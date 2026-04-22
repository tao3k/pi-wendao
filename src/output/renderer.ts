import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { bold, cyan, dim, green, red, yellow } from "yoctocolors";

export interface Renderer {
	onAgentEvent: (event: AgentEvent) => void;
	onNodeStart: (activityId: string, activityName: string) => void;
	onNodeEnd: (activityId: string, activityName: string) => void;
	onFlowTake: (flowId: string) => void;
	onError: (err: Error) => void;
	printVariables: (variables: Record<string, unknown>) => void;
}

export function createRenderer(): Renderer {
	return {
		onAgentEvent(event: AgentEvent) {
			switch (event.type) {
				case "message_update": {
					const ae = event.assistantMessageEvent;
					if (ae.type === "text_delta") {
						process.stdout.write(ae.delta);
					}
					break;
				}
				case "message_end": {
					if (event.message.role === "assistant") {
						process.stdout.write("\n");
					}
					break;
				}
				case "tool_execution_start": {
					console.log(dim(`  [tool] ${event.toolName}(${formatArgs(event.args)})`));
					break;
				}
				case "tool_execution_end": {
					if (event.isError) {
						console.log(red(`  [tool] ${event.toolName} failed`));
					}
					break;
				}
			}
		},

		onNodeStart(activityId: string, activityName: string) {
			console.log(`\n${cyan(bold(`>> ${activityName}`))} ${dim(`(${activityId})`)}`);
		},

		onNodeEnd(_activityId: string, _activityName: string) {
			console.log(green("   done"));
		},

		onFlowTake(_flowId: string) {
			// Silent by default
		},

		onError(err: Error) {
			console.error(red(`Error: ${err.message}`));
		},

		printVariables(variables: Record<string, unknown>) {
			const keys = Object.keys(variables);
			if (keys.length === 0) return;
			console.log(`\n${bold("Variables:")}`);
			for (const [key, value] of Object.entries(variables)) {
				console.log(`  ${yellow(key)}: ${JSON.stringify(value)}`);
			}
		},
	};
}

function formatArgs(args: unknown): string {
	if (args == null) return "";
	if (typeof args !== "object") return String(args);

	const obj = args as Record<string, unknown>;
	const parts: string[] = [];
	for (const [key, value] of Object.entries(obj)) {
		const str = typeof value === "string" ? truncate(value, 60) : JSON.stringify(value);
		parts.push(`${key}=${str}`);
	}
	return parts.join(", ");
}

function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return JSON.stringify(str);
	return JSON.stringify(str.slice(0, maxLen) + "...");
}
