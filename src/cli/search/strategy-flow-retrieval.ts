import type {
  SearchStrategyFlowRetrievalRoute,
  SearchStrategyFlowRetrievalStep,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";

const STUDIO_REPO_PLACEHOLDER = "<repo>";
const RESOLVED_PAGE_ID_PLACEHOLDER = "<resolved-page-id>";
const RESOLVED_NODE_ID_PLACEHOLDER = "<resolved-node-id>";

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
        candidateId: candidate.candidateId,
        materializationOwner: "studio-rust",
        sourcePath: section.sourcePath,
        headingAnchor: section.headingAnchor,
        directFileReadAllowed: false,
        studioHttpSteps: studioHttpSteps(section),
        flightRouteHints: [
          "/search/intent",
          "/search/knowledge",
          "repo_search",
          "graph_neighbors",
          "repo_projected_page_index_tree",
        ],
      };
    });
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

function studioHttpSteps(section: {
  sourcePath: string;
  headingAnchor?: string;
}): SearchStrategyFlowRetrievalStep[] {
  const query = encodeURIComponent(
    section.headingAnchor
      ? `${section.sourcePath}#${section.headingAnchor}`
      : section.sourcePath,
  );
  const sourcePath = encodeURIComponent(section.sourcePath);
  const heading = section.headingAnchor
    ? `&query=${encodeURIComponent(section.headingAnchor)}`
    : "";
  return [
    {
      step: "search_page",
      routeTemplate: `/api/docs/retrieval?repo=${STUDIO_REPO_PLACEHOLDER}&query=${query}&limit=5`,
      requiresResolvedPageId: false,
      requiresResolvedNodeId: false,
    },
    {
      step: "resolve_page_index_node",
      routeTemplate: `/api/repo/projected-page-index-tree-search?repo=${STUDIO_REPO_PLACEHOLDER}&page_id=${RESOLVED_PAGE_ID_PLACEHOLDER}&source_path=${sourcePath}${heading}`,
      requiresResolvedPageId: true,
      requiresResolvedNodeId: false,
    },
    {
      step: "open_section_context",
      routeTemplate: `/api/docs/retrieval-context?repo=${STUDIO_REPO_PLACEHOLDER}&page_id=${RESOLVED_PAGE_ID_PLACEHOLDER}&node_id=${RESOLVED_NODE_ID_PLACEHOLDER}`,
      requiresResolvedPageId: true,
      requiresResolvedNodeId: true,
    },
  ];
}
