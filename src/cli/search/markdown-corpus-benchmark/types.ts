import type { PiWendaoThinkingLevel } from "../../../executor/agent-runtime-types.js";
import type { WendaoTraceControlPlane, WendaoTraceDataPlane } from "../../../arrow/boundary.js";
import type { SearchStrategyFlowAgentCandidatePoolMode } from "../strategy-flow-agent.js";
import type {
  SearchStrategyFlowAgentTrace,
  SearchStrategyFlowTrace,
} from "../strategy-flow-types.js";
import type { Branded } from "../../../types/domain.js";

export type { SearchStrategyFlowAgentCandidatePoolMode } from "../strategy-flow-agent.js";

export type MarkdownCorpusBenchmarkPath = Branded<string, "MarkdownCorpusBenchmarkPath">;
export type MarkdownCorpusBenchmarkApiKey = Branded<string, "MarkdownCorpusBenchmarkApiKey">;
export type MarkdownCorpusBenchmarkModelPattern = string;
export type MarkdownCorpusBenchmarkProvider = string;
export type MarkdownCorpusBenchmarkBackend = string;
export type MarkdownCorpusBenchmarkCommand = string;
export type MarkdownCorpusBenchmarkFlightUrl = Branded<string, "MarkdownCorpusBenchmarkFlightUrl">;
export type MarkdownCorpusBenchmarkServiceUrl = Branded<
  string,
  "MarkdownCorpusBenchmarkServiceUrl"
>;
export type MarkdownCorpusBenchmarkFamilyId = Branded<string, "MarkdownCorpusBenchmarkFamilyId">;
export type MarkdownCorpusBenchmarkIntent = string;
export type MarkdownCorpusBenchmarkMilliseconds = number;
export type MarkdownCorpusBenchmarkConcurrency = number;
export type MarkdownCorpusBenchmarkCount = number;
export type MarkdownCorpusBenchmarkDataPlane = WendaoTraceDataPlane;
export type MarkdownCorpusBenchmarkControlEnvelope = WendaoTraceControlPlane;
export type MarkdownCorpusBenchmarkExecutionMode = "development" | "production";
export type SearchStrategyFlowMarkdownCorpusLiveAgentMode =
  | "branch-judgement"
  | "batch-judgement"
  | "batch-sufficiency";
export type SearchStrategyFlowMarkdownCorpusPromotionStatus = Branded<
  string,
  "SearchStrategyFlowMarkdownCorpusPromotionStatus"
>;
export type SearchStrategyFlowMarkdownCorpusLiveStatus = SearchStrategyFlowAgentTrace["status"];
export type SearchStrategyFlowMarkdownCorpusLiveAgentRunner = (options: {
  trace: SearchStrategyFlowTrace;
  cwd: string;
  modelPattern: string;
  provider?: string;
  apiKey?: string;
  thinkingLevel?: PiWendaoThinkingLevel;
  timeoutSeconds?: MarkdownCorpusBenchmarkMilliseconds;
  forceJudgement?: boolean;
  qianjiCommand?: MarkdownCorpusBenchmarkCommand;
  candidatePoolMode?: SearchStrategyFlowAgentCandidatePoolMode;
  extensionPaths: string[];
}) => Promise<SearchStrategyFlowAgentTrace>;
export type SearchStrategyFlowMarkdownCorpusLiveAgentBatchRunner = (input: {
  cwd: string;
  tracedRows: Array<{
    intentRow: SearchStrategyFlowMarkdownCorpusIntentRow;
    trace: SearchStrategyFlowTrace;
  }>;
  options: SearchStrategyFlowMarkdownCorpusBenchmarkOptions;
  concurrency: MarkdownCorpusBenchmarkConcurrency;
  defaultModelPattern: string;
}) => Promise<SearchStrategyFlowMarkdownCorpusAgentRun[]>;

export interface SearchStrategyFlowRustBridgeSessionTiming {
  requestCount: MarkdownCorpusBenchmarkCount;
  sessionDurationMs: MarkdownCorpusBenchmarkMilliseconds;
  firstResponseMs: MarkdownCorpusBenchmarkMilliseconds;
  responseSpanMs: MarkdownCorpusBenchmarkMilliseconds;
  maxResponseGapMs: MarkdownCorpusBenchmarkMilliseconds;
  warmupRequestCount?: MarkdownCorpusBenchmarkCount;
  warmupDurationMs?: MarkdownCorpusBenchmarkMilliseconds;
  steadyStateDurationMs?: MarkdownCorpusBenchmarkMilliseconds;
  steadyStateFirstResponseMs?: MarkdownCorpusBenchmarkMilliseconds;
  steadyStateResponseSpanMs?: MarkdownCorpusBenchmarkMilliseconds;
  steadyStateMaxResponseGapMs?: MarkdownCorpusBenchmarkMilliseconds;
}

export interface SearchStrategyFlowMarkdownCorpusIntentRow {
  familyId: MarkdownCorpusBenchmarkFamilyId;
  intent: MarkdownCorpusBenchmarkIntent;
  requiredEvidence: string[];
  expectedSourcePaths: string[];
  blockedSourcePaths: string[];
  liveEvidenceRequired: boolean;
  promotionStatus: SearchStrategyFlowMarkdownCorpusPromotionStatus;
}

export interface SearchStrategyFlowMarkdownCorpusAgentRun {
  trace: SearchStrategyFlowAgentTrace;
  attemptCount: MarkdownCorpusBenchmarkCount;
  retryCount: MarkdownCorpusBenchmarkCount;
  retryReasons: string[];
  candidatePoolMode: SearchStrategyFlowAgentCandidatePoolMode;
  liveAgentMode: SearchStrategyFlowMarkdownCorpusLiveAgentMode;
  batchId?: string;
  batchSize?: MarkdownCorpusBenchmarkCount;
  batchDurationMs?: MarkdownCorpusBenchmarkMilliseconds;
  sufficient?: boolean;
  sufficiencyReason?: string;
}

export interface SearchStrategyFlowMarkdownCorpusBenchmarkOptions {
  cwd?: MarkdownCorpusBenchmarkPath;
  fixturePath?: MarkdownCorpusBenchmarkPath;
  limit?: MarkdownCorpusBenchmarkCount;
  live?: boolean;
  failOnViolation?: boolean;
  outputJsonPath?: MarkdownCorpusBenchmarkPath;
  outputMarkdownPath?: MarkdownCorpusBenchmarkPath;
  qianjiCommand?: MarkdownCorpusBenchmarkCommand;
  modelPattern?: MarkdownCorpusBenchmarkModelPattern;
  provider?: MarkdownCorpusBenchmarkProvider;
  apiKey?: MarkdownCorpusBenchmarkApiKey;
  thinkingLevel?: PiWendaoThinkingLevel;
  liveAgentTimeoutSeconds?: MarkdownCorpusBenchmarkMilliseconds;
  liveAgentRetryLimit?: MarkdownCorpusBenchmarkCount;
  liveAgentRetryTimeoutSeconds?: MarkdownCorpusBenchmarkMilliseconds;
  liveAgentCandidatePoolMode?: SearchStrategyFlowAgentCandidatePoolMode;
  liveAgentMode?: SearchStrategyFlowMarkdownCorpusLiveAgentMode;
  liveAgentBatchSize?: MarkdownCorpusBenchmarkCount;
  liveQianjiConcurrency?: MarkdownCorpusBenchmarkConcurrency;
  liveAgentTraceRunner?: SearchStrategyFlowMarkdownCorpusLiveAgentRunner;
  liveAgentBatchRunner?: SearchStrategyFlowMarkdownCorpusLiveAgentBatchRunner;
  liveAgentSufficiencyRunner?: SearchStrategyFlowMarkdownCorpusLiveAgentBatchRunner;
  extensionPaths?: string[];
  wendaoGraph?: MarkdownCorpusBenchmarkPath;
  searchJulia?: MarkdownCorpusBenchmarkCommand;
  searchBackend?: MarkdownCorpusBenchmarkBackend;
  searchRustWorkspace?: MarkdownCorpusBenchmarkPath;
  searchRustCommand?: MarkdownCorpusBenchmarkCommand;
  searchRustBridgeBin?: MarkdownCorpusBenchmarkPath;
  searchRustBridgeSession?: boolean;
  searchRustBridgeWarmupRows?: MarkdownCorpusBenchmarkCount;
  searchFlightBaseUrl?: MarkdownCorpusBenchmarkFlightUrl;
  searchFlightTimeoutSeconds?: MarkdownCorpusBenchmarkMilliseconds;
  searchStrategyFlowServiceBaseUrl?: MarkdownCorpusBenchmarkServiceUrl;
  searchStrategyFlowServiceTimeoutSeconds?: MarkdownCorpusBenchmarkMilliseconds;
}

export interface SearchStrategyFlowMarkdownCorpusBenchmarkRow {
  familyId: MarkdownCorpusBenchmarkFamilyId;
  intent: MarkdownCorpusBenchmarkIntent;
  backend: string;
  controlPlane?: string;
  executionMode: MarkdownCorpusBenchmarkExecutionMode;
  promotionEligible: boolean;
  rustBridgeFallback?: string;
  candidateInputSource?: string;
  candidateInputCount?: number;
  candidateDiscoveryMs?: MarkdownCorpusBenchmarkMilliseconds;
  candidateDiscoveryAttemptCount?: MarkdownCorpusBenchmarkCount;
  selectedCount: number;
  selectedCandidateIds: string[];
  requiredEvidence: string[];
  selectedRequiredEvidence: string[];
  missingRequiredEvidence: string[];
  requiredEvidenceCovered: boolean;
  expectedSourceHit: boolean;
  expectedSourcePaths: string[];
  blockedSourceSelected: boolean;
  blockedSourcePaths: string[];
  retrievalReceiptSource?: string;
  retrievalPrimaryTransport?: string;
  routeMaterializationRouteCount?: MarkdownCorpusBenchmarkCount;
  routeMaterializationMs?: MarkdownCorpusBenchmarkMilliseconds;
  routeMaterializationMaxRouteMs?: MarkdownCorpusBenchmarkMilliseconds;
  liveStatus?: SearchStrategyFlowMarkdownCorpusLiveStatus;
  liveModel?: string;
  liveDurationMs?: MarkdownCorpusBenchmarkMilliseconds;
  liveReason?: string;
  liveToolUseCount?: number;
  liveBranchJudgementCount?: number;
  liveAttemptCount?: MarkdownCorpusBenchmarkCount;
  liveRetryCount?: MarkdownCorpusBenchmarkCount;
  liveRetryReasons?: string[];
  liveCandidatePoolMode?: SearchStrategyFlowAgentCandidatePoolMode;
  liveAgentMode?: SearchStrategyFlowMarkdownCorpusLiveAgentMode;
  liveBatchId?: string;
  liveBatchSize?: MarkdownCorpusBenchmarkCount;
  liveBatchDurationMs?: MarkdownCorpusBenchmarkMilliseconds;
  liveSufficient?: boolean;
  liveSufficiencyReason?: string;
  promotionStatus: SearchStrategyFlowMarkdownCorpusPromotionStatus;
  passed: boolean;
  violations: string[];
}

export interface SearchStrategyFlowMarkdownCorpusBenchmarkReportDto {
  fixturePath: MarkdownCorpusBenchmarkPath;
  live: boolean;
  rowCount: MarkdownCorpusBenchmarkCount;
  passedCount: MarkdownCorpusBenchmarkCount;
  failedCount: MarkdownCorpusBenchmarkCount;
  requiredEvidenceCoveredCount: MarkdownCorpusBenchmarkCount;
  expectedSourceHitCount: MarkdownCorpusBenchmarkCount;
  blockedSourceSelectedCount: MarkdownCorpusBenchmarkCount;
  promotionEligibleCount: MarkdownCorpusBenchmarkCount;
  liveCompletedCount: MarkdownCorpusBenchmarkCount;
  liveRetriedCount: MarkdownCorpusBenchmarkCount;
  liveRetryRecoveredCount: MarkdownCorpusBenchmarkCount;
  totalLiveAttemptCount: MarkdownCorpusBenchmarkCount;
  liveAgentCandidatePoolMode?: SearchStrategyFlowAgentCandidatePoolMode;
  liveAgentMode: SearchStrategyFlowMarkdownCorpusLiveAgentMode;
  liveBatchCount: MarkdownCorpusBenchmarkCount;
  liveBatchSize?: MarkdownCorpusBenchmarkCount;
  totalLiveBatchDurationMs: MarkdownCorpusBenchmarkMilliseconds;
  maxLiveBatchDurationMs: MarkdownCorpusBenchmarkMilliseconds;
  liveQianjiConcurrency: MarkdownCorpusBenchmarkConcurrency;
  traceDataPlane: MarkdownCorpusBenchmarkDataPlane;
  traceControlEnvelope: MarkdownCorpusBenchmarkControlEnvelope;
  rustBridgeSession: boolean;
  rustBridgeSessionTiming?: SearchStrategyFlowRustBridgeSessionTiming;
  totalCandidateDiscoveryMs: MarkdownCorpusBenchmarkMilliseconds;
  maxCandidateDiscoveryMs: MarkdownCorpusBenchmarkMilliseconds;
  totalRouteMaterializationMs: MarkdownCorpusBenchmarkMilliseconds;
  maxRouteMaterializationMs: MarkdownCorpusBenchmarkMilliseconds;
  wallDurationMs: MarkdownCorpusBenchmarkMilliseconds;
  totalLiveDurationMs: MarkdownCorpusBenchmarkMilliseconds;
  maxLiveDurationMs: MarkdownCorpusBenchmarkMilliseconds;
  rows: SearchStrategyFlowMarkdownCorpusBenchmarkRow[];
}
