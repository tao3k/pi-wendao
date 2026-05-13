import { spawn } from "node:child_process";
import {
  resolveRustBridgeCommand,
  resolveWendaoGraphProject,
  resolveWendaoRustWorkspace,
} from "./strategy-flow-discovery.js";
import { renderSearchStrategyFlowBranchJudgementTsv } from "./strategy-flow-branch-judgement.js";
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
  branchJudgementsTsv?: string;
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
  try {
    return attachSuccessfulRustBridge(
      context,
      rustWorkspace,
      await runRustStrategyFlow({
        cargoCommand: context.options.rustCommand ?? process.env.CARGO,
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
        branchJudgementsTsv: renderOptionalBranchJudgementsTsv(context.options),
      }),
    );
  } catch (error) {
    throw new Error(
      `${summarizeBridgeError(error)}\nSearchStrategyFlow auto mode treats the Rust bridge as the core path. Use --search-backend julia-direct only for pi-local bridge smoke tests.`,
    );
  }
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
  if (!options.flightBaseUrl) {
    throw new Error(
      "--search-rust-bridge-session requires --search-flight-base-url",
    );
  }
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
        ...(options.branchJudgementsTsv
          ? { branchJudgementsTsv: options.branchJudgementsTsv }
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
  branchJudgementsTsv: string | undefined,
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
        branchJudgementsTsv ?? "",
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
      ? [
          "run",
          "-q",
          "-p",
          "xiuxian-wendao-julia",
          "--bin",
          "wendaograph_search_strategy_flow",
          "--",
        ]
      : [];
  args.push("--intent", options.intent);
  if (options.branchJudgementsTsv) {
    args.push("--branch-judgements-tsv", options.branchJudgementsTsv);
  }
  if (options.flightBaseUrl) args.push("--flight-base-url", options.flightBaseUrl);
  if (options.flightTimeoutSeconds !== undefined) {
    args.push("--flight-timeout-seconds", String(options.flightTimeoutSeconds));
  }
  return args;
}

function rustBridgeSessionArgs(
  options: RustStrategyFlowOptions,
  mode: SearchStrategyFlowRustBridgeMode,
): string[] {
  const args =
    mode === "cargo"
      ? [
          "run",
          "-q",
          "-p",
          "xiuxian-wendao-julia",
          "--bin",
          "wendaograph_search_strategy_flow",
          "--",
        ]
      : [];
  args.push("--flight-base-url", options.flightBaseUrl ?? "");
  if (options.flightTimeoutSeconds !== undefined) {
    args.push("--flight-timeout-seconds", String(options.flightTimeoutSeconds));
  }
  args.push("--serve-stdio");
  return args;
}

function renderOptionalBranchJudgementsTsv(
  options: SearchStrategyFlowOptions,
): string | undefined {
  return options.branchJudgements && options.branchJudgements.length > 0
    ? renderSearchStrategyFlowBranchJudgementTsv(options.branchJudgements)
    : undefined;
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
