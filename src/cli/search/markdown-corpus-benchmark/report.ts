import { DEFAULT_LIVE_QIANJI_CONCURRENCY } from "./concurrency.js";
import {
  WENDAO_NO_DATA_PLANE,
  WENDAO_PROCESS_ARGS_CONTROL_PLANE,
} from "../../../arrow/boundary.js";
import type {
  SearchStrategyFlowMarkdownCorpusBenchmarkReportDto,
  SearchStrategyFlowMarkdownCorpusBenchmarkRow,
} from "./types.js";

export function summarizeMarkdownCorpusBenchmarkReport(
  fixturePath: string,
  live: boolean,
  rows: SearchStrategyFlowMarkdownCorpusBenchmarkRow[],
  options: {
    liveQianjiConcurrency?: number;
    traceDataPlane?: SearchStrategyFlowMarkdownCorpusBenchmarkReportDto["traceDataPlane"];
    traceControlEnvelope?: SearchStrategyFlowMarkdownCorpusBenchmarkReportDto["traceControlEnvelope"];
    rustBridgeSession?: boolean;
    rustBridgeSessionTiming?: SearchStrategyFlowMarkdownCorpusBenchmarkReportDto["rustBridgeSessionTiming"];
    liveAgentMode?: SearchStrategyFlowMarkdownCorpusBenchmarkReportDto["liveAgentMode"];
    liveAgentBatchSize?: number;
    wallDurationMs?: number;
  } = {},
): SearchStrategyFlowMarkdownCorpusBenchmarkReportDto {
  const liveDurations = rows
    .map((row) => row.liveDurationMs)
    .filter((duration): duration is number => typeof duration === "number");
  const routeMaterializationDurations = rows
    .map((row) => row.routeMaterializationMs)
    .filter((duration): duration is number => typeof duration === "number");
  const candidateDiscoveryDurations = rows
    .map((row) => row.candidateDiscoveryMs)
    .filter((duration): duration is number => typeof duration === "number");
  const uniqueBatchRows = uniqueLiveBatchRows(rows);
  const batchDurations = uniqueBatchRows
    .map((row) => row.liveBatchDurationMs)
    .filter((duration): duration is number => typeof duration === "number");
  return {
    fixturePath,
    live,
    rowCount: rows.length,
    passedCount: rows.filter((row) => row.passed).length,
    failedCount: rows.filter((row) => !row.passed).length,
    requiredEvidenceCoveredCount: rows.filter((row) => row.requiredEvidenceCovered).length,
    expectedSourceHitCount: rows.filter((row) => row.expectedSourceHit).length,
    blockedSourceSelectedCount: rows.filter((row) => row.blockedSourceSelected).length,
    promotionEligibleCount: rows.filter((row) => row.promotionEligible).length,
    liveCompletedCount: rows.filter((row) => row.liveStatus === "completed").length,
    liveRetriedCount: rows.filter((row) => (row.liveRetryCount ?? 0) > 0).length,
    liveRetryRecoveredCount: rows.filter(
      (row) => (row.liveRetryCount ?? 0) > 0 && row.liveStatus === "completed",
    ).length,
    totalLiveAttemptCount: rows.reduce((sum, row) => sum + (row.liveAttemptCount ?? 0), 0),
    liveAgentCandidatePoolMode: rows.find((row) => row.liveCandidatePoolMode)
      ?.liveCandidatePoolMode,
    liveAgentMode: options.liveAgentMode ?? "branch-judgement",
    liveBatchCount: uniqueBatchRows.length,
    liveBatchSize: options.liveAgentBatchSize,
    totalLiveBatchDurationMs: batchDurations.reduce((sum, duration) => sum + duration, 0),
    maxLiveBatchDurationMs: batchDurations.length > 0 ? Math.max(...batchDurations) : 0,
    liveQianjiConcurrency:
      options.liveQianjiConcurrency ?? (live ? DEFAULT_LIVE_QIANJI_CONCURRENCY : 0),
    traceDataPlane: options.traceDataPlane ?? WENDAO_NO_DATA_PLANE,
    traceControlEnvelope: options.traceControlEnvelope ?? WENDAO_PROCESS_ARGS_CONTROL_PLANE,
    rustBridgeSession: options.rustBridgeSession ?? false,
    rustBridgeSessionTiming: options.rustBridgeSessionTiming,
    totalCandidateDiscoveryMs: candidateDiscoveryDurations.reduce(
      (sum, duration) => sum + duration,
      0,
    ),
    maxCandidateDiscoveryMs:
      candidateDiscoveryDurations.length > 0 ? Math.max(...candidateDiscoveryDurations) : 0,
    totalRouteMaterializationMs: routeMaterializationDurations.reduce(
      (sum, duration) => sum + duration,
      0,
    ),
    maxRouteMaterializationMs:
      routeMaterializationDurations.length > 0 ? Math.max(...routeMaterializationDurations) : 0,
    wallDurationMs: options.wallDurationMs ?? 0,
    totalLiveDurationMs: liveDurations.reduce((sum, duration) => sum + duration, 0),
    maxLiveDurationMs: liveDurations.length > 0 ? Math.max(...liveDurations) : 0,
    rows,
  };
}

export function renderMarkdownCorpusBenchmarkReport(
  report: SearchStrategyFlowMarkdownCorpusBenchmarkReportDto,
): string {
  const lines = [
    "# SearchStrategyFlow Markdown Corpus Benchmark",
    "",
    "| metric | value |",
    "| --- | ---: |",
    `| live | \`${String(report.live)}\` |`,
    `| rows | \`${report.rowCount}\` |`,
    `| passed | \`${report.passedCount}\` |`,
    `| failed | \`${report.failedCount}\` |`,
    `| required evidence covered | \`${report.requiredEvidenceCoveredCount}\` |`,
    `| expected source hit | \`${report.expectedSourceHitCount}\` |`,
    `| blocked source selected | \`${report.blockedSourceSelectedCount}\` |`,
    `| promotion eligible | \`${report.promotionEligibleCount}\` |`,
    `| live completed | \`${report.liveCompletedCount}\` |`,
    `| live retried | \`${report.liveRetriedCount}\` |`,
    `| live retry recovered | \`${report.liveRetryRecoveredCount}\` |`,
    `| total live attempts | \`${report.totalLiveAttemptCount}\` |`,
    `| live agent mode | \`${report.liveAgentMode}\` |`,
    `| live agent candidate pool mode | \`${report.liveAgentCandidatePoolMode ?? "not-run"}\` |`,
    `| live batch count | \`${report.liveBatchCount}\` |`,
    `| live batch size | \`${report.liveBatchSize ?? "not-run"}\` |`,
    `| total live batch duration ms | \`${report.totalLiveBatchDurationMs}\` |`,
    `| max live batch duration ms | \`${report.maxLiveBatchDurationMs}\` |`,
    `| live qianji concurrency | \`${report.liveQianjiConcurrency}\` |`,
    `| trace data plane | \`${report.traceDataPlane}\` |`,
    `| trace control envelope | \`${report.traceControlEnvelope}\` |`,
    `| rust bridge session | \`${String(report.rustBridgeSession)}\` |`,
    ...renderRustBridgeSessionTimingRows(report),
    `| total candidate discovery ms | \`${report.totalCandidateDiscoveryMs}\` |`,
    `| max candidate discovery ms | \`${report.maxCandidateDiscoveryMs}\` |`,
    `| total route materialization ms | \`${report.totalRouteMaterializationMs}\` |`,
    `| max route materialization ms | \`${report.maxRouteMaterializationMs}\` |`,
    `| wall duration ms | \`${report.wallDurationMs}\` |`,
    `| total live duration ms | \`${report.totalLiveDurationMs}\` |`,
    `| max live duration ms | \`${report.maxLiveDurationMs}\` |`,
    "",
    "| family | passed | mode | promotion | backend | selected | required evidence | expected source hit | live | agent mode | sufficient | candidate pool | attempts | retries | live reason | violations |",
    "| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | ---: | ---: | --- | --- |",
  ];
  for (const row of report.rows) {
    lines.push(
      `| ${escapeMarkdownCell(row.familyId)} | \`${String(row.passed)}\` | \`${row.executionMode}\` | \`${String(row.promotionEligible)}\` | \`${escapeMarkdownCell(row.backend)}\` | \`${row.selectedCount}\` | ${escapeMarkdownCell(row.selectedRequiredEvidence.join(","))} | \`${String(row.expectedSourceHit)}\` | \`${escapeMarkdownCell(row.liveStatus ?? "not-run")}\` | \`${row.liveAgentMode ?? "not-run"}\` | \`${row.liveSufficient ?? "not-run"}\` | \`${row.liveCandidatePoolMode ?? "not-run"}\` | \`${row.liveAttemptCount ?? 0}\` | \`${row.liveRetryCount ?? 0}\` | ${escapeMarkdownCell(row.liveReason ?? "")} | ${escapeMarkdownCell(row.violations.join(","))} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function uniqueLiveBatchRows(
  rows: SearchStrategyFlowMarkdownCorpusBenchmarkRow[],
): SearchStrategyFlowMarkdownCorpusBenchmarkRow[] {
  const seen = new Set<string>();
  const uniqueRows: SearchStrategyFlowMarkdownCorpusBenchmarkRow[] = [];
  for (const row of rows) {
    if (!row.liveBatchId) continue;
    if (seen.has(row.liveBatchId)) continue;
    seen.add(row.liveBatchId);
    uniqueRows.push(row);
  }
  return uniqueRows;
}

function renderRustBridgeSessionTimingRows(
  report: SearchStrategyFlowMarkdownCorpusBenchmarkReportDto,
): string[] {
  const timing = report.rustBridgeSessionTiming;
  if (!timing) return [];
  const rows = [
    `| rust bridge requests | \`${timing.requestCount}\` |`,
    `| rust bridge session duration ms | \`${timing.sessionDurationMs}\` |`,
    `| rust bridge first response ms | \`${timing.firstResponseMs}\` |`,
    `| rust bridge response span ms | \`${timing.responseSpanMs}\` |`,
    `| rust bridge max response gap ms | \`${timing.maxResponseGapMs}\` |`,
  ];
  if ((timing.warmupRequestCount ?? 0) > 0) {
    rows.push(
      `| rust bridge warmup requests | \`${timing.warmupRequestCount}\` |`,
      `| rust bridge warmup duration ms | \`${timing.warmupDurationMs ?? 0}\` |`,
      `| rust bridge steady-state duration ms | \`${timing.steadyStateDurationMs ?? 0}\` |`,
      `| rust bridge steady-state first response ms | \`${timing.steadyStateFirstResponseMs ?? 0}\` |`,
      `| rust bridge steady-state response span ms | \`${timing.steadyStateResponseSpanMs ?? 0}\` |`,
      `| rust bridge steady-state max response gap ms | \`${timing.steadyStateMaxResponseGapMs ?? 0}\` |`,
    );
  }
  return rows;
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "\\|");
}
