import { dim } from "yoctocolors";
import type { QianjiHostWorkLogEvent } from "./types.js";
import { plural, selectReadableLines } from "./text.js";

export function formatQianjiCliOutputForLog(output: string): string[] {
  const text = output
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("@@QIANJI_TRACE "))
    .join("\n")
    .trim();
  if (!text) return [];

  const reports = parseQianjiReports(text);
  if (reports.length > 0) {
    return reports.map(formatQianjiReportForLog);
  }

  const outcomeMatches = [...text.matchAll(/^Outcome:\s*([a-z_]+)/gm)];
  if (outcomeMatches.length > 0) {
    const lastOutcome = outcomeMatches[outcomeMatches.length - 1]?.[1];
    return lastOutcome ? [dim(`qianji outcome: ${lastOutcome}`)] : [];
  }

  return selectReadableLines(text)
    .slice(0, 4)
    .map((line) => dim(`qianji: ${line}`));
}

export function formatQianjiHostWorkEventForLog(event: QianjiHostWorkLogEvent): string[] {
  const prefix = event.parallel ? "parallel jobs" : "host job";
  const tokenLabel = event.tokenIds.length === 1 ? "token" : "tokens";
  const tokens = event.tokenIds.length > 0 ? ` ${tokenLabel}=${event.tokenIds.join(",")}` : "";
  const batch =
    event.batchHostWorkCount > event.hostWorkCount ? ` batch=${event.batchHostWorkCount}` : "";
  const kinds = event.hostKinds.length > 0 ? ` kind=${event.hostKinds.join("+")}` : "";
  const repeats =
    event.repeatSummaries.length > 0 ? ` repeat=${event.repeatSummaries.join(";")}` : "";
  return [
    dim(
      `${prefix} ${event.activityId}: ${event.hostWorkCount} ${plural(event.hostWorkCount, "job")}${batch}${tokens}${kinds}${repeats}`,
    ),
  ];
}

interface QianjiReportSummary {
  title: string;
  outcome?: string;
  checkpointBackend?: string;
  checkpointSource?: string;
  checkpointSaved?: string;
  checkpointDeleted?: string;
  checkpointStatus?: string;
  pendingHostWork?: string;
}

function parseQianjiReports(text: string): QianjiReportSummary[] {
  const reportPattern = /^# BPMN (.+)$/gm;
  const matches = [...text.matchAll(reportPattern)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end =
      index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
    const block = text.slice(start, end);
    return {
      title: match[1] ?? "Report",
      outcome: extractQianjiReportField(block, "Outcome"),
      checkpointBackend: extractQianjiReportField(block, "Checkpoint backend"),
      checkpointSource: extractQianjiReportField(block, "Checkpoint source"),
      checkpointSaved: extractQianjiReportField(block, "Checkpoint saved"),
      checkpointDeleted: extractQianjiReportField(block, "Checkpoint deleted"),
      checkpointStatus: extractQianjiReportField(block, "Checkpoint status"),
      pendingHostWork: extractQianjiReportField(block, "Pending host work"),
    };
  });
}

function formatQianjiReportForLog(report: QianjiReportSummary): string {
  const title = report.title.toLowerCase();
  const parts: string[] = [];
  if (report.checkpointBackend && report.checkpointBackend !== "none") {
    parts.push(`checkpoint=${report.checkpointBackend}`);
  }
  if (report.checkpointSource) parts.push(`source=${report.checkpointSource}`);
  if (report.checkpointStatus) parts.push(`status=${report.checkpointStatus}`);
  if (report.checkpointSaved) parts.push(`saved=${report.checkpointSaved}`);
  if (report.checkpointDeleted) parts.push(`deleted=${report.checkpointDeleted}`);
  if (report.pendingHostWork && report.pendingHostWork !== "0") {
    parts.push(`pending_host=${report.pendingHostWork}`);
  }
  const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return dim(`qianji ${title}: ${report.outcome ?? "reported"}${suffix}`);
}

function extractQianjiReportField(block: string, label: string): string | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`^${escapedLabel}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}
