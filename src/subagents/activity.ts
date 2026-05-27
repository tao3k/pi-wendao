import type { ActivityId, AgentId } from "../types/domain.js";

declare const piSubagentActivityIdBrand: unique symbol;
declare const piSubagentActivityTextBrand: unique symbol;
declare const piSubagentToolCallIdBrand: unique symbol;

export type PiSubagentActivityId = string & {
  readonly [piSubagentActivityIdBrand]: "PiSubagentActivityId";
};
export type PiSubagentActivityText = string & {
  readonly [piSubagentActivityTextBrand]: "PiSubagentActivityText";
};
export type PiSubagentToolCallId = string & {
  readonly [piSubagentToolCallIdBrand]: "PiSubagentToolCallId";
};

export type PiSubagentActivityState = "queued" | "running" | "waiting" | "completed" | "failed";

export type PiSubagentActivityEventKind =
  | "spawned"
  | "resumed"
  | "waiting"
  | "update"
  | "tool_call"
  | "tool_result"
  | "result"
  | "failed";

export interface PiSubagentActivityEventDto {
  readonly kind: PiSubagentActivityEventKind;
  readonly activityId: ActivityId;
  readonly description: PiSubagentActivityText;
  readonly agentId?: AgentId;
  readonly toolName?: PiSubagentActivityText;
  readonly toolCallId?: PiSubagentToolCallId;
  readonly text?: PiSubagentActivityText;
  readonly failed?: true;
  readonly timestamp: number;
}

export interface PiSubagentActivityDto {
  readonly id: PiSubagentActivityId;
  readonly title: PiSubagentActivityText;
  readonly state: PiSubagentActivityState;
  readonly description?: PiSubagentActivityText;
  readonly agentId?: AgentId;
  readonly activityId?: ActivityId;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly events: readonly PiSubagentActivityEventDto[];
}

export interface PiSubagentActivitySummaryDto {
  readonly state: PiSubagentActivityState;
  readonly title: string;
  readonly eventCount: number;
  readonly commandCount: number;
  readonly fileCount: number;
  readonly readCount: number;
  readonly editCount: number;
  readonly searchCount: number;
  readonly failedCount: number;
  readonly durationMs: number;
}

export function createPiSubagentActivity(input: {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly agentId?: string;
  readonly activityId?: string;
  readonly state?: PiSubagentActivityState;
  readonly now?: number;
}): PiSubagentActivityDto {
  const now = input.now ?? Date.now();
  return {
    id: input.id as PiSubagentActivityId,
    title: piSubagentActivityText(input.title ?? "Running subagent"),
    state: input.state ?? "running",
    ...(input.description ? { description: piSubagentActivityText(input.description) } : {}),
    ...(input.agentId ? { agentId: input.agentId as AgentId } : {}),
    ...(input.activityId ? { activityId: input.activityId as ActivityId } : {}),
    startedAt: now,
    updatedAt: now,
    events: [],
  };
}

export function appendPiSubagentActivityEvent(
  activity: PiSubagentActivityDto,
  event: {
    readonly kind: PiSubagentActivityEventKind;
    readonly activityId: string;
    readonly description: string;
    readonly agentId?: string;
    readonly toolName?: string;
    readonly toolCallId?: string;
    readonly text?: string;
    readonly failed?: true;
    readonly timestamp?: number;
  },
): PiSubagentActivityDto {
  const timestamp = event.timestamp ?? Date.now();
  const nextEvent: PiSubagentActivityEventDto = {
    kind: event.kind,
    activityId: event.activityId as ActivityId,
    description: piSubagentActivityText(event.description),
    ...(event.agentId ? { agentId: event.agentId as AgentId } : {}),
    ...(event.toolName ? { toolName: piSubagentActivityText(event.toolName) } : {}),
    ...(event.toolCallId ? { toolCallId: event.toolCallId as PiSubagentToolCallId } : {}),
    ...(event.text ? { text: piSubagentActivityText(event.text) } : {}),
    ...(event.failed ? { failed: true } : {}),
    timestamp,
  };
  return {
    ...activity,
    state: stateAfterEvent(activity.state, nextEvent),
    ...(nextEvent.agentId && !activity.agentId ? { agentId: nextEvent.agentId } : {}),
    ...(nextEvent.activityId && !activity.activityId ? { activityId: nextEvent.activityId } : {}),
    updatedAt: timestamp,
    events: [...activity.events, nextEvent],
  };
}

export function summarizePiSubagentActivity(
  activity: PiSubagentActivityDto,
): PiSubagentActivitySummaryDto {
  const events = activity.events;
  const commandCount = events.filter((event) => event.kind === "tool_call").length;
  const failedCount = events.filter(
    (event) => event.failed === true || event.kind === "failed",
  ).length;
  const readCount = countToolEvents(events, READ_TOOL_NAMES);
  const editCount = countToolEvents(events, EDIT_TOOL_NAMES);
  const searchCount = countToolEvents(events, SEARCH_TOOL_NAMES);
  return {
    state: activity.state,
    title: activity.title,
    eventCount: events.length,
    commandCount,
    fileCount: readCount + editCount,
    readCount,
    editCount,
    searchCount,
    failedCount,
    durationMs: Math.max(0, activity.updatedAt - activity.startedAt),
  };
}

function stateAfterEvent(
  current: PiSubagentActivityState,
  event: PiSubagentActivityEventDto,
): PiSubagentActivityState {
  if (event.kind === "failed" || event.failed === true) return "failed";
  if (event.kind === "result") return "completed";
  if (event.kind === "waiting") return "waiting";
  if (event.kind === "spawned" || event.kind === "resumed" || event.kind === "update") {
    return current === "queued" ? "running" : current;
  }
  return current === "queued" ? "running" : current;
}

function piSubagentActivityText(value: string): PiSubagentActivityText {
  return value as PiSubagentActivityText;
}

const READ_TOOL_NAMES = new Set(["read", "cat", "open", "view"]);
const EDIT_TOOL_NAMES = new Set(["edit", "write", "apply_patch"]);
const SEARCH_TOOL_NAMES = new Set(["rg", "grep", "find", "search"]);

function countToolEvents(
  events: readonly PiSubagentActivityEventDto[],
  toolNames: ReadonlySet<string>,
): number {
  return events.filter((event) => {
    const toolName = event.toolName?.toLowerCase();
    return toolName ? toolNames.has(toolName) : false;
  }).length;
}
