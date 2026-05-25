import { resolveModel } from "../../model-resolver.js";
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
import { normalizeLiveAgentBatchSize } from "./live-agent-batch.js";
import type {
  SearchStrategyFlowMarkdownCorpusAgentRun,
  SearchStrategyFlowMarkdownCorpusBenchmarkOptions,
  SearchStrategyFlowMarkdownCorpusIntentRow,
} from "./types.js";

const SUFFICIENCY_ACTIVITY_ID = "SearchStrategyFlow_BatchSufficiencyGate";

interface IndexedTracedRow {
  index: number;
  intentRow: SearchStrategyFlowMarkdownCorpusIntentRow;
  trace: SearchStrategyFlowTrace;
}

interface SufficiencyRow {
  familyId: string;
  sufficient: boolean;
  confidence: number;
  reason: string;
}

export async function runBenchmarkLiveAgentSufficiencyRuns(input: {
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
  const runs = input.tracedRows.map(({ trace }) =>
    skippedRun(
      "SearchStrategyFlow batch sufficiency was not required for this row.",
      resolveLiveAgentCandidatePoolMode(input.options.liveAgentCandidatePoolMode, trace),
    ),
  );
  const eligibleRows = input.tracedRows
    .map((row, index) => ({ index, ...row }))
    .filter((row) => liveSufficiencyRowIsEligible(row, input.options, runs));
  const chunks = chunkRows(eligibleRows, batchSize);
  const chunkRuns = await mapWithConcurrency(chunks, input.concurrency, (chunk, batchIndex) =>
    runSufficiencyChunk({
      cwd: input.cwd,
      rows: chunk,
      batchIndex,
      options: input.options,
      defaultModelPattern: input.defaultModelPattern,
    }),
  );
  for (const rowRun of chunkRuns.flat()) runs[rowRun.index] = rowRun.run;
  return runs;
}

function liveSufficiencyRowIsEligible(
  row: IndexedTracedRow,
  options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions,
  runs: SearchStrategyFlowMarkdownCorpusAgentRun[],
): boolean {
  if (!shouldRunSearchStrategyFlowAgentJudgement(row.trace, row.intentRow.liveEvidenceRequired)) {
    return false;
  }
  const deterministic = evaluateMarkdownCorpusBenchmarkRow(row.intentRow, row.trace);
  if (deterministic.violations.length === 0) return true;
  runs[row.index] = skippedRun(
    `SearchStrategyFlow batch sufficiency skipped because deterministic gates failed: ${deterministic.violations.join(", ")}.`,
    resolveLiveAgentCandidatePoolMode(options.liveAgentCandidatePoolMode, row.trace),
  );
  return false;
}

async function runSufficiencyChunk(input: {
  cwd: string;
  rows: IndexedTracedRow[];
  batchIndex: number;
  options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions;
  defaultModelPattern: string;
}): Promise<Array<{ index: number; run: SearchStrategyFlowMarkdownCorpusAgentRun }>> {
  const startedAt = Date.now();
  const batchId = `sufficiency-${input.batchIndex + 1}`;
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
      return failedRows(input, candidatePoolModes, batchId, elapsedMs(startedAt),
        "No request auth is configured for the SearchStrategyFlow batch sufficiency gate.",
      );
    }
    const timeoutSeconds = normalizeTimeoutSeconds(input.options.liveAgentTimeoutSeconds);
    const controller = timeoutSeconds > 0 ? new AbortController() : undefined;
    const timeout = controller
      ? setTimeout(() => {
          controller.abort();
        }, timeoutSeconds * 1_000)
      : undefined;
    try {
      const bpmnResult = await runSearchStrategyFlowAgentBpmnTask({
        trace: syntheticTrace(input.rows),
        cwd: input.cwd,
        activityId: SUFFICIENCY_ACTIVITY_ID,
        prompt: buildSufficiencyPrompt(input.rows),
        compactTrace: buildCompactTrace(input.rows, candidatePoolModes),
        model: resolved.model,
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        ...(input.options.thinkingLevel ? { thinkingLevel: input.options.thinkingLevel } : {}),
        ...(input.options.qianjiCommand ? { qianjiCommand: input.options.qianjiCommand } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
      return mapOutputToRuns({
        rows: input.rows,
        output: bpmnResult.output,
        events: bpmnResult.events,
        cached: bpmnResult.cached,
        model: `${resolved.model.provider}/${resolved.model.id}`,
        candidatePoolModes,
        batchId,
        batchDurationMs: elapsedMs(startedAt),
      });
    } catch (error) {
      return failedRows(
        input,
        candidatePoolModes,
        batchId,
        elapsedMs(startedAt),
        controller?.signal.aborted === true
          ? `SearchStrategyFlow batch sufficiency BPMN/Qianji task timed out after ${timeoutSeconds}s.`
          : `SearchStrategyFlow batch sufficiency BPMN/Qianji task failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } catch (error) {
    return failedRows(
      input,
      candidatePoolModes,
      batchId,
      elapsedMs(startedAt),
      error instanceof Error ? error.message : String(error),
    );
  }
}

function mapOutputToRuns(input: {
  rows: IndexedTracedRow[];
  output: Record<string, unknown>;
  events: SearchStrategyFlowAgentEvent[];
  cached: boolean;
  model: string;
  candidatePoolModes: Map<number, SearchStrategyFlowMarkdownCorpusAgentRun["candidatePoolMode"]>;
  batchId: string;
  batchDurationMs: number;
}): Array<{ index: number; run: SearchStrategyFlowMarkdownCorpusAgentRun }> {
  const parsed = parseSufficiencyRows(input.output.branch_judgements);
  const familyErrors = validateFamilyCoverage(input.rows, parsed.rows);
  if (parsed.errors.length > 0 || familyErrors.length > 0) {
    return input.rows.map((row) => ({
      index: row.index,
      run: failedRun(
        `SearchStrategyFlow batch sufficiency output was invalid: ${[
          ...parsed.errors,
          ...familyErrors,
        ].join("; ")}`,
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
    const sufficiency = parsed.rows.get(row.intentRow.familyId);
    if (!sufficiency) {
      return {
        index: row.index,
        run: failedRun(
          `SearchStrategyFlow batch sufficiency omitted family ${row.intentRow.familyId}.`,
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
      run: sufficiency.sufficient
        ? completedRun(input, row, sufficiency)
        : failedRun(
            `SearchStrategyFlow batch sufficiency rejected ${row.intentRow.familyId}: ${sufficiency.reason}`,
            input.candidatePoolModes.get(row.index) ?? "visible",
            input.batchId,
            input.rows.length,
            input.batchDurationMs,
            input.model,
            input.events,
            sufficiency,
          ),
    };
  });
}

function validateFamilyCoverage(rows: IndexedTracedRow[], parsedRows: Map<string, SufficiencyRow>): string[] {
  const expected = new Set(rows.map((row) => row.intentRow.familyId));
  return [
    ...[...expected]
      .filter((familyId) => !parsedRows.has(familyId))
      .map((familyId) => `missing family_id ${familyId}`),
    ...[...parsedRows.keys()]
      .filter((familyId) => !expected.has(familyId))
      .map((familyId) => `unexpected family_id ${familyId}`),
  ];
}

function completedRun(
  input: {
    rows: IndexedTracedRow[];
    events: SearchStrategyFlowAgentEvent[];
    cached: boolean;
    model: string;
    candidatePoolModes: Map<number, SearchStrategyFlowMarkdownCorpusAgentRun["candidatePoolMode"]>;
    batchId: string;
    batchDurationMs: number;
  },
  row: IndexedTracedRow,
  sufficiency: SufficiencyRow,
): SearchStrategyFlowMarkdownCorpusAgentRun {
  return {
    trace: {
      mode: "qianji-service-agent",
      status: "completed",
      model: input.model,
      durationMs: input.batchDurationMs,
      cached: input.cached,
      events: input.events,
      output: {
        intent_understanding: `Batch sufficiency accepted ${row.intentRow.familyId}.`,
        branch_decision: "Selected frontier is sufficient.",
        judgement: sufficiency.reason,
        branch_judgements: [],
      },
      branchJudgementValidation: { valid: true, acceptedCount: 0, errors: [] },
    },
    attemptCount: 1,
    retryCount: 0,
    retryReasons: [],
    candidatePoolMode: input.candidatePoolModes.get(row.index) ?? "visible",
    liveAgentMode: "batch-sufficiency",
    batchId: input.batchId,
    batchSize: input.rows.length,
    batchDurationMs: input.batchDurationMs,
    sufficient: true,
    sufficiencyReason: sufficiency.reason,
  };
}

function buildSufficiencyPrompt(rows: IndexedTracedRow[]): string {
  return [
    "You are the Wendao SearchStrategyFlow batch sufficiency gate.",
    "Judge whether each row's selected frontier is sufficient for the stated intent.",
    "Do not request files, tools, or extra context. Use only the compact trace.",
    "You must fill all four Qianji output fields.",
    "- intent_understanding: one concise batch-level summary.",
    "- branch_decision: one concise batch-level decision summary.",
    "- judgement: one concise batch-level verdict.",
    "- branch_judgements: JSON array only, no Markdown.",
    'Each branch_judgements item must be {"family_id":"...","sufficient":true,"confidence":0.0,"reason":"short evidence-grounded reason"}.',
    "Return sufficient=false only when deterministic selected evidence is semantically inadequate.",
    "Use exact family_id values from the batch rows.",
    `Batch rows: ${rows.map((row) => row.intentRow.familyId).join(", ")}`,
  ].join("\n");
}

function buildCompactTrace(
  rows: IndexedTracedRow[],
  candidatePoolModes: Map<number, SearchStrategyFlowMarkdownCorpusAgentRun["candidatePoolMode"]>,
): Record<string, unknown> {
  return {
    mode: "markdown-corpus-batch-sufficiency",
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

function parseSufficiencyRows(value: unknown): {
  rows: Map<string, SufficiencyRow>;
  errors: string[];
} {
  const rawRows = parseRawRows(value);
  if (!Array.isArray(rawRows)) {
    return { rows: new Map(), errors: ["branch_judgements must be a JSON array."] };
  }
  const rows = new Map<string, SufficiencyRow>();
  const errors: string[] = [];
  rawRows.forEach((rawRow, index) => {
    const rowNumber = index + 1;
    if (!isRecord(rawRow)) {
      errors.push(`sufficiency row ${rowNumber} must be an object.`);
      return;
    }
    const familyId = readString(rawRow.family_id ?? rawRow.familyId);
    const sufficient = readBoolean(rawRow.sufficient);
    const confidence = readUnitScore(rawRow.confidence);
    const reason = readString(rawRow.reason);
    if (!familyId) errors.push(`sufficiency row ${rowNumber} missing family_id.`);
    if (familyId && rows.has(familyId)) {
      errors.push(`sufficiency row ${rowNumber} duplicates family_id ${familyId}.`);
    }
    if (sufficient === undefined) errors.push(`sufficiency row ${rowNumber} invalid sufficient.`);
    if (confidence === undefined) errors.push(`sufficiency row ${rowNumber} invalid confidence.`);
    if (!reason) errors.push(`sufficiency row ${rowNumber} missing reason.`);
    if (familyId && sufficient !== undefined && confidence !== undefined && reason) {
      rows.set(familyId, { familyId, sufficient, confidence, reason });
    }
  });
  return errors.length > 0 ? { rows: new Map(), errors } : { rows, errors: [] };
}

function parseRawRows(value: unknown): unknown {
  const parsed = parseJsonPayload(value);
  return Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? parsed.rows ??
        parsed.sufficiency_rows ??
        parsed.sufficiencyRows ??
        parsed.sufficiency_judgements ??
        parsed.sufficiencyJudgements
      : undefined;
}

function parseJsonPayload(value: unknown): unknown {
  if (Array.isArray(value) || isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function syntheticTrace(rows: IndexedTracedRow[]): SearchStrategyFlowTrace {
  const trace = rows[0]?.trace;
  if (!trace) throw new Error("SearchStrategyFlow batch sufficiency requires at least one row");
  return { ...trace, intent: `Batch sufficiency gate for ${rows.length} intent(s).` };
}

function failedRows(
  input: { rows: IndexedTracedRow[] },
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
  sufficiency?: SufficiencyRow,
): SearchStrategyFlowMarkdownCorpusAgentRun {
  return {
    trace: {
      mode: "qianji-service-agent",
      status: "failed",
      ...(model ? { model } : {}),
      durationMs: batchDurationMs,
      reason,
      events,
      branchJudgementValidation: { valid: false, acceptedCount: 0, errors: [reason] },
    },
    attemptCount: 1,
    retryCount: 0,
    retryReasons: [],
    candidatePoolMode,
    liveAgentMode: "batch-sufficiency",
    batchId,
    batchSize,
    batchDurationMs,
    sufficient: sufficiency?.sufficient ?? false,
    sufficiencyReason: sufficiency?.reason ?? reason,
  };
}

function skippedRun(
  reason: string,
  candidatePoolMode: SearchStrategyFlowMarkdownCorpusAgentRun["candidatePoolMode"],
): SearchStrategyFlowMarkdownCorpusAgentRun {
  return {
    trace: { mode: "qianji-service-agent", status: "skipped", durationMs: 0, reason, events: [] },
    attemptCount: 0,
    retryCount: 0,
    retryReasons: [],
    candidatePoolMode,
    liveAgentMode: "batch-sufficiency",
  };
}

function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function hasRequestAuth(apiKey: string | undefined, headers: Record<string, string> | undefined) {
  return Boolean(apiKey || (headers && Object.keys(headers).length > 0));
}

function normalizeTimeoutSeconds(value: number | undefined): number {
  if (value === undefined) return 180;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("--live-agent-timeout-seconds must be a non-negative number");
  }
  return Math.floor(value);
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = readString(value).toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return undefined;
}

function readUnitScore(value: unknown): number | undefined {
  const score = typeof value === "number" ? value : Number.parseFloat(readString(value));
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : undefined;
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
