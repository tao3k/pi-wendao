import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type {
  ApiKey,
  DmnPath,
  EventFixturePath,
  HostFixturePath,
  InstanceId,
  ProcessId,
  QianjiCommand,
  QianjiWorkflowStateDuckdbPath,
  SourcePath,
  TraceFrameDelayMs,
} from "../types/domain.js";
import type { GraphView } from "../ui/graph-view.js";
import type {
  PiWendaoAgentExecutionMetadata,
  PiWendaoAgentHost,
  PiWendaoConfig,
} from "./agent-host.js";
import type {
  PiWendaoAgentEvent,
  PiWendaoAgentTool,
  PiWendaoThinkingLevel,
} from "./agent-runtime-types.js";
import {
  extractFirstProcessId,
  parseVariablePairs,
  populateGraphViewFromBpmn,
  type HostCompletionFixture,
} from "./bpmn-config.js";
import { isObject } from "./data.js";
import { mapHumanTaskReplyToOutputs } from "./human-task.js";
import { isWorkflowInterruptedError, throwIfWorkflowInterrupted } from "./interrupt.js";
import {
  buildQianjiArgs,
  defaultQianjiCommand,
  runQianjiCli,
} from "./qianji-cli.js";
import type {
  QianjiHostWorkClaim,
  QianjiHostWorkEvent,
  QianjiHumanTaskAssignment,
  QianjiTraceEvent,
} from "./qianji-types.js";
import { runQianjiExternalHostLoop } from "./executor-host-loop.js";
import {
  isQianjiServerWorkflowExecutionError,
  runQianjiServerExternalHostLoop,
} from "./qianji-server-workflow.js";
import {
  applyCheckpointGraphSnapshot,
  applyQianjiTrace,
  applyQianjiTraceEvents,
  delay,
  resolveTraceFrameDelayMs,
  resultVariables,
} from "./executor-runtime-state.js";

export type { QianjiHostWorkEvent, QianjiTraceEvent } from "./qianji-types.js";
export { mapHumanTaskReplyToOutputs } from "./human-task.js";
export { resolveTraceFrameDelayMs } from "./executor-runtime-state.js";

export interface ExecuteOptions {
  /** BPMN 2.0 XML source */
  source: string;
  /** Existing BPMN source path. When omitted, the source is written to a temp file for qianji. */
  sourcePath?: SourcePath;
  /** BPMN process id. Defaults to the first process declared in the source. */
  processId?: ProcessId;
  /** Workflow instance id. Defaults to a generated pi-wendao id. */
  instanceId?: InstanceId;
  /** Start a fresh qianji BPMN instance at a specific host-bound node. */
  startAtNode?: string;
  /** Qianji CLI command. Defaults to QIANJI_CLI, workspace target/debug/qianji, or qianji on PATH. */
  qianjiCommand?: QianjiCommand;
  /** Optional local DuckDB workflow-state path for this qianji process. */
  qianjiWorkflowStateDuckdbPath?: QianjiWorkflowStateDuckdbPath;
  /** Additional DMN files passed through as repeated --dmn args. */
  dmnPaths?: DmnPath[];
  /** Optional qianji host fixture. */
  hostFixturePath?: HostFixturePath;
  /** Optional qianji-server URL for HTTP-backed real host workflow execution. */
  qianjiWorkflowServerUrl?: string;
  /** qianji-server fresh-run policy. Defaults to resume-or-start for operator safety. */
  qianjiWorkflowStartMode?: "resume-or-start" | "start";
  /** Optional qianji event fixture. */
  eventFixturePath?: EventFixturePath;
  /** Raw JSON object merged after --var pairs for qianji --context-json. */
  context?: Record<string, unknown>;
  /** Model for default host-side service task execution when agentHost is not provided. */
  model?: Model<string>;
  /** Runtime API key override for default host-side service task execution. */
  apiKey?: ApiKey;
  /** LLM thinking level for real host-side skill execution. */
  thinkingLevel?: PiWendaoThinkingLevel;
  /** Optional service-task agent host override. Defaults to pi-ai when model is provided. */
  agentHost?: PiWendaoAgentHost;
  /** Handles BPMN userTask/manualTask host work as graph-local human input. */
  humanTaskHandler?: (request: HumanTaskPromptRequest) => Promise<string>;
  /** Display name for the active real-host backend in graph node runtime details. */
  hostBackend?: string;
  /** Extra tools exposed to the default pi-ai service-task host. */
  agentTools?: PiWendaoAgentTool<any>[];
  /** Working directory for the qianji process */
  cwd?: string;
  /** Initial variables as key=value pairs */
  variables?: string[];
  /** Called with qianji stdout/stderr once the CLI exits. */
  onCliOutput?: (output: string) => void;
  /** Retained for API compatibility; qianji CLI execution does not emit agent events. */
  onAgentEvent?: (event: PiWendaoAgentEvent) => void;
  /** Called from qianji execution trace when a BPMN node starts executing. */
  onActivityStart?: (activityId: string, activityName: string) => void;
  /** Called from qianji execution trace when a BPMN node reaches a terminal status. */
  onActivityEnd?: (activityId: string, activityName: string) => void;
  /** Called from qianji execution trace when a BPMN sequence flow is taken. */
  onFlowTake?: (flowId: string) => void;
  /** Called on error */
  onError?: (err: Error) => void;
  /** Retained for API compatibility; qianji CLI execution does not consume moddle options. */
  moddleOptions?: Record<string, unknown>;
  /** Graph view populated from BPMN and updated from qianji execution trace. */
  graphView?: GraphView;
  /** Called after the static BPMN graph has been loaded. */
  onGraphReady?: () => void;
  /** Called after each trace-backed graph mutation. */
  onGraphUpdate?: () => void;
  /** Called for every streamed or replayed qianji execution trace event. */
  onTraceEvent?: (event: QianjiTraceEvent) => void;
  /** Called when qianji exposes pending external host work tokens. */
  onHostWork?: (event: QianjiHostWorkEvent) => void;
  /** Delay between streamed graph trace events. Defaults to a small visual frame delay when graphView is enabled. */
  traceFrameDelayMs?: TraceFrameDelayMs;
  /** Soft-interrupt signal. Interrupting preserves qianji checkpoint state. */
  signal?: AbortSignal;
}

export interface ExecuteResult {
  success: boolean;
  error?: string;
  variables: Record<string, unknown>;
  output: Record<string, unknown>;
  rawOutput?: string;
  interrupted?: boolean;
}

export interface HumanTaskPromptRequest {
  activityId: string;
  config: PiWendaoConfig;
  variables: Record<string, unknown>;
  assignment?: QianjiHumanTaskAssignment;
  claim?: QianjiHostWorkClaim;
  execution?: PiWendaoAgentExecutionMetadata;
}

/**
 * Execute a BPMN workflow through the qianji CLI.
 */
export async function execute(options: ExecuteOptions): Promise<ExecuteResult> {
  const tempDirs: string[] = [];
  try {
    throwIfWorkflowInterrupted(options.signal);
    const cwd = options.cwd ?? process.cwd();
    const sourcePath = options.sourcePath
      ? resolve(cwd, options.sourcePath)
      : await writeTempBpmnSource(options.source).then(({ dir, path }) => {
          tempDirs.push(dir);
          return path;
        });
    const processId = options.processId ?? extractFirstProcessId(options.source);
    const instanceId = options.instanceId ?? `pi-wendao-${randomUUID()}`;
    const variables = {
      ...parseVariablePairs(options.variables),
      ...(options.context ?? {}),
    };
    const useRealHost =
      Boolean(options.model) || Boolean(options.agentHost) || Boolean(options.humanTaskHandler);
    const command = options.qianjiCommand ?? defaultQianjiCommand(cwd);
    const qianjiEnvironment = await buildQianjiProcessEnvironment(
      options.qianjiWorkflowStateDuckdbPath,
      tempDirs,
    );
    if (options.graphView) {
      populateGraphViewFromBpmn(options.source, processId, options.graphView);
      if (options.instanceId) {
        await applyCheckpointGraphSnapshot({
          command,
          sourcePath,
          instanceId,
          dmnPaths: options.dmnPaths ?? [],
          cwd,
          qianjiEnvironment,
          options,
        });
      }
      options.onGraphReady?.();
    }
    const completionFixture =
      useRealHost && options.hostFixturePath
        ? await readHostCompletionFixture(options.hostFixturePath, cwd)
        : undefined;
    const hostFixturePath = useRealHost ? undefined : options.hostFixturePath;

    const args = buildQianjiArgs({
      sourcePath,
      processId,
      instanceId,
      context: variables,
      dmnPaths: options.dmnPaths ?? [],
      hostFixturePath,
      eventFixturePath: options.eventFixturePath,
      traceStream: Boolean(options.graphView),
      externalHost: false,
      startAtNode: options.startAtNode,
    });
    const traceFrameDelayMs = resolveTraceFrameDelayMs(options);
    const onTraceEvent = async (event: QianjiTraceEvent) => {
      applyQianjiTraceEvents([event], options);
      if (traceFrameDelayMs > 0) await delay(traceFrameDelayMs);
    };
    const cli = useRealHost
      ? options.qianjiWorkflowServerUrl
        ? await runQianjiServerExternalHostLoop({
            serverUrl: options.qianjiWorkflowServerUrl,
            sourcePath,
            processId,
            instanceId,
            context: variables,
            dmnPaths: options.dmnPaths ?? [],
            cwd,
            source: options.source,
            startAtNode: options.startAtNode,
            options,
            completionFixture,
            onTraceEvent,
          })
        : await runQianjiExternalHostLoop({
            command,
            sourcePath,
            processId,
            instanceId,
            context: variables,
            dmnPaths: options.dmnPaths ?? [],
            eventFixturePath: options.eventFixturePath,
            cwd,
            source: options.source,
            startAtNode: options.startAtNode,
            options,
            qianjiEnvironment,
            completionFixture,
            onTraceEvent,
            tempDirs,
          })
      : await runQianjiCli({
          command,
          args,
          cwd,
          onTraceEvent,
          signal: options.signal,
          env: qianjiEnvironment,
        });
    const rawOutput = [cli.stdout, cli.stderr].filter(Boolean).join("\n");
    options.onCliOutput?.(rawOutput);
    if (!cli.streamedTrace) {
      applyQianjiTrace(rawOutput, options);
    }

    if (cli.exitCode !== 0) {
      const error =
        cli.stderr.trim() || cli.stdout.trim() || `qianji exited with code ${cli.exitCode}`;
      return {
        success: false,
        error,
        variables: {},
        output: {},
        rawOutput,
      };
    }

    const parsedVariables = resultVariables(cli);
    return {
      success: true,
      variables: { ...variables, ...parsedVariables },
      output: { qianji: cli.stdout },
      rawOutput,
    };
  } catch (err) {
    if (isWorkflowInterruptedError(err)) {
      return {
        success: false,
        error: err.message,
        variables: {},
        output: {},
        interrupted: true,
      };
    }
    if (isQianjiServerWorkflowExecutionError(err)) {
      const rawOutput = [err.result.stdout, err.result.stderr].filter(Boolean).join("\n");
      options.onCliOutput?.(rawOutput);
      if (!err.result.streamedTrace) {
        applyQianjiTrace(rawOutput, options);
      }
      options.onError?.(err);
      return {
        success: false,
        error: err.message,
        variables: {},
        output: {},
        rawOutput,
      };
    }
    const error = err instanceof Error ? err : new Error(String(err));
    options.onError?.(error);
    return {
      success: false,
      error: error.message,
      variables: {},
      output: {},
    };
  } finally {
    for (const tempDir of tempDirs) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

async function buildQianjiProcessEnvironment(
  workflowStateDuckdbPath: QianjiWorkflowStateDuckdbPath | undefined,
  tempDirs: string[],
): Promise<NodeJS.ProcessEnv | undefined> {
  if (!workflowStateDuckdbPath) return undefined;
  const configDir = await mkdtemp(join(tmpdir(), "pi-wendao-qianji-config-"));
  tempDirs.push(configDir);
  const qianjiConfigPath = join(configDir, "qianji.toml");
  await writeFile(
    qianjiConfigPath,
    `[workflow_state]\nlocal_duckdb_path = ${JSON.stringify(workflowStateDuckdbPath)}\n`,
    "utf-8",
  );
  return {
    ...process.env,
    QIANJI_CONFIG_PATH: qianjiConfigPath,
    QIANJI_WORKFLOW_STATE_DUCKDB_PATH: workflowStateDuckdbPath,
  };
}

async function writeTempBpmnSource(source: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wendao-qianji-"));
  const path = join(dir, "workflow.bpmn");
  await writeFile(path, source, "utf-8");
  return { dir, path };
}

async function readHostCompletionFixture(
  path: string,
  cwd: string,
): Promise<HostCompletionFixture> {
  const resolvedPath = resolve(cwd, path);
  const parsed = JSON.parse(await readFile(resolvedPath, "utf-8")) as unknown;
  if (!isObject(parsed)) {
    throw new Error(`host fixture '${resolvedPath}' must be a JSON object`);
  }
  return parsed as HostCompletionFixture;
}
