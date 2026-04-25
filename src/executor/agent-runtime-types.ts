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

export type SkillscThinkingLevel = "off" | PiAiThinkingLevel;
export type SkillscAgentMessage = Message;

export interface SkillscAgentToolResult<TDetails = unknown> {
	content: (TextContent | ImageContent)[];
	details?: TDetails;
}

export type SkillscAgentToolUpdateCallback<TDetails = unknown> = (
	partialResult: SkillscAgentToolResult<TDetails>,
) => void;

export interface SkillscAgentTool<
	TParameters extends TSchema = TSchema,
	TDetails = unknown,
> extends Tool<TParameters> {
	label: string;
	prepareArguments?: (args: unknown) => Static<TParameters>;
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: SkillscAgentToolUpdateCallback<TDetails>,
	) => Promise<SkillscAgentToolResult<TDetails>>;
	executionMode?: "parallel" | "sequential";
}

export type SkillscAgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: SkillscAgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: SkillscAgentMessage; toolResults: ToolResultMessage[] }
	| { type: "message_start"; message: SkillscAgentMessage }
	| {
		type: "message_update";
		message: SkillscAgentMessage;
		assistantMessageEvent: AssistantMessageEvent;
	}
	| { type: "message_end"; message: SkillscAgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| {
		type: "tool_execution_update";
		toolCallId: string;
		toolName: string;
		args: unknown;
		partialResult: SkillscAgentToolResult;
	}
	| {
		type: "tool_execution_end";
		toolCallId: string;
		toolName: string;
		result: SkillscAgentToolResult;
		isError: boolean;
	};
