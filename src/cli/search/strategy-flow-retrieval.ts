import type {
  SearchStrategyFlowId,
  SearchStrategyFlowResolutionRequirement,
  SearchStrategyFlowRetrievalRoute,
  SearchStrategyFlowRetrievalStep,
  SearchStrategyFlowSourcePath,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";

const REPO_PLACEHOLDER = "<repo>";
const RESOLVED_PAGE_ID_PLACEHOLDER = "<resolved-page-id>";
const RESOLVED_NODE_ID_PLACEHOLDER = "<resolved-node-id>";
const RESOLVED_GRAPH_NODE_ID_PLACEHOLDER = "<resolved-graph-node-id>";

export function buildSearchStrategyFlowRetrievalRoutes(
  trace: SearchStrategyFlowTrace,
): SearchStrategyFlowRetrievalRoute[] {
  const selectedCandidateIds = new Set(
    trace.frontier.filter((row) => row.selected).map((row) => row.candidateId),
  );
  const actionCandidateIds = new Set(
    trace.plannerActions
      .filter((action) => action.actionKind !== "stop")
      .flatMap((action) =>
        action.targetCandidateId
          ? [action.candidateId, action.targetCandidateId]
          : [action.candidateId],
      ),
  );

  return trace.candidates
    .filter(
      (candidate) =>
        !candidate.blocked &&
        (selectedCandidateIds.has(candidate.candidateId) ||
          actionCandidateIds.has(candidate.candidateId)),
    )
    .map((candidate) => {
      const section = parseMarkdownSectionCandidateId(candidate.candidateId);
      return {
        candidateId: candidate.candidateId as SearchStrategyFlowId,
        ...(trace.candidateInputSource ? { candidateInputSource: trace.candidateInputSource } : {}),
        materializationOwner: "studio-rust",
        materializationStatus: "planned",
        receiptSource: "local-plan",
        primaryTransport: "arrow-flight",
        sourcePath: section.sourcePath as SearchStrategyFlowSourcePath,
        headingAnchor: section.headingAnchor,
        evidenceKind: evidenceKind(section),
        directFileReadAllowed: false,
        executeBeforeAnswer: true,
        flightSteps: flightSteps(section),
      };
    });
}

export function resolveSearchStrategyFlowRetrievalRoutes(
  trace: SearchStrategyFlowTrace,
): SearchStrategyFlowRetrievalRoute[] {
  return trace.retrievalRoutes && trace.retrievalRoutes.length > 0
    ? trace.retrievalRoutes
    : buildSearchStrategyFlowRetrievalRoutes(trace);
}

export function parseMarkdownSectionCandidateId(candidateId: string): {
  sourcePath: string;
  headingAnchor?: string;
} {
  const [sourcePath, headingAnchor] = candidateId.split("#", 2);
  return {
    sourcePath,
    ...(headingAnchor ? { headingAnchor } : {}),
  };
}

function flightSteps(section: {
  sourcePath: string;
  headingAnchor?: string;
}): SearchStrategyFlowRetrievalStep[] {
  const query = sectionQuery(section);
  return [
    {
      step: "flight_search_page",
      transport: "arrow-flight",
      route: "/search/repos/main",
      metadataTemplates: [
        `x-wendao-repo-search-repo=${REPO_PLACEHOLDER}`,
        `x-wendao-repo-search-query=${query}`,
        "x-wendao-repo-search-limit=5",
        `x-wendao-repo-search-path-prefixes=${section.sourcePath}`,
      ],
      note: "Resolve the Markdown section candidate to a page hit through native repo search.",
      requiresResolvedPageId: resolutionRequirement(false),
      requiresResolvedNodeId: resolutionRequirement(false),
      requiresResolvedGraphNodeId: resolutionRequirement(false),
    },
    {
      step: "flight_resolve_page_index_tree",
      transport: "arrow-flight",
      route: "/analysis/repo-projected-page-index-tree",
      metadataTemplates: [
        `x-wendao-repo-projected-page-index-tree-repo=${REPO_PLACEHOLDER}`,
        `x-wendao-repo-projected-page-index-tree-page-id=${RESOLVED_PAGE_ID_PLACEHOLDER}`,
        ...(section.headingAnchor ? [`candidate-heading-anchor=${section.headingAnchor}`] : []),
      ],
      note: "Select the concrete page-index node from the returned tree; do not treat the Markdown anchor as the node id.",
      requiresResolvedPageId: resolutionRequirement(true),
      requiresResolvedNodeId: resolutionRequirement(false),
      requiresResolvedGraphNodeId: resolutionRequirement(false),
    },
    {
      step: "flight_open_retrieval_context",
      transport: "arrow-flight",
      route: "/analysis/repo-projected-retrieval-context",
      metadataTemplates: [
        `x-wendao-repo-projected-retrieval-context-repo=${REPO_PLACEHOLDER}`,
        `x-wendao-repo-projected-retrieval-context-page-id=${RESOLVED_PAGE_ID_PLACEHOLDER}`,
        `x-wendao-repo-projected-retrieval-context-node-id=${RESOLVED_NODE_ID_PLACEHOLDER}`,
        "x-wendao-repo-projected-retrieval-context-related-limit=5",
      ],
      note: "Open the section-level projected retrieval context through the native Flight route.",
      requiresResolvedPageId: resolutionRequirement(true),
      requiresResolvedNodeId: resolutionRequirement(true),
      requiresResolvedGraphNodeId: resolutionRequirement(false),
    },
    {
      step: "flight_expand_graph_context",
      transport: "arrow-flight",
      route: "/graph/neighbors",
      metadataTemplates: [
        `x-wendao-graph-node-id=${RESOLVED_GRAPH_NODE_ID_PLACEHOLDER}`,
        "x-wendao-graph-direction=both",
        "x-wendao-graph-hops=2",
        "x-wendao-graph-limit=50",
      ],
      note: "Expand document-level graph context through the relation layer before the next reasoning-tree branch.",
      requiresResolvedPageId: resolutionRequirement(true),
      requiresResolvedNodeId: resolutionRequirement(true),
      requiresResolvedGraphNodeId: resolutionRequirement(true),
    },
  ];
}

function resolutionRequirement(value: boolean): SearchStrategyFlowResolutionRequirement {
  return value as SearchStrategyFlowResolutionRequirement;
}

function evidenceKind(section: { sourcePath: string; headingAnchor?: string }): string {
  const combined = `${section.sourcePath} ${section.headingAnchor ?? ""}`.toLowerCase();
  if (combined.includes("page_index") || combined.includes("page-index")) {
    return "page_index_reasoning_tree";
  }
  if (
    combined.includes("graph_compute") ||
    combined.includes("link_graph") ||
    combined.includes("link-graph")
  ) {
    return "link_graph_dependency_path";
  }
  if (combined.includes("validation")) {
    return "validation_guard";
  }
  if (combined.includes("notebook") || combined.includes("pluto")) {
    return "notebook_validation_surface";
  }
  return "search_strategy_flow_authority";
}

function sectionQuery(section: { sourcePath: string; headingAnchor?: string }): string {
  return section.headingAnchor
    ? `${section.sourcePath}#${section.headingAnchor}`
    : section.sourcePath;
}
