import { runSearchStrategyFlowAgentTrace } from "../strategy-flow-agent.js";
import { evaluateMarkdownCorpusBenchmarkRow } from "./evaluate.js";
import { mapWithConcurrency } from "./concurrency.js";
import type {
  SearchStrategyFlowAgentCandidatePoolMode,
  SearchStrategyFlowMarkdownCorpusAgentRun,
  SearchStrategyFlowMarkdownCorpusBenchmarkOptions,
  SearchStrategyFlowMarkdownCorpusIntentRow,
} from "./types.js";
import type {
  SearchStrategyFlowAgentTrace,
  SearchStrategyFlowTrace,
} from "../strategy-flow-types.js";

export async function runBenchmarkLiveAgentRuns(input: {
  cwd: string;
  tracedRows: Array<{
    intentRow: SearchStrategyFlowMarkdownCorpusIntentRow;
    trace: SearchStrategyFlowTrace;
  }>;
  options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions;
  concurrency: number;
  defaultModelPattern: string;
}): Promise<SearchStrategyFlowMarkdownCorpusAgentRun[]> {
  const retryLimit = normalizeLiveAgentRetryLimit(input.options.liveAgentRetryLimit);
  const runner = input.options.liveAgentTraceRunner ?? runSearchStrategyFlowAgentTrace;
  const runs = await runInitialLiveAgentAttempts(input, runner);
  if (retryLimit === 0) return runs;
  return recoverRetryableLiveAgentTimeouts(input, runner, runs, retryLimit);
}

function runInitialLiveAgentAttempts(
  input: {
    cwd: string;
    tracedRows: Array<{
      intentRow: SearchStrategyFlowMarkdownCorpusIntentRow;
      trace: SearchStrategyFlowTrace;
    }>;
    options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions;
    concurrency: number;
    defaultModelPattern: string;
  },
  runner: NonNullable<SearchStrategyFlowMarkdownCorpusBenchmarkOptions["liveAgentTraceRunner"]>,
): Promise<SearchStrategyFlowMarkdownCorpusAgentRun[]> {
  return mapWithConcurrency(input.tracedRows, input.concurrency, ({ intentRow, trace }) =>
    runLiveAgentAttempt(input.cwd, input.options, runner, intentRow, trace, {
      defaultModelPattern: input.defaultModelPattern,
      retry: false,
    }),
  );
}

async function recoverRetryableLiveAgentTimeouts(
  input: {
    cwd: string;
    tracedRows: Array<{
      intentRow: SearchStrategyFlowMarkdownCorpusIntentRow;
      trace: SearchStrategyFlowTrace;
    }>;
    options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions;
    defaultModelPattern: string;
  },
  runner: NonNullable<SearchStrategyFlowMarkdownCorpusBenchmarkOptions["liveAgentTraceRunner"]>,
  runs: SearchStrategyFlowMarkdownCorpusAgentRun[],
  retryLimit: number,
): Promise<SearchStrategyFlowMarkdownCorpusAgentRun[]> {
  for (const [index, run] of runs.entries()) {
    const tracedRow = input.tracedRows[index];
    if (!tracedRow) continue;
    let currentRun = run;
    if (!shouldRetryLiveAgentRun(tracedRow.intentRow, tracedRow.trace, currentRun)) continue;
    runs[index] = await recoverSingleLiveAgentTimeout(
      input,
      runner,
      tracedRow,
      currentRun,
      retryLimit,
    );
  }
  return runs;
}

async function recoverSingleLiveAgentTimeout(
  input: {
    cwd: string;
    options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions;
    defaultModelPattern: string;
  },
  runner: NonNullable<SearchStrategyFlowMarkdownCorpusBenchmarkOptions["liveAgentTraceRunner"]>,
  tracedRow: {
    intentRow: SearchStrategyFlowMarkdownCorpusIntentRow;
    trace: SearchStrategyFlowTrace;
  },
  run: SearchStrategyFlowMarkdownCorpusAgentRun,
  retryLimit: number,
): Promise<SearchStrategyFlowMarkdownCorpusAgentRun> {
  let currentRun = run;
  for (let retryIndex = 0; retryIndex < retryLimit; retryIndex += 1) {
    const retryRun = await runLiveAgentAttempt(
      input.cwd,
      input.options,
      runner,
      tracedRow.intentRow,
      tracedRow.trace,
      {
        defaultModelPattern: input.defaultModelPattern,
        retry: true,
      },
    );
    currentRun = mergeLiveAgentRetry(currentRun, retryRun);
    if (currentRun.trace.status === "completed") break;
    if (!shouldRetryLiveAgentRun(tracedRow.intentRow, tracedRow.trace, currentRun)) break;
  }
  return currentRun;
}

function mergeLiveAgentRetry(
  currentRun: SearchStrategyFlowMarkdownCorpusAgentRun,
  retryRun: SearchStrategyFlowMarkdownCorpusAgentRun,
): SearchStrategyFlowMarkdownCorpusAgentRun {
  return {
    trace: retryRun.trace,
    attemptCount: currentRun.attemptCount + 1,
    retryCount: currentRun.retryCount + 1,
    retryReasons: [...currentRun.retryReasons, liveAgentFailureReason(currentRun.trace)],
    candidatePoolMode: retryRun.candidatePoolMode,
    liveAgentMode: retryRun.liveAgentMode,
  };
}

async function runLiveAgentAttempt(
  cwd: string,
  options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions,
  runner: NonNullable<SearchStrategyFlowMarkdownCorpusBenchmarkOptions["liveAgentTraceRunner"]>,
  intentRow: SearchStrategyFlowMarkdownCorpusIntentRow,
  trace: SearchStrategyFlowTrace,
  attempt: { defaultModelPattern: string; retry: boolean },
): Promise<SearchStrategyFlowMarkdownCorpusAgentRun> {
  const candidatePoolMode = resolveLiveAgentCandidatePoolMode(
    options.liveAgentCandidatePoolMode,
    trace,
  );
  const agentTrace = await runner({
    trace,
    cwd,
    modelPattern: options.modelPattern ?? attempt.defaultModelPattern,
    provider: options.provider,
    apiKey: options.apiKey,
    thinkingLevel: options.thinkingLevel,
    timeoutSeconds: attempt.retry
      ? (options.liveAgentRetryTimeoutSeconds ?? options.liveAgentTimeoutSeconds)
      : options.liveAgentTimeoutSeconds,
    forceJudgement: intentRow.liveEvidenceRequired,
    qianjiCommand: options.qianjiCommand,
    candidatePoolMode,
    extensionPaths: options.extensionPaths ?? [],
  });
  return {
    trace: agentTrace,
    attemptCount: 1,
    retryCount: 0,
    retryReasons: [],
    candidatePoolMode,
    liveAgentMode: "branch-judgement",
  };
}

export function shouldRetryLiveAgentRun(
  intentRow: SearchStrategyFlowMarkdownCorpusIntentRow,
  trace: SearchStrategyFlowTrace,
  run: SearchStrategyFlowMarkdownCorpusAgentRun,
): boolean {
  if (run.trace.status === "completed") return false;
  if (!isRetryableLiveAgentTrace(run.trace)) return false;
  return evaluateMarkdownCorpusBenchmarkRow(intentRow, trace).violations.length === 0;
}

function isRetryableLiveAgentTrace(trace: SearchStrategyFlowAgentTrace): boolean {
  if (trace.status !== "failed") return false;
  const reason = trace.reason?.toLowerCase() ?? "";
  return reason.includes("timed out") || reason.includes("timeout");
}

function liveAgentFailureReason(trace: SearchStrategyFlowAgentTrace): string {
  return trace.reason ?? trace.status;
}

function normalizeLiveAgentRetryLimit(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("--live-agent-retries must be a non-negative integer");
  }
  return value;
}

export function resolveLiveAgentCandidatePoolMode(
  value: SearchStrategyFlowAgentCandidatePoolMode | undefined,
  trace: SearchStrategyFlowTrace,
): SearchStrategyFlowAgentCandidatePoolMode {
  if (value === "visible" || value === "selected-only") return value;
  if (value !== undefined && value !== "auto") {
    throw new Error("--live-agent-candidate-pool must be one of auto, visible, or selected-only");
  }
  return trace.validation.requiredEvidenceCovered === true ? "selected-only" : "visible";
}
