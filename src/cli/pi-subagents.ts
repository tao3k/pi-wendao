import { join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import {
	ExtensionRunner,
	SessionManager,
	type ExtensionContext,
	type LoadExtensionsResult,
	type ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { PiWendaoAgentHost } from "../executor/agent-host.js";
import type {
	PiSubagentsHostEvent,
	PiSubagentsHostToolEvent,
	PiSubagentsHostUpdateEvent,
} from "../executor/pi-subagents-host.js";
import {
	getCurrentPiSubagentsToolExecutionContext,
	tryCreatePiSubagentsHostFromLoadedExtensions,
} from "../executor/pi-subagents-runtime.js";

const TOOL_EVENT_BRIDGE_KEY = "__PI_WENDAO_PI_SUBAGENTS_TOOL_EVENT_BRIDGE__";
export const DEFAULT_PI_WENDAO_SUBAGENT_TYPE = "pi-wendao-worker";

export interface CreateCliExtensionContextOptions {
	loadResult: LoadExtensionsResult;
	modelRegistry: ModelRegistry;
	cwd: string;
	model?: Model<string>;
	signal?: AbortSignal;
	onToolEvent?: (event: PiSubagentsHostToolEvent) => void;
}

export interface CreateCliPiSubagentsHostOptions extends CreateCliExtensionContextOptions {
	runStorePath?: string;
	defaultSubagentType?: string;
	defaultRunInBackground?: boolean;
	onUpdate?: (event: PiSubagentsHostUpdateEvent) => void;
	onEvent?: (event: PiSubagentsHostEvent) => void;
	onToolEvent?: (event: PiSubagentsHostToolEvent) => void;
}

export function createCliPiSubagentsHost(
	options: CreateCliPiSubagentsHostOptions,
): PiWendaoAgentHost | undefined {
	installGlobalToolEventBridge(options.onToolEvent);
	const ctx = createCliExtensionContext(options);
	return tryCreatePiSubagentsHostFromLoadedExtensions({
		loadResult: options.loadResult,
		ctx,
		runStorePath: options.runStorePath ?? defaultPiSubagentsRunStorePath(options.cwd),
		defaultSubagentType: options.defaultSubagentType ?? DEFAULT_PI_WENDAO_SUBAGENT_TYPE,
		...(options.defaultRunInBackground === undefined ? {} : { defaultRunInBackground: options.defaultRunInBackground }),
		toolCallIdPrefix: "pi-wendao",
		verboseResult: true,
		...(options.signal ? { signal: options.signal } : {}),
		...(options.onUpdate === undefined ? {} : { onUpdate: options.onUpdate }),
		...(options.onEvent ? { onEvent: options.onEvent } : {}),
		...(options.onToolEvent ? { onToolEvent: options.onToolEvent } : {}),
	});
}

function installGlobalToolEventBridge(
	onToolEvent: ((event: PiSubagentsHostToolEvent) => void) | undefined,
): void {
	if (!onToolEvent) return;
	(globalThis as Record<string, unknown>)[TOOL_EVENT_BRIDGE_KEY] = { onToolEvent };
}

export function createCliExtensionContext(
	options: CreateCliExtensionContextOptions,
): ExtensionContext {
	let currentModel: Model<any> | undefined = options.model;
	let runner: ExtensionRunner;
	const actions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => runner.getAllRegisteredTools().map((tool) => ({
			name: tool.definition.name,
			description: tool.definition.description,
			parameters: tool.definition.parameters,
			sourceInfo: tool.sourceInfo,
		})),
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async (model: Model<any>) => {
			currentModel = model;
			return true;
		},
		getThinkingLevel: () => "medium" as const,
		setThinkingLevel: () => {},
	};
	const contextActions = {
		getModel: () => currentModel,
		isIdle: () => true,
		getSignal: () => options.signal,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	};

	runner = new ExtensionRunner(
		withPiWendaoToolEventBridge(options.loadResult.extensions, options.onToolEvent),
		options.loadResult.runtime,
		options.cwd,
		SessionManager.inMemory(options.cwd),
		options.modelRegistry,
	);
	runner.bindCore(actions, contextActions);
	return runner.createContext();
}

function withPiWendaoToolEventBridge(
	extensions: LoadExtensionsResult["extensions"],
	onToolEvent: ((event: PiSubagentsHostToolEvent) => void) | undefined,
): LoadExtensionsResult["extensions"] {
	if (!onToolEvent) return extensions;
	const handlers = new Map<string, Array<(event: unknown) => void>>();
	handlers.set("tool_call", [(event) => {
		const context = getCurrentPiSubagentsToolExecutionContext();
		if (!context || !isRecord(event)) return;
		const toolName = readString(event.toolName);
		const toolCallId = readString(event.toolCallId);
		if (!toolName || !toolCallId || !isRecord(event.input)) return;
		onToolEvent({
			type: "tool_call",
			...context,
			toolName,
			toolCallId,
			input: event.input,
		});
	}]);
	handlers.set("tool_result", [(event) => {
		const context = getCurrentPiSubagentsToolExecutionContext();
		if (!context || !isRecord(event)) return;
		const toolName = readString(event.toolName);
		const toolCallId = readString(event.toolCallId);
		if (!toolName || !toolCallId || !isRecord(event.input)) return;
		onToolEvent({
			type: "tool_result",
			...context,
			toolName,
			toolCallId,
			input: event.input,
			content: event.content,
			...(event.details === undefined ? {} : { details: event.details }),
			isError: event.isError === true,
		});
	}]);
	const bridge = {
		path: "<pi-wendao-tool-events>",
		sourceInfo: {
			path: "<pi-wendao-tool-events>",
			resolvedPath: "<pi-wendao-tool-events>",
			type: "extension",
		},
		tools: new Map(),
		handlers,
		commands: new Map(),
		shortcuts: new Map(),
		flags: new Map(),
		messageRenderers: new Map(),
	};
	return [bridge as unknown as LoadExtensionsResult["extensions"][number], ...extensions];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function defaultPiSubagentsRunStorePath(cwd: string): string {
	const explicitPath = process.env.PI_WENDAO_SUBAGENTS_RUN_STORE?.trim();
	if (explicitPath) return explicitPath;
	const cacheHome = process.env.PRJ_CACHE_HOME?.trim();
	return join(cacheHome || join(cwd, ".cache"), "pi-wendao", "pi-subagents-run-store.json");
}
