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
  buildPiWendaoConfigMap,
  extractFirstProcessId,
  hasHostCompletionResults,
  parseVariablePairs,
  populateGraphViewFromBpmn,
  type HostCompletionFixture,
} from "./bpmn-config.js";
import { isObject } from "./data.js";
import {
  humanTaskReplyOutputNames,
  mapHumanTaskReplyToOutputs,
  mergeQianjiHostWorkFormConfig,
  resolveHumanTaskConfig,
  validateOutputSchemas,
} from "./human-task.js";
import { isWorkflowInterruptedError, throwIfWorkflowInterrupted } from "./interrupt.js";
import { createPiAiHost } from "./node-runner.js";
import {
  buildQianjiArgs,
  buildQianjiHostSessionArgs,
  buildQianjiHostSessionTaskCompleteRequest,
  buildQianjiStatusArgs,
  defaultQianjiCommand,
  QianjiHostSession,
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
  QianjiHostWorkClaim,
  QianjiHostWorkEvent,
  QianjiHumanTaskAssignment,
  QianjiHumanTaskResourceRole,
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
  assignment?: QianjiHumanTaskAssignment;
  claim?: QianjiHostWorkClaim;
  execution?: PiWendaoAgentExecutionMetadata;
}

const DEFAULT_GRAPH_TRACE_FRAME_DELAY_MS = 0;

interface HostCompletionResult {
  kind: PiWendaoHostWorkKind;
  processId: string;
  nodeId: string;
  tokenId: number;
  claimant?: string;
  data: Record<string, unknown>;
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
  const continuationFixture = buildNonHumanCompletionFixture(
    options.completionFixture,
    piWendaoConfigs,
  );
  const continuationFixturePath = continuationFixture
    ? await writeHostCompletionFixture(continuationFixture).then((fixture) => {
        options.tempDirs.push(fixture.dir);
        return fixture.path;
      })
    : undefined;
  const stallGuard = new WorkflowStallGuard();
  const onTraceEvent = async (event: QianjiTraceEvent) => {
    updatePendingActivities(pendingActivities, event);
    await options.onTraceEvent(event);
  };

  let session: QianjiHostSession | undefined;
  try {
    session = new QianjiHostSession(
      options.command,
      buildQianjiHostSessionArgs({
        sourcePath: options.sourcePath,
        processId: options.processId,
        instanceId: options.instanceId,
        context: options.context,
        dmnPaths: options.dmnPaths,
        hostFixturePath: continuationFixturePath,
        eventFixturePath: options.eventFixturePath,
        traceStream: true,
        startAtNode: options.startAtNode,
      }),
      options.cwd,
      onTraceEvent,
      options.options.signal,
    );
    let latest = await session.initial;
    appendCliResult(aggregate, latest);

    let guard = 0;
    while (latest.exitCode === 0 && resultOutcome(latest) === "blocked_on_host") {
      throwIfWorkflowInterrupted(options.options.signal);
      guard += 1;
      if (guard > 100) {
        throw new Error("qianji external host loop exceeded 100 host-boundary iterations");
      }
      const checkpoint = resultCheckpointFeedback(latest, latest.hostWork.length);
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
        options: options.options,
      });
      const hostCompletions = await runPendingHostWork({
        agentHost,
        humanTaskHandler: options.options.humanTaskHandler,
        piWendaoConfigs,
        pendingHostWork: latest.hostWork,
        variables: options.context,
        processId: options.processId,
        instanceId: options.instanceId,
        checkpoint,
        completionFixture: options.completionFixture,
        signal: options.options.signal,
      });
      if (!hostCompletions || hostCompletions.length === 0) {
        throw new Error("qianji stopped on host work but did not stream an active BPMN activity");
      }
      for (const [completionIndex, completion] of hostCompletions.entries()) {
        const completionPayload = {
          tokenId: completion.tokenId,
          processId: completion.processId,
          activityId: completion.nodeId,
          kind: completion.kind,
          data: completion.data,
          ...(completion.claimant ? { claimant: completion.claimant } : {}),
        };
        const continueUntilHumanBoundary = completionIndex === hostCompletions.length - 1;
        latest = await session.taskComplete(
          buildQianjiHostSessionTaskCompleteRequest({
            completion: completionPayload,
            continueUntilHumanBoundary,
          }),
        );
        const variables = resultVariables(latest);
        Object.assign(options.context, variables);
        appendCliResult(aggregate, latest);
        if (latest.exitCode !== 0) break;
      }
    }

    aggregate.exitCode = latest.exitCode;
    return aggregate;
  } finally {
    session?.close();
  }
}

async function runPendingHostWork(options: {
  agentHost: PiWendaoAgentHost;
  humanTaskHandler?: (request: HumanTaskPromptRequest) => Promise<string>;
  piWendaoConfigs: Map<string, PiWendaoConfig>;
  pendingHostWork: QianjiHostWork[];
  variables: Record<string, unknown>;
  processId: string;
  instanceId: string;
  checkpoint?: PiWendaoQianjiCheckpointFeedback;
  completionFixture?: HostCompletionFixture;
  signal?: AbortSignal;
}): Promise<HostCompletionResult[] | undefined> {
  throwIfWorkflowInterrupted(options.signal);
  const tokenResults = await Promise.all(
    options.pendingHostWork.map(async (work) => {
      throwIfWorkflowInterrupted(options.signal);
      const tokenVariables = { ...options.variables, ...(work.variables ?? {}) };
      const activityId = hostWorkActivityId(work);
      const processId = hostWorkProcessId(work, options.processId);
      const data = await runPiWendaoActivity({
        agentHost: options.agentHost,
        humanTaskHandler: options.humanTaskHandler,
        piWendaoConfigs: options.piWendaoConfigs,
        activityId,
        hostWork: work,
        hostKind: work.kind,
        variables: tokenVariables,
        execution: {
          processId,
          instanceId: options.instanceId,
          nodeIndex: work.node_index,
          tokenId: work.token_id,
          repeat: work.repeat,
          checkpoint: options.checkpoint,
        },
        completionFixture: options.completionFixture,
        signal: options.signal,
      });
      return {
        kind: work.kind,
        processId,
        nodeId: activityId,
        tokenId: work.token_id,
        ...(work.claim?.claimant ? { claimant: work.claim.claimant } : {}),
        data,
      };
    }),
  );
  for (const result of tokenResults) {
    Object.assign(options.variables, result.data);
  }
  return tokenResults.length > 0 ? tokenResults : undefined;
}

async function writeHostCompletionFixture(
  fixture: HostCompletionFixture,
): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wendao-qianji-host-"));
  const path = join(dir, "host-fixture.json");
  await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf-8");
  return { dir, path };
}

function buildNonHumanCompletionFixture(
  fixture: HostCompletionFixture | undefined,
  piWendaoConfigs: Map<string, PiWendaoConfig>,
): HostCompletionFixture | undefined {
  if (!fixture) return undefined;
  const nonHumanFixture: HostCompletionFixture = {};
  if (fixture.send_tasks) {
    nonHumanFixture.send_tasks = validateStaticFixtureBucket(fixture.send_tasks, piWendaoConfigs);
  }
  if (fixture.service_tasks) {
    nonHumanFixture.service_tasks = validateStaticFixtureBucket(
      fixture.service_tasks,
      piWendaoConfigs,
    );
  }
  if (fixture.service_task_tokens) nonHumanFixture.service_task_tokens = fixture.service_task_tokens;
  if (fixture.business_rule_tasks) nonHumanFixture.business_rule_tasks = fixture.business_rule_tasks;
  return hasHostCompletionResults(nonHumanFixture) ? nonHumanFixture : undefined;
}

function validateStaticFixtureBucket(
  bucket: Record<string, { data: Record<string, unknown> }>,
  piWendaoConfigs: Map<string, PiWendaoConfig>,
): Record<string, { data: Record<string, unknown> }> {
  const validated: Record<string, { data: Record<string, unknown> }> = {};
  for (const [activityId, entry] of Object.entries(bucket)) {
    const config = piWendaoConfigs.get(activityId);
    validated[activityId] = {
      data: config
        ? validateOutputSchemas(config, entry.data, { activityId })
        : entry.data,
    };
  }
  return validated;
}

async function runPiWendaoActivity(options: {
  agentHost: PiWendaoAgentHost;
  humanTaskHandler?: (request: HumanTaskPromptRequest) => Promise<string>;
  piWendaoConfigs: Map<string, PiWendaoConfig>;
  activityId: string;
  hostWork?: QianjiHostWork;
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
  const effectiveConfig = options.hostWork
    ? mergeQianjiHostWorkFormConfig(config, options.hostWork)
    : config;
  const hostKind = options.hostKind ?? config.hostKind;
  if (isHumanHostWorkKind(hostKind)) {
    if (!options.humanTaskHandler) {
      const element = hostKind === "manual" ? "manualTask" : "userTask";
      throw new Error(`BPMN ${element} '${options.activityId}' requires a human task handler`);
    }
    const resolvedConfig = resolveHumanTaskConfig(effectiveConfig, options.variables, {
      activityId: options.activityId,
    });
    const reply = await options.humanTaskHandler({
      activityId: options.activityId,
      config: resolvedConfig,
      variables: options.variables,
      ...(options.hostWork?.assignment ? { assignment: options.hostWork.assignment } : {}),
      ...(options.hostWork?.claim ? { claim: options.hostWork.claim } : {}),
      execution: {
        ...options.execution,
        activityId: options.activityId,
      },
    });
    throwIfWorkflowInterrupted(options.signal);
    const output = mapHumanTaskReplyToOutputs(
      reply,
      humanTaskReplyOutputNames(effectiveConfig, { activityId: options.activityId }),
    );
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
    config: effectiveConfig,
    variables: options.variables,
    signal: options.signal,
    execution: {
      ...options.execution,
      activityId: options.activityId,
    },
  });
  throwIfWorkflowInterrupted(options.signal);
  const validatedOutput = validateOutputSchemas(effectiveConfig, output, {
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
  if (!options.fixture || isHumanHostWorkKind(options.hostKind)) return undefined;
  const tokenData =
    options.tokenId !== undefined
      ? options.fixture.service_task_tokens?.[String(options.tokenId)]?.data
      : undefined;
  if (tokenData) return tokenData;
  switch (options.hostKind) {
    case "send":
      return options.fixture.send_tasks?.[options.activityId]?.data;
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
  options: ExecuteOptions;
}): void {
  if (!options.options.graphView || options.hostWork.length === 0) return;
  const byNode = new Map<string, QianjiHostWork[]>();
  for (const work of options.hostWork) {
    const activityId = hostWorkActivityId(work);
    const group = byNode.get(activityId) ?? [];
    group.push(work);
    byNode.set(activityId, group);
  }
  for (const [nodeId, work] of byNode) {
    const hostKinds = uniqueHostKinds(work.map((item) => item.kind));
    options.options.graphView.setNodeStatus(nodeId, "active");
    options.options.graphView.setNodeDetails(
      nodeId,
      buildGraphRuntimeDetails({
        hostWorkCount: work.length,
        hostKinds,
        config: options.piWendaoConfigs.get(nodeId),
        checkpoint: options.checkpoint,
        hostBackend: resolveHostBackendLabel(options.options, hostKinds),
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
  const assignmentSummaries = uniqueStrings(
    (options.hostWork ?? [])
      .map((work) => summarizeHumanTaskAssignment(work.assignment))
      .filter(isNonEmptyString),
  );
  if (assignmentSummaries.length > 0) {
    details.push(`assignment:${assignmentSummaries.join(";")}`);
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
    const activityId = hostWorkActivityId(work);
    const group = byNode.get(activityId) ?? [];
    group.push(work);
    byNode.set(activityId, group);
  }
  const batchParallel = hostWork.length > 1;
  return [...byNode.entries()].map(([activityId, work]) => {
    const repeatKinds = uniqueStrings(
      work.map((item) => readRepeatKind(item.repeat)).filter(isNonEmptyString),
    );
    const assignmentSummaries = uniqueStrings(
      work.map((item) => summarizeHumanTaskAssignment(item.assignment)).filter(isNonEmptyString),
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
      ...(assignmentSummaries.length > 0 ? { assignmentSummaries } : {}),
    };
  });
}

function summarizeHumanTaskAssignment(
  assignment: QianjiHumanTaskAssignment | null | undefined,
): string | undefined {
  if (!assignment) return undefined;
  const roles = [
    ...(assignment.human_performers ?? []).map((role) =>
      summarizeHumanTaskResourceRole("human_performer", role),
    ),
    ...(assignment.potential_owners ?? []).map((role) =>
      summarizeHumanTaskResourceRole("potential_owner", role),
    ),
  ].filter(isNonEmptyString);
  return roles.length > 0 ? roles.join(";") : undefined;
}

function summarizeHumanTaskResourceRole(
  kind: string,
  role: QianjiHumanTaskResourceRole,
): string {
  const label = [kind, role.name?.trim()].filter(isNonEmptyString).join(":");
  const resourceRef = role.resource_ref?.trim();
  const expression = role.assignment_expression?.trim();
  return [
    label,
    resourceRef ? `ref=${resourceRef}` : undefined,
    expression ? `expr=${expression}` : undefined,
  ]
    .filter(isNonEmptyString)
    .join(":");
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

function isHumanHostWorkKind(
  hostKind: PiWendaoHostWorkKind | undefined,
): hostKind is "user" | "manual" {
  return hostKind === "user" || hostKind === "manual";
}

function hostWorkActivityId(work: QianjiHostWork): string {
  return work.activity_id?.trim() || work.node_id;
}

function hostWorkProcessId(work: QianjiHostWork, fallback: string): string {
  return work.process_id?.trim() || fallback;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function resolveHostBackendLabel(
  options: ExecuteOptions,
  hostKinds: PiWendaoHostWorkKind[] = [],
): string | undefined {
  if (hostKinds.length > 0 && hostKinds.every(isHumanHostWorkKind) && options.humanTaskHandler) {
    return "human";
  }
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
  if (result.outcome) aggregate.outcome = result.outcome;
  if (result.checkpoint) aggregate.checkpoint = result.checkpoint;
  if (result.pendingHostWork !== undefined) aggregate.pendingHostWork = result.pendingHostWork;
  if (result.variables) {
    aggregate.variables = {
      ...(aggregate.variables ?? {}),
      ...result.variables,
    };
  }
}

function resultOutcome(result: QianjiCliResult): string | undefined {
  return result.outcome ?? parseQianjiOutcome(result.stdout);
}

function resultVariables(result: QianjiCliResult): Record<string, unknown> {
  return result.variables ?? parseQianjiVariables(result.stdout);
}

function resultCheckpointFeedback(
  result: QianjiCliResult,
  hostWorkCount = 0,
): PiWendaoQianjiCheckpointFeedback | undefined {
  if (result.checkpoint) {
    return {
      ...result.checkpoint,
      ...(result.outcome ? { outcome: result.outcome } : {}),
      ...(result.pendingHostWork !== undefined
        ? { pendingHostWork: String(result.pendingHostWork) }
        : {}),
    };
  }
  return parseQianjiCheckpointFeedback(result.stdout, hostWorkCount);
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

export function resolveTraceFrameDelayMs(
  options: Pick<ExecuteOptions, "graphView" | "traceFrameDelayMs">,
): number {
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
