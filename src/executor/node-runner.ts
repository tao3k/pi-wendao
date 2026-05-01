import type { Model } from "@mariozechner/pi-ai";
import { resolve, sep } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { createPiWendaoToolRegistry } from "../tools/registry.js";
import {
  buildPiWendaoAgentPrompt,
  EMPTY_PI_WENDAO_CONFIG,
  extractOutputVariablesFromText,
  type PiWendaoAgentHost,
  type PiWendaoAgentRequest,
  type PiWendaoConfig,
  type PiWendaoToolScope,
} from "./agent-host.js";
import type {
  PiWendaoAgentMessage,
  PiWendaoAgentTool,
  PiWendaoThinkingLevel,
} from "./agent-runtime-types.js";
import {
  isPiWendaoAgentMessage,
  toPiWendaoAgentEvent,
  type PiWendaoAgentEvent,
} from "./agent-runtime-types.js";
import { WorkflowInterruptedError, throwIfWorkflowInterrupted } from "./interrupt.js";

export interface NodeRunnerOptions {
  model: Model<string>;
  apiKey?: string;
  cwd?: string;
  extraTools?: PiWendaoAgentTool<any>[];
  onEvent?: (event: PiWendaoAgentEvent) => void;
  thinkingLevel?: PiWendaoThinkingLevel;
  signal?: AbortSignal;
  /** Lookup function to get the pi-wendao config for an activity by ID */
  getConfig?: (activityId: string) => PiWendaoConfig | undefined;
}

/**
 * BPMN host service function signature.
 * Originally wired as `environment.services.runAgent`.
 *
 * `executionContext` is the BPMN host execution scope for the activity.
 * `callback(err, result)` completes the service task.
 */
export function createRunAgentService(options: NodeRunnerOptions) {
  const host = createPiAiHost(options);
  return async function runAgent(
    executionContext: Record<string, unknown>,
    callback: (err: Error | null, result?: Record<string, unknown>) => void,
  ) {
    const content = executionContext.content as Record<string, unknown>;
    const environment = executionContext.environment as {
      variables: Record<string, unknown>;
      output: Record<string, unknown>;
    };

    // Get pi-wendao config for this activity
    const activityId = content.id as string;
    const config = options.getConfig?.(activityId) ?? EMPTY_PI_WENDAO_CONFIG;

    try {
      const outputVars = await host.run({
        activityId,
        config,
        variables: environment.variables,
      });

      // Write outputs to workflow environment variables
      for (const [key, value] of Object.entries(outputVars)) {
        environment.variables[key] = value;
      }

      // Also set in output for downstream access
      environment.output[content.id as string] = outputVars;

      callback(null, outputVars);
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  };
}

export function createPiAiHost(options: NodeRunnerOptions): PiWendaoAgentHost {
  return {
    run: (request) => runPiAiTask(options, request),
  };
}

async function runPiAiTask(
  options: NodeRunnerOptions,
  request: PiWendaoAgentRequest,
): Promise<Record<string, unknown>> {
  throwIfWorkflowInterrupted(options.signal);
  const cwd = options.cwd ?? process.cwd();
  const toolRegistry = createPiWendaoToolRegistry(cwd, options.extraTools);
  let toolScopeViolation: Error | undefined;

  const tools: PiWendaoAgentTool<any>[] = request.config.tools
    .map((name) => toolRegistry.get(name))
    .map((tool) =>
      tool
        ? applyToolScope(tool, request.config.toolScopes ?? [], cwd, request.activityId, (error) => {
            toolScopeViolation = error;
          })
        : tool,
    )
    .filter((t): t is PiWendaoAgentTool<any> => t !== undefined);

  const systemPrompt = buildPiWendaoAgentPrompt(request.config, request.variables, {
    ...request.execution,
    activityId: request.activityId,
  });

  const messages = await runPiAiToolLoop({
    model: options.model,
    apiKey: options.apiKey,
    systemPrompt,
    tools,
    thinkingLevel: options.thinkingLevel ?? "medium",
    cwd,
    onEvent: options.onEvent,
    signal: options.signal,
    getToolScopeViolation: () => toolScopeViolation,
  });

  return extractOutputVariables(messages, request.config.outputs);
}

function applyToolScope<T extends PiWendaoAgentTool<any>>(
  tool: T,
  scopes: PiWendaoToolScope[],
  cwd: string,
  activityId: string,
  onViolation: (error: Error) => void,
): T {
  const toolScopes = scopes.filter((scope) => scope.tool === tool.name);
  if (toolScopes.length === 0) return tool;
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const violation = getToolParamsScopeViolation(tool.name, params, toolScopes, cwd, activityId);
      if (violation) {
        onViolation(violation);
        throw violation;
      }
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}

function getToolParamsScopeViolation(
  toolName: string,
  params: unknown,
  scopes: PiWendaoToolScope[],
  cwd: string,
  activityId: string,
): Error | undefined {
  const record = isRecord(params) ? params : {};
  const accepted = scopes.some((scope) => toolParamsMatchScope(toolName, record, scope, cwd));
  if (accepted) return undefined;
  return new Error(
    `Tool call for ${activityId} violates the native tool scope for '${toolName}'. Params: ${JSON.stringify(record)}`,
  );
}

function toolParamsMatchScope(
  toolName: string,
  params: Record<string, unknown>,
  scope: PiWendaoToolScope,
  cwd: string,
): boolean {
  if (toolName === "bash") return bashParamsMatchScope(params, scope);
  if (["read", "ls", "grep", "find", "write", "edit"].includes(toolName)) {
    return pathParamsMatchScope(toolName, params, scope, cwd);
  }
  return true;
}

function bashParamsMatchScope(params: Record<string, unknown>, scope: PiWendaoToolScope): boolean {
  if (!scope.command || params.command !== scope.command) return false;
  if (scope.timeoutSeconds !== undefined) {
    return typeof params.timeout === "number" && params.timeout <= scope.timeoutSeconds;
  }
  return true;
}

function pathParamsMatchScope(
  toolName: string,
  params: Record<string, unknown>,
  scope: PiWendaoToolScope,
  cwd: string,
): boolean {
  if (!scope.path) return false;
  const rawPath =
    typeof params.path === "string" && params.path.trim()
      ? params.path
      : toolName === "ls" || toolName === "grep" || toolName === "find"
        ? "."
        : "";
  if (!rawPath) return false;
  return pathWithinScope(rawPath, scope.path, cwd);
}

function pathWithinScope(rawPath: string, rawScope: string, cwd: string): boolean {
  const target = resolve(cwd, rawPath);
  const scopePrefix = resolve(cwd, prefixBeforeWildcard(rawScope));
  return target === scopePrefix || target.startsWith(`${scopePrefix}${sep}`);
}

function prefixBeforeWildcard(value: string): string {
  const wildcardIndex = value.search(/[*?\[]/);
  if (wildcardIndex === -1) return value;
  const prefix = value.slice(0, wildcardIndex);
  const slash = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
  return slash === -1 ? "." : prefix.slice(0, slash) || ".";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runPiAiToolLoop(options: {
  model: Model<string>;
  apiKey?: string;
  systemPrompt: string;
  tools: PiWendaoAgentTool<any>[];
  thinkingLevel: PiWendaoThinkingLevel;
  cwd: string;
  onEvent?: (event: PiWendaoAgentEvent) => void;
  signal?: AbortSignal;
  getToolScopeViolation?: () => Error | undefined;
}): Promise<PiWendaoAgentMessage[]> {
  throwIfWorkflowInterrupted(options.signal);
  const customTools = options.tools.map(toPiCodingAgentTool);
  const services = await createAgentSessionServices({
    cwd: options.cwd,
    resourceLoaderOptions: {
      systemPrompt: options.systemPrompt,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  });
  if (options.apiKey) {
    services.authStorage.setRuntimeApiKey(options.model.provider, options.apiKey);
  }
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(options.cwd),
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    customTools,
    tools: customTools.map((tool) => tool.name),
  });
  const unsubscribe = session.subscribe((event) => {
    const piWendaoEvent = toPiWendaoAgentEvent(event);
    if (piWendaoEvent) options.onEvent?.(piWendaoEvent);
    if (options.getToolScopeViolation?.() && event.type === "tool_execution_end") {
      void session.abort();
    }
  });
  const abort = () => {
    void session.abort();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    try {
      await session.prompt("Execute the task described in your instructions.", {
        expandPromptTemplates: false,
        source: "extension",
      });
    } catch (error) {
      const violation = options.getToolScopeViolation?.();
      if (violation) throw violation;
      throw error;
    }
    const violation = options.getToolScopeViolation?.();
    if (violation) throw violation;
    throwIfWorkflowInterrupted(options.signal);
    const messages = session.messages.filter(isPiWendaoAgentMessage);
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") {
      if (options.signal?.aborted) throw new WorkflowInterruptedError();
      throw new Error(lastAssistant.errorMessage ?? `model stopped: ${lastAssistant.stopReason}`);
    }
    return messages;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
  }
}

function toPiCodingAgentTool(tool: PiWendaoAgentTool<any>): ToolDefinition {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const result = await tool.execute(
        toolCallId,
        params,
        signal,
        onUpdate
          ? (partialResult) =>
              onUpdate({
                content: partialResult.content,
                details: partialResult.details,
              })
          : undefined,
      );
      return {
        content: result.content,
        details: result.details,
      };
    },
  } as ToolDefinition;
}

/**
 * Extract output variables from the agent's message history.
 * Looks for a JSON code block in the last assistant message.
 */
function extractOutputVariables(
  messages: PiWendaoAgentMessage[],
  outputNames: string[],
): Record<string, unknown> {
  if (outputNames.length === 0) return {};

  // Find the last assistant message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;

    const textContent = msg.content
      .filter((c: { type: string; text?: string }) => c.type === "text" && c.text)
      .map((c: { type: string; text?: string }) => c.text!)
      .join("");

    const outputVars = extractOutputVariablesFromText(textContent, outputNames);
    if (Object.keys(outputVars).length > 0) return outputVars;

    break;
  }

  return {};
}
