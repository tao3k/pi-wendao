import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveModel } from "../model-resolver.js";
import { createCliPiSubagentsHost } from "../pi-subagents.js";
import {
  loadSearchStrategyFlowAnswerRequestRows,
  parseSearchStrategyFlowLiveAnswerEvidenceTsv,
  parseSearchStrategyFlowPartialLiveAnswerEvidenceTsv,
  renderSearchStrategyFlowAnswerEvidenceTsv,
  type SearchStrategyFlowAnswerEvidenceRow,
  type SearchStrategyFlowAnswerEvidenceResult,
} from "./strategy-flow-agent-evidence.js";

const SEARCH_STRATEGY_FLOW_REQUEST_ANSWER_ACTIVITY_ID =
  "SearchStrategyFlow_MaterializedRequestAnswer";

interface SearchStrategyFlowLiveRequestAnswerOptions {
  requestPath: string;
  evidencePath: string;
  cwd: string;
  chunkSize?: number;
  resumeExisting?: boolean;
  modelPattern: string;
  provider?: string;
  apiKey?: string;
  thinkingLevel?: string;
  extensionPaths: string[];
  onChunkComplete?: (progress: SearchStrategyFlowLiveRequestAnswerProgress) => void;
}

interface SearchStrategyFlowLiveRequestAnswerProgress {
  chunkIndex: number;
  chunkCount: number;
  rowCount: number;
}

export async function writeSearchStrategyFlowLiveRequestAnswerEvidence(
  options: SearchStrategyFlowLiveRequestAnswerOptions,
): Promise<SearchStrategyFlowAnswerEvidenceResult> {
  const requestText = readFileSync(options.requestPath, "utf-8");
  const requestRows = loadSearchStrategyFlowAnswerRequestRows(options.requestPath);
  const evidenceRows: SearchStrategyFlowAnswerEvidenceRow[] = options.resumeExisting === true
    ? loadExistingEvidenceRows(options.evidencePath, requestRows)
    : [];
  const requestChunks = splitRequestTsv(
    requestText,
    requestRows,
    options.chunkSize ?? 4,
    evidenceRows.length,
  );
  if (requestChunks.length === 0) {
    writeEvidenceRows(options.evidencePath, evidenceRows);
    return { path: options.evidencePath, rowCount: evidenceRows.length };
  }
  const resolved = await resolveModel(
    options.modelPattern,
    options.provider,
    options.apiKey,
    options.extensionPaths,
  );
  if (!hasRequestAuth(resolved.apiKey, resolved.headers)) {
    throw new Error(
      "No request auth is configured for SearchStrategyFlow live request answers.",
    );
  }
  const host = createCliPiSubagentsHost({
    loadResult: resolved.loadResult,
    modelRegistry: resolved.modelRegistry,
    cwd: options.cwd,
    model: resolved.model,
    defaultRunInBackground: false,
    defaultSubagentType: "pi-wendao-output-only",
  });
  if (!host) {
    throw new Error("pi-subagents tools are not available in the loaded extensions.");
  }

  for (const [index, chunk] of requestChunks.entries()) {
    const output = await host.run({
      activityId: `${SEARCH_STRATEGY_FLOW_REQUEST_ANSWER_ACTIVITY_ID}_${index + 1}`,
      config: {
        prompt: buildLiveRequestAnswerPrompt(chunk.rows.length),
        tools: [],
        inputs: ["request_tsv"],
        outputs: ["answer_evidence_tsv"],
        subagent: {
          type: "pi-wendao-output-only",
          description: "Generate SearchStrategyFlow answer evidence from materialized request rows",
          runInBackground: false,
          model: `${resolved.model.provider}/${resolved.model.id}`,
          ...(options.thinkingLevel ? { thinking: options.thinkingLevel } : {}),
          maxTurns: 2,
        },
      },
      variables: {
        request_tsv: chunk.tsv,
      },
      execution: {
        activityId: `${SEARCH_STRATEGY_FLOW_REQUEST_ANSWER_ACTIVITY_ID}_${index + 1}`,
        nodeIndex: index,
      },
    });
    const answerEvidenceTsv = readAnswerEvidenceOutput(output.answer_evidence_tsv);
    evidenceRows.push(
      ...parseSearchStrategyFlowLiveAnswerEvidenceTsv(answerEvidenceTsv, chunk.rows),
    );
    writeEvidenceRows(options.evidencePath, evidenceRows);
    options.onChunkComplete?.({
      chunkIndex: index + 1,
      chunkCount: requestChunks.length,
      rowCount: chunk.rows.length,
    });
  }
  writeEvidenceRows(options.evidencePath, evidenceRows);
  return { path: options.evidencePath, rowCount: evidenceRows.length };
}

export function buildLiveRequestAnswerPrompt(requestCount: number): string {
  return [
    "You generate Wendao SearchStrategyFlow answer evidence from a materialized request TSV.",
    "Use only the provided request_tsv. Do not request tools, files, or extra context.",
    "Return answer_evidence_tsv as plain TSV text, with no Markdown fence and no commentary.",
    "The first row must be exactly: candidate_id<TAB>answer_text.",
    `Return exactly ${requestCount} data rows, in the same order as request_tsv.`,
    "Each candidate_id must exactly match the request row candidate_id.",
    "Each answer_text must be concise, at most 512 characters, and must include the request row's repo=, source=, evidence=, and all term= facts.",
    "If a compact_packet already satisfies that contract, copy that compact_packet byte-for-byte as answer_text.",
    "Do not rewrite punctuation, quotes, backticks, Markdown table pipes, or spaces inside term facts.",
    "Do not JSON-escape, shell-escape, or backslash-escape answer_text. A literal quote must stay \", not \\\".",
  ].join("\n");
}

function readAnswerEvidenceOutput(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("SearchStrategyFlow live request answer missing non-empty answer_evidence_tsv.");
  }
  return value.trim();
}

function splitRequestTsv(
  requestText: string,
  requestRows: ReturnType<typeof loadSearchStrategyFlowAnswerRequestRows>,
  chunkSize: number,
  startRow = 0,
): Array<{ tsv: string; rows: ReturnType<typeof loadSearchStrategyFlowAnswerRequestRows> }> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("--search-agent-answer-chunk-size must be a positive integer");
  }
  const lines = requestText.trimEnd().split(/\n/);
  const header = lines[0];
  const dataLines = lines.slice(1).filter((line) => line.trim().length > 0);
  if (dataLines.length !== requestRows.length) {
    throw new Error("SearchStrategyFlow answer request TSV row count changed during live chunking.");
  }
  const chunks = [];
  for (let start = startRow; start < requestRows.length; start += chunkSize) {
    const rows = requestRows.slice(start, start + chunkSize);
    const tsv = [header, ...dataLines.slice(start, start + chunkSize)].join("\n") + "\n";
    chunks.push({ tsv, rows });
  }
  return chunks;
}

function loadExistingEvidenceRows(
  evidencePath: string,
  requestRows: ReturnType<typeof loadSearchStrategyFlowAnswerRequestRows>,
): SearchStrategyFlowAnswerEvidenceRow[] {
  if (!existsSync(evidencePath)) return [];
  return parseSearchStrategyFlowPartialLiveAnswerEvidenceTsv(
    readFileSync(evidencePath, "utf-8"),
    requestRows,
  );
}

function writeEvidenceRows(
  evidencePath: string,
  evidenceRows: SearchStrategyFlowAnswerEvidenceRow[],
): void {
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, renderSearchStrategyFlowAnswerEvidenceTsv(evidenceRows), "utf-8");
}

function hasRequestAuth(apiKey: string | undefined, headers: Record<string, string> | undefined): boolean {
  return Boolean(apiKey || (headers && Object.keys(headers).length > 0));
}
