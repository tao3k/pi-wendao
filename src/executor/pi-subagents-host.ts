import type {
  ActivityId,
  AgentId,
  InstanceId,
  NodeIndex,
  RunRecordKey,
  TokenId,
} from "../types/domain.js";
import {
  buildPiWendaoAgentPrompt,
  extractOutputVariablesFromText,
  type PiWendaoConfig,
  type PiWendaoAgentHost,
  type PiWendaoAgentRequest,
} from "./agent-host.js";
import { validateOutputSchemas } from "./human-task.js";
import { buildRunKey, resolveSubagentType } from "./pi-subagents-routing.js";
import { throwIfWorkflowInterrupted, waitForWorkflowInterrupt } from "./interrupt.js";

export interface PiSubagentsSpawnRequest {
  prompt: string;
  description: string;
  subagent_type: string;
  run_in_background: boolean;
  model?: string;
  thinking?: string;
  max_turns?: number;
  isolated?: boolean;
  isolation?: string;
  inherit_context?: boolean;
}

export type PiSubagentsSpawnResult =
  | string
  | {
      agent_id?: string;
      agentId?: string;
      id?: string;
    };

export interface PiSubagentsGetResultRequest {
  agent_id: string;
  wait: boolean;
  verbose?: boolean;
}

export interface PiSubagentsClient {
  spawn(
    request: PiSubagentsSpawnRequest,
    callbacks?: PiSubagentsClientCallbacks,
  ): Promise<PiSubagentsSpawnResult>;
  getResult(
    request: PiSubagentsGetResultRequest,
    callbacks?: PiSubagentsClientCallbacks,
  ): Promise<unknown>;
}

export interface PiSubagentsClientCallbacks {
  activityId: string;
  description: string;
  agentId?: string;
  onUpdate?: (update: unknown) => void;
}

export interface PiSubagentsRunRecord {
  key: RunRecordKey;
  agentId: AgentId;
  activityId: ActivityId;
  instanceId?: InstanceId;
  tokenId?: TokenId;
  nodeIndex?: NodeIndex;
  status: "spawned" | "completed" | "failed";
  spawnRequest: PiSubagentsSpawnRequest;
  output?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PiSubagentsRunStore {
  get(key: string): Promise<PiSubagentsRunRecord | undefined>;
  put(record: PiSubagentsRunRecord): Promise<void>;
}

export type PiSubagentsHostEvent =
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

export interface PiSubagentsHostUpdateEvent {
  type: "update";
  activityId: string;
  agentId?: string;
  description: string;
  update: unknown;
}

export type PiSubagentsHostToolEvent =
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

export interface PiSubagentsToolSurface {
  Agent?: (request: PiSubagentsSpawnRequest) => Promise<PiSubagentsSpawnResult>;
  get_subagent_result?: (request: PiSubagentsGetResultRequest) => Promise<unknown>;
}

export interface PiSubagentsHostOptions {
  client: PiSubagentsClient;
  defaultSubagentType?: string;
  defaultRunInBackground?: boolean;
  verboseResult?: boolean;
  runStore?: PiSubagentsRunStore;
  onEvent?: (event: PiSubagentsHostEvent) => void;
  onUpdate?: (event: PiSubagentsHostUpdateEvent) => void;
  onToolEvent?: (event: PiSubagentsHostToolEvent) => void;
}

export function createPiSubagentsClientFromTools(tools: PiSubagentsToolSurface): PiSubagentsClient {
  if (!tools.Agent || !tools.get_subagent_result) {
    throw new Error("pi-subagents tools Agent and get_subagent_result are required");
  }
  return {
    spawn: (request) => tools.Agent!(request),
    getResult: (request) => tools.get_subagent_result!(request),
  };
}

export { createInMemoryPiSubagentsRunStore, createJsonFilePiSubagentsRunStore } from "./pi-subagents-run-store.js";
export function createPiSubagentsHost(options: PiSubagentsHostOptions): PiWendaoAgentHost {
  return {
    run: async (request) => runPiSubagentTask(options, request),
  };
}

async function runPiSubagentTask(
  options: PiSubagentsHostOptions,
  request: PiWendaoAgentRequest,
): Promise<Record<string, unknown>> {
  throwIfWorkflowInterrupted(request.signal);
  const config = request.config;
  const key = buildRunKey(request);
  const stored = key && options.runStore ? await options.runStore.get(key) : undefined;
  throwIfWorkflowInterrupted(request.signal);
  const reusableOutput = reusableCompletedOutput(stored, config, request.activityId);
  if (reusableOutput) return reusableOutput;
  const reusableStored = stored?.status === "spawned" ? stored : undefined;
  const spawnRequest = reusableStored?.spawnRequest ?? buildSpawnRequest(options, request);
  const agentId =
    reusableStored?.agentId ??
    (await runInterruptible(
      spawnAndStoreSubagent(options, request, key, spawnRequest, {
        activityId: request.activityId,
        description: spawnRequest.description,
        onUpdate: (update) => emitHostUpdate(options, request, spawnRequest, undefined, update),
      }),
      request.signal,
    ));
  throwIfWorkflowInterrupted(request.signal);
  emitHostEvent(options, {
    type: reusableStored ? "resumed" : "spawned",
    activityId: request.activityId,
    agentId,
    description: spawnRequest.description,
  });
  emitHostEvent(options, {
    type: "waiting",
    activityId: request.activityId,
    agentId,
    description: spawnRequest.description,
  });
  const result = await runInterruptible(
    options.client.getResult(
      {
        agent_id: agentId,
        wait: true,
        ...(options.verboseResult === undefined && !options.onEvent
          ? {}
          : { verbose: options.verboseResult ?? true }),
      },
      {
        activityId: request.activityId,
        description: spawnRequest.description,
        agentId,
        onUpdate: (update) => emitHostUpdate(options, request, spawnRequest, agentId, update),
      },
    ),
    request.signal,
  );
  throwIfWorkflowInterrupted(request.signal);
  const resultText = resultToText(result);
  emitHostEvent(options, {
    type: "result",
    activityId: request.activityId,
    agentId,
    description: spawnRequest.description,
    resultText,
  });
  const agentError = extractPiSubagentError(resultText);
  if (agentError) {
    await storeFailedRun(options, request, key, agentId, spawnRequest, stored, agentError);
    throw new Error(
      `pi-subagents agent ${agentId} failed for ${request.activityId}: ${agentError}`,
    );
  }
  const output = extractOutputVariablesFromText(resultText, config.outputs);
  const missingOutputs = missingRequiredOutputs(output, config.outputs);
  if (missingOutputs.length > 0) {
    const message = `pi-subagents agent ${agentId} did not produce required output(s) for ${request.activityId}: ${missingOutputs.join(", ")}. Result: ${summarizeResultText(resultText)}`;
    await storeFailedRun(options, request, key, agentId, spawnRequest, stored, message);
    throw new Error(message);
  }
  let validatedOutput: Record<string, unknown>;
  try {
    validatedOutput = validateOutputSchemas(config, output, {
      activityId: request.activityId,
    });
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    await storeFailedRun(options, request, key, agentId, spawnRequest, stored, error.message);
    throw error;
  }
  if (key && options.runStore) {
    const now = new Date().toISOString();
    await options.runStore.put({
      key,
      agentId,
      activityId: request.activityId,
      instanceId: request.execution?.instanceId,
      tokenId: request.execution?.tokenId,
      nodeIndex: request.execution?.nodeIndex,
      status: "completed",
      spawnRequest,
      output: validatedOutput,
      createdAt: stored?.createdAt ?? now,
      updatedAt: now,
    });
  }
  return validatedOutput;
}

function runInterruptible<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  return signal ? Promise.race([operation, waitForWorkflowInterrupt(signal)]) : operation;
}

function emitHostEvent(options: PiSubagentsHostOptions, event: PiSubagentsHostEvent): void {
  options.onEvent?.(event);
}

function emitHostUpdate(
  options: PiSubagentsHostOptions,
  request: PiWendaoAgentRequest,
  spawnRequest: PiSubagentsSpawnRequest,
  agentId: string | undefined,
  update: unknown,
): void {
  options.onUpdate?.({
    type: "update",
    activityId: request.activityId,
    ...(agentId ? { agentId } : {}),
    description: spawnRequest.description,
    update,
  });
}

async function storeFailedRun(
  options: PiSubagentsHostOptions,
  request: PiWendaoAgentRequest,
  key: string | undefined,
  agentId: string,
  spawnRequest: PiSubagentsSpawnRequest,
  stored: PiSubagentsRunRecord | undefined,
  error: string,
): Promise<void> {
  if (!key || !options.runStore) return;
  const now = new Date().toISOString();
  await options.runStore.put({
    key,
    agentId,
    activityId: request.activityId,
    instanceId: request.execution?.instanceId,
    tokenId: request.execution?.tokenId,
    nodeIndex: request.execution?.nodeIndex,
    status: "failed",
    spawnRequest,
    error,
    createdAt: stored?.createdAt ?? now,
    updatedAt: now,
  });
}

async function spawnAndStoreSubagent(
  options: PiSubagentsHostOptions,
  request: PiWendaoAgentRequest,
  key: string | undefined,
  spawnRequest: PiSubagentsSpawnRequest,
  callbacks: PiSubagentsClientCallbacks,
): Promise<string> {
  const spawnResult = await options.client.spawn(spawnRequest, callbacks);
  const agentId = parseAgentId(spawnResult);
  if (key && options.runStore) {
    const now = new Date().toISOString();
    await options.runStore.put({
      key,
      agentId,
      activityId: request.activityId,
      instanceId: request.execution?.instanceId,
      tokenId: request.execution?.tokenId,
      nodeIndex: request.execution?.nodeIndex,
      status: "spawned",
      spawnRequest,
      createdAt: now,
      updatedAt: now,
    });
  }
  return agentId;
}

function buildSpawnRequest(
  options: PiSubagentsHostOptions,
  request: PiWendaoAgentRequest,
): PiSubagentsSpawnRequest {
  const subagent = request.config.subagent;
  return {
    prompt: buildPiWendaoAgentPrompt(request.config, request.variables, {
      ...request.execution,
      activityId: request.activityId,
    }),
    description: subagent?.description ?? `Run BPMN service task ${request.activityId}`,
    subagent_type: resolveSubagentType(options, request.config),
    run_in_background: subagent?.runInBackground ?? options.defaultRunInBackground ?? true,
    ...(subagent?.model ? { model: subagent.model } : {}),
    ...(subagent?.thinking ? { thinking: subagent.thinking } : {}),
    ...(subagent?.maxTurns !== undefined ? { max_turns: subagent.maxTurns } : {}),
    ...(subagent?.isolated !== undefined ? { isolated: subagent.isolated } : {}),
    ...(subagent?.isolation ? { isolation: subagent.isolation } : {}),
    ...(subagent?.inheritContext !== undefined ? { inherit_context: subagent.inheritContext } : {}),
  };
}

function parseAgentId(result: PiSubagentsSpawnResult): string {
  if (typeof result === "string" && result.trim()) {
    const match = result.match(/^Agent ID:\s*(\S+)/m);
    return match?.[1] ?? result;
  }
  if (typeof result === "object" && result !== null) {
    const id = result.agent_id ?? result.agentId ?? result.id;
    if (typeof id === "string" && id.trim()) return id;
  }
  throw new Error("pi-subagents spawn did not return an agent id");
}

function resultToText(result: unknown): string {
  if (typeof result === "string") return result;
  if (typeof result !== "object" || result === null) return String(result);
  const record = result as Record<string, unknown>;
  for (const key of ["result", "output", "text", "message", "content"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  if (Array.isArray(record.content)) {
    return record.content
      .map((content) => {
        if (typeof content !== "object" || content === null) return "";
        const text = (content as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return JSON.stringify(result);
}

function hasRequiredOutputs(output: Record<string, unknown>, outputNames: string[]): boolean {
  return missingRequiredOutputs(output, outputNames).length === 0;
}

function reusableCompletedOutput(
  stored: PiSubagentsRunRecord | undefined,
  config: PiWendaoConfig,
  activityId: string,
): Record<string, unknown> | undefined {
  if (stored?.status !== "completed" || !stored.output) return undefined;
  if (!hasRequiredOutputs(stored.output, config.outputs)) return undefined;
  try {
    return validateOutputSchemas(config, stored.output, { activityId });
  } catch {
    return undefined;
  }
}

function missingRequiredOutputs(output: Record<string, unknown>, outputNames: string[]): string[] {
  return outputNames.filter((name) => !Object.prototype.hasOwnProperty.call(output, name));
}

function extractPiSubagentError(resultText: string): string | undefined {
  const statusMatch = resultText.match(/\bStatus:\s*error\b/i);
  if (!statusMatch) return undefined;
  const errorMatch = resultText.match(/^Error:\s*(.+(?:\n(?!--- Agent Conversation ---).*)*)/m);
  return summarizeResultText(errorMatch?.[1] ?? resultText);
}

function summarizeResultText(resultText: string): string {
  const compact = resultText.replace(/\s+/g, " ").trim();
  if (compact.length <= 500) return compact;
  return `${compact.slice(0, 497)}...`;
}
