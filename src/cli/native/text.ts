import type { PiWendaoThinkingLevel } from "../../executor/agent-runtime-types.js";
import type { PlannerReplyRequest } from "../../ui/renderer.js";
import { MAX_MESSAGE_LINE_LENGTH, MAX_MESSAGE_LINES } from "./constants.js";

export function normalizeThinkingLevel(
  value: string,
  fallback: PiWendaoThinkingLevel,
): PiWendaoThinkingLevel {
  return isPiWendaoThinkingLevel(value) ? value : fallback;
}

export function isPiWendaoThinkingLevel(value: string): value is PiWendaoThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

export function promptLabel(request: PlannerReplyRequest): string {
  if (request.action === "workflow_path") return "workflow path";
  if (request.action === "human_task" || request.to === "user") return "workflow user input";
  return "planner approval";
}

export function defaultReply(request: PlannerReplyRequest): string {
  if (request.action === "workflow_path") return "";
  if (request.action === "human_task" || request.to === "user") {
    return request.interaction?.type === "confirm" ? "approved" : "";
  }
  return "approved";
}

export function normalizeMessageLines(lines: string[]): string[] {
  return lines
    .flatMap((line) => line.split(/\r?\n/))
    .map((line) => compactLine(line, MAX_MESSAGE_LINE_LENGTH))
    .filter((line) => line.trim().length > 0)
    .slice(0, MAX_MESSAGE_LINES);
}

export function normalizeFoldedEventLines(lines: string[]): string[] {
  return lines
    .flatMap((line) => line.split(/\r?\n/))
    .map((line) => compactLine(line, MAX_MESSAGE_LINE_LENGTH))
    .filter((line) => line.trim().length > 0);
}

export function isWorkflowErrorLine(line: string): boolean {
  const stripped = stripAnsi(line).trim();
  return (
    stripped.startsWith("Error:") ||
    stripped.startsWith("Execution failed:") ||
    stripped.includes("No API key found")
  );
}

export function isPrintableInput(data: string): boolean {
  return data.length > 0 && !/[\u0000-\u001F\u007F]/.test(data);
}

export function compactLine(line: string, maxLength: number): string {
  const stripped = stripAnsi(line).replace(/\s+/g, " ").trim();
  if (stripped.length <= maxLength) return stripped;
  return `${stripped.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function formatVariable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
