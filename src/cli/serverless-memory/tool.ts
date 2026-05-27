import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE } from "./types.js";

export const WENDAO_MEMORY_RECALL_TOOL_NAME = "wendao_memory_recall";

export interface RegisterServerlessMemoryRecallToolOptions {
  cwd: string;
  command?: string;
  runner?: ServerlessMemoryRecallCommandRunner;
}

export interface ServerlessMemoryRecallCommandRunnerInput {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
}

export interface ServerlessMemoryRecallCommandRunnerOutput {
  stdout: string;
  stderr: string;
}

export type ServerlessMemoryRecallCommandRunner = (
  input: ServerlessMemoryRecallCommandRunnerInput,
) => Promise<ServerlessMemoryRecallCommandRunnerOutput>;

interface MemoryRecallToolParams {
  query?: unknown;
  limit?: unknown;
  cached?: unknown;
  includeDone?: unknown;
  includeArchived?: unknown;
}

interface MemoryRecallToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

export function registerServerlessMemoryRecallTool(
  pi: Pick<ExtensionAPI, "registerTool">,
  options: RegisterServerlessMemoryRecallToolOptions,
): void {
  if (typeof pi.registerTool !== "function") return;
  pi.registerTool({
    name: WENDAO_MEMORY_RECALL_TOOL_NAME,
    label: "Wendao Memory Recall",
    description:
      "Recall Org-native Wendao memory from the local Rust read-model when prior project context may affect the answer.",
    promptSnippet:
      "Use wendao_memory_recall when you need prior project memory, corrections, preferences, or reusable evidence before answering.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Natural-language memory query. Use the current task, package, error, preference, or entity name.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Maximum recall rows to return. Defaults to 5.",
          minimum: 1,
          maximum: 8,
        }),
      ),
      cached: Type.Optional(
        Type.Boolean({
          description:
            "Use the existing Wendao Org read-model snapshot first. Defaults to true and falls back to refresh on failure.",
        }),
      ),
      includeDone: Type.Optional(
        Type.Boolean({
          description: "Include completed Org memory rows. Defaults to true.",
        }),
      ),
      includeArchived: Type.Optional(
        Type.Boolean({
          description: "Include archived Org memory rows. Defaults to true.",
        }),
      ),
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      return executeServerlessMemoryRecallTool({
        toolCallId,
        params,
        signal,
        cwd: options.cwd,
        command: options.command ?? "wendao-client",
        runner: options.runner ?? runCommand,
      });
    },
  });
}

async function executeServerlessMemoryRecallTool(input: {
  toolCallId: string;
  params: MemoryRecallToolParams;
  signal?: AbortSignal;
  cwd: string;
  command: string;
  runner: ServerlessMemoryRecallCommandRunner;
}): Promise<MemoryRecallToolResult> {
  const request = normalizeMemoryRecallParams(input.params);
  const firstArgs = buildWendaoMemoryRecallArgs(request, request.cached);
  let commandOutput: ServerlessMemoryRecallCommandRunnerOutput;
  let cacheMode = request.cached ? "cached" : "refreshed";
  let fallbackReason: string | undefined;
  try {
    commandOutput = await input.runner({
      command: input.command,
      args: firstArgs,
      cwd: input.cwd,
      signal: input.signal,
    });
  } catch (error) {
    if (!request.cached) throw error;
    fallbackReason = error instanceof Error ? error.message : String(error);
    cacheMode = "refreshed";
    commandOutput = await input.runner({
      command: input.command,
      args: buildWendaoMemoryRecallArgs(request, false),
      cwd: input.cwd,
      signal: input.signal,
    });
  }

  const content = commandOutput.stdout.trimEnd();
  return {
    content: [{ type: "text", text: content }],
    details: {
      customType: PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE,
      toolCallId: input.toolCallId,
      query: request.query,
      cacheMode,
      ...(fallbackReason ? { fallbackReason } : {}),
      command: input.command,
      args: buildWendaoMemoryRecallArgs(request, cacheMode === "cached"),
      outputFormat: "text",
    },
  };
}

function normalizeMemoryRecallParams(params: MemoryRecallToolParams): {
  query: string;
  limit: number;
  cached: boolean;
  includeDone: boolean;
  includeArchived: boolean;
} {
  return {
    query: typeof params.query === "string" ? params.query.trim() : "",
    limit: clampInteger(params.limit, 5, 1, 8),
    cached: params.cached === undefined ? true : params.cached === true,
    includeDone: params.includeDone === undefined ? true : params.includeDone === true,
    includeArchived: params.includeArchived === undefined ? true : params.includeArchived === true,
  };
}

function buildWendaoMemoryRecallArgs(
  request: ReturnType<typeof normalizeMemoryRecallParams>,
  cached: boolean,
): string[] {
  const args = ["orgize", "task-list"];
  if (cached) args.push("--cached");
  if (request.includeDone) args.push("--include-done");
  if (request.includeArchived) args.push("--include-archived");
  if (request.query) args.push("--text", request.query);
  args.push("--limit", String(request.limit));
  return args;
}

async function runCommand(
  input: ServerlessMemoryRecallCommandRunnerInput,
): Promise<ServerlessMemoryRecallCommandRunnerOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: process.env,
      signal: input.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `wendao memory recall command failed with ${signal ? `signal ${signal}` : `code ${code}`}: ${stderr.trim()}`,
        ),
      );
    });
  });
}

function clampInteger(value: unknown, defaultValue: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
