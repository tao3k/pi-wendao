import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  WENDAO_ARROW_FLIGHT_DATA_PLANE,
  WENDAO_JSONL_STDIO_CONTROL_PLANE,
  WENDAO_NO_DATA_PLANE,
  WENDAO_PROCESS_ARGS_CONTROL_PLANE,
} from "../../arrow/boundary.js";
import { resolveSearchStrategyFlowCliOptions } from "./strategy-flow-cli-options.js";
import { runSearchStrategyFlow } from "./strategy-flow-julia.js";
import { mapWithConcurrency, normalizeLiveQianjiConcurrency } from "./markdown-corpus-benchmark/concurrency.js";
import { evaluateMarkdownCorpusBenchmarkRow } from "./markdown-corpus-benchmark/evaluate.js";
import { limitRows, parseMarkdownCorpusIntentFixture } from "./markdown-corpus-benchmark/fixture.js";
import {
  runBenchmarkLiveAgentRuns,
  shouldRetryLiveAgentRun,
} from "./markdown-corpus-benchmark/live-agent.js";
import { runBenchmarkLiveAgentBatchRuns } from "./markdown-corpus-benchmark/live-agent-batch.js";
import { runBenchmarkLiveAgentSufficiencyRuns } from "./markdown-corpus-benchmark/live-agent-sufficiency.js";
import {
  renderMarkdownCorpusBenchmarkReport,
  summarizeMarkdownCorpusBenchmarkReport,
} from "./markdown-corpus-benchmark/report.js";
import { runMarkdownCorpusBenchmarkRustBridgeSession } from "./markdown-corpus-benchmark/rust-session.js";
import type {
  SearchStrategyFlowQueryUnderstandingRow,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";
import type {
  SearchStrategyFlowAgentCandidatePoolMode,
  SearchStrategyFlowMarkdownCorpusBenchmarkOptions,
  SearchStrategyFlowMarkdownCorpusBenchmarkReportDto,
  SearchStrategyFlowMarkdownCorpusIntentRow,
  SearchStrategyFlowMarkdownCorpusLiveAgentMode,
  SearchStrategyFlowRustBridgeSessionTiming,
} from "./markdown-corpus-benchmark/types.js";

export { mapWithConcurrency } from "./markdown-corpus-benchmark/concurrency.js";
export { evaluateMarkdownCorpusBenchmarkRow } from "./markdown-corpus-benchmark/evaluate.js";
export { parseMarkdownCorpusIntentFixture } from "./markdown-corpus-benchmark/fixture.js";
export { shouldRetryLiveAgentRun } from "./markdown-corpus-benchmark/live-agent.js";
export {
  renderMarkdownCorpusBenchmarkReport,
  summarizeMarkdownCorpusBenchmarkReport,
} from "./markdown-corpus-benchmark/report.js";
export type {
  SearchStrategyFlowMarkdownCorpusAgentRun,
  SearchStrategyFlowMarkdownCorpusBenchmarkOptions,
  SearchStrategyFlowMarkdownCorpusBenchmarkReportDto,
  SearchStrategyFlowMarkdownCorpusBenchmarkRow,
  SearchStrategyFlowMarkdownCorpusIntentRow,
  SearchStrategyFlowMarkdownCorpusLiveAgentMode,
} from "./markdown-corpus-benchmark/types.js";

const DEFAULT_FIXTURE_PATH =
  "../WendaoGraph.jl/test/fixtures/search_strategy_flow/markdown_corpus_live_intents.org";
const DEFAULT_MODEL_PATTERN = "anthropic/deepseek-v4-pro";

export async function runSearchStrategyFlowMarkdownCorpusBenchmark(
  options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions = {},
): Promise<SearchStrategyFlowMarkdownCorpusBenchmarkReportDto> {
  const startedAt = Date.now();
  const cwd = resolve(options.cwd ?? process.cwd());
  const fixturePath = resolve(cwd, options.fixturePath ?? DEFAULT_FIXTURE_PATH);
  const intentRows = limitRows(parseMarkdownCorpusIntentFixture(fixturePath), options.limit);
  if (options.live === true && !hasSearchFlightEndpoint(options)) {
    throw new Error(
      "Live SearchStrategyFlow Markdown corpus benchmark requires Studio/Gateway Arrow Flight materialization. Set PI_WENDAO_SEARCH_FLIGHT_BASE_URL or pass --search-flight-base-url.",
    );
  }
  const searchRustBridgeSession = resolveBenchmarkRustBridgeSession(options);
  const traceDataPlane = hasSearchFlightEndpoint(options) || hasStrategyFlowServiceEndpoint(options)
    ? WENDAO_ARROW_FLIGHT_DATA_PLANE
    : WENDAO_NO_DATA_PLANE;

  const traceRun = await runBenchmarkTraceRows({
    cwd,
    intentRows,
    options,
    searchRustBridgeSession,
  });
  const tracedRows = traceRun.rows;

  const liveQianjiConcurrency = options.live === true
    ? normalizeLiveQianjiConcurrency(options.liveQianjiConcurrency)
    : 0;
  const agentRuns = options.live === true
    ? await runBenchmarkLiveAgentRunsForMode({
        cwd,
        tracedRows,
        options,
        concurrency: liveQianjiConcurrency,
        defaultModelPattern: DEFAULT_MODEL_PATTERN,
      })
    : [];
  const benchmarkRows = tracedRows.map(({ intentRow, trace }, index) =>
    evaluateMarkdownCorpusBenchmarkRow(intentRow, trace, agentRuns[index]?.trace, agentRuns[index]),
  );

  const report = summarizeMarkdownCorpusBenchmarkReport(fixturePath, options.live === true, benchmarkRows, {
    liveQianjiConcurrency,
    traceDataPlane,
    traceControlEnvelope: searchRustBridgeSession
      ? WENDAO_JSONL_STDIO_CONTROL_PLANE
      : WENDAO_PROCESS_ARGS_CONTROL_PLANE,
    rustBridgeSession: searchRustBridgeSession,
    rustBridgeSessionTiming: traceRun.rustBridgeSessionTiming,
    liveAgentMode: resolveLiveAgentMode(options.liveAgentMode),
    liveAgentBatchSize: options.liveAgentBatchSize,
    wallDurationMs: Date.now() - startedAt,
  });
  if (options.outputJsonPath) {
    writeTextFile(resolve(cwd, options.outputJsonPath), `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.outputMarkdownPath) {
    writeTextFile(resolve(cwd, options.outputMarkdownPath), renderMarkdownCorpusBenchmarkReport(report));
  }
  if (options.failOnViolation && report.failedCount > 0) {
    throw new Error(
      `SearchStrategyFlow Markdown corpus benchmark failed ${report.failedCount}/${report.rowCount} row(s).`,
    );
  }
  return report;
}

function runBenchmarkLiveAgentRunsForMode(input: {
  cwd: string;
  tracedRows: Array<{
    intentRow: SearchStrategyFlowMarkdownCorpusIntentRow;
    trace: SearchStrategyFlowTrace;
  }>;
  options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions;
  concurrency: number;
  defaultModelPattern: string;
}) {
  const mode = resolveLiveAgentMode(input.options.liveAgentMode);
  if (mode === "batch-sufficiency") {
    const runner = input.options.liveAgentSufficiencyRunner ?? runBenchmarkLiveAgentSufficiencyRuns;
    return runner(input);
  }
  if (mode === "batch-judgement") {
    const runner = input.options.liveAgentBatchRunner ?? runBenchmarkLiveAgentBatchRuns;
    return runner(input);
  }
  return runBenchmarkLiveAgentRuns(input);
}

function hasSearchFlightEndpoint(options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions): boolean {
  return Boolean(options.searchFlightBaseUrl ?? process.env.PI_WENDAO_SEARCH_FLIGHT_BASE_URL);
}

function hasStrategyFlowServiceEndpoint(
  options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions,
): boolean {
  return Boolean(
    options.searchStrategyFlowServiceBaseUrl ??
      process.env.PI_WENDAO_SEARCH_STRATEGY_FLOW_SERVICE_BASE_URL,
  );
}

function resolveBenchmarkRustBridgeSession(
  options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions,
): boolean {
  if (options.searchRustBridgeSession === true && hasStrategyFlowServiceEndpoint(options)) {
    throw new Error(
      "--search-rust-bridge-session cannot be combined with --search-strategy-flow-service-base-url; use process-args control for the production Arrow Flight service path.",
    );
  }
  if (options.searchRustBridgeSession !== undefined) return options.searchRustBridgeSession;
  if (options.searchBackend === "julia-direct") return false;
  if (hasStrategyFlowServiceEndpoint(options)) return false;
  return true;
}

async function runBenchmarkTraceRows(input: {
  cwd: string;
  intentRows: SearchStrategyFlowMarkdownCorpusIntentRow[];
  options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions;
  searchRustBridgeSession: boolean;
}): Promise<{
  rows: Array<{ intentRow: SearchStrategyFlowMarkdownCorpusIntentRow; trace: SearchStrategyFlowTrace }>;
  rustBridgeSessionTiming?: SearchStrategyFlowRustBridgeSessionTiming;
}> {
  if (input.searchRustBridgeSession && input.options.searchBackend !== "julia-direct") {
    const baseOptions = resolveSearchStrategyFlowCliOptions({
      intent: input.intentRows[0]?.intent ?? "SearchStrategyFlow benchmark",
      cwd: input.cwd,
      wendaoGraph: input.options.wendaoGraph,
      searchJulia: input.options.searchJulia,
      searchBackend: input.options.searchBackend,
      searchRustWorkspace: input.options.searchRustWorkspace,
      searchRustCommand: input.options.searchRustCommand,
      searchRustBridgeBin: input.options.searchRustBridgeBin,
      searchRustBridgeSession: true,
      searchFlightBaseUrl: input.options.searchFlightBaseUrl,
      searchFlightTimeoutSeconds: input.options.searchFlightTimeoutSeconds,
      searchStrategyFlowServiceBaseUrl: input.options.searchStrategyFlowServiceBaseUrl,
      searchStrategyFlowServiceTimeoutSeconds: input.options.searchStrategyFlowServiceTimeoutSeconds,
      queryUnderstanding: queryUnderstandingRowsForIntent(input.intentRows[0]),
    });
    const session = await runMarkdownCorpusBenchmarkRustBridgeSession({
      options: input.options,
      intentRows: input.intentRows,
      baseOptions,
    });
    return {
      rows: input.intentRows.map((intentRow, index) => ({
        intentRow,
        trace: session.traces[index] as SearchStrategyFlowTrace,
      })),
      rustBridgeSessionTiming: session.timing,
    };
  }

  const tracedRows: Array<{
    intentRow: SearchStrategyFlowMarkdownCorpusIntentRow;
    trace: SearchStrategyFlowTrace;
  }> = [];
  for (const intentRow of input.intentRows) {
    const trace = await runSearchStrategyFlow(
      resolveSearchStrategyFlowCliOptions({
        intent: intentRow.intent,
        cwd: input.cwd,
        wendaoGraph: input.options.wendaoGraph,
        searchJulia: input.options.searchJulia,
        searchBackend: input.options.searchBackend,
        searchRustWorkspace: input.options.searchRustWorkspace,
        searchRustCommand: input.options.searchRustCommand,
        searchRustBridgeBin: input.options.searchRustBridgeBin,
        searchRustBridgeSession: input.searchRustBridgeSession,
        searchFlightBaseUrl: input.options.searchFlightBaseUrl,
        searchFlightTimeoutSeconds: input.options.searchFlightTimeoutSeconds,
        searchStrategyFlowServiceBaseUrl: input.options.searchStrategyFlowServiceBaseUrl,
        searchStrategyFlowServiceTimeoutSeconds: input.options.searchStrategyFlowServiceTimeoutSeconds,
        queryUnderstanding: queryUnderstandingRowsForIntent(intentRow),
      }),
    );
    tracedRows.push({ intentRow, trace });
  }
  return { rows: tracedRows };
}

function writeTextFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf-8");
}

function queryUnderstandingRowsForIntent(
  intentRow: SearchStrategyFlowMarkdownCorpusIntentRow | undefined,
): SearchStrategyFlowQueryUnderstandingRow[] {
  if (!intentRow) return [];
  return intentRow.requiredEvidence.map((requiredEvidence, index) => ({
    flowId: `markdown-corpus:${intentRow.familyId}` as SearchStrategyFlowQueryUnderstandingRow["flowId"],
    intentId: intentRow.familyId as SearchStrategyFlowQueryUnderstandingRow["intentId"],
    signalId: `${intentRow.familyId}:required-evidence:${
      index + 1
    }` as SearchStrategyFlowQueryUnderstandingRow["signalId"],
    signalKind: "required_evidence",
    signalValue: requiredEvidence,
    confidence: 1,
    routeHint: routeHintForRequiredEvidence(requiredEvidence),
    requiredEvidence,
    ambiguity: 0,
    weight: 1,
    recommendedLoopBudget: 1,
    recommendedJudgementBudget: 1,
    recommendedBeamWidth: 4,
    reason: "markdown_corpus_fixture_required_evidence",
  }));
}

function routeHintForRequiredEvidence(requiredEvidence: string): string {
  switch (requiredEvidence) {
    case "ownership_boundary":
      return "authority";
    case "validation_path":
      return "validation";
    case "relation_path":
      return "link_graph";
    case "page_index_seed":
      return "page_index";
    default:
      return "general";
  }
}

function parseCliArgs(argv: string[]): SearchStrategyFlowMarkdownCorpusBenchmarkOptions {
  const options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions = { cwd: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fixture") {
      options.fixturePath = requireCliValue(argv, index, arg);
      index += 1;
    } else if (arg === "--limit") {
      options.limit = Number.parseInt(requireCliValue(argv, index, arg), 10);
      index += 1;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--fail-on-violation") {
      options.failOnViolation = true;
    } else if (arg === "--output-json") {
      options.outputJsonPath = requireCliValue(argv, index, arg);
      index += 1;
    } else if (arg === "--output-md") {
      options.outputMarkdownPath = requireCliValue(argv, index, arg);
      index += 1;
    } else if (arg === "--qianji") {
      options.qianjiCommand = requireCliValue(argv, index, arg);
      index += 1;
    } else if (arg === "--model") {
      options.modelPattern = requireCliValue(argv, index, arg);
      index += 1;
    } else if (arg === "--live-agent-timeout-seconds") {
      options.liveAgentTimeoutSeconds = parseNonNegativeNumber(
        requireCliValue(argv, index, arg),
        arg,
      );
      index += 1;
    } else if (arg === "--live-agent-retries") {
      options.liveAgentRetryLimit = parseNonNegativeInteger(requireCliValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === "--live-agent-retry-timeout-seconds") {
      options.liveAgentRetryTimeoutSeconds = parseNonNegativeNumber(
        requireCliValue(argv, index, arg),
        arg,
      );
      index += 1;
    } else if (arg === "--live-agent-candidate-pool") {
      options.liveAgentCandidatePoolMode = parseLiveAgentCandidatePoolMode(
        requireCliValue(argv, index, arg),
        arg,
      );
      index += 1;
    } else if (arg === "--live-agent-mode") {
      options.liveAgentMode = parseLiveAgentMode(requireCliValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === "--live-agent-batch-size") {
      options.liveAgentBatchSize = parsePositiveInteger(requireCliValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === "--live-qianji-concurrency" || arg === "--live-agent-concurrency") {
      options.liveQianjiConcurrency = parsePositiveInteger(requireCliValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === "--search-backend") {
      options.searchBackend = requireCliValue(argv, index, arg);
      index += 1;
    } else if (arg === "--search-rust-bridge-bin") {
      options.searchRustBridgeBin = requireCliValue(argv, index, arg);
      index += 1;
    } else if (arg === "--search-rust-bridge-session") {
      options.searchRustBridgeSession = true;
    } else if (arg === "--search-rust-bridge-warmup-rows") {
      options.searchRustBridgeWarmupRows = parseNonNegativeInteger(requireCliValue(argv, index, arg), arg);
      index += 1;
    } else if (arg === "--search-flight-base-url") {
      options.searchFlightBaseUrl = requireCliValue(argv, index, arg);
      index += 1;
    } else if (arg === "--search-flight-timeout-seconds") {
      options.searchFlightTimeoutSeconds = Number.parseInt(requireCliValue(argv, index, arg), 10);
      index += 1;
    } else if (arg === "--search-strategy-flow-service-base-url") {
      options.searchStrategyFlowServiceBaseUrl = requireCliValue(argv, index, arg);
      index += 1;
    } else if (arg === "--search-strategy-flow-service-timeout-seconds") {
      options.searchStrategyFlowServiceTimeoutSeconds = Number.parseInt(requireCliValue(argv, index, arg), 10);
      index += 1;
    } else {
      throw new Error(`unknown Markdown corpus benchmark option: ${arg}`);
    }
  }
  return options;
}

function requireCliValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function parseNonNegativeNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative number`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value || parsed < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, option: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value || parsed < 0) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return parsed;
}

function parseLiveAgentCandidatePoolMode(
  value: string,
  option: string,
): SearchStrategyFlowAgentCandidatePoolMode {
  if (value === "auto" || value === "visible" || value === "selected-only") return value;
  throw new Error(`${option} must be one of auto, visible, or selected-only`);
}

function parseLiveAgentMode(
  value: string,
  option: string,
): SearchStrategyFlowMarkdownCorpusLiveAgentMode {
  if (
    value === "branch-judgement" ||
    value === "batch-judgement" ||
    value === "batch-sufficiency"
  ) {
    return value;
  }
  throw new Error(
    `${option} must be one of branch-judgement, batch-judgement, or batch-sufficiency`,
  );
}

function resolveLiveAgentMode(
  value: SearchStrategyFlowMarkdownCorpusLiveAgentMode | undefined,
): SearchStrategyFlowMarkdownCorpusLiveAgentMode {
  return value ?? "branch-judgement";
}

function printReport(report: SearchStrategyFlowMarkdownCorpusBenchmarkReportDto): void {
  process.stdout.write(renderMarkdownCorpusBenchmarkReport(report));
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (!existsSync(resolve(options.cwd ?? process.cwd(), options.fixturePath ?? DEFAULT_FIXTURE_PATH))) {
      throw new Error(`fixture not found: ${options.fixturePath ?? DEFAULT_FIXTURE_PATH}`);
    }
    const report = await runSearchStrategyFlowMarkdownCorpusBenchmark(options);
    printReport(report);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode ?? 0);
  }
}
