import {
  buildPiWendaoConfigMap,
  type HostCompletionFixture,
} from "./bpmn-config.js";
import { isWorkflowInterruptedError, throwIfWorkflowInterrupted } from "./interrupt.js";
import { createPiAiHost } from "./node-runner.js";
import type { ExecuteOptions } from "./executor.js";
import type {
  PiWendaoAgentHost,
  PiWendaoQianjiCheckpointFeedback,
} from "./agent-host.js";
import type {
  QianjiCliResult,
  QianjiHostWork,
  QianjiTraceEvent,
} from "./qianji-types.js";
import {
  applyQianjiHostWorkGraph,
  appendCliResult,
  createMissingAgentHost,
  emitQianjiHostWorkEvents,
  resultOutcome,
  resultVariables,
  updatePendingActivities,
} from "./executor-runtime-state.js";
import { type HostCompletionResult, runPendingHostWork } from "./executor-host-loop.js";
import { WorkflowStallGuard } from "./stall-guard.js";
import {
  completeHostWork,
  completeHostWorkBatch,
  resumeOrStartWorkflow,
  type QianjiServerPendingHostWork,
  type QianjiServerWorkflowHttpOptions,
  type QianjiServerWorkflowResponse,
} from "./qianji-server/http.js";

interface QianjiServerExternalHostLoopOptions {
  serverUrl: string;
  sourcePath: string;
  processId: string;
  instanceId: string;
  context: Record<string, unknown>;
  dmnPaths: string[];
  cwd: string;
  source: string;
  startAtNode?: string;
  options: ExecuteOptions;
  completionFixture?: HostCompletionFixture;
  onTraceEvent: (event: QianjiTraceEvent) => void | Promise<void>;
}

export class QianjiServerWorkflowExecutionError extends Error {
  readonly result: QianjiCliResult;

  constructor(message: string, result: QianjiCliResult) {
    super(message);
    this.name = "QianjiServerWorkflowExecutionError";
    this.result = result;
  }
}

export function isQianjiServerWorkflowExecutionError(
  error: unknown,
): error is QianjiServerWorkflowExecutionError {
  return error instanceof QianjiServerWorkflowExecutionError;
}

export async function runQianjiServerExternalHostLoop(
  options: QianjiServerExternalHostLoopOptions,
): Promise<QianjiCliResult> {
  return runQianjiServerHostLoop(options);
}

async function runQianjiServerHostLoop(
  options: QianjiServerExternalHostLoopOptions,
): Promise<QianjiCliResult> {
  const piWendaoConfigs = buildPiWendaoConfigMap(options.source, options.processId);
  const agentHost = buildAgentHost(options);
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

  const httpOptions = workflowHttpOptions(options);
  let latest = await resumeOrStartWorkflow(httpOptions);
  appendCliResult(aggregate, toCliResult(latest));

  let guard = 0;
  while (resultOutcome(toCliResult(latest)) === "blocked_on_host") {
    throwIfWorkflowInterrupted(options.options.signal);
    guard += 1;
    if (guard > 100) {
      throw new Error("qianji server host loop exceeded 100 host-boundary iterations");
    }

    const latestCli = toCliResult(latest);
    const checkpoint = buildCheckpointFeedback(latest);
    const pendingHostWork = latestCli.hostWork;
    stallGuard.inspectPendingHostWork({
      hostWork: pendingHostWork,
      piWendaoConfigs,
      variables: options.context,
    });
    emitQianjiHostWorkEvents(pendingHostWork, options.options);
    applyQianjiHostWorkGraph({
      hostWork: pendingHostWork,
      piWendaoConfigs,
      checkpoint,
      options: options.options,
    });
    await onTraceEvent({
      kind: "node_status",
      node_id: pendingHostWork[0]?.node_id ?? "qianji-server-host-work",
      status: "executing",
    });

    let hostCompletions: HostCompletionResult[] | undefined;
    try {
      hostCompletions = await runPendingHostWork({
        agentHost,
        humanTaskHandler: options.options.humanTaskHandler,
        piWendaoConfigs,
        pendingHostWork,
        variables: options.context,
        processId: options.processId,
        instanceId: options.instanceId,
        checkpoint,
        completionFixture: options.completionFixture,
        signal: options.options.signal,
      });
    } catch (error) {
      if (!isWorkflowInterruptedError(error)) {
        await emitHostWorkTerminalTrace(pendingHostWork, "failed", onTraceEvent);
      }
      throw qianjiServerWorkflowExecutionError(error, aggregate);
    }
    if (!hostCompletions || hostCompletions.length === 0) {
      throw qianjiServerWorkflowExecutionError(
        new Error("qianji server stopped on host work but returned no active work items"),
        aggregate,
      );
    }
    if (hostCompletions.length > 1) {
      try {
        latest = await completeHostWorkBatch(httpOptions, hostCompletions);
      } catch (error) {
        await emitHostWorkTerminalTrace(pendingHostWork, "failed", onTraceEvent);
        throw qianjiServerWorkflowExecutionError(error, aggregate);
      }
      const latestResult = toCliResult(latest);
      Object.assign(options.context, resultVariables(latestResult));
      appendCliResult(aggregate, latestResult);
      if (latestResult.exitCode !== 0) {
        await emitHostWorkTerminalTrace(pendingHostWork, "failed", onTraceEvent);
      } else {
        await emitClearedCompletionTerminalTrace(hostCompletions, latestResult.hostWork, onTraceEvent);
      }
    } else {
      for (const completion of hostCompletions) {
        try {
          latest = await completeHostWork(httpOptions, completion);
        } catch (error) {
          await emitCompletionTerminalTrace(completion, "failed", onTraceEvent);
          throw qianjiServerWorkflowExecutionError(error, aggregate);
        }
        const latestResult = toCliResult(latest);
        Object.assign(options.context, resultVariables(latestResult));
        appendCliResult(aggregate, latestResult);
        if (latestResult.exitCode !== 0) {
          await emitCompletionTerminalTrace(completion, "failed", onTraceEvent);
          break;
        }
        if (!hasPendingHostWorkForNode(latestResult.hostWork, completion.nodeId)) {
          await emitCompletionTerminalTrace(completion, "completed", onTraceEvent);
        }
      }
    }
  }

  const finalResult = toCliResult(latest);
  aggregate.exitCode = finalResult.exitCode;
  return aggregate;
}

function buildAgentHost(options: QianjiServerExternalHostLoopOptions): PiWendaoAgentHost {
  return (
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
      : createMissingAgentHost())
  );
}

function workflowHttpOptions(
  options: QianjiServerExternalHostLoopOptions,
): QianjiServerWorkflowHttpOptions {
  return {
    serverUrl: options.serverUrl,
    sourcePath: options.sourcePath,
    processId: options.processId,
    instanceId: options.instanceId,
    context: options.context,
    dmnPaths: options.dmnPaths,
    ...(options.startAtNode ? { startAtNode: options.startAtNode } : {}),
    ...(options.options.qianjiWorkflowStartMode
      ? { startMode: options.options.qianjiWorkflowStartMode }
      : {}),
    signal: options.options.signal,
  };
}

function toCliResult(response: QianjiServerWorkflowResponse): QianjiCliResult {
  const outcome = normalizeOutcome(response.outcome);
  const hostWork = (response.workflow?.pending_host_work ?? []).map(toQianjiHostWork);
  const variables = response.workflow?.variables ?? {};
  const pendingHostWork = response.workflow?.pending_host_work_count ?? hostWork.length;
  const checkpoint = buildCheckpointFeedback(response);
  return {
    exitCode: outcome === "failed" ? 1 : 0,
    stdout: renderServerWorkflowReport(outcome, checkpoint, pendingHostWork),
    stderr: "",
    streamedTrace: false,
    hostWork,
    ...(outcome ? { outcome } : {}),
    checkpoint,
    pendingHostWork,
    variables,
  };
}

function toQianjiHostWork(work: QianjiServerPendingHostWork): QianjiHostWork {
  const kind = normalizeHostWorkKind(work.kind);
  const tokenId = typeof work.token_id === "number" ? work.token_id : -1;
  const nodeId = work.node_id?.trim() || work.activity_id?.trim() || `node_${work.node_index ?? tokenId}`;
  return {
    kind,
    ...(work.process_id ? { process_id: work.process_id } : {}),
    ...(work.activity_id ? { activity_id: work.activity_id } : {}),
    node_id: nodeId,
    ...(typeof work.node_index === "number" ? { node_index: work.node_index } : {}),
    token_id: tokenId,
    variables: hostWorkVariables(work),
    repeat: work.repeat,
    form: work.form ?? null,
    assignment: work.assignment ?? null,
    claim: work.claim ?? null,
  };
}

function hostWorkVariables(work: QianjiServerPendingHostWork): Record<string, unknown> {
  return {
    ...(work.variables ?? {}),
    ...(work.inputs ?? {}),
  };
}

function qianjiServerWorkflowExecutionError(
  error: unknown,
  aggregate: QianjiCliResult,
): QianjiServerWorkflowExecutionError {
  const message = error instanceof Error ? error.message : String(error);
  return new QianjiServerWorkflowExecutionError(message, {
    ...aggregate,
    hostWork: [...aggregate.hostWork],
    variables: aggregate.variables ? { ...aggregate.variables } : undefined,
    exitCode: 1,
    stderr: [aggregate.stderr.trim(), message].filter(Boolean).join("\n"),
  });
}

function renderServerWorkflowReport(
  outcome: string | undefined,
  checkpoint: PiWendaoQianjiCheckpointFeedback,
  pendingHostWork: number,
): string {
  return [
    "# BPMN Server Workflow",
    "",
    `Outcome: ${outcome ?? "unknown"}`,
    ...(checkpoint.backend ? [`Checkpoint backend: ${checkpoint.backend}`] : []),
    ...(checkpoint.source ? [`Checkpoint source: ${checkpoint.source}`] : []),
    ...(checkpoint.saved ? [`Checkpoint saved: ${checkpoint.saved}`] : []),
    ...(checkpoint.deleted ? [`Checkpoint deleted: ${checkpoint.deleted}`] : []),
    `Pending host work: ${pendingHostWork}`,
  ].join("\n");
}

async function emitCompletionTerminalTrace(
  completion: HostCompletionResult,
  status: "completed" | "failed",
  onTraceEvent: (event: QianjiTraceEvent) => void | Promise<void>,
): Promise<void> {
  await onTraceEvent({
    kind: "node_status",
    node_id: completion.nodeId,
    node_kind: hostWorkKindToNodeKind(completion.kind),
    status,
  });
}

async function emitHostWorkTerminalTrace(
  hostWork: QianjiHostWork[],
  status: "completed" | "failed",
  onTraceEvent: (event: QianjiTraceEvent) => void | Promise<void>,
): Promise<void> {
  const emitted = new Set<string>();
  for (const work of hostWork) {
    const nodeId = work.node_id;
    if (emitted.has(nodeId)) continue;
    emitted.add(nodeId);
    await onTraceEvent({
      kind: "node_status",
      node_id: nodeId,
      node_kind: hostWorkKindToNodeKind(work.kind),
      status,
    });
  }
}

async function emitClearedCompletionTerminalTrace(
  completions: HostCompletionResult[],
  latestHostWork: QianjiHostWork[],
  onTraceEvent: (event: QianjiTraceEvent) => void | Promise<void>,
): Promise<void> {
  const emitted = new Set<string>();
  for (const completion of completions) {
    if (emitted.has(completion.nodeId)) continue;
    if (hasPendingHostWorkForNode(latestHostWork, completion.nodeId)) continue;
    emitted.add(completion.nodeId);
    await emitCompletionTerminalTrace(completion, "completed", onTraceEvent);
  }
}

function hasPendingHostWorkForNode(hostWork: QianjiHostWork[], nodeId: string): boolean {
  return hostWork.some((work) => work.node_id === nodeId || work.activity_id === nodeId);
}

function hostWorkKindToNodeKind(kind: QianjiHostWork["kind"]): string {
  switch (kind) {
    case "send":
      return "send_task";
    case "service":
      return "service_task";
    case "script":
      return "script_task";
    case "user":
      return "user_task";
    case "manual":
      return "manual_task";
    case "business_rule":
      return "business_rule_task";
  }
}

function normalizeOutcome(outcome: unknown): string | undefined {
  if (typeof outcome === "string") return outcome;
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return undefined;
  return Object.keys(outcome)[0];
}

function normalizeHostWorkKind(kind: string | undefined): QianjiHostWork["kind"] {
  switch (kind) {
    case "send":
    case "service":
    case "script":
    case "user":
    case "manual":
    case "business_rule":
      return kind;
    default:
      throw new Error(`qianji server returned unsupported host work kind '${kind ?? ""}'`);
  }
}

function buildCheckpointFeedback(
  response: QianjiServerWorkflowResponse,
): PiWendaoQianjiCheckpointFeedback {
  return {
    source: "qianji-server",
    ...(response.checkpoint_backend ? { backend: response.checkpoint_backend } : {}),
    ...(response.checkpoint_saved !== undefined ? { saved: String(response.checkpoint_saved) } : {}),
    ...(response.checkpoint_deleted !== undefined
      ? { deleted: String(response.checkpoint_deleted) }
      : {}),
    ...(response.workflow?.pending_host_work_count !== undefined
      ? { pendingHostWork: String(response.workflow.pending_host_work_count) }
      : {}),
    ...(normalizeOutcome(response.outcome) ? { outcome: normalizeOutcome(response.outcome) } : {}),
  };
}
