import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import type { GraphView } from "../ui/graph-view.js";
import type {
  PiWendaoAgentExecutionMetadata,
  PiWendaoAgentHost,
  PiWendaoConfig,
  PiWendaoHostWorkKind,
  PiWendaoQianjiCheckpointFeedback,
} from "./agent-host.js";
import type {
  PiWendaoAgentEvent,
  PiWendaoAgentTool,
  PiWendaoThinkingLevel,
} from "./agent-runtime-types.js";
import {
  buildDefaultHostFixture,
  buildPiWendaoConfigMap,
  extractFirstProcessId,
  hasHostCompletionResults,
  parseVariablePairs,
  populateGraphViewFromBpmn,
  type HostCompletionFixture,
} from "./bpmn-config.js";
import { isObject } from "./data.js";
import {
  mapHumanTaskReplyToOutputs,
  resolveHumanTaskConfig,
  validateOutputSchemas,
} from "./human-task.js";
import { isWorkflowInterruptedError, throwIfWorkflowInterrupted } from "./interrupt.js";
import { createPiAiHost } from "./node-runner.js";
import {
  buildQianjiArgs,
  buildQianjiStatusArgs,
  buildQianjiTaskCompleteArgs,
  defaultQianjiCommand,
  runQianjiCli,
} from "./qianji-cli.js";
import {
  isActivityTraceNode,
  parseQianjiCheckpointFeedback,
  parseQianjiGraphSnapshot,
  parseQianjiOutcome,
  parseQianjiTrace,
  parseQianjiVariables,
  toGraphNodeStatus,
} from "./qianji-report.js";
import type {
  QianjiCliResult,
  QianjiHostWork,
  QianjiHostWorkEvent,
  QianjiTraceEvent,
} from "./qianji-types.js";
import { WorkflowStallGuard } from "./stall-guard.js";

export type { QianjiHostWorkEvent, QianjiTraceEvent } from "./qianji-types.js";
export { mapHumanTaskReplyToOutputs } from "./human-task.js";

export interface ExecuteOptions {
  /** BPMN 2.0 XML source */
  source: string;
  /** Existing BPMN source path. When omitted, the source is written to a temp file for qianji. */
  sourcePath?: string;
  /** BPMN process id. Defaults to the first process declared in the source. */
  processId?: string;
  /** Workflow instance id. Defaults to a generated pi-wendao id. */
  instanceId?: string;
  /** Start a fresh qianji BPMN instance at a specific host-bound node. */
  startAtNode?: string;
  /** Qianji CLI command. Defaults to QIANJI_CLI or qianji on PATH. */
  qianjiCommand?: string;
  /** Additional DMN files passed through as repeated --dmn args. */
  dmnPaths?: string[];
  /** Optional qianji host fixture. */
  hostFixturePath?: string;
  /** Optional qianji event fixture. */
  eventFixturePath?: string;
  /** Raw JSON object merged after --var pairs for qianji --context-json. */
  context?: Record<string, unknown>;
  /** Model for default host-side service task execution when agentHost is not provided. */
  model?: Model<string>;
  /** Runtime API key override for default host-side service task execution. */
  apiKey?: string;
  /** LLM thinking level for real host-side skill execution. */
  thinkingLevel?: PiWendaoThinkingLevel;
  /** Optional service-task agent host override. Defaults to pi-ai when model is provided. */
  agentHost?: PiWendaoAgentHost;
  /** Handles BPMN userTask host work as graph-local human input. */
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
  traceFrameDelayMs?: number;
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
  execution?: PiWendaoAgentExecutionMetadata;
}

const DEFAULT_GRAPH_TRACE_FRAME_DELAY_MS = 60;

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
    if (options.graphView) {
      populateGraphViewFromBpmn(options.source, processId, options.graphView);
      if (options.instanceId) {
        await applyCheckpointGraphSnapshot({
          command,
          sourcePath,
          instanceId,
          dmnPaths: options.dmnPaths ?? [],
          cwd,
          options,
        });
      }
      options.onGraphReady?.();
    }
    const completionFixture =
      useRealHost && options.hostFixturePath
        ? await readHostCompletionFixture(options.hostFixturePath, cwd)
        : undefined;
    const hostFixturePath = useRealHost
      ? undefined
      : (options.hostFixturePath ??
        (await writeDefaultHostFixture(options.source, variables).then((fixture) => {
          if (!fixture) return undefined;
          tempDirs.push(fixture.dir);
          return fixture.path;
        })));

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
      ? await runQianjiExternalHostLoop({
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
          completionFixture,
          onTraceEvent,
          tempDirs,
        })
      : await runQianjiCli(command, args, cwd, onTraceEvent, options.signal);
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

    const parsedVariables = parseQianjiVariables(cli.stdout);
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

async function applyCheckpointGraphSnapshot(options: {
  command: string;
  sourcePath: string;
  instanceId: string;
  dmnPaths: string[];
  cwd: string;
  options: ExecuteOptions;
}): Promise<void> {
  try {
    const cli = await runQianjiCli(
      options.command,
      buildQianjiStatusArgs({
        sourcePath: options.sourcePath,
        instanceId: options.instanceId,
        dmnPaths: options.dmnPaths,
      }),
      options.cwd,
      () => {},
      options.options.signal,
    );
    if (cli.exitCode !== 0) return;
    const snapshot = parseQianjiGraphSnapshot(cli.stdout);
    if (snapshot.length === 0) return;
    let changed = false;
    for (const node of snapshot) {
      const status = toGraphNodeStatus(node.status);
      if (!status) continue;
      options.options.graphView?.setNodeStatus(node.node_id, status);
      changed = true;
    }
    if (changed) options.options.onGraphUpdate?.();
  } catch {
    // Status hydration is opportunistic; execution will report hard qianji errors.
  }
}

async function writeTempBpmnSource(source: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wendao-qianji-"));
  const path = join(dir, "workflow.bpmn");
  await writeFile(path, source, "utf-8");
  return { dir, path };
}

async function writeDefaultHostFixture(
  source: string,
  context: Record<string, unknown>,
): Promise<{ dir: string; path: string } | undefined> {
  const fixture = buildDefaultHostFixture(source, context);
  if (!fixture) return undefined;

  const dir = await mkdtemp(join(tmpdir(), "pi-wendao-qianji-host-"));
  const path = join(dir, "host-fixture.json");
  await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf-8");
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

async function runQianjiExternalHostLoop(options: {
  command: string;
  sourcePath: string;
  processId: string;
  instanceId: string;
  context: Record<string, unknown>;
  dmnPaths: string[];
  eventFixturePath?: string;
  cwd: string;
  source: string;
  startAtNode?: string;
  options: ExecuteOptions;
  completionFixture?: HostCompletionFixture;
  onTraceEvent: (event: QianjiTraceEvent) => void | Promise<void>;
  tempDirs: string[];
}): Promise<QianjiCliResult> {
  const piWendaoConfigs = buildPiWendaoConfigMap(options.source, options.processId);
  const agentHost =
    options.options.agentHost ??
    (options.options.model
      ? createPiAiHost({
          model: options.options.model,
          apiKey: options.options.apiKey,
          cwd: options.cwd,
          extraTools: options.options.agentTools,
          onEvent: options.options.onAgentEvent,
          thinkingLevel: options.options.thinkingLevel,
          signal: options.options.signal,
        })
      : createMissingAgentHost());
  const pendingActivities = new Set<string>();
  const aggregate: QianjiCliResult = {
    exitCode: 0,
    stdout: "",
    stderr: "",
    streamedTrace: false,
    hostWork: [],
  };
  const stallGuard = new WorkflowStallGuard();
  const onTraceEvent = async (event: QianjiTraceEvent) => {
    updatePendingActivities(pendingActivities, event);
    await options.onTraceEvent(event);
  };

  let latest = await runQianjiCli(
    options.command,
    buildQianjiArgs({
      sourcePath: options.sourcePath,
      processId: options.processId,
      instanceId: options.instanceId,
      context: options.context,
      dmnPaths: options.dmnPaths,
      eventFixturePath: options.eventFixturePath,
      traceStream: true,
      externalHost: true,
      startAtNode: options.startAtNode,
    }),
    options.cwd,
    onTraceEvent,
    options.options.signal,
  );
  appendCliResult(aggregate, latest);

  let guard = 0;
  while (latest.exitCode === 0 && parseQianjiOutcome(latest.stdout) === "blocked_on_host") {
    throwIfWorkflowInterrupted(options.options.signal);
    guard += 1;
    if (guard > 100) {
      throw new Error("qianji external host loop exceeded 100 host-boundary iterations");
    }
    const checkpoint = parseQianjiCheckpointFeedback(latest.stdout, latest.hostWork.length);
    stallGuard.inspectPendingHostWork({
      hostWork: latest.hostWork,
      piWendaoConfigs,
      variables: options.context,
    });
    emitQianjiHostWorkEvents(latest.hostWork, options.options);
    applyQianjiHostWorkGraph({
      hostWork: latest.hostWork,
      piWendaoConfigs,
      checkpoint,
      hostBackend: resolveHostBackendLabel(options.options),
      options: options.options,
    });
    const hostData = await runPendingHostWork({
      agentHost,
      humanTaskHandler: options.options.humanTaskHandler,
      piWendaoConfigs,
      pendingHostWork: latest.hostWork,
      pendingActivityIds: Array.from(pendingActivities),
      variables: options.context,
      processId: options.processId,
      instanceId: options.instanceId,
      checkpoint,
      completionFixture: options.completionFixture,
      signal: options.options.signal,
    });
    if (!hostData) {
      throw new Error("qianji stopped on host work but did not stream an active BPMN activity");
    }
    const fixture = await writeHostCompletionFixture(hostData);
    options.tempDirs.push(fixture.dir);
    latest = await runQianjiCli(
      options.command,
      buildQianjiTaskCompleteArgs({
        sourcePath: options.sourcePath,
        instanceId: options.instanceId,
        dmnPaths: options.dmnPaths,
        hostFixturePath: fixture.path,
        traceStream: true,
        externalHost: true,
      }),
      options.cwd,
      onTraceEvent,
      options.options.signal,
    );
    const variables = parseQianjiVariables(latest.stdout);
    Object.assign(options.context, variables);
    appendCliResult(aggregate, latest);
  }

  aggregate.exitCode = latest.exitCode;
  return aggregate;
}

async function runPendingHostWork(options: {
  agentHost: PiWendaoAgentHost;
  humanTaskHandler?: (request: HumanTaskPromptRequest) => Promise<string>;
  piWendaoConfigs: Map<string, PiWendaoConfig>;
  pendingHostWork: QianjiHostWork[];
  pendingActivityIds: string[];
  variables: Record<string, unknown>;
  processId: string;
  instanceId: string;
  checkpoint?: PiWendaoQianjiCheckpointFeedback;
  completionFixture?: HostCompletionFixture;
  signal?: AbortSignal;
}): Promise<HostCompletionFixture | undefined> {
  throwIfWorkflowInterrupted(options.signal);
  const tokenResults = await Promise.all(
    options.pendingHostWork.map(async (work) => {
      throwIfWorkflowInterrupted(options.signal);
      const tokenVariables = { ...options.variables, ...(work.variables ?? {}) };
      const data = await runPiWendaoActivity({
        agentHost: options.agentHost,
        humanTaskHandler: options.humanTaskHandler,
        piWendaoConfigs: options.piWendaoConfigs,
        activityId: work.node_id,
        hostKind: work.kind,
        variables: tokenVariables,
        execution: {
          processId: options.processId,
          instanceId: options.instanceId,
          nodeIndex: work.node_index,
          tokenId: work.token_id,
          repeat: work.repeat,
          checkpoint: options.checkpoint,
        },
        completionFixture: options.completionFixture,
        signal: options.signal,
      });
      return { kind: work.kind, nodeId: work.node_id, tokenId: String(work.token_id), data };
    }),
  );
  const fixture: HostCompletionFixture = {};
  for (const result of tokenResults) {
    Object.assign(options.variables, result.data);
    addHostCompletionResult(fixture, result);
  }
  if (hasHostCompletionResults(fixture)) {
    return fixture;
  }

  const activityResults = await Promise.all(
    options.pendingActivityIds.map(async (activityId) => {
      throwIfWorkflowInterrupted(options.signal);
      const activityVariables = { ...options.variables };
      const data = await runPiWendaoActivity({
        agentHost: options.agentHost,
        humanTaskHandler: options.humanTaskHandler,
        piWendaoConfigs: options.piWendaoConfigs,
        activityId,
        variables: activityVariables,
        execution: {
          processId: options.processId,
          instanceId: options.instanceId,
          checkpoint: options.checkpoint,
        },
        completionFixture: options.completionFixture,
        signal: options.signal,
      });
      return { activityId, data };
    }),
  );
  const service_tasks: Record<string, { data: Record<string, unknown> }> = {};
  for (const result of activityResults) {
    Object.assign(options.variables, result.data);
    service_tasks[result.activityId] = { data: result.data };
  }
  if (Object.keys(service_tasks).length > 0) {
    return { service_tasks };
  }
  return undefined;
}

async function writeHostCompletionFixture(
  fixture: HostCompletionFixture,
): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wendao-qianji-host-"));
  const path = join(dir, "host-fixture.json");
  await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf-8");
  return { dir, path };
}

function addHostCompletionResult(
  fixture: HostCompletionFixture,
  result: {
    kind: PiWendaoHostWorkKind;
    nodeId: string;
    tokenId: string;
    data: Record<string, unknown>;
  },
): void {
  switch (result.kind) {
    case "service":
      fixture.service_task_tokens ??= {};
      fixture.service_task_tokens[result.tokenId] = { data: result.data };
      return;
    case "user":
      fixture.user_tasks ??= {};
      fixture.user_tasks[result.nodeId] = { data: result.data };
      return;
    case "manual":
      fixture.manual_tasks ??= {};
      fixture.manual_tasks[result.nodeId] = { data: result.data };
      return;
    case "send":
      fixture.send_tasks ??= {};
      fixture.send_tasks[result.nodeId] = { data: result.data };
      return;
    case "script":
    case "business_rule":
      fixture.service_task_tokens ??= {};
      fixture.service_task_tokens[result.tokenId] = { data: result.data };
      return;
  }
}

async function runPiWendaoActivity(options: {
  agentHost: PiWendaoAgentHost;
  humanTaskHandler?: (request: HumanTaskPromptRequest) => Promise<string>;
  piWendaoConfigs: Map<string, PiWendaoConfig>;
  activityId: string;
  hostKind?: PiWendaoHostWorkKind;
  variables: Record<string, unknown>;
  execution: PiWendaoAgentExecutionMetadata;
  completionFixture?: HostCompletionFixture;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  throwIfWorkflowInterrupted(options.signal);
  const config = options.piWendaoConfigs.get(options.activityId) ?? {
    prompt: "",
    tools: [],
    inputs: [],
    outputs: [],
  };
  if ((options.hostKind ?? config.hostKind) === "user") {
    if (!options.humanTaskHandler) {
      throw new Error(`BPMN userTask '${options.activityId}' requires a human task handler`);
    }
    const resolvedConfig = resolveHumanTaskConfig(config, options.variables, {
      activityId: options.activityId,
    });
    const reply = await options.humanTaskHandler({
      activityId: options.activityId,
      config: resolvedConfig,
      variables: options.variables,
      execution: {
        ...options.execution,
        activityId: options.activityId,
      },
    });
    throwIfWorkflowInterrupted(options.signal);
    const output = mapHumanTaskReplyToOutputs(reply, config.outputs);
    Object.assign(options.variables, output);
    return output;
  }
  const fixtureOutput = resolveFixtureCompletion({
    fixture: options.completionFixture,
    hostKind: options.hostKind ?? config.hostKind ?? "service",
    activityId: options.activityId,
    tokenId: options.execution.tokenId,
  });
  if (fixtureOutput) {
    const validatedOutput = validateOutputSchemas(config, fixtureOutput, {
      activityId: options.activityId,
    });
    Object.assign(options.variables, validatedOutput);
    return validatedOutput;
  }
  const output = await options.agentHost.run({
    activityId: options.activityId,
    config,
    variables: options.variables,
    signal: options.signal,
    execution: {
      ...options.execution,
      activityId: options.activityId,
    },
  });
  throwIfWorkflowInterrupted(options.signal);
  const validatedOutput = validateOutputSchemas(config, output, {
    activityId: options.activityId,
  });
  Object.assign(options.variables, validatedOutput);
  return validatedOutput;
}

function resolveFixtureCompletion(options: {
  fixture?: HostCompletionFixture;
  hostKind: PiWendaoHostWorkKind;
  activityId: string;
  tokenId?: number;
}): Record<string, unknown> | undefined {
  if (!options.fixture || options.hostKind === "user") return undefined;
  const tokenData =
    options.tokenId !== undefined
      ? options.fixture.service_task_tokens?.[String(options.tokenId)]?.data
      : undefined;
  if (tokenData) return tokenData;
  switch (options.hostKind) {
    case "send":
      return options.fixture.send_tasks?.[options.activityId]?.data;
    case "manual":
      return options.fixture.manual_tasks?.[options.activityId]?.data;
    case "script":
    case "business_rule":
    case "service":
      return options.fixture.service_tasks?.[options.activityId]?.data;
  }
}

function updatePendingActivities(pendingActivities: Set<string>, event: QianjiTraceEvent): void {
  if (event.kind !== "node_status" || !isActivityTraceNode(event)) return;
  if (event.status === "executing") {
    pendingActivities.add(event.node_id);
    return;
  }
  if (event.status === "completed" || event.status === "cancelled" || event.status === "failed") {
    pendingActivities.delete(event.node_id);
  }
}

function applyQianjiHostWorkGraph(options: {
  hostWork: QianjiHostWork[];
  piWendaoConfigs: Map<string, PiWendaoConfig>;
  checkpoint?: PiWendaoQianjiCheckpointFeedback;
  hostBackend?: string;
  options: ExecuteOptions;
}): void {
  if (!options.options.graphView || options.hostWork.length === 0) return;
  const byNode = new Map<string, QianjiHostWork[]>();
  for (const work of options.hostWork) {
    const group = byNode.get(work.node_id) ?? [];
    group.push(work);
    byNode.set(work.node_id, group);
  }
  for (const [nodeId, work] of byNode) {
    options.options.graphView.setNodeStatus(nodeId, "active");
    options.options.graphView.setNodeDetails(
      nodeId,
      buildGraphRuntimeDetails({
        hostWorkCount: work.length,
        hostKinds: [...new Set(work.map((item) => item.kind))],
        config: options.piWendaoConfigs.get(nodeId),
        checkpoint: options.checkpoint,
        hostBackend: options.hostBackend,
        hostWork: work,
        batchHostWorkCount: options.hostWork.length,
      }),
    );
  }
  options.options.onGraphUpdate?.();
}

function buildGraphRuntimeDetails(options: {
  hostWorkCount: number;
  hostKinds?: PiWendaoHostWorkKind[];
  config?: PiWendaoConfig;
  checkpoint?: PiWendaoQianjiCheckpointFeedback;
  hostBackend?: string;
  hostWork?: QianjiHostWork[];
  batchHostWorkCount?: number;
}): string[] {
  const details: string[] = [];
  const hostKind =
    options.hostKinds && options.hostKinds.length === 1 && options.hostKinds[0] !== "service"
      ? `${options.hostKinds[0]}:`
      : "";
  const host = [`host:${hostKind}${options.hostWorkCount}`, options.hostBackend]
    .filter(Boolean)
    .join(" ");
  if (host) details.push(host);
  const parallel = buildParallelRuntimeDetail(
    options.hostWork ?? [],
    options.batchHostWorkCount ?? 0,
  );
  if (parallel) details.push(parallel);
  const checkpoint = [
    options.checkpoint?.backend,
    options.checkpoint?.source,
    options.checkpoint?.status,
  ]
    .filter(Boolean)
    .join("/");
  if (checkpoint) details.push(`checkpoint:${checkpoint}`);
  if (options.config?.subagent?.type) {
    details.push(`subagent:${options.config.subagent.type}`);
  }
  return details;
}

function emitQianjiHostWorkEvents(hostWork: QianjiHostWork[], options: ExecuteOptions): void {
  if (!options.onHostWork || hostWork.length === 0) return;
  for (const event of buildQianjiHostWorkEvents(hostWork)) {
    options.onHostWork(event);
  }
}

function buildQianjiHostWorkEvents(hostWork: QianjiHostWork[]): QianjiHostWorkEvent[] {
  const byNode = new Map<string, QianjiHostWork[]>();
  for (const work of hostWork) {
    const group = byNode.get(work.node_id) ?? [];
    group.push(work);
    byNode.set(work.node_id, group);
  }
  const batchParallel = hostWork.length > 1;
  return [...byNode.entries()].map(([activityId, work]) => {
    const repeatKinds = uniqueStrings(
      work.map((item) => readRepeatKind(item.repeat)).filter(isNonEmptyString),
    );
    return {
      activityId,
      hostWorkCount: work.length,
      batchHostWorkCount: hostWork.length,
      tokenIds: work.map((item) => item.token_id),
      hostKinds: uniqueHostKinds(work.map((item) => item.kind)),
      parallel: batchParallel || work.some((item) => isParallelRepeat(item.repeat)),
      repeatKinds,
      repeatSummaries: work.map((item) => summarizeRepeat(item.repeat)).filter(isNonEmptyString),
    };
  });
}

function buildParallelRuntimeDetail(
  hostWork: QianjiHostWork[],
  batchHostWorkCount: number,
): string | undefined {
  const parallel = batchHostWorkCount > 1 || hostWork.some((work) => isParallelRepeat(work.repeat));
  if (!parallel) return undefined;
  const tokens = hostWork.map((work) => work.token_id).join(",");
  const batch = batchHostWorkCount > hostWork.length ? `batch=${batchHostWorkCount} ` : "";
  return `parallel:${batch}${hostWork.length} jobs tokens=${tokens}`;
}

function isParallelRepeat(repeat: unknown): boolean {
  const kind = readRepeatKind(repeat);
  return !!kind && /\bparallel\b/i.test(kind);
}

function readRepeatKind(repeat: unknown): string | undefined {
  if (!isObject(repeat)) return undefined;
  return typeof repeat.kind === "string" && repeat.kind.trim() ? repeat.kind.trim() : undefined;
}

function summarizeRepeat(repeat: unknown): string | undefined {
  if (!isObject(repeat)) return undefined;
  const kind = readRepeatKind(repeat);
  const iteration =
    typeof repeat.iteration_index === "number" ? repeat.iteration_index + 1 : undefined;
  const total = typeof repeat.total_iterations === "number" ? repeat.total_iterations : undefined;
  if (kind && iteration !== undefined && total !== undefined)
    return `${kind} ${iteration}/${total}`;
  if (kind) return kind;
  if (iteration !== undefined && total !== undefined) return `${iteration}/${total}`;
  return undefined;
}

function uniqueHostKinds(values: PiWendaoHostWorkKind[]): PiWendaoHostWorkKind[] {
  return [...new Set(values)];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function resolveHostBackendLabel(options: ExecuteOptions): string | undefined {
  if (options.hostBackend) return options.hostBackend;
  if (options.agentHost) return "custom-host";
  if (options.humanTaskHandler && !options.model) return "human";
  if (options.model) return "pi-ai";
  return undefined;
}

function createMissingAgentHost(): PiWendaoAgentHost {
  return {
    async run(request) {
      throw new Error(`BPMN serviceTask '${request.activityId}' requires a model or agent host`);
    },
  };
}

function appendCliResult(aggregate: QianjiCliResult, result: QianjiCliResult): void {
  if (result.stdout) aggregate.stdout += `${result.stdout}\n`;
  if (result.stderr) aggregate.stderr += `${result.stderr}\n`;
  aggregate.streamedTrace ||= result.streamedTrace;
  aggregate.hostWork.push(...result.hostWork);
  aggregate.exitCode = result.exitCode;
}

function applyQianjiTrace(output: string, options: ExecuteOptions): void {
  const trace = parseQianjiTrace(output);
  if (trace.length === 0) return;
  applyQianjiTraceEvents(trace, options);
}

function applyQianjiTraceEvents(trace: QianjiTraceEvent[], options: ExecuteOptions): void {
  for (const event of trace) {
    options.onTraceEvent?.(event);
    if (event.kind === "flow_take") {
      if (event.source_id && event.target_id) {
        options.graphView?.setEdgeTaken(event.source_id, event.target_id);
        options.onFlowTake?.(`${event.source_id}->${event.target_id}`);
      }
      options.onGraphUpdate?.();
      continue;
    }

    const status = toGraphNodeStatus(event.status);
    if (status) {
      options.graphView?.setNodeStatus(event.node_id, status);
    }
    if (event.status === "executing" && isActivityTraceNode(event)) {
      options.onActivityStart?.(event.node_id, event.node_id);
    }
    if (
      (event.status === "completed" || event.status === "cancelled" || event.status === "failed") &&
      isActivityTraceNode(event)
    ) {
      options.onActivityEnd?.(event.node_id, event.node_id);
    }
    options.onGraphUpdate?.();
  }
}

function resolveTraceFrameDelayMs(options: ExecuteOptions): number {
  if (!options.graphView) return 0;
  if (typeof options.traceFrameDelayMs === "number") {
    return Math.max(0, options.traceFrameDelayMs);
  }
  const envValue = process.env.PI_WENDAO_TRACE_FRAME_MS?.trim();
  if (envValue) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return DEFAULT_GRAPH_TRACE_FRAME_DELAY_MS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
