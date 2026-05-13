import { describe, expect, it } from "vitest";
import {
  parseSearchStrategyFlowBranchJudgements,
  renderSearchStrategyFlowBranchJudgementTsv,
} from "../../src/cli/search/strategy-flow-branch-judgement.js";
import { renderSearchStrategyFlowTrace } from "../../src/cli/search/strategy-flow-renderer.js";
import type {
  SearchStrategyFlowAgentTrace,
  SearchStrategyFlowTrace,
} from "../../src/cli/search/strategy-flow-types.js";

describe("SearchStrategyFlow branch judgement contract", () => {
  it("accepts exact candidate-scoped JSON rows for selected frontier branches", () => {
    const result = parseSearchStrategyFlowBranchJudgements(
      JSON.stringify([
        {
          candidate_id: "docs/a.md#owner",
          branch_role: "authority",
          judgement_score: 0.91,
          confidence: 0.82,
          decision: "keep",
          blocked: false,
          reason: "Ownership evidence is directly selected.",
        },
        {
          candidate_id: "docs/b.md#validation",
          branch_role: "validation",
          judgement_score: 0.78,
          confidence: 0.74,
          decision: "expand",
          blocked: false,
          reason: "Validation path is relevant but needs package proof.",
        },
      ]),
      sampleTrace(),
    );

    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      expect.objectContaining({
        flowId: "pi-wendao-search-strategy-flow",
        candidateId: "docs/a.md#owner",
        branchRole: "authority",
        decision: "keep",
        blocked: false,
      }),
      expect.objectContaining({
        candidateId: "docs/b.md#validation",
        branchRole: "validation",
        decision: "expand",
      }),
    ]);
  });

  it("accepts multiple subagent rows for the same candidate", () => {
    const result = parseSearchStrategyFlowBranchJudgements(
      [
        {
          candidate_id: "docs/a.md#owner",
          branch_role: "authority",
          judgement_score: 0.91,
          confidence: 0.82,
          decision: "keep",
          blocked: false,
          reason: "Ownership evidence is directly selected.",
        },
        {
          candidate_id: "docs/a.md#owner",
          branch_role: "authority",
          judgement_score: 0.72,
          confidence: 0.65,
          decision: "defer",
          blocked: false,
          reason: "Second subagent wants adjacent section evidence.",
        },
      ],
      sampleTrace(),
    );

    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.candidateId)).toEqual([
      "docs/a.md#owner",
      "docs/a.md#owner",
    ]);
  });

  it("rejects unknown, malformed, or over-range branch judgement rows", () => {
    const result = parseSearchStrategyFlowBranchJudgements(
      [
        {
          candidate_id: "docs/missing.md#branch",
          branch_role: "authority",
          judgement_score: 0.9,
          confidence: 0.8,
          decision: "keep",
          blocked: false,
          reason: "Unknown branch.",
        },
        {
          candidate_id: "docs/a.md#owner",
          branch_role: "ownership",
          judgement_score: 1.3,
          confidence: 0.8,
          decision: "keep",
          blocked: false,
          reason: "Bad role and score.",
        },
      ],
      sampleTrace(),
    );

    expect(result.rows).toEqual([]);
    expect(result.errors.join("\n")).toContain("unknown candidate_id");
    expect(result.errors.join("\n")).toContain("invalid branch_role");
    expect(result.errors.join("\n")).toContain("invalid judgement_score");
  });

  it("renders accepted branch judgement rows in the live trace", () => {
    const rendered = renderSearchStrategyFlowTrace(sampleTrace(), completedAgentTrace());

    expect(rendered).toContain(
      "live branch_judgement candidate=docs/a.md#owner role=authority decision=keep",
    );
    expect(rendered).toContain("score=0.900");
  });

  it("renders branch judgement rows as escaped bridge TSV", () => {
    const tsv = renderSearchStrategyFlowBranchJudgementTsv([
      {
        flowId: "pi-wendao-search-strategy-flow" as never,
        candidateId: "docs/a.md#owner",
        branchRole: "authority",
        judgementScore: 0.9,
        confidence: 0.8,
        decision: "keep",
        blocked: false,
        reason: "line one\nline two\twith tab",
      },
    ]);

    expect(tsv).toBe(
      "pi-wendao-search-strategy-flow\tdocs/a.md#owner\tauthority\t0.900000\t0.800000\tkeep\tfalse\tline one\\nline two\\twith tab",
    );
  });
});

function completedAgentTrace(): SearchStrategyFlowAgentTrace {
  return {
    mode: "live-subagent",
    status: "completed",
    model: "deepseek/deepseek-chat-v3-0324",
    durationMs: 100,
    cached: false,
    events: [],
    output: {
      intent_understanding: "Find the owner boundary.",
      branch_decision: "Keep owner and validation branches.",
      judgement: "The selected frontier is sufficient.",
      branch_judgements: "[]",
    },
    branchJudgements: [
      {
        flowId: "pi-wendao-search-strategy-flow" as never,
        candidateId: "docs/a.md#owner",
        branchRole: "authority",
        judgementScore: 0.9,
        confidence: 0.8,
        decision: "keep",
        blocked: false,
        reason: "Ownership branch covers the requested authority evidence.",
      },
    ],
    branchJudgementValidation: {
      valid: true,
      acceptedCount: 1,
      errors: [],
    },
  };
}

function sampleTrace(): SearchStrategyFlowTrace {
  return {
    intent: "find owner and validation evidence",
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
    ],
    candidates: [],
    frontier: [
      {
        candidateId: "docs/a.md#owner",
        rank: 1,
        selected: true,
        finalScore: 0.9,
        action: "keep",
        contextBudget: 120,
        judgementKind: "graph_verified_candidate",
      },
      {
        candidateId: "docs/b.md#validation",
        rank: 2,
        selected: true,
        finalScore: 0.8,
        action: "compare",
        contextBudget: 120,
        judgementKind: "subagent_branch_judgement",
      },
    ],
    plannerActions: [],
    retrievalRoutes: [
      {
        candidateId: "docs/a.md#owner",
        materializationOwner: "studio-rust",
        materializationStatus: "planned",
        receiptSource: "local-plan",
        primaryTransport: "arrow-flight",
        sourcePath: "docs/a.md",
        headingAnchor: "owner",
        directFileReadAllowed: false,
        executeBeforeAnswer: true,
        flightSteps: [],
      },
      {
        candidateId: "docs/b.md#validation",
        materializationOwner: "studio-rust",
        materializationStatus: "planned",
        receiptSource: "local-plan",
        primaryTransport: "arrow-flight",
        sourcePath: "docs/b.md",
        headingAnchor: "validation",
        directFileReadAllowed: false,
        executeBeforeAnswer: true,
        flightSteps: [],
      },
    ],
    summary: {
      candidateCount: 2,
      selectedCount: 2,
      plannerActionCount: 0,
      totalContextCost: 240,
      selectedContextCost: 240,
      contextReductionRatio: 0,
    },
    validation: {
      noVectorMode: true,
      materializedTopCandidate: true,
      blockedEvidencePruned: true,
      selectedContextReduced: false,
    },
  };
}
