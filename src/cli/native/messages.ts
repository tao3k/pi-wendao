import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import { MAX_MESSAGE_LINES, WORKFLOW_MESSAGE_TYPE } from "./constants.js";
import type { PiWendaoWorkflowMessageDetails } from "./types.js";
import { normalizeFoldedEventLines, normalizeMessageLines, stripAnsi } from "./text.js";

export interface FoldedWorkflowEvents {
  lineCount: number;
  samples: string[];
  flushed: boolean;
}

export interface NativeWorkflowRunMessageHandle {
  readonly details: PiWendaoWorkflowMessageDetails;
  append(kind: PiWendaoWorkflowMessageDetails["kind"], lines: string[], success?: boolean): void;
  complete(success: boolean | "interrupted" | undefined): void;
}

export interface NativeWorkflowRunMessageOptions {
  streamDetails?: PiWendaoWorkflowMessageDetails["streamDetails"];
}

const workflowRunMessages = new Map<string, PiWendaoWorkflowMessageDetails>();

export function sendWorkflowMessage(
  pi: ExtensionAPI,
  details: PiWendaoWorkflowMessageDetails,
): void {
  const normalizedLines = normalizeMessageLines(details.lines);
  if (normalizedLines.length === 0) return;
  const messageDetails = { ...details, lines: normalizedLines };
  pi.sendMessage<PiWendaoWorkflowMessageDetails>({
    customType: WORKFLOW_MESSAGE_TYPE,
    content: workflowMessageContext(messageDetails),
    display: true,
    details: messageDetails,
  });
}

export function startWorkflowRunMessage(
  pi: ExtensionAPI,
  workflowPath: string,
  now = Date.now(),
  options: NativeWorkflowRunMessageOptions = {},
): NativeWorkflowRunMessageHandle {
  const details: PiWendaoWorkflowMessageDetails = {
    kind: "run",
    id: randomUUID(),
    workflowPath,
    lines: ["starting workflow"],
    status: "running",
    streamDetails: options.streamDetails ?? "visible",
    eventCount: 0,
    agentCount: 0,
    errorCount: 0,
    startedAt: now,
  };
  workflowRunMessages.set(details.id!, details);
  pi.sendMessage<PiWendaoWorkflowMessageDetails>({
    customType: WORKFLOW_MESSAGE_TYPE,
    content: workflowMessageContext(details),
    display: true,
    details,
  });

  return {
    details,
    append(kind, lines, success) {
      appendWorkflowRunLines(details, kind, lines, success);
    },
    complete(success) {
      completeWorkflowRun(details, success);
    },
  };
}

export function renderWorkflowMessage(
  details: PiWendaoWorkflowMessageDetails,
  expanded: boolean,
  theme: PiTheme,
): string {
  if (details.kind === "run") {
    return renderWorkflowRunMessage(details, expanded, theme);
  }
  const icon =
    details.kind === "error" || details.success === false
      ? theme.fg("error", "x")
      : details.success === true
        ? theme.fg("success", "ok")
        : theme.fg("accent", "workflow");
  const title = [
    icon,
    theme.bold(labelForWorkflowMessage(details.kind)),
    details.workflowPath ? theme.fg("dim", basename(details.workflowPath)) : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const maxLines = expanded ? 80 : MAX_MESSAGE_LINES;
  const body = details.lines.slice(0, maxLines).map((line) => `  ${line}`);
  if (details.lines.length > maxLines) {
    body.push(theme.fg("muted", `  ... ${details.lines.length - maxLines} more lines`));
  }
  return [title, ...body].join("\n");
}

export function createFoldedWorkflowEvents(): FoldedWorkflowEvents {
  return {
    lineCount: 0,
    samples: [],
    flushed: false,
  };
}

export function foldWorkflowEventLines(state: FoldedWorkflowEvents, lines: string[]): void {
  if (state.flushed) return;
  const normalized = normalizeFoldedEventLines(lines);
  state.lineCount += normalized.length;
  for (const line of normalized) {
    if (state.samples.length >= 3) break;
    state.samples.push(line);
  }
}

export function workflowEventSummaryLines(state: FoldedWorkflowEvents): string[] {
  if (state.flushed || state.lineCount === 0) return [];
  state.flushed = true;
  return [
    `Workflow events folded: ${state.lineCount} line${state.lineCount === 1 ? "" : "s"}.`,
    ...state.samples.map((line) => `sample: ${line}`),
  ];
}

function appendWorkflowRunLines(
  details: PiWendaoWorkflowMessageDetails,
  kind: PiWendaoWorkflowMessageDetails["kind"],
  lines: string[],
  success?: boolean,
): void {
  const normalized = normalizeMessageLines(lines);
  if (normalized.length === 0) return;
  if (kind === "event") details.eventCount = (details.eventCount ?? 0) + normalized.length;
  if (kind === "agent") details.agentCount = (details.agentCount ?? 0) + normalized.length;
  if (kind === "error" || success === false) {
    details.errorCount = (details.errorCount ?? 0) + normalized.length;
    details.status = "failed";
  }
  if (details.streamDetails === "summary" && (kind === "event" || kind === "agent")) {
    return;
  }
  const label = labelForWorkflowMessage(kind);
  const prefixed = normalized.map((line) => `${label}: ${stripAnsi(line)}`);
  details.lines = [...details.lines, ...prefixed].slice(-240);
}

function completeWorkflowRun(
  details: PiWendaoWorkflowMessageDetails,
  success: boolean | "interrupted" | undefined,
): void {
  if (success === "interrupted") {
    details.status = "interrupted";
  } else if (details.status === "failed" || success === false) {
    details.status = "failed";
  } else {
    details.status = "completed";
  }
  details.success = details.status === "completed";
  details.completedAt = Date.now();
  appendWorkflowRunLines(
    details,
    "status",
    [
      details.status === "interrupted"
        ? "Workflow interrupted. Qianji checkpoint state was preserved."
        : details.success
          ? "Workflow completed successfully."
          : "Workflow failed.",
    ],
    details.status === "interrupted" ? undefined : details.success,
  );
  if (details.id) workflowRunMessages.delete(details.id);
}

function renderWorkflowRunMessage(
  details: PiWendaoWorkflowMessageDetails,
  expanded: boolean,
  theme: PiTheme,
): string {
  const liveDetails = details.id ? (workflowRunMessages.get(details.id) ?? details) : details;
  const status = liveDetails.status ?? "running";
  const icon =
    status === "running"
      ? theme.fg("accent", "▸")
      : status === "interrupted"
        ? theme.fg("warning", "!")
        : status === "failed"
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
  const title = [
    icon,
    theme.bold("workflow run"),
    liveDetails.workflowPath ? theme.fg("dim", basename(liveDetails.workflowPath)) : undefined,
    theme.fg(status === "failed" ? "error" : status === "interrupted" ? "warning" : "dim", status),
  ]
    .filter(Boolean)
    .join(" ");
  const stats = workflowRunStats(liveDetails, theme);
  const maxLines = expanded ? 80 : 8;
  const tail = liveDetails.lines.slice(-maxLines);
  const body = tail.map((line) => `  ${theme.fg("dim", `⎿ ${line}`)}`);
  if (!expanded && liveDetails.lines.length > tail.length) {
    body.unshift(
      theme.fg("muted", `  ... ${liveDetails.lines.length - tail.length} earlier stream lines`),
    );
  }
  if (expanded && liveDetails.lines.length > tail.length) {
    body.unshift(
      theme.fg("muted", `  ... ${liveDetails.lines.length - tail.length} earlier stream lines`),
    );
  }
  return [title, stats ? `  ${stats}` : undefined, ...body].filter(Boolean).join("\n");
}

function workflowRunStats(details: PiWendaoWorkflowMessageDetails, theme: PiTheme): string {
  const parts: string[] = [];
  if (details.eventCount)
    parts.push(`${details.eventCount} event${details.eventCount === 1 ? "" : "s"}`);
  if (details.agentCount)
    parts.push(`${details.agentCount} agent line${details.agentCount === 1 ? "" : "s"}`);
  if (details.errorCount)
    parts.push(`${details.errorCount} error line${details.errorCount === 1 ? "" : "s"}`);
  const startedAt = details.startedAt;
  const endedAt = details.completedAt ?? Date.now();
  if (startedAt) parts.push(`${Math.max(0, Math.round((endedAt - startedAt) / 1000))}s`);
  return parts.map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `);
}

function workflowMessageContext(details: PiWendaoWorkflowMessageDetails): string {
  const workflowPath = details.workflowPath ? `workflowPath: ${details.workflowPath}\n` : "";
  return [
    "[pi-wendao workflow event]",
    workflowPath.trimEnd(),
    `kind: ${details.kind}`,
    ...details.lines.map((line) => `- ${stripAnsi(line)}`),
  ]
    .filter(Boolean)
    .join("\n");
}

function labelForWorkflowMessage(kind: PiWendaoWorkflowMessageDetails["kind"]): string {
  switch (kind) {
    case "agent":
      return "agent";
    case "prompt":
      return "input";
    case "show":
      return "qianji status";
    case "error":
      return "error";
    case "status":
      return "status";
    case "event":
      return "event";
    case "run":
      return "run";
  }
}
