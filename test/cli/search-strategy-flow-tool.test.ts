import { describe, expect, it } from "vitest";
import { WENDAO_ARROW_FLIGHT_DATA_PLANE } from "../../src/arrow/boundary.js";
import { registerSearchStrategyFlowTool } from "../../src/cli/search/strategy-flow-tool.js";
import type { SearchStrategyFlowTrace } from "../../src/cli/search/strategy-flow-types.js";

describe("SearchStrategyFlow pi tool", () => {
  it("runs the governed bridge runner and returns rendered trace details", async () => {
    let receivedIntent = "";
    let registeredTool:
      | {
          execute(
            toolCallId: string,
            params: Record<string, unknown>,
            signal?: AbortSignal,
          ): Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
        }
      | undefined;

    registerSearchStrategyFlowTool(
      {
        registerTool: (tool: typeof registeredTool) => {
          registeredTool = tool;
        },
      },
      {
        cwd: process.cwd(),
        runner: async (options) => {
          receivedIntent = options.intent;
          return traceFixture(options.intent);
        },
      },
    );

    const result = await registeredTool?.execute("tool-1", {
      intent: "find ownership boundary",
      search_backend: "rust-julia",
      json: false,
    });

    expect(receivedIntent).toBe("find ownership boundary");
    expect(result?.content[0]?.text).toContain("SearchStrategyFlow trace");
    expect(result?.details).toMatchObject({
      customType: "wendao_search_strategy_flow",
      toolCallId: "tool-1",
      candidateCount: 2,
      selectedCount: 1,
      requiredEvidenceCovered: true,
    });
  });

  it("rejects blank intents and julia-direct bypass requests", async () => {
    let registeredTool:
      | {
          execute(
            toolCallId: string,
            params: Record<string, unknown>,
            signal?: AbortSignal,
          ): Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
        }
      | undefined;

    registerSearchStrategyFlowTool(
      {
        registerTool: (tool: typeof registeredTool) => {
          registeredTool = tool;
        },
      },
      {
        cwd: process.cwd(),
        runner: async () => traceFixture("unused"),
      },
    );

    await expect(registeredTool?.execute("tool-blank", { intent: " " })).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("non-empty intent") }],
    });
    await expect(
      registeredTool?.execute("tool-bypass", {
        intent: "find validation",
        search_backend: "julia-direct",
      }),
    ).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("does not expose julia-direct") }],
    });
  });
});

function traceFixture(intent: string): SearchStrategyFlowTrace {
  return {
    intent,
    backend: "rust-julia",
    controlPlane: "rust-bridge",
    strategyFlowDataPlane: WENDAO_ARROW_FLIGHT_DATA_PLANE,
    graphProject: "/tmp/WendaoGraph.jl",
    searchRoot: "/tmp/WendaoGraph.jl",
    rustBridge: {
      requestedBackend: "rust-julia",
      attempted: true,
      mode: "persistent-stdio",
      fallback: "none",
    },
    stageReceipts: [],
    candidates: [
      candidate("authority", true),
      candidate("validation", false),
    ],
    frontier: [
      {
        rank: 1,
        candidateId: "authority",
        selected: true,
        action: "inspect",
        contextBudget: 128,
        judgementKind: "deterministic",
      },
    ],
    plannerActions: [],
    summary: {
      candidateCount: 2,
      selectedCount: 1,
      plannerActionCount: 0,
      selectedContextCost: 128,
      totalContextCost: 512,
      contextReductionRatio: 0.75,
    },
    validation: {
      noVectorMode: true,
      materializedTopCandidate: true,
      blockedEvidencePruned: true,
      selectedContextReduced: true,
      requiredEvidenceCovered: true,
      selectedRequiredEvidence: ["ownership_boundary"],
      missingRequiredEvidence: [],
    },
  };
}

function candidate(candidateId: string, selected: boolean): SearchStrategyFlowTrace["candidates"][number] {
  return {
    candidateId,
    action: "inspect",
    reason: selected ? "selected" : "available",
    finalScore: selected ? 0.9 : 0.7,
    evidenceCoverage: 1,
    graphScore: 0.8,
    authorityScore: selected ? 1 : 0.4,
    semanticScore: 0.8,
    structuralScore: 0.7,
    contextCost: 128,
    blocked: false,
  };
}
