import { describe, expect, it } from "vitest";
import {
  parseWorkflowSubagentBenchmarkArgs,
  renderWorkflowSubagentBenchmarkReport,
  summarizeWorkflowSubagentBenchmarkReport,
  type WorkflowSubagentBenchmarkRow,
} from "../../src/cli/workflow-subagent-benchmark.js";

describe("workflow subagent BPMN benchmark", () => {
  it("parses benchmark CLI arguments", () => {
    expect(
      parseWorkflowSubagentBenchmarkArgs([
        "--live",
        "--iterations",
        "2",
        "--model",
        "anthropic/deepseek-v4-pro",
        "--server-url",
        "http://127.0.0.1:38130",
        "--output-json",
        "out.json",
      ]),
    ).toEqual({
      live: true,
      iterations: 2,
      model: "anthropic/deepseek-v4-pro",
      serverUrl: "http://127.0.0.1:38130",
      outputJsonPath: "out.json",
    });
  });

  it("summarizes deterministic, subagent, server, and live benchmark rows", () => {
    const summary = summarizeWorkflowSubagentBenchmarkReport([
      benchmarkRow("qianji-complex-fixture", 4800),
      benchmarkRow("pi-wendao-deterministic-complex-subagent", 5200),
      benchmarkRow("qianji-server-deterministic-complex-subagent", 6100, {
        serverUrl: "http://127.0.0.1:38130",
      }),
      benchmarkRow("qianji-server-fresh-start-deterministic-complex-subagent", 5700, {
        serverUrl: "http://127.0.0.1:38130",
        serverStartMode: "start",
      }),
      benchmarkRow("pi-wendao-live-complex-subagent", 33000),
    ]);

    expect(summary).toEqual({
      rowCount: 5,
      passedCount: 5,
      failedCount: 0,
      skippedCount: 0,
      deterministicAvgMs: 4800,
      deterministicSubagentAvgMs: 5200,
      serverSubagentAvgMs: 6100,
      serverFreshStartSubagentAvgMs: 5700,
      liveAvgMs: 33000,
      deterministicSubagentDeltaAvgMs: 400,
      serverSubagentDeltaAvgMs: 1300,
      serverFreshStartSubagentDeltaAvgMs: 900,
      liveDeltaAvgMs: 28200,
    });
  });

  it("renders a compact Markdown report", () => {
    const row = benchmarkRow("qianji-server-deterministic-complex-subagent", 1120, {
      serverUrl: "http://127.0.0.1:38130",
    });
    const report = renderWorkflowSubagentBenchmarkReport({
      benchmark: "workflow-subagent-bpmn",
      fixturePath: "test/fixtures/complex-workflow.bpmn",
      processId: "Process_1",
      iterations: 1,
      live: true,
      startedAt: "2026-05-25T00:00:00.000Z",
      rows: [row],
      summary: summarizeWorkflowSubagentBenchmarkReport([row]),
    });

    expect(report).toContain("# Workflow Subagent BPMN Benchmark");
    expect(report).toContain(
      "| `qianji-server-deterministic-complex-subagent` | 1 | `passed` | 1120.00 |",
    );
    expect(report).toContain("`http://127.0.0.1:38130`");
    expect(report).toContain("`published`");
  });
});

function benchmarkRow(
  variant: WorkflowSubagentBenchmarkRow["variant"],
  wallMs: number,
  options: { serverUrl?: string; serverStartMode?: "resume-or-start" | "start" } = {},
): WorkflowSubagentBenchmarkRow {
  return {
    variant,
    iteration: 1,
    status: "passed",
    success: true,
    wallMs,
    workflowPath: "test/fixtures/complex-workflow.bpmn",
    processId: "Process_1",
    model: variant === "pi-wendao-live-complex-subagent" ? "anthropic/deepseek-v4-pro" : undefined,
    serverUrl: options.serverUrl,
    serverStartMode: options.serverStartMode,
    httpCallCount: options.serverUrl ? 3 : undefined,
    httpMs: options.serverUrl ? 120 : undefined,
    subagentToolCallCount: variant.includes("subagent") ? 10 : undefined,
    subagentToolMs: variant.includes("subagent") ? 20 : undefined,
    unaccountedMs: variant.includes("subagent") ? wallMs - 140 : undefined,
    traceEventCount: 42,
    parallelBatchCount: 1,
    variableKeys: ["status", "isReady", "resultA", "resultB", "merged", "valid", "published"],
    variables: {
      status: "ready",
      isReady: true,
      resultA: "alpha",
      resultB: "beta",
      merged: "alpha,beta",
      valid: true,
      published: true,
    },
  };
}
