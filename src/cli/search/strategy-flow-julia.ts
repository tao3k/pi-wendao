import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveRustBridgeCommand,
  resolveWendaoGraphProject,
  resolveWendaoRustWorkspace,
} from "./strategy-flow-discovery.js";
import { encodeSearchStrategyFlowBranchJudgementsArrowIpc } from "./strategy-flow-branch-judgement-arrow.js";
import { renderSearchStrategyFlowBranchJudgementTsv } from "./strategy-flow-branch-judgement.js";
import { encodeSearchStrategyFlowQueryUnderstandingArrowIpc } from "./strategy-flow-query-understanding-arrow.js";
import { collectProcessOutput } from "./strategy-flow-process.js";
import { JULIA_STRATEGY_FLOW_SCRIPT } from "./strategy-flow-script.js";
import { parseStrategyFlowTrace } from "./strategy-flow-trace.js";
import type {
  SearchStrategyFlowBackend,
  SearchStrategyFlowOptions,
  SearchStrategyFlowRustBridgeMode,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";

export async function runSearchStrategyFlow(
  options: SearchStrategyFlowOptions,
): Promise<SearchStrategyFlowTrace> {
  return runResolvedStrategyFlow(resolveSearchStrategyFlowContext(options));
}

interface SearchStrategyFlowContext {
  options: SearchStrategyFlowOptions;
  intent: string;
  graphProject: string;
  juliaCommand: string;
  searchBackend: SearchStrategyFlowBackend;
}

interface RustStrategyFlowOptions {
  cargoCommand?: string;
  bridgeBinary?: string;
  rustWorkspace: string;
  graphProject: string;
  intent: string;
  juliaCommand?: string;
  rustBridgeSession?: boolean;
  flightBaseUrl?: string;
  flightTimeoutSeconds?: number;
  strategyFlowServiceBaseUrl?: string;
  strategyFlowServiceTimeoutSeconds?: number;
  queryUnderstandingArrowIpcPath?: string;
  branchJudgementsArrowIpcPath?: string;
}

interface RustStrategyFlowOutput {
  stdout: string;
  bridgeMode: SearchStrategyFlowRustBridgeMode;
}

async function runResolvedStrategyFlow(
  context: SearchStrategyFlowContext,
): Promise<SearchStrategyFlowTrace> {
  if (context.searchBackend === "julia-direct") {
    return runJuliaDirectStrategyFlow(context, false);
  }

  const rustWorkspace = resolveWendaoRustWorkspace(context.options);
  if (!rustWorkspace) return runWithoutRustWorkspace(context);
  return runRustBridgeOrFallback(context, rustWorkspace);
}

function resolveSearchStrategyFlowContext(
  options: SearchStrategyFlowOptions,
): SearchStrategyFlowContext {
  const intent = options.intent.trim();
  if (!intent) throw new Error("--search intent must not be blank");

  const graphProject = resolveWendaoGraphProject(options);
  const juliaCommand = options.juliaCommand ?? process.env.JULIA ?? "julia";
  const searchBackend: SearchStrategyFlowBackend = options.searchBackend ?? "auto";
  return { options, intent, graphProject, juliaCommand, searchBackend };
}

async function runWithoutRustWorkspace(
  context: SearchStrategyFlowContext,
): Promise<SearchStrategyFlowTrace> {
  throw new Error(
    context.searchBackend === "rust-julia"
      ? "could not find xiuxian Rust workspace for SearchStrategyFlow; pass --search-rust-workspace <path>"
      : "could not find xiuxian Rust workspace for SearchStrategyFlow auto mode; pass --search-rust-workspace <path> for the core Rust bridge, or use --search-backend julia-direct only for pi-local bridge smoke tests",
  );
}

async function runRustBridgeOrFallback(
  context: SearchStrategyFlowContext,
  rustWorkspace: string,
): Promise<SearchStrategyFlowTrace> {
  const queryUnderstandingIpcFile = await writeOptionalQueryUnderstandingArrowIpcFile(
    context.options,
  );
  const branchJudgementIpcFile = await writeOptionalBranchJudgementsArrowIpcFile(context.options);
  try {
    return attachSuccessfulRustBridge(
      context,
      rustWorkspace,
      await runRustStrategyFlow({
        cargoCommand: resolveSearchStrategyFlowRustCommandOverride(context.options),
        bridgeBinary:
          context.options.rustBridgeBinary ?? process.env.PI_WENDAO_SEARCH_RUST_BRIDGE_BIN,
        rustWorkspace,
        graphProject: context.graphProject,
        intent: context.intent,
        juliaCommand: context.options.juliaCommand,
        rustBridgeSession: resolveRustBridgeSessionMode(context.options.rustBridgeSession),
        flightBaseUrl:
          context.options.flightBaseUrl ?? process.env.PI_WENDAO_SEARCH_FLIGHT_BASE_URL,
        flightTimeoutSeconds: context.options.flightTimeoutSeconds,
        strategyFlowServiceBaseUrl:
          context.options.strategyFlowServiceBaseUrl ??
          process.env.PI_WENDAO_SEARCH_STRATEGY_FLOW_SERVICE_BASE_URL,
        strategyFlowServiceTimeoutSeconds: context.options.strategyFlowServiceTimeoutSeconds,
        queryUnderstandingArrowIpcPath: queryUnderstandingIpcFile?.path,
        branchJudgementsArrowIpcPath: branchJudgementIpcFile?.path,
      }),
    );
  } catch (error) {
    throw new Error(
      `${summarizeBridgeError(error)}\nSearchStrategyFlow auto mode treats the Rust bridge as the core path. Use --search-backend julia-direct only for pi-local bridge smoke tests.`,
    );
  } finally {
    await queryUnderstandingIpcFile?.cleanup();
    await branchJudgementIpcFile?.cleanup();
  }
}

export function resolveSearchStrategyFlowRustCommandOverride(
  options: Pick<SearchStrategyFlowOptions, "rustCommand">,
): string | undefined {
  return options.rustCommand ?? process.env.PI_WENDAO_SEARCH_RUST_COMMAND;
}

function attachSuccessfulRustBridge(
  context: SearchStrategyFlowContext,
  rustWorkspace: string,
  output: RustStrategyFlowOutput,
): SearchStrategyFlowTrace {
  return {
    ...parseStrategyFlowTrace(output.stdout),
    rustBridge: {
      requestedBackend: context.searchBackend,
      attempted: true,
      rustWorkspace,
      mode: output.bridgeMode,
      fallback: "none",
    },
  };
}

async function runJuliaDirectStrategyFlow(
  context: SearchStrategyFlowContext,
  attemptedRustBridge: boolean,
  rustWorkspace?: string,
  bridgeError?: string,
): Promise<SearchStrategyFlowTrace> {
  const stdout = await runJuliaStrategyFlow(
    context.juliaCommand,
    context.graphProject,
    context.intent,
    context.graphProject,
    renderOptionalBranchJudgementsTsv(context.options),
  );
  return {
    ...parseStrategyFlowTrace(stdout),
    rustBridge: {
      requestedBackend: context.searchBackend,
      attempted: attemptedRustBridge,
      ...(rustWorkspace ? { rustWorkspace } : {}),
      fallback: attemptedRustBridge ? "julia-direct" : "none",
      ...(bridgeError ? { error: bridgeError } : {}),
    },
  };
}

async function runRustStrategyFlow(
  options: RustStrategyFlowOptions,
): Promise<RustStrategyFlowOutput> {
  const command = resolveRustBridgeCommand(
    options.rustWorkspace,
    options.cargoCommand,
    options.bridgeBinary,
  );
  if (options.rustBridgeSession) {
    if (options.strategyFlowServiceBaseUrl) {
      throw new Error(
        "Rust SearchStrategyFlow bridge session cannot be combined with --search-strategy-flow-service-base-url; use process-args control for the production Arrow Flight service path.",
      );
    }
    return runRustStrategyFlowStdioSession(options, command);
  }
  const stdout = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(
      command.command,
      [...command.prefixArgs, ...rustBridgeArgs(options, command.mode)],
      {
        cwd: options.rustWorkspace,
        env: {
          ...process.env,
          WENDAOGRAPH_PACKAGE_DIR: options.graphProject,
          ...(options.juliaCommand ? { JULIA: options.juliaCommand } : {}),
        },
      },
    );
    collectProcessOutput(child, resolveOutput, reject, "Rust SearchStrategyFlow bridge");
  });
  return { stdout, bridgeMode: command.mode };
}

async function runRustStrategyFlowStdioSession(
  options: RustStrategyFlowOptions,
  command: ReturnType<typeof resolveRustBridgeCommand>,
): Promise<RustStrategyFlowOutput> {
  const stdout = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(
      command.command,
      [...command.prefixArgs, ...rustBridgeSessionArgs(options, command.mode)],
      {
        cwd: options.rustWorkspace,
        env: {
          ...process.env,
          WENDAOGRAPH_PACKAGE_DIR: options.graphProject,
          ...(options.juliaCommand ? { JULIA: options.juliaCommand } : {}),
        },
      },
    );
    collectProcessOutput(child, resolveOutput, reject, "Rust SearchStrategyFlow bridge session");
    child.stdin.write(
      `${JSON.stringify({
        requestId: "pi-wendao-search",
        intent: options.intent,
        ...(options.queryUnderstandingArrowIpcPath
          ? { queryUnderstandingArrowIpcPath: options.queryUnderstandingArrowIpcPath }
          : {}),
        ...(options.branchJudgementsArrowIpcPath
          ? { branchJudgementsArrowIpcPath: options.branchJudgementsArrowIpcPath }
          : {}),
      })}\n`,
    );
    child.stdin.end();
  });
  return {
    stdout: parseRustBridgeStdioSessionTrace(stdout),
    bridgeMode: "persistent-stdio",
  };
}

async function runJuliaStrategyFlow(
  juliaCommand: string,
  graphProject: string,
  intent: string,
  searchRoot: string,
  branchJudgementsLocalPayload: string | undefined,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(
      juliaCommand,
      [
        `--project=${graphProject}`,
        "--startup-file=no",
        "-e",
        JULIA_STRATEGY_FLOW_SCRIPT,
        intent,
        searchRoot,
        "",
        "",
        "null",
        branchJudgementsLocalPayload ?? "",
      ],
      { env: process.env },
    );
    collectProcessOutput(child, resolveOutput, reject, "WendaoGraph SearchStrategyFlow");
  });
}

function rustBridgeArgs(
  options: RustStrategyFlowOptions,
  mode: SearchStrategyFlowRustBridgeMode,
): string[] {
  const args =
    mode === "cargo"
      ? ["run", "-q", "-p", "xiuxian-julia-core", "--bin", "wendaograph_search_strategy_flow", "--"]
      : [];
  args.push("--intent", options.intent);
  if (options.queryUnderstandingArrowIpcPath) {
    args.push("--query-understanding-arrow-ipc", options.queryUnderstandingArrowIpcPath);
  }
  if (options.branchJudgementsArrowIpcPath) {
    args.push("--branch-judgements-arrow-ipc", options.branchJudgementsArrowIpcPath);
  }
  if (options.flightBaseUrl) args.push("--flight-base-url", options.flightBaseUrl);
  if (options.flightTimeoutSeconds !== undefined) {
    args.push("--flight-timeout-seconds", String(options.flightTimeoutSeconds));
  }
  if (options.strategyFlowServiceBaseUrl) {
    args.push("--strategy-flow-service-base-url", options.strategyFlowServiceBaseUrl);
  }
  if (options.strategyFlowServiceTimeoutSeconds !== undefined) {
    args.push(
      "--strategy-flow-service-timeout-seconds",
      String(options.strategyFlowServiceTimeoutSeconds),
    );
  }
  return args;
}

function rustBridgeSessionArgs(
  options: RustStrategyFlowOptions,
  mode: SearchStrategyFlowRustBridgeMode,
): string[] {
  const args =
    mode === "cargo"
      ? ["run", "-q", "-p", "xiuxian-julia-core", "--bin", "wendaograph_search_strategy_flow", "--"]
      : [];
  if (options.flightBaseUrl) args.push("--flight-base-url", options.flightBaseUrl);
  if (options.flightTimeoutSeconds !== undefined) {
    args.push("--flight-timeout-seconds", String(options.flightTimeoutSeconds));
  }
  args.push("--serve-stdio");
  return args;
}

function renderOptionalBranchJudgementsTsv(options: SearchStrategyFlowOptions): string | undefined {
  return options.branchJudgements && options.branchJudgements.length > 0
    ? renderSearchStrategyFlowBranchJudgementTsv(options.branchJudgements)
    : undefined;
}

async function writeOptionalQueryUnderstandingArrowIpcFile(
  options: SearchStrategyFlowOptions,
): Promise<{ path: string; cleanup: () => Promise<void> } | undefined> {
  if (!options.queryUnderstanding || options.queryUnderstanding.length === 0) return undefined;

  const dir = await mkdtemp(join(tmpdir(), "pi-wendao-search-query-understanding-"));
  const path = join(dir, "query-understanding.arrow");
  await writeFile(
    path,
    encodeSearchStrategyFlowQueryUnderstandingArrowIpc(options.queryUnderstanding),
  );
  return {
    path,
    cleanup: () => rm(dir, { force: true, recursive: true }),
  };
}

async function writeOptionalBranchJudgementsArrowIpcFile(
  options: SearchStrategyFlowOptions,
): Promise<{ path: string; cleanup: () => Promise<void> } | undefined> {
  if (!options.branchJudgements || options.branchJudgements.length === 0) return undefined;

  const dir = await mkdtemp(join(tmpdir(), "pi-wendao-search-branch-judgements-"));
  const path = join(dir, "branch-judgements.arrow");
  await writeFile(path, encodeSearchStrategyFlowBranchJudgementsArrowIpc(options.branchJudgements));
  return {
    path,
    cleanup: () => rm(dir, { force: true, recursive: true }),
  };
}

function parseRustBridgeStdioSessionTrace(stdout: string): string {
  const responses = stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as {
          ok?: unknown;
          error?: unknown;
          trace?: unknown;
        };
      } catch (error) {
        throw new Error(`invalid Rust SearchStrategyFlow bridge session JSONL: ${error}`);
      }
    });
  if (responses.length !== 1) {
    throw new Error(
      `Rust SearchStrategyFlow bridge session expected one response, got ${responses.length}`,
    );
  }
  const [response] = responses;
  if (response.ok !== true) {
    throw new Error(`Rust SearchStrategyFlow bridge session failed: ${String(response.error)}`);
  }
  if (response.trace === undefined) {
    throw new Error("Rust SearchStrategyFlow bridge session response is missing trace");
  }
  return JSON.stringify(response.trace);
}

function resolveRustBridgeSessionMode(explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  return process.env.PI_WENDAO_SEARCH_RUST_BRIDGE_SESSION === "1";
}

function summarizeBridgeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const firstUsefulLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.endsWith("failed with exit code 101:")) ??
    text.trim();
  return firstUsefulLine.length > 240 ? `${firstUsefulLine.slice(0, 237)}...` : firstUsefulLine;
}
