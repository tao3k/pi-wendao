import { resolveSearchStrategyFlowRetrievalRoutes } from "./strategy-flow-retrieval.js";
import type {
  SearchStrategyFlowDecodedPayloadReceipt,
  SearchStrategyFlowRetrievalRoute,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";

export type SearchStrategyFlowRouteRole =
  | "search_strategy"
  | "page_index"
  | "link_graph"
  | "validation"
  | "general";

export interface SearchStrategyFlowBranchContext {
  candidateId: string;
  routeRole: SearchStrategyFlowRouteRole;
  routePurpose: string;
  selected: boolean;
  frontierRank?: number;
  judgementKind?: string;
  actionKind?: string;
  compareTargetId?: string;
  materializationStatus?: SearchStrategyFlowRetrievalRoute["materializationStatus"];
  materializedRows?: number;
  sourcePath?: string;
  headingAnchor?: string;
  resolvedGraphNodeId?: string;
  evidenceAnchors: string[];
}

export function buildSearchStrategyFlowBranchContexts(
  trace: SearchStrategyFlowTrace,
): SearchStrategyFlowBranchContext[] {
  const retrievalByCandidate = new Map(
    resolveSearchStrategyFlowRetrievalRoutes(trace).map((route) => [
      String(route.candidateId),
      route,
    ]),
  );
  const actionByCandidate = new Map(
    trace.plannerActions
      .filter((action) => action.actionKind !== "stop")
      .map((action) => [action.candidateId, action]),
  );

  return trace.frontier
    .filter((row) => row.selected || actionByCandidate.has(row.candidateId))
    .map((row) => {
      const route = retrievalByCandidate.get(row.candidateId);
      const action = actionByCandidate.get(row.candidateId);
      const role = inferSearchStrategyFlowRouteRole(route?.sourcePath ?? row.candidateId);
      return {
        candidateId: row.candidateId,
        routeRole: role,
        routePurpose: routePurpose(role),
        selected: row.selected,
        frontierRank: row.rank,
        judgementKind: row.judgementKind,
        actionKind: action?.actionKind,
        compareTargetId: action?.targetCandidateId || undefined,
        materializationStatus: route?.materializationStatus,
        materializedRows: route?.materializedRows,
        sourcePath: route?.sourcePath,
        headingAnchor: route?.headingAnchor,
        resolvedGraphNodeId: route?.resolvedGraphNodeId,
        evidenceAnchors: evidenceAnchors(route),
      };
    });
}

export function inferSearchStrategyFlowRouteRole(value: string): SearchStrategyFlowRouteRole {
  const normalized = value.toLowerCase();
  if (
    normalized.includes("docs/30_search_strategy") ||
    normalized.includes("search_strategy_flow") ||
    normalized.includes("search-strategy-flow") ||
    normalized.includes("searchstrategyflow")
  ) {
    return "search_strategy";
  }
  if (
    normalized.includes("docs/20_page_index") ||
    normalized.includes("page_index") ||
    normalized.includes("page-index") ||
    normalized.includes("pageindex") ||
    normalized.includes("reasoning_tree") ||
    normalized.includes("reasoning-tree")
  ) {
    return "page_index";
  }
  if (
    normalized.includes("docs/10_graph_compute") ||
    normalized.includes("link_graph") ||
    normalized.includes("link-graph") ||
    normalized.includes("linkgraph") ||
    normalized.includes("graph_compute") ||
    normalized.includes("graph-compute") ||
    normalized.includes("relation")
  ) {
    return "link_graph";
  }
  if (
    normalized.includes("docs/90_validation") ||
    normalized.includes("validation") ||
    normalized.includes("verify") ||
    normalized.includes("gate")
  ) {
    return "validation";
  }

  return "general";
}

function routePurpose(role: SearchStrategyFlowRouteRole): string {
  switch (role) {
    case "search_strategy":
      return "Normalize intent, strategy loop, and first-layer branch policy.";
    case "page_index":
      return "Expose section-level reasoning tree contracts and page-index boundaries.";
    case "link_graph":
      return "Expose relation, graph-neighbor, and evidence fanout context.";
    case "validation":
      return "Check promotion, guardrail, and validation evidence.";
    case "general":
      return "Provide supporting context that does not map to a specialized route.";
  }
}

function evidenceAnchors(route: SearchStrategyFlowRetrievalRoute | undefined): string[] {
  if (!route?.decodedPayloadReceipts) {
    return [];
  }
  return route.decodedPayloadReceipts
    .map((receipt: SearchStrategyFlowDecodedPayloadReceipt) => receipt.evidenceAnchor)
    .filter((anchor) => anchor.trim().length > 0);
}
