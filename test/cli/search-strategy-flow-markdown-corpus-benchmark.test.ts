import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WENDAO_ARROW_FLIGHT_DATA_PLANE,
  WENDAO_JSONL_STDIO_CONTROL_PLANE,
  WENDAO_PROCESS_ARGS_CONTROL_PLANE,
} from "../../src/arrow/boundary.js";
import { shouldRunSearchStrategyFlowAgentJudgement } from "../../src/cli/search/strategy-flow-agent.js";
import {
  runSearchStrategyFlowMarkdownCorpusBenchmark,
  evaluateMarkdownCorpusBenchmarkRow,
  mapWithConcurrency,
  parseMarkdownCorpusIntentFixture,
  renderMarkdownCorpusBenchmarkReport,
  shouldRetryLiveAgentRun,
  summarizeMarkdownCorpusBenchmarkReport,
  type SearchStrategyFlowMarkdownCorpusIntentRow,
} from "../../src/cli/search/strategy-flow-markdown-corpus-benchmark.js";
import type {
  SearchStrategyFlowAgentTrace,
  SearchStrategyFlowTrace,
} from "../../src/cli/search/strategy-flow-types.js";

describe("SearchStrategyFlow Markdown corpus benchmark", () => {
  const originalFlightBaseUrl = process.env.PI_WENDAO_SEARCH_FLIGHT_BASE_URL;

  afterEach(() => {
    if (originalFlightBaseUrl === undefined) {
      delete process.env.PI_WENDAO_SEARCH_FLIGHT_BASE_URL;
    } else {
      process.env.PI_WENDAO_SEARCH_FLIGHT_BASE_URL = originalFlightBaseUrl;
    }
  });

  it("parses the Markdown corpus intent Org ledger", () => {
    const fixturePath = writeFixture(`* Intent: ownership
:PROPERTIES:
:FAMILY_ID: ownership
:INTENT: Find ownership.
:REQUIRED_EVIDENCE: ownership_boundary
:EXPECTED_SOURCE_PATHS: docs/a.md, docs/b.md
:BLOCKED_SOURCE_PATHS: docs/trap.md
:LIVE_EVIDENCE_REQUIRED: true
:PROMOTION_STATUS: requires_live
:END:
`);

    const rows = parseMarkdownCorpusIntentFixture(fixturePath);

    expect(rows).toEqual([
      {
        familyId: "ownership",
        intent: "Find ownership.",
        requiredEvidence: ["ownership_boundary"],
        expectedSourcePaths: ["docs/a.md", "docs/b.md"],
        blockedSourcePaths: ["docs/trap.md"],
        liveEvidenceRequired: true,
        promotionStatus: "requires_live",
      },
    ]);
  });

  it("rejects malformed Markdown corpus intent Org properties", () => {
    const fixturePath = writeFixture(`* Intent: ownership
:PROPERTIES:
:FAMILY_ID: ownership
:INTENT: Find ownership.
:REQUIRED_EVIDENCE: ownership_boundary
:EXPECTED_SOURCE_PATHS: docs/a.md
:LIVE_EVIDENCE_REQUIRED: maybe
:PROMOTION_STATUS: requires_live
:END:
`);

    expect(() => parseMarkdownCorpusIntentFixture(fixturePath)).toThrow(
      "invalid LIVE_EVIDENCE_REQUIRED",
    );
  });

  it("marks a Rust bridge trace with covered evidence and source hit as passed", () => {
    const row = benchmarkIntentRow();
    const result = evaluateMarkdownCorpusBenchmarkRow(
      row,
      benchmarkTrace({
        selectedCandidateIds: ["docs/a.md#owner", "docs/support.md#validation"],
        selectedRequiredEvidence: ["ownership_boundary"],
        candidateDiscovery: { elapsedMs: 42, attemptCount: 2 },
        routeReceipts: [
          { route: "/search/repos/main", rowCount: 1, elapsedMs: 12 },
          { route: "/graph/neighbors", rowCount: 2, elapsedMs: 7 },
        ],
      }),
      completedAgentTrace(),
    );

    expect(result.passed).toBe(true);
    expect(result.executionMode).toBe("production");
    expect(result.promotionEligible).toBe(true);
    expect(result.backend).toBe("rust-wendao-julia");
    expect(result.requiredEvidenceCovered).toBe(true);
    expect(result.expectedSourceHit).toBe(true);
    expect(result.blockedSourceSelected).toBe(false);
    expect(result.liveStatus).toBe("completed");
    expect(result.liveToolUseCount).toBe(0);
    expect(result.candidateDiscoveryMs).toBe(42);
    expect(result.candidateDiscoveryAttemptCount).toBe(2);
    expect(result.routeMaterializationRouteCount).toBe(2);
    expect(result.routeMaterializationMs).toBe(19);
    expect(result.routeMaterializationMaxRouteMs).toBe(12);
    expect(result.violations).toEqual([]);
  });

  it("reports deterministic violations without patching missing evidence", () => {
    const row = benchmarkIntentRow();
    const result = evaluateMarkdownCorpusBenchmarkRow(
      row,
      benchmarkTrace({
        backend: "wendao-graph-julia",
        controlPlane: undefined,
        rustBridgeFallback: "julia-direct",
        selectedCandidateIds: ["docs/trap.md#blocked"],
        selectedRequiredEvidence: [],
      }),
    );

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual([
      "backend_not_rust_wendao_julia",
      "control_plane_not_rust",
      "rust_bridge_fallback",
      "required_evidence_missing",
      "expected_source_missing",
      "blocked_source_selected",
    ]);
  });

  it("renders a compact Markdown report", () => {
    const rows = [
      evaluateMarkdownCorpusBenchmarkRow(
        benchmarkIntentRow(),
        benchmarkTrace({
          selectedCandidateIds: ["docs/a.md#owner"],
          selectedRequiredEvidence: ["ownership_boundary"],
        }),
      ),
    ];
    const report = summarizeMarkdownCorpusBenchmarkReport("fixture.org", false, rows);

    expect(report.totalRouteMaterializationMs).toBe(0);
    expect(report.promotionEligibleCount).toBe(1);
    expect(renderMarkdownCorpusBenchmarkReport(report)).toContain(
      "| ownership | `true` | `production` | `true` | `rust-wendao-julia` | `1` | ownership_boundary | `true` | `not-run` | `not-run` | `not-run` | `not-run` | `0` | `0` |  |  |",
    );
  });

  it("requires a Flight endpoint for live corpus benchmarks", async () => {
    delete process.env.PI_WENDAO_SEARCH_FLIGHT_BASE_URL;
    const fixturePath = writeFixture(`* Intent: ownership
:PROPERTIES:
:FAMILY_ID: ownership
:INTENT: Find ownership.
:REQUIRED_EVIDENCE: ownership_boundary
:EXPECTED_SOURCE_PATHS: docs/a.md
:LIVE_EVIDENCE_REQUIRED: true
:PROMOTION_STATUS: requires_live
:END:
`);

    await expect(
      runSearchStrategyFlowMarkdownCorpusBenchmark({
        fixturePath,
        live: true,
      }),
    ).rejects.toThrow("requires Studio/Gateway Arrow Flight materialization");
  });

  it("marks persistent local Rust bridge sessions as non-promotable benchmark rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-markdown-corpus-session-"));
    const fixturePath = join(dir, "intents.org");
    const bridgePath = join(dir, "fake-bridge.mjs");
    const argsPath = join(dir, "bridge-args.json");
    writeFileSync(fixturePath, twoIntentFixture(), "utf-8");
    writeFakeBridgeSession(
      bridgePath,
      argsPath,
      benchmarkTrace({
        selectedCandidateIds: ["docs/a.md#owner"],
        selectedRequiredEvidence: ["ownership_boundary"],
      }),
    );

    const report = await runSearchStrategyFlowMarkdownCorpusBenchmark({
      fixturePath,
      searchRustBridgeBin: bridgePath,
    });

    const bridgeArgs = JSON.parse(readFileSync(argsPath, "utf-8")) as string[];
    expect(bridgeArgs).toEqual(["--serve-stdio"]);
    expect(report.traceDataPlane).toBe("none");
    expect(report.traceControlEnvelope).toBe(WENDAO_JSONL_STDIO_CONTROL_PLANE);
    expect(report.rustBridgeSession).toBe(true);
    expect(report.rustBridgeSessionTiming?.requestCount).toBe(2);
    expect(report.rustBridgeSessionTiming?.sessionDurationMs).toBeGreaterThanOrEqual(0);
    expect(report.rustBridgeSessionTiming?.firstResponseMs).toBeGreaterThanOrEqual(0);
    expect(report.rows).toHaveLength(2);
    expect(report.rows.every((row) => row.passed)).toBe(true);
    expect(report.rows.every((row) => row.executionMode === "development")).toBe(true);
    expect(report.rows.every((row) => row.promotionEligible === false)).toBe(true);
    expect(report.promotionEligibleCount).toBe(0);
  });

  it("reports warmup and steady-state timing for persistent Rust bridge sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-markdown-corpus-session-warmup-"));
    const fixturePath = join(dir, "intents.org");
    const bridgePath = join(dir, "fake-bridge.mjs");
    const argsPath = join(dir, "bridge-args.json");
    writeFileSync(fixturePath, twoIntentFixture(), "utf-8");
    writeFakeBridgeSession(
      bridgePath,
      argsPath,
      benchmarkTrace({
        selectedCandidateIds: ["docs/a.md#owner"],
        selectedRequiredEvidence: ["ownership_boundary"],
      }),
    );

    const report = await runSearchStrategyFlowMarkdownCorpusBenchmark({
      fixturePath,
      searchRustBridgeBin: bridgePath,
      searchRustBridgeWarmupRows: 1,
    });

    expect(report.rustBridgeSessionTiming?.requestCount).toBe(2);
    expect(report.rustBridgeSessionTiming?.warmupRequestCount).toBe(1);
    expect(report.rustBridgeSessionTiming?.warmupDurationMs).toBeGreaterThanOrEqual(0);
    expect(report.rustBridgeSessionTiming?.steadyStateDurationMs).toBeGreaterThanOrEqual(0);
    expect(report.rows).toHaveLength(2);
    expect(report.rows.every((row) => row.passed)).toBe(true);
    expect(report.rows.every((row) => row.executionMode === "development")).toBe(true);
    expect(report.rows.every((row) => row.promotionEligible === false)).toBe(true);
    expect(renderMarkdownCorpusBenchmarkReport(report)).toContain(
      "rust bridge steady-state duration ms",
    );
  });

  it("classifies Flight-backed persistent Rust bridge sessions as development mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-markdown-corpus-flight-"));
    const fixturePath = join(dir, "intents.org");
    const bridgePath = join(dir, "fake-bridge.mjs");
    const argsPath = join(dir, "bridge-args.json");
    writeFileSync(
      fixturePath,
      `* Intent: ownership
:PROPERTIES:
:FAMILY_ID: ownership
:INTENT: Find ownership.
:REQUIRED_EVIDENCE: ownership_boundary
:EXPECTED_SOURCE_PATHS: docs/a.md
:LIVE_EVIDENCE_REQUIRED: false
:PROMOTION_STATUS: candidate
:END:
`,
      "utf-8",
    );
    writeFakeBridgeSession(
      bridgePath,
      argsPath,
      benchmarkTrace({
        selectedCandidateIds: ["docs/a.md#owner"],
        selectedRequiredEvidence: ["ownership_boundary"],
      }),
    );

    const report = await runSearchStrategyFlowMarkdownCorpusBenchmark({
      fixturePath,
      searchRustBridgeBin: bridgePath,
      searchFlightBaseUrl: "http://127.0.0.1:50052",
    });

    const bridgeArgs = JSON.parse(readFileSync(argsPath, "utf-8")) as string[];
    expect(bridgeArgs).toContain("--serve-stdio");
    expect(bridgeArgs).toContain("--flight-base-url");
    expect(report.traceDataPlane).toBe(WENDAO_ARROW_FLIGHT_DATA_PLANE);
    expect(report.traceControlEnvelope).toBe(WENDAO_JSONL_STDIO_CONTROL_PLANE);
    expect(report.rustBridgeSession).toBe(true);
    expect(report.rustBridgeSessionTiming?.requestCount).toBe(1);
    expect(report.rows[0]?.passed).toBe(true);
    expect(report.rows[0]?.executionMode).toBe("development");
    expect(report.rows[0]?.promotionEligible).toBe(false);
    expect(report.rows[0]?.violations).not.toContain("non_polyglot_service_entrypoint");
  });

  it("classifies SearchStrategyFlow service plus Gateway Flight traces as production mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-markdown-corpus-service-"));
    const fixturePath = join(dir, "intents.org");
    const bridgePath = join(dir, "fake-bridge.mjs");
    const argsPath = join(dir, "bridge-args.json");
    writeFileSync(
      fixturePath,
      `* Intent: ownership
:PROPERTIES:
:FAMILY_ID: ownership
:INTENT: Find ownership.
:REQUIRED_EVIDENCE: ownership_boundary
:EXPECTED_SOURCE_PATHS: docs/a.md
:LIVE_EVIDENCE_REQUIRED: false
:PROMOTION_STATUS: candidate
:END:
`,
      "utf-8",
    );
    writeFakeBridgeDirect(
      bridgePath,
      argsPath,
      benchmarkTrace({
        selectedCandidateIds: ["docs/a.md#owner"],
        selectedRequiredEvidence: ["ownership_boundary"],
        strategyFlowService: true,
        materializationStatus: "executed",
      }),
    );

    const report = await runSearchStrategyFlowMarkdownCorpusBenchmark({
      fixturePath,
      searchRustBridgeBin: bridgePath,
      searchFlightBaseUrl: "http://127.0.0.1:50052",
      searchStrategyFlowServiceBaseUrl: "http://127.0.0.1:50053",
      searchStrategyFlowServiceTimeoutSeconds: 7,
    });

    const bridgeArgs = JSON.parse(readFileSync(argsPath, "utf-8")) as string[];
    expect(bridgeArgs).not.toContain("--serve-stdio");
    expect(bridgeArgs).toContain("--strategy-flow-service-base-url");
    expect(bridgeArgs).toContain("http://127.0.0.1:50053");
    expect(bridgeArgs).toContain("--strategy-flow-service-timeout-seconds");
    expect(bridgeArgs).toContain("7");
    expect(bridgeArgs).toContain("--query-understanding-arrow-ipc");
    expect(report.traceDataPlane).toBe(WENDAO_ARROW_FLIGHT_DATA_PLANE);
    expect(report.traceControlEnvelope).toBe(WENDAO_PROCESS_ARGS_CONTROL_PLANE);
    expect(report.rustBridgeSession).toBe(false);
    expect(report.rows[0]?.executionMode).toBe("production");
    expect(report.rows[0]?.promotionEligible).toBe(true);
    expect(report.rows[0]?.violations).toEqual([]);
  });

  it("forces live judgement for fixture rows that require live evidence", async () => {
    const row = benchmarkIntentRow();
    const trace = benchmarkTrace({
      selectedCandidateIds: ["docs/a.md#owner"],
      selectedRequiredEvidence: ["ownership_boundary"],
    });

    const result = evaluateMarkdownCorpusBenchmarkRow(row, trace, skippedAgentTrace());

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(["live_agent_not_completed"]);
    expect(shouldRunSearchStrategyFlowAgentJudgement(trace)).toBe(false);
    expect(shouldRunSearchStrategyFlowAgentJudgement(trace, row.liveEvidenceRequired)).toBe(true);
  });

  it("retries timeout live agent rows after deterministic evidence passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-markdown-corpus-live-retry-"));
    const fixturePath = join(dir, "intents.org");
    const bridgePath = join(dir, "fake-bridge.mjs");
    const argsPath = join(dir, "bridge-args.json");
    writeFileSync(
      fixturePath,
      `* Intent: ownership
:PROPERTIES:
:FAMILY_ID: ownership
:INTENT: Find ownership.
:REQUIRED_EVIDENCE: ownership_boundary
:EXPECTED_SOURCE_PATHS: docs/a.md
:LIVE_EVIDENCE_REQUIRED: true
:PROMOTION_STATUS: requires_live
:END:
`,
      "utf-8",
    );
    writeFakeBridgeDirect(
      bridgePath,
      argsPath,
      benchmarkTrace({
        selectedCandidateIds: ["docs/a.md#owner"],
        selectedRequiredEvidence: ["ownership_boundary"],
        strategyFlowService: true,
        materializationStatus: "executed",
      }),
    );
    const timeoutSeconds: Array<number | undefined> = [];
    const candidatePoolModes: Array<string | undefined> = [];
    let attempt = 0;

    const report = await runSearchStrategyFlowMarkdownCorpusBenchmark({
      fixturePath,
      live: true,
      liveAgentTimeoutSeconds: 7,
      liveAgentRetryTimeoutSeconds: 11,
      searchRustBridgeBin: bridgePath,
      searchFlightBaseUrl: "http://127.0.0.1:50052",
      searchStrategyFlowServiceBaseUrl: "http://127.0.0.1:50053",
      liveAgentTraceRunner: async (options) => {
        timeoutSeconds.push(options.timeoutSeconds);
        candidatePoolModes.push(options.candidatePoolMode);
        attempt += 1;
        return attempt === 1 ? timedOutAgentTrace() : completedAgentTrace();
      },
    });

    expect(timeoutSeconds).toEqual([7, 11]);
    expect(candidatePoolModes).toEqual(["selected-only", "selected-only"]);
    expect(report.passedCount).toBe(1);
    expect(report.failedCount).toBe(0);
    expect(report.liveRetriedCount).toBe(1);
    expect(report.liveRetryRecoveredCount).toBe(1);
    expect(report.totalLiveAttemptCount).toBe(2);
    expect(report.liveAgentMode).toBe("branch-judgement");
    expect(report.liveAgentCandidatePoolMode).toBe("selected-only");
    expect(report.rows[0]?.liveAttemptCount).toBe(2);
    expect(report.rows[0]?.liveRetryCount).toBe(1);
    expect(report.rows[0]?.liveAgentMode).toBe("branch-judgement");
    expect(report.rows[0]?.liveCandidatePoolMode).toBe("selected-only");
    expect(report.rows[0]?.liveRetryReasons).toEqual([
      "SearchStrategyFlow BPMN/Qianji agent task timed out after 7s.",
    ]);
    expect(report.rows[0]?.violations).toEqual([]);
  });

  it("does not retry timeout live agent rows when deterministic gates already failed", () => {
    const row = benchmarkIntentRow();
    const trace = benchmarkTrace({
      selectedCandidateIds: ["docs/trap.md#blocked"],
      selectedRequiredEvidence: [],
    });

    expect(
      shouldRetryLiveAgentRun(row, trace, {
        trace: timedOutAgentTrace(),
        attemptCount: 1,
        retryCount: 0,
        retryReasons: [],
        candidatePoolMode: "visible",
        liveAgentMode: "branch-judgement",
      }),
    ).toBe(false);
  });

  it("runs live batch judgement mode through one benchmark runner call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-markdown-corpus-live-batch-"));
    const fixturePath = join(dir, "intents.org");
    const bridgePath = join(dir, "fake-bridge.mjs");
    const argsPath = join(dir, "bridge-args.json");
    writeFileSync(
      fixturePath,
      twoIntentFixture().replaceAll(
        "LIVE_EVIDENCE_REQUIRED: false",
        "LIVE_EVIDENCE_REQUIRED: true",
      ),
      "utf-8",
    );
    writeFakeBridgeDirect(
      bridgePath,
      argsPath,
      benchmarkTrace({
        selectedCandidateIds: ["docs/a.md#owner"],
        selectedRequiredEvidence: ["ownership_boundary"],
        strategyFlowService: true,
        materializationStatus: "executed",
      }),
    );
    const batchSizes: number[] = [];

    const report = await runSearchStrategyFlowMarkdownCorpusBenchmark({
      fixturePath,
      live: true,
      liveAgentMode: "batch-judgement",
      liveAgentBatchSize: 8,
      searchRustBridgeBin: bridgePath,
      searchFlightBaseUrl: "http://127.0.0.1:50052",
      searchStrategyFlowServiceBaseUrl: "http://127.0.0.1:50053",
      liveAgentBatchRunner: async (input) => {
        batchSizes.push(input.tracedRows.length);
        return input.tracedRows.map((_, index) => ({
          trace: completedAgentTrace(),
          attemptCount: 1,
          retryCount: 0,
          retryReasons: [],
          candidatePoolMode: "selected-only",
          liveAgentMode: "batch-judgement",
          batchId: "batch-1",
          batchSize: input.tracedRows.length,
          batchDurationMs: 1234 + index,
        }));
      },
    });

    expect(batchSizes).toEqual([2]);
    expect(report.passedCount).toBe(2);
    expect(report.failedCount).toBe(0);
    expect(report.liveAgentMode).toBe("batch-judgement");
    expect(report.liveBatchCount).toBe(1);
    expect(report.liveBatchSize).toBe(8);
    expect(report.totalLiveBatchDurationMs).toBe(1234);
    expect(report.rows.map((row) => row.liveAgentMode)).toEqual([
      "batch-judgement",
      "batch-judgement",
    ]);
    expect(report.rows.map((row) => row.liveBatchId)).toEqual(["batch-1", "batch-1"]);
  });

  it("runs live batch sufficiency mode through one benchmark runner call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-markdown-corpus-live-sufficiency-"));
    const fixturePath = join(dir, "intents.org");
    const bridgePath = join(dir, "fake-bridge.mjs");
    const argsPath = join(dir, "bridge-args.json");
    writeFileSync(
      fixturePath,
      twoIntentFixture().replaceAll(
        "LIVE_EVIDENCE_REQUIRED: false",
        "LIVE_EVIDENCE_REQUIRED: true",
      ),
      "utf-8",
    );
    writeFakeBridgeDirect(
      bridgePath,
      argsPath,
      benchmarkTrace({
        selectedCandidateIds: ["docs/a.md#owner"],
        selectedRequiredEvidence: ["ownership_boundary"],
        strategyFlowService: true,
        materializationStatus: "executed",
      }),
    );
    const batchSizes: number[] = [];

    const report = await runSearchStrategyFlowMarkdownCorpusBenchmark({
      fixturePath,
      live: true,
      liveAgentMode: "batch-sufficiency",
      liveAgentBatchSize: 8,
      searchRustBridgeBin: bridgePath,
      searchFlightBaseUrl: "http://127.0.0.1:50052",
      searchStrategyFlowServiceBaseUrl: "http://127.0.0.1:50053",
      liveAgentSufficiencyRunner: async (input) => {
        batchSizes.push(input.tracedRows.length);
        return input.tracedRows.map(() => ({
          trace: completedAgentTrace(),
          attemptCount: 1,
          retryCount: 0,
          retryReasons: [],
          candidatePoolMode: "selected-only",
          liveAgentMode: "batch-sufficiency",
          batchId: "sufficiency-1",
          batchSize: input.tracedRows.length,
          batchDurationMs: 4321,
          sufficient: true,
          sufficiencyReason: "selected frontier covers required evidence",
        }));
      },
    });

    expect(batchSizes).toEqual([2]);
    expect(report.passedCount).toBe(2);
    expect(report.failedCount).toBe(0);
    expect(report.liveAgentMode).toBe("batch-sufficiency");
    expect(report.liveBatchCount).toBe(1);
    expect(report.liveBatchSize).toBe(8);
    expect(report.totalLiveBatchDurationMs).toBe(4321);
    expect(report.rows.map((row) => row.liveAgentMode)).toEqual([
      "batch-sufficiency",
      "batch-sufficiency",
    ]);
    expect(report.rows.map((row) => row.liveSufficient)).toEqual([true, true]);
    expect(report.rows.map((row) => row.liveSufficiencyReason)).toEqual([
      "selected frontier covers required evidence",
      "selected frontier covers required evidence",
    ]);
  });

  it("runs benchmark tasks with bounded Qianji concurrency while preserving row order", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, value === 1 ? 30 : 5));
      active -= 1;
      return `row-${value}`;
    });

    expect(results).toEqual(["row-1", "row-2", "row-3", "row-4"]);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBe(2);
  });
});

function writeFixture(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-markdown-corpus-"));
  const path = join(dir, "intents.org");
  writeFileSync(path, text, "utf-8");
  return path;
}

function twoIntentFixture(): string {
  return `* Intent: ownership
:PROPERTIES:
:FAMILY_ID: ownership
:INTENT: Find ownership.
:REQUIRED_EVIDENCE: ownership_boundary
:EXPECTED_SOURCE_PATHS: docs/a.md
:LIVE_EVIDENCE_REQUIRED: false
:PROMOTION_STATUS: candidate
:END:

* Intent: validation
:PROPERTIES:
:FAMILY_ID: validation
:INTENT: Find validation.
:REQUIRED_EVIDENCE: ownership_boundary
:EXPECTED_SOURCE_PATHS: docs/a.md
:LIVE_EVIDENCE_REQUIRED: false
:PROMOTION_STATUS: candidate
:END:
`;
}

function writeFakeBridgeSession(
  bridgePath: string,
  argsPath: string,
  trace: SearchStrategyFlowTrace,
): void {
  writeFileSync(
    bridgePath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)), "utf-8");
let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  for (const line of input.trim().split(/\\r?\\n/).filter(Boolean)) {
    const request = JSON.parse(line);
    const requests = Array.isArray(request.requests) ? request.requests : [request];
    for (const row of requests) {
      if (!row.intent) throw new Error("missing intent");
      console.log(JSON.stringify({ requestId: row.requestId, ok: true, trace: ${JSON.stringify(trace)} }));
    }
  }
});
`,
    "utf-8",
  );
  chmodSync(bridgePath, 0o755);
}

function writeFakeBridgeDirect(
  bridgePath: string,
  argsPath: string,
  trace: SearchStrategyFlowTrace,
): void {
  writeFileSync(
    bridgePath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)), "utf-8");
console.log(JSON.stringify(${JSON.stringify(trace)}));
`,
    "utf-8",
  );
  chmodSync(bridgePath, 0o755);
}

function benchmarkIntentRow(): SearchStrategyFlowMarkdownCorpusIntentRow {
  return {
    familyId: "ownership",
    intent: "Find ownership.",
    requiredEvidence: ["ownership_boundary"],
    expectedSourcePaths: ["docs/a.md"],
    blockedSourcePaths: ["docs/trap.md"],
    liveEvidenceRequired: true,
    promotionStatus: "requires_live",
  };
}

function benchmarkTrace(input: {
  backend?: string;
  controlPlane?: string;
  rustBridgeFallback?: "none" | "julia-direct";
  strategyFlowService?: boolean;
  materializationStatus?: "planned" | "executed";
  candidateDiscovery?: { elapsedMs: number; attemptCount: number };
  selectedCandidateIds: string[];
  selectedRequiredEvidence: string[];
  routeReceipts?: Array<{ route: string; rowCount: number; elapsedMs?: number }>;
}): SearchStrategyFlowTrace {
  const selectedFrontier = input.selectedCandidateIds.map((candidateId, index) => ({
    candidateId,
    rank: index + 1,
    selected: true,
    finalScore: 0.9,
    action: "keep",
    contextBudget: 100,
    judgementKind: "graph_verified_candidate",
  }));
  return {
    intent: "Find ownership.",
    backend: input.backend ?? "rust-wendao-julia",
    ...(Object.hasOwn(input, "controlPlane")
      ? { controlPlane: input.controlPlane }
      : { controlPlane: "rust" }),
    ...(input.strategyFlowService === true
      ? {
          strategyFlowDataPlane: WENDAO_ARROW_FLIGHT_DATA_PLANE,
          strategyFlowService: {
            dataPlane: WENDAO_ARROW_FLIGHT_DATA_PLANE,
            baseUrl: "http://127.0.0.1:50053",
            flightRoute: "wendaograph.search_strategy_flow.v1",
            timeoutSeconds: 7,
          },
        }
      : {}),
    candidateInputSource: "rust-markdown-headings",
    candidateInputCount: 3,
    candidateInputDiscovery: input.candidateDiscovery,
    graphProject: "WendaoGraph.jl",
    searchRoot: ".",
    rustBridge: {
      requestedBackend: "auto",
      attempted: true,
      fallback: input.rustBridgeFallback ?? "none",
    },
    stageReceipts: [],
    candidates: [],
    frontier: selectedFrontier,
    plannerActions: [],
    retrievalRoutes: [
      {
        candidateId: input.selectedCandidateIds[0] ?? "docs/a.md#owner",
        materializationOwner: "studio-rust",
        materializationStatus: input.materializationStatus ?? "planned",
        receiptSource: "rust-bridge",
        primaryTransport: WENDAO_ARROW_FLIGHT_DATA_PLANE,
        sourcePath: "docs/a.md",
        directFileReadAllowed: false,
        executeBeforeAnswer: true,
        routeReceipts: input.routeReceipts,
        flightSteps: [],
      },
    ],
    summary: {
      candidateCount: 3,
      selectedCount: selectedFrontier.length,
      plannerActionCount: 0,
      totalContextCost: 300,
      selectedContextCost: 100,
      contextReductionRatio: 0.66,
    },
    validation: {
      noVectorMode: true,
      materializedTopCandidate: true,
      blockedEvidencePruned: true,
      selectedContextReduced: true,
      requiredEvidenceCovered: input.selectedRequiredEvidence.length > 0,
      selectedRequiredEvidence: input.selectedRequiredEvidence,
      missingRequiredEvidence: [],
    },
  } as SearchStrategyFlowTrace;
}

function completedAgentTrace(): SearchStrategyFlowAgentTrace {
  return {
    mode: "qianji-service-agent",
    status: "completed",
    model: "anthropic/deepseek-v4-pro",
    durationMs: 1000,
    events: [],
    branchJudgementValidation: {
      valid: true,
      acceptedCount: 1,
      errors: [],
    },
  };
}

function timedOutAgentTrace(): SearchStrategyFlowAgentTrace {
  return {
    mode: "qianji-service-agent",
    status: "failed",
    model: "anthropic/deepseek-v4-pro",
    durationMs: 7000,
    reason: "SearchStrategyFlow BPMN/Qianji agent task timed out after 7s.",
    events: [],
  };
}

function skippedAgentTrace(): SearchStrategyFlowAgentTrace {
  return {
    mode: "qianji-service-agent",
    status: "skipped",
    durationMs: 1,
    reason: "SearchStrategyFlow did not request an LLM judgement.",
    events: [],
  };
}
