import { dim, green, yellow } from "yoctocolors";
import type { PiSubagentsHostLogEvent, PiSubagentsHostToolLogEvent } from "./types.js";
import {
  clampLines,
  compactInline,
  compactLinePreservingShape,
  isRecord,
  shortAgentId,
} from "./text.js";
import { formatAssistantMessageForLog, formatUserMessageForLog } from "./message-log.js";
import { formatArgsForLog, formatToolResultForLog, formatToolStartForLog } from "./tool-log.js";

export function formatPiSubagentsHostEventForLog(event: PiSubagentsHostLogEvent): string[] {
  const label = `subagent ${event.activityId}`;
  const agent = shortAgentId(event.agentId);
  switch (event.type) {
    case "spawned":
      return [yellow(label), dim(`  ${agent} spawned: ${event.description}`)];
    case "resumed":
      return [yellow(label), dim(`  ${agent} resumed: ${event.description}`)];
    case "waiting":
      return [dim(`${label} ${agent} thinking...`)];
    case "result":
      return formatPiSubagentResultForLog(event.resultText, label, agent);
  }
}

export function formatPiSubagentsHostToolEventForLog(event: PiSubagentsHostToolLogEvent): string[] {
  if (event.type === "tool_call") {
    const lines = formatToolStartForLog(event.toolName, event.input);
    return [yellow(`subagent ${event.activityId}`), ...lines.map((line) => `  ${line}`)];
  }
  const lines = formatToolResultForLog(event.toolName, { content: event.content }, event.isError);
  return [yellow(`subagent ${event.activityId}`), ...lines.map((line) => `  ${line}`)];
}

export function formatPiSubagentsHostToolEventForGraphDetail(
  event: PiSubagentsHostToolLogEvent,
): string | undefined {
  if (event.type === "tool_result") {
    return undefined;
  }
  const args = formatArgsForLog(event.input);
  const label = args ? `${event.toolName} ${args}` : event.toolName;
  return `tool:${compactInline(label, 48)}`;
}

export function formatPiSubagentsToolUpdateForLog(
  update: unknown,
  context: { activityId?: string } = {},
): string[] {
  const summary = summarizePiSubagentsToolUpdate(update);
  if (!summary) return [];
  const suffix = summary.parts.length > 0 ? ` (${summary.parts.join(", ")})` : "";
  const prefix = context.activityId ? `subagent ${context.activityId} ` : "subagent ";
  return [dim(`${prefix}${compactLinePreservingShape(summary.activity, 120)}${suffix}`)];
}

export function formatPiSubagentsToolUpdateForGraphDetail(update: unknown): string | undefined {
  const summary = summarizePiSubagentsToolUpdate(update);
  if (!summary) return undefined;
  const activity = summary.activity.replace(/\u2026/g, "...").replace(/^running\s+/i, "");
  const parts = [activity];
  const turn =
    typeof summary.turnCount === "number"
      ? typeof summary.maxTurns === "number"
        ? `t${summary.turnCount}/${summary.maxTurns}`
        : `t${summary.turnCount}`
      : undefined;
  if (turn) parts.push(turn);
  if (typeof summary.toolUses === "number") parts.push(`${summary.toolUses}t`);
  return `llm:${compactInline(parts.join(" "), 48)}`;
}

function summarizePiSubagentsToolUpdate(update: unknown):
  | {
      activity: string;
      parts: string[];
      toolUses?: number;
      turnCount?: number;
      maxTurns?: number;
    }
  | undefined {
  if (!isRecord(update)) return undefined;
  const details = isRecord(update.details) ? update.details : undefined;
  const rawActivity =
    typeof details?.activity === "string" && details.activity.trim()
      ? details.activity.trim()
      : extractPiSubagentsUpdateText(update);
  const activity = normalizePiSubagentsActivity(rawActivity);
  if (!activity) return undefined;

  const parts: string[] = [];
  const toolUses = details?.toolUses;
  if (typeof toolUses === "number") parts.push(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
  const turnCount = details?.turnCount;
  const maxTurns = details?.maxTurns;
  if (typeof turnCount === "number") {
    parts.push(
      typeof maxTurns === "number" ? `turn ${turnCount}/${maxTurns}` : `turn ${turnCount}`,
    );
  }
  const tokens =
    typeof details?.tokens === "string" && details.tokens.trim()
      ? details.tokens.trim()
      : undefined;
  if (tokens) parts.push(tokens);
  return {
    activity,
    parts,
    ...(typeof toolUses === "number" ? { toolUses } : {}),
    ...(typeof turnCount === "number" ? { turnCount } : {}),
    ...(typeof maxTurns === "number" ? { maxTurns } : {}),
  };
}

function normalizePiSubagentsActivity(activity: string | undefined): string {
  const trimmed = activity?.trim() ?? "";
  if (!trimmed) return "";
  const first = trimmed[0];
  if (/^`{1,3}/.test(trimmed) || first === "{" || first === "[") return "responding";
  return trimmed;
}

function extractPiSubagentsUpdateText(update: Record<string, unknown>): string | undefined {
  const content = update.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((entry) => (isRecord(entry) && typeof entry.text === "string" ? entry.text : ""))
    .join("")
    .trim();
  return text || undefined;
}

function formatPiSubagentResultForLog(resultText: string, label: string, agent: string): string[] {
  const lines: string[] = [];
  const status = extractPiSubagentStatusLine(resultText);
  lines.push(green(`${label} ${agent} ${status.status ?? "completed"}`));
  if (status.details) lines.push(dim(`  ${status.details}`));

  const conversation = extractPiSubagentConversation(resultText);
  if (conversation) {
    lines.push(...formatPiSubagentConversationForLog(conversation));
    return clampLines(lines, 28);
  }

  const finalText = extractPiSubagentFinalText(resultText);
  if (finalText) lines.push(...formatAssistantMessageForLog(finalText));
  return clampLines(lines, 28);
}

function extractPiSubagentStatusLine(resultText: string): { status?: string; details?: string } {
  const match = resultText.match(/^Type:\s*(.+)$/m);
  if (!match) return {};
  const raw = match[1]?.trim() ?? "";
  const statusMatch = raw.match(/\bStatus:\s*([^|]+)/i);
  return {
    status: statusMatch?.[1]?.trim(),
    details: raw,
  };
}

function extractPiSubagentConversation(resultText: string): string | undefined {
  const marker = "--- Agent Conversation ---";
  const index = resultText.indexOf(marker);
  if (index === -1) return undefined;
  const conversation = resultText.slice(index + marker.length).trim();
  return conversation || undefined;
}

function extractPiSubagentFinalText(resultText: string): string | undefined {
  const body = resultText
    .replace(/^Agent:.*$/m, "")
    .replace(/^Type:.*$/m, "")
    .replace(/^Description:.*$/m, "")
    .trim();
  if (!body || body.includes("Agent is still running.")) return undefined;
  return body;
}

function formatPiSubagentConversationForLog(conversation: string): string[] {
  const lines: string[] = [];
  for (const block of parsePiSubagentConversationBlocks(conversation)) {
    if (block.kind === "user") {
      lines.push(...formatUserMessageForLog(block.text));
      continue;
    }
    if (block.kind === "assistant") {
      lines.push(...formatAssistantMessageForLog(block.text));
      continue;
    }
    if (block.kind === "tool_calls") {
      const toolNames = [...block.text.matchAll(/^\s*Tool:\s*(.+)$/gm)].map(
        (match) => match[1]?.trim() ?? "unknown",
      );
      for (const toolName of toolNames) {
        lines.push(yellow(`tool ${toolName}`));
      }
      continue;
    }
    lines.push(...formatToolResultForLog(block.toolName, block.text, false));
  }
  return lines;
}

type PiSubagentConversationBlock =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool_calls"; text: string }
  | { kind: "tool_result"; toolName: string; text: string };

function parsePiSubagentConversationBlocks(conversation: string): PiSubagentConversationBlock[] {
  const blocks: PiSubagentConversationBlock[] = [];
  let current: PiSubagentConversationBlock | undefined;

  function flush(): void {
    if (!current) return;
    current.text = current.text.trim();
    if (current.text) blocks.push(current);
    current = undefined;
  }

  for (const line of conversation.split(/\r?\n/)) {
    const messageMatch = line.match(/^\[(User|Assistant|Tool Calls)\]:\s*(.*)$/);
    if (messageMatch) {
      flush();
      const label = messageMatch[1];
      const text = messageMatch[2] ?? "";
      if (label === "User") current = { kind: "user", text };
      else if (label === "Assistant") current = { kind: "assistant", text };
      else current = { kind: "tool_calls", text };
      continue;
    }

    const toolResultMatch = line.match(/^\[Tool Result \((.+?)\)\]:\s*(.*)$/);
    if (toolResultMatch) {
      flush();
      current = {
        kind: "tool_result",
        toolName: toolResultMatch[1] ?? "unknown",
        text: toolResultMatch[2] ?? "",
      };
      continue;
    }

    if (current) current.text += current.text ? `\n${line}` : line;
  }
  flush();

  return blocks;
}
