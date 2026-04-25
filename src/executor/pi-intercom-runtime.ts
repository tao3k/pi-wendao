import type { SkillscAgentTool } from "./agent-runtime-types.js";
import type {
	PiLoadedExtensionsLike,
	PiRegisteredToolDefinition,
	PiRegisteredToolLike,
	PiToolResultLike,
} from "./pi-subagents-runtime.js";
import type {
	SkillscIntercomAttachment,
	SkillscIntercomCorrelationState,
	SkillscIntercomExecutionRef,
	SkillscIntercomMessage,
	SkillscIntercomSession,
} from "./intercom-correlation.js";

export type PiIntercomAction = "list" | "send" | "ask" | "reply" | "pending" | "status";

export interface PiIntercomToolParams {
	action: PiIntercomAction;
	to?: string;
	message?: string;
	attachments?: SkillscIntercomAttachment[];
	replyTo?: string;
}

export interface PiIntercomMessageRequest {
	to: string;
	message: string;
	attachments?: SkillscIntercomAttachment[];
	replyTo?: string;
	execution?: SkillscIntercomExecutionRef;
	now?: number;
}

export interface PiIntercomReplyRequest {
	message: string;
	to?: string;
	attachments?: SkillscIntercomAttachment[];
	replyTo?: string;
	execution?: SkillscIntercomExecutionRef;
	now?: number;
}

export interface PiIntercomToolResult {
	text: string;
	isError: boolean;
	details?: unknown;
	messageId?: string;
	delivered?: boolean;
	reason?: string;
	replyTo?: string;
}

export interface PiIntercomClient {
	execute(params: PiIntercomToolParams): Promise<PiIntercomToolResult>;
	list(): Promise<PiIntercomToolResult>;
	status(): Promise<PiIntercomToolResult>;
	pending(): Promise<PiIntercomToolResult>;
	send(request: PiIntercomMessageRequest): Promise<PiIntercomToolResult>;
	ask(request: PiIntercomMessageRequest): Promise<PiIntercomToolResult>;
	reply(request: PiIntercomReplyRequest): Promise<PiIntercomToolResult>;
}

export interface PiIntercomRegisteredTools {
	intercom?: PiRegisteredToolDefinition;
}

export interface PiIntercomRegisteredToolClientOptions {
	ctx: unknown;
	signal?: AbortSignal;
	toolCallIdPrefix?: string;
	onUpdate?: unknown;
	correlation?: SkillscIntercomCorrelationState;
}

interface PiIntercomToolResultLike extends PiToolResultLike {
	isError?: boolean;
}

const PI_INTERCOM_ACTIONS = new Set<PiIntercomAction>([
	"list",
	"send",
	"ask",
	"reply",
	"pending",
	"status",
]);

const PI_INTERCOM_AGENT_TOOL_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["action"],
	properties: {
		action: {
			type: "string",
			enum: ["list", "send", "ask", "reply", "pending", "status"],
			description: "Action: list, send, ask, reply, pending, or status",
		},
		to: {
			type: "string",
			description: "Target session name or id for send, ask, or reply disambiguation",
		},
		message: {
			type: "string",
			description: "Message text for send, ask, or reply",
		},
		attachments: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["type", "name", "content"],
				properties: {
					type: { type: "string", enum: ["file", "snippet", "context"] },
					name: { type: "string" },
					content: { type: "string" },
					language: { type: "string" },
				},
			},
		},
		replyTo: {
			type: "string",
			description: "Message id to reply to",
		},
	},
};

export function createPiIntercomClientFromRegisteredTools(
	tools: PiIntercomRegisteredTools,
	options: PiIntercomRegisteredToolClientOptions,
): PiIntercomClient {
	if (!tools.intercom) {
		throw new Error("pi-intercom registered tool intercom is required");
	}
	const intercom = tools.intercom;

	const execute = async (params: PiIntercomToolParams): Promise<PiIntercomToolResult> => {
		const result = await executeRegisteredTool(intercom, params, options);
		return normalizeToolResult(result);
	};

	return {
		execute,
		list: () => execute({ action: "list" }),
		status: () => execute({ action: "status" }),
		pending: () => execute({ action: "pending" }),
		send: async (request) => {
			const result = await execute({
				action: "send",
				to: request.to,
				message: request.message,
				attachments: request.attachments,
				replyTo: request.replyTo,
			});
			if (!result.isError) {
				await options.correlation?.send({
					to: sessionFromTarget(request.to),
					text: request.message,
					messageId: result.messageId,
					attachments: request.attachments,
					execution: request.execution,
					now: request.now,
				});
			}
			return result;
		},
		ask: async (request) => {
			const pendingRecord = await options.correlation?.ask({
				to: sessionFromTarget(request.to),
				text: request.message,
				attachments: request.attachments,
				execution: request.execution,
				now: request.now,
			});
			const result = await execute({
				action: "ask",
				to: request.to,
				message: request.message,
				attachments: request.attachments,
				replyTo: request.replyTo,
			});
			if (pendingRecord) {
				const now = request.now ?? Date.now();
				if (result.isError) {
					await options.correlation?.markRecordFailed(pendingRecord.key, result.text, now);
				} else {
					await options.correlation?.markRecordReplied(
						pendingRecord.key,
						replyMessageFromResult(result, pendingRecord.context.message.id, now),
						now,
					);
				}
			}
			return result;
		},
		reply: async (request) => {
			const result = await execute({
				action: "reply",
				to: request.to,
				message: request.message,
				attachments: request.attachments,
				replyTo: request.replyTo,
			});
			if (!result.isError && options.correlation) {
				try {
					await options.correlation.reply({
						text: request.message,
						to: request.to,
						replyTo: request.replyTo,
						messageId: result.messageId,
						attachments: request.attachments,
						execution: request.execution,
						now: request.now,
					});
				} catch {
					// pi-intercom may resolve replies with its own in-extension tracker.
				}
			}
			return result;
		},
	};
}

export function createPiIntercomAgentTool(client: PiIntercomClient): SkillscAgentTool<any> {
	return {
		name: "intercom",
		label: "Intercom",
		description: "Coordinate with other local pi sessions via list, send, ask, reply, pending, and status actions.",
		parameters: PI_INTERCOM_AGENT_TOOL_PARAMETERS as any,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			const result = await client.execute(normalizePiIntercomToolParams(params));
			if (result.isError) {
				throw new Error(result.text || "pi-intercom action failed");
			}
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
			};
		},
	};
}

export function createPiIntercomClientFromLoadedExtensions(
	loadResult: PiLoadedExtensionsLike,
	options: PiIntercomRegisteredToolClientOptions,
): PiIntercomClient {
	return createPiIntercomClientFromRegisteredTools(
		collectPiIntercomRegisteredTools(loadResult),
		options,
	);
}

export function tryCreatePiIntercomClientFromLoadedExtensions(
	loadResult: PiLoadedExtensionsLike,
	options: PiIntercomRegisteredToolClientOptions,
): PiIntercomClient | undefined {
	const tools = collectPiIntercomRegisteredTools(loadResult);
	if (!tools.intercom) return undefined;
	return createPiIntercomClientFromRegisteredTools(tools, options);
}

export function collectPiIntercomRegisteredTools(
	loadResult: PiLoadedExtensionsLike,
): PiIntercomRegisteredTools {
	const found: PiIntercomRegisteredTools = {};
	for (const extension of loadResult.extensions ?? []) {
		for (const [name, tool] of extension.tools ?? []) {
			if (name !== "intercom") continue;
			const definition = extractToolDefinition(tool);
			if (!definition) continue;
			found.intercom = definition;
		}
	}
	return found;
}

async function executeRegisteredTool(
	tool: PiRegisteredToolDefinition,
	params: PiIntercomToolParams,
	options: PiIntercomRegisteredToolClientOptions,
): Promise<PiIntercomToolResultLike> {
	return tool.execute(
		`${options.toolCallIdPrefix ?? "skillsc"}:intercom:${params.action}:${Date.now()}`,
		params as unknown as Record<string, unknown>,
		options.signal,
		options.onUpdate,
		options.ctx,
	) as Promise<PiIntercomToolResultLike>;
}

function extractToolDefinition(
	tool: PiRegisteredToolLike | PiRegisteredToolDefinition,
): PiRegisteredToolDefinition | undefined {
	if ("execute" in tool && typeof tool.execute === "function") return tool;
	const definition = (tool as PiRegisteredToolLike).definition;
	return definition && typeof definition.execute === "function" ? definition : undefined;
}

function normalizeToolResult(result: PiIntercomToolResultLike): PiIntercomToolResult {
	const details = extractDeliveryDetails(result.details);
	return {
		text: toolResultToText(result),
		isError: result.isError === true,
		...(result.details === undefined ? {} : { details: result.details }),
		...(details.messageId ? { messageId: details.messageId } : {}),
		...(details.delivered === undefined ? {} : { delivered: details.delivered }),
		...(details.reason ? { reason: details.reason } : {}),
		...(details.replyTo ? { replyTo: details.replyTo } : {}),
	};
}

function extractDeliveryDetails(details: unknown): {
	messageId?: string;
	delivered?: boolean;
	reason?: string;
	replyTo?: string;
} {
	if (typeof details !== "object" || details === null) return {};
	const record = details as Record<string, unknown>;
	return {
		...(typeof record.messageId === "string" ? { messageId: record.messageId } : {}),
		...(typeof record.delivered === "boolean" ? { delivered: record.delivered } : {}),
		...(typeof record.reason === "string" ? { reason: record.reason } : {}),
		...(typeof record.replyTo === "string" ? { replyTo: record.replyTo } : {}),
	};
}

function toolResultToText(result: PiToolResultLike): string {
	return (result.content ?? [])
		.filter((content) => content.type === "text" && content.text)
		.map((content) => content.text!)
		.join("");
}

function normalizePiIntercomToolParams(params: unknown): PiIntercomToolParams {
	if (typeof params !== "object" || params === null || Array.isArray(params)) {
		throw new Error("intercom tool parameters must be an object");
	}
	const record = params as Record<string, unknown>;
	const action = record.action;
	if (typeof action !== "string" || !PI_INTERCOM_ACTIONS.has(action as PiIntercomAction)) {
		throw new Error("intercom action must be list, send, ask, reply, pending, or status");
	}
	return {
		action: action as PiIntercomAction,
		...(typeof record.to === "string" ? { to: record.to } : {}),
		...(typeof record.message === "string" ? { message: record.message } : {}),
		...(isIntercomAttachments(record.attachments) ? { attachments: record.attachments } : {}),
		...(typeof record.replyTo === "string" ? { replyTo: record.replyTo } : {}),
	};
}

function isIntercomAttachments(value: unknown): value is SkillscIntercomAttachment[] {
	if (value === undefined) return false;
	if (!Array.isArray(value)) {
		throw new Error("intercom attachments must be an array");
	}
	for (const item of value) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new Error("intercom attachment must be an object");
		}
		const record = item as Record<string, unknown>;
		if (
			record.type !== "file"
			&& record.type !== "snippet"
			&& record.type !== "context"
		) {
			throw new Error("intercom attachment type must be file, snippet, or context");
		}
		if (typeof record.name !== "string" || typeof record.content !== "string") {
			throw new Error("intercom attachment name and content are required");
		}
		if (record.language !== undefined && typeof record.language !== "string") {
			throw new Error("intercom attachment language must be a string");
		}
	}
	return true;
}

function sessionFromTarget(target: string): SkillscIntercomSession {
	return {
		id: target,
		name: target,
	};
}

function replyMessageFromResult(
	result: PiIntercomToolResult,
	replyTo: string,
	now: number,
): SkillscIntercomMessage {
	return {
		id: result.messageId ?? `${replyTo}:reply`,
		text: result.text,
		timestamp: now,
		replyTo,
	};
}
