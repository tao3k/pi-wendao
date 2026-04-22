import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { type Component, matchesKey, ProcessTerminal, TUI } from "@mariozechner/pi-tui";
import { bold, cyan, dim, green, red, yellow } from "yoctocolors";
import { GraphView, LogView } from "./graph-view.js";

export interface Renderer {
	graphView: GraphView;
	onAgentEvent: (event: AgentEvent) => void;
	onNodeStart: (activityId: string, activityName: string) => void;
	onNodeEnd: (activityId: string, activityName: string) => void;
	onFlowTake: (flowId: string) => void;
	onError: (err: Error) => void;
	printVariables: (variables: Record<string, unknown>) => void;
	appendLog: (text: string) => void;
	waitForKey: () => Promise<void>;
	refresh: () => void;
	start: () => void;
	stop: () => void;
}

/**
 * Create a TUI-based renderer with graph at top, log output below.
 * If `useGraph` is false, creates a plain text renderer (no TUI).
 */
export function createRenderer(useGraph: boolean): Renderer {
	if (!useGraph) {
		return createPlainRenderer();
	}
	return createTuiRenderer();
}

function createTuiRenderer(): Renderer {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	const graphView = new GraphView();
	const logView = new LogView();

	const layout = new SplitLayout(graphView, logView, terminal);
	tui.addChild(layout);

	// Handle Ctrl+C to exit cleanly
	tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+c")) {
			tui.stop();
			process.exit(130);
		}
		return undefined;
	});

	function refresh(): void {
		layout.invalidate();
		tui.requestRender();
	}

	return {
		graphView,
		refresh,

		start() {
			tui.start();
			refresh();
		},

		stop() {
			tui.stop();
		},

		appendLog(text: string) {
			logView.appendLine(text);
			refresh();
		},

		waitForKey() {
			return new Promise<void>((resolve) => {
				tui.addInputListener(() => {
					resolve();
					return { consume: true };
				});
			});
		},

		onAgentEvent(event: AgentEvent) {
			switch (event.type) {
				case "message_update": {
					const ae = event.assistantMessageEvent;
					if (ae.type === "text_delta") {
						logView.appendText(ae.delta);
						refresh();
					}
					break;
				}
				case "message_end": {
					if (event.message.role === "assistant") {
						logView.appendLine("");
						refresh();
					}
					break;
				}
				case "tool_execution_start": {
					logView.appendLine(dim(`  [tool] ${event.toolName}(${formatArgs(event.args)})`));
					refresh();
					break;
				}
				case "tool_execution_end": {
					if (event.isError) {
						logView.appendLine(red(`  [tool] ${event.toolName} failed`));
						refresh();
					}
					break;
				}
			}
		},

		onNodeStart(activityId: string, activityName: string) {
			logView.appendLine(`${cyan(bold(`>> ${activityName}`))} ${dim(`(${activityId})`)}`);
			refresh();
		},

		onNodeEnd(_activityId: string, _activityName: string) {
			logView.appendLine(green("   done"));
			refresh();
		},

		onFlowTake(_flowId: string) {
			// silent
		},

		onError(err: Error) {
			logView.appendLine(red(`Error: ${err.message}`));
			refresh();
		},

		printVariables(variables: Record<string, unknown>) {
			const keys = Object.keys(variables);
			if (keys.length === 0) return;
			logView.appendLine(`\n${bold("Variables:")}`);
			for (const [key, value] of Object.entries(variables)) {
				logView.appendLine(`  ${yellow(key)}: ${JSON.stringify(value)}`);
			}
			refresh();
		},
	};
}

function createPlainRenderer(): Renderer {
	const graphView = new GraphView();

	return {
		graphView,
		refresh() {},
		start() {},
		stop() {},

		appendLog(text: string) {
			console.log(text);
		},

		async waitForKey() {
			// No TUI, just return immediately
		},

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

		onFlowTake(_flowId: string) {},

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

/**
 * Split layout: top component gets its natural height,
 * bottom component fills the remaining terminal rows.
 * Bottom content is tail-scrolled (shows last N lines).
 */
class SplitLayout implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private top: Component,
		private bottom: Component,
		private terminal: { rows: number },
	) {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.top.invalidate();
		this.bottom.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const totalRows = this.terminal.rows;
		const topLines = this.top.render(width);
		const separator = "─".repeat(width);
		const headerHeight = topLines.length + 1; // +1 for separator
		const bottomHeight = Math.max(1, totalRows - headerHeight);

		// Render bottom, then take only the tail that fits
		const allBottomLines = this.bottom.render(width);
		const visibleBottom = allBottomLines.slice(-bottomHeight);

		// Pad to fill the remaining space so the layout is stable
		while (visibleBottom.length < bottomHeight) {
			visibleBottom.unshift("");
		}

		const lines = [...topLines, separator, ...visibleBottom];
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
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
