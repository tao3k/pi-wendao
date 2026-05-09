import { resolve as resolvePath } from "node:path";
import type {
  SearchStrategyFlowBackend,
  SearchStrategyFlowFlightBaseUrl,
  SearchStrategyFlowFlightRepo,
  SearchStrategyFlowFlightTimeoutSeconds,
  SearchStrategyFlowOptions,
  SearchStrategyFlowPath,
} from "./strategy-flow-types.js";

export interface SearchStrategyFlowCliInput {
  intent: string;
  cwd: string;
  wendaoGraph?: string;
  searchRoot?: string;
  searchJulia?: string;
  searchBackend?: string;
  searchRustWorkspace?: string;
  searchRustCommand?: string;
  searchFlightBaseUrl?: string;
  searchFlightRepo?: string;
  searchFlightTimeoutSeconds?: number;
}

export function resolveSearchStrategyFlowCliOptions(
  input: SearchStrategyFlowCliInput,
): SearchStrategyFlowOptions {
  return {
    intent: input.intent,
    cwd: input.cwd,
    wendaoGraphPath: resolveOptionalSearchStrategyFlowPath(input.cwd, input.wendaoGraph),
    searchRoot: resolveOptionalSearchStrategyFlowPath(input.cwd, input.searchRoot),
    juliaCommand: input.searchJulia,
    searchBackend: resolveSearchBackend(input.searchBackend),
    rustWorkspace: resolveOptionalSearchStrategyFlowPath(input.cwd, input.searchRustWorkspace),
    rustCommand: input.searchRustCommand,
    flightBaseUrl: asSearchStrategyFlowFlightBaseUrl(input.searchFlightBaseUrl),
    flightRepo: asSearchStrategyFlowFlightRepo(input.searchFlightRepo),
    flightTimeoutSeconds: asSearchStrategyFlowFlightTimeoutSeconds(
      input.searchFlightTimeoutSeconds,
    ),
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

function asSearchStrategyFlowFlightRepo(
  value: string | undefined,
): SearchStrategyFlowFlightRepo | undefined {
  return value as SearchStrategyFlowFlightRepo | undefined;
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
