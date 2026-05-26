import { spawn } from "node:child_process";
import {
  resolveRustBridgeCommand,
  resolveWendaoGraphProject,
  resolveWendaoRustWorkspace,
} from "../strategy-flow-discovery.js";
import { resolveSearchStrategyFlowRustCommandOverride } from "../strategy-flow-julia.js";
import { parseStrategyFlowTrace } from "../strategy-flow-trace.js";
import type {
  SearchStrategyFlowBackend,
  SearchStrategyFlowOptions,
  SearchStrategyFlowRustBridgeMode,
  SearchStrategyFlowTrace,
} from "../strategy-flow-types.js";
import type {
  SearchStrategyFlowMarkdownCorpusBenchmarkOptions,
  SearchStrategyFlowMarkdownCorpusIntentRow,
  SearchStrategyFlowRustBridgeSessionTiming,
} from "./types.js";

export interface SearchStrategyFlowRustBridgeSessionResult {
  traces: SearchStrategyFlowTrace[];
  timing: SearchStrategyFlowRustBridgeSessionTiming;
}

export async function runMarkdownCorpusBenchmarkRustBridgeSession(input: {
  options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions;
  intentRows: SearchStrategyFlowMarkdownCorpusIntentRow[];
  baseOptions: SearchStrategyFlowOptions;
}): Promise<SearchStrategyFlowRustBridgeSessionResult> {
  const rustWorkspace = resolveWendaoRustWorkspace(input.baseOptions);
  if (!rustWorkspace) {
    throw new Error("could not find xiuxian Rust workspace for SearchStrategyFlow benchmark session");
  }
  const graphProject = resolveWendaoGraphProject(input.baseOptions);
  const command = resolveRustBridgeCommand(
    rustWorkspace,
    resolveSearchStrategyFlowRustCommandOverride(input.baseOptions),
    input.baseOptions.rustBridgeBinary ?? process.env.PI_WENDAO_SEARCH_RUST_BRIDGE_BIN,
  );
  const flightBaseUrl =
    input.options.searchFlightBaseUrl ?? process.env.PI_WENDAO_SEARCH_FLIGHT_BASE_URL;
  const warmupRows = selectWarmupRows(input.intentRows, input.options.searchRustBridgeWarmupRows);
  const { stdout, timing } = await collectRustBridgeSessionOutput({
    command,
    rustWorkspace,
    graphProject,
    intentRows: input.intentRows,
    warmupRows,
    searchJulia: input.options.searchJulia,
    flightBaseUrl,
    flightTimeoutSeconds: input.options.searchFlightTimeoutSeconds,
  });
  return {
    traces: parseRustBridgeSessionResponses(
      stdout,
      input.intentRows,
      input.baseOptions.searchBackend ?? "auto",
      rustWorkspace,
      warmupRows.length,
    ),
    timing,
  };
}

function collectRustBridgeSessionOutput(input: {
  command: ReturnType<typeof resolveRustBridgeCommand>;
  rustWorkspace: string;
  graphProject: string;
  intentRows: SearchStrategyFlowMarkdownCorpusIntentRow[];
  warmupRows: SearchStrategyFlowMarkdownCorpusIntentRow[];
  searchJulia: string | undefined;
  flightBaseUrl: string | undefined;
  flightTimeoutSeconds: number | undefined;
}): Promise<{
  stdout: string;
  timing: SearchStrategyFlowRustBridgeSessionTiming;
}> {
  const startedAt = Date.now();
  const responseElapsedMs: number[] = [];
  return new Promise((resolveOutput, reject) => {
    const child = spawn(
      input.command.command,
      [...input.command.prefixArgs, ...rustBridgeSessionArgs(input.command.mode, {
        flightBaseUrl: input.flightBaseUrl,
        flightTimeoutSeconds: input.flightTimeoutSeconds,
      })],
      {
        cwd: input.rustWorkspace,
        env: {
          ...process.env,
          WENDAOGRAPH_PACKAGE_DIR: input.graphProject,
          ...(input.searchJulia ? { JULIA: input.searchJulia } : {}),
        },
      },
    );
    let stdout = "";
    let stderr = "";
    let pendingStdout = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      pendingStdout += chunk;
      let newlineIndex = pendingStdout.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = pendingStdout.slice(0, newlineIndex).trim();
        pendingStdout = pendingStdout.slice(newlineIndex + 1);
        if (line.length > 0) {
          responseElapsedMs.push(Date.now() - startedAt);
        }
        newlineIndex = pendingStdout.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const sessionDurationMs = Date.now() - startedAt;
      if (exitCode !== 0) {
        reject(
          new Error(
            `Rust SearchStrategyFlow benchmark session failed with exit code ${exitCode ?? "unknown"}${
              stderr.trim() ? `:\n${stderr.trimEnd()}` : ""
            }`,
          ),
        );
        return;
      }
      resolveOutput({
        stdout,
        timing: buildRustBridgeSessionTiming(
          responseElapsedMs,
          sessionDurationMs,
          input.warmupRows.length,
        ),
      });
    });
    input.warmupRows.forEach((row, index) => {
      child.stdin.write(
        `${JSON.stringify({
          requestId: warmupRequestId(row, index),
          intent: row.intent,
        })}\n`,
      );
    });
    for (const row of input.intentRows) {
      child.stdin.write(
        `${JSON.stringify({
          requestId: row.familyId,
          intent: row.intent,
        })}\n`,
      );
    }
    child.stdin.end();
  });
}

function rustBridgeSessionArgs(
  mode: SearchStrategyFlowRustBridgeMode,
  options: {
    flightBaseUrl: string | undefined;
    flightTimeoutSeconds: number | undefined;
  },
): string[] {
  const args =
    mode === "cargo"
      ? [
          "run",
          "-q",
          "-p",
          "xiuxian-julia-core",
          "--bin",
          "wendaograph_search_strategy_flow",
          "--",
        ]
      : [];
  if (options.flightBaseUrl) {
    args.push("--flight-base-url", options.flightBaseUrl);
  }
  if (options.flightTimeoutSeconds !== undefined) {
    args.push("--flight-timeout-seconds", String(options.flightTimeoutSeconds));
  }
  args.push("--serve-stdio");
  return args;
}

function buildRustBridgeSessionTiming(
  responseElapsedMs: number[],
  sessionDurationMs: number,
  warmupRequestCount = 0,
): SearchStrategyFlowRustBridgeSessionTiming {
  const warmupElapsedMs = responseElapsedMs.slice(0, warmupRequestCount);
  const measuredElapsedMs = responseElapsedMs.slice(warmupRequestCount);
  const firstResponseMs = measuredElapsedMs[0] ?? sessionDurationMs;
  const lastResponseMs = measuredElapsedMs.at(-1) ?? firstResponseMs;
  const responseSpanMs = Math.max(0, lastResponseMs - firstResponseMs);
  const responseGaps = measuredElapsedMs.slice(1).map((elapsedMs, index) => (
    elapsedMs - (measuredElapsedMs[index] ?? firstResponseMs)
  ));
  const timing: SearchStrategyFlowRustBridgeSessionTiming = {
    requestCount: measuredElapsedMs.length,
    sessionDurationMs,
    firstResponseMs,
    responseSpanMs,
    maxResponseGapMs: responseGaps.length > 0 ? Math.max(...responseGaps) : 0,
  };
  if (warmupRequestCount > 0) {
    const warmupDurationMs = warmupElapsedMs.at(-1) ?? 0;
    const steadyStateFirstResponseMs = Math.max(0, firstResponseMs - warmupDurationMs);
    const steadyStateLastResponseMs = Math.max(
      steadyStateFirstResponseMs,
      lastResponseMs - warmupDurationMs,
    );
    timing.warmupRequestCount = warmupRequestCount;
    timing.warmupDurationMs = warmupDurationMs;
    timing.steadyStateDurationMs = Math.max(0, sessionDurationMs - warmupDurationMs);
    timing.steadyStateFirstResponseMs = steadyStateFirstResponseMs;
    timing.steadyStateResponseSpanMs = Math.max(
      0,
      steadyStateLastResponseMs - steadyStateFirstResponseMs,
    );
    timing.steadyStateMaxResponseGapMs = timing.maxResponseGapMs;
  }
  return timing;
}

function parseRustBridgeSessionResponses(
  stdout: string,
  intentRows: SearchStrategyFlowMarkdownCorpusIntentRow[],
  requestedBackend: SearchStrategyFlowBackend,
  rustWorkspace: string,
  warmupRequestCount: number,
): SearchStrategyFlowTrace[] {
  const allResponses = stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as {
          requestId?: unknown;
          ok?: unknown;
          error?: unknown;
          trace?: unknown;
        };
      } catch (error) {
        throw new Error(`invalid Rust SearchStrategyFlow benchmark session JSONL: ${error}`);
      }
    });
  const warmupResponses = allResponses.slice(0, warmupRequestCount);
  for (const [index, response] of warmupResponses.entries()) {
    const row = intentRows[index % intentRows.length];
    if (!row) {
      throw new Error(`Rust SearchStrategyFlow benchmark warmup response ${index + 1} has no source row`);
    }
    const expectedRequestId = warmupRequestId(row, index);
    if (response.requestId !== expectedRequestId) {
      throw new Error(
        `Rust SearchStrategyFlow benchmark warmup response ${index + 1} requestId mismatch: expected ${expectedRequestId}, got ${String(response.requestId)}`,
      );
    }
    if (response.ok !== true) {
      throw new Error(
        `Rust SearchStrategyFlow benchmark warmup failed for ${expectedRequestId}: ${String(response.error)}`,
      );
    }
  }
  const responses = allResponses.slice(warmupRequestCount);
  if (responses.length !== intentRows.length) {
    throw new Error(
      `Rust SearchStrategyFlow benchmark session expected ${intentRows.length} response(s), got ${responses.length}`,
    );
  }
  return responses.map((response, index) => {
    const familyId = intentRows[index]?.familyId;
    if (response.requestId !== familyId) {
      throw new Error(
        `Rust SearchStrategyFlow benchmark session response ${index + 1} requestId mismatch: expected ${familyId}, got ${String(response.requestId)}`,
      );
    }
    if (response.ok !== true) {
      throw new Error(
        `Rust SearchStrategyFlow benchmark session failed for ${familyId}: ${String(response.error)}`,
      );
    }
    if (response.trace === undefined) {
      throw new Error(`Rust SearchStrategyFlow benchmark session response ${familyId} is missing trace`);
    }
    return {
      ...parseStrategyFlowTrace(JSON.stringify(response.trace)),
      rustBridge: {
        requestedBackend,
        attempted: true,
        rustWorkspace,
        mode: "persistent-stdio",
        fallback: "none",
      },
    };
  });
}

function selectWarmupRows(
  intentRows: SearchStrategyFlowMarkdownCorpusIntentRow[],
  requestedWarmupRows: number | undefined,
): SearchStrategyFlowMarkdownCorpusIntentRow[] {
  const count = Math.max(0, Math.min(requestedWarmupRows ?? 0, intentRows.length));
  return intentRows.slice(0, count);
}

function warmupRequestId(row: SearchStrategyFlowMarkdownCorpusIntentRow, index: number): string {
  return `__warmup__:${index}:${row.familyId}`;
}
