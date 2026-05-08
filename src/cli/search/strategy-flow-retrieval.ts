import type {
  SearchStrategyFlowRetrievalRoute,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";

const STUDIO_REPO_PLACEHOLDER = "<repo>";

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
        studioHttpRouteTemplates: studioHttpRouteTemplates(section),
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

function studioHttpRouteTemplates(section: {
  sourcePath: string;
  headingAnchor?: string;
}): string[] {
  const pageId = encodeURIComponent(section.sourcePath);
  const node = section.headingAnchor
    ? `&node_id=${encodeURIComponent(section.headingAnchor)}`
    : "";
  return [
    `/api/docs/retrieval-hit?repo=${STUDIO_REPO_PLACEHOLDER}&page_id=${pageId}${node}`,
    `/api/docs/retrieval-context?repo=${STUDIO_REPO_PLACEHOLDER}&page_id=${pageId}${node}`,
    `/api/repo/projected-retrieval-hit?repo=${STUDIO_REPO_PLACEHOLDER}&page_id=${pageId}${node}`,
    `/api/repo/projected-retrieval-context?repo=${STUDIO_REPO_PLACEHOLDER}&page_id=${pageId}${node}`,
  ];
}
