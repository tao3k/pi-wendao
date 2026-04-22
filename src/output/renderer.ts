import type { AgentEvent } from "@mariozechner/pi-agent-core";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";

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
					console.log(`${DIM}  [tool] ${event.toolName}(${formatArgs(event.args)})${RESET}`);
					break;
				}
				case "tool_execution_end": {
					if (event.isError) {
						console.log(`${RED}  [tool] ${event.toolName} failed${RESET}`);
					}
					break;
				}
			}
		},

		onNodeStart(activityId: string, activityName: string) {
			console.log(`\n${CYAN}${BOLD}>> ${activityName}${RESET} ${DIM}(${activityId})${RESET}`);
		},

		onNodeEnd(activityId: string, activityName: string) {
			console.log(`${GREEN}   done${RESET}`);
		},

		onFlowTake(flowId: string) {
			// Silent by default — too noisy
		},

		onError(err: Error) {
			console.error(`${RED}Error: ${err.message}${RESET}`);
		},

		printVariables(variables: Record<string, unknown>) {
			const keys = Object.keys(variables);
			if (keys.length === 0) return;
			console.log(`\n${BOLD}Variables:${RESET}`);
			for (const [key, value] of Object.entries(variables)) {
				console.log(`  ${YELLOW}${key}${RESET}: ${JSON.stringify(value)}`);
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
