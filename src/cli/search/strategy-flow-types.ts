import type { WendaoArrowFlightDataPlane, WendaoTraceDataPlane } from "../../arrow/boundary.js";
import type { Branded } from "../../types/domain.js";

declare const searchStrategyFlowPathBrand: unique symbol;
declare const searchStrategyFlowFlightBaseUrlBrand: unique symbol;
declare const searchStrategyFlowServiceBaseUrlBrand: unique symbol;
declare const searchStrategyFlowFlightTimeoutSecondsBrand: unique symbol;
declare const searchStrategyFlowSourcePathBrand: unique symbol;
declare const searchStrategyFlowPageIdBrand: unique symbol;
declare const searchStrategyFlowNodeIdBrand: unique symbol;
declare const searchStrategyFlowGraphNodeIdBrand: unique symbol;
declare const searchStrategyFlowIdBrand: unique symbol;
declare const searchStrategyFlowIntentIdBrand: unique symbol;
declare const searchStrategyFlowSignalIdBrand: unique symbol;
declare const searchStrategyFlowResolutionRequirementBrand: unique symbol;

export type SearchStrategyFlowPath = string & {
  readonly [searchStrategyFlowPathBrand]: "SearchStrategyFlowPath";
};
export type SearchStrategyFlowFlightBaseUrl = string & {
  readonly [searchStrategyFlowFlightBaseUrlBrand]: "SearchStrategyFlowFlightBaseUrl";
};
export type SearchStrategyFlowServiceBaseUrl = string & {
  readonly [searchStrategyFlowServiceBaseUrlBrand]: "SearchStrategyFlowServiceBaseUrl";
};
export type SearchStrategyFlowFlightTimeoutSeconds = number & {
  readonly [searchStrategyFlowFlightTimeoutSecondsBrand]: "SearchStrategyFlowFlightTimeoutSeconds";
};
export type SearchStrategyFlowSourcePath = string & {
  readonly [searchStrategyFlowSourcePathBrand]: "SearchStrategyFlowSourcePath";
};
export type SearchStrategyFlowPageId = string & {
  readonly [searchStrategyFlowPageIdBrand]: "SearchStrategyFlowPageId";
};
export type SearchStrategyFlowNodeId = string & {
  readonly [searchStrategyFlowNodeIdBrand]: "SearchStrategyFlowNodeId";
};
export type SearchStrategyFlowGraphNodeId = string & {
  readonly [searchStrategyFlowGraphNodeIdBrand]: "SearchStrategyFlowGraphNodeId";
};
export type SearchStrategyFlowId = string & {
  readonly [searchStrategyFlowIdBrand]: "SearchStrategyFlowId";
};
export type SearchStrategyFlowIntentId = string & {
  readonly [searchStrategyFlowIntentIdBrand]: "SearchStrategyFlowIntentId";
};
export type SearchStrategyFlowSignalId = string & {
  readonly [searchStrategyFlowSignalIdBrand]: "SearchStrategyFlowSignalId";
};
export type SearchStrategyFlowResolutionRequirement = boolean & {
  readonly [searchStrategyFlowResolutionRequirementBrand]: "SearchStrategyFlowResolutionRequirement";
};

export interface SearchStrategyFlowOptions {
  intent: string;
  cwd: string;
  wendaoGraphPath?: SearchStrategyFlowPath;
  juliaCommand?: string;
  searchBackend?: SearchStrategyFlowBackend;
  rustWorkspace?: SearchStrategyFlowPath;
  rustCommand?: string;
  rustBridgeBinary?: SearchStrategyFlowPath;
  rustBridgeSession?: boolean;
  flightBaseUrl?: SearchStrategyFlowFlightBaseUrl;
  flightTimeoutSeconds?: SearchStrategyFlowFlightTimeoutSeconds;
  strategyFlowServiceBaseUrl?: SearchStrategyFlowServiceBaseUrl;
  strategyFlowServiceTimeoutSeconds?: SearchStrategyFlowFlightTimeoutSeconds;
  queryUnderstanding?: SearchStrategyFlowQueryUnderstandingRow[];
  branchJudgements?: SearchStrategyFlowBranchJudgementRow[];
}

export type SearchStrategyFlowBackend = "auto" | "rust-julia" | "julia-direct";
export type SearchStrategyFlowRustBridgeMode = "cargo" | "direct-binary" | "persistent-stdio";
export type SearchStrategyFlowCandidateDiscoveryMode = Branded<
  string,
  "SearchStrategyFlowCandidateDiscoveryMode"
>;
export type SearchStrategyFlowEvidenceKind = Branded<string, "SearchStrategyFlowEvidenceKind">;
export type SearchStrategyFlowSignalKind = Branded<string, "SearchStrategyFlowSignalKind">;
export type SearchStrategyFlowJudgementKind = Branded<string, "SearchStrategyFlowJudgementKind">;
export type SearchStrategyFlowPlannerActionKind = Branded<
  string,
  "SearchStrategyFlowPlannerActionKind"
>;

export interface SearchStrategyFlowBridgeTrace {
  requestedBackend: SearchStrategyFlowBackend;
  attempted: boolean;
  rustWorkspace?: string;
  mode?: SearchStrategyFlowRustBridgeMode;
  fallback: "none" | "julia-direct";
  error?: string;
}

export interface SearchStrategyFlowTrace {
  intent: string;
  backend: string;
  controlPlane?: string;
  strategyFlowDataPlane?: WendaoTraceDataPlane;
  strategyFlowService?: SearchStrategyFlowServiceTrace;
  candidateInputSource?: string;
  candidateInputCount?: number;
  juliaProject?: string;
  graphProject: string;
  searchRoot: string;
  rustBridge?: SearchStrategyFlowBridgeTrace;
  candidateInputDiscovery?: SearchStrategyFlowCandidateInputDiscovery;
  queryUnderstanding?: SearchStrategyFlowQueryUnderstandingRow[];
  strategyBudget?: SearchStrategyFlowBudget;
  stageReceipts: SearchStrategyFlowStageReceipt[];
  candidates: SearchStrategyFlowCandidate[];
  frontier: SearchStrategyFlowFrontierRow[];
  plannerActions: SearchStrategyFlowPlannerAction[];
  retrievalRoutes?: SearchStrategyFlowRetrievalRoute[];
  summary: SearchStrategyFlowSummary;
  validation: SearchStrategyFlowValidation;
}

export interface SearchStrategyFlowServiceTrace {
  dataPlane: WendaoArrowFlightDataPlane;
  baseUrl: string;
  flightRoute: string;
  timeoutSeconds: number;
}

export interface SearchStrategyFlowCandidateInputDiscovery {
  receiptSource?: string;
  candidateInputSource?: string;
  candidateInputCount?: number;
  repoId?: string;
  transport?: string;
  route?: string;
  candidateDiscoveryMode?: SearchStrategyFlowCandidateDiscoveryMode;
  attemptCount?: number;
  mergedCandidateCount?: number;
  elapsedMs?: number;
}

export interface SearchStrategyFlowRetrievalRoute {
  candidateId: SearchStrategyFlowId;
  candidateInputSource?: string;
  materializationOwner: "studio-rust";
  materializationStatus: "planned" | "executed";
  receiptSource: "local-plan" | "rust-bridge";
  primaryTransport: WendaoArrowFlightDataPlane;
  sourcePath: SearchStrategyFlowSourcePath;
  headingAnchor?: string;
  evidenceKind?: SearchStrategyFlowEvidenceKind;
  directFileReadAllowed: false;
  executeBeforeAnswer: true;
  materializedRows?: number;
  routeReceipts?: SearchStrategyFlowRouteReceipt[];
  decodedPayloadStatus?: "decoded";
  decodedPayloadReceipts?: SearchStrategyFlowDecodedPayloadReceipt[];
  resolvedPageId?: SearchStrategyFlowPageId;
  resolvedNodeId?: SearchStrategyFlowNodeId;
  resolvedGraphNodeId?: SearchStrategyFlowGraphNodeId;
  graphMaterializationStatus?: "resolved" | "missing" | "structured-code-relation-substitute";
  graphMaterializationWarning?: string;
  flightSteps: SearchStrategyFlowRetrievalStep[];
}

export interface SearchStrategyFlowRouteReceipt {
  route: string;
  rowCount: number;
  elapsedMs?: number;
}

export interface SearchStrategyFlowDecodedPayloadReceipt {
  route: string;
  rowCount: number;
  decodedColumns: string[];
  evidenceAnchor: string;
}

export interface SearchStrategyFlowRetrievalStep {
  step:
    | "flight_search_page"
    | "flight_resolve_page_index_tree"
    | "flight_open_retrieval_context"
    | "flight_expand_graph_context";
  transport: WendaoArrowFlightDataPlane;
  route: string;
  metadataTemplates: string[];
  note?: string;
  requiresResolvedPageId: SearchStrategyFlowResolutionRequirement;
  requiresResolvedNodeId: SearchStrategyFlowResolutionRequirement;
  requiresResolvedGraphNodeId: SearchStrategyFlowResolutionRequirement;
}

export interface SearchStrategyFlowAgentTrace {
  mode: "qianji-service-agent";
  status: "completed" | "skipped" | "unavailable" | "failed";
  model?: string;
  durationMs?: number;
  cached?: boolean;
  reason?: string;
  events: SearchStrategyFlowAgentEvent[];
  output?: Record<string, unknown>;
  branchJudgements?: SearchStrategyFlowBranchJudgementRow[];
  branchJudgementValidation?: SearchStrategyFlowBranchJudgementValidation;
}

export type SearchStrategyFlowBranchJudgementRole =
  | "search_strategy"
  | "authority"
  | "page_index"
  | "link_graph"
  | "validation"
  | "general";

export type SearchStrategyFlowBranchJudgementDecision =
  | "keep"
  | "expand"
  | "reject"
  | "prune"
  | "defer";

export interface SearchStrategyFlowBranchJudgementRow {
  flowId?: SearchStrategyFlowId;
  candidateId: string;
  branchRole: SearchStrategyFlowBranchJudgementRole;
  judgementScore: number;
  confidence: number;
  decision: SearchStrategyFlowBranchJudgementDecision;
  blocked: boolean;
  reason: string;
}

export interface SearchStrategyFlowBranchJudgementValidation {
  valid: boolean;
  acceptedCount: number;
  errors: string[];
}

export type SearchStrategyFlowAgentEvent =
  | {
      kind: "spawned" | "resumed" | "waiting" | "result";
      activityId: string;
      agentId?: string;
      description: string;
      resultText?: string;
    }
  | {
      kind: "tool_call" | "tool_result";
      activityId: string;
      agentId?: string;
      description: string;
      toolName: string;
      isError?: boolean;
    };

export interface SearchStrategyFlowCandidate {
  candidateId: string;
  action: string;
  reason: string;
  finalScore: number;
  evidenceCoverage: number;
  graphScore: number;
  authorityScore: number;
  semanticScore: number;
  structuralScore: number;
  contextCost: number;
  blocked: boolean;
}

export interface SearchStrategyFlowQueryUnderstandingRow {
  flowId: SearchStrategyFlowId;
  intentId: SearchStrategyFlowIntentId;
  signalId: SearchStrategyFlowSignalId;
  signalKind: SearchStrategyFlowSignalKind;
  signalValue: string;
  confidence: number;
  routeHint: string;
  requiredEvidence: string;
  ambiguity: number;
  weight: number;
  recommendedLoopBudget: number;
  recommendedJudgementBudget: number;
  recommendedBeamWidth: number;
  reason: string;
}

export interface SearchStrategyFlowBudget {
  source: "query_understanding" | "default";
  loopBudget: number;
  judgementBudget: number;
  beamWidth: number;
}

export type SearchStrategyFlowStage =
  | "query_understanding"
  | "candidate_scoring"
  | "transition_inference"
  | "frontier_selection"
  | "planner_actions";

export interface SearchStrategyFlowStageReceipt {
  stage: SearchStrategyFlowStage;
  notebook: string;
  inputCount: number;
  outputCount: number;
  selectedCount: number;
  llmJudgementCount: number;
  cycleAllowedCount: number;
  contextBudget: number;
  summary: string;
}

export interface SearchStrategyFlowFrontierRow {
  candidateId: string;
  rank: number;
  selected: boolean;
  finalScore: number;
  action: string;
  contextBudget: number;
  judgementKind: SearchStrategyFlowJudgementKind;
}

export interface SearchStrategyFlowPlannerAction {
  actionKind: SearchStrategyFlowPlannerActionKind;
  candidateId: string;
  targetCandidateId: string;
  cycleAllowed: boolean;
  requiresLlmJudgement: boolean;
  score: number;
  contextBudget?: number;
  reason: string;
}

export interface SearchStrategyFlowSummary {
  candidateCount: number;
  selectedCount: number;
  plannerActionCount: number;
  totalContextCost: number;
  selectedContextCost: number;
  contextReductionRatio: number;
}

export interface SearchStrategyFlowValidation {
  noVectorMode: boolean;
  materializedTopCandidate: boolean;
  blockedEvidencePruned: boolean;
  selectedContextReduced: boolean;
  requiredEvidenceCovered?: boolean;
  selectedRequiredEvidence?: string[];
  missingRequiredEvidence?: string[];
}
