import { AsyncLocalStorage } from "node:async_hooks";
import { discoverAndLoadExtensions } from "@mariozechner/pi-coding-agent";
import type { EventBus } from "@mariozechner/pi-coding-agent";
import type {
  PiSubagentsClient,
  PiSubagentsClientCallbacks,
  PiSubagentsGetResultRequest,
  PiSubagentsHostOptions,
  PiSubagentsSpawnRequest,
  PiSubagentsSpawnResult,
  PiSubagentsRunStore,
} from "./pi-subagents-host.js";
import { createJsonFilePiSubagentsRunStore, createPiSubagentsHost } from "./pi-subagents-host.js";
import type { PiWendaoAgentHost } from "./agent-host.js";

export interface PiToolResultContent {
  type: string;
  text?: string;
}

export interface PiToolResultLike {
  content?: PiToolResultContent[];
  details?: unknown;
}

export interface PiRegisteredToolDefinition {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<PiToolResultLike>;
}

export interface PiRegisteredToolLike {
  definition?: PiRegisteredToolDefinition;
  name?: string;
}

export interface PiLoadedExtensionLike {
  tools?: Map<string, PiRegisteredToolLike | PiRegisteredToolDefinition>;
}

export interface PiLoadedExtensionsLike {
  extensions?: PiLoadedExtensionLike[];
}

export interface PiSubagentsRegisteredTools {
  Agent?: PiRegisteredToolDefinition;
  get_subagent_result?: PiRegisteredToolDefinition;
}

export interface PiSubagentsToolExecutionContext {
  activityId: string;
  description: string;
  agentId?: string;
}

export interface PiSubagentsRegisteredToolClientOptions {
  ctx: unknown;
  signal?: AbortSignal;
  toolCallIdPrefix?: string;
  onUpdate?: unknown;
}

export interface PiSubagentsRuntimeHostOptions extends PiSubagentsRegisteredToolClientOptions {
  loadResult: PiLoadedExtensionsLike;
  runStore?: PiSubagentsRunStore;
  runStorePath?: string;
  defaultSubagentType?: string;
  defaultRunInBackground?: boolean;
  defaultModel?: string;
  defaultThinking?: string;
  defaultMaxTurns?: number;
  verboseResult?: boolean;
  onUpdate?: PiSubagentsHostOptions["onUpdate"];
  onEvent?: PiSubagentsHostOptions["onEvent"];
  onToolEvent?: PiSubagentsHostOptions["onToolEvent"];
}

export interface DiscoverPiSubagentsRuntimeHostOptions extends Omit<
  PiSubagentsRuntimeHostOptions,
  "loadResult"
> {
  cwd: string;
  agentDir?: string;
  extensionPaths?: string[];
  eventBus?: EventBus;
}

export interface DiscoverPiSubagentsRuntimeHostResult {
  loadResult: PiLoadedExtensionsLike;
  host?: PiWendaoAgentHost;
  errors: Array<{ path: string; error: string }>;
}

export function createPiSubagentsClientFromRegisteredTools(
  tools: PiSubagentsRegisteredTools,
  options: PiSubagentsRegisteredToolClientOptions,
): PiSubagentsClient {
  if (!tools.Agent || !tools.get_subagent_result) {
    throw new Error("pi-subagents registered tools Agent and get_subagent_result are required");
  }
  return {
    spawn: async (request, callbacks) => {
      const result = await executeRegisteredTool(
        tools.Agent!,
        "Agent",
        request,
        options,
        callbacks,
      );
      return extractAgentIdResult(result);
    },
    getResult: async (request, callbacks) => {
      const result = await executeRegisteredTool(
        tools.get_subagent_result!,
        "get_subagent_result",
        request,
        options,
        callbacks,
      );
      return toolResultToText(result);
    },
  };
}

export function createPiSubagentsClientFromLoadedExtensions(
  loadResult: PiLoadedExtensionsLike,
  options: PiSubagentsRegisteredToolClientOptions,
): PiSubagentsClient {
  return createPiSubagentsClientFromRegisteredTools(
    collectPiSubagentsRegisteredTools(loadResult),
    options,
  );
}

export async function discoverPiSubagentsHost(
  options: DiscoverPiSubagentsRuntimeHostOptions,
): Promise<DiscoverPiSubagentsRuntimeHostResult> {
  const loadResult = await discoverAndLoadExtensions(
    options.extensionPaths ?? [],
    options.cwd,
    options.agentDir,
    options.eventBus,
  );
  const host = tryCreatePiSubagentsHostFromLoadedExtensions({
    ...options,
    loadResult,
  });
  return {
    loadResult,
    host,
    errors: loadResult.errors,
  };
}

export function createPiSubagentsHostFromLoadedExtensions(
  options: PiSubagentsRuntimeHostOptions,
): PiWendaoAgentHost {
  const hostOptions = buildRuntimeHostOptions(options);
  return createPiSubagentsHost(hostOptions);
}

export function tryCreatePiSubagentsHostFromLoadedExtensions(
  options: PiSubagentsRuntimeHostOptions,
): PiWendaoAgentHost | undefined {
  const tools = collectPiSubagentsRegisteredTools(options.loadResult);
  if (!tools.Agent || !tools.get_subagent_result) return undefined;
  return createPiSubagentsHostFromLoadedExtensions(options);
}

export function collectPiSubagentsRegisteredTools(
  loadResult: PiLoadedExtensionsLike,
): PiSubagentsRegisteredTools {
  const found: PiSubagentsRegisteredTools = {};
  for (const extension of loadResult.extensions ?? []) {
    for (const [name, tool] of extension.tools ?? []) {
      if (name !== "Agent" && name !== "get_subagent_result") continue;
      const definition = extractToolDefinition(tool);
      if (!definition) continue;
      found[name] = definition;
    }
  }
  return found;
}

function buildRuntimeHostOptions(options: PiSubagentsRuntimeHostOptions): PiSubagentsHostOptions {
  const client = createPiSubagentsClientFromLoadedExtensions(options.loadResult, {
    ctx: options.ctx,
    signal: options.signal,
    toolCallIdPrefix: options.toolCallIdPrefix,
  });
  return {
    client,
    ...(options.defaultSubagentType ? { defaultSubagentType: options.defaultSubagentType } : {}),
    ...(options.defaultRunInBackground === undefined
      ? {}
      : { defaultRunInBackground: options.defaultRunInBackground }),
    ...(options.defaultModel ? { defaultModel: options.defaultModel } : {}),
    ...(options.defaultThinking ? { defaultThinking: options.defaultThinking } : {}),
    ...(options.defaultMaxTurns === undefined ? {} : { defaultMaxTurns: options.defaultMaxTurns }),
    ...(options.verboseResult === undefined ? {} : { verboseResult: options.verboseResult }),
    ...(options.onUpdate ? { onUpdate: options.onUpdate } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.onToolEvent ? { onToolEvent: options.onToolEvent } : {}),
    ...(options.runStore || options.runStorePath
      ? { runStore: options.runStore ?? createJsonFilePiSubagentsRunStore(options.runStorePath!) }
      : {}),
  };
}

const PI_SUBAGENTS_TOOL_CONTEXT_KEY = "__PI_WENDAO_PI_SUBAGENTS_TOOL_CONTEXT__";

export function getCurrentPiSubagentsToolExecutionContext():
  | PiSubagentsToolExecutionContext
  | undefined {
  return getPiSubagentsToolContextStorage().getStore();
}

function getPiSubagentsToolContextStorage(): AsyncLocalStorage<PiSubagentsToolExecutionContext> {
  const globalState = globalThis as Record<string, unknown>;
  const existing = globalState[PI_SUBAGENTS_TOOL_CONTEXT_KEY];
  if (existing instanceof AsyncLocalStorage) {
    return existing as AsyncLocalStorage<PiSubagentsToolExecutionContext>;
  }
  const storage = new AsyncLocalStorage<PiSubagentsToolExecutionContext>();
  globalState[PI_SUBAGENTS_TOOL_CONTEXT_KEY] = storage;
  return storage;
}

function extractToolDefinition(
  tool: PiRegisteredToolLike | PiRegisteredToolDefinition,
): PiRegisteredToolDefinition | undefined {
  if ("execute" in tool && typeof tool.execute === "function") return tool;
  const definition = (tool as PiRegisteredToolLike).definition;
  return definition && typeof definition.execute === "function" ? definition : undefined;
}

async function executeRegisteredTool(
  tool: PiRegisteredToolDefinition,
  name: string,
  params: PiSubagentsSpawnRequest | PiSubagentsGetResultRequest,
  options: PiSubagentsRegisteredToolClientOptions,
  callbacks?: PiSubagentsClientCallbacks,
): Promise<PiToolResultLike> {
  const operation = () =>
    tool.execute(
      `${options.toolCallIdPrefix ?? "pi-wendao"}:${name}:${Date.now()}`,
      params as unknown as Record<string, unknown>,
      options.signal,
      mergeToolUpdateCallbacks(callbacks?.onUpdate, options.onUpdate),
      options.ctx,
    );
  if (!callbacks) return operation();
  return getPiSubagentsToolContextStorage().run(
    {
      activityId: callbacks.activityId,
      description: callbacks.description,
      ...(callbacks.agentId ? { agentId: callbacks.agentId } : {}),
    },
    operation,
  );
}

function mergeToolUpdateCallbacks(
  contextual: ((update: unknown) => void) | undefined,
  fallback: unknown,
): unknown {
  if (typeof fallback !== "function") return contextual;
  if (!contextual) return fallback;
  const fallbackCallback = fallback as (update: unknown) => void;
  return (update: unknown) => {
    contextual(update);
    fallbackCallback(update);
  };
}

function extractAgentIdResult(result: PiToolResultLike): PiSubagentsSpawnResult {
  const details = result.details;
  if (typeof details === "object" && details !== null) {
    const agentId =
      (details as { agentId?: unknown; agent_id?: unknown; id?: unknown }).agentId ??
      (details as { agentId?: unknown; agent_id?: unknown; id?: unknown }).agent_id ??
      (details as { agentId?: unknown; agent_id?: unknown; id?: unknown }).id;
    if (typeof agentId === "string" && agentId.trim()) {
      return { agent_id: agentId };
    }
  }
  const text = toolResultToText(result);
  const match = text.match(/^Agent ID:\s*(\S+)/m);
  if (match) return { agent_id: match[1] };
  return text;
}

function toolResultToText(result: PiToolResultLike): string {
  return (result.content ?? [])
    .filter((content) => content.type === "text" && content.text)
    .map((content) => content.text!)
    .join("");
}
