export interface SearchStrategyFlowOptions {
  intent: string;
  cwd: string;
  wendaoGraphPath?: string;
  juliaCommand?: string;
  searchRoot?: string;
  searchBackend?: SearchStrategyFlowBackend;
  rustWorkspace?: string;
  rustCommand?: string;
}

export type SearchStrategyFlowBackend = "auto" | "rust-julia" | "julia-direct";

declare const searchStrategyFlowIdBrand: unique symbol;
declare const searchStrategyFlowIntentIdBrand: unique symbol;
declare const searchStrategyFlowSignalIdBrand: unique symbol;

export type SearchStrategyFlowId = string & {
  readonly [searchStrategyFlowIdBrand]: "SearchStrategyFlowId";
};
export type SearchStrategyFlowIntentId = string & {
  readonly [searchStrategyFlowIntentIdBrand]: "SearchStrategyFlowIntentId";
};
export type SearchStrategyFlowSignalId = string & {
  readonly [searchStrategyFlowSignalIdBrand]: "SearchStrategyFlowSignalId";
};

export interface SearchStrategyFlowBridgeTrace {
  requestedBackend: SearchStrategyFlowBackend;
  attempted: boolean;
  rustWorkspace?: string;
  fallback: "none" | "julia-direct";
  error?: string;
}

export interface SearchStrategyFlowTrace {
  intent: string;
  backend: string;
  controlPlane?: string;
  juliaProject?: string;
  graphProject: string;
  searchRoot: string;
  rustBridge?: SearchStrategyFlowBridgeTrace;
  queryUnderstanding?: SearchStrategyFlowQueryUnderstandingRow[];
  strategyBudget?: SearchStrategyFlowBudget;
  stageReceipts: SearchStrategyFlowStageReceipt[];
  candidates: SearchStrategyFlowCandidate[];
  frontier: SearchStrategyFlowFrontierRow[];
  plannerActions: SearchStrategyFlowPlannerAction[];
  summary: SearchStrategyFlowSummary;
  validation: SearchStrategyFlowValidation;
}

export interface SearchStrategyFlowRetrievalRoute {
  candidateId: string;
  materializationOwner: "studio-rust";
  primaryTransport: "arrow-flight";
  sourcePath: string;
  headingAnchor?: string;
  directFileReadAllowed: false;
  flightSteps: SearchStrategyFlowRetrievalStep[];
  studioHttpFallbackSteps: SearchStrategyFlowRetrievalStep[];
}

export interface SearchStrategyFlowRetrievalStep {
  step:
    | "flight_search_page"
    | "flight_resolve_page_index_tree"
    | "flight_expand_graph_context"
    | "http_search_page"
    | "http_resolve_page_index_node"
    | "http_open_section_context";
  transport: "arrow-flight" | "studio-http";
  route: string;
  metadataTemplates: string[];
  note?: string;
  requiresResolvedPageId: boolean;
  requiresResolvedNodeId: boolean;
}

export interface SearchStrategyFlowAgentTrace {
  mode: "live-subagent";
  status: "completed" | "skipped" | "unavailable" | "failed";
  model?: string;
  durationMs?: number;
  cached?: boolean;
  reason?: string;
  events: SearchStrategyFlowAgentEvent[];
  output?: Record<string, unknown>;
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
  signalKind: string;
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
  judgementKind: string;
}

export interface SearchStrategyFlowPlannerAction {
  actionKind: string;
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
}
