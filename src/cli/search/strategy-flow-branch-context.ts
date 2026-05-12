import { resolveSearchStrategyFlowRetrievalRoutes } from "./strategy-flow-retrieval.js";
import type {
  SearchStrategyFlowDecodedPayloadReceipt,
  SearchStrategyFlowGraphNodeId,
  SearchStrategyFlowId,
  SearchStrategyFlowRetrievalRoute,
  SearchStrategyFlowSourcePath,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";

export type SearchStrategyFlowRouteRole =
  | "search_strategy"
  | "authority"
  | "page_index"
  | "link_graph"
  | "validation"
  | "general";

export interface SearchStrategyFlowBranchContext {
  candidateId: SearchStrategyFlowId;
  routeRole: SearchStrategyFlowRouteRole;
  routePurpose: string;
  selected: boolean;
  frontierRank?: number;
  judgementKind?: string;
  actionKind?: string;
  compareTargetId?: SearchStrategyFlowId;
  materializationStatus?: SearchStrategyFlowRetrievalRoute["materializationStatus"];
  materializedRows?: number;
  sourcePath?: SearchStrategyFlowSourcePath;
  headingAnchor?: string;
  resolvedGraphNodeId?: SearchStrategyFlowGraphNodeId;
  graphMaterializationStatus?: SearchStrategyFlowRetrievalRoute["graphMaterializationStatus"];
  evidenceAnchors: string[];
  derivedHints: SearchStrategyFlowDerivedTraceHints;
}

export interface SearchStrategyFlowDerivedTraceHints {
  ambiguity: string[];
  structuralGaps: string[];
  probeRecommendations: string[];
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
      const role = inferSearchStrategyFlowRouteRole(
        [route?.sourcePath, route?.headingAnchor, row.candidateId].filter(Boolean).join("#"),
      );
      return {
        candidateId: row.candidateId as SearchStrategyFlowId,
        routeRole: role,
        routePurpose: routePurpose(role),
        selected: row.selected,
        frontierRank: row.rank,
        judgementKind: row.judgementKind,
        actionKind: action?.actionKind,
        compareTargetId: (action?.targetCandidateId || undefined) as
          | SearchStrategyFlowId
          | undefined,
        materializationStatus: route?.materializationStatus,
        materializedRows: route?.materializedRows,
        sourcePath: route?.sourcePath,
        headingAnchor: route?.headingAnchor,
        resolvedGraphNodeId: route?.resolvedGraphNodeId,
        graphMaterializationStatus: route?.graphMaterializationStatus,
        evidenceAnchors: evidenceAnchors(route),
        derivedHints: {
          ambiguity: ambiguityHints(trace, role, route, action?.targetCandidateId),
          structuralGaps: structuralGaps(trace, role, route),
          probeRecommendations: probeRecommendations(role, route, action?.targetCandidateId),
        },
      };
    });
}

export function inferSearchStrategyFlowRouteRole(value: string): SearchStrategyFlowRouteRole {
  const normalized = value.toLowerCase();
  if (
    normalized.includes("authority") ||
    normalized.includes("ownership") ||
    normalized.includes("owner-boundary") ||
    normalized.includes("ownership-boundary") ||
    normalized.includes("ownership_boundary") ||
    normalized.includes("package-owner") ||
    normalized.includes("source-authority") ||
    normalized.includes("ssot") ||
    normalized.includes("single-source-of-truth")
  ) {
    return "authority";
  }
  if (normalized.includes("docs/30_search_strategy")) {
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
    normalized.includes("docs/testing") ||
    normalized.includes("validation") ||
    normalized.includes("package-test") ||
    normalized.includes("verify") ||
    normalized.includes("gate")
  ) {
    return "validation";
  }
  if (
    normalized.includes("search_strategy_flow") ||
    normalized.includes("search-strategy-flow") ||
    normalized.includes("searchstrategyflow") ||
    normalized.includes("strategy-flow") ||
    normalized.includes("strategy flow")
  ) {
    return "search_strategy";
  }

  return "general";
}

function routePurpose(role: SearchStrategyFlowRouteRole): string {
  switch (role) {
    case "search_strategy":
      return "Normalize intent, strategy loop, and first-layer branch policy.";
    case "authority":
      return "Check ownership, SSOT, source authority, and provenance boundaries.";
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

function ambiguityHints(
  trace: SearchStrategyFlowTrace,
  role: SearchStrategyFlowRouteRole,
  route: SearchStrategyFlowRetrievalRoute | undefined,
  compareTargetId: string | undefined,
): string[] {
  const markers: string[] = [];
  const queryAmbiguity = maxQueryAmbiguity(trace);
  if (queryAmbiguity >= 0.55) {
    markers.push(`high_query_ambiguity:${queryAmbiguity.toFixed(2)}`);
  }
  if (compareTargetId) {
    markers.push(`compare_target:${inferSearchStrategyFlowRouteRole(compareTargetId)}`);
  }
  if (role === "general" && route?.sourcePath) {
    markers.push("general_branch_needs_role_confirmation");
  }
  if (route?.sourcePath === "README.md" || route?.sourcePath === "docs/index.md") {
    markers.push("index_page_candidate");
  }
  if (route?.headingAnchor?.includes("not-the-owner")) {
    markers.push("negative_boundary_anchor");
  }
  return markers;
}

function structuralGaps(
  trace: SearchStrategyFlowTrace,
  role: SearchStrategyFlowRouteRole,
  route: SearchStrategyFlowRetrievalRoute | undefined,
): string[] {
  const gaps: string[] = [];
  const selectedRoles = selectedRouteRoles(trace);
  const requiredRoles = requiredRouteRoles(trace);
  if (requiredRoles.has("search_strategy") && !selectedRoles.has("search_strategy")) {
    gaps.push("missing_search_strategy_branch");
  }
  if (requiredRoles.has("page_index") && !selectedRoles.has("page_index")) {
    gaps.push("missing_page_index_branch");
  }
  if (requiredRoles.has("link_graph") && !selectedRoles.has("link_graph")) {
    gaps.push("missing_link_graph_branch");
  }
  if (requiredRoles.has("authority") && !selectedRoles.has("authority")) {
    gaps.push("missing_authority_branch");
  }
  if (requiredRoles.has("validation") && !selectedRoles.has("validation")) {
    gaps.push("missing_validation_branch");
  }
  if (!route?.decodedPayloadReceipts || route.decodedPayloadReceipts.length === 0) {
    gaps.push("missing_decoded_evidence_anchors");
  }
  if (role === "link_graph" && route?.graphMaterializationStatus === "missing") {
    gaps.push("missing_link_graph_neighbor_receipt");
  }
  if (role === "page_index" && !route?.headingAnchor?.includes("reasoning")) {
    gaps.push("page_index_branch_without_reasoning_anchor");
  }
  if (
    role === "link_graph" &&
    !route?.headingAnchor?.includes("link-graph") &&
    !route?.headingAnchor?.includes("link_graph") &&
    !route?.headingAnchor?.includes("linkgraph") &&
    !route?.headingAnchor?.includes("relation")
  ) {
    gaps.push("link_graph_branch_without_relation_anchor");
  }
  if (role === "authority" && !route?.headingAnchor?.includes("ownership")) {
    gaps.push("authority_branch_without_ownership_anchor");
  }
  return [...new Set(gaps)];
}

function probeRecommendations(
  role: SearchStrategyFlowRouteRole,
  route: SearchStrategyFlowRetrievalRoute | undefined,
  compareTargetId: string | undefined,
): string[] {
  const actions: string[] = [];
  if (compareTargetId) {
    actions.push(`compare_provenance:${compareTargetId}`);
  }
  if (route?.resolvedGraphNodeId) {
    actions.push(`expand_neighbors:${route.resolvedGraphNodeId}`);
  } else if (
    role !== "link_graph" &&
    route?.graphMaterializationStatus === "structured-code-relation-substitute"
  ) {
    actions.push(`open_structured_relation_context:${route.candidateId}`);
  }
  if (role === "page_index") {
    actions.push(`open_parent_child:${route?.candidateId ?? "selected-page-index-branch"}`);
  }
  if (role === "link_graph") {
    actions.push(
      route?.graphMaterializationStatus === "structured-code-relation-substitute"
        ? `open_structured_relation_context:${route?.candidateId ?? "selected-link-graph-branch"}`
        : `expand_neighbors:${route?.resolvedGraphNodeId ?? "selected-link-graph-branch"}`,
    );
  }
  if (role === "authority") {
    actions.push(`verify_authority:${route?.candidateId ?? "selected-authority-branch"}`);
  }
  if (route?.sourcePath && route.headingAnchor) {
    actions.push(`open_adjacent_sections:${route.sourcePath}#${route.headingAnchor}`);
  }
  return actions;
}

function requiredRouteRoles(trace: SearchStrategyFlowTrace): Set<SearchStrategyFlowRouteRole> {
  const roles = new Set<SearchStrategyFlowRouteRole>();
  for (const row of trace.queryUnderstanding ?? []) {
    addRequiredEvidenceRole(roles, row.requiredEvidence);
  }
  return roles;
}

function addRequiredEvidenceRole(
  roles: Set<SearchStrategyFlowRouteRole>,
  requiredEvidence: string,
): void {
  switch (requiredEvidence) {
    case "ownership_boundary":
    case "freshness_or_staleness":
      roles.add("authority");
      return;
    case "validation_path":
      roles.add("validation");
      return;
    case "relation_path":
      roles.add("link_graph");
      return;
    case "page_index_seed":
      roles.add("page_index");
      return;
  }
}

function maxQueryAmbiguity(trace: SearchStrategyFlowTrace): number {
  return Math.max(0, ...(trace.queryUnderstanding ?? []).map((row) => row.ambiguity));
}

function selectedRouteRoles(trace: SearchStrategyFlowTrace): Set<SearchStrategyFlowRouteRole> {
  const selected = new Set(trace.frontier.filter((row) => row.selected).map((row) => row.candidateId));
  return new Set(
    resolveSearchStrategyFlowRetrievalRoutes(trace)
      .filter((route) => selected.has(route.candidateId))
      .map((route) =>
        inferSearchStrategyFlowRouteRole(
          [route.sourcePath, route.headingAnchor, route.candidateId].filter(Boolean).join("#"),
        ),
      ),
  );
}
