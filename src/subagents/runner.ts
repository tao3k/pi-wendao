import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
  createNativeSubagentChildContextExtensionFactories,
  selectNativeSubagentChildContextToolNames,
} from "./child-tools.js";
import type { NativeSubagentRunOptions } from "./protocol.js";

const EXCLUDED_TOOL_NAMES = new Set(["Agent", "get_subagent_result", "steer_subagent"]);

export interface NativeSubagentRunnerInput {
  type: string;
  prompt: string;
  description: string;
  cwd: string;
  modelName?: string;
  thinking?: string;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
}

export interface NativeSubagentRunnerResult {
  responseText: string;
  session: AgentSession;
}

export async function runNativeSubagent(
  input: NativeSubagentRunnerInput,
  options: NativeSubagentRunOptions,
): Promise<NativeSubagentRunnerResult> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(input.cwd, agentDir);
  const childExtensionFactories = createNativeSubagentChildContextExtensionFactories(input);
  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir,
    settingsManager,
    extensionFactories: childExtensionFactories,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: input.inheritContext !== true,
    systemPromptOverride: () => buildNativeSubagentSystemPrompt(input),
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const model = resolveModelOverride(input.modelName, options.modelRegistry) ?? options.model;
  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(input.cwd),
    settingsManager,
    modelRegistry: options.modelRegistry,
    ...(model ? { model } : {}),
    ...(input.thinking ? { thinkingLevel: input.thinking as never } : {}),
    tools: selectNativeSubagentActiveToolNames(input),
    resourceLoader: loader,
  });

  session.setSessionName(`subagent:${input.description}`);
  session.setActiveToolsByName(
    session.getActiveToolNames().filter((toolName) => !EXCLUDED_TOOL_NAMES.has(toolName)),
  );
  options.onSessionCreated?.(session);

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);
  let turnCount = 0;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_end") {
      turnCount += 1;
      options.onTurnEnd?.(turnCount);
      if (input.maxTurns && turnCount >= input.maxTurns) {
        session.abort();
      }
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      collector.append(event.assistantMessageEvent.delta);
      options.onTextDelta?.(event.assistantMessageEvent.delta, collector.getText());
    }
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
  });

  try {
    await session.prompt(input.prompt);
  } finally {
    unsubscribe();
    cleanupAbort();
  }

  return {
    responseText: collector.getText().trim() || getLastAssistantText(session),
    session,
  };
}

function buildNativeSubagentSystemPrompt(input: NativeSubagentRunnerInput): string {
  const toolBoundary =
    input.type === "pi-wendao-output-only"
      ? "Return only the requested result. Do not claim tool work you did not perform."
      : "Use only the tools exposed in this child session. Do not spawn nested subagents.";
  const childContextBoundary =
    selectNativeSubagentChildContextToolNames(input).length > 0
      ? "Use fd for file candidates, rg for text snippets, and Wendao tools for structured evidence. Use intercom only for graph-local planner coordination."
      : "No child context tools are available in this session.";
  return [
    "You are a pi-wendao native subagent.",
    `Subagent type: ${input.type}.`,
    `Task description: ${input.description}.`,
    toolBoundary,
    childContextBoundary,
    "When the task asks for structured output, preserve the exact requested keys and format.",
  ].join("\n");
}

export function selectNativeSubagentActiveToolNames(
  input: Pick<NativeSubagentRunnerInput, "type" | "isolated">,
): string[] {
  return uniqueStrings([
    ...selectOverriddenCoreToolNames(input.type, input.isolated),
    ...selectNativeSubagentChildContextToolNames(input),
  ]);
}

function selectOverriddenCoreToolNames(type: string, isolated: boolean | undefined): string[] {
  if (isolated) return [];
  if (type === "pi-wendao-output-only") return [];
  if (type === "pi-wendao-readonly") return ["read"];
  if (type === "pi-wendao-output-writer") return ["read", "write"];
  return ["read", "bash", "edit", "write"];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function resolveModelOverride(
  value: string | undefined,
  registry: ModelRegistry,
): Model<any> | undefined {
  const modelName = value?.trim();
  if (!modelName) return undefined;
  const slashIndex = modelName.indexOf("/");
  if (slashIndex > 0) {
    const provider = modelName.slice(0, slashIndex);
    const modelId = modelName.slice(slashIndex + 1);
    return registry.find(provider, modelId);
  }
  return registry.getAll().find((model) => model.id.includes(modelName) || model.name.includes(modelName));
}

function collectResponseText(session: AgentSession): {
  append(delta: string): void;
  getText(): string;
} {
  let text = "";
  return {
    append(delta) {
      text += delta;
    },
    getText() {
      return text;
    },
  };
}

function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i];
    if (message.role !== "assistant") continue;
    const text = message.content
      .map((content) => (content.type === "text" ? content.text : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

function forwardAbortSignal(session: AgentSession, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => undefined;
  const onAbort = () => {
    void session.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
