import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  SearchStrategyFlowAgentTrace,
  SearchStrategyFlowFrontierRow,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";

export interface SearchStrategyFlowAnswerEvidenceRow {
  candidateId: string;
  answerText: string;
}

interface SearchStrategyFlowAnswerRequestRow {
  candidateId: string;
  packetId: string;
  repoId: string;
  sourceRelativePath: string;
  evidenceKind: string;
  requiredTerms: string[];
  compactPacket: string;
  answerContract: string;
}

export interface SearchStrategyFlowAnswerEvidenceResult {
  path: string;
  rowCount: number;
}

export function writeSearchStrategyFlowAgentAnswerEvidence(
  path: string,
  trace: SearchStrategyFlowTrace,
  agentTrace: SearchStrategyFlowAgentTrace | undefined,
  deterministicTrace?: SearchStrategyFlowTrace,
): SearchStrategyFlowAnswerEvidenceResult {
  const rows = buildSearchStrategyFlowAgentAnswerEvidenceRows(trace, agentTrace, deterministicTrace);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderSearchStrategyFlowAnswerEvidenceTsv(rows), "utf-8");
  return { path, rowCount: rows.length };
}

export function writeSearchStrategyFlowRequestAnswerEvidence(
  requestPath: string,
  evidencePath: string,
): SearchStrategyFlowAnswerEvidenceResult {
  const requestRows = loadSearchStrategyFlowAnswerRequestRows(requestPath);
  const evidenceRows = buildSearchStrategyFlowRequestAnswerEvidenceRows(requestRows);
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, renderSearchStrategyFlowAnswerEvidenceTsv(evidenceRows), "utf-8");
  return { path: evidencePath, rowCount: evidenceRows.length };
}

export function buildSearchStrategyFlowAgentAnswerEvidenceRows(
  trace: SearchStrategyFlowTrace,
  agentTrace: SearchStrategyFlowAgentTrace | undefined,
  deterministicTrace?: SearchStrategyFlowTrace,
): SearchStrategyFlowAnswerEvidenceRow[] {
  const selectedFrontier = selectedFrontierRowsWithDeterministicBaseline(
    trace,
    deterministicTrace,
    agentTrace,
  );
  if (selectedFrontier.length === 0) {
    throw new Error("SearchStrategyFlow live answer evidence requires at least one selected frontier row.");
  }

  const answerText = renderAgentAnswerText(agentTrace);

  return selectedFrontier.map((row) => ({
    candidateId: row.candidateId,
    answerText: renderCandidateScopedAnswerText(row, answerText),
  }));
}

function selectedFrontierRowsWithDeterministicBaseline(
  trace: SearchStrategyFlowTrace,
  deterministicTrace: SearchStrategyFlowTrace | undefined,
  agentTrace?: SearchStrategyFlowAgentTrace,
): SearchStrategyFlowFrontierRow[] {
  const selectedRows: SearchStrategyFlowFrontierRow[] = [];
  const selectedIds = new Set<string>();
  const deterministicRows = deterministicTrace?.frontier ?? trace.frontier;
  for (const row of deterministicRows) {
    if (!row.selected || selectedIds.has(row.candidateId)) continue;
    selectedRows.push(row);
    selectedIds.add(row.candidateId);
  }
  if (selectedRows.length > 0 && deterministicTrace?.validation?.requiredEvidenceCovered === true) {
    return selectedRows;
  }

  const acceptedExpansionIds = new Set(
    (agentTrace?.branchJudgements ?? [])
      .filter((row) =>
        row.decision === "expand" &&
        row.blocked === false &&
        row.judgementScore >= 0.86 &&
        row.confidence >= 0.72,
      )
      .map((row) => row.candidateId),
  );
  for (const row of trace.frontier) {
    if (
      !row.selected ||
      selectedIds.has(row.candidateId) ||
      !acceptedExpansionIds.has(row.candidateId)
    ) {
      continue;
    }
    selectedRows.push(row);
    selectedIds.add(row.candidateId);
  }
  return selectedRows;
}

export function loadSearchStrategyFlowAnswerRequestRows(
  path: string,
): SearchStrategyFlowAnswerRequestRow[] {
  const text = readFileSync(path, "utf-8");
  const lines = text.trimEnd().split(/\n/);
  if (lines.length === 0 || lines[0].trim().length === 0) {
    throw new Error("SearchStrategyFlow answer request TSV is empty.");
  }
  const header = lines[0].split("\t");
  const expectedHeader = [
    "candidate_id",
    "packet_id",
    "repo_id",
    "source_relative_path",
    "evidence_kind",
    "required_terms",
    "compact_packet",
    "answer_contract",
  ];
  if (header.join("\t") !== expectedHeader.join("\t")) {
    throw new Error(
      `SearchStrategyFlow answer request TSV has invalid header: ${header.join("\t")}`,
    );
  }

  return lines.slice(1).filter((line) => line.trim().length > 0).map((line, index) => {
    const fields = line.split("\t");
    if (fields.length !== expectedHeader.length) {
      throw new Error(
        `SearchStrategyFlow answer request TSV row ${index + 2} has ${fields.length} fields; expected ${expectedHeader.length}.`,
      );
    }
    const [
      candidateId,
      packetId,
      repoId,
      sourceRelativePath,
      evidenceKind,
      requiredTerms,
      compactPacket,
      answerContract,
    ] = fields;
    const row = {
      candidateId,
      packetId,
      repoId,
      sourceRelativePath,
      evidenceKind,
      requiredTerms: requiredTerms.split("|").filter((term) => term.trim().length > 0),
      compactPacket,
      answerContract,
    };
    assertNonEmptyRequestRow(row, index + 2);
    return row;
  });
}

export function buildSearchStrategyFlowRequestAnswerEvidenceRows(
  requestRows: SearchStrategyFlowAnswerRequestRow[],
): SearchStrategyFlowAnswerEvidenceRow[] {
  if (requestRows.length === 0) {
    throw new Error("SearchStrategyFlow answer request TSV must contain at least one request row.");
  }
  return requestRows.map((row) => ({
    candidateId: row.candidateId,
    answerText: renderRequestScopedAnswerText(row),
  }));
}

export function parseSearchStrategyFlowLiveAnswerEvidenceTsv(
  text: string,
  requestRows: ReturnType<typeof loadSearchStrategyFlowAnswerRequestRows>,
): SearchStrategyFlowAnswerEvidenceRow[] {
  const lines = text.trim().split(/\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new Error("SearchStrategyFlow live request answer output is empty.");
  }
  if (lines[0] !== "candidate_id\tanswer_text") {
    throw new Error("SearchStrategyFlow live request answer output must start with candidate_id<TAB>answer_text.");
  }
  const rows = lines.slice(1).map((line, index) => {
    const fields = line.split("\t");
    if (fields.length < 2) {
      throw new Error(
        `SearchStrategyFlow live request answer row ${index + 2} has no answer_text field.`,
      );
    }
    const candidateId = fields[0] ?? "";
    const answerText = normalizeLiveModelAnswerText(fields.slice(1).join("\t"));
    if (candidateId.trim().length === 0 || answerText.trim().length === 0) {
      throw new Error(
        `SearchStrategyFlow live request answer row ${index + 2} has empty candidate_id or answer_text.`,
      );
    }
    if (answerText.length > 512) {
      throw new Error(
        `SearchStrategyFlow live request answer row ${index + 2} exceeds the 512 character evidence bound.`,
      );
    }
    return { candidateId, answerText };
  });

  const expectedIds = requestRows.map((row) => row.candidateId);
  const observedIds = rows.map((row) => row.candidateId);
  if (rows.length !== requestRows.length) {
    throw new Error(
      `SearchStrategyFlow live request answer output has ${rows.length} row(s); expected ${requestRows.length}.`,
    );
  }
  const duplicateId = firstDuplicate(observedIds);
  if (duplicateId) {
    throw new Error(`SearchStrategyFlow live request answer output duplicates candidate id ${duplicateId}.`);
  }
  for (let index = 0; index < expectedIds.length; index += 1) {
    if (observedIds[index] !== expectedIds[index]) {
      throw new Error(
        `SearchStrategyFlow live request answer row ${index + 2} candidate mismatch: expected ${expectedIds[index]}, got ${observedIds[index] ?? "<missing>"}.`,
      );
    }
  }
  return rows;
}

export function parseSearchStrategyFlowPartialLiveAnswerEvidenceTsv(
  text: string,
  requestRows: ReturnType<typeof loadSearchStrategyFlowAnswerRequestRows>,
): SearchStrategyFlowAnswerEvidenceRow[] {
  const rowCount = text.trim().split(/\n/).filter((line) => line.trim().length > 0).length - 1;
  return parseSearchStrategyFlowLiveAnswerEvidenceTsv(
    text,
    requestRows.slice(0, Math.max(rowCount, 0)),
  );
}

export function renderSearchStrategyFlowAnswerEvidenceTsv(
  rows: SearchStrategyFlowAnswerEvidenceRow[],
): string {
  return [
    "candidate_id\tanswer_text",
    ...rows.map((row) => `${escapeTsvCell(row.candidateId)}\t${escapeTsvCell(row.answerText)}`),
  ].join("\n") + "\n";
}

function renderAgentAnswerText(agentTrace: SearchStrategyFlowAgentTrace | undefined): string {
  if (agentTrace?.status === "completed") {
    const intentUnderstanding = readOutput(agentTrace, "intent_understanding");
    const branchDecision = readOutput(agentTrace, "branch_decision");
    const judgement = readOutput(agentTrace, "judgement");
    return [
      `intent_understanding=${intentUnderstanding}`,
      `branch_decision=${branchDecision}`,
      `judgement=${judgement}`,
    ].join("; ");
  }

  const status = agentTrace?.status ?? "unavailable";
  const reason = normalizeWhitespace(agentTrace?.reason ?? "");
  const judgement = reason.length > 0
    ? `Live agent ${status}: ${reason}; deterministic frontier evidence retained.`
    : `Live agent ${status}; deterministic frontier evidence retained.`;
  return [
    "intent_understanding=Deterministic SearchStrategyFlow frontier selected the evidence rows.",
    "branch_decision=Retain deterministic selected frontier baseline.",
    `judgement=${judgement}`,
  ].join("; ");
}

function readOutput(
  agentTrace: SearchStrategyFlowAgentTrace,
  key: "intent_understanding" | "branch_decision" | "judgement",
): string {
  const value = agentTrace.output?.[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`SearchStrategyFlow live answer evidence missing non-empty ${key}.`);
  }
  return normalizeWhitespace(value);
}

function renderCandidateScopedAnswerText(
  row: SearchStrategyFlowFrontierRow,
  answerText: string,
): string {
  return [
    `candidate_id=${row.candidateId}`,
    `frontier_rank=${row.rank}`,
    `frontier_action=${row.action}`,
    `judgement_kind=${row.judgementKind}`,
    answerText,
  ].join("; ");
}

function assertNonEmptyRequestRow(
  row: SearchStrategyFlowAnswerRequestRow,
  lineNumber: number,
): void {
  const requiredStringFields: Array<keyof Omit<SearchStrategyFlowAnswerRequestRow, "requiredTerms">> = [
    "candidateId",
    "packetId",
    "repoId",
    "sourceRelativePath",
    "evidenceKind",
    "compactPacket",
    "answerContract",
  ];
  for (const field of requiredStringFields) {
    if (row[field].trim().length === 0) {
      throw new Error(`SearchStrategyFlow answer request TSV row ${lineNumber} missing ${field}.`);
    }
  }
  if (row.requiredTerms.length === 0) {
    throw new Error(
      `SearchStrategyFlow answer request TSV row ${lineNumber} missing requiredTerms.`,
    );
  }
}

function renderRequestScopedAnswerText(row: SearchStrategyFlowAnswerRequestRow): string {
  return row.compactPacket;
}

function escapeTsvCell(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").trim();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeLiveModelAnswerText(value: string): string {
  return value.replace(/\\"/g, "\"");
}

function firstDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}
