import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  resolveRustBridgeCommand,
  resolveWendaoGraphProject,
  resolveWendaoRustWorkspace,
} from "./strategy-flow-discovery.js";
import { collectProcessOutput } from "./strategy-flow-process.js";
import { JULIA_STRATEGY_FLOW_SCRIPT } from "./strategy-flow-script.js";
import { parseStrategyFlowTrace } from "./strategy-flow-trace.js";
import type {
  SearchStrategyFlowBackend,
  SearchStrategyFlowOptions,
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
  searchRoot: string;
  juliaCommand: string;
  searchBackend: SearchStrategyFlowBackend;
}

interface RustStrategyFlowOptions {
  cargoCommand?: string;
  rustWorkspace: string;
  graphProject: string;
  intent: string;
  searchRoot: string;
  juliaCommand?: string;
  flightBaseUrl?: string;
  flightRepo?: string;
  flightTimeoutSeconds?: number;
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
  const searchRoot = resolve(options.searchRoot ?? graphProject);
  const juliaCommand = options.juliaCommand ?? process.env.JULIA ?? "julia";
  const searchBackend: SearchStrategyFlowBackend = options.searchBackend ?? "auto";
  return { options, intent, graphProject, searchRoot, juliaCommand, searchBackend };
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
        rustWorkspace,
        graphProject: context.graphProject,
        intent: context.intent,
        searchRoot: context.searchRoot,
        juliaCommand: context.options.juliaCommand,
        flightBaseUrl:
          context.options.flightBaseUrl ?? process.env.PI_WENDAO_SEARCH_FLIGHT_BASE_URL,
        flightRepo: context.options.flightRepo ?? process.env.PI_WENDAO_SEARCH_FLIGHT_REPO,
        flightTimeoutSeconds: context.options.flightTimeoutSeconds,
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
  stdout: string,
): SearchStrategyFlowTrace {
  return {
    ...parseStrategyFlowTrace(stdout),
    rustBridge: {
      requestedBackend: context.searchBackend,
      attempted: true,
      rustWorkspace,
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
    context.searchRoot,
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

async function runRustStrategyFlow(options: RustStrategyFlowOptions): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const command = resolveRustBridgeCommand(options.rustWorkspace, options.cargoCommand);
    const child = spawn(command.command, [...command.prefixArgs, ...rustBridgeArgs(options)], {
      cwd: options.rustWorkspace,
      env: {
        ...process.env,
        WENDAOGRAPH_PACKAGE_DIR: options.graphProject,
        ...(options.juliaCommand ? { JULIA: options.juliaCommand } : {}),
      },
    });
    collectProcessOutput(child, resolveOutput, reject, "Rust SearchStrategyFlow bridge");
  });
}

async function runJuliaStrategyFlow(
  juliaCommand: string,
  graphProject: string,
  intent: string,
  searchRoot: string,
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
      ],
      { env: process.env },
    );
    collectProcessOutput(child, resolveOutput, reject, "WendaoGraph SearchStrategyFlow");
  });
}

function rustBridgeArgs(options: RustStrategyFlowOptions): string[] {
  const args = [
    "run",
    "-q",
    "-p",
    "xiuxian-wendao-julia",
    "--example",
    "wendaograph_search_strategy_flow",
    "--",
    "--intent",
    options.intent,
    "--search-root",
    options.searchRoot,
  ];
  if (options.flightBaseUrl) args.push("--flight-base-url", options.flightBaseUrl);
  if (options.flightRepo) args.push("--flight-repo", options.flightRepo);
  if (options.flightTimeoutSeconds !== undefined) {
    args.push("--flight-timeout-seconds", String(options.flightTimeoutSeconds));
  }
  return args;
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
