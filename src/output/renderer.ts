import { createInterface } from "node:readline/promises";
import { type Component, matchesKey, ProcessTerminal, truncateToWidth, TUI } from "@mariozechner/pi-tui";
import { bold, cyan, dim, green, red, yellow } from "yoctocolors";
import type { PiWendaoAgentEvent, PiWendaoAgentMessage } from "../executor/agent-runtime-types.js";
import { GraphView, LogView } from "./graph-view.js";

export interface Renderer {
	graphView: GraphView;
	onAgentEvent: (event: PiWendaoAgentEvent) => void;
	onNodeStart: (activityId: string, activityName: string) => void;
	onNodeEnd: (activityId: string, activityName: string) => void;
	onFlowTake: (flowId: string) => void;
	onTraceEvent: (event: QianjiTraceLogEvent) => void;
	onError: (err: Error) => void;
	printVariables: (variables: Record<string, unknown>) => void;
	appendLog: (text: string) => void;
	requestPlannerReply: (request: PlannerReplyRequest, signal?: AbortSignal) => Promise<string>;
	waitForKey: () => Promise<void>;
	refresh: () => void;
	start: () => void;
	stop: () => void;
}

export interface PlannerReplyRequest {
	toolCallId: string;
	action: string;
	to: string;
	message: string;
	context?: {
		activityId: string;
		description: string;
		agentId?: string;
	};
}

export type QianjiTraceLogEvent =
	| { kind: "node_status"; node_id: string; node_kind?: string | null; status: string }
	| { kind: "flow_take"; source_id: string; target_id: string };

export interface QianjiHostWorkLogEvent {
	activityId: string;
	hostWorkCount: number;
	batchHostWorkCount: number;
	tokenIds: number[];
	hostKinds: string[];
	parallel: boolean;
	repeatKinds: string[];
	repeatSummaries: string[];
}

export type PiSubagentsHostLogEvent =
	| {
		type: "spawned" | "resumed" | "waiting";
		activityId: string;
		agentId: string;
		description: string;
	}
	| {
		type: "result";
		activityId: string;
		agentId: string;
		description: string;
			resultText: string;
		};

export type PiSubagentsHostToolLogEvent =
	| {
		type: "tool_call";
		activityId: string;
		agentId?: string;
		description: string;
		toolName: string;
		toolCallId: string;
		input: Record<string, unknown>;
	}
	| {
		type: "tool_result";
		activityId: string;
		agentId?: string;
		description: string;
		toolName: string;
		toolCallId: string;
		input: Record<string, unknown>;
		content: unknown;
		details?: unknown;
		isError: boolean;
	};

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

export function createViewRenderer(options: {
	graphView: GraphView;
	logView: LogView;
	refresh: () => void;
	requestPlannerReply: Renderer["requestPlannerReply"];
	waitForKey?: Renderer["waitForKey"];
	start?: () => void;
	stop?: () => void;
}): Renderer {
	const agentLog = new AgentEventLogBuffer();
	return {
		graphView: options.graphView,
		refresh: options.refresh,
		start: options.start ?? (() => {}),
		stop: options.stop ?? (() => {}),
		appendLog(text: string) {
			appendLogBlock(options.logView, text);
			options.refresh();
		},
		requestPlannerReply: options.requestPlannerReply,
		waitForKey: options.waitForKey ?? (async () => {}),
		onAgentEvent(event: PiWendaoAgentEvent) {
			const lines = agentLog.handle(event);
			if (lines.length === 0) return;
			for (const line of lines) {
				options.logView.appendLine(line);
			}
			options.refresh();
		},
		onNodeStart(activityId: string, activityName: string) {
			options.logView.appendLine(`${cyan(bold(`>> ${activityName}`))} ${dim(`(${activityId})`)}`);
			options.refresh();
		},
		onNodeEnd(_activityId: string, _activityName: string) {
			options.logView.appendLine(green("   done"));
			options.refresh();
		},
		onFlowTake(_flowId: string) {},
		onTraceEvent(event: QianjiTraceLogEvent) {
			appendTraceEvent(options.logView, event);
			options.refresh();
		},
		onError(err: Error) {
			options.logView.appendLine(red(`Error: ${err.message}`));
			options.refresh();
		},
		printVariables(variables: Record<string, unknown>) {
			const keys = Object.keys(variables);
			if (keys.length === 0) return;
			options.logView.appendLine("");
			options.logView.appendLine(bold("Variables:"));
			for (const [key, value] of Object.entries(variables)) {
				options.logView.appendLine(`  ${yellow(key)}: ${formatVariableValueForLog(value)}`);
			}
			options.refresh();
		},
	};
}

function createTuiRenderer(): Renderer {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	const graphView = new GraphView();
	const logView = new LogView();
	const agentLog = new AgentEventLogBuffer();
	const plannerInputQueue: Array<{
		request: PlannerReplyRequest;
		resolve: (value: string) => void;
		reject: (error: Error) => void;
		signal?: AbortSignal;
	}> = [];
	let activePlannerInput: {
		request: PlannerReplyRequest;
		value: string;
		resolve: (value: string) => void;
		reject: (error: Error) => void;
		signal?: AbortSignal;
	} | undefined;

	const layout = new SplitLayout(graphView, logView, terminal);
	tui.addChild(layout);

	// Handle Ctrl+C to exit cleanly
	tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+c")) {
			tui.stop();
			process.exit(130);
		}
		if (activePlannerInput) {
			handlePlannerInput(data);
			return { consume: true };
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
			appendLogBlock(logView, text);
			refresh();
		},

		requestPlannerReply(request: PlannerReplyRequest, signal?: AbortSignal) {
			return enqueuePlannerReplyRequest(request, signal);
		},

		waitForKey() {
			return new Promise<void>((resolve) => {
				tui.addInputListener(() => {
					resolve();
					return { consume: true };
				});
			});
		},

		onAgentEvent(event: PiWendaoAgentEvent) {
			const lines = agentLog.handle(event);
			if (lines.length === 0) return;
			for (const line of lines) {
				logView.appendLine(line);
			}
			refresh();
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

		onTraceEvent(event: QianjiTraceLogEvent) {
			appendTraceEvent(logView, event);
			refresh();
		},

		onError(err: Error) {
			logView.appendLine(red(`Error: ${err.message}`));
			refresh();
		},

		printVariables(variables: Record<string, unknown>) {
			const keys = Object.keys(variables);
			if (keys.length === 0) return;
			logView.appendLine("");
			logView.appendLine(bold("Variables:"));
			for (const [key, value] of Object.entries(variables)) {
				logView.appendLine(`  ${yellow(key)}: ${formatVariableValueForLog(value)}`);
			}
			refresh();
		},
	};

	function enqueuePlannerReplyRequest(request: PlannerReplyRequest, signal?: AbortSignal): Promise<string> {
		return new Promise((resolve, reject) => {
			plannerInputQueue.push({ request, resolve, reject, signal });
			if (!activePlannerInput) startNextPlannerInput();
		});
	}

	function startNextPlannerInput(): void {
		const next = plannerInputQueue.shift();
		if (!next) return;
		activePlannerInput = { ...next, value: "" };
		appendPlannerPrompt(logView, next.request);
		refresh();
		if (next.signal?.aborted) {
			completePlannerInput("rejected");
		}
	}

	function appendPlannerPrompt(target: LogView, request: PlannerReplyRequest): void {
		const prompt = replyPromptForRequest(request);
		const label = request.context?.activityId
			? `${prompt.label} for ${request.context.activityId}`
			: prompt.label;
		target.appendLine(yellow(label));
		target.appendLine(dim(`  ${compactLinePreservingShape(request.message || "(empty request)", 180)}`));
		target.appendLine(cyan(`${prompt.prefix}> `));
	}

	function handlePlannerInput(data: string): void {
		if (!activePlannerInput) return;
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			completePlannerInput(activePlannerInput.value.trim() || defaultReplyForRequest(activePlannerInput.request));
			return;
		}
		if (matchesKey(data, "escape")) {
			completePlannerInput("rejected");
			return;
		}
		if (matchesKey(data, "backspace")) {
			activePlannerInput.value = activePlannerInput.value.slice(0, -1);
			renderPlannerInputLine();
			return;
		}
		if (isPrintableInput(data)) {
			activePlannerInput.value += data;
			renderPlannerInputLine();
		}
	}

	function completePlannerInput(answer: string): void {
		if (!activePlannerInput) return;
		const completed = activePlannerInput;
		activePlannerInput = undefined;
		logView.replaceLastLine(green(`${replyPromptForRequest(completed.request).prefix}> ${answer}`));
		completed.resolve(answer);
		refresh();
		startNextPlannerInput();
	}

	function renderPlannerInputLine(): void {
		if (!activePlannerInput) return;
		logView.replaceLastLine(cyan(`${replyPromptForRequest(activePlannerInput.request).prefix}> ${activePlannerInput.value}`));
		refresh();
	}
}

function replyPromptForRequest(request: PlannerReplyRequest): { label: string; prefix: string } {
	if (request.action === "workflow_path") {
		return { label: "workflow path", prefix: "workflow" };
	}
	if (request.action === "human_task" || request.to === "user") {
		return { label: "user input", prefix: "user" };
	}
	return { label: "planner approval", prefix: "planner" };
}

function defaultReplyForRequest(request: PlannerReplyRequest): string {
	return request.action === "workflow_path" ? "" : "approved";
}

function createPlainRenderer(): Renderer {
	const graphView = new GraphView();
	const agentLog = new AgentEventLogBuffer();

	return {
		graphView,
		refresh() {},
		start() {},
		stop() {},

		appendLog(text: string) {
			console.log(text);
		},

		async requestPlannerReply(request: PlannerReplyRequest, signal?: AbortSignal) {
			if (signal?.aborted) return "rejected";
			const prompt = replyPromptForRequest(request);
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			try {
				const answer = await rl.question(`${prompt.label}: ${request.message || "(empty request)"}\n${prompt.prefix}> `);
				return answer.trim() || defaultReplyForRequest(request);
			} finally {
				rl.close();
			}
		},

		async waitForKey() {
			await waitForTerminalKey();
		},

		onAgentEvent(event: PiWendaoAgentEvent) {
			for (const line of agentLog.handle(event)) {
				console.log(line);
			}
		},

		onNodeStart(activityId: string, activityName: string) {
			console.log(`\n${cyan(bold(`>> ${activityName}`))} ${dim(`(${activityId})`)}`);
		},

		onNodeEnd(_activityId: string, _activityName: string) {
			console.log(green("   done"));
		},

		onFlowTake(_flowId: string) {},

		onTraceEvent(event: QianjiTraceLogEvent) {
			appendTraceEventToConsole(event);
		},

		onError(err: Error) {
			console.error(red(`Error: ${err.message}`));
		},

		printVariables(variables: Record<string, unknown>) {
			const keys = Object.keys(variables);
			if (keys.length === 0) return;
			console.log(`\n${bold("Variables:")}`);
			for (const [key, value] of Object.entries(variables)) {
				console.log(`  ${yellow(key)}: ${formatVariableValueForLog(value)}`);
			}
		},
	};
}

export function waitForTerminalKey(input: NodeJS.ReadStream = process.stdin): Promise<void> {
	if (!input.isTTY) return Promise.resolve();
	return new Promise((resolve) => {
		const wasRaw = input.isRaw === true;
		const cleanup = () => {
			input.off("data", onData);
			if (!wasRaw && typeof input.setRawMode === "function") {
				input.setRawMode(false);
			}
			input.pause();
			resolve();
		};
		const onData = () => cleanup();
		if (typeof input.setRawMode === "function") {
			input.setRawMode(true);
		}
		input.resume();
		input.once("data", onData);
	});
}

function appendTraceEvent(logView: LogView, event: QianjiTraceLogEvent): void {
	if (event.kind === "flow_take") {
		logView.appendLine(dim(`flow ${event.source_id} -> ${event.target_id}`));
		return;
	}
	logView.appendLine(formatTraceNodeStatus(event));
}

function appendTraceEventToConsole(event: QianjiTraceLogEvent): void {
	if (event.kind === "flow_take") {
		console.log(dim(`flow ${event.source_id} -> ${event.target_id}`));
		return;
	}
	console.log(formatTraceNodeStatus(event));
}

function appendLogBlock(logView: LogView, text: string): void {
	const lines = text.split(/\r?\n/);
	for (const line of lines) {
		logView.appendLine(line);
	}
}

function isPrintableInput(data: string): boolean {
	return data.length > 0 && !/[\u0000-\u001F\u007F]/.test(data);
}

function formatTraceNodeStatus(event: Extract<QianjiTraceLogEvent, { kind: "node_status" }>): string {
	const kind = event.node_kind ? event.node_kind.replace(/_/g, " ") : "node";
	const label = `${kind} ${event.node_id}`;
	switch (event.status) {
		case "queued":
			return dim(`${label} queued`);
		case "executing":
			return cyan(`${label} executing`);
		case "completed":
			return green(`${label} completed`);
		case "failed":
		case "cancelled":
			return red(`${label} ${event.status}`);
		default:
			return `${label} ${event.status}`;
	}
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
		private top: GraphView,
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
		const allTopLines = this.top.render(width);
		if (allTopLines.length === 0) {
			const allBottomLines = this.bottom.render(width);
			const visibleBottom = allBottomLines.slice(-Math.max(1, totalRows));
			while (visibleBottom.length < totalRows) {
				visibleBottom.unshift("");
			}
			this.cachedWidth = width;
			this.cachedLines = visibleBottom;
			return visibleBottom;
		}

		const topHeight = Math.floor(totalRows * 2 / 3);
		const bottomHeight = Math.max(1, totalRows - topHeight - 1); // -1 for separator

		// Render full graph, then viewport-scroll centered on active node
		const activeRow = this.top.getActiveRow();
		const scrollOffset = Math.max(0, Math.min(
			activeRow - Math.floor(topHeight / 2),
			Math.max(0, allTopLines.length - topHeight),
		));
		const visibleTop = allTopLines.slice(scrollOffset, scrollOffset + topHeight);
		while (visibleTop.length < topHeight) {
			visibleTop.push("");
		}

		const separator = truncateToWidth(dim("─".repeat(width)), width);

		// Render bottom, take tail that fits
		const allBottomLines = this.bottom.render(width);
		const visibleBottom = allBottomLines.slice(-bottomHeight);
		while (visibleBottom.length < bottomHeight) {
			visibleBottom.unshift("");
		}

		const lines = [...visibleTop, separator, ...visibleBottom];
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export class AgentEventLogBuffer {
	private assistantText = "";
	private thinkingText = "";

	handle(event: PiWendaoAgentEvent): string[] {
		switch (event.type) {
			case "message_start": {
				if (event.message.role === "assistant") {
					this.assistantText = "";
					this.thinkingText = "";
				}
				return [];
			}
			case "message_update": {
				const assistantEvent = event.assistantMessageEvent;
				switch (assistantEvent.type) {
					case "text_delta":
						this.assistantText += assistantEvent.delta;
						return [];
					case "thinking_start":
						this.thinkingText = "";
						return [dim("thinking summary")];
					case "thinking_delta":
						this.thinkingText += assistantEvent.delta;
						return [];
					case "thinking_end": {
						const text = assistantEvent.content || this.thinkingText;
						this.thinkingText = "";
						return formatThinkingMessageForLog(text);
					}
					default:
						return [];
				}
			}
			case "message_end": {
				if (event.message.role !== "assistant") return [];
				const text = this.assistantText || extractMessageText(event.message);
				this.assistantText = "";
				return formatAssistantMessageForLog(text);
			}
			case "tool_execution_start":
				return formatToolStartForLog(event.toolName, event.args);
			case "tool_execution_end":
				return formatToolResultForLog(event.toolName, event.result, event.isError);
			default:
				return [];
		}
	}
}

export function formatAssistantMessageForLog(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	return [cyan("assistant"), ...formatStructuredMessageLines(trimmed, "  ")];
}

function formatUserMessageForLog(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	return [green("user"), ...formatStructuredMessageLines(trimmed, "  ")];
}

export function formatThinkingMessageForLog(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	return formatIndentedTextLines(trimmed, "  ", 8).map(dim);
}

function formatStructuredMessageLines(text: string, indent: string): string[] {
	const lines: string[] = [];
	const blockPattern = /```([A-Za-z0-9_-]*)?\s*\n?([\s\S]*?)\n?```/g;
	let cursor = 0;
	let match: RegExpExecArray | null;

	while ((match = blockPattern.exec(text)) !== null) {
		lines.push(...formatIndentedTextLines(text.slice(cursor, match.index), indent, 12));
		const language = (match[1] ?? "").toLowerCase();
		const body = match[2] ?? "";
		const parsed = parseJson(body.trim());
		if (parsed.ok) {
			lines.push(`${indent}${green("output")}`);
			lines.push(...formatJsonSummaryLines(parsed.value).map((line) => `${indent}  ${line}`));
		} else {
			const label = language ? `code ${language}` : "code";
			lines.push(`${indent}${label}: ${countNonEmptyLines(body)} lines`);
		}
		cursor = match.index + match[0].length;
	}

	lines.push(...formatIndentedTextLines(text.slice(cursor), indent, 12));
	return clampLines(lines, 18);
}

function formatIndentedTextLines(text: string, indent: string, limit: number): string[] {
	const normalized = text
		.replace(/```/g, "")
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
	return clampLines(
		normalized.map((line) => `${indent}${compactLinePreservingShape(line, 180)}`),
		limit,
	);
}

export function formatQianjiCliOutputForLog(output: string): string[] {
	const text = output
		.split(/\r?\n/)
		.filter((line) => !line.startsWith("@@QIANJI_TRACE "))
		.join("\n")
		.trim();
	if (!text) return [];

	const reports = parseQianjiReports(text);
	if (reports.length > 0) {
		return reports.map(formatQianjiReportForLog);
	}

	const outcomeMatches = [...text.matchAll(/^Outcome:\s*([a-z_]+)/gm)];
	if (outcomeMatches.length > 0) {
		const lastOutcome = outcomeMatches[outcomeMatches.length - 1]?.[1];
		return lastOutcome ? [dim(`qianji outcome: ${lastOutcome}`)] : [];
	}

	return selectReadableLines(text)
		.slice(0, 4)
		.map((line) => dim(`qianji: ${line}`));
}

export function formatQianjiHostWorkEventForLog(event: QianjiHostWorkLogEvent): string[] {
	const prefix = event.parallel ? "parallel jobs" : "host job";
	const tokenLabel = event.tokenIds.length === 1 ? "token" : "tokens";
	const tokens = event.tokenIds.length > 0 ? ` ${tokenLabel}=${event.tokenIds.join(",")}` : "";
	const batch = event.batchHostWorkCount > event.hostWorkCount ? ` batch=${event.batchHostWorkCount}` : "";
	const kinds = event.hostKinds.length > 0 ? ` kind=${event.hostKinds.join("+")}` : "";
	const repeats = event.repeatSummaries.length > 0 ? ` repeat=${event.repeatSummaries.join(";")}` : "";
	return [dim(`${prefix} ${event.activityId}: ${event.hostWorkCount} ${plural(event.hostWorkCount, "job")}${batch}${tokens}${kinds}${repeats}`)];
}

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
		return [
			yellow(`subagent ${event.activityId}`),
			...lines.map((line) => `  ${line}`),
		];
	}
	const lines = formatToolResultForLog(event.toolName, { content: event.content }, event.isError);
	return [
		yellow(`subagent ${event.activityId}`),
		...lines.map((line) => `  ${line}`),
	];
}

export function formatPiSubagentsHostToolEventForGraphDetail(event: PiSubagentsHostToolLogEvent): string | undefined {
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
	const activity = summary.activity
		.replace(/\u2026/g, "...")
		.replace(/^running\s+/i, "");
	const parts = [activity];
	const turn = typeof summary.turnCount === "number"
		? typeof summary.maxTurns === "number" ? `t${summary.turnCount}/${summary.maxTurns}` : `t${summary.turnCount}`
		: undefined;
	if (turn) parts.push(turn);
	if (typeof summary.toolUses === "number") parts.push(`${summary.toolUses}t`);
	return `llm:${compactInline(parts.join(" "), 48)}`;
}

function summarizePiSubagentsToolUpdate(update: unknown): {
	activity: string;
	parts: string[];
	toolUses?: number;
	turnCount?: number;
	maxTurns?: number;
} | undefined {
	if (!isRecord(update)) return undefined;
	const details = isRecord(update.details) ? update.details : undefined;
	const rawActivity = typeof details?.activity === "string" && details.activity.trim()
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
		parts.push(typeof maxTurns === "number" ? `turn ${turnCount}/${maxTurns}` : `turn ${turnCount}`);
	}
	const tokens = typeof details?.tokens === "string" && details.tokens.trim() ? details.tokens.trim() : undefined;
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
	if (/^`{1,3}/.test(trimmed) || /^[{\[]/.test(trimmed)) return "responding";
	return trimmed;
}

function extractPiSubagentsUpdateText(update: Record<string, unknown>): string | undefined {
	const content = update.content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((entry) => isRecord(entry) && typeof entry.text === "string" ? entry.text : "")
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
	const raw = match[1].trim();
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
			const toolNames = [...block.text.matchAll(/^\s*Tool:\s*(.+)$/gm)].map((match) => match[1].trim());
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

function plural(count: number, noun: string): string {
	return `${noun}${count === 1 ? "" : "s"}`;
}

function shortAgentId(agentId: string): string {
	const trimmed = agentId.trim();
	if (trimmed.length <= 8) return trimmed;
	return trimmed.slice(0, 8);
}

interface QianjiReportSummary {
	title: string;
	outcome?: string;
	checkpointBackend?: string;
	checkpointSource?: string;
	checkpointSaved?: string;
	checkpointDeleted?: string;
	checkpointStatus?: string;
	pendingHostWork?: string;
}

function parseQianjiReports(text: string): QianjiReportSummary[] {
	const reportPattern = /^# BPMN (.+)$/gm;
	const matches = [...text.matchAll(reportPattern)];
	return matches.map((match, index) => {
		const start = match.index ?? 0;
		const end = index + 1 < matches.length ? matches[index + 1].index ?? text.length : text.length;
		const block = text.slice(start, end);
		return {
			title: match[1] ?? "Report",
			outcome: extractQianjiReportField(block, "Outcome"),
			checkpointBackend: extractQianjiReportField(block, "Checkpoint backend"),
			checkpointSource: extractQianjiReportField(block, "Checkpoint source"),
			checkpointSaved: extractQianjiReportField(block, "Checkpoint saved"),
			checkpointDeleted: extractQianjiReportField(block, "Checkpoint deleted"),
			checkpointStatus: extractQianjiReportField(block, "Checkpoint status"),
			pendingHostWork: extractQianjiReportField(block, "Pending host work"),
		};
	});
}

function formatQianjiReportForLog(report: QianjiReportSummary): string {
	const title = report.title.toLowerCase();
	const parts: string[] = [];
	if (report.checkpointBackend && report.checkpointBackend !== "none") {
		parts.push(`checkpoint=${report.checkpointBackend}`);
	}
	if (report.checkpointSource) parts.push(`source=${report.checkpointSource}`);
	if (report.checkpointStatus) parts.push(`status=${report.checkpointStatus}`);
	if (report.checkpointSaved) parts.push(`saved=${report.checkpointSaved}`);
	if (report.checkpointDeleted) parts.push(`deleted=${report.checkpointDeleted}`);
	if (report.pendingHostWork && report.pendingHostWork !== "0") {
		parts.push(`pending_host=${report.pendingHostWork}`);
	}
	const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
	return dim(`qianji ${title}: ${report.outcome ?? "reported"}${suffix}`);
}

function extractQianjiReportField(block: string, label: string): string | undefined {
	const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = block.match(new RegExp(`^${escapedLabel}:\\s*(.+)$`, "m"));
	return match?.[1]?.trim();
}

export function formatVariableValueForLog(value: unknown): string {
	return summarizeValue(value);
}

function formatToolStartForLog(toolName: string, args: unknown): string[] {
	const formattedArgs = formatArgsForLog(args);
	const lines = [yellow(`tool ${toolName}`)];
	if (formattedArgs) lines.push(dim(`  ${hasCommandLikeArg(args) ? "command" : "args"}: ${formattedArgs}`));
	return lines;
}

export function formatToolResultForLog(toolName: string, result: unknown, isError: boolean): string[] {
	const summary = summarizeToolResult(result);
	const lines = [isError ? red(`tool ${toolName} failed`) : green(`tool ${toolName} done`)];
	if (!summary) return lines;
	if (isError) {
		lines.push(red(`  result: ${summary}`));
		return lines;
	}
	lines.push(dim(`  result: ${summary}`));
	return lines;
}

export function formatArgsForLog(args: unknown): string {
	if (args == null) return "";
	if (typeof args !== "object") return String(args);
	const obj = args as Record<string, unknown>;
	const command = firstStringValue(obj, ["command", "cmd", "script"]);
	if (command) return quoteIfNeeded(compactInline(command, 120));

	const parts: string[] = [];
	for (const [key, value] of Object.entries(obj)) {
		const str = typeof value === "string" ? quoteIfNeeded(compactInline(value, 60)) : compactInline(JSON.stringify(value), 60);
		parts.push(`${key}=${str}`);
	}
	return parts.join(", ");
}

function extractMessageText(message: PiWendaoAgentMessage): string {
	if (!isRecord(message)) return "";
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((entry) => {
			if (!isRecord(entry)) return "";
			return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
		})
		.join("");
}

function firstStringValue(obj: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function hasCommandLikeArg(args: unknown): boolean {
	if (!isRecord(args)) return false;
	return firstStringValue(args, ["command", "cmd", "script"]) !== undefined;
}

function selectReadableLines(text: string): string[] {
	const normalized = text
		.replace(/```/g, "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	if (normalized.length === 0) return [];

	const selected = normalized.slice(0, 3).map((line) => compactInline(line, 180));
	if (normalized.length > selected.length) {
		selected.push(`... ${normalized.length - selected.length} more lines`);
	}
	return selected;
}

function formatJsonSummary(value: unknown): string {
	return formatJsonSummaryLines(value).join(", ");
}

function formatJsonSummaryLines(value: unknown): string[] {
	if (!isRecord(value)) return [summarizeValue(value)];
	const entries = Object.entries(value);
	if (entries.length === 0) return ["empty object"];
	return entries
		.slice(0, 6)
		.map(([key, entryValue]) => `${key}: ${summarizeValue(entryValue)}`)
		.concat(entries.length > 6 ? [`... ${entries.length - 6} more keys`] : [])
		;
}

function summarizeValue(value: unknown): string {
	if (typeof value === "string") {
		const lines = countNonEmptyLines(value);
		if (lines > 1) return `${lines} lines`;
		return quoteIfNeeded(compactInline(value, 80));
	}
	if (Array.isArray(value)) return `${value.length} items`;
	if (isRecord(value)) return `${Object.keys(value).length} keys`;
	if (value == null) return String(value);
	return compactInline(JSON.stringify(value), 80);
}

function summarizeToolResult(result: unknown): string {
	const text = extractToolText(result).trim();
	if (!text) return "";

	const parsed = parseJson(text);
	if (parsed.ok) return formatJsonSummary(parsed.value);

	const lines = countNonEmptyLines(text);
	if (lines > 1) return `${lines} lines`;
	return compactInline(text, 100);
}

function extractToolText(result: unknown): string {
	if (!isRecord(result)) return "";
	const content = result.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((entry) => {
			if (typeof entry === "string") return entry;
			if (!isRecord(entry)) return "";
			return typeof entry.text === "string" ? entry.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

function countNonEmptyLines(text: string): number {
	const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
	return Math.max(1, lines);
}

function compactInline(text: string | undefined, maxLen: number): string {
	const compacted = (text ?? "").replace(/\s+/g, " ").trim();
	if (compacted.length <= maxLen) return compacted;
	return `${compacted.slice(0, Math.max(0, maxLen - 3))}...`;
}

function compactLinePreservingShape(text: string, maxLen: number): string {
	const line = text.replace(/\t/g, "  ");
	if (line.length <= maxLen) return line;
	return `${line.slice(0, Math.max(0, maxLen - 3))}...`;
}

function clampLines(lines: string[], maxLines: number): string[] {
	if (lines.length <= maxLines) return lines;
	return [
		...lines.slice(0, maxLines),
		`  ... ${lines.length - maxLines} more lines`,
	];
}

function quoteIfNeeded(text: string): string {
	if (!text) return "";
	return /\s/.test(text) ? JSON.stringify(text) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
