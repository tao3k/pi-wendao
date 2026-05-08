import { resolveModel } from "../model-resolver.js";
import { createCliPiSubagentsHost } from "../pi-subagents.js";
import { buildSearchStrategyFlowRetrievalRoutes } from "./strategy-flow-retrieval.js";
import type {
  SearchStrategyFlowAgentEvent,
  SearchStrategyFlowAgentTrace,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";

const SEARCH_STRATEGY_FLOW_AGENT_ACTIVITY_ID = "SearchStrategyFlow_QueryUnderstanding";

export interface SearchStrategyFlowAgentOptions {
  trace: SearchStrategyFlowTrace;
  cwd: string;
  modelPattern: string;
  provider?: string;
  apiKey?: string;
  thinkingLevel?: string;
  extensionPaths: string[];
}

export async function runSearchStrategyFlowAgentTrace(
  options: SearchStrategyFlowAgentOptions,
): Promise<SearchStrategyFlowAgentTrace> {
  const startedAt = Date.now();
  const llmActions = options.trace.plannerActions.filter((action) => action.requiresLlmJudgement);
  if (llmActions.length === 0) {
    return {
      mode: "live-subagent",
      status: "skipped",
      durationMs: elapsedMs(startedAt),
      reason: "SearchStrategyFlow did not request an LLM judgement.",
      events: [],
    };
  }

  const events: SearchStrategyFlowAgentEvent[] = [];
  try {
    const resolved = await resolveModel(
      options.modelPattern,
      options.provider,
      options.apiKey,
      options.extensionPaths,
    );
    if (!hasRequestAuth(resolved.apiKey, resolved.headers)) {
      return {
        mode: "live-subagent",
        status: "failed",
        model: `${resolved.model.provider}/${resolved.model.id}`,
        durationMs: elapsedMs(startedAt),
        reason:
          "No request auth is configured for the SearchStrategyFlow LLM judgement. Set DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN for the selected Anthropic-compatible gateway.",
        events,
      };
    }
    const host = createCliPiSubagentsHost({
      loadResult: resolved.loadResult,
      modelRegistry: resolved.modelRegistry,
      cwd: resolveSearchAgentCwd(options),
      model: resolved.model,
      defaultRunInBackground: false,
      defaultSubagentType: "pi-wendao-output-only",
      onEvent: (event) => {
        events.push({
          kind: event.type,
          activityId: event.activityId,
          agentId: event.agentId,
          description: event.description,
          ...(event.type === "result" ? { resultText: event.resultText } : {}),
        });
      },
      onToolEvent: (event) => {
        events.push({
          kind: event.type,
          activityId: event.activityId,
          agentId: event.agentId,
          description: event.description,
          toolName: event.toolName,
          ...(event.type === "tool_result" ? { isError: event.isError } : {}),
        });
      },
    });
    if (!host) {
      return {
        mode: "live-subagent",
        status: "unavailable",
        model: `${resolved.model.provider}/${resolved.model.id}`,
        durationMs: elapsedMs(startedAt),
        reason: "pi-subagents tools are not available in the loaded extensions.",
        events,
      };
    }

    const output = await host.run({
      activityId: SEARCH_STRATEGY_FLOW_AGENT_ACTIVITY_ID,
      config: {
        prompt: buildSearchAgentPrompt(options.trace),
        tools: [],
        inputs: ["intent", "trace"],
        outputs: ["intent_understanding", "branch_decision", "judgement"],
        subagent: {
          type: "pi-wendao-output-only",
          description: "Understand SearchStrategyFlow intent and judge frontier branches",
          runInBackground: false,
          model: `${resolved.model.provider}/${resolved.model.id}`,
          ...(options.thinkingLevel ? { thinking: options.thinkingLevel } : {}),
          maxTurns: 2,
        },
      },
      variables: {
        intent: options.trace.intent,
        trace: compactTraceForAgent(options.trace),
      },
      execution: {
        activityId: SEARCH_STRATEGY_FLOW_AGENT_ACTIVITY_ID,
        nodeIndex: 0,
      },
    });

    const intentUnderstanding = readNonEmptyString(output.intent_understanding);
    const branchDecision = readNonEmptyString(output.branch_decision);
    const judgement = readNonEmptyString(output.judgement);
    const missingOutputs = [
      ["intent_understanding", intentUnderstanding],
      ["branch_decision", branchDecision],
      ["judgement", judgement],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingOutputs.length > 0) {
      return {
        mode: "live-subagent",
        status: "failed",
        model: `${resolved.model.provider}/${resolved.model.id}`,
        durationMs: elapsedMs(startedAt),
        reason: `SearchStrategyFlow subagent completed without non-empty output(s): ${missingOutputs.join(", ")}.`,
        events,
        output,
      };
    }

    return {
      mode: "live-subagent",
      status: "completed",
      model: `${resolved.model.provider}/${resolved.model.id}`,
      durationMs: elapsedMs(startedAt),
      cached: events.length === 0,
      events,
      output,
    };
  } catch (error) {
    return {
      mode: "live-subagent",
      status: "failed",
      durationMs: elapsedMs(startedAt),
      reason: error instanceof Error ? error.message : String(error),
      events,
    };
  }
}

function buildSearchAgentPrompt(trace: SearchStrategyFlowTrace): string {
  return [
    "You are the first-layer Wendao SearchStrategyFlow query-understanding and branch-judgement agent.",
    "This first layer is correctness-sensitive: preserve the configured reasoning level and do not trade intent quality for latency.",
    "Use only the compact trace and the graph_query_understanding evidence. Do not request files, tools, or extra context.",
    "Treat retrieval_routes as later-layer Flight/Rust materialization plans; never bypass Rust by reading a full Markdown file directly.",
    "First normalize what the user is really asking for, using Julia's graph evidence as constraints rather than optional suggestions.",
    "Then judge whether the selected frontier branches are sufficient for that intent.",
    "Return concise outputs:",
    "- intent_understanding: one sentence with normalized intent, route, facets, and ambiguity.",
    "- branch_decision: one sentence naming keep, expand, prune, and risky branches.",
    "- judgement: final answer under 80 words explaining whether the current frontier is sufficient.",
    "",
    `Intent: ${trace.intent}`,
    `Search root: ${trace.searchRoot}`,
  ].join("\n");
}

function compactTraceForAgent(trace: SearchStrategyFlowTrace): Record<string, unknown> {
  const retrievalRoutes = buildSearchStrategyFlowRetrievalRoutes(trace);
  return {
    backend: trace.backend,
    controlPlane: trace.controlPlane,
    rustBridge: trace.rustBridge,
    strategyBudget: trace.strategyBudget,
    stageReceipts: trace.stageReceipts.map((stage) => ({
      stage: stage.stage,
      notebook: stage.notebook,
      input: stage.inputCount,
      output: stage.outputCount,
      selected: stage.selectedCount,
      llmJudgement: stage.llmJudgementCount,
      cycleAllowed: stage.cycleAllowedCount,
      contextBudget: stage.contextBudget,
      summary: stage.summary,
    })),
    validation: trace.validation,
    graphQueryUnderstanding: (trace.queryUnderstanding ?? []).map((row) => ({
      kind: row.signalKind,
      value: row.signalValue,
      confidence: row.confidence,
      route: row.routeHint,
      requiredEvidence: row.requiredEvidence,
      ambiguity: row.ambiguity,
      budget: {
        loop: row.recommendedLoopBudget,
        judgement: row.recommendedJudgementBudget,
        beam: row.recommendedBeamWidth,
      },
      reason: row.reason,
    })),
    candidates: trace.candidates.map((candidate) => ({
      id: candidate.candidateId,
      action: candidate.action,
      score: candidate.finalScore,
      blocked: candidate.blocked,
      reason: candidate.reason,
    })),
    frontier: trace.frontier.map((row) => ({
      id: row.candidateId,
      rank: row.rank,
      selected: row.selected,
      action: row.action,
      judgementKind: row.judgementKind,
    })),
    llmActions: trace.plannerActions
      .filter((action) => action.requiresLlmJudgement)
      .map((action) => ({
        kind: action.actionKind,
        candidateId: action.candidateId,
        targetCandidateId: action.targetCandidateId,
        reason: action.reason,
      })),
    retrievalRoutes: retrievalRoutes.map((route) => ({
      candidateId: route.candidateId,
      owner: route.materializationOwner,
      sourcePath: route.sourcePath,
      headingAnchor: route.headingAnchor,
      directFileReadAllowed: route.directFileReadAllowed,
      primaryTransport: route.primaryTransport,
      flightSteps: route.flightSteps,
    })),
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveSearchAgentCwd(options: SearchStrategyFlowAgentOptions): string {
  return options.trace.searchRoot || options.trace.graphProject || options.cwd;
}

function hasRequestAuth(apiKey: string | undefined, headers: Record<string, string> | undefined): boolean {
  return Boolean(apiKey || (headers && Object.keys(headers).length > 0));
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}
