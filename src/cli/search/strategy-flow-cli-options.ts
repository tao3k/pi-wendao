import { resolve as resolvePath } from "node:path";
import type {
  SearchStrategyFlowBackend,
  SearchStrategyFlowFlightBaseUrl,
  SearchStrategyFlowFlightTimeoutSeconds,
  SearchStrategyFlowOptions,
  SearchStrategyFlowPath,
  SearchStrategyFlowQueryUnderstandingRow,
  SearchStrategyFlowServiceBaseUrl,
} from "./strategy-flow-types.js";

interface SearchStrategyFlowCliRawInput {
  intent: string;
  cwd: string;
  wendaoGraph?: string;
  searchJulia?: string;
  searchBackend?: string;
  searchRustWorkspace?: string;
  searchRustCommand?: string;
  searchRustBridgeBin?: string;
  searchRustBridgeSession?: boolean;
  searchFlightBaseUrl?: string;
  searchFlightTimeoutSeconds?: number;
  searchStrategyFlowServiceBaseUrl?: string;
  searchStrategyFlowServiceTimeoutSeconds?: number;
  queryUnderstanding?: SearchStrategyFlowQueryUnderstandingRow[];
}

export function resolveSearchStrategyFlowCliOptions(
  input: SearchStrategyFlowCliRawInput,
): SearchStrategyFlowOptions {
  return {
    intent: input.intent,
    cwd: input.cwd,
    wendaoGraphPath: resolveOptionalSearchStrategyFlowPath(input.cwd, input.wendaoGraph),
    juliaCommand: input.searchJulia,
    searchBackend: resolveSearchBackend(input.searchBackend),
    rustWorkspace: resolveOptionalSearchStrategyFlowPath(input.cwd, input.searchRustWorkspace),
    rustCommand: input.searchRustCommand,
    rustBridgeBinary: resolveOptionalSearchStrategyFlowPath(input.cwd, input.searchRustBridgeBin),
    rustBridgeSession: input.searchRustBridgeSession,
    flightBaseUrl: asSearchStrategyFlowFlightBaseUrl(input.searchFlightBaseUrl),
    flightTimeoutSeconds: asSearchStrategyFlowFlightTimeoutSeconds(
      input.searchFlightTimeoutSeconds,
    ),
    strategyFlowServiceBaseUrl: asSearchStrategyFlowServiceBaseUrl(
      input.searchStrategyFlowServiceBaseUrl,
    ),
    strategyFlowServiceTimeoutSeconds: asSearchStrategyFlowFlightTimeoutSeconds(
      input.searchStrategyFlowServiceTimeoutSeconds,
    ),
    queryUnderstanding: input.queryUnderstanding,
  };
}

function resolveOptionalSearchStrategyFlowPath(
  cwd: string,
  path: string | undefined,
): SearchStrategyFlowPath | undefined {
  return (path ? resolvePath(cwd, path) : undefined) as SearchStrategyFlowPath | undefined;
}

function asSearchStrategyFlowFlightBaseUrl(
  value: string | undefined,
): SearchStrategyFlowFlightBaseUrl | undefined {
  return value as SearchStrategyFlowFlightBaseUrl | undefined;
}

function asSearchStrategyFlowServiceBaseUrl(
  value: string | undefined,
): SearchStrategyFlowServiceBaseUrl | undefined {
  return value as SearchStrategyFlowServiceBaseUrl | undefined;
}

function asSearchStrategyFlowFlightTimeoutSeconds(
  value: number | undefined,
): SearchStrategyFlowFlightTimeoutSeconds | undefined {
  return value as SearchStrategyFlowFlightTimeoutSeconds | undefined;
}

function resolveSearchBackend(explicitBackend: string | undefined): SearchStrategyFlowBackend | undefined {
  if (explicitBackend === undefined) return undefined;
  if (
    explicitBackend === "auto" ||
    explicitBackend === "rust-julia" ||
    explicitBackend === "julia-direct"
  ) {
    return explicitBackend;
  }
  throw new Error('invalid --search-backend; expected "auto", "rust-julia", or "julia-direct"');
}
