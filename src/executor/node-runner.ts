import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { type Model, streamSimple } from "@mariozechner/pi-ai";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";

export interface NodeRunnerOptions {
	model: Model<string>;
	apiKey?: string;
	cwd?: string;
	onEvent?: (event: AgentEvent) => void;
	/** Lookup function to get the skillsc config for an activity by ID */
	getConfig?: (activityId: string) => SkillscConfig | undefined;
}

export interface SkillscConfig {
	prompt: string;
	tools: string[];
	inputs: string[];
	outputs: string[];
}

/**
 * bpmn-engine service function signature.
 * Wired as `environment.services.runAgent`.
 *
 * `executionContext` is the bpmn-elements execution scope for the activity.
 * `callback(err, result)` completes the service task.
 */
export function createRunAgentService(options: NodeRunnerOptions) {
	return async function runAgent(executionContext: Record<string, unknown>, callback: (err: Error | null, result?: Record<string, unknown>) => void) {
		const content = executionContext.content as Record<string, unknown>;
		const environment = executionContext.environment as {
			variables: Record<string, unknown>;
			output: Record<string, unknown>;
		};

		// Get skillsc config for this activity
		const activityId = content.id as string;
		const config = options.getConfig?.(activityId) ?? { prompt: "", tools: [], inputs: [], outputs: [] };

		const cwd = options.cwd ?? process.cwd();

		// Build tools from config
		const tools: AgentTool<any>[] = config.tools
			.map((name) => createToolByName(name, cwd))
			.filter((t): t is AgentTool<any> => t !== undefined);

		// Build system prompt with scoped variables
		const scopedVars: Record<string, unknown> = {};
		for (const inputName of config.inputs) {
			if (inputName in environment.variables) {
				scopedVars[inputName] = environment.variables[inputName];
			}
		}

		const variableContext = Object.entries(scopedVars)
			.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
			.join("\n");

		// Replace ${environment.variables.X} references in prompt with actual values
		const resolvedPrompt = config.prompt.replace(
			/\$\{environment\.variables\.(\w+)\}/g,
			(_, varName) => {
				const val = environment.variables[varName];
				return val !== undefined ? JSON.stringify(val) : "undefined";
			},
		);

		const promptParts = [resolvedPrompt];
		if (variableContext) {
			promptParts.push(`\n\nCurrent variable values (use these as inputs):\n${variableContext}`);
		}
		if (config.outputs.length > 0) {
			promptParts.push(
				`\nAfter completing the task, output the following variables in a JSON code block with exactly these keys:\n${config.outputs.map((o) => `- ${o}`).join("\n")}`,
			);
		}
		const systemPrompt = promptParts.join("");

		const agent = new Agent({
			initialState: {
				systemPrompt,
				model: options.model,
				tools,
			},
			streamFn: streamSimple,
			...(options.apiKey ? { getApiKey: () => options.apiKey } : {}),
		});

		if (options.onEvent) {
			const handler = options.onEvent;
			agent.subscribe(async (event) => {
				handler(event);
			});
		}

		try {
			await agent.prompt("Execute the task described in your instructions.");
			await agent.waitForIdle();

			// Check if the agent ended with an error
			if (agent.state.errorMessage) {
				callback(new Error(agent.state.errorMessage));
				return;
			}

			// Extract output variables from the last assistant message
			const outputVars = extractOutputVariables(agent.state.messages, config.outputs);

			// Write outputs to bpmn-engine environment variables
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

/**
 * Extract output variables from the agent's message history.
 * Looks for a JSON code block in the last assistant message.
 */
function extractOutputVariables(
	messages: AgentMessage[],
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

		// Try to extract JSON from code blocks
		const jsonMatch = textContent.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
		if (jsonMatch) {
			try {
				const parsed = JSON.parse(jsonMatch[1]);
				if (typeof parsed === "object" && parsed !== null) {
					const result: Record<string, unknown> = {};
					for (const name of outputNames) {
						if (name in parsed) {
							result[name] = parsed[name];
						}
					}
					return result;
				}
			} catch {
				// Not valid JSON, continue
			}
		}

		// Fallback: try parsing the whole text as JSON
		try {
			const parsed = JSON.parse(textContent);
			if (typeof parsed === "object" && parsed !== null) {
				const result: Record<string, unknown> = {};
				for (const name of outputNames) {
					if (name in parsed) {
						result[name] = parsed[name];
					}
				}
				return result;
			}
		} catch {
			// Not JSON
		}

		break;
	}

	return {};
}

function parseCommaSeparated(value: string): string[] {
	if (!value || value.trim() === "") return [];
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

const TOOL_FACTORIES: Record<string, (cwd: string) => AgentTool<any>> = {
	read: createReadTool,
	bash: createBashTool,
	edit: createEditTool,
	write: createWriteTool,
	grep: createGrepTool,
	find: createFindTool,
	ls: createLsTool,
};

function createToolByName(name: string, cwd: string): AgentTool<any> | undefined {
	const factory = TOOL_FACTORIES[name];
	if (!factory) return undefined;
	return factory(cwd);
}
