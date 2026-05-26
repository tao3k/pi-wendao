import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const NATIVE_SUBAGENT_FD_TOOL_NAME = "fd";
export const NATIVE_SUBAGENT_RG_TOOL_NAME = "rg";
export const NATIVE_SUBAGENT_FILE_TOOL_NAMES = [
  NATIVE_SUBAGENT_FD_TOOL_NAME,
  NATIVE_SUBAGENT_RG_TOOL_NAME,
] as const;

export interface RegisterNativeSubagentFileToolsOptions {
  cwd: string;
  runner?: NativeSubagentCommandRunner;
}

export interface NativeSubagentCommandRunnerInput {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  noMatchExitCodes?: number[];
}

export interface NativeSubagentCommandRunnerOutput {
  stdout: string;
  stderr: string;
}

export type NativeSubagentCommandRunner = (
  input: NativeSubagentCommandRunnerInput,
) => Promise<NativeSubagentCommandRunnerOutput>;

interface FileToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

export function registerNativeSubagentFileTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  options: RegisterNativeSubagentFileToolsOptions,
): void {
  if (typeof pi.registerTool !== "function") return;
  const runner = options.runner ?? runCommand;
  pi.registerTool({
    name: NATIVE_SUBAGENT_FD_TOOL_NAME,
    label: "fd",
    description:
      "Find workspace files by path pattern using fd. Use this for file candidates, not for reading file contents.",
    promptSnippet:
      "Use fd to list likely workspace files before using rg or Wendao structured search.",
    parameters: Type.Object({
      pattern: Type.Optional(Type.String({ description: "fd pattern. Defaults to all files." })),
      path: Type.Optional(Type.String({ description: "Relative search root. Defaults to the workspace root." })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    }),
    executionMode: "sequential",
    execute: (_toolCallId, params, signal) =>
      executeFileTool({
        toolName: NATIVE_SUBAGENT_FD_TOOL_NAME,
        command: "fd",
        args: buildFdArgs(params as Record<string, unknown>),
        cwd: options.cwd,
        runner,
        signal,
        limit: normalizeLimit((params as { limit?: unknown }).limit, 80, 1, 200),
      }),
  });
  pi.registerTool({
    name: NATIVE_SUBAGENT_RG_TOOL_NAME,
    label: "rg",
    description:
      "Search workspace text with ripgrep and return compact line-numbered snippets.",
    promptSnippet:
      "Use rg for text snippets after fd has narrowed likely files, then use Wendao tools for structured evidence.",
    parameters: Type.Object({
      query: Type.String({ description: "ripgrep search text or regex." }),
      path: Type.Optional(Type.String({ description: "Relative search root. Defaults to the workspace root." })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    }),
    executionMode: "sequential",
    execute: (_toolCallId, params, signal) =>
      executeFileTool({
        toolName: NATIVE_SUBAGENT_RG_TOOL_NAME,
        command: "rg",
        args: buildRgArgs(params as Record<string, unknown>),
        cwd: options.cwd,
        runner,
        signal,
        noMatchExitCodes: [1],
        limit: normalizeLimit((params as { limit?: unknown }).limit, 80, 1, 200),
      }),
  });
}

async function executeFileTool(input: {
  toolName: string;
  command: string;
  args: string[];
  cwd: string;
  runner: NativeSubagentCommandRunner;
  signal?: AbortSignal;
  noMatchExitCodes?: number[];
  limit: number;
}): Promise<FileToolResult> {
  try {
    const output = await input.runner({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      signal: input.signal,
      noMatchExitCodes: input.noMatchExitCodes,
    });
    const lines = output.stdout.split(/\r?\n/).filter(Boolean).slice(0, input.limit);
    return {
      content: [
        {
          type: "text",
          text: lines.length > 0 ? lines.join("\n") : `${input.toolName}: no matches`,
        },
      ],
      details: {
        customType: input.toolName,
        command: input.command,
        args: input.args,
        rowCount: lines.length,
      },
    };
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    return {
      content: [{ type: "text", text: `${input.toolName} failed: ${error.message}` }],
      details: { customType: input.toolName, error: error.message },
      isError: true,
    };
  }
}

function buildFdArgs(params: Record<string, unknown>): string[] {
  return [
    "--color",
    "never",
    "--strip-cwd-prefix",
    "--exclude",
    ".git",
    "--exclude",
    "node_modules",
    optionalString(params.pattern) ?? ".",
    optionalString(params.path) ?? ".",
  ];
}

function buildRgArgs(params: Record<string, unknown>): string[] {
  const query = optionalString(params.query);
  if (!query) throw new Error("rg requires a non-empty query");
  return [
    "--line-number",
    "--color",
    "never",
    "--hidden",
    "--glob",
    "!.git/**",
    "--glob",
    "!node_modules/**",
    query,
    optionalString(params.path) ?? ".",
  ];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeLimit(value: unknown, defaultValue: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

async function runCommand(
  input: NativeSubagentCommandRunnerInput,
): Promise<NativeSubagentCommandRunnerOutput> {
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
      if (code === 0 || (code !== null && input.noMatchExitCodes?.includes(code))) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${input.command} failed with ${signal ? `signal ${signal}` : `code ${code}`}: ${stderr.trim()}`,
        ),
      );
    });
  });
}
