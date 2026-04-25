import type { AssistantMessage, Model, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { createSkillscToolRegistry } from "../tools/registry.js";
import {
	buildSkillscAgentPrompt,
	EMPTY_SKILLSC_CONFIG,
	extractOutputVariablesFromText,
	type SkillscAgentHost,
	type SkillscAgentRequest,
	type SkillscConfig,
} from "./agent-host.js";
import type {
	SkillscAgentEvent,
	SkillscAgentMessage,
	SkillscAgentTool,
	SkillscAgentToolResult,
	SkillscThinkingLevel,
} from "./agent-runtime-types.js";

export interface NodeRunnerOptions {
	model: Model<string>;
	apiKey?: string;
	cwd?: string;
	extraTools?: SkillscAgentTool<any>[];
	onEvent?: (event: SkillscAgentEvent) => void;
	thinkingLevel?: SkillscThinkingLevel;
	/** Lookup function to get the skillsc config for an activity by ID */
	getConfig?: (activityId: string) => SkillscConfig | undefined;
}

/**
 * BPMN host service function signature.
 * Originally wired as `environment.services.runAgent`.
 *
 * `executionContext` is the BPMN host execution scope for the activity.
 * `callback(err, result)` completes the service task.
 */
export function createRunAgentService(options: NodeRunnerOptions) {
	const host = createPiAiHost(options);
	return async function runAgent(executionContext: Record<string, unknown>, callback: (err: Error | null, result?: Record<string, unknown>) => void) {
		const content = executionContext.content as Record<string, unknown>;
		const environment = executionContext.environment as {
			variables: Record<string, unknown>;
			output: Record<string, unknown>;
		};

		// Get skillsc config for this activity
		const activityId = content.id as string;
		const config = options.getConfig?.(activityId) ?? EMPTY_SKILLSC_CONFIG;

		try {
			const outputVars = await host.run({
				activityId,
				config,
				variables: environment.variables,
			});

			// Write outputs to workflow environment variables
			for (const [key, value] of Object.entries(outputVars)) {
				environment.variables[key] = value;
			}

			// Also set in output for downstream access
			environment.output[content.id as string] = outputVars;

			callback(null, outputVars);
		} catch (error) {
			callback(error instanceof Error ? error : new Error(String(error)));
		}
	};
}

export function createPiAiHost(options: NodeRunnerOptions): SkillscAgentHost {
	return {
		run: (request) => runPiAiTask(options, request),
	};
}

async function runPiAiTask(
	options: NodeRunnerOptions,
	request: SkillscAgentRequest,
): Promise<Record<string, unknown>> {
	const cwd = options.cwd ?? process.cwd();
	const toolRegistry = createSkillscToolRegistry(cwd, options.extraTools);

	const tools: SkillscAgentTool<any>[] = request.config.tools
		.map((name) => toolRegistry.get(name))
		.filter((t): t is SkillscAgentTool<any> => t !== undefined);

	const systemPrompt = buildSkillscAgentPrompt(request.config, request.variables, {
		...request.execution,
		activityId: request.activityId,
	});

	const messages = await runPiAiToolLoop({
		model: options.model,
		apiKey: options.apiKey,
		systemPrompt,
		tools,
		thinkingLevel: options.thinkingLevel ?? "medium",
		onEvent: options.onEvent,
	});

	return extractOutputVariables(messages, request.config.outputs);
}

async function runPiAiToolLoop(options: {
	model: Model<string>;
	apiKey?: string;
	systemPrompt: string;
	tools: SkillscAgentTool<any>[];
	thinkingLevel: SkillscThinkingLevel;
	onEvent?: (event: SkillscAgentEvent) => void;
}): Promise<SkillscAgentMessage[]> {
	const messages: SkillscAgentMessage[] = [{
		role: "user",
		content: "Execute the task described in your instructions.",
		timestamp: Date.now(),
	}];
	const emit = (event: SkillscAgentEvent) => options.onEvent?.(event);
	const toolMap = new Map(options.tools.map((tool) => [tool.name, tool]));

	emit({ type: "agent_start" });
	emit({ type: "message_start", message: messages[0]! });
	emit({ type: "message_end", message: messages[0]! });

	for (let turn = 0; turn < 8; turn += 1) {
		emit({ type: "turn_start" });
		const assistant = await requestAssistantTurn(options, messages, emit);
		messages.push(assistant);
		emit({ type: "message_end", message: assistant });

		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			throw new Error(assistant.errorMessage ?? `model stopped: ${assistant.stopReason}`);
		}

		const toolCalls = assistant.content.filter((content): content is ToolCall => content.type === "toolCall");
		if (toolCalls.length === 0) {
			emit({ type: "turn_end", message: assistant, toolResults: [] });
			emit({ type: "agent_end", messages });
			return messages;
		}

		const toolResults: ToolResultMessage[] = [];
		for (const toolCall of toolCalls) {
			const result = await executeToolCall(toolMap, toolCall, emit);
			toolResults.push(result);
			messages.push(result);
		}
		emit({ type: "turn_end", message: assistant, toolResults });
	}

	throw new Error("pi-ai service-task loop exceeded 8 turns");
}

async function requestAssistantTurn(
	options: {
		model: Model<string>;
		apiKey?: string;
		systemPrompt: string;
		tools: SkillscAgentTool<any>[];
		thinkingLevel: SkillscThinkingLevel;
	},
	messages: SkillscAgentMessage[],
	emit: (event: SkillscAgentEvent) => void,
): Promise<AssistantMessage> {
	const stream = streamSimple(
		options.model,
		{
			systemPrompt: options.systemPrompt,
			messages,
			tools: options.tools,
		},
		{
			apiKey: options.apiKey,
			...reasoningOption(options.thinkingLevel),
		},
	);

	let started = false;
	for await (const event of stream) {
		if (event.type === "start") {
			started = true;
			emit({ type: "message_start", message: event.partial });
		} else if (
			event.type === "text_delta"
			|| event.type === "thinking_delta"
			|| event.type === "thinking_start"
			|| event.type === "thinking_end"
			|| event.type === "toolcall_start"
			|| event.type === "toolcall_delta"
			|| event.type === "toolcall_end"
		) {
			if (!started) {
				started = true;
				emit({ type: "message_start", message: event.partial });
			}
			emit({ type: "message_update", message: event.partial, assistantMessageEvent: event });
		} else if (event.type === "error") {
			if (!started) emit({ type: "message_start", message: event.error });
			emit({ type: "message_update", message: event.error, assistantMessageEvent: event });
		}
	}

	return stream.result();
}

async function executeToolCall(
	toolMap: Map<string, SkillscAgentTool<any>>,
	toolCall: ToolCall,
	emit: (event: SkillscAgentEvent) => void,
): Promise<ToolResultMessage> {
	const tool = toolMap.get(toolCall.name);
	const args = tool?.prepareArguments ? tool.prepareArguments(toolCall.arguments) : toolCall.arguments;
	emit({ type: "tool_execution_start", toolCallId: toolCall.id, toolName: toolCall.name, args });
	let result: SkillscAgentToolResult;
	let isError = false;
	if (!tool) {
		result = {
			content: [{ type: "text", text: `Tool ${toolCall.name} is not available.` }],
			details: undefined,
		};
		isError = true;
	} else {
		try {
			result = await tool.execute(toolCall.id, args, undefined, (partialResult) => {
				emit({
					type: "tool_execution_update",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					args,
					partialResult,
				});
			});
		} catch (error) {
			result = {
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				details: undefined,
			};
			isError = true;
		}
	}
	emit({ type: "tool_execution_end", toolCallId: toolCall.id, toolName: toolCall.name, result, isError });
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};
}

function reasoningOption(level: SkillscThinkingLevel): { reasoning?: Exclude<SkillscThinkingLevel, "off"> } {
	return level === "off" ? {} : { reasoning: level };
}

/**
 * Extract output variables from the agent's message history.
 * Looks for a JSON code block in the last assistant message.
 */
function extractOutputVariables(
	messages: SkillscAgentMessage[],
	outputNames: string[],
): Record<string, unknown> {
	if (outputNames.length === 0) return {};

	// Find the last assistant message
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;

		const textContent = msg.content
			.filter((c: { type: string; text?: string }) => c.type === "text" && c.text)
			.map((c: { type: string; text?: string }) => c.text!)
			.join("");

		const outputVars = extractOutputVariablesFromText(textContent, outputNames);
		if (Object.keys(outputVars).length > 0) return outputVars;

		break;
	}

	return {};
}
