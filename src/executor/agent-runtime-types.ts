import type {
  AssistantMessageEvent,
  ImageContent,
  Message,
  TextContent,
  ThinkingLevel as PiAiThinkingLevel,
  Tool,
  ToolResultMessage,
  Static,
  TSchema,
} from "@mariozechner/pi-ai";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

export type PiWendaoThinkingLevel = "off" | PiAiThinkingLevel;
export type PiWendaoAgentMessage = Message;

export interface PiWendaoAgentToolResult<TDetails = unknown> {
  content: (TextContent | ImageContent)[];
  details?: TDetails;
}

export type PiWendaoAgentToolUpdateCallback<TDetails = unknown> = (
  partialResult: PiWendaoAgentToolResult<TDetails>,
) => void;

export interface PiWendaoAgentTool<
  TParameters extends TSchema = TSchema,
  TDetails = unknown,
> extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: PiWendaoAgentToolUpdateCallback<TDetails>,
  ) => Promise<PiWendaoAgentToolResult<TDetails>>;
  executionMode?: "parallel" | "sequential";
}

export type PiWendaoAgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: PiWendaoAgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: PiWendaoAgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: PiWendaoAgentMessage }
  | {
      type: "message_update";
      message: PiWendaoAgentMessage;
      assistantMessageEvent: AssistantMessageEvent;
    }
  | { type: "message_end"; message: PiWendaoAgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: PiWendaoAgentToolResult;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: PiWendaoAgentToolResult;
      isError: boolean;
    };

export function toPiWendaoAgentEvent(event: AgentSessionEvent): PiWendaoAgentEvent | undefined {
  return toPiWendaoAgentEventInternal(event);
}

function toPiWendaoAgentEventInternal(
  event: AgentSessionEvent,
): PiWendaoAgentEvent | undefined {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
      return event;
    case "agent_end":
      return {
        type: "agent_end",
        messages: event.messages.filter(isPiWendaoAgentMessage),
      };
    case "turn_end":
      return isPiWendaoAgentMessage(event.message) ? (event as PiWendaoAgentEvent) : undefined;
    case "message_start":
    case "message_end":
      return isPiWendaoAgentMessage(event.message) ? (event as PiWendaoAgentEvent) : undefined;
    case "message_update":
      return isPiWendaoAgentMessage(event.message) ? (event as PiWendaoAgentEvent) : undefined;
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return event as PiWendaoAgentEvent;
    default:
      return undefined;
  }
}

export function isPiWendaoAgentMessage(message: unknown): message is PiWendaoAgentMessage {
  if (!isObject(message) || typeof message.role !== "string") return false;
  return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
