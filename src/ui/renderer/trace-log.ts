import { cyan, dim, green, red } from "yoctocolors";
import type { LogView } from "../graph-view.js";
import type { QianjiTraceLogEvent } from "./types.js";

export function appendTraceEvent(logView: LogView, event: QianjiTraceLogEvent): void {
  if (event.kind === "flow_take") {
    logView.appendLine(dim(`flow ${event.source_id} -> ${event.target_id}`));
    return;
  }
  logView.appendLine(formatTraceNodeStatus(event));
}

export function appendTraceEventToConsole(event: QianjiTraceLogEvent): void {
  if (event.kind === "flow_take") {
    console.log(dim(`flow ${event.source_id} -> ${event.target_id}`));
    return;
  }
  console.log(formatTraceNodeStatus(event));
}

function formatTraceNodeStatus(
  event: Extract<QianjiTraceLogEvent, { kind: "node_status" }>,
): string {
  const kind = event.node_kind ? event.node_kind.replace(/_/g, " ") : "node";
  const label = `${kind} ${event.node_id}`;
  switch (event.status) {
    case "queued":
      return dim(`${label} queued`);
    case "executing":
      return cyan(`${label} executing`);
    case "completed":
      return green(`${label} completed`);
    case "failed":
    case "cancelled":
      return red(`${label} ${event.status}`);
    default:
      return `${label} ${event.status}`;
  }
}
