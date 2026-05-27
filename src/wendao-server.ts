/**
 * Stable package facade for Wendao SearchStrategyFlow runtime integration.
 *
 * This boundary exposes library-safe SearchStrategyFlow runners, renderers,
 * Arrow IPC helpers, agent judgement helpers, and benchmark DTOs while leaving
 * CLI command wiring private.
 */
export { resolveSearchStrategyFlowCliOptions } from "./cli/search/strategy-flow-cli-options.js";
export {
  resolveSearchStrategyFlowRustCommandOverride,
  runSearchStrategyFlow,
} from "./cli/search/strategy-flow-julia.js";
export { renderSearchStrategyFlowTrace } from "./cli/search/strategy-flow-renderer.js";
export { parseStrategyFlowTrace } from "./cli/search/strategy-flow-trace.js";
export {
  buildSearchStrategyFlowBranchContexts,
  inferSearchStrategyFlowRouteRole,
} from "./cli/search/strategy-flow-branch-context.js";
export type {
  SearchStrategyFlowBranchContext,
  SearchStrategyFlowDerivedTraceHints,
  SearchStrategyFlowRouteRole,
} from "./cli/search/strategy-flow-branch-context.js";
export {
  parseSearchStrategyFlowBranchJudgements,
  renderSearchStrategyFlowBranchJudgementTsv,
} from "./cli/search/strategy-flow-branch-judgement.js";
export type { SearchStrategyFlowBranchJudgementParseResult } from "./cli/search/strategy-flow-branch-judgement.js";
export { encodeSearchStrategyFlowBranchJudgementsArrowIpc } from "./cli/search/strategy-flow-branch-judgement-arrow.js";
export { encodeSearchStrategyFlowQueryUnderstandingArrowIpc } from "./cli/search/strategy-flow-query-understanding-arrow.js";
export {
  compactSearchStrategyFlowTraceForAgent,
  shouldRunSearchStrategyFlowAgentJudgement,
} from "./cli/search/strategy-flow-agent.js";
export type {
  SearchStrategyFlowAgentCandidatePoolMode,
  SearchStrategyFlowAgentOptions,
} from "./cli/search/strategy-flow-agent.js";
export * from "./cli/search/strategy-flow-agent-evidence.js";
export { buildLiveRequestAnswerPrompt } from "./cli/search/strategy-flow-live-answer.js";
export {
  registerSearchStrategyFlowTool,
  WENDAO_SEARCH_STRATEGY_FLOW_TOOL_NAME,
} from "./cli/search/strategy-flow-tool.js";
export type {
  RegisterSearchStrategyFlowToolOptions,
  SearchStrategyFlowToolRunner,
} from "./cli/search/strategy-flow-tool.js";
export {
  evaluateMarkdownCorpusBenchmarkRow,
  mapWithConcurrency,
  parseMarkdownCorpusIntentFixture,
  renderMarkdownCorpusBenchmarkReport,
  runSearchStrategyFlowMarkdownCorpusBenchmark,
  shouldRetryLiveAgentRun,
  summarizeMarkdownCorpusBenchmarkReport,
} from "./cli/search/strategy-flow-markdown-corpus-benchmark.js";
export type {
  SearchStrategyFlowMarkdownCorpusAgentRun,
  SearchStrategyFlowMarkdownCorpusBenchmarkOptions,
  SearchStrategyFlowMarkdownCorpusBenchmarkReportDto,
  SearchStrategyFlowMarkdownCorpusBenchmarkRow,
  SearchStrategyFlowMarkdownCorpusIntentRow,
  SearchStrategyFlowMarkdownCorpusLiveAgentMode,
} from "./cli/search/strategy-flow-markdown-corpus-benchmark.js";
export * from "./cli/search/strategy-flow-types.js";
