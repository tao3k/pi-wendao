import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveSearchStrategyFlowCliOptions } from "./strategy-flow-cli-options.js";
import { runSearchStrategyFlow } from "./strategy-flow-julia.js";
import { renderSearchStrategyFlowTrace } from "./strategy-flow-renderer.js";
import type { SearchStrategyFlowOptions, SearchStrategyFlowTrace } from "./strategy-flow-types.js";

export const WENDAO_SEARCH_STRATEGY_FLOW_TOOL_NAME = "wendao_search_strategy_flow";

export interface RegisterSearchStrategyFlowToolOptions {
  cwd: string;
  runner?: SearchStrategyFlowToolRunner;
}

export type SearchStrategyFlowToolRunner = (
  options: SearchStrategyFlowOptions,
) => Promise<SearchStrategyFlowTrace>;

interface SearchStrategyFlowToolParams {
  intent?: unknown;
  search_backend?: unknown;
  search_flight_base_url?: unknown;
  search_flight_timeout_seconds?: unknown;
  search_strategy_flow_service_base_url?: unknown;
  search_strategy_flow_service_timeout_seconds?: unknown;
  json?: unknown;
}

interface SearchStrategyFlowToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

export function registerSearchStrategyFlowTool(
  pi: Pick<ExtensionAPI, "registerTool">,
  options: RegisterSearchStrategyFlowToolOptions,
): void {
  if (typeof pi.registerTool !== "function") return;
  pi.registerTool({
    name: WENDAO_SEARCH_STRATEGY_FLOW_TOOL_NAME,
    label: "Wendao SearchStrategyFlow",
    description:
      "Search structured Wendao project evidence through the governed Rust SearchStrategyFlow bridge.",
    promptSnippet:
      "Use wendao_search_strategy_flow when you need structured project evidence, ownership boundaries, validation paths, or graph-selected recall.",
    parameters: Type.Object({
      intent: Type.String({
        description: "Natural-language search intent for the Wendao SearchStrategyFlow.",
      }),
      search_backend: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("rust-julia")], {
          description:
            "Governed SearchStrategyFlow backend. Defaults to auto; julia-direct is intentionally not exposed to child agents.",
        }),
      ),
      search_flight_base_url: Type.Optional(
        Type.String({
          description:
            "Optional Studio/Gateway Arrow Flight endpoint. Environment defaults are used when omitted.",
        }),
      ),
      search_flight_timeout_seconds: Type.Optional(
        Type.Number({ minimum: 1, description: "Optional Flight request timeout." }),
      ),
      search_strategy_flow_service_base_url: Type.Optional(
        Type.String({
          description: "Optional WendaoGraph SearchStrategyFlow Arrow Flight service endpoint.",
        }),
      ),
      search_strategy_flow_service_timeout_seconds: Type.Optional(
        Type.Number({
          minimum: 1,
          description: "Optional SearchStrategyFlow service request timeout.",
        }),
      ),
      json: Type.Optional(
        Type.Boolean({
          description:
            "Return the raw SearchStrategyFlow trace JSON instead of the compact text trace.",
        }),
      ),
    }),
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      return executeSearchStrategyFlowTool({
        toolCallId,
        params: params as SearchStrategyFlowToolParams,
        signal,
        cwd: options.cwd,
        runner: options.runner ?? runSearchStrategyFlow,
      });
    },
  });
}

async function executeSearchStrategyFlowTool(input: {
  toolCallId: string;
  params: SearchStrategyFlowToolParams;
  signal?: AbortSignal;
  cwd: string;
  runner: SearchStrategyFlowToolRunner;
}): Promise<SearchStrategyFlowToolResult> {
  try {
    throwIfAborted(input.signal);
    const request = normalizeSearchStrategyFlowToolParams(input.params);
    const trace = await input.runner(
      resolveSearchStrategyFlowCliOptions({
        intent: request.intent,
        cwd: input.cwd,
        searchBackend: request.searchBackend,
        searchFlightBaseUrl: request.searchFlightBaseUrl,
        searchFlightTimeoutSeconds: request.searchFlightTimeoutSeconds,
        searchStrategyFlowServiceBaseUrl: request.searchStrategyFlowServiceBaseUrl,
        searchStrategyFlowServiceTimeoutSeconds: request.searchStrategyFlowServiceTimeoutSeconds,
      }),
    );
    throwIfAborted(input.signal);
    return {
      content: [
        {
          type: "text",
          text: request.json
            ? `${JSON.stringify(trace, null, 2)}\n`
            : renderSearchStrategyFlowTrace(trace),
        },
      ],
      details: searchStrategyFlowToolDetails(input.toolCallId, trace),
    };
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    return {
      content: [{ type: "text", text: `Wendao SearchStrategyFlow failed: ${error.message}` }],
      details: {
        customType: WENDAO_SEARCH_STRATEGY_FLOW_TOOL_NAME,
        toolCallId: input.toolCallId,
        error: error.message,
      },
      isError: true,
    };
  }
}

function normalizeSearchStrategyFlowToolParams(params: SearchStrategyFlowToolParams): {
  intent: string;
  searchBackend?: "auto" | "rust-julia";
  searchFlightBaseUrl?: string;
  searchFlightTimeoutSeconds?: number;
  searchStrategyFlowServiceBaseUrl?: string;
  searchStrategyFlowServiceTimeoutSeconds?: number;
  json: boolean;
} {
  const intent = typeof params.intent === "string" ? params.intent.trim() : "";
  if (!intent) throw new Error("wendao_search_strategy_flow requires a non-empty intent");
  return {
    intent,
    searchBackend: normalizeSearchBackend(params.search_backend),
    searchFlightBaseUrl: optionalNonEmptyString(params.search_flight_base_url),
    searchFlightTimeoutSeconds: optionalPositiveInteger(params.search_flight_timeout_seconds),
    searchStrategyFlowServiceBaseUrl: optionalNonEmptyString(
      params.search_strategy_flow_service_base_url,
    ),
    searchStrategyFlowServiceTimeoutSeconds: optionalPositiveInteger(
      params.search_strategy_flow_service_timeout_seconds,
    ),
    json: params.json === true,
  };
}

function normalizeSearchBackend(value: unknown): "auto" | "rust-julia" | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "rust-julia") return value;
  if (value === "julia-direct") {
    throw new Error("wendao_search_strategy_flow does not expose julia-direct");
  }
  throw new Error('search_backend must be "auto" or "rust-julia"');
}

function searchStrategyFlowToolDetails(
  toolCallId: string,
  trace: SearchStrategyFlowTrace,
): Record<string, unknown> {
  return {
    customType: WENDAO_SEARCH_STRATEGY_FLOW_TOOL_NAME,
    toolCallId,
    intent: trace.intent,
    backend: trace.backend,
    controlPlane: trace.controlPlane,
    strategyFlowDataPlane: trace.strategyFlowDataPlane,
    strategyFlowServiceDataPlane: trace.strategyFlowService?.dataPlane,
    rustBridgeAttempted: trace.rustBridge?.attempted,
    rustBridgeMode: trace.rustBridge?.mode,
    candidateCount: trace.summary.candidateCount,
    selectedCount: trace.summary.selectedCount,
    requiredEvidenceCovered: trace.validation.requiredEvidenceCovered,
    selectedRequiredEvidence: trace.validation.selectedRequiredEvidence,
    missingRequiredEvidence: trace.validation.missingRequiredEvidence,
  };
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.trunc(value));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("wendao_search_strategy_flow was aborted");
}
