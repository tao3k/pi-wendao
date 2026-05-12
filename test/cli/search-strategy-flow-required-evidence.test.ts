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

    const contexts = buildSearchStrategyFlowBranchContexts(sampleTrace());
    const authority = contexts.find((branch) => branch.routeRole === "authority");

    expect(authority?.candidateId).toBe(
      "docs/30_search_strategy/30.01_search_strategy_flow.md#ownership-boundary",
    );
    expect(authority?.routePurpose).toContain("ownership");
    expect(authority?.derivedHints.probeRecommendations).toContain(
      "verify_authority:docs/30_search_strategy/30.01_search_strategy_flow.md#ownership-boundary",
    );
  });

  it("passes required-evidence coverage to the compact agent trace", () => {
    const compact = compactSearchStrategyFlowTraceForAgent(sampleTrace());

    expect(compact).toMatchObject({
      requiredEvidenceCoverage: {
        covered: true,
        selected: ["ownership_boundary", "validation_path"],
        missing: [],
      },
    });
  });
});

function sampleTrace(): SearchStrategyFlowTrace {
  return {
    intent: "find the SearchStrategyFlow ownership boundary and validation path",
    backend: "wendao-graph-julia",
    graphProject: "/tmp/WendaoGraph.jl",
    searchRoot: "/tmp/WendaoGraph.jl",
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
    ],
    candidates: [],
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
    ],
    summary: {
      candidateCount: 2,
      selectedCount: 2,
      plannerActionCount: 0,
      totalContextCost: 320,
      selectedContextCost: 320,
      contextReductionRatio: 0,
    },
    validation: {
      noVectorMode: true,
      materializedTopCandidate: true,
      blockedEvidencePruned: true,
      selectedContextReduced: false,
      requiredEvidenceCovered: true,
      selectedRequiredEvidence: ["ownership_boundary", "validation_path"],
      missingRequiredEvidence: [],
    },
  };
}
