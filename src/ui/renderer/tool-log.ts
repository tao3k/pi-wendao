import { dim, green, red, yellow } from "yoctocolors";
import {
  compactInline,
  formatJsonSummary,
  isRecord,
  parseJson,
  quoteIfNeeded,
  summarizeValue,
  countNonEmptyLines,
} from "./text.js";

export function formatVariableValueForLog(value: unknown): string {
  return summarizeValue(value);
}

export function formatToolStartForLog(toolName: string, args: unknown): string[] {
  const formattedArgs = formatArgsForLog(args);
  const lines = [yellow(`tool ${toolName}`)];
  if (formattedArgs)
    lines.push(dim(`  ${hasCommandLikeArg(args) ? "command" : "args"}: ${formattedArgs}`));
  return lines;
}

export function formatToolResultForLog(
  toolName: string,
  result: unknown,
  isError: boolean,
): string[] {
  const summary = summarizeToolResult(result);
  const lines = [isError ? red(`tool ${toolName} failed`) : green(`tool ${toolName} done`)];
  if (!summary) return lines;
  if (isError) {
    lines.push(red(`  result: ${summary}`));
    return lines;
  }
  lines.push(dim(`  result: ${summary}`));
  return lines;
}

export function formatArgsForLog(args: unknown): string {
  if (args == null) return "";
  if (typeof args !== "object") return String(args);
  const obj = args as Record<string, unknown>;
  const command = firstStringValue(obj, ["command", "cmd", "script"]);
  if (command) return quoteIfNeeded(compactInline(command, 120));

  const parts: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const str =
      typeof value === "string"
        ? quoteIfNeeded(compactInline(value, 60))
        : compactInline(JSON.stringify(value), 60);
    parts.push(`${key}=${str}`);
  }
  return parts.join(", ");
}

function firstStringValue(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function hasCommandLikeArg(args: unknown): boolean {
  if (!isRecord(args)) return false;
  return firstStringValue(args, ["command", "cmd", "script"]) !== undefined;
}

function summarizeToolResult(result: unknown): string {
  const text = extractToolText(result).trim();
  if (!text) return "";

  const parsed = parseJson(text);
  if (parsed.ok) return formatJsonSummary(parsed.value);

  const lines = countNonEmptyLines(text);
  if (lines > 1) return `${lines} lines`;
  return compactInline(text, 100);
}

function extractToolText(result: unknown): string {
  if (!isRecord(result)) return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (!isRecord(entry)) return "";
      return typeof entry.text === "string" ? entry.text : "";
    })
    .filter(Boolean)
    .join("\n");
}
