import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  buildPiWendaoAgentPrompt,
  extractOutputVariablesFromText,
  type PiWendaoConfig,
  type PiWendaoAgentHost,
  type PiWendaoAgentRequest,
} from "./agent-host.js";
import { validateOutputSchemas } from "./human-task.js";
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
  key: string;
  agentId: string;
  activityId: string;
  instanceId?: string;
  tokenId?: number;
  nodeIndex?: number;
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

const PI_WENDAO_OUTPUT_ONLY_SUBAGENT = "pi-wendao-output-only";
const PI_WENDAO_OUTPUT_WRITER_SUBAGENT = "pi-wendao-output-writer";
const PI_WENDAO_READ_ONLY_SUBAGENT = "pi-wendao-readonly";
const PI_WENDAO_READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function createPiSubagentsClientFromTools(tools: PiSubagentsToolSurface): PiSubagentsClient {
  if (!tools.Agent || !tools.get_subagent_result) {
    throw new Error("pi-subagents tools Agent and get_subagent_result are required");
  }
  return {
    spawn: (request) => tools.Agent!(request),
    getResult: (request) => tools.get_subagent_result!(request),
  };
}

export function createInMemoryPiSubagentsRunStore(
  initialRecords: PiSubagentsRunRecord[] = [],
): PiSubagentsRunStore {
  const records = new Map(initialRecords.map((record) => [record.key, record]));
  return {
    async get(key) {
      return records.get(key);
    },
    async put(record) {
      records.set(record.key, record);
    },
  };
}

export function createJsonFilePiSubagentsRunStore(path: string): PiSubagentsRunStore {
  let queue = Promise.resolve();
  const withLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return {
    get: (key) =>
      withLock(async () => {
        const records = await readStoreFile(path);
        return records[key];
      }),
    put: (record) =>
      withLock(async () => {
        const records = await readStoreFile(path);
        records[record.key] = record;
        await writeStoreFile(path, records);
      }),
  };
}

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

function resolveSubagentType(
  options: PiSubagentsHostOptions,
  config: PiWendaoConfig,
): string {
  const tools = normalizedToolNames(config.tools);
  if (tools.length === 0) {
    return PI_WENDAO_OUTPUT_ONLY_SUBAGENT;
  }
  if (isWriteOnlyToolScope(tools)) {
    return PI_WENDAO_OUTPUT_WRITER_SUBAGENT;
  }
  if (isReadOnlyToolScope(tools)) {
    return PI_WENDAO_READ_ONLY_SUBAGENT;
  }

  return (
    normalizedName(config.subagent?.type) ??
    normalizedName(options.defaultSubagentType) ??
    "general-purpose"
  );
}

function normalizedName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizedToolNames(tools: readonly string[]): string[] {
  return Array.from(
    new Set(
      tools
        .map((tool) => tool.trim())
        .filter((tool) => tool.length > 0)
        .map((tool) => tool.toLowerCase()),
    ),
  ).sort();
}

function isWriteOnlyToolScope(tools: readonly string[]): boolean {
  return tools.length === 1 && tools[0] === "write";
}

function isReadOnlyToolScope(tools: readonly string[]): boolean {
  return tools.length > 0 && tools.every((tool) => PI_WENDAO_READ_ONLY_TOOLS.has(tool));
}

function buildRunKey(request: PiWendaoAgentRequest): string | undefined {
  const instanceId = request.execution?.instanceId;
  if (!instanceId) return undefined;
  return JSON.stringify({
    instanceId,
    activityId: request.activityId,
    tokenId: request.execution?.tokenId ?? null,
    contract: buildRunContractFingerprint(request.config),
    inputs: buildRunInputSnapshot(request),
  });
}

function buildRunContractFingerprint(config: PiWendaoConfig): string {
  return createHash("sha256")
    .update(
      stableJson({
        prompt: config.prompt,
        tools: config.tools,
        toolScopes: config.toolScopes ?? [],
        outputs: config.outputs,
        outputSchemas: config.outputSchemas ?? {},
        subagent: config.subagent ?? {},
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function buildRunInputSnapshot(request: PiWendaoAgentRequest): Array<[string, unknown]> {
  const inputNames =
    request.config.inputs.length > 0
      ? request.config.inputs
      : Object.keys(request.variables).sort();
  const seen = new Set<string>();
  const snapshot: Array<[string, unknown]> = [];
  for (const name of inputNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (Object.prototype.hasOwnProperty.call(request.variables, name)) {
      snapshot.push([name, request.variables[name]]);
    }
  }
  return snapshot;
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

interface PiSubagentsRunStoreFile {
  version: 1;
  records: Record<string, PiSubagentsRunRecord>;
}

async function readStoreFile(path: string): Promise<Record<string, PiSubagentsRunRecord>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    if (!isRunStoreFile(parsed)) return {};
    return parsed.records;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeStoreFile(
  path: string,
  records: Record<string, PiSubagentsRunRecord>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const file: PiSubagentsRunStoreFile = { version: 1, records };
  await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  await rename(tempPath, path);
}

function isRunStoreFile(value: unknown): value is PiSubagentsRunStoreFile {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { records?: unknown }).records === "object" &&
    (value as { records?: unknown }).records !== null &&
    !Array.isArray((value as { records?: unknown }).records)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
