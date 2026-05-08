import type {
  SearchStrategyFlowAgentTrace,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";
import { buildSearchStrategyFlowRetrievalRoutes } from "./strategy-flow-retrieval.js";

export function renderSearchStrategyFlowTrace(
  trace: SearchStrategyFlowTrace,
  agentTrace?: SearchStrategyFlowAgentTrace,
): string {
  return renderSearchStrategyFlowTraceInternal(trace, agentTrace);
}

function renderSearchStrategyFlowTraceInternal(
  trace: SearchStrategyFlowTrace,
  agentTrace?: SearchStrategyFlowAgentTrace,
): string {
  const llmActions = trace.plannerActions.filter((row) => row.requiresLlmJudgement);
  const retrievalRoutes = buildSearchStrategyFlowRetrievalRoutes(trace);
  const lines = [
    "SearchStrategyFlow trace",
    `intent: ${trace.intent}`,
    `backend: ${trace.backend}`,
    ...(trace.controlPlane ? [`control_plane: ${trace.controlPlane}`] : []),
    ...(trace.juliaProject ? [`julia_project: ${trace.juliaProject}`] : []),
    `graph_project: ${trace.graphProject}`,
    `search_root: ${trace.searchRoot}`,
    ...(trace.rustBridge
      ? [
          "",
          "rust_bridge:",
          `  requested: ${trace.rustBridge.requestedBackend}`,
          `  attempted: ${formatBool(trace.rustBridge.attempted)}`,
          ...(trace.rustBridge.rustWorkspace
            ? [`  workspace: ${trace.rustBridge.rustWorkspace}`]
            : []),
          `  fallback: ${trace.rustBridge.fallback}`,
          ...(trace.rustBridge.error ? [`  error: ${trace.rustBridge.error}`] : []),
        ]
      : []),
    ...(trace.queryUnderstanding && trace.queryUnderstanding.length > 0
      ? [
          "",
          "graph_query_understanding:",
          ...trace.queryUnderstanding.map(
            (row) =>
              `  - ${row.signalId} kind=${row.signalKind} value=${row.signalValue} confidence=${formatScore(row.confidence)} route=${row.routeHint || "none"} evidence=${row.requiredEvidence || "none"} ambiguity=${formatScore(row.ambiguity)} budget=${row.recommendedLoopBudget}/${row.recommendedJudgementBudget}/${row.recommendedBeamWidth} reason=${row.reason}`,
          ),
        ]
      : []),
    ...(trace.strategyBudget
      ? [
          "",
          "strategy_budget:",
          `  source: ${trace.strategyBudget.source}`,
          `  loop: ${trace.strategyBudget.loopBudget}`,
          `  judgement: ${trace.strategyBudget.judgementBudget}`,
          `  beam: ${trace.strategyBudget.beamWidth}`,
        ]
      : []),
    ...(trace.stageReceipts.length > 0
      ? [
          "",
          "strategy_flow_stages:",
          ...trace.stageReceipts.map(
            (row, index) =>
              `  - stage${index + 1} ${row.stage} notebook=${row.notebook} input=${row.inputCount} output=${row.outputCount} selected=${row.selectedCount} llm=${row.llmJudgementCount} cycle=${row.cycleAllowedCount} context=${row.contextBudget} summary=${row.summary}`,
          ),
        ]
      : []),
    "",
    "summary:",
    `  candidates: ${trace.summary.candidateCount}`,
    `  selected: ${trace.summary.selectedCount}`,
    `  planner_actions: ${trace.summary.plannerActionCount}`,
    `  context: ${trace.summary.selectedContextCost}/${trace.summary.totalContextCost}`,
    `  context_reduction: ${formatRatio(trace.summary.contextReductionRatio)}`,
    "",
    "validation:",
    `  no_vector_mode: ${formatBool(trace.validation.noVectorMode)}`,
    `  materialized_top_candidate: ${formatBool(trace.validation.materializedTopCandidate)}`,
    `  blocked_evidence_pruned: ${formatBool(trace.validation.blockedEvidencePruned)}`,
    `  selected_context_reduced: ${formatBool(trace.validation.selectedContextReduced)}`,
    "",
    "candidates:",
    ...trace.candidates.map(
      (row) =>
        `  - ${row.candidateId} action=${row.action} score=${formatScore(row.finalScore)} semantic=${formatScore(row.semanticScore)} blocked=${formatBool(row.blocked)} reason=${row.reason}`,
    ),
    "",
    "frontier:",
    ...trace.frontier.map(
      (row) =>
        `  - #${row.rank} ${row.candidateId} selected=${formatBool(row.selected)} action=${row.action} budget=${row.contextBudget} judgement=${row.judgementKind}`,
    ),
    "",
    "planner:",
    ...trace.plannerActions.map(
      (row) =>
        `  - ${row.actionKind} candidate=${row.candidateId}${row.targetCandidateId ? ` target=${row.targetCandidateId}` : ""} llm=${formatBool(row.requiresLlmJudgement)} cycle=${formatBool(row.cycleAllowed)} reason=${row.reason}`,
    ),
    "",
    "retrieval_routes:",
    ...(retrievalRoutes.length > 0
      ? retrievalRoutes.map(
          (row) =>
            `  - candidate=${row.candidateId} owner=${row.materializationOwner} primary=${row.primaryTransport} source=${row.sourcePath}${row.headingAnchor ? ` anchor=${row.headingAnchor}` : ""} direct_file_read=${formatBool(row.directFileReadAllowed)} flight_steps=${formatRouteSteps(row.flightSteps)} http_fallback_steps=${formatRouteSteps(row.studioHttpFallbackSteps)}`,
        )
      : ["  - none"]),
    "",
    "llm_interactions:",
    ...(llmActions.length > 0
      ? llmActions.map(
          (row) =>
            `  - planned action=${row.actionKind} candidate=${row.candidateId}${row.targetCandidateId ? ` target=${row.targetCandidateId}` : ""} reason=${row.reason}`,
        )
      : ["  - none"]),
    ...(agentTrace
      ? [
          `  - live status=${agentTrace.status}${agentTrace.model ? ` model=${agentTrace.model}` : ""}${agentTrace.durationMs === undefined ? "" : ` duration_ms=${agentTrace.durationMs}`}${agentTrace.cached === undefined ? "" : ` cached=${formatBool(agentTrace.cached)}`}${agentTrace.reason ? ` reason=${agentTrace.reason}` : ""}`,
          ...renderAgentOutputs(agentTrace),
        ]
      : []),
    "",
    "subagent_interactions:",
    ...(llmActions.length > 0
      ? llmActions.map(
          (row) =>
            `  - planned type=pi-wendao-output-only activity=SearchStrategyFlow_QueryUnderstanding action=${row.actionKind} candidate=${row.candidateId}`,
        )
      : ["  - none"]),
    ...(agentTrace?.events ?? []).map((event) => {
      if (event.kind === "tool_call" || event.kind === "tool_result") {
        return `  - live ${event.kind} activity=${event.activityId} tool=${event.toolName}${event.agentId ? ` agent=${event.agentId}` : ""}${event.isError === undefined ? "" : ` error=${formatBool(event.isError)}`}`;
      }
      const resultSnippet =
        event.kind === "result" && event.resultText ? ` result=${formatSnippet(event.resultText)}` : "";
      return `  - live ${event.kind} activity=${event.activityId}${event.agentId ? ` agent=${event.agentId}` : ""} description=${event.description}${resultSnippet}`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

function formatBool(value: boolean): string {
  return value ? "yes" : "no";
}

function formatScore(value: number): string {
  return value.toFixed(3);
}

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSnippet(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
}

function renderAgentOutputs(agentTrace: SearchStrategyFlowAgentTrace): string[] {
  return [
    renderAgentOutput(agentTrace, "intent_understanding"),
    renderAgentOutput(agentTrace, "branch_decision"),
    renderAgentOutput(agentTrace, "judgement"),
  ].filter((line): line is string => Boolean(line));
}

function renderAgentOutput(
  agentTrace: SearchStrategyFlowAgentTrace,
  key: "intent_understanding" | "branch_decision" | "judgement",
): string | undefined {
  const value = agentTrace.output?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? `  - live ${key}=${formatSnippet(value)}`
    : undefined;
}

function formatRouteSteps(steps: { step: string; route: string }[]): string {
  return steps.map((step) => `${step.step}:${step.route}`).join(" -> ");
}
