import { resolveModel } from "../model-resolver.js";
import type { PiWendaoThinkingLevel } from "../../executor/agent-runtime-types.js";
import { runSearchStrategyFlowAgentBpmnTask } from "./strategy-flow-agent-bpmn.js";
import { parseSearchStrategyFlowBranchJudgements } from "./strategy-flow-branch-judgement.js";
import {
  buildSearchStrategyFlowBranchContexts,
  type SearchStrategyFlowBranchContext,
} from "./strategy-flow-branch-context.js";
import type {
  SearchStrategyFlowAgentEvent,
  SearchStrategyFlowAgentTrace,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";

const SEARCH_STRATEGY_FLOW_AGENT_ACTIVITY_ID = "SearchStrategyFlow_QueryUnderstanding";
const CANDIDATE_POOL_BRANCH_VISIBLE_LIMIT = 16;
const DEFAULT_AGENT_TIMEOUT_SECONDS = 180;
const CANDIDATE_POOL_STOP_WORDS = new Set([
  "and",
  "are",
  "for",
  "from",
  "how",
  "the",
  "this",
  "that",
  "with",
]);

export interface SearchStrategyFlowAgentOptions {
  trace: SearchStrategyFlowTrace;
  cwd: string;
  modelPattern: string;
  provider?: string;
  apiKey?: string;
  thinkingLevel?: PiWendaoThinkingLevel;
  qianjiCommand?: string;
  extensionPaths: string[];
  timeoutSeconds?: number;
  forceJudgement?: boolean;
  candidatePoolMode?: SearchStrategyFlowAgentCandidatePoolMode;
}

export type SearchStrategyFlowAgentCandidatePoolMode = "visible" | "selected-only" | "auto";

export async function runSearchStrategyFlowAgentTrace(
  options: SearchStrategyFlowAgentOptions,
): Promise<SearchStrategyFlowAgentTrace> {
  const startedAt = Date.now();
  if (!shouldRunSearchStrategyFlowAgentJudgement(options.trace, options.forceJudgement === true)) {
    return skippedAgentTrace(startedAt);
  }
  return runSearchStrategyFlowAgentLlmTrace(options, startedAt);
}

export function shouldRunSearchStrategyFlowAgentJudgement(
  trace: SearchStrategyFlowTrace,
  forceJudgement = false,
): boolean {
  return forceJudgement || traceRequiresLlmJudgement(trace);
}

async function runSearchStrategyFlowAgentLlmTrace(
  options: SearchStrategyFlowAgentOptions,
  startedAt: number,
): Promise<SearchStrategyFlowAgentTrace> {
  const events: SearchStrategyFlowAgentEvent[] = [];
  try {
    const resolved = await resolveModel(
      options.modelPattern,
      options.provider,
      options.apiKey,
      options.extensionPaths,
    );
    if (!hasRequestAuth(resolved.apiKey, resolved.headers)) {
      return {
        mode: "qianji-service-agent",
        status: "failed",
        model: `${resolved.model.provider}/${resolved.model.id}`,
        durationMs: elapsedMs(startedAt),
        reason:
          "No request auth is configured for the SearchStrategyFlow LLM judgement. Set DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN for the selected Anthropic-compatible gateway.",
        events,
      };
    }
    const prompt = buildSearchAgentPrompt(options.trace);
    const compactTrace = compactSearchStrategyFlowTraceForAgent(options.trace, {
      candidatePoolMode: options.candidatePoolMode ?? "visible",
    });
    const timeoutSeconds = normalizeAgentTimeoutSeconds(options.timeoutSeconds);
    const controller = timeoutSeconds > 0 ? new AbortController() : undefined;
    const timeout = controller
      ? setTimeout(() => {
          controller.abort();
        }, timeoutSeconds * 1_000)
      : undefined;
    let bpmnResult: Awaited<ReturnType<typeof runSearchStrategyFlowAgentBpmnTask>>;
    try {
      bpmnResult = await runSearchStrategyFlowAgentBpmnTask({
        trace: options.trace,
        cwd: resolveSearchAgentCwd(options),
        activityId: SEARCH_STRATEGY_FLOW_AGENT_ACTIVITY_ID,
        prompt,
        compactTrace,
        model: resolved.model,
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
        ...(options.qianjiCommand ? { qianjiCommand: options.qianjiCommand } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      return {
        mode: "qianji-service-agent",
        status: "failed",
        model: `${resolved.model.provider}/${resolved.model.id}`,
        durationMs: elapsedMs(startedAt),
        reason:
          controller?.signal.aborted === true
            ? `SearchStrategyFlow BPMN/Qianji agent task timed out after ${timeoutSeconds}s.`
            : `SearchStrategyFlow BPMN/Qianji agent task failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
        events,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    events.push(...bpmnResult.events);
    const output = bpmnResult.output;

    const intentUnderstanding = readNonEmptyString(output.intent_understanding);
    const branchDecision = readNonEmptyString(output.branch_decision);
    const judgement = readNonEmptyString(output.judgement);
    const branchJudgements = parseSearchStrategyFlowBranchJudgements(
      output.branch_judgements,
      options.trace,
    );
    const missingOutputs = [
      ["intent_understanding", intentUnderstanding],
      ["branch_decision", branchDecision],
      ["judgement", judgement],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingOutputs.length > 0) {
      return {
        mode: "qianji-service-agent",
        status: "failed",
        model: `${resolved.model.provider}/${resolved.model.id}`,
        durationMs: elapsedMs(startedAt),
        reason: `SearchStrategyFlow Qianji service agent completed without non-empty output(s): ${missingOutputs.join(", ")}.`,
        events,
        output,
      };
    }
    if (branchJudgements.errors.length > 0) {
      return {
        mode: "qianji-service-agent",
        status: "failed",
        model: `${resolved.model.provider}/${resolved.model.id}`,
        durationMs: elapsedMs(startedAt),
        reason: `SearchStrategyFlow Qianji service agent returned invalid branch_judgements: ${branchJudgements.errors.join("; ")}`,
        events,
        output,
        branchJudgementValidation: {
          valid: false,
          acceptedCount: 0,
          errors: branchJudgements.errors,
        },
      };
    }

    return {
      mode: "qianji-service-agent",
      status: "completed",
      model: `${resolved.model.provider}/${resolved.model.id}`,
      durationMs: elapsedMs(startedAt),
      cached: bpmnResult.cached,
      events,
      output,
      branchJudgements: branchJudgements.rows,
      branchJudgementValidation: {
        valid: true,
        acceptedCount: branchJudgements.rows.length,
        errors: [],
      },
    };
  } catch (error) {
    return {
      mode: "qianji-service-agent",
      status: "failed",
      durationMs: elapsedMs(startedAt),
      reason: error instanceof Error ? error.message : String(error),
      events,
    };
  }
}

function traceRequiresLlmJudgement(trace: SearchStrategyFlowTrace): boolean {
  return trace.plannerActions.some((action) => action.requiresLlmJudgement);
}

function skippedAgentTrace(startedAt: number): SearchStrategyFlowAgentTrace {
  return {
    mode: "qianji-service-agent",
    status: "skipped",
    durationMs: elapsedMs(startedAt),
    reason: "SearchStrategyFlow did not request an LLM judgement.",
    events: [],
  };
}

function buildSearchAgentPrompt(trace: SearchStrategyFlowTrace): string {
  return [
    "You are the first-layer Wendao SearchStrategyFlow query-understanding and branch-judgement agent.",
    "This first layer is correctness-sensitive: preserve the configured reasoning level and do not trade intent quality for latency.",
    "Use only the compact trace and the graph_query_understanding evidence. Do not request files, tools, or extra context.",
    "Treat retrieval_routes as later-layer Flight/Rust materialization plans; never bypass Rust by reading a full Markdown file directly.",
    "Gateway REST/Flight data-plane calls happen after query understanding and WendaoGraph frontier selection; do not invent or request a raw Gateway intent endpoint.",
    "Prefer frontier_branches over raw candidates when judging coverage; each branch includes its source, route role, purpose, and evidence anchors.",
    "frontier_branches may include selected frontier rows and compact candidate_pool rows. Use candidate_pool rows to rescue relevant documents already retrieved but not selected.",
    "Return at most 8 branch_judgements. Always cover selected frontier rows first, then add only candidate_pool rows that materially improve source relevance.",
    "Candidate_pool rows are promotion candidates, not selected evidence. Use decision=expand only for high-confidence candidate_pool rows that must be added; decision=keep on candidate_pool rows will not promote them.",
    "Use decision=expand for candidate_pool rows that should be promoted into the next frontier; use decision=keep for rows that are already sufficient in the selected frontier.",
    "judgement_score is semantic intent relevance from your judgement, not the numeric finalScore copied from the trace.",
    "Use branch_role=general only when no specific role applies. RFCs, audits, package docs, or boundary docs that establish ownership/provenance should normally be authority.",
    "Use each branch's derivedTraceHints as non-authoritative tactical hints. If the frontier is insufficient, name the exact whitelisted Rust probe recommendation to execute next.",
    "Treat requiredEvidenceCoverage as the deterministic graph gate: when it is covered, do not reject the frontier for missing ownership, validation, or relation evidence.",
    "First normalize what the user is really asking for, using Julia's graph evidence as constraints rather than optional suggestions.",
    "Then judge whether the selected frontier branches are sufficient for that intent.",
    "Return concise outputs:",
    "- intent_understanding: one sentence with normalized intent, route, facets, and ambiguity.",
    "- branch_decision: one sentence naming keep, expand, prune, and risky branches.",
    "- judgement: final answer under 80 words explaining whether the current frontier is sufficient.",
    "- branch_judgements: JSON array only, no Markdown. Include one object for each selected, actionable, or candidate_pool frontier_branches item you judge. Use exact ids from frontier_branches.",
    '  Row shape: {"candidate_id":"...","branch_role":"search_strategy|authority|page_index|link_graph|validation|general","judgement_score":0.0,"confidence":0.0,"decision":"keep|expand|reject|prune|defer","blocked":false,"reason":"short evidence-grounded reason"}.',
    "",
    `Intent: ${trace.intent}`,
    `Search root: ${trace.searchRoot}`,
  ].join("\n");
}

export function compactSearchStrategyFlowTraceForAgent(
  trace: SearchStrategyFlowTrace,
  options: { candidatePoolMode?: SearchStrategyFlowAgentCandidatePoolMode } = {},
): Record<string, unknown> {
  const branchContexts = buildSearchStrategyFlowBranchContexts(trace);
  const selectedOrActionableBranches = branchContexts.filter(
    (branch) =>
      branch.selected ||
      branch.actionKind === "compare" ||
      branch.actionKind === "expand" ||
      branch.actionKind === "judge",
  );
  const candidatePoolMode = options.candidatePoolMode ?? "visible";
  const includeCandidatePool =
    candidatePoolMode === "visible" ||
    (candidatePoolMode === "auto" && trace.validation.requiredEvidenceCovered !== true);
  const candidatePoolBranches = includeCandidatePool
    ? selectCandidatePoolBranchesForAgent(
        trace,
        branchContexts.filter((branch) => branch.branchSource === "candidate_pool"),
      )
    : [];
  const visibleIds = new Set<string>();
  const agentVisibleBranches = [...selectedOrActionableBranches, ...candidatePoolBranches].filter(
    (branch) => {
      if (visibleIds.has(branch.candidateId)) return false;
      visibleIds.add(branch.candidateId);
      return true;
    },
  );
  return {
    backend: trace.backend,
    controlPlane: trace.controlPlane,
    rustBridge: trace.rustBridge,
    strategyBudget: trace.strategyBudget,
    candidateSummary: {
      candidateInputSource: trace.candidateInputSource,
      candidateInputCount: trace.candidateInputCount,
      frontierCount: trace.frontier.length,
      selectedCount: trace.frontier.filter((row) => row.selected).length,
      agentCandidatePoolMode: candidatePoolMode,
      agentCandidatePoolVisibleCount: candidatePoolBranches.length,
    },
    stageReceipts: trace.stageReceipts.map((stage) => ({
      stage: stage.stage,
      input: stage.inputCount,
      output: stage.outputCount,
      selected: stage.selectedCount,
      llmJudgement: stage.llmJudgementCount,
      cycleAllowed: stage.cycleAllowedCount,
      contextBudget: stage.contextBudget,
      summary: stage.summary,
    })),
    validation: trace.validation,
    requiredEvidenceCoverage: {
      covered: trace.validation.requiredEvidenceCovered ?? false,
      selected: trace.validation.selectedRequiredEvidence ?? [],
      missing: trace.validation.missingRequiredEvidence ?? [],
    },
    graphQueryUnderstanding: (trace.queryUnderstanding ?? []).map((row) => ({
      kind: row.signalKind,
      value: row.signalValue,
      confidence: row.confidence,
      route: row.routeHint,
      requiredEvidence: row.requiredEvidence,
      ambiguity: row.ambiguity,
      budget: {
        loop: row.recommendedLoopBudget,
        judgement: row.recommendedJudgementBudget,
        beam: row.recommendedBeamWidth,
      },
      reason: row.reason,
    })),
    frontierBranches: agentVisibleBranches.map((branch) => ({
      id: branch.candidateId,
      source: branch.branchSource,
      role: branch.routeRole,
      purpose: branch.routePurpose,
      selected: branch.selected,
      rank: branch.frontierRank,
      judgementKind: branch.judgementKind,
      action: branch.actionKind,
      finalScore: branch.finalScore,
      contextCost: branch.contextCost,
      blocked: branch.blocked,
      compareTargetId: branch.compareTargetId,
      materializationStatus: branch.materializationStatus,
      materializedRows: branch.materializedRows,
      sourcePath: branch.sourcePath,
      headingAnchor: branch.headingAnchor,
      resolvedGraphNodeId: branch.resolvedGraphNodeId,
      graphMaterializationStatus: branch.graphMaterializationStatus,
      evidenceAnchors: branch.evidenceAnchors,
      ...(branch.branchSource === "frontier"
        ? { derivedTraceHints: branch.derivedHints }
        : {}),
    })),
    llmActions: trace.plannerActions
      .filter((action) => action.requiresLlmJudgement)
      .map((action) => ({
        kind: action.actionKind,
        candidateId: action.candidateId,
        targetCandidateId: action.targetCandidateId,
        reason: action.reason,
      })),
  };
}

function selectCandidatePoolBranchesForAgent(
  trace: SearchStrategyFlowTrace,
  branches: SearchStrategyFlowBranchContext[],
): SearchStrategyFlowBranchContext[] {
  const terms = searchStrategyFlowIntentTerms(trace);
  return [...branches]
    .sort((left, right) =>
      candidatePoolBranchScore(right, terms) - candidatePoolBranchScore(left, terms) ||
      (right.finalScore ?? 0) - (left.finalScore ?? 0) ||
      String(left.candidateId).localeCompare(String(right.candidateId)),
    )
    .slice(0, CANDIDATE_POOL_BRANCH_VISIBLE_LIMIT);
}

function searchStrategyFlowIntentTerms(trace: SearchStrategyFlowTrace): string[] {
  const text = [
    trace.intent,
    ...(trace.queryUnderstanding ?? []).flatMap((row) => [
      row.signalKind,
      row.signalValue,
      row.routeHint,
      row.requiredEvidence,
    ]),
  ].join(" ");
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((term) => term.length >= 3 && !CANDIDATE_POOL_STOP_WORDS.has(term));
  return [...new Set(terms)];
}

function candidatePoolBranchScore(
  branch: SearchStrategyFlowBranchContext,
  terms: string[],
): number {
  const haystack = [
    branch.candidateId,
    branch.sourcePath,
    branch.headingAnchor,
    branch.routeRole,
    branch.routePurpose,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const overlap = terms.filter((term) => haystack.includes(term)).length;
  const markdownBonus = branch.sourcePath?.endsWith(".md") ? 1.5 : 0;
  const exactPathBonus = branch.sourcePath && haystack.includes(branch.sourcePath.toLowerCase())
    ? 0.5
    : 0;
  const routeBonus = branch.routeRole === "general" ? 0 : 0.5;
  return overlap * 4 + markdownBonus + exactPathBonus + routeBonus;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveSearchAgentCwd(options: SearchStrategyFlowAgentOptions): string {
  return options.trace.searchRoot || options.trace.graphProject || options.cwd;
}

function hasRequestAuth(apiKey: string | undefined, headers: Record<string, string> | undefined): boolean {
  return Boolean(apiKey || (headers && Object.keys(headers).length > 0));
}

function normalizeAgentTimeoutSeconds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_AGENT_TIMEOUT_SECONDS;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("--live-agent-timeout-seconds must be a non-negative number");
  }
  return Math.floor(value);
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}
