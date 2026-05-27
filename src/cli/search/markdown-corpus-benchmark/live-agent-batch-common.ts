import type { SearchStrategyFlowTrace } from "../strategy-flow-types.js";
import type { SearchStrategyFlowMarkdownCorpusIntentRow } from "./types.js";

export interface IndexedMarkdownCorpusTraceRow {
  index: number;
  intentRow: SearchStrategyFlowMarkdownCorpusIntentRow;
  trace: SearchStrategyFlowTrace;
}

export function parseJsonPayload(value: unknown): unknown {
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

export function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

export function hasRequestAuth(
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
): boolean {
  return Boolean(apiKey || (headers && Object.keys(headers).length > 0));
}

export function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

function stripJsonFence(value: string): string {
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? (fenced[1]?.trim() ?? "") : value;
}
