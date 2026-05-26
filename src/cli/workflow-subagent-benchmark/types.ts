export type WorkflowSubagentBenchmarkVariant =
  | "qianji-complex-fixture"
  | "pi-wendao-deterministic-complex-subagent"
  | "qianji-server-deterministic-complex-subagent"
  | "qianji-server-fresh-start-deterministic-complex-subagent"
  | "pi-wendao-live-complex-subagent";

export type WorkflowSubagentBenchmarkStatus = "passed" | "failed" | "skipped";
export type WorkflowSubagentBenchmarkPath = string;
export type WorkflowSubagentBenchmarkProcessId = string;
export type WorkflowSubagentBenchmarkModelPattern = string;
export type WorkflowSubagentBenchmarkMilliseconds = number;
export type WorkflowSubagentBenchmarkCount = number;
export type WorkflowSubagentBenchmarkVariableKey = string;
export type WorkflowSubagentBenchmarkError = string;
export type WorkflowSubagentBenchmarkStartedAt = string;
export type WorkflowSubagentBenchmarkServerUrl = string;
export type WorkflowSubagentBenchmarkServerStartMode = "resume-or-start" | "start";

export interface WorkflowSubagentBenchmarkOptions {
  cwd?: WorkflowSubagentBenchmarkPath;
  fixturePath?: WorkflowSubagentBenchmarkPath;
  processId?: WorkflowSubagentBenchmarkProcessId;
  iterations?: WorkflowSubagentBenchmarkCount;
  live?: boolean;
  model?: WorkflowSubagentBenchmarkModelPattern;
  serverUrl?: WorkflowSubagentBenchmarkServerUrl;
  outputJsonPath?: WorkflowSubagentBenchmarkPath;
  json?: boolean;
}

export interface WorkflowSubagentBenchmarkRow {
  variant: WorkflowSubagentBenchmarkVariant;
  iteration: WorkflowSubagentBenchmarkCount;
  status: WorkflowSubagentBenchmarkStatus;
  success: boolean;
  wallMs: WorkflowSubagentBenchmarkMilliseconds;
  workflowPath: WorkflowSubagentBenchmarkPath;
  processId: WorkflowSubagentBenchmarkProcessId;
  model?: WorkflowSubagentBenchmarkModelPattern;
  serverUrl?: WorkflowSubagentBenchmarkServerUrl;
  serverStartMode?: WorkflowSubagentBenchmarkServerStartMode;
  httpCallCount?: WorkflowSubagentBenchmarkCount;
  httpMs?: WorkflowSubagentBenchmarkMilliseconds;
  subagentToolCallCount?: WorkflowSubagentBenchmarkCount;
  subagentToolMs?: WorkflowSubagentBenchmarkMilliseconds;
  unaccountedMs?: WorkflowSubagentBenchmarkMilliseconds;
  traceEventCount: WorkflowSubagentBenchmarkCount;
  parallelBatchCount: WorkflowSubagentBenchmarkCount;
  variableKeys: WorkflowSubagentBenchmarkVariableKey[];
  variables: Record<string, unknown>;
  error?: WorkflowSubagentBenchmarkError;
}

export interface WorkflowSubagentBenchmarkReport {
  benchmark: "workflow-subagent-bpmn";
  fixturePath: WorkflowSubagentBenchmarkPath;
  processId: WorkflowSubagentBenchmarkProcessId;
  iterations: WorkflowSubagentBenchmarkCount;
  live: boolean;
  startedAt: WorkflowSubagentBenchmarkStartedAt;
  rows: WorkflowSubagentBenchmarkRow[];
  summary: WorkflowSubagentBenchmarkSummary;
}

export interface WorkflowSubagentBenchmarkSummary {
  rowCount: WorkflowSubagentBenchmarkCount;
  passedCount: WorkflowSubagentBenchmarkCount;
  failedCount: WorkflowSubagentBenchmarkCount;
  skippedCount: WorkflowSubagentBenchmarkCount;
  deterministicAvgMs: WorkflowSubagentBenchmarkMilliseconds;
  deterministicSubagentAvgMs: WorkflowSubagentBenchmarkMilliseconds;
  serverSubagentAvgMs: WorkflowSubagentBenchmarkMilliseconds;
  serverFreshStartSubagentAvgMs: WorkflowSubagentBenchmarkMilliseconds;
  liveAvgMs: WorkflowSubagentBenchmarkMilliseconds;
  deterministicSubagentDeltaAvgMs: WorkflowSubagentBenchmarkMilliseconds;
  serverSubagentDeltaAvgMs: WorkflowSubagentBenchmarkMilliseconds;
  serverFreshStartSubagentDeltaAvgMs: WorkflowSubagentBenchmarkMilliseconds;
  liveDeltaAvgMs: WorkflowSubagentBenchmarkMilliseconds;
}
