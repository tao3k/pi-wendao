import { cyan, dim, green } from "yoctocolors";
import type {
  PiWendaoAgentEvent,
  PiWendaoAgentMessage,
} from "../../executor/agent-runtime-types.js";
import {
  clampLines,
  compactLinePreservingShape,
  countNonEmptyLines,
  formatJsonSummaryLines,
  isRecord,
  parseJson,
} from "./text.js";
import { formatToolResultForLog, formatToolStartForLog } from "./tool-log.js";

export class AgentEventLogBuffer {
  private assistantText = "";
  private thinkingText = "";

  handle(event: PiWendaoAgentEvent): string[] {
    switch (event.type) {
      case "message_start": {
        if (event.message.role === "assistant") {
          this.assistantText = "";
          this.thinkingText = "";
        }
        return [];
      }
      case "message_update": {
        const assistantEvent = event.assistantMessageEvent;
        switch (assistantEvent.type) {
          case "text_delta":
            this.assistantText += assistantEvent.delta;
            return [];
          case "thinking_start":
            this.thinkingText = "";
            return [dim("thinking summary")];
          case "thinking_delta":
            this.thinkingText += assistantEvent.delta;
            return [];
          case "thinking_end": {
            const text = assistantEvent.content || this.thinkingText;
            this.thinkingText = "";
            return formatThinkingMessageForLog(text);
          }
          default:
            return [];
        }
      }
      case "message_end": {
        if (event.message.role !== "assistant") return [];
        const text = this.assistantText || extractMessageText(event.message);
        this.assistantText = "";
        return formatAssistantMessageForLog(text);
      }
      case "tool_execution_start":
        return formatToolStartForLog(event.toolName, event.args);
      case "tool_execution_end":
        return formatToolResultForLog(event.toolName, event.result, event.isError);
      default:
        return [];
    }
  }
}

export function formatAssistantMessageForLog(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return [cyan("assistant"), ...formatStructuredMessageLines(trimmed, "  ")];
}

export function formatUserMessageForLog(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return [green("user"), ...formatStructuredMessageLines(trimmed, "  ")];
}

export function formatThinkingMessageForLog(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return formatIndentedTextLines(trimmed, "  ", 8).map(dim);
}

function formatStructuredMessageLines(text: string, indent: string): string[] {
  const lines: string[] = [];
  const blockPattern = /```([A-Za-z0-9_-]*)?\s*\n?([\s\S]*?)\n?```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(text)) !== null) {
    lines.push(...formatIndentedTextLines(text.slice(cursor, match.index), indent, 12));
    const language = (match[1] ?? "").toLowerCase();
    const body = match[2] ?? "";
    const parsed = parseJson(body.trim());
    if (parsed.ok) {
      lines.push(`${indent}${green("output")}`);
      lines.push(...formatJsonSummaryLines(parsed.value).map((line) => `${indent}  ${line}`));
    } else {
      const label = language ? `code ${language}` : "code";
      lines.push(`${indent}${label}: ${countNonEmptyLines(body)} lines`);
    }
    cursor = match.index + match[0].length;
  }

  lines.push(...formatIndentedTextLines(text.slice(cursor), indent, 12));
  return clampLines(lines, 18);
}

function formatIndentedTextLines(text: string, indent: string, limit: number): string[] {
  const normalized = text
    .replace(/```/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return clampLines(
    normalized.map((line) => `${indent}${compactLinePreservingShape(line, 180)}`),
    limit,
  );
}

function extractMessageText(message: PiWendaoAgentMessage): string {
  if (!isRecord(message)) return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => {
      if (!isRecord(entry)) return "";
      return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .join("");
}
