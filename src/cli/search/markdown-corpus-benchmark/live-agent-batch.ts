import { resolveModel } from "../../model-resolver.js";
import { parseSearchStrategyFlowBranchJudgements } from "../strategy-flow-branch-judgement.js";
import {
  compactSearchStrategyFlowTraceForAgent,
  shouldRunSearchStrategyFlowAgentJudgement,
} from "../strategy-flow-agent.js";
import { runSearchStrategyFlowAgentBpmnTask } from "../strategy-flow-agent-bpmn.js";
import type {
  SearchStrategyFlowAgentEvent,
  SearchStrategyFlowTrace,
} from "../strategy-flow-types.js";
import { evaluateMarkdownCorpusBenchmarkRow } from "./evaluate.js";
import { mapWithConcurrency } from "./concurrency.js";
import { resolveLiveAgentCandidatePoolMode } from "./live-agent.js";
import type {
  MarkdownCorpusBenchmarkCount,
  SearchStrategyFlowMarkdownCorpusAgentRun,
  SearchStrategyFlowMarkdownCorpusBenchmarkOptions,
  SearchStrategyFlowMarkdownCorpusIntentRow,
} from "./types.js";

export const DEFAULT_LIVE_AGENT_BATCH_SIZE = 4;

const BATCH_ACTIVITY_ID = "SearchStrategyFlow_BatchQueryUnderstanding";

interface IndexedTracedRow {
  index: number;
  intentRow: SearchStrategyFlowMarkdownCorpusIntentRow;
  trace: SearchStrategyFlowTrace;
}

interface BatchJudgementRow {
  familyId: string;
  intentUnderstanding: string;
  branchDecision: string;
  judgement: string;
  branchJudgements: unknown;
}

export async function runBenchmarkLiveAgentBatchRuns(input: {
  cwd: string;
  tracedRows: Array<{
    intentRow: SearchStrategyFlowMarkdownCorpusIntentRow;
    trace: SearchStrategyFlowTrace;
  }>;
  options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions;
  concurrency: number;
  defaultModelPattern: string;
}): Promise<SearchStrategyFlowMarkdownCorpusAgentRun[]> {
  const batchSize = normalizeLiveAgentBatchSize(input.options.liveAgentBatchSize);
  const runs = input.tracedRows.map(({ intentRow, trace }) =>
    skippedRun(
      "SearchStrategyFlow batch judgement was not required for this row.",
      resolveLiveAgentCandidatePoolMode(input.options.liveAgentCandidatePoolMode, trace),
    ),
  );
  const eligibleRows = input.tracedRows
    .map((row, index) => ({ index, ...row }))
    .filter((row) => {
      if (!shouldRunSearchStrategyFlowAgentJudgement(row.trace, row.intentRow.liveEvidenceRequired)) {
        return false;
      }
      const deterministic = evaluateMarkdownCorpusBenchmarkRow(row.intentRow, row.trace);
      if (deterministic.violations.length > 0) {
        runs[row.index] = skippedRun(
          `SearchStrategyFlow batch judgement skipped because deterministic gates failed: ${deterministic.violations.join(", ")}.`,
          resolveLiveAgentCandidatePoolMode(input.options.liveAgentCandidatePoolMode, row.trace),
        );
        return false;
      }
      return true;
    });
  const chunks = chunkRows(eligibleRows, batchSize);
  const chunkRuns = await mapWithConcurrency(chunks, input.concurrency, (chunk, batchIndex) =>
    runLiveAgentBatchChunk({
      cwd: input.cwd,
      rows: chunk,
      batchIndex,
      batchSize,
      options: input.options,
      defaultModelPattern: input.defaultModelPattern,
    }),
  );
  for (const rowRun of chunkRuns.flat()) {
    runs[rowRun.index] = rowRun.run;
  }
  return runs;
}

async function runLiveAgentBatchChunk(input: {
  cwd: string;
  rows: IndexedTracedRow[];
  batchIndex: number;
  batchSize: number;
  options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions;
  defaultModelPattern: string;
}): Promise<Array<{ index: number; run: SearchStrategyFlowMarkdownCorpusAgentRun }>> {
  const startedAt = Date.now();
  const batchId = `batch-${input.batchIndex + 1}`;
  const candidatePoolModes = new Map(
    input.rows.map((row) => [
      row.index,
      resolveLiveAgentCandidatePoolMode(input.options.liveAgentCandidatePoolMode, row.trace),
    ]),
  );
  try {
    const resolved = await resolveModel(
      input.options.modelPattern ?? input.defaultModelPattern,
      input.options.provider,
      input.options.apiKey,
      input.options.extensionPaths ?? [],
    );
    if (!hasRequestAuth(resolved.apiKey, resolved.headers)) {
      return failedBatchRows(input, candidatePoolModes, batchId, elapsedMs(startedAt),
        "No request auth is configured for the SearchStrategyFlow batch judgement.",
      );
    }
    const timeoutSeconds = normalizeBatchTimeoutSeconds(input.options.liveAgentTimeoutSeconds);
    const controller = timeoutSeconds > 0 ? new AbortController() : undefined;
    const timeout = controller
      ? setTimeout(() => {
          controller.abort();
        }, timeoutSeconds * 1_000)
      : undefined;
    try {
      const bpmnResult = await runSearchStrategyFlowAgentBpmnTask({
        trace: syntheticBatchTrace(input.rows),
        cwd: input.cwd,
        activityId: BATCH_ACTIVITY_ID,
        prompt: buildBatchAgentPrompt(input.rows),
        compactTrace: buildBatchCompactTrace(input.rows, candidatePoolModes),
        model: resolved.model,
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        ...(input.options.thinkingLevel ? { thinkingLevel: input.options.thinkingLevel } : {}),
        ...(input.options.qianjiCommand ? { qianjiCommand: input.options.qianjiCommand } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const durationMs = elapsedMs(startedAt);
      return mapBatchOutputToRuns({
        rows: input.rows,
        output: bpmnResult.output,
        events: bpmnResult.events,
        cached: bpmnResult.cached,
        model: `${resolved.model.provider}/${resolved.model.id}`,
        candidatePoolModes,
        batchId,
        batchDurationMs: durationMs,
      });
    } catch (error) {
      return failedBatchRows(
        input,
        candidatePoolModes,
        batchId,
        elapsedMs(startedAt),
        controller?.signal.aborted === true
          ? `SearchStrategyFlow batch BPMN/Qianji agent task timed out after ${timeoutSeconds}s.`
          : `SearchStrategyFlow batch BPMN/Qianji agent task failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } catch (error) {
    return failedBatchRows(
      input,
      candidatePoolModes,
      batchId,
      elapsedMs(startedAt),
      error instanceof Error ? error.message : String(error),
    );
  }
}

function mapBatchOutputToRuns(input: {
  rows: IndexedTracedRow[];
  output: Record<string, unknown>;
  events: SearchStrategyFlowAgentEvent[];
  cached: boolean;
  model: string;
  candidatePoolModes: Map<number, SearchStrategyFlowMarkdownCorpusAgentRun["candidatePoolMode"]>;
  batchId: string;
  batchDurationMs: number;
}): Array<{ index: number; run: SearchStrategyFlowMarkdownCorpusAgentRun }> {
  const parsed = parseBatchJudgementRows(input.output.branch_judgements);
  if (parsed.errors.length > 0) {
    return input.rows.map((row) => ({
      index: row.index,
      run: failedRun(
        `SearchStrategyFlow batch judgement output was invalid: ${parsed.errors.join("; ")}`,
        input.candidatePoolModes.get(row.index) ?? "visible",
        input.batchId,
        input.rows.length,
        input.batchDurationMs,
        input.model,
        input.events,
      ),
    }));
  }
  return input.rows.map((row) => {
    const judgement = parsed.rows.get(row.intentRow.familyId);
    if (!judgement) {
      return {
        index: row.index,
        run: failedRun(
          `SearchStrategyFlow batch judgement omitted family ${row.intentRow.familyId}.`,
          input.candidatePoolModes.get(row.index) ?? "visible",
          input.batchId,
          input.rows.length,
          input.batchDurationMs,
          input.model,
          input.events,
        ),
      };
    }
    const branchJudgements = parseSearchStrategyFlowBranchJudgements(
      judgement.branchJudgements,
      row.trace,
    );
    if (branchJudgements.errors.length > 0) {
      return {
        index: row.index,
        run: failedRun(
          `SearchStrategyFlow batch judgement returned invalid branch_judgements for ${row.intentRow.familyId}: ${branchJudgements.errors.join("; ")}`,
          input.candidatePoolModes.get(row.index) ?? "visible",
          input.batchId,
          input.rows.length,
          input.batchDurationMs,
          input.model,
          input.events,
        ),
      };
    }
    return {
      index: row.index,
      run: {
        trace: {
          mode: "qianji-service-agent",
          status: "completed",
          model: input.model,
          durationMs: input.batchDurationMs,
          cached: input.cached,
          events: input.events,
          output: {
            intent_understanding: judgement.intentUnderstanding,
            branch_decision: judgement.branchDecision,
            judgement: judgement.judgement,
            branch_judgements: judgement.branchJudgements,
          },
          branchJudgements: branchJudgements.rows,
          branchJudgementValidation: {
            valid: true,
            acceptedCount: branchJudgements.rows.length,
            errors: [],
          },
        },
        attemptCount: 1,
        retryCount: 0,
        retryReasons: [],
        candidatePoolMode: input.candidatePoolModes.get(row.index) ?? "visible",
        liveAgentMode: "batch-judgement",
        batchId: input.batchId,
        batchSize: input.rows.length,
        batchDurationMs: input.batchDurationMs,
      },
    };
  });
}

function buildBatchAgentPrompt(rows: IndexedTracedRow[]): string {
  return [
    "You are the first-layer Wendao SearchStrategyFlow batch query-understanding and branch-judgement agent.",
    "Judge each batch row independently. Do not request files, tools, or extra context.",
    "The Rust/Julia data plane has already selected frontier evidence through Arrow Flight; treat each compact trace as the only evidence surface.",
    "You must fill all four Qianji output fields:",
    "- intent_understanding: one concise batch-level summary naming the family ids judged.",
    "- branch_decision: one concise batch-level summary of keep/expand/reject decisions.",
    "- judgement: one concise batch-level sufficiency verdict.",
    "- branch_judgements: one JSON array of family-keyed rows only. Do not return Markdown.",
    "Do not put branch rows directly at the top level. Each branch_judgements array item must have this shape:",
    '{"family_id":"...","intent_understanding":"...","branch_decision":"...","judgement":"...","branch_judgements":[{"candidate_id":"...","branch_role":"search_strategy|authority|page_index|link_graph|validation|general","judgement_score":0.0,"confidence":0.0,"decision":"keep|expand|reject|prune|defer","blocked":false,"reason":"short evidence-grounded reason"}]}',
    "Use exact family_id values and exact candidate_id values from each row's frontier_branches.",
    "Cover selected frontier rows first. Candidate_pool rows may use decision=expand only when they materially improve the row.",
    "Required evidence coverage is a deterministic gate. If covered, do not reject a row for missing ownership, validation, relation, or page-index evidence.",
    "",
    `Batch rows: ${rows.map((row) => row.intentRow.familyId).join(", ")}`,
  ].join("\n");
}

function buildBatchCompactTrace(
  rows: IndexedTracedRow[],
  candidatePoolModes: Map<number, SearchStrategyFlowMarkdownCorpusAgentRun["candidatePoolMode"]>,
): Record<string, unknown> {
  return {
    mode: "markdown-corpus-batch-judgement",
    rows: rows.map((row) => ({
      familyId: row.intentRow.familyId,
      intent: row.intentRow.intent,
      requiredEvidence: row.intentRow.requiredEvidence,
      expectedSourcePaths: row.intentRow.expectedSourcePaths,
      trace: compactSearchStrategyFlowTraceForAgent(row.trace, {
        candidatePoolMode: candidatePoolModes.get(row.index) ?? "visible",
      }),
    })),
  };
}

function syntheticBatchTrace(rows: IndexedTracedRow[]): SearchStrategyFlowTrace {
  const trace = rows[0]?.trace;
  if (!trace) throw new Error("SearchStrategyFlow batch judgement requires at least one row");
  return {
    ...trace,
    intent: `Batch SearchStrategyFlow judgement for ${rows.length} Markdown corpus intent(s).`,
  };
}

function parseBatchJudgementRows(value: unknown): {
  rows: Map<string, BatchJudgementRow>;
  errors: string[];
} {
  const parsed = parseJsonPayload(value);
  const rawRows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? parsed.rows ?? parsed.batch_judgements ?? parsed.batchJudgements
      : undefined;
  if (!Array.isArray(rawRows)) {
    return { rows: new Map(), errors: ["branch_judgements must be a JSON array of batch rows."] };
  }
  const rows = new Map<string, BatchJudgementRow>();
  const errors: string[] = [];
  rawRows.forEach((rawRow, index) => {
    const rowNumber = index + 1;
    if (!isRecord(rawRow)) {
      errors.push(`batch row ${rowNumber} must be an object.`);
      return;
    }
    const familyId = readString(rawRow.family_id ?? rawRow.familyId);
    if (!familyId) {
      errors.push(`batch row ${rowNumber} missing family_id.`);
      return;
    }
    if (rows.has(familyId)) {
      errors.push(`batch row ${rowNumber} duplicates family_id ${familyId}.`);
      return;
    }
    const intentUnderstanding = readString(rawRow.intent_understanding ?? rawRow.intentUnderstanding);
    const branchDecision = readString(rawRow.branch_decision ?? rawRow.branchDecision);
    const judgement = readString(rawRow.judgement);
    const branchJudgements = rawRow.branch_judgements ?? rawRow.branchJudgements;
    if (!intentUnderstanding) errors.push(`batch row ${rowNumber} missing intent_understanding.`);
    if (!branchDecision) errors.push(`batch row ${rowNumber} missing branch_decision.`);
    if (!judgement) errors.push(`batch row ${rowNumber} missing judgement.`);
    if (branchJudgements === undefined) {
      errors.push(`batch row ${rowNumber} missing branch_judgements.`);
    }
    rows.set(familyId, {
      familyId,
      intentUnderstanding,
      branchDecision,
      judgement,
      branchJudgements,
    });
  });
  return errors.length > 0 ? { rows: new Map(), errors } : { rows, errors: [] };
}

function parseJsonPayload(value: unknown): unknown {
  if (Array.isArray(value) || isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  const text = stripJsonFence(value.trim());
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function stripJsonFence(value: string): string {
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]?.trim() ?? "" : value;
}

function failedBatchRows(
  input: {
    rows: IndexedTracedRow[];
    batchSize?: number;
  },
  candidatePoolModes: Map<number, SearchStrategyFlowMarkdownCorpusAgentRun["candidatePoolMode"]>,
  batchId: string,
  batchDurationMs: number,
  reason: string,
): Array<{ index: number; run: SearchStrategyFlowMarkdownCorpusAgentRun }> {
  return input.rows.map((row) => ({
    index: row.index,
      run: failedRun(
        reason,
        candidatePoolModes.get(row.index) ?? "visible",
        batchId,
      input.rows.length,
      batchDurationMs,
    ),
  }));
}

function failedRun(
  reason: string,
  candidatePoolMode: SearchStrategyFlowMarkdownCorpusAgentRun["candidatePoolMode"],
  batchId: string,
  batchSize: number,
  batchDurationMs: number,
  model?: string,
  events: SearchStrategyFlowAgentEvent[] = [],
): SearchStrategyFlowMarkdownCorpusAgentRun {
  return {
    trace: {
      mode: "qianji-service-agent",
      status: "failed",
      ...(model ? { model } : {}),
      durationMs: batchDurationMs,
      reason,
      events,
    },
    attemptCount: 1,
    retryCount: 0,
    retryReasons: [],
    candidatePoolMode,
    liveAgentMode: "batch-judgement",
    batchId,
    batchSize,
    batchDurationMs,
  };
}

function skippedRun(
  reason: string,
  candidatePoolMode: SearchStrategyFlowMarkdownCorpusAgentRun["candidatePoolMode"],
): SearchStrategyFlowMarkdownCorpusAgentRun {
  return {
    trace: {
      mode: "qianji-service-agent",
      status: "skipped",
      durationMs: 0,
      reason,
      events: [],
    },
    attemptCount: 0,
    retryCount: 0,
    retryReasons: [],
    candidatePoolMode,
    liveAgentMode: "batch-judgement",
  };
}

export function normalizeLiveAgentBatchSize(
  value: MarkdownCorpusBenchmarkCount | undefined,
): MarkdownCorpusBenchmarkCount {
  if (value === undefined) return DEFAULT_LIVE_AGENT_BATCH_SIZE;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--live-agent-batch-size must be a positive integer");
  }
  return value;
}

function normalizeBatchTimeoutSeconds(value: number | undefined): number {
  if (value === undefined) return 180;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("--live-agent-timeout-seconds must be a non-negative number");
  }
  return Math.floor(value);
}

function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function hasRequestAuth(
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
): boolean {
  return Boolean(apiKey || (headers && Object.keys(headers).length > 0));
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}
