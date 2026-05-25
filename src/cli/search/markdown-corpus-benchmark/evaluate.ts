import type {
  SearchStrategyFlowAgentTrace,
  SearchStrategyFlowTrace,
} from "../strategy-flow-types.js";
import { WENDAO_ARROW_FLIGHT_DATA_PLANE } from "../../../arrow/boundary.js";
import type {
  SearchStrategyFlowMarkdownCorpusAgentRun,
  SearchStrategyFlowMarkdownCorpusBenchmarkRow,
  SearchStrategyFlowMarkdownCorpusIntentRow,
} from "./types.js";

export function evaluateMarkdownCorpusBenchmarkRow(
  intentRow: SearchStrategyFlowMarkdownCorpusIntentRow,
  trace: SearchStrategyFlowTrace,
  agentTrace?: SearchStrategyFlowAgentTrace,
  agentRun?: SearchStrategyFlowMarkdownCorpusAgentRun,
): SearchStrategyFlowMarkdownCorpusBenchmarkRow {
  const selectedCandidateIds = trace.frontier
    .filter((frontierRow) => frontierRow.selected)
    .map((frontierRow) => frontierRow.candidateId);
  const selectedRequiredEvidence = trace.validation.selectedRequiredEvidence ?? [];
  const missingRequiredEvidence = intentRow.requiredEvidence.filter(
    (evidence) => !selectedRequiredEvidence.includes(evidence),
  );
  const requiredEvidenceCovered =
    missingRequiredEvidence.length === 0 && trace.validation.requiredEvidenceCovered !== false;
  const expectedSourceHit = intentRow.expectedSourcePaths.some((sourcePath) =>
    selectedCandidateIds.some((candidateId) => candidateIdStartsWithSource(candidateId, sourcePath)),
  );
  const blockedSourceSelected = intentRow.blockedSourcePaths.some((sourcePath) =>
    selectedCandidateIds.some((candidateId) => candidateIdStartsWithSource(candidateId, sourcePath)),
  );
  const liveToolUseCount = agentTrace
    ? agentTrace.events.filter((event) => event.kind === "tool_call").length
    : undefined;
  const violations = benchmarkViolations({
    trace,
    agentTrace,
    liveToolUseCount,
    requiredEvidenceCovered,
    expectedSourceHit,
    blockedSourceSelected,
  });
  const executionMode = benchmarkExecutionMode(trace);
  const firstRetrievalRoute = trace.retrievalRoutes?.[0];
  const routeMaterialization = summarizeRouteMaterialization(trace);
  return {
    familyId: intentRow.familyId,
    intent: intentRow.intent,
    backend: trace.backend,
    controlPlane: trace.controlPlane,
    executionMode,
    promotionEligible: executionMode === "production" && violations.length === 0,
    rustBridgeFallback: trace.rustBridge?.fallback,
    candidateInputSource: trace.candidateInputSource,
    candidateInputCount: trace.candidateInputCount,
    candidateDiscoveryMs: trace.candidateInputDiscovery?.elapsedMs,
    candidateDiscoveryAttemptCount: trace.candidateInputDiscovery?.attemptCount,
    selectedCount: selectedCandidateIds.length,
    selectedCandidateIds,
    requiredEvidence: intentRow.requiredEvidence,
    selectedRequiredEvidence,
    missingRequiredEvidence,
    requiredEvidenceCovered,
    expectedSourceHit,
    expectedSourcePaths: intentRow.expectedSourcePaths,
    blockedSourceSelected,
    blockedSourcePaths: intentRow.blockedSourcePaths,
    retrievalReceiptSource: firstRetrievalRoute?.receiptSource,
    retrievalPrimaryTransport: firstRetrievalRoute?.primaryTransport,
    routeMaterializationRouteCount: routeMaterialization.routeCount,
    routeMaterializationMs: routeMaterialization.totalMs,
    routeMaterializationMaxRouteMs: routeMaterialization.maxRouteMs,
    liveStatus: agentTrace?.status,
    liveModel: agentTrace?.model,
    liveDurationMs: agentTrace?.durationMs,
    liveReason: agentTrace?.reason,
    liveToolUseCount,
    liveBranchJudgementCount: agentTrace?.branchJudgementValidation?.acceptedCount,
    liveAttemptCount: agentRun?.attemptCount,
    liveRetryCount: agentRun?.retryCount,
    liveRetryReasons: agentRun?.retryReasons,
    liveCandidatePoolMode: agentRun?.candidatePoolMode,
    liveAgentMode: agentRun?.liveAgentMode,
    liveBatchId: agentRun?.batchId,
    liveBatchSize: agentRun?.batchSize,
    liveBatchDurationMs: agentRun?.batchDurationMs,
    liveSufficient: agentRun?.sufficient,
    liveSufficiencyReason: agentRun?.sufficiencyReason,
    promotionStatus: intentRow.promotionStatus,
    passed: violations.length === 0,
    violations,
  };
}

function summarizeRouteMaterialization(trace: SearchStrategyFlowTrace): {
  routeCount: number | undefined;
  totalMs: number | undefined;
  maxRouteMs: number | undefined;
} {
  const elapsedMs = (trace.retrievalRoutes ?? [])
    .flatMap((route) => route.routeReceipts ?? [])
    .map((receipt) => receipt.elapsedMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (elapsedMs.length === 0) {
    return {
      routeCount: undefined,
      totalMs: undefined,
      maxRouteMs: undefined,
    };
  }
  return {
    routeCount: elapsedMs.length,
    totalMs: elapsedMs.reduce((sum, value) => sum + value, 0),
    maxRouteMs: Math.max(...elapsedMs),
  };
}

function benchmarkViolations(input: {
  trace: SearchStrategyFlowTrace;
  agentTrace?: SearchStrategyFlowAgentTrace;
  liveToolUseCount: number | undefined;
  requiredEvidenceCovered: boolean;
  expectedSourceHit: boolean;
  blockedSourceSelected: boolean;
}): string[] {
  const violations: string[] = [];
  if (input.trace.backend !== "rust-wendao-julia") violations.push("backend_not_rust_wendao_julia");
  if (input.trace.controlPlane !== "rust") violations.push("control_plane_not_rust");
  if (input.trace.rustBridge?.fallback !== "none") violations.push("rust_bridge_fallback");
  if (!input.requiredEvidenceCovered) violations.push("required_evidence_missing");
  if (!input.expectedSourceHit) violations.push("expected_source_missing");
  if (input.blockedSourceSelected) violations.push("blocked_source_selected");
  if (input.agentTrace) {
    if (input.agentTrace.status !== "completed") violations.push("live_agent_not_completed");
    if ((input.liveToolUseCount ?? 0) > 0) violations.push("live_agent_used_tools");
    if (input.agentTrace.branchJudgementValidation?.valid === false) {
      violations.push("live_branch_judgement_invalid");
    }
  }
  return violations;
}

function benchmarkExecutionMode(trace: SearchStrategyFlowTrace): "development" | "production" {
  if (isProductionArrowFlightTrace(trace)) {
    return "production";
  }
  if (
    trace.rustBridge?.mode === "cargo" ||
    trace.rustBridge?.mode === "direct-binary" ||
    trace.rustBridge?.mode === "persistent-stdio"
  ) {
    return "development";
  }
  return "production";
}

function isProductionArrowFlightTrace(trace: SearchStrategyFlowTrace): boolean {
  return (
    trace.strategyFlowDataPlane === WENDAO_ARROW_FLIGHT_DATA_PLANE &&
    trace.strategyFlowService?.dataPlane === WENDAO_ARROW_FLIGHT_DATA_PLANE &&
    (trace.retrievalRoutes ?? []).some((route) => (
      route.materializationStatus === "executed" &&
      route.primaryTransport === WENDAO_ARROW_FLIGHT_DATA_PLANE
    ))
  );
}

function candidateIdStartsWithSource(candidateId: string, sourcePath: string): boolean {
  return candidateId === sourcePath || candidateId.startsWith(`${sourcePath}#`);
}
