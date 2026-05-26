import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { resolveModel } from "../model-resolver.js";
import type { PiWendaoThinkingLevel } from "../../executor/agent-runtime-types.js";
import { execute } from "../../executor/executor.js";
import { createPiAiHost } from "../../executor/node-runner.js";
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
const PROCESS_ID = "Process_SearchStrategyFlowMaterializedAnswer";
const SERVICE_TASK_IMPLEMENTATION = "${environment.services.runAgent}";

interface SearchStrategyFlowLiveRequestAnswerOptions {
  requestPath: string;
  evidencePath: string;
  cwd: string;
  chunkSize?: number;
  resumeExisting?: boolean;
  modelPattern: string;
  provider?: string;
  apiKey?: string;
  thinkingLevel?: PiWendaoThinkingLevel;
  qianjiCommand?: string;
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
  for (const [index, chunk] of requestChunks.entries()) {
    const output = await runLiveRequestAnswerChunk({
      activityId: `${SEARCH_STRATEGY_FLOW_REQUEST_ANSWER_ACTIVITY_ID}_${index + 1}`,
      prompt: buildLiveRequestAnswerPrompt(chunk.rows.length),
      requestTsv: chunk.tsv,
      cwd: options.cwd,
      model: resolved.model,
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      ...(options.qianjiCommand ? { qianjiCommand: options.qianjiCommand } : {}),
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

interface LiveRequestAnswerChunkOptions {
  activityId: string;
  prompt: string;
  requestTsv: string;
  cwd: string;
  model: Model<string>;
  apiKey?: string;
  thinkingLevel?: PiWendaoThinkingLevel;
  qianjiCommand?: string;
}

async function runLiveRequestAnswerChunk(
  options: LiveRequestAnswerChunkOptions,
): Promise<Record<string, unknown>> {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-wendao-search-answer-bpmn-"));
  try {
    const workflowPath = join(tempDir, "search-strategy-flow-answer.bpmn");
    const workflowSource = buildLiveRequestAnswerBpmn(options);
    await writeFile(workflowPath, workflowSource, "utf-8");
    const result = await execute({
      source: workflowSource,
      sourcePath: workflowPath,
      cwd: options.cwd,
      processId: PROCESS_ID,
      instanceId: liveRequestAnswerInstanceId(options, workflowSource, workflowPath),
      ...(options.qianjiCommand ?? process.env.QIANJI_CLI
        ? { qianjiCommand: options.qianjiCommand ?? process.env.QIANJI_CLI }
        : {}),
      context: {
        request_tsv: options.requestTsv,
      },
      agentHost: createPiAiHost({
        model: options.model,
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        cwd: options.cwd,
        ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      }),
    });
    if (!result.success) {
      throw new Error(result.error ?? "SearchStrategyFlow Qianji answer task failed");
    }
    return result.variables;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildLiveRequestAnswerBpmn(options: LiveRequestAnswerChunkOptions): string {
  const taskId = options.activityId;
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             id="Definitions_SearchStrategyFlowMaterializedAnswer"
             targetNamespace="https://wendao.dev/pi/search-strategy-flow">
  <process id="${PROCESS_ID}" isExecutable="true">
    <startEvent id="Start_SearchStrategyFlowMaterializedAnswer" name="Start"/>
    <serviceTask id="${escapeXmlAttr(taskId)}" name="SearchStrategyFlow materialized answer" implementation="${escapeXmlAttr(SERVICE_TASK_IMPLEMENTATION)}">
      <documentation>${escapeXmlText(options.prompt)}</documentation>
      <ioSpecification>
        <dataInput id="${dataInputId(taskId, "request_tsv")}" name="request_tsv" />
        <dataOutput id="${dataOutputId(taskId, "answer_evidence_tsv")}" name="answer_evidence_tsv" />
        <inputSet id="${escapeXmlAttr(taskId)}_input_set">
          <dataInputRefs>${dataInputId(taskId, "request_tsv")}</dataInputRefs>
        </inputSet>
        <outputSet id="${escapeXmlAttr(taskId)}_output_set">
          <dataOutputRefs>${dataOutputId(taskId, "answer_evidence_tsv")}</dataOutputRefs>
        </outputSet>
      </ioSpecification>
    <dataInputAssociation>
      <sourceRef>request_tsv</sourceRef>
      <targetRef>${dataInputId(taskId, "request_tsv")}</targetRef>
    </dataInputAssociation>
    <dataOutputAssociation>
      <sourceRef>${dataOutputId(taskId, "answer_evidence_tsv")}</sourceRef>
      <targetRef>answer_evidence_tsv</targetRef>
    </dataOutputAssociation>
    </serviceTask>
    <endEvent id="End_SearchStrategyFlowMaterializedAnswer" name="Done"/>
    <sequenceFlow id="Flow_SearchStrategyFlowMaterializedAnswer_Start" sourceRef="Start_SearchStrategyFlowMaterializedAnswer" targetRef="${escapeXmlAttr(taskId)}" />
    <sequenceFlow id="Flow_SearchStrategyFlowMaterializedAnswer_Done" sourceRef="${escapeXmlAttr(taskId)}" targetRef="End_SearchStrategyFlowMaterializedAnswer" />
  </process>
</definitions>`;
}

function liveRequestAnswerInstanceId(
  options: LiveRequestAnswerChunkOptions,
  workflowSource: string,
  workflowPath: string,
): string {
  const digest = createHash("sha256")
    .update(workflowSource)
    .update(workflowPath)
    .update(options.requestTsv)
    .digest("hex")
    .slice(0, 16);
  return `search-strategy-flow-answer-${digest}`;
}

function dataInputId(taskId: string, name: string): string {
  return `${escapeXmlAttr(taskId)}_input_${escapeXmlAttr(name)}`;
}

function dataOutputId(taskId: string, name: string): string {
  return `${escapeXmlAttr(taskId)}_output_${escapeXmlAttr(name)}`;
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
