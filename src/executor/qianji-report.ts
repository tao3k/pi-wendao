import type { NodeStatus } from "../ui/graph-view.js";
import type { PiWendaoQianjiCheckpointFeedback } from "./agent-host.js";
import { isObject } from "./data.js";
import type {
  QianjiGraphSnapshotNode,
  QianjiTraceEvent,
  QianjiTraceNodeStatusEvent,
} from "./qianji-types.js";

const ACTIVITY_TRACE_NODE_KINDS = new Set([
  "business_rule_task",
  "manual_task",
  "receive_task",
  "script_task",
  "send_task",
  "service_task",
  "sub_process",
  "user_task",
]);

export function parseQianjiVariables(output: string): Record<string, unknown> {
  const variablesSection = output.lastIndexOf("## Variables");
  if (variablesSection === -1) return {};
  const match = output.slice(variablesSection).match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return {};
  const parsed = JSON.parse(match[1]) as unknown;
  if (!isObject(parsed)) {
    throw new Error("qianji variables block did not contain a JSON object");
  }
  return parsed;
}

export function parseQianjiTrace(output: string): QianjiTraceEvent[] {
  const traceSection = output.lastIndexOf("## Trace");
  if (traceSection === -1) return [];
  const match = output.slice(traceSection).match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return [];
  const parsed = JSON.parse(match[1]) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isQianjiTraceEvent);
}

export function parseQianjiGraphSnapshot(output: string): QianjiGraphSnapshotNode[] {
  const snapshotSection = output.lastIndexOf("## Graph Snapshot");
  if (snapshotSection === -1) return [];
  const match = output.slice(snapshotSection).match(/```json\s*([\s\S]*?)\s*```/);
  if (!match) return [];
  const parsed = JSON.parse(match[1]) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isQianjiGraphSnapshotNode);
}

export function parseQianjiOutcome(output: string): string | undefined {
  const match = output.match(/^Outcome:\s*([a-z_]+)/m);
  return match?.[1];
}

export function parseQianjiCheckpointFeedback(
  output: string,
  hostWorkCount = 0,
): PiWendaoQianjiCheckpointFeedback | undefined {
  const feedback: PiWendaoQianjiCheckpointFeedback = {
    ...(extractQianjiReportField(output, "Outcome")
      ? { outcome: extractQianjiReportField(output, "Outcome") }
      : {}),
    ...(extractQianjiReportField(output, "Checkpoint backend")
      ? { backend: extractQianjiReportField(output, "Checkpoint backend") }
      : {}),
    ...(extractQianjiReportField(output, "Checkpoint source")
      ? { source: extractQianjiReportField(output, "Checkpoint source") }
      : {}),
    ...(extractQianjiReportField(output, "Checkpoint saved")
      ? { saved: extractQianjiReportField(output, "Checkpoint saved") }
      : {}),
    ...(extractQianjiReportField(output, "Checkpoint deleted")
      ? { deleted: extractQianjiReportField(output, "Checkpoint deleted") }
      : {}),
    ...(extractQianjiReportField(output, "Checkpoint status")
      ? { status: extractQianjiReportField(output, "Checkpoint status") }
      : {}),
    ...(extractQianjiReportField(output, "Pending host work")
      ? { pendingHostWork: extractQianjiReportField(output, "Pending host work") }
      : {}),
  };
  if (!feedback.pendingHostWork && hostWorkCount > 0) {
    feedback.pendingHostWork = String(hostWorkCount);
  }
  return Object.keys(feedback).length > 0 ? feedback : undefined;
}

export function isQianjiTraceEvent(value: unknown): value is QianjiTraceEvent {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "node_status") {
    return (
      typeof value.node_id === "string" &&
      typeof value.status === "string" &&
      (value.node_kind === undefined ||
        value.node_kind === null ||
        typeof value.node_kind === "string")
    );
  }
  if (value.kind === "flow_take") {
    return typeof value.source_id === "string" && typeof value.target_id === "string";
  }
  return false;
}

export function isActivityTraceNode(event: QianjiTraceNodeStatusEvent): boolean {
  if (!event.node_kind) return true;
  return ACTIVITY_TRACE_NODE_KINDS.has(event.node_kind);
}

export function toGraphNodeStatus(status: string): NodeStatus | undefined {
  switch (status) {
    case "idle":
      return "pending";
    case "queued":
    case "executing":
      return "active";
    case "completed":
      return "done";
    case "cancelled":
    case "failed":
      return "error";
    default:
      return undefined;
  }
}

function extractQianjiReportField(output: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`^${escaped}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

function isQianjiGraphSnapshotNode(value: unknown): value is QianjiGraphSnapshotNode {
  if (!isObject(value)) return false;
  if (typeof value.node_id !== "string" || !value.node_id.trim()) return false;
  if (typeof value.status !== "string") return false;
  if (
    value.node_kind !== undefined &&
    value.node_kind !== null &&
    typeof value.node_kind !== "string"
  ) {
    return false;
  }
  if (value.node_index !== undefined && typeof value.node_index !== "number") return false;
  return true;
}
