import { join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import {
  ExtensionRunner,
  SessionManager,
  type AgentSession,
  type CompactOptions,
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
  session?: AgentSession;
  signal?: AbortSignal;
  onToolEvent?: (event: PiSubagentsHostToolEvent) => void;
}

export interface CreateCliPiSubagentsHostOptions extends CreateCliExtensionContextOptions {
  runStorePath?: string;
  defaultSubagentType?: string;
  defaultRunInBackground?: boolean;
  defaultModel?: string;
  defaultThinking?: string;
  defaultMaxTurns?: number;
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
    ...(options.defaultRunInBackground === undefined
      ? {}
      : { defaultRunInBackground: options.defaultRunInBackground }),
    ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
    ...(options.defaultThinking ? { defaultThinking: options.defaultThinking } : {}),
    ...(options.defaultMaxTurns === undefined ? {} : { defaultMaxTurns: options.defaultMaxTurns }),
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
  return createCliExtensionContextInternal(options);
}

function createCliExtensionContextInternal(
  options: CreateCliExtensionContextOptions,
): ExtensionContext {
  let currentModel: Model<any> | undefined = options.model;
  let runner: ExtensionRunner;
  const session = options.session;
  const sessionManager = session?.sessionManager ?? SessionManager.inMemory(options.cwd);
  const actions = {
    sendMessage: (...args: Parameters<AgentSession["sendCustomMessage"]>) => {
      if (!session) return;
      void session
        .sendCustomMessage(...args)
        .catch((error: unknown) => reportExtensionActionError(runner, "send_message", error));
    },
    sendUserMessage: (...args: Parameters<AgentSession["sendUserMessage"]>) => {
      if (!session) return;
      void session
        .sendUserMessage(...args)
        .catch((error: unknown) => reportExtensionActionError(runner, "send_user_message", error));
    },
    appendEntry: (customType: string, data?: unknown) => {
      session?.sessionManager.appendCustomEntry(customType, data);
    },
    setSessionName: (name: string) => {
      session?.sessionManager.appendSessionInfo(name);
    },
    getSessionName: () => session?.sessionName,
    setLabel: (entryId: string, label: string | undefined) => {
      session?.sessionManager.appendLabelChange(entryId, label);
    },
    getActiveTools: () => session?.getActiveToolNames() ?? [],
    getAllTools: () =>
      session?.getAllTools() ??
      runner.getAllRegisteredTools().map((tool) => ({
        name: tool.definition.name,
        description: tool.definition.description,
        parameters: tool.definition.parameters,
        sourceInfo: tool.sourceInfo,
      })),
    setActiveTools: (toolNames: string[]) => {
      session?.setActiveToolsByName(toolNames);
    },
    refreshTools: () => {
      if (!session) return;
      void session
        .reload()
        .catch((error: unknown) => reportExtensionActionError(runner, "refresh_tools", error));
    },
    getCommands: () => [
      ...runner.getRegisteredCommands().map((command) => ({
        name: command.invocationName,
        description: command.description,
        source: "extension" as const,
        sourceInfo: command.sourceInfo,
      })),
      ...(session?.promptTemplates.map((template) => ({
        name: template.name,
        description: template.description,
        source: "prompt" as const,
        sourceInfo: template.sourceInfo,
      })) ?? []),
      ...(session?.resourceLoader.getSkills().skills.map((skill) => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill" as const,
        sourceInfo: skill.sourceInfo,
      })) ?? []),
    ],
    setModel: async (model: Model<any>) => {
      currentModel = model;
      if (session) {
        if (!session.modelRegistry.hasConfiguredAuth(model)) return false;
        await session.setModel(model);
      }
      return true;
    },
    getThinkingLevel: () => session?.thinkingLevel ?? ("medium" as const),
    setThinkingLevel: (level: AgentSession["thinkingLevel"]) => {
      session?.setThinkingLevel(level);
    },
  };
  const contextActions = {
    getModel: () => session?.model ?? currentModel,
    isIdle: () => !session?.isStreaming,
    getSignal: () => session?.agent.signal ?? options.signal,
    abort: () => {
      if (session) void session.abort();
    },
    hasPendingMessages: () => (session?.pendingMessageCount ?? 0) > 0,
    shutdown: () => {},
    getContextUsage: () => session?.getContextUsage(),
    compact: (compactOptions?: CompactOptions) => {
      if (!session) return;
      void session
        .compact(compactOptions?.customInstructions)
        .then((result) => compactOptions?.onComplete?.(result))
        .catch((error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          compactOptions?.onError?.(err);
          reportExtensionActionError(runner, "compact", err);
        });
    },
    getSystemPrompt: () => session?.systemPrompt ?? "",
  };

  runner = new ExtensionRunner(
    withPiWendaoToolEventBridge(options.loadResult.extensions, options.onToolEvent),
    options.loadResult.runtime,
    options.cwd,
    sessionManager,
    options.modelRegistry,
  );
  runner.bindCore(actions, contextActions);
  return runner.createContext();
}

function reportExtensionActionError(runner: ExtensionRunner, event: string, error: unknown): void {
  runner.emitError({
    extensionPath: "<pi-wendao-session>",
    event,
    error: error instanceof Error ? error.message : String(error),
  });
}

function withPiWendaoToolEventBridge(
  extensions: LoadExtensionsResult["extensions"],
  onToolEvent: ((event: PiSubagentsHostToolEvent) => void) | undefined,
): LoadExtensionsResult["extensions"] {
  if (!onToolEvent) return extensions;
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  handlers.set("tool_call", [
    (event) => {
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
    },
  ]);
  handlers.set("tool_result", [
    (event) => {
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
    },
  ]);
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
