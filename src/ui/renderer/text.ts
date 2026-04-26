export function compactInline(text: string | undefined, maxLen: number): string {
  const compacted = (text ?? "").replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLen) return compacted;
  return `${compacted.slice(0, Math.max(0, maxLen - 3))}...`;
}

export function compactLinePreservingShape(text: string, maxLen: number): string {
  const line = text.replace(/\t/g, "  ");
  if (line.length <= maxLen) return line;
  return `${line.slice(0, Math.max(0, maxLen - 3))}...`;
}

export function clampLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `  ... ${lines.length - maxLines} more lines`];
}

export function quoteIfNeeded(text: string): string {
  if (!text) return "";
  return /\s/.test(text) ? JSON.stringify(text) : text;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function countNonEmptyLines(text: string): number {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  return Math.max(1, lines);
}

export function selectReadableLines(text: string): string[] {
  const normalized = text
    .replace(/```/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (normalized.length === 0) return [];

  const selected = normalized.slice(0, 3).map((line) => compactInline(line, 180));
  if (normalized.length > selected.length) {
    selected.push(`... ${normalized.length - selected.length} more lines`);
  }
  return selected;
}

export function formatJsonSummary(value: unknown): string {
  return formatJsonSummaryLines(value).join(", ");
}

export function formatJsonSummaryLines(value: unknown): string[] {
  if (!isRecord(value)) return [summarizeValue(value)];
  const entries = Object.entries(value);
  if (entries.length === 0) return ["empty object"];
  return entries
    .slice(0, 6)
    .map(([key, entryValue]) => `${key}: ${summarizeValue(entryValue)}`)
    .concat(entries.length > 6 ? [`... ${entries.length - 6} more keys`] : []);
}

export function summarizeValue(value: unknown): string {
  if (typeof value === "string") {
    const lines = countNonEmptyLines(value);
    if (lines > 1) return `${lines} lines`;
    return quoteIfNeeded(compactInline(value, 80));
  }
  if (Array.isArray(value)) return `${value.length} items`;
  if (isRecord(value)) return `${Object.keys(value).length} keys`;
  if (value == null) return String(value);
  return compactInline(JSON.stringify(value), 80);
}

export function plural(count: number, noun: string): string {
  return `${noun}${count === 1 ? "" : "s"}`;
}

export function shortAgentId(agentId: string): string {
  const trimmed = agentId.trim();
  if (trimmed.length <= 8) return trimmed;
  return trimmed.slice(0, 8);
}
