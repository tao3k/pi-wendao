import { readFileSync } from "node:fs";
import type { SearchStrategyFlowMarkdownCorpusIntentRow } from "./types.js";

export function parseMarkdownCorpusIntentFixture(
  fixturePath: string,
): SearchStrategyFlowMarkdownCorpusIntentRow[] {
  const text = readFileSync(fixturePath, "utf-8").trim();
  if (!text) throw new Error(`Markdown corpus intent fixture is empty: ${fixturePath}`);
  return parseMarkdownCorpusIntentOrgFixture(text, fixturePath);
}

export function limitRows<T>(rows: T[], limit: number | undefined): T[] {
  if (limit === undefined) return rows;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  return rows.slice(0, limit);
}

function parseMarkdownCorpusIntentOrgFixture(
  text: string,
  fixturePath: string,
): SearchStrategyFlowMarkdownCorpusIntentRow[] {
  const rows: SearchStrategyFlowMarkdownCorpusIntentRow[] = [];
  const seenFamilyIds = new Set<string>();
  let currentHeading = "";
  let currentProperties: Record<string, string> | undefined;
  let inDrawer = false;

  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trimEnd();
    const heading = line.match(/^\*+\s+(.+)$/);
    if (heading) {
      flushCurrentRow();
      currentHeading = heading[1]?.trim() ?? "";
      continue;
    }
    if (line.trim() === ":PROPERTIES:") {
      if (inDrawer) throw new Error(`nested Org property drawer in ${fixturePath}:${lineIndex + 1}`);
      inDrawer = true;
      currentProperties = {};
      continue;
    }
    if (line.trim() === ":END:") {
      if (!inDrawer) throw new Error(`unexpected Org property drawer end in ${fixturePath}:${lineIndex + 1}`);
      inDrawer = false;
      continue;
    }
    if (!inDrawer) continue;
    const property = line.match(/^:([A-Z0-9_]+):\s*(.*)$/);
    if (!property) throw new Error(`invalid Org property row in ${fixturePath}:${lineIndex + 1}`);
    if (currentProperties === undefined) {
      throw new Error(`Org property without active drawer in ${fixturePath}:${lineIndex + 1}`);
    }
    const key = property[1] ?? "";
    if (Object.hasOwn(currentProperties, key)) {
      throw new Error(`duplicate Org property ${key} in ${fixturePath}:${lineIndex + 1}`);
    }
    currentProperties[key] = property[2]?.trim() ?? "";
  }
  flushCurrentRow();

  if (inDrawer) throw new Error(`unterminated Org property drawer in ${fixturePath}`);
  if (rows.length === 0) throw new Error(`Markdown corpus intent Org fixture has no intent rows: ${fixturePath}`);
  return rows;

  function flushCurrentRow(): void {
    if (currentProperties === undefined) return;
    const row = intentRowFromProperties(currentProperties, rows.length + 1, currentHeading);
    if (seenFamilyIds.has(row.familyId)) {
      throw new Error(`duplicate Markdown corpus intent family id: ${row.familyId}`);
    }
    seenFamilyIds.add(row.familyId);
    rows.push(row);
    currentProperties = undefined;
  }
}

function intentRowFromProperties(
  properties: Record<string, string>,
  rowNumber: number,
  heading: string,
): SearchStrategyFlowMarkdownCorpusIntentRow {
  return {
    familyId: requireOrgProperty(properties, "FAMILY_ID", rowNumber, heading),
    intent: requireOrgProperty(properties, "INTENT", rowNumber, heading),
    requiredEvidence: splitList(requireOrgProperty(properties, "REQUIRED_EVIDENCE", rowNumber, heading)),
    expectedSourcePaths: splitList(requireOrgProperty(properties, "EXPECTED_SOURCE_PATHS", rowNumber, heading)),
    blockedSourcePaths: splitList(properties.BLOCKED_SOURCE_PATHS ?? ""),
    liveEvidenceRequired: parseBooleanOrgProperty(
      requireOrgProperty(properties, "LIVE_EVIDENCE_REQUIRED", rowNumber, heading),
      rowNumber,
      heading,
    ),
    promotionStatus: requireOrgProperty(properties, "PROMOTION_STATUS", rowNumber, heading),
  };
}

function requireOrgProperty(
  properties: Record<string, string>,
  key: string,
  rowNumber: number,
  heading: string,
): string {
  const value = properties[key]?.trim();
  if (!value) {
    throw new Error(`Markdown corpus intent row ${rowNumber} (${heading || "no heading"}) missing ${key}.`);
  }
  return value;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseBooleanOrgProperty(value: string, rowNumber: number, heading: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(
    `Markdown corpus intent row ${rowNumber} (${heading || "no heading"}) has invalid LIVE_EVIDENCE_REQUIRED: ${value}.`,
  );
}
