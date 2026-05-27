import type {
  WorkflowSubagentBenchmarkReport,
  WorkflowSubagentBenchmarkRow,
  WorkflowSubagentBenchmarkSummary,
} from "./types.js";

export function summarizeWorkflowSubagentBenchmarkReport(
  rows: WorkflowSubagentBenchmarkRow[],
): WorkflowSubagentBenchmarkSummary {
  const deterministicRows = passedRows(rows, "qianji-complex-fixture");
  const deterministicSubagentRows = passedRows(rows, "pi-wendao-deterministic-complex-subagent");
  const serverSubagentRows = passedRows(rows, "qianji-server-deterministic-complex-subagent");
  const serverFreshStartSubagentRows = passedRows(
    rows,
    "qianji-server-fresh-start-deterministic-complex-subagent",
  );
  const liveRows = passedRows(rows, "pi-wendao-live-complex-subagent");
  const deterministicAvgMs = average(deterministicRows.map((row) => row.wallMs));
  const deterministicSubagentAvgMs = average(deterministicSubagentRows.map((row) => row.wallMs));
  const serverSubagentAvgMs = average(serverSubagentRows.map((row) => row.wallMs));
  const serverFreshStartSubagentAvgMs = average(
    serverFreshStartSubagentRows.map((row) => row.wallMs),
  );
  const liveAvgMs = average(liveRows.map((row) => row.wallMs));
  return {
    rowCount: rows.length,
    passedCount: rows.filter((row) => row.status === "passed").length,
    failedCount: rows.filter((row) => row.status === "failed").length,
    skippedCount: rows.filter((row) => row.status === "skipped").length,
    deterministicAvgMs,
    deterministicSubagentAvgMs,
    serverSubagentAvgMs,
    serverFreshStartSubagentAvgMs,
    deterministicSubagentDeltaAvgMs:
      deterministicSubagentAvgMs > 0 && deterministicAvgMs > 0
        ? deterministicSubagentAvgMs - deterministicAvgMs
        : 0,
    serverSubagentDeltaAvgMs:
      serverSubagentAvgMs > 0 && deterministicAvgMs > 0
        ? serverSubagentAvgMs - deterministicAvgMs
        : 0,
    serverFreshStartSubagentDeltaAvgMs:
      serverFreshStartSubagentAvgMs > 0 && deterministicAvgMs > 0
        ? serverFreshStartSubagentAvgMs - deterministicAvgMs
        : 0,
    liveAvgMs,
    liveDeltaAvgMs: liveAvgMs > 0 && deterministicAvgMs > 0 ? liveAvgMs - deterministicAvgMs : 0,
  };
}

export function renderWorkflowSubagentBenchmarkReport(
  report: WorkflowSubagentBenchmarkReport,
): string {
  const lines = [
    "# Workflow Subagent BPMN Benchmark",
    "",
    `Fixture: \`${report.fixturePath}\``,
    `Process: \`${report.processId}\``,
    `Iterations: \`${report.iterations}\``,
    `Live model: \`${report.live}\``,
    "",
    "## Summary",
    "",
    `- Rows: ${report.summary.rowCount}`,
    `- Passed: ${report.summary.passedCount}`,
    `- Failed: ${report.summary.failedCount}`,
    `- Skipped: ${report.summary.skippedCount}`,
    `- Deterministic qianji avg: ${formatMs(report.summary.deterministicAvgMs)}`,
    `- Deterministic subagent avg: ${formatMs(report.summary.deterministicSubagentAvgMs)}`,
    `- Qianji-server subagent avg: ${formatMs(report.summary.serverSubagentAvgMs)}`,
    `- Qianji-server fresh-start subagent avg: ${formatMs(report.summary.serverFreshStartSubagentAvgMs)}`,
    `- Live subagent avg: ${formatMs(report.summary.liveAvgMs)}`,
    `- Deterministic subagent delta vs direct avg: ${formatMs(report.summary.deterministicSubagentDeltaAvgMs)}`,
    `- Qianji-server subagent delta vs direct avg: ${formatMs(report.summary.serverSubagentDeltaAvgMs)}`,
    `- Qianji-server fresh-start delta vs direct avg: ${formatMs(report.summary.serverFreshStartSubagentDeltaAvgMs)}`,
    `- Live subagent delta vs direct avg: ${formatMs(report.summary.liveDeltaAvgMs)}`,
    "",
    "## Rows",
    "",
    "| Variant | Iteration | Status | Wall ms | HTTP ms | HTTP calls | Tool ms | Tool calls | Other ms | Trace signals | Parallel batches | Variables | Model | Server | Start mode | Error |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |",
  ];
  for (const row of report.rows) {
    lines.push(
      [
        `| \`${row.variant}\``,
        String(row.iteration),
        `\`${row.status}\``,
        formatNumber(row.wallMs),
        row.httpMs === undefined ? "" : formatNumber(row.httpMs),
        row.httpCallCount === undefined ? "" : String(row.httpCallCount),
        row.subagentToolMs === undefined ? "" : formatNumber(row.subagentToolMs),
        row.subagentToolCallCount === undefined ? "" : String(row.subagentToolCallCount),
        row.unaccountedMs === undefined ? "" : formatNumber(row.unaccountedMs),
        String(row.traceEventCount),
        String(row.parallelBatchCount),
        row.variableKeys.map((key) => `\`${key}\``).join(", "),
        row.model ? `\`${row.model}\`` : "",
        row.serverUrl ? `\`${row.serverUrl}\`` : "",
        row.serverStartMode ? `\`${row.serverStartMode}\`` : "",
        row.error ? escapeTableCell(row.error) : "",
      ].join(" | ") + " |",
    );
  }
  lines.push("");
  return lines.join("\n");
}

function passedRows(
  rows: WorkflowSubagentBenchmarkRow[],
  variant: WorkflowSubagentBenchmarkRow["variant"],
): WorkflowSubagentBenchmarkRow[] {
  return rows.filter((row) => row.variant === variant && row.status === "passed");
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatMs(value: number): string {
  return `${formatNumber(value)} ms`;
}

function formatNumber(value: number): string {
  return value.toFixed(2);
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}
