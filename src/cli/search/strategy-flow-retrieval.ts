import type {
  SearchStrategyFlowRetrievalRoute,
  SearchStrategyFlowRetrievalStep,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";

const REPO_PLACEHOLDER = "<repo>";
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
        primaryTransport: "arrow-flight",
        sourcePath: section.sourcePath,
        headingAnchor: section.headingAnchor,
        directFileReadAllowed: false,
        flightSteps: flightSteps(section),
        studioHttpFallbackSteps: studioHttpFallbackSteps(section),
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
      requiresResolvedPageId: false,
      requiresResolvedNodeId: false,
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
      requiresResolvedPageId: true,
      requiresResolvedNodeId: false,
    },
    {
      step: "flight_expand_graph_context",
      transport: "arrow-flight",
      route: "/graph/neighbors",
      metadataTemplates: [
        `x-wendao-graph-node-id=${RESOLVED_NODE_ID_PLACEHOLDER}`,
        "x-wendao-graph-direction=both",
        "x-wendao-graph-hops=2",
        "x-wendao-graph-limit=50",
      ],
      note: "Expand section context through the graph relation layer before the next reasoning-tree branch.",
      requiresResolvedPageId: true,
      requiresResolvedNodeId: true,
    },
  ];
}

function studioHttpFallbackSteps(section: {
  sourcePath: string;
  headingAnchor?: string;
}): SearchStrategyFlowRetrievalStep[] {
  const query = encodeURIComponent(
    sectionQuery(section),
  );
  const sourcePath = encodeURIComponent(section.sourcePath);
  const heading = section.headingAnchor
    ? `&query=${encodeURIComponent(section.headingAnchor)}`
    : "";
  return [
    {
      step: "http_search_page",
      transport: "studio-http",
      route: `/api/docs/retrieval?repo=${REPO_PLACEHOLDER}&query=${query}&limit=5`,
      metadataTemplates: [],
      note: "HTTP fallback/debug equivalent for the native Flight search step.",
      requiresResolvedPageId: false,
      requiresResolvedNodeId: false,
    },
    {
      step: "http_resolve_page_index_node",
      transport: "studio-http",
      route: `/api/repo/projected-page-index-tree-search?repo=${REPO_PLACEHOLDER}&page_id=${RESOLVED_PAGE_ID_PLACEHOLDER}&source_path=${sourcePath}${heading}`,
      metadataTemplates: [],
      note: "HTTP fallback/debug equivalent for resolving the page-index node.",
      requiresResolvedPageId: true,
      requiresResolvedNodeId: false,
    },
    {
      step: "http_open_section_context",
      transport: "studio-http",
      route: `/api/docs/retrieval-context?repo=${REPO_PLACEHOLDER}&page_id=${RESOLVED_PAGE_ID_PLACEHOLDER}&node_id=${RESOLVED_NODE_ID_PLACEHOLDER}`,
      metadataTemplates: [],
      note: "HTTP fallback/debug context opener until the same retrieval-context materialization is exposed as a Flight descriptor.",
      requiresResolvedPageId: true,
      requiresResolvedNodeId: true,
    },
  ];
}

function sectionQuery(section: { sourcePath: string; headingAnchor?: string }): string {
  return section.headingAnchor
    ? `${section.sourcePath}#${section.headingAnchor}`
    : section.sourcePath;
}
