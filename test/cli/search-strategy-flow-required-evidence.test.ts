import { describe, expect, it } from "vitest";
import { compactSearchStrategyFlowTraceForAgent } from "../../src/cli/search/strategy-flow-agent.js";
import {
  buildSearchStrategyFlowBranchContexts,
  inferSearchStrategyFlowRouteRole,
} from "../../src/cli/search/strategy-flow-branch-context.js";
import type { SearchStrategyFlowTrace } from "../../src/cli/search/strategy-flow-types.js";

describe("SearchStrategyFlow required evidence trace", () => {
  it("treats authority as a first-class branch role", () => {
    expect(
      inferSearchStrategyFlowRouteRole(
        "docs/30_search_strategy/30.01_search_strategy_flow.md#ownership-boundary",
      ),
    ).toBe("authority");
    expect(inferSearchStrategyFlowRouteRole("docs/90_validation/90.01_validation.md#package-test")).toBe(
      "validation",
    );
    expect(
      inferSearchStrategyFlowRouteRole(
        "packages/rust/crates/xiuxian-wendao-julia/tests/unit/integration_support/wendaograph/search_strategy.rs#search-strategy-flow-link-graph-python-julia-toml",
      ),
    ).toBe("link_graph");

    const contexts = buildSearchStrategyFlowBranchContexts(sampleTrace());
    const authority = contexts.find((branch) => branch.routeRole === "authority");
    const linkGraph = contexts.find((branch) => branch.routeRole === "link_graph");

    expect(authority?.candidateId).toBe(
      "docs/30_search_strategy/30.01_search_strategy_flow.md#ownership-boundary",
    );
    expect(authority?.routePurpose).toContain("ownership");
    expect(authority?.derivedHints.probeRecommendations).toContain(
      "verify_authority:docs/30_search_strategy/30.01_search_strategy_flow.md#ownership-boundary",
    );
    expect(linkGraph?.derivedHints.structuralGaps).not.toContain("missing_link_graph_branch");
    expect(linkGraph?.derivedHints.structuralGaps).not.toContain("missing_search_strategy_branch");
    expect(linkGraph?.derivedHints.structuralGaps).not.toContain(
      "link_graph_branch_without_relation_anchor",
    );
    expect(linkGraph?.graphMaterializationStatus).toBe("structured-code-relation-substitute");
    expect(linkGraph?.evidenceAnchors).toContain(
      "structured-code-relation:node:search-strategy-flow-link-graph-python-julia-toml",
    );
    expect(linkGraph?.derivedHints.probeRecommendations).toContain(
      "open_structured_relation_context:packages/rust/crates/xiuxian-wendao-julia/tests/unit/integration_support/wendaograph/search_strategy.rs#search-strategy-flow-link-graph-python-julia-toml",
    );
  });

  it("passes required-evidence coverage to the compact agent trace", () => {
    const compact = compactSearchStrategyFlowTraceForAgent(sampleTrace());

    expect(compact).toMatchObject({
      requiredEvidenceCoverage: {
        covered: true,
        selected: ["ownership_boundary", "validation_path", "relation_path"],
        missing: [],
      },
    });
    expect(compact.frontierBranches).toContainEqual(
      expect.objectContaining({
        source: "frontier",
        role: "link_graph",
        graphMaterializationStatus: "structured-code-relation-substitute",
      }),
    );
    expect(compact.frontierBranches).toContainEqual(
      expect.objectContaining({
        id: "docs/rfcs/2026-05-04-polyglot-compute-orchestrator-rfc.md#boundary-calibration",
        source: "candidate_pool",
        selected: false,
      }),
    );
    expect(compact).not.toHaveProperty("candidates");
    expect(compact).not.toHaveProperty("retrievalRoutes");
    expect(compact).toMatchObject({
      candidateSummary: {
        candidateInputSource: "rust-code-intelligence-inventory",
        candidateInputCount: 4,
        frontierCount: 3,
        selectedCount: 3,
      },
    });
  });

  it("keeps high-overlap candidate-pool rows visible under the agent cap", () => {
    const trace = sampleTrace();
    trace.intent =
      "Find the Markdown roadmap explaining projected documentation pages, page index, and graph-enhanced retrieval.";
    trace.candidates = [
      ...Array.from({ length: 24 }, (_, index) => ({
        candidateId: `docs/generated/noise-${index}.md#generic-supporting-note`,
        action: "keep",
        reason: "candidate pool row not selected by the deterministic frontier",
        finalScore: 0.9 - index * 0.001,
        evidenceCoverage: 0.8,
        graphScore: 0.8,
        authorityScore: 0.7,
        semanticScore: 0.7,
        structuralScore: 0.7,
        contextCost: 120,
        blocked: false,
      })),
      {
        candidateId:
          "packages/rust/crates/xiuxian-wendao/docs/06_roadmap/403_document_projection_and_retrieval_enhancement.md#run-retrieval-over-both-repository-records-and-projected-documentation-pages",
        action: "keep",
        reason: "candidate pool row not selected by the deterministic frontier",
        finalScore: 0.42,
        evidenceCoverage: 0.5,
        graphScore: 0.5,
        authorityScore: 0.4,
        semanticScore: 0.4,
        structuralScore: 0.4,
        contextCost: 120,
        blocked: false,
      },
    ];

    const compact = compactSearchStrategyFlowTraceForAgent(trace);
    const branches = compact.frontierBranches as Array<Record<string, unknown>>;

    expect(branches).toContainEqual(
      expect.objectContaining({
        id: "packages/rust/crates/xiuxian-wendao/docs/06_roadmap/403_document_projection_and_retrieval_enhancement.md#run-retrieval-over-both-repository-records-and-projected-documentation-pages",
        source: "candidate_pool",
      }),
    );
  });
});

function sampleTrace(): SearchStrategyFlowTrace {
  return {
    intent: "find the SearchStrategyFlow ownership boundary and validation path",
    backend: "wendao-graph-julia",
    graphProject: "/tmp/WendaoGraph.jl",
    searchRoot: "/tmp/WendaoGraph.jl",
    candidateInputSource: "rust-code-intelligence-inventory",
    candidateInputCount: 4,
    stageReceipts: [],
    queryUnderstanding: [
      {
        flowId: "pi-wendao-search-strategy-flow",
        intentId: "cli-intent-1",
        signalId: "cli-intent-1-signal-1",
        signalKind: "required_evidence",
        signalValue: "ownership_boundary",
        confidence: 0.82,
        routeHint: "authority",
        requiredEvidence: "ownership_boundary",
        ambiguity: 0.5,
        weight: 0.75,
        recommendedLoopBudget: 1,
        recommendedJudgementBudget: 2,
        recommendedBeamWidth: 3,
        reason: "required evidence inferred before LLM judgement",
      },
      {
        flowId: "pi-wendao-search-strategy-flow",
        intentId: "cli-intent-1",
        signalId: "cli-intent-1-signal-2",
        signalKind: "required_evidence",
        signalValue: "validation_path",
        confidence: 0.82,
        routeHint: "validation",
        requiredEvidence: "validation_path",
        ambiguity: 0.5,
        weight: 0.75,
        recommendedLoopBudget: 1,
        recommendedJudgementBudget: 2,
        recommendedBeamWidth: 3,
        reason: "required evidence inferred before LLM judgement",
      },
      {
        flowId: "pi-wendao-search-strategy-flow",
        intentId: "cli-intent-1",
        signalId: "cli-intent-1-signal-3",
        signalKind: "required_evidence",
        signalValue: "relation_path",
        confidence: 0.82,
        routeHint: "link_graph",
        requiredEvidence: "relation_path",
        ambiguity: 0.5,
        weight: 0.75,
        recommendedLoopBudget: 1,
        recommendedJudgementBudget: 2,
        recommendedBeamWidth: 3,
        reason: "required evidence inferred before LLM judgement",
      },
    ],
    candidates: [
      {
        candidateId:
          "docs/rfcs/2026-05-04-polyglot-compute-orchestrator-rfc.md#boundary-calibration",
        action: "keep",
        reason: "candidate pool row not selected by the deterministic frontier",
        finalScore: 0.77,
        evidenceCoverage: 0.8,
        graphScore: 0.75,
        authorityScore: 0.74,
        semanticScore: 0.7,
        structuralScore: 0.72,
        contextCost: 180,
        blocked: false,
      },
    ],
    frontier: [
      {
        candidateId: "docs/30_search_strategy/30.01_search_strategy_flow.md#ownership-boundary",
        rank: 1,
        selected: true,
        finalScore: 0.88,
        action: "keep",
        contextBudget: 160,
        judgementKind: "graph_verified_candidate",
      },
      {
        candidateId: "docs/90_validation/90.01_validation.md#package-test",
        rank: 2,
        selected: true,
        finalScore: 0.8,
        action: "keep",
        contextBudget: 160,
        judgementKind: "graph_verified_candidate",
      },
      {
        candidateId:
          "packages/rust/crates/xiuxian-wendao-julia/tests/unit/integration_support/wendaograph/search_strategy.rs#search-strategy-flow-link-graph-python-julia-toml",
        rank: 3,
        selected: true,
        finalScore: 0.79,
        action: "keep",
        contextBudget: 160,
        judgementKind: "graph_verified_candidate",
      },
    ],
    plannerActions: [],
    retrievalRoutes: [
      {
        candidateId: "docs/30_search_strategy/30.01_search_strategy_flow.md#ownership-boundary",
        materializationOwner: "studio-rust",
        materializationStatus: "planned",
        receiptSource: "local-plan",
        primaryTransport: "arrow-flight",
        sourcePath: "docs/30_search_strategy/30.01_search_strategy_flow.md",
        headingAnchor: "ownership-boundary",
        directFileReadAllowed: false,
        executeBeforeAnswer: true,
        flightSteps: [],
      },
      {
        candidateId: "docs/90_validation/90.01_validation.md#package-test",
        materializationOwner: "studio-rust",
        materializationStatus: "planned",
        receiptSource: "local-plan",
        primaryTransport: "arrow-flight",
        sourcePath: "docs/90_validation/90.01_validation.md",
        headingAnchor: "package-test",
        directFileReadAllowed: false,
        executeBeforeAnswer: true,
        flightSteps: [],
      },
      {
        candidateId:
          "packages/rust/crates/xiuxian-wendao-julia/tests/unit/integration_support/wendaograph/search_strategy.rs#search-strategy-flow-link-graph-python-julia-toml",
        materializationOwner: "studio-rust",
        materializationStatus: "executed",
        receiptSource: "rust-bridge",
        primaryTransport: "arrow-flight",
        sourcePath:
          "packages/rust/crates/xiuxian-wendao-julia/tests/unit/integration_support/wendaograph/search_strategy.rs",
        headingAnchor: "search-strategy-flow-link-graph-python-julia-toml",
        directFileReadAllowed: false,
        executeBeforeAnswer: true,
        materializedRows: 3,
        graphMaterializationStatus: "structured-code-relation-substitute",
        decodedPayloadReceipts: [
          {
            route: "/analysis/graph/neighbors",
            rowCount: 0,
            decodedColumns: ["rowType"],
            evidenceAnchor:
              "structured-code-relation:node:search-strategy-flow-link-graph-python-julia-toml",
          },
        ],
        flightSteps: [],
      },
    ],
    summary: {
      candidateCount: 3,
      selectedCount: 3,
      plannerActionCount: 0,
      totalContextCost: 480,
      selectedContextCost: 480,
      contextReductionRatio: 0,
    },
    validation: {
      noVectorMode: true,
      materializedTopCandidate: true,
      blockedEvidencePruned: true,
      selectedContextReduced: false,
      requiredEvidenceCovered: true,
      selectedRequiredEvidence: ["ownership_boundary", "validation_path", "relation_path"],
      missingRequiredEvidence: [],
    },
  };
}
