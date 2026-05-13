import { afterEach, describe, expect, it, vi } from "vitest";
import { runDirectSearchStrategyFlowAgentTrace } from "../../src/cli/search/strategy-flow-agent-direct.js";
import type { SearchStrategyFlowTrace } from "../../src/cli/search/strategy-flow-types.js";

describe("SearchStrategyFlow direct Anthropic-compatible agent", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses Bearer authentication for OpenRouter messages requests", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      );
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                intent_understanding: "Find the configured Markdown evidence.",
                branch_decision: "Keep the selected exact Markdown branch.",
                judgement: "The frontier is sufficient.",
                branch_judgements: [
                  {
                    candidate_id: "docs/a.md#owner",
                    branch_role: "authority",
                    judgement_score: 0.9,
                    confidence: 0.8,
                    decision: "keep",
                    blocked: false,
                    reason: "Selected authority evidence.",
                  },
                ],
              }),
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await runDirectSearchStrategyFlowAgentTrace({
      trace: minimalTrace(),
      prompt: "Return JSON.",
      compactTrace: { frontier: [] },
      model: {
        provider: "anthropic",
        id: "deepseek/deepseek-v4-pro",
        baseUrl: "https://openrouter.ai/api",
      },
      apiKey: "openrouter-api-key",
      startedAt: Date.now(),
    });

    expect(result.status).toBe("completed");
    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/messages");
    expect(capturedHeaders.authorization).toBe("Bearer openrouter-api-key");
    expect(capturedHeaders["x-api-key"]).toBeUndefined();
  });
});

function minimalTrace(): SearchStrategyFlowTrace {
  return {
    intent: "Find the Markdown evidence.",
    backend: "rust-wendao-julia",
    graphProject: "/tmp/WendaoGraph.jl",
    juliaProject: "/tmp/WendaoGraph.jl",
    searchRoot: "/tmp/repo",
    queryUnderstanding: [],
    candidates: [],
    frontier: [
      {
        candidateId: "docs/a.md#owner",
        rank: 1,
        selected: true,
        finalScore: 0.9,
        action: "keep",
        contextBudget: 8,
        judgementKind: "graph_verified_candidate",
      },
    ],
    plannerActions: [],
    stageReceipts: [],
    summary: {
      candidateCount: 0,
      plannerActionCount: 0,
      selectedCount: 0,
      selectedContextCost: 0,
      totalContextCost: 0,
      contextReductionRatio: 0,
    },
    validation: {
      requiredEvidenceCovered: true,
      selectedRequiredEvidence: [],
      missingRequiredEvidence: [],
      selectedContextReduced: true,
      materializedTopCandidate: false,
      blockedEvidencePruned: false,
      noVectorMode: true,
    },
  } as SearchStrategyFlowTrace;
}
