import { readFileSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionFactory,
	Theme as PiTheme,
} from "@mariozechner/pi-coding-agent";
import { type Component, Text, type TUI, truncateToWidth } from "@mariozechner/pi-tui";
import type { PiWendaoThinkingLevel } from "../executor/agent-runtime-types.js";
import { GraphView, LogView } from "../output/graph-view.js";
import {
	AgentEventLogBuffer,
	createViewRenderer,
	type PlannerReplyRequest,
	type QianjiTraceLogEvent,
	type Renderer,
} from "../output/renderer.js";
import { validateInstanceId } from "./instance-id.js";
import { resolveModel } from "./model-resolver.js";
import {
	appendActiveBpmnNodeLabels,
	resolveQianjiCommand,
	runQianjiShow,
	runWorkflowInRenderer,
	type PiWendaoWorkflowOptions,
} from "./workflow-runner.js";

const WORKFLOW_MESSAGE_TYPE = "pi-wendao-workflow";
const WORKFLOW_WIDGET_KEY = "pi-wendao-workflow";
const MAX_MESSAGE_LINES = 12;
const MAX_MESSAGE_LINE_LENGTH = 220;

export interface PiWendaoNativeExtensionOptions {
	modelPattern: string;
	provider?: string;
	apiKey?: string;
	thinkingLevel: PiWendaoThinkingLevel;
	invocationCwd: string;
	piContextCwd: string;
	resolvedExtensionPaths: string[];
	baseWorkflowOptions: PiWendaoWorkflowOptions;
	resolvedDmnPaths: string[];
	resolvedHostFixturePath?: string;
	resolvedEventFixturePath?: string;
}

interface PiWendaoWorkflowMessageDetails {
	kind: "status" | "event" | "agent" | "prompt" | "show" | "error";
	workflowPath?: string;
	lines: string[];
	success?: boolean;
}

interface NativeRunCommand {
	workflowPath: string;
	process?: string;
	instanceId?: string;
	qianji?: string;
	dmnPaths: string[];
	hostFixturePath?: string;
	eventFixturePath?: string;
	contextJson?: string;
	traceFrameMs?: number;
	variables: string[];
	graph: boolean;
}

interface NativeShowCommand {
	instanceId?: string;
	workflowPath?: string;
	dmnPaths: string[];
}

export function createPiWendaoNativeExtension(options: PiWendaoNativeExtensionOptions): ExtensionFactory {
	let running = false;

	return (pi: ExtensionAPI) => {
		pi.registerMessageRenderer<PiWendaoWorkflowMessageDetails>(
			WORKFLOW_MESSAGE_TYPE,
			(message, renderOptions, theme) => {
				const details = message.details;
				if (!details) return new Text(String(message.content ?? ""), 0, 0);
				const text = renderWorkflowMessage(details, renderOptions.expanded, theme);
				return new Text(text, 0, 0);
			},
		);

		pi.registerCommand("run", {
			description: "Run a qianji BPMN workflow in the native pi session",
			handler: async (args, ctx) => {
				if (running) {
					ctx.ui.notify("A pi-wendao workflow is already running.", "warning");
					return;
				}
				let command: NativeRunCommand | undefined;
				try {
					command = parseNativeRunCommand(args);
					running = true;
					await ctx.waitForIdle();
					await runNativeWorkflow(pi, ctx, options, command);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(message, "error");
					sendWorkflowMessage(pi, {
						kind: "error",
						workflowPath: command?.workflowPath,
						lines: [`Error: ${message}`],
						success: false,
					});
				} finally {
					running = false;
					ctx.ui.setStatus("pi-wendao", undefined);
				}
			},
		});

		pi.registerCommand("show", {
			description: "Show qianji BPMN instances or an instance status",
			handler: async (args, ctx) => {
				try {
					await ctx.waitForIdle();
					await showNativeWorkflowStatus(pi, options, parseNativeShowCommand(args));
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(message, "error");
					sendWorkflowMessage(pi, { kind: "error", lines: [`Error: ${message}`], success: false });
				}
			},
		});
	};
}

export function parseNativeRunCommand(args: string): NativeRunCommand {
	const words = splitCommandWords(args);
	if (words.length === 0) {
		throw new Error("Usage: /run <workflow.bpmn> [--instance-id id] [--dmn file] [--var key=value]");
	}
	const command: NativeRunCommand = {
		workflowPath: words[0]!,
		dmnPaths: [],
		variables: [],
		graph: true,
	};
	for (let index = 1; index < words.length; index += 1) {
		const flag = words[index]!;
		switch (flag) {
			case "--process":
				command.process = readRequiredValue(words, ++index, flag);
				break;
			case "--instance-id":
				command.instanceId = validateInstanceId(readRequiredValue(words, ++index, flag));
				break;
			case "--qianji":
				command.qianji = readRequiredValue(words, ++index, flag);
				break;
			case "--dmn":
				command.dmnPaths.push(readRequiredValue(words, ++index, flag));
				break;
			case "--host-fixture":
				command.hostFixturePath = readRequiredValue(words, ++index, flag);
				break;
			case "--event-fixture":
				command.eventFixturePath = readRequiredValue(words, ++index, flag);
				break;
			case "--context-json":
				command.contextJson = readRequiredValue(words, ++index, flag);
				break;
			case "--trace-frame-ms":
				command.traceFrameMs = parseNonNegativeNumber(readRequiredValue(words, ++index, flag), flag);
				break;
			case "--var":
				command.variables.push(readRequiredValue(words, ++index, flag));
				break;
			case "--no-graph":
			case "--no-tui":
				command.graph = false;
				break;
			default:
				throw new Error(`Unknown /run option: ${flag}`);
		}
	}
	return command;
}

export function parseNativeShowCommand(args: string): NativeShowCommand {
	const words = splitCommandWords(args);
	const command: NativeShowCommand = { dmnPaths: [] };
	for (let index = 0; index < words.length; index += 1) {
		const word = words[index]!;
		if (word === "--dmn") {
			command.dmnPaths.push(readRequiredValue(words, ++index, word));
		} else if (!command.instanceId) {
			command.instanceId = validateInstanceId(word);
		} else if (!command.workflowPath) {
			command.workflowPath = word;
		} else {
			throw new Error(`Unexpected /show argument: ${word}`);
		}
	}
	return command;
}

async function runNativeWorkflow(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	options: PiWendaoNativeExtensionOptions,
	command: NativeRunCommand,
): Promise<void> {
	const resolvedWorkflowPath = resolvePath(options.invocationCwd, command.workflowPath);
	const resolvedDmnPaths = [
		...options.resolvedDmnPaths,
		...command.dmnPaths.map((path) => resolvePath(options.invocationCwd, path)),
	];
	const resolvedHostFixturePath = command.hostFixturePath
		? resolvePath(options.invocationCwd, command.hostFixturePath)
		: options.resolvedHostFixturePath;
	const resolvedEventFixturePath = command.eventFixturePath
		? resolvePath(options.invocationCwd, command.eventFixturePath)
		: options.resolvedEventFixturePath;
	const workflowOptions: PiWendaoWorkflowOptions = {
		process: command.process ?? options.baseWorkflowOptions.process,
		instanceId: command.instanceId ?? options.baseWorkflowOptions.instanceId,
		qianji: command.qianji ?? options.baseWorkflowOptions.qianji,
		contextJson: command.contextJson ?? options.baseWorkflowOptions.contextJson,
		traceFrameMs: command.traceFrameMs ?? options.baseWorkflowOptions.traceFrameMs,
		var: [...(options.baseWorkflowOptions.var ?? []), ...command.variables],
	};
	const renderer = new PiWendaoNativeWorkflowRenderer(pi, ctx, resolvedWorkflowPath);
	const contextModel = ctx.model;
	const modelPattern = contextModel ? `${contextModel.provider}/${contextModel.id}` : options.modelPattern;
	const provider = contextModel ? undefined : options.provider;
	const resolvedModel = resolvedHostFixturePath
		? undefined
		: await resolveModel(modelPattern, provider, options.apiKey, options.resolvedExtensionPaths);

	pi.setSessionName(`pi-wendao ${basename(resolvedWorkflowPath)}`);
	ctx.ui.setStatus("pi-wendao", `running ${basename(resolvedWorkflowPath)}`);
	renderer.start();
	const result = await runWorkflowInRenderer({
		renderer,
		useGraph: command.graph,
		resolvedWorkflowPath,
		options: workflowOptions,
		instanceId: workflowOptions.instanceId,
		invocationCwd: options.invocationCwd,
		piContextCwd: options.piContextCwd,
		resolvedDmnPaths,
		resolvedHostFixturePath,
		resolvedEventFixturePath,
		resolvedModel,
		thinkingLevel: normalizeThinkingLevel(pi.getThinkingLevel(), options.thinkingLevel),
	});
	renderer.stop();
	sendWorkflowMessage(pi, {
		kind: "status",
		workflowPath: resolvedWorkflowPath,
		lines: [result.success ? "Workflow completed successfully." : "Workflow failed."],
		success: result.success,
	});
}

async function showNativeWorkflowStatus(
	pi: ExtensionAPI,
	options: PiWendaoNativeExtensionOptions,
	command: NativeShowCommand,
): Promise<void> {
	const workflowPath = command.workflowPath ? resolvePath(options.invocationCwd, command.workflowPath) : undefined;
	const dmnPaths = [
		...options.resolvedDmnPaths,
		...command.dmnPaths.map((path) => resolvePath(options.invocationCwd, path)),
	];
	const output = await runQianjiShow({
		command: resolveQianjiCommand(options.baseWorkflowOptions.qianji),
		instanceId: command.instanceId,
		workflowPath,
		dmnPaths,
		cwd: options.invocationCwd,
	});
	let stdout = output.stdout;
	if (output.exitCode === 0 && command.instanceId && workflowPath) {
		stdout = appendActiveBpmnNodeLabels(stdout, readFileSync(workflowPath, "utf-8"), options.baseWorkflowOptions.process);
	}
	const lines = [
		...stdout.trimEnd().split(/\r?\n/).filter(Boolean),
		...output.stderr.trimEnd().split(/\r?\n/).filter(Boolean).map((line) => `stderr: ${line}`),
	];
	sendWorkflowMessage(pi, {
		kind: output.exitCode === 0 ? "show" : "error",
		workflowPath,
		lines: lines.length > 0 ? lines : ["No qianji instance output."],
		success: output.exitCode === 0,
	});
}

class PiWendaoNativeWorkflowRenderer implements Renderer {
	readonly graphView = new GraphView();
	readonly logView = new LogView(240);
	private readonly agentLog = new AgentEventLogBuffer();
	private readonly viewRenderer: Renderer;
	private widget: NativeWorkflowWidget | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionCommandContext,
		readonly workflowPath: string,
	) {
		this.viewRenderer = createViewRenderer({
			graphView: this.graphView,
			logView: this.logView,
			refresh: () => this.refresh(),
			requestPlannerReply: (request, signal) => this.requestPlannerReply(request, signal),
			start: () => {},
			stop: () => {},
		});
	}

	onAgentEvent = (event: Parameters<Renderer["onAgentEvent"]>[0]): void => {
		const lines = this.agentLog.handle(event);
		this.viewRenderer.onAgentEvent(event);
		if (lines.length > 0) {
			this.emit("agent", lines);
		}
	};

	onNodeStart(activityId: string, activityName: string): void {
		this.viewRenderer.onNodeStart(activityId, activityName);
		this.emit("event", [`node ${activityName} started (${activityId})`]);
	}

	onNodeEnd(activityId: string, activityName: string): void {
		this.viewRenderer.onNodeEnd(activityId, activityName);
		this.emit("event", [`node ${activityName} completed (${activityId})`]);
	}

	onFlowTake(flowId: string): void {
		this.viewRenderer.onFlowTake(flowId);
	}

	onTraceEvent(event: QianjiTraceLogEvent): void {
		this.viewRenderer.onTraceEvent(event);
		if (event.kind === "flow_take") {
			this.emit("event", [`flow ${event.source_id} -> ${event.target_id}`]);
		} else {
			this.emit("event", [`${event.node_kind ?? "node"} ${event.node_id} ${event.status}`]);
		}
	}

	onError = (err: Error): void => {
		this.viewRenderer.onError(err);
		this.emit("error", [`Error: ${err.message}`], false);
	};

	printVariables(variables: Record<string, unknown>): void {
		this.viewRenderer.printVariables(variables);
		const keys = Object.keys(variables);
		if (keys.length === 0) return;
		this.emit("status", [
			"Variables:",
			...Object.entries(variables).map(([key, value]) => `  ${key}: ${formatVariable(value)}`),
		]);
	}

	appendLog(text: string): void {
		this.viewRenderer.appendLog(text);
		this.emit("event", text.split(/\r?\n/).filter((line) => line.trim().length > 0));
	}

	async requestPlannerReply(request: PlannerReplyRequest, signal?: AbortSignal): Promise<string> {
		const prompt = promptLabel(request);
		this.emit("prompt", [prompt, request.message || "(empty request)"]);
		const answer = await this.ctx.ui.input(prompt, compactLine(stripAnsi(request.message || ""), 140), { signal });
		const reply = answer?.trim() || defaultReply(request);
		this.emit("prompt", [`${prompt}: ${reply}`]);
		return reply;
	}

	async waitForKey(): Promise<void> {}

	refresh(): void {
		this.widget?.invalidate();
		this.widget?.requestRender();
	}

	start(): void {
		this.ctx.ui.setWidget(WORKFLOW_WIDGET_KEY, (tui, theme) => {
			this.widget = new NativeWorkflowWidget(this, tui, theme);
			return this.widget;
		}, { placement: "aboveEditor" });
		this.emit("status", [`running workflow: ${this.workflowPath}`]);
	}

	stop(): void {
		this.ctx.ui.setStatus("pi-wendao", `completed ${basename(this.workflowPath)}`);
		this.refresh();
	}

	private emit(kind: PiWendaoWorkflowMessageDetails["kind"], lines: string[], success?: boolean): void {
		sendWorkflowMessage(this.pi, {
			kind,
			workflowPath: this.workflowPath,
			lines,
			...(success === undefined ? {} : { success }),
		});
	}
}

class NativeWorkflowWidget implements Component {
	private invalidated = false;

	constructor(
		private readonly renderer: PiWendaoNativeWorkflowRenderer,
		private readonly tui: TUI,
		private readonly theme: PiTheme,
	) {}

	invalidate(): void {
		this.invalidated = true;
	}

	requestRender(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		this.invalidated = false;
		if (width < 10) return [];
		const totalHeight = Math.max(8, Math.min(18, Math.floor(this.tui.terminal.rows * 0.42)));
		const title = truncateToWidth(
			`${this.theme.bold(this.theme.fg("accent", "pi-wendao workflow"))} ${this.theme.fg("dim", basename(this.renderer.workflowPath))}`,
			width,
		);
		const graphLines = this.renderer.graphView.render(width);
		const graphHeight = graphLines.length === 0 ? 0 : Math.max(3, Math.min(graphLines.length, totalHeight - 5));
		const graphStart = Math.max(0, Math.min(
			this.renderer.graphView.getActiveRow() - Math.floor(graphHeight / 2),
			Math.max(0, graphLines.length - graphHeight),
		));
		const visibleGraph = graphLines.slice(graphStart, graphStart + graphHeight);
		const separator = truncateToWidth(this.theme.fg("dim", "-".repeat(width)), width);
		const logHeight = Math.max(2, totalHeight - visibleGraph.length - 2);
		const visibleLog = this.renderer.logView.render(width).slice(-logHeight);
		return [title, ...visibleGraph, separator, ...visibleLog].slice(0, totalHeight);
	}

	dispose(): void {
		this.invalidated = true;
	}
}

function sendWorkflowMessage(pi: ExtensionAPI, details: PiWendaoWorkflowMessageDetails): void {
	const normalizedLines = normalizeMessageLines(details.lines);
	if (normalizedLines.length === 0) return;
	const messageDetails = { ...details, lines: normalizedLines };
	pi.sendMessage<PiWendaoWorkflowMessageDetails>({
		customType: WORKFLOW_MESSAGE_TYPE,
		content: workflowMessageContext(messageDetails),
		display: true,
		details: messageDetails,
	});
}

function renderWorkflowMessage(
	details: PiWendaoWorkflowMessageDetails,
	expanded: boolean,
	theme: PiTheme,
): string {
	const icon = details.kind === "error" || details.success === false
		? theme.fg("error", "x")
		: details.success === true
			? theme.fg("success", "ok")
			: theme.fg("accent", "workflow");
	const title = [
		icon,
		theme.bold(labelForWorkflowMessage(details.kind)),
		details.workflowPath ? theme.fg("dim", basename(details.workflowPath)) : undefined,
	].filter(Boolean).join(" ");
	const maxLines = expanded ? 80 : MAX_MESSAGE_LINES;
	const body = details.lines.slice(0, maxLines).map((line) => `  ${line}`);
	if (details.lines.length > maxLines) {
		body.push(theme.fg("muted", `  ... ${details.lines.length - maxLines} more lines`));
	}
	return [title, ...body].join("\n");
}

function workflowMessageContext(details: PiWendaoWorkflowMessageDetails): string {
	const workflowPath = details.workflowPath ? `workflowPath: ${details.workflowPath}\n` : "";
	return [
		"[pi-wendao workflow event]",
		workflowPath.trimEnd(),
		`kind: ${details.kind}`,
		...details.lines.map((line) => `- ${stripAnsi(line)}`),
	].filter(Boolean).join("\n");
}

function labelForWorkflowMessage(kind: PiWendaoWorkflowMessageDetails["kind"]): string {
	switch (kind) {
		case "agent":
			return "agent";
		case "prompt":
			return "input";
		case "show":
			return "qianji status";
		case "error":
			return "error";
		case "status":
			return "status";
		case "event":
			return "event";
	}
}

function splitCommandWords(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaping = false;
	for (const char of input.trim()) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}
		if (char === "\\") {
			escaping = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (quote) throw new Error("Unclosed quote in command arguments");
	if (escaping) current += "\\";
	if (current) words.push(current);
	return words;
}

function readRequiredValue(words: string[], index: number, flag: string): string {
	const value = words[index];
	if (!value || value.startsWith("--")) {
		throw new Error(`${flag} requires a value`);
	}
	return value;
}

function parseNonNegativeNumber(value: string, label: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`${label} must be a non-negative number`);
	}
	return parsed;
}

function normalizeThinkingLevel(value: string, fallback: PiWendaoThinkingLevel): PiWendaoThinkingLevel {
	return isPiWendaoThinkingLevel(value) ? value : fallback;
}

function isPiWendaoThinkingLevel(value: string): value is PiWendaoThinkingLevel {
	return value === "off"
		|| value === "minimal"
		|| value === "low"
		|| value === "medium"
		|| value === "high"
		|| value === "xhigh";
}

function promptLabel(request: PlannerReplyRequest): string {
	if (request.action === "workflow_path") return "workflow path";
	if (request.action === "human_task" || request.to === "user") return "workflow user input";
	return "planner approval";
}

function defaultReply(request: PlannerReplyRequest): string {
	return request.action === "workflow_path" ? "" : "approved";
}

function normalizeMessageLines(lines: string[]): string[] {
	return lines
		.flatMap((line) => line.split(/\r?\n/))
		.map((line) => compactLine(line, MAX_MESSAGE_LINE_LENGTH))
		.filter((line) => line.trim().length > 0)
		.slice(0, MAX_MESSAGE_LINES);
}

function compactLine(line: string, maxLength: number): string {
	const stripped = stripAnsi(line).replace(/\s+/g, " ").trim();
	if (stripped.length <= maxLength) return stripped;
	return `${stripped.slice(0, Math.max(0, maxLength - 3))}...`;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function formatVariable(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
