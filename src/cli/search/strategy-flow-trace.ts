import type {
  SearchStrategyFlowStageReceipt,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";

export function parseStrategyFlowTrace(stdout: string): SearchStrategyFlowTrace {
  const text = stdout.trim();
  if (!text) throw new Error("WendaoGraph SearchStrategyFlow returned empty output");
  const parsed = JSON.parse(text) as SearchStrategyFlowTrace;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("WendaoGraph SearchStrategyFlow returned invalid JSON");
  }
  return hydrateStrategyFlowTrace(parsed);
}

function hydrateStrategyFlowTrace(trace: SearchStrategyFlowTrace): SearchStrategyFlowTrace {
  if (Array.isArray(trace.stageReceipts) && trace.stageReceipts.length > 0) return trace;

  return {
    ...trace,
    stageReceipts: deriveStageReceipts(trace),
  };
}

function deriveStageReceipts(trace: SearchStrategyFlowTrace): SearchStrategyFlowStageReceipt[] {
  const queryUnderstanding = trace.queryUnderstanding ?? [];
  const candidates = trace.candidates ?? [];
  const frontier = trace.frontier ?? [];
  const actions = trace.plannerActions ?? [];
  const selectedFrontier = frontier.filter((row) => row.selected);
  const llmActions = actions.filter((row) => row.requiresLlmJudgement);

  return [
    {
      stage: "query_understanding",
      notebook: "notebooks/search_strategy_flow_query_understanding.jl",
      inputCount: 1,
      outputCount: queryUnderstanding.length,
      selectedCount: 0,
      llmJudgementCount: 0,
      cycleAllowedCount: 0,
      contextBudget: 0,
      summary: "intent to graph route hints, required evidence, ambiguity, and strategy budget",
    },
    {
      stage: "candidate_scoring",
      notebook: "notebooks/search_strategy_flow_candidate_scoring.jl",
      inputCount: candidates.length,
      outputCount: candidates.length,
      selectedCount: candidates.filter((row) => row.action !== "prune").length,
      llmJudgementCount: 0,
      cycleAllowedCount: 0,
      contextBudget: trace.summary?.totalContextCost ?? 0,
      summary: "graph evidence rows to deterministic score rows and branch actions",
    },
    {
      stage: "transition_inference",
      notebook: "notebooks/search_strategy_flow_transition_inference.jl",
      inputCount: candidates.length,
      outputCount: candidates.length,
      selectedCount: candidates.filter((row) => row.action !== "prune").length,
      llmJudgementCount: 0,
      cycleAllowedCount: 0,
      contextBudget: 0,
      summary: "score rows to revision transition kinds and missing-signal diagnostics",
    },
    {
      stage: "frontier_selection",
      notebook: "notebooks/search_strategy_flow_frontier_selection.jl",
      inputCount: candidates.length,
      outputCount: frontier.length,
      selectedCount: selectedFrontier.length,
      llmJudgementCount: selectedFrontier.filter(
        (row) => row.judgementKind === "subagent_branch_judgement",
      ).length,
      cycleAllowedCount: 0,
      contextBudget: trace.summary?.selectedContextCost ?? 0,
      summary: "beam and context-budget bounded Agent-visible frontier",
    },
    {
      stage: "planner_actions",
      notebook: "notebooks/search_strategy_flow_planner_actions.jl",
      inputCount: frontier.length,
      outputCount: actions.length,
      selectedCount: actions.filter((row) => row.actionKind !== "stop").length,
      llmJudgementCount: llmActions.length,
      cycleAllowedCount: actions.filter((row) => row.cycleAllowed).length,
      contextBudget: actions.reduce((sum, row) => sum + (row.contextBudget ?? 0), 0),
      summary: "frontier and transition facts to materialize, refine, judge, compare, and stop actions",
    },
  ];
}
