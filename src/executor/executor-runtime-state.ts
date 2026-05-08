import { buildQianjiStatusArgs, runQianjiCli } from "./qianji-cli.js";
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
  QianjiHumanTaskAssignment,
  QianjiHumanTaskResourceRole,
  QianjiTraceEvent,
} from "./qianji-types.js";
import type {
  PiWendaoAgentHost,
  PiWendaoConfig,
  PiWendaoHostWorkKind,
  PiWendaoQianjiCheckpointFeedback,
} from "./agent-host.js";
import { isObject } from "./data.js";
import type { ExecuteOptions } from "./executor.js";

const DEFAULT_GRAPH_TRACE_FRAME_DELAY_MS = 0;

export async function applyCheckpointGraphSnapshot(options: {
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

export function updatePendingActivities(pendingActivities: Set<string>, event: QianjiTraceEvent): void {
  if (event.kind !== "node_status" || !isActivityTraceNode(event)) return;
  if (event.status === "executing") {
    pendingActivities.add(event.node_id);
    return;
  }
  if (event.status === "completed" || event.status === "cancelled" || event.status === "failed") {
    pendingActivities.delete(event.node_id);
  }
}

export function applyQianjiHostWorkGraph(options: {
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

export function buildGraphRuntimeDetails(options: {
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

export function emitQianjiHostWorkEvents(hostWork: QianjiHostWork[], options: ExecuteOptions): void {
  if (!options.onHostWork || hostWork.length === 0) return;
  for (const event of buildQianjiHostWorkEvents(hostWork)) {
    options.onHostWork(event);
  }
}

export function buildQianjiHostWorkEvents(hostWork: QianjiHostWork[]): QianjiHostWorkEvent[] {
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

export function summarizeHumanTaskAssignment(
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

export function summarizeHumanTaskResourceRole(
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

export function buildParallelRuntimeDetail(
  hostWork: QianjiHostWork[],
  batchHostWorkCount: number,
): string | undefined {
  const parallel = batchHostWorkCount > 1 || hostWork.some((work) => isParallelRepeat(work.repeat));
  if (!parallel) return undefined;
  const tokens = hostWork.map((work) => work.token_id).join(",");
  const batch = batchHostWorkCount > hostWork.length ? `batch=${batchHostWorkCount} ` : "";
  return `parallel:${batch}${hostWork.length} jobs tokens=${tokens}`;
}

export function isParallelRepeat(repeat: unknown): boolean {
  const kind = readRepeatKind(repeat);
  return !!kind && /\bparallel\b/i.test(kind);
}

export function readRepeatKind(repeat: unknown): string | undefined {
  if (!isObject(repeat)) return undefined;
  return typeof repeat.kind === "string" && repeat.kind.trim() ? repeat.kind.trim() : undefined;
}

export function summarizeRepeat(repeat: unknown): string | undefined {
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

export function uniqueHostKinds(values: PiWendaoHostWorkKind[]): PiWendaoHostWorkKind[] {
  return [...new Set(values)];
}

export function isHumanHostWorkKind(
  hostKind: PiWendaoHostWorkKind | undefined,
): hostKind is "user" | "manual" {
  return hostKind === "user" || hostKind === "manual";
}

export function hostWorkActivityId(work: QianjiHostWork): string {
  return work.activity_id?.trim() || work.node_id;
}

export function hostWorkProcessId(work: QianjiHostWork, fallback: string): string {
  return work.process_id?.trim() || fallback;
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

export function resolveHostBackendLabel(
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

export function createMissingAgentHost(): PiWendaoAgentHost {
  return {
    async run(request) {
      throw new Error(`BPMN serviceTask '${request.activityId}' requires a model or agent host`);
    },
  };
}

export function appendCliResult(aggregate: QianjiCliResult, result: QianjiCliResult): void {
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

export function resultOutcome(result: QianjiCliResult): string | undefined {
  return result.outcome ?? parseQianjiOutcome(result.stdout);
}

export function resultVariables(result: QianjiCliResult): Record<string, unknown> {
  return result.variables ?? parseQianjiVariables(result.stdout);
}

export function resultCheckpointFeedback(
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

export function applyQianjiTrace(output: string, options: ExecuteOptions): void {
  const trace = parseQianjiTrace(output);
  if (trace.length === 0) return;
  applyQianjiTraceEvents(trace, options);
}

export function applyQianjiTraceEvents(trace: QianjiTraceEvent[], options: ExecuteOptions): void {
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

export function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
