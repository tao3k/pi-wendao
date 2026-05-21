import { createHash } from "node:crypto";
import type { PiWendaoConfig, PiWendaoAgentRequest } from "./agent-host.js";
import type { PiSubagentsHostOptions } from "./pi-subagents-host.js";

const PI_WENDAO_OUTPUT_ONLY_SUBAGENT = "pi-wendao-output-only";
const PI_WENDAO_OUTPUT_WRITER_SUBAGENT = "pi-wendao-output-writer";
const PI_WENDAO_READ_ONLY_SUBAGENT = "pi-wendao-readonly";
const PI_WENDAO_READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function resolveSubagentType(
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

export function buildRunKey(request: PiWendaoAgentRequest): string | undefined {
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