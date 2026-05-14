import {
  buildSearchStrategyFlowBranchContexts,
  type SearchStrategyFlowBranchContext,
} from "./strategy-flow-branch-context.js";
import type {
  SearchStrategyFlowBranchJudgementDecision,
  SearchStrategyFlowBranchJudgementRole,
  SearchStrategyFlowBranchJudgementRow,
  SearchStrategyFlowId,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";

export interface SearchStrategyFlowBranchJudgementParseResult {
  rows: SearchStrategyFlowBranchJudgementRow[];
  errors: string[];
}

interface SearchStrategyFlowBranchJudgementParseContext {
  parsed: unknown;
  allowedCandidateIds: Set<string>;
  branchesByCandidateId: Map<string, SearchStrategyFlowBranchContext>;
  flowId?: SearchStrategyFlowId;
}

interface SearchStrategyFlowCandidatePoolPromotionGate {
  promotable: boolean;
  suppressed: boolean;
}

const CANDIDATE_POOL_EXPAND_MIN_SCORE = 0.86;
const CANDIDATE_POOL_EXPAND_MIN_CONFIDENCE = 0.72;

const BRANCH_ROLES: readonly SearchStrategyFlowBranchJudgementRole[] = [
  "search_strategy",
  "authority",
  "page_index",
  "link_graph",
  "validation",
  "general",
];

const BRANCH_DECISIONS: readonly SearchStrategyFlowBranchJudgementDecision[] = [
  "keep",
  "expand",
  "reject",
  "prune",
  "defer",
];

export function parseSearchStrategyFlowBranchJudgements(
  value: unknown,
  trace: SearchStrategyFlowTrace,
): SearchStrategyFlowBranchJudgementParseResult {
  return parseBranchJudgementRows(buildBranchJudgementParseContext(value, trace));
}

export function renderSearchStrategyFlowBranchJudgementTsv(
  rows: SearchStrategyFlowBranchJudgementRow[],
): string {
  return rows.map(renderBranchJudgementTsvRow).join("\n");
}

function buildBranchJudgementParseContext(
  value: unknown,
  trace: SearchStrategyFlowTrace,
): SearchStrategyFlowBranchJudgementParseContext {
  const branchContexts = buildSearchStrategyFlowBranchContexts(trace);
  return {
    parsed: parseBranchJudgementPayload(value),
    allowedCandidateIds: new Set(branchContexts.map((branch) => String(branch.candidateId))),
    branchesByCandidateId: new Map(
      branchContexts.map((branch) => [String(branch.candidateId), branch]),
    ),
    flowId: trace.queryUnderstanding?.[0]?.flowId as SearchStrategyFlowId | undefined,
  };
}

function parseBranchJudgementRows(
  context: SearchStrategyFlowBranchJudgementParseContext,
): SearchStrategyFlowBranchJudgementParseResult {
  if (!Array.isArray(context.parsed)) {
    return { rows: [], errors: ["branch_judgements must be a JSON array."] };
  }

  if (context.allowedCandidateIds.size === 0) {
    return {
      rows: [],
      errors: ["branch_judgements cannot be accepted without frontier branch contexts."],
    };
  }

  const errors: string[] = [];
  const rows: SearchStrategyFlowBranchJudgementRow[] = [];
  let suppressedCandidatePoolRows = 0;

  context.parsed.forEach((rawRow, index) => {
    const rowNumber = index + 1;
    if (!isRecord(rawRow)) {
      errors.push(`branch_judgements row ${rowNumber} must be an object.`);
      return;
    }

    const candidateId = readString(rawRow.candidateId ?? rawRow.candidate_id);
    if (!candidateId) {
      errors.push(`branch_judgements row ${rowNumber} missing candidate_id.`);
    } else if (!context.allowedCandidateIds.has(candidateId)) {
      errors.push(`branch_judgements row ${rowNumber} references unknown candidate_id ${candidateId}.`);
    }

    const branchRole = readBranchRole(rawRow.branchRole ?? rawRow.branch_role ?? rawRow.role);
    if (!branchRole) {
      errors.push(`branch_judgements row ${rowNumber} has invalid branch_role.`);
    }

    const judgementScore = readUnitScore(
      rawRow.judgementScore ?? rawRow.judgement_score ?? rawRow.score,
    );
    if (judgementScore === undefined) {
      errors.push(`branch_judgements row ${rowNumber} has invalid judgement_score.`);
    }

    const confidence = readUnitScore(rawRow.confidence);
    if (confidence === undefined) {
      errors.push(`branch_judgements row ${rowNumber} has invalid confidence.`);
    }

    const decision = readDecision(rawRow.decision);
    if (!decision) {
      errors.push(`branch_judgements row ${rowNumber} has invalid decision.`);
    }

    const blocked = readBoolean(rawRow.blocked);
    if (blocked === undefined) {
      errors.push(`branch_judgements row ${rowNumber} has invalid blocked flag.`);
    }

    const reason = readString(rawRow.reason);
    if (!reason) {
      errors.push(`branch_judgements row ${rowNumber} missing reason.`);
    }

    if (
      candidateId &&
      branchRole &&
      judgementScore !== undefined &&
      confidence !== undefined &&
      decision &&
      blocked !== undefined &&
      reason &&
      context.allowedCandidateIds.has(candidateId)
    ) {
      const promotionGate = candidatePoolPromotionGate(
        context.branchesByCandidateId.get(candidateId),
        judgementScore,
        confidence,
        decision,
        blocked,
      );
      if (!promotionGate.promotable) {
        suppressedCandidatePoolRows += promotionGate.suppressed ? 1 : 0;
        return;
      }
      rows.push({
        ...(context.flowId ? { flowId: context.flowId } : {}),
        candidateId,
        branchRole,
        judgementScore,
        confidence,
        decision,
        blocked,
        reason: reason.length > 240 ? reason.slice(0, 240) : reason,
      });
    }
  });

  if (rows.length === 0 && suppressedCandidatePoolRows === 0) {
    errors.push("branch_judgements must include at least one accepted row.");
  }

  return errors.length > 0 ? { rows: [], errors } : { rows, errors: [] };
}

function candidatePoolPromotionGate(
  branch: SearchStrategyFlowBranchContext | undefined,
  judgementScore: number,
  confidence: number,
  decision: SearchStrategyFlowBranchJudgementDecision,
  blocked: boolean,
): SearchStrategyFlowCandidatePoolPromotionGate {
  if (branch?.branchSource !== "candidate_pool") {
    return { promotable: true, suppressed: false };
  }
  if (blocked || decision !== "expand") {
    return { promotable: false, suppressed: true };
  }
  if (
    judgementScore < CANDIDATE_POOL_EXPAND_MIN_SCORE ||
    confidence < CANDIDATE_POOL_EXPAND_MIN_CONFIDENCE
  ) {
    return { promotable: false, suppressed: true };
  }

  return { promotable: true, suppressed: false };
}

function parseBranchJudgementPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return value.branch_judgements ?? value.branchJudgements;
  if (typeof value !== "string") return undefined;
  const text = stripJsonFence(value.trim());
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed.branch_judgements ?? parsed.branchJudgements : parsed;
  } catch {
    return undefined;
  }
}

function stripJsonFence(value: string): string {
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]?.trim() ?? "" : value;
}

function readBranchRole(value: unknown): SearchStrategyFlowBranchJudgementRole | undefined {
  const role = readString(value);
  return (BRANCH_ROLES as readonly string[]).includes(role)
    ? (role as SearchStrategyFlowBranchJudgementRole)
    : undefined;
}

function readDecision(value: unknown): SearchStrategyFlowBranchJudgementDecision | undefined {
  const decision = readString(value);
  return (BRANCH_DECISIONS as readonly string[]).includes(decision)
    ? (decision as SearchStrategyFlowBranchJudgementDecision)
    : undefined;
}

function readUnitScore(value: unknown): number | undefined {
  const score = typeof value === "number" ? value : Number.parseFloat(readString(value));
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = readString(value).toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return undefined;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderBranchJudgementTsvRow(row: SearchStrategyFlowBranchJudgementRow): string {
  return [
    row.flowId ?? "",
    row.candidateId,
    row.branchRole,
    row.judgementScore.toFixed(6),
    row.confidence.toFixed(6),
    row.decision,
    row.blocked ? "true" : "false",
    row.reason,
  ]
    .map(escapeTsvField)
    .join("\t");
}

function escapeTsvField(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}
