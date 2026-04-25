import type { Message, Model, ThinkingLevel as PiAiThinkingLevel, UserMessage } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import {
	Editor,
	Key,
	type Component,
	type EditorTheme,
	type Terminal,
	ProcessTerminal,
	TUI,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { bold, cyan, dim, green, red, yellow } from "yoctocolors";
import type { PiWendaoAgentEvent, PiWendaoAgentMessage } from "../executor/agent-runtime-types.js";
import type { ResolvedModel } from "./model-resolver.js";
import { GraphView } from "../output/graph-view.js";
import {
	formatArgsForLog,
	formatToolResultForLog,
	formatVariableValueForLog,
	type PlannerReplyRequest,
	type QianjiTraceLogEvent,
	type Renderer,
} from "../output/renderer.js";

export type PiWendaoChatThinkingLevel = "off" | PiAiThinkingLevel;

export interface PiWendaoChatCommandOutput {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export type PiWendaoChatTuiResult =
	| { kind: "workflow"; workflowPath: string }
	| { kind: "exit" };

export interface PiWendaoChatTuiOptions {
	resolvedModel: ResolvedModel;
	thinkingLevel: PiWendaoChatThinkingLevel;
	invocationCwd: string;
	showInstances: () => Promise<PiWendaoChatCommandOutput>;
	showInstanceStatus: (instanceId: string, workflowPath?: string) => Promise<PiWendaoChatCommandOutput>;
	runWorkflow?: (workflowPath: string, renderer: Renderer) => Promise<{ success: boolean }>;
}

export type PiWendaoChatCommand =
	| { kind: "chat"; text: string }
	| { kind: "help" }
	| { kind: "exit" }
	| { kind: "run"; workflowPath: string }
	| { kind: "show"; instanceId?: string; workflowPath?: string }
	| { kind: "unknown"; text: string };

export type PiWendaoChatTranscriptRole = "system" | "user" | "assistant" | "thinking" | "agent" | "tool" | "error";
type TranscriptRole = PiWendaoChatTranscriptRole;

interface TranscriptEntry {
	role: TranscriptRole;
	text: string;
}

const CHAT_SYSTEM_PROMPT = `You are the pi-wendao TUI assistant.

Help the user inspect, plan, and run qianji BPMN workflows. Keep workflow
semantics owned by qianji. Do not pretend that chat messages execute workflow
steps; tell the user to use /run when they want to execute a BPMN file in the
right workflow graph sidebar. Workflow execution should appear as native chat
stream items: subagent lifecycle as agent output, qianji and shell work as tool
output, reasoning as thinking, and agent replies as assistant output.`;

const MAX_WORKFLOW_CONTEXT_LINES = 60;
const MAX_WORKFLOW_CONTEXT_LINE_LENGTH = 160;
const MAX_WORKFLOW_CONTEXT_EVENT_LINES = 8;
const MAX_WORKFLOW_CONTEXT_CHARS = 6_000;

export async function launchPiWendaoChatTui(options: PiWendaoChatTuiOptions): Promise<PiWendaoChatTuiResult> {
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal, true);
	const editor = new Editor(tui, createEditorTheme(), { paddingX: 1, autocompleteMaxVisible: 8 });
	const graphView = new GraphView();
	const view = new PiWendaoChatView(terminal, editor, options.invocationCwd, graphView);
	const messages: Message[] = [];
	const workflowContext = new WorkflowChatContextSession(messages);
	const chatSessionId = `pi-wendao-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

	let activeAbort: AbortController | undefined;
	let activeWorkflowReply: {
		request: PlannerReplyRequest;
		resolve: (answer: string) => void;
		signal?: AbortSignal;
	} | undefined;
	let workflowRunning = false;
	let settled = false;

	tui.addChild(view);
	tui.setFocus(editor);

	return new Promise<PiWendaoChatTuiResult>((resolve) => {
		function finish(result: PiWendaoChatTuiResult): void {
			if (settled) return;
			settled = true;
			activeAbort?.abort();
			tui.stop();
			resolve(result);
		}

		tui.addInputListener((data) => {
			if (!matchesKey(data, Key.ctrl("c"))) return undefined;
			if (activeAbort) {
				activeAbort.abort();
				view.setStatus("aborting current response");
				tui.requestRender();
				return { consume: true };
			}
			finish({ kind: "exit" });
			return { consume: true };
		});

		editor.onSubmit = (value) => {
			void handleSubmit(value);
		};

		view.append("system", "pi-wendao chat ready. Type normally to talk to the LLM, or use /run <workflow.bpmn>.");
		view.append("system", "Commands: /run <workflow.bpmn>, /show, /show <instance> [bpmn], /help, /quit.");
		tui.start();
		tui.requestRender(true);

		async function handleSubmit(rawInput: string): Promise<void> {
			const input = rawInput.trim();
			if (activeWorkflowReply) {
				editor.addToHistory(input);
				editor.setText("");
				completeWorkflowReply(input || defaultWorkflowReply(activeWorkflowReply.request));
				return;
			}
			if (!input || activeAbort) return;
			editor.addToHistory(input);
			editor.setText("");

			const command = parsePiWendaoChatCommand(input);
			switch (command.kind) {
				case "chat":
					await sendChatMessage(command.text);
					return;
				case "help":
					view.append("system", "Type a normal message to chat with the configured LLM.");
					view.append("system", "Use /run <workflow.bpmn> to execute that qianji BPMN workflow with graph on the right and native chat streaming on the left.");
					view.append("system", "Use /show or /show <instance> [bpmn] to inspect qianji BPMN instances.");
					tui.requestRender();
					return;
				case "exit":
					finish({ kind: "exit" });
					return;
				case "run":
					view.append("user", input);
					if (!options.runWorkflow) {
						view.append("system", `loading workflow ${command.workflowPath}`);
						tui.requestRender();
						finish({ kind: "workflow", workflowPath: command.workflowPath });
						return;
					}
					if (workflowRunning) {
						view.append("system", "A workflow is already running.");
						tui.requestRender();
						return;
					}
					await runWorkflowInSidebar(command.workflowPath);
					return;
				case "show":
					await runShowCommand(input, command);
					return;
				case "unknown":
					view.append("user", input);
					view.append("error", `unknown command: ${command.text}`);
					view.append("system", "Use /help for available commands.");
					tui.requestRender();
					return;
			}
		}

		async function runWorkflowInSidebar(workflowPath: string): Promise<void> {
			workflowRunning = true;
			view.openWorkflow(workflowPath);
			workflowContext.start(workflowPath);
			view.append("system", `running workflow: ${workflowPath}`);
			workflowContext.record("system", `running workflow: ${workflowPath}`);
			view.setStatus("workflow running");
			refreshWorkflowView();
			const renderer = createChatRenderer({
				graphView,
				view,
				refresh: refreshWorkflowView,
				requestPlannerReply: requestWorkflowReply,
				recordWorkflowContext: (role, text) => workflowContext.record(role, text),
			});
			try {
				const result = await options.runWorkflow!(workflowPath, renderer);
				const statusLine = result.success
					? `workflow completed: ${workflowPath}`
					: `workflow failed: ${workflowPath}`;
				view.append("system", statusLine);
				workflowContext.finish(result.success, workflowPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				view.append("error", message);
				workflowContext.record("error", message);
				workflowContext.finish(false, workflowPath);
			} finally {
				workflowRunning = false;
				view.setStatus("ready");
				refreshWorkflowView();
			}
		}

		function refreshWorkflowView(): void {
			view.invalidate();
			tui.requestRender();
		}

		function requestWorkflowReply(request: PlannerReplyRequest, signal?: AbortSignal): Promise<string> {
			return new Promise((resolve) => {
				activeWorkflowReply = { request, resolve, signal };
				const prompt = workflowPromptLabel(request);
				const message = `${prompt}\n${request.message || "(empty request)"}`;
				view.append("assistant", message);
				workflowContext.record("assistant", message);
				view.setStatus(prompt);
				refreshWorkflowView();
				if (signal?.aborted) completeWorkflowReply("rejected");
			});
		}

		function completeWorkflowReply(answer: string): void {
			if (!activeWorkflowReply) return;
			const current = activeWorkflowReply;
			activeWorkflowReply = undefined;
			view.append("user", answer);
			workflowContext.record("user", answer);
			view.setStatus(workflowRunning ? "workflow running" : "ready");
			refreshWorkflowView();
			current.resolve(answer);
		}

		async function sendChatMessage(text: string): Promise<void> {
			const userMessage: Message = {
				role: "user",
				content: text,
				timestamp: Date.now(),
			};
			messages.push(userMessage);
			view.append("user", text);
			view.setStatus("LLM responding");
			editor.disableSubmit = true;
			activeAbort = new AbortController();
			tui.requestRender();

			try {
				const stream = streamSimple(
					options.resolvedModel.model as Model<string>,
					{
						systemPrompt: CHAT_SYSTEM_PROMPT,
						messages,
					},
					{
						apiKey: options.resolvedModel.apiKey,
						headers: options.resolvedModel.headers,
						signal: activeAbort.signal,
						sessionId: chatSessionId,
						...reasoningOption(options.thinkingLevel),
					},
				);

				for await (const event of stream) {
					if (event.type === "text_delta") {
						view.appendAssistantDelta(event.delta);
					} else if (event.type === "thinking_start") {
						view.beginThinking();
					} else if (event.type === "thinking_delta") {
						view.appendThinkingDelta(event.delta);
					} else if (event.type === "thinking_end") {
						view.endThinking(event.content);
					} else if (event.type === "toolcall_start") {
						view.append("tool", `tool call started at content index ${event.contentIndex}`);
					} else if (event.type === "toolcall_end") {
						view.append("tool", `${event.toolCall.name}(${JSON.stringify(event.toolCall.arguments)})`);
					} else if (event.type === "error") {
						view.append("error", event.error.errorMessage ?? "model returned an error");
					}
					tui.requestRender();
				}

				const assistant = await stream.result();
				if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
					view.append("error", assistant.errorMessage ?? `model stopped: ${assistant.stopReason}`);
				} else {
					messages.push(assistant);
					view.ensureAssistantMessage(assistant);
				}
			} catch (error) {
				if (activeAbort?.signal.aborted) {
					view.append("system", "response aborted");
				} else {
					view.append("error", error instanceof Error ? error.message : String(error));
				}
			} finally {
				activeAbort = undefined;
				editor.disableSubmit = false;
				view.setStatus("ready");
				tui.requestRender();
			}
		}

		async function runShowCommand(input: string, command: Extract<PiWendaoChatCommand, { kind: "show" }>): Promise<void> {
			view.append("user", input);
			view.setStatus("running qianji show");
			editor.disableSubmit = true;
			tui.requestRender();
			try {
				const output = command.instanceId
					? await options.showInstanceStatus(command.instanceId, command.workflowPath)
					: await options.showInstances();
				view.append("tool", formatPiWendaoChatCommandOutput(output));
			} catch (error) {
				view.append("error", error instanceof Error ? error.message : String(error));
			} finally {
				editor.disableSubmit = false;
				view.setStatus("ready");
				tui.requestRender();
			}
		}
	});
}

export function parsePiWendaoChatCommand(input: string): PiWendaoChatCommand {
	const command = input.trim();
	if (!command) return { kind: "chat", text: "" };
	if (!command.startsWith("/")) return { kind: "chat", text: command };
	if (command === "/help" || command === "/h") return { kind: "help" };
	if (command === "/quit" || command === "/exit" || command === "/q") return { kind: "exit" };
	const runMatch = command.match(/^\/(?:run|open)\s+(.+)$/);
	if (runMatch?.[1]) {
		return { kind: "run", workflowPath: cleanCommandPath(runMatch[1]) };
	}
	const showMatch = command.match(/^\/show(?:\s+([^\s]+)(?:\s+(.+))?)?$/);
	if (showMatch) {
		return {
			kind: "show",
			instanceId: showMatch[1],
			workflowPath: showMatch[2] ? cleanCommandPath(showMatch[2]) : undefined,
		};
	}
	return { kind: "unknown", text: command };
}

export function formatPiWendaoChatCommandOutput(output: PiWendaoChatCommandOutput): string {
	const parts = [
		output.stdout.trimEnd(),
		output.stderr.trimEnd(),
		output.exitCode && output.exitCode !== 0 ? `command exited with code ${output.exitCode}` : "",
	].filter((part) => part.length > 0);
	return parts.length > 0 ? parts.join("\n") : "(no output)";
}

export class WorkflowChatContextSession {
	private workflowPath: string | undefined;
	private status: "running" | "completed" | "failed" | undefined;
	private readonly lines: string[] = [];
	private omittedEvents = 0;
	private contextMessage: UserMessage | undefined;

	constructor(private readonly messages: Message[]) {}

	start(workflowPath: string): void {
		this.removeContextMessage();
		this.workflowPath = workflowPath;
		this.status = "running";
		this.lines.length = 0;
		this.omittedEvents = 0;
		this.contextMessage = undefined;
		this.record("system", `workflow path: ${workflowPath}`);
	}

	record(role: TranscriptRole, text: string): void {
		const normalized = selectWorkflowContextEventLines(stripAnsi(text)
			.split(/\r?\n/)
			.map((line) => line.trimEnd())
			.filter((line) => line.trim().length > 0));
		for (const line of normalized) {
			this.lines.push(`${role}> ${compactWorkflowContextLine(line)}`);
		}
		this.trimToBudget();
		this.syncContextMessage();
	}

	finish(success: boolean, workflowPath = this.workflowPath ?? ""): void {
		this.status = success ? "completed" : "failed";
		this.record("system", workflowPath ? `workflow ${this.status}: ${workflowPath}` : `workflow ${this.status}`);
	}

	toContextMessageContent(): string {
		const header = [
			"[pi-wendao workflow context]",
			this.workflowPath ? `workflowPath: ${this.workflowPath}` : undefined,
			this.status ? `status: ${this.status}` : undefined,
			this.omittedEvents > 0 ? `omittedEvents: ${this.omittedEvents}` : undefined,
			"events:",
		].filter((line): line is string => Boolean(line));
		return [...header, ...this.lines].join("\n");
	}

	private trimToBudget(): void {
		while (this.lines.length > MAX_WORKFLOW_CONTEXT_LINES) {
			this.lines.shift();
			this.omittedEvents += 1;
		}
		while (this.toContextMessageContent().length > MAX_WORKFLOW_CONTEXT_CHARS && this.lines.length > 0) {
			this.lines.shift();
			this.omittedEvents += 1;
		}
	}

	private syncContextMessage(): void {
		const content = this.toContextMessageContent();
		if (!this.contextMessage) {
			this.contextMessage = {
				role: "user",
				content,
				timestamp: Date.now(),
			};
			this.messages.push(this.contextMessage);
			return;
		}
		this.contextMessage.content = content;
		this.contextMessage.timestamp = Date.now();
	}

	private removeContextMessage(): void {
		if (!this.contextMessage) return;
		const index = this.messages.indexOf(this.contextMessage);
		if (index >= 0) this.messages.splice(index, 1);
	}
}

function reasoningOption(level: PiWendaoChatThinkingLevel): { reasoning?: PiAiThinkingLevel } {
	return level === "off" ? {} : { reasoning: level };
}

function cleanCommandPath(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

function createEditorTheme(): EditorTheme {
	const selectList = {
		selectedPrefix: (text: string) => green(text),
		selectedText: (text: string) => cyan(text),
		description: (text: string) => dim(text),
		scrollInfo: (text: string) => dim(text),
		noMatch: (text: string) => red(text),
	};
	return {
		borderColor: (text: string) => cyan(text),
		selectList,
	};
}

function createChatRenderer(options: {
	graphView: GraphView;
	view: PiWendaoChatView;
	refresh: () => void;
	requestPlannerReply: Renderer["requestPlannerReply"];
	recordWorkflowContext?: (role: TranscriptRole, text: string) => void;
}): Renderer {
	return {
		graphView: options.graphView,
		refresh: options.refresh,
		start() {},
		stop() {},
		waitForKey: async () => {},
		requestPlannerReply: options.requestPlannerReply,
		appendLog(text: string) {
			options.view.appendWorkflowLog(text);
			options.recordWorkflowContext?.("tool", text);
			options.refresh();
		},
		onAgentEvent(event: PiWendaoAgentEvent) {
			options.view.appendAgentEvent(event);
			const summary = summarizeAgentEventForWorkflowContext(event);
			if (summary) options.recordWorkflowContext?.(summary.role, summary.text);
			options.refresh();
		},
		onNodeStart(activityId: string, activityName: string) {
			const text = `qianji started ${activityName} (${activityId})`;
			options.view.append("tool", text);
			options.recordWorkflowContext?.("tool", text);
			options.refresh();
		},
		onNodeEnd(activityId: string, activityName: string) {
			const text = `qianji completed ${activityName} (${activityId})`;
			options.view.append("tool", text);
			options.recordWorkflowContext?.("tool", text);
			options.refresh();
		},
		onFlowTake(_flowId: string) {},
		onTraceEvent(event: QianjiTraceLogEvent) {
			const text = formatWorkflowTraceForChat(event);
			options.view.append("tool", text);
			options.recordWorkflowContext?.("tool", text);
			options.refresh();
		},
		onError(err: Error) {
			options.view.append("error", err.message);
			options.recordWorkflowContext?.("error", err.message);
			options.refresh();
		},
		printVariables(variables: Record<string, unknown>) {
			const entries = Object.entries(variables);
			if (entries.length === 0) return;
			const text = [
				"variables",
				...entries.map(([key, value]) => `  ${key}: ${formatVariableValueForLog(value)}`),
			].join("\n");
			options.view.append("tool", text);
			options.recordWorkflowContext?.("tool", text);
			options.refresh();
		},
	};
}

class PiWendaoChatView implements Component {
	private readonly transcript: TranscriptEntry[] = [];
	private status = "ready";
	private activeAssistantIndex: number | undefined;
	private activeThinkingIndex: number | undefined;
	private workflowTitle: string | undefined;
	private workflowFormattedRole: TranscriptRole | undefined;
	private workflowFormattedIndex: number | undefined;

	constructor(
		private readonly terminal: Terminal,
		private readonly editor: Editor,
		private readonly cwd: string,
		private readonly graphView: GraphView,
	) {}

	append(role: TranscriptRole, text: string): void {
		this.transcript.push({ role, text });
		if (role !== "assistant") this.activeAssistantIndex = undefined;
		if (role !== "thinking") this.activeThinkingIndex = undefined;
		this.workflowFormattedRole = undefined;
		this.workflowFormattedIndex = undefined;
	}

	setStatus(status: string): void {
		this.status = status;
	}

	openWorkflow(workflowPath: string): void {
		this.workflowTitle = workflowPath;
		this.graphView.clear();
		this.workflowFormattedRole = undefined;
		this.workflowFormattedIndex = undefined;
	}

	appendWorkflowLog(text: string): void {
		for (const rawLine of text.split(/\r?\n/)) {
			this.appendWorkflowLine(rawLine);
		}
	}

	appendAgentEvent(event: PiWendaoAgentEvent): void {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") this.startAssistantMessage();
				return;
			case "message_update": {
				const assistantEvent = event.assistantMessageEvent;
				switch (assistantEvent.type) {
					case "text_delta":
						this.appendAssistantDelta(assistantEvent.delta);
						return;
					case "thinking_start":
						this.beginThinking();
						return;
					case "thinking_delta":
						this.appendThinkingDelta(assistantEvent.delta);
						return;
					case "thinking_end":
						this.endThinking(assistantEvent.content);
						return;
					case "toolcall_start":
						this.append("tool", `tool call started at content index ${assistantEvent.contentIndex}`);
						return;
					case "toolcall_end":
						this.append("tool", `${assistantEvent.toolCall.name}(${JSON.stringify(assistantEvent.toolCall.arguments)})`);
						return;
					case "error":
						this.append("error", assistantEvent.error.errorMessage ?? "model returned an error");
						return;
					default:
						return;
				}
			}
			case "message_end":
				this.ensureAssistantMessage(event.message);
				return;
			case "tool_execution_start":
				this.append("tool", `${event.toolName} ${formatArgsForLog(event.args)}`);
				return;
			case "tool_execution_update":
				this.append("tool", `${event.toolName} update ${summarizeToolUpdate(event.partialResult)}`);
				return;
			case "tool_execution_end":
				this.appendWorkflowLog(formatToolResultForLog(event.toolName, event.result, event.isError).join("\n"));
				return;
			case "agent_start":
			case "agent_end":
			case "turn_start":
			case "turn_end":
				return;
		}
	}

	appendAssistantDelta(delta: string): void {
		if (this.activeAssistantIndex === undefined) {
			this.transcript.push({ role: "assistant", text: "" });
			this.activeAssistantIndex = this.transcript.length - 1;
		}
		this.transcript[this.activeAssistantIndex]!.text += delta;
	}

	private startAssistantMessage(): void {
		this.transcript.push({ role: "assistant", text: "" });
		this.activeAssistantIndex = this.transcript.length - 1;
		this.workflowFormattedRole = undefined;
		this.workflowFormattedIndex = undefined;
	}

	ensureAssistantMessage(message: Message): void {
		if (message.role !== "assistant") return;
		const text = message.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("");
		if (!text.trim()) return;
		if (this.activeAssistantIndex === undefined) {
			this.transcript.push({ role: "assistant", text });
			this.activeAssistantIndex = this.transcript.length - 1;
			return;
		}
		this.transcript[this.activeAssistantIndex]!.text = text;
	}

	beginThinking(): void {
		if (this.activeThinkingIndex !== undefined) return;
		this.transcript.push({ role: "thinking", text: "" });
		this.activeThinkingIndex = this.transcript.length - 1;
	}

	appendThinkingDelta(delta: string): void {
		if (this.activeThinkingIndex === undefined) this.beginThinking();
		this.transcript[this.activeThinkingIndex!]!.text += delta;
	}

	endThinking(content: string): void {
		if (this.activeThinkingIndex === undefined) return;
		if (content.trim()) this.transcript[this.activeThinkingIndex]!.text = content;
		this.activeThinkingIndex = undefined;
	}

	private appendWorkflowLine(rawLine: string): void {
		const line = stripAnsi(rawLine).trimEnd();
		if (!hasVisibleText(line)) {
			this.workflowFormattedRole = undefined;
			this.workflowFormattedIndex = undefined;
			return;
		}
		const trimmed = line.trim();
		if (trimmed === "assistant") {
			this.startWorkflowFormattedEntry("assistant", "");
			return;
		}
		if (trimmed === "user") {
			this.startWorkflowFormattedEntry("user", "");
			return;
		}
		if (trimmed === "thinking summary") {
			this.startWorkflowFormattedEntry("thinking", "");
			return;
		}
		if (/^\s+/.test(line) && this.workflowFormattedRole && this.workflowFormattedIndex !== undefined) {
			const unindented = line.replace(/^\s{2}/, "");
			const nestedRole = classifyWorkflowChatLine(unindented.trim());
			if (this.workflowFormattedRole === "agent" && nestedRole === "tool") {
				this.startWorkflowFormattedEntry("tool", normalizeWorkflowChatLine(unindented.trim(), "tool"));
				return;
			}
			this.appendToWorkflowFormattedEntry(unindented);
			return;
		}
		const role = classifyWorkflowChatLine(trimmed);
		this.startWorkflowFormattedEntry(role, normalizeWorkflowChatLine(trimmed, role));
	}

	private startWorkflowFormattedEntry(role: TranscriptRole, text: string): void {
		this.workflowFormattedRole = role;
		this.transcript.push({ role, text });
		this.workflowFormattedIndex = this.transcript.length - 1;
		if (role !== "assistant") this.activeAssistantIndex = undefined;
		if (role !== "thinking") this.activeThinkingIndex = undefined;
	}

	private appendToWorkflowFormattedEntry(text: string): void {
		if (this.workflowFormattedIndex === undefined) return;
		const entry = this.transcript[this.workflowFormattedIndex];
		if (!entry) return;
		entry.text = entry.text ? `${entry.text}\n${text}` : text;
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		if (this.workflowTitle && safeWidth >= 110) {
			return this.renderWithWorkflowSidebar(safeWidth);
		}
		if (this.workflowTitle) {
			return this.renderWithWorkflowTopPanel(safeWidth);
		}
		return this.renderMain(safeWidth);
	}

	private renderMain(width: number, height = this.terminal.rows): string[] {
		const header = [
			truncateToWidth(`${bold("pi-wendao")} ${dim("LLM chat + qianji workflow runner")}`, width),
			truncateToWidth(dim(`cwd: ${this.cwd}`), width),
			truncateToWidth(dim("Enter sends chat. Commands: /run <bpmn>, /show, /help, /quit. Ctrl+C aborts/exits."), width),
			truncateToWidth(dim(`status: ${this.status}`), width),
		];
		const editorLines = this.editor.render(width);
		const separator = truncateToWidth(dim("-".repeat(Math.max(1, width))), width);
		const availableRows = Math.max(1, height - header.length - editorLines.length - 1);
		const transcriptLines = this.renderTranscript(width);
		const visibleTranscript = transcriptLines.slice(-availableRows);
		while (visibleTranscript.length < availableRows) visibleTranscript.unshift("");
		const lines = [...header, ...visibleTranscript, separator, ...editorLines].map((line) => truncateToWidth(line, width));
		while (lines.length < height) lines.push("");
		return lines.slice(0, height);
	}

	private renderWithWorkflowSidebar(width: number): string[] {
		const sidebarWidth = Math.min(56, Math.max(28, Math.floor(width * 0.38)));
		const separatorWidth = 1;
		const mainWidth = Math.max(30, width - sidebarWidth - separatorWidth);
		const main = this.renderMain(mainWidth).slice(0, this.terminal.rows);
		const sidebar = this.renderWorkflowSidebar(sidebarWidth, this.terminal.rows);
		const rows = Math.max(this.terminal.rows, main.length, sidebar.length);
		const lines: string[] = [];
		for (let i = 0; i < rows; i += 1) {
			const left = padToWidth(main[i] ?? "", mainWidth);
			const right = sidebar[i] ?? "";
			lines.push(truncateToWidth(`${left}${dim("|")}${right}`, width));
		}
		return lines;
	}

	private renderWithWorkflowTopPanel(width: number): string[] {
		const totalRows = this.terminal.rows;
		const graphHeight = Math.max(7, Math.min(Math.floor(totalRows * 0.45), totalRows - 8));
		const chatHeight = Math.max(1, totalRows - graphHeight - 1);
		const graph = this.renderWorkflowGraphPanel(width, graphHeight);
		const separator = truncateToWidth(dim("-".repeat(Math.max(1, width))), width);
		const main = this.renderMain(width, chatHeight);
		return [...graph, separator, ...main].slice(0, totalRows);
	}

	private renderWorkflowSidebar(width: number, height: number): string[] {
		return this.renderWorkflowGraphPanel(width, height);
	}

	private renderWorkflowGraphPanel(width: number, height: number): string[] {
		const title = truncateToWidth(`${bold("workflow graph")} ${dim(this.workflowTitle ?? "")}`, width);
		const graphBudget = Math.max(1, height - 2);
		const graphLines = sliceAround(
			this.graphView.render(width),
			graphBudget,
			this.graphView.getActiveRow(),
		);
		const lines = [
			title,
			truncateToWidth(dim("-".repeat(Math.max(1, width))), width),
			...(graphLines.length > 0 ? graphLines : [dim("waiting for qianji trace")]),
		].map((line) => truncateToWidth(line, width));
		while (lines.length < height) lines.push("");
		return lines.slice(0, height);
	}

	private renderTranscript(width: number): string[] {
		const lines: string[] = [];
		for (const entry of this.transcript) {
			const label = roleLabel(entry.role);
			const text = entry.text.trimEnd();
			if (!text) {
				lines.push(truncateToWidth(label, width));
				continue;
			}
			const firstLineBudget = Math.max(8, width - visibleWidth(label) - 1);
			const wrapped = wrapTextWithAnsi(text, firstLineBudget);
			const [first, ...rest] = wrapped.length > 0 ? wrapped : [""];
			lines.push(truncateToWidth(`${label} ${first}`, width));
			for (const chunk of rest.flatMap((line) => wrapTextWithAnsi(line, Math.max(8, width - 2)))) {
				lines.push(truncateToWidth(`  ${chunk}`, width));
			}
		}
		return lines;
	}
}

function workflowPromptLabel(request: PlannerReplyRequest): string {
	const activity = request.context?.activityId ? ` ${request.context.activityId}` : "";
	if (request.action === "human_task" || request.to === "user") return `user input${activity}`;
	return `planner input${activity}`;
}

function defaultWorkflowReply(request: PlannerReplyRequest): string {
	return request.action === "workflow_path" ? "" : "approved";
}

function padToWidth(value: string, width: number): string {
	const truncated = truncateToWidth(value, width);
	const padding = Math.max(0, width - visibleWidth(truncated));
	return `${truncated}${" ".repeat(padding)}`;
}

function sliceAround(lines: string[], budget: number, preferredRow: number): string[] {
	if (lines.length <= budget) return lines;
	const half = Math.floor(budget / 2);
	const start = Math.max(0, Math.min(lines.length - budget, preferredRow - half));
	return lines.slice(start, start + budget);
}

export function classifyWorkflowChatLine(line: string): TranscriptRole {
	const clean = stripAnsi(line).trim();
	if (!clean) return "system";
	if (clean === "user") return "user";
	if (clean === "assistant") return "assistant";
	if (clean === "thinking summary") return "thinking";
	if (/^error:/i.test(clean) || /^execution failed:/i.test(clean)) return "error";
	if (/^(qianji|flow|start event|end event|service task|user task|business rule task|script task|send task|receive task|manual task|exclusive gateway|parallel gateway|inclusive gateway|event based gateway|complex gateway)\b/i.test(clean)) {
		return "tool";
	}
	if (/^subagent\b/i.test(clean)) return "agent";
	if (/^(tool|host job|parallel jobs|host backend|agent tool|extension tool|variables)\b/i.test(clean)) return "tool";
	if (/^workflow completed successfully\.$/i.test(clean)) return "system";
	return "system";
}

function normalizeWorkflowChatLine(line: string, role: TranscriptRole): string {
	if (role !== "tool") return line;
	if (/^(flow|start event|end event|service task|user task|business rule task|script task|send task|receive task|manual task|exclusive gateway|parallel gateway|inclusive gateway|event based gateway|complex gateway)\b/i.test(line)) {
		return `qianji: ${line}`;
	}
	return line;
}

function formatWorkflowTraceForChat(event: QianjiTraceLogEvent): string {
	if (event.kind === "flow_take") {
		return `qianji: flow ${event.source_id} -> ${event.target_id}`;
	}
	const kind = event.node_kind ? event.node_kind.replace(/_/g, " ") : "node";
	return `qianji: ${kind} ${event.node_id} ${event.status}`;
}

function summarizeToolUpdate(result: { content?: unknown; details?: unknown }): string {
	if (Array.isArray(result.content)) {
		const text = result.content
			.map((content) => isObject(content) && typeof content.text === "string" ? content.text : "")
			.filter(Boolean)
			.join("\n");
		if (text.trim()) return formatVariableValueForLog(text);
	}
	return formatVariableValueForLog(result.details ?? result);
}

function summarizeAgentEventForWorkflowContext(event: PiWendaoAgentEvent): { role: TranscriptRole; text: string } | undefined {
	switch (event.type) {
		case "agent_start":
			return { role: "agent", text: "agent started" };
		case "agent_end":
			return { role: "agent", text: "agent ended" };
		case "message_end": {
			if (event.message.role !== "assistant") return undefined;
			const text = extractPiWendaoMessageText(event.message);
			return text.trim() ? { role: "assistant", text } : undefined;
		}
		case "tool_execution_start": {
			const args = formatArgsForLog(event.args);
			return { role: "tool", text: args ? `${event.toolName} ${args}` : event.toolName };
		}
		case "tool_execution_update": {
			const update = summarizeToolUpdate(event.partialResult);
			return update ? { role: "tool", text: `${event.toolName} update ${update}` } : undefined;
		}
		case "tool_execution_end": {
			const text = formatToolResultForLog(event.toolName, event.result, event.isError)
				.map((line) => stripAnsi(line))
				.join("\n");
			return { role: "tool", text };
		}
		default:
			return undefined;
	}
}

function extractPiWendaoMessageText(message: PiWendaoAgentMessage): string {
	if (message.role === "user") {
		return typeof message.content === "string"
			? message.content
			: message.content
				.map((entry) => entry.type === "text" ? entry.text : "")
				.join("");
	}
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((entry) => isObject(entry) && entry.type === "text" && typeof entry.text === "string" ? entry.text : "")
		.join("");
}

function compactWorkflowContextLine(line: string): string {
	const compact = line.replace(/\s+/g, " ").trim();
	if (compact.length <= MAX_WORKFLOW_CONTEXT_LINE_LENGTH) return compact;
	const marker = "... (truncated)";
	return `${compact.slice(0, Math.max(0, MAX_WORKFLOW_CONTEXT_LINE_LENGTH - marker.length))}${marker}`;
}

function selectWorkflowContextEventLines(lines: string[]): string[] {
	if (lines.length <= MAX_WORKFLOW_CONTEXT_EVENT_LINES) return lines;
	const headCount = Math.ceil((MAX_WORKFLOW_CONTEXT_EVENT_LINES - 1) / 2);
	const tailCount = Math.floor((MAX_WORKFLOW_CONTEXT_EVENT_LINES - 1) / 2);
	const omitted = lines.length - headCount - tailCount;
	return [
		...lines.slice(0, headCount),
		`... ${omitted} lines omitted from this event ...`,
		...lines.slice(lines.length - tailCount),
	];
}

function hasVisibleText(line: string): boolean {
	return stripAnsi(line).trim().length > 0;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roleLabel(role: TranscriptRole): string {
	switch (role) {
		case "system":
			return dim("system>");
			case "user":
				return green("user>");
			case "assistant":
				return cyan("assistant>");
			case "thinking":
				return dim("thinking>");
			case "agent":
				return bold("agent>");
			case "tool":
				return yellow("tool>");
			case "error":
				return red("error>");
		}
}
