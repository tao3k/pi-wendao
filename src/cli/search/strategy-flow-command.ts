import { resolve as resolvePath } from "node:path";
import type { PiWendaoThinkingLevel } from "../../executor/agent-runtime-types.js";
import {
  writeSearchStrategyFlowAgentAnswerEvidence,
  writeSearchStrategyFlowRequestAnswerEvidence,
} from "./strategy-flow-agent-evidence.js";
import { runSearchStrategyFlowAgentTrace } from "./strategy-flow-agent.js";
import { resolveSearchStrategyFlowCliOptions } from "./strategy-flow-cli-options.js";
import { runSearchStrategyFlow } from "./strategy-flow-julia.js";
import { writeSearchStrategyFlowLiveRequestAnswerEvidence } from "./strategy-flow-live-answer.js";
import { renderSearchStrategyFlowTrace } from "./strategy-flow-renderer.js";

interface SearchStrategyFlowCommandOptions {
  intent: string;
  cwd: string;
  wendaoGraph?: string;
  searchJulia?: string;
  searchBackend?: string;
  searchRustWorkspace?: string;
  searchRustCommand?: string;
  searchRustBridgeBin?: string;
  searchRustBridgeSession?: boolean;
  searchFlightBaseUrl?: string;
  searchFlightTimeoutSeconds?: number;
  searchStrategyFlowServiceBaseUrl?: string;
  searchStrategyFlowServiceTimeoutSeconds?: number;
  searchAgent?: boolean;
  searchAgentAnswerRequest?: string;
  searchAgentAnswerMode?: string;
  searchAgentAnswerChunkSize?: number;
  searchAgentAnswerResume?: boolean;
  searchAgentAnswerEvidence?: string;
  searchJson?: boolean;
  qianjiCommand?: string;
  modelPattern: string;
  provider?: string;
  apiKey?: string;
  thinkingLevel?: PiWendaoThinkingLevel;
  extensionPaths: string[];
}

type SearchStrategyFlowAnswerRequestInvocation =
  | { kind: "none" }
  | { kind: "deterministic"; requestPath: string; evidencePath: string }
  | { kind: "live"; requestPath: string; evidencePath: string };

export async function runSearchStrategyFlowCommand(
  options: SearchStrategyFlowCommandOptions,
): Promise<void> {
  const requestInvocation = resolveAnswerRequestInvocation(options);
  if (requestInvocation.kind === "deterministic") return runDeterministicRequestAnswer(options, requestInvocation);
  if (requestInvocation.kind === "live") return runLiveRequestAnswer(options, requestInvocation);
  await runSearchTraceCommand(options);
}

function resolveAnswerRequestInvocation(
  options: SearchStrategyFlowCommandOptions,
): SearchStrategyFlowAnswerRequestInvocation {
  if (!options.searchAgentAnswerRequest) return { kind: "none" };
  if (!options.searchAgentAnswerEvidence) {
    throw new Error("--search-agent-answer-request requires --search-agent-answer-evidence");
  }
  const answerMode = options.searchAgentAnswerMode ?? "deterministic";
  if (answerMode !== "deterministic" && answerMode !== "live") {
    throw new Error("--search-agent-answer-mode must be deterministic or live");
  }
  if (answerMode === "live") {
    if (options.searchAgent !== true) {
      throw new Error("--search-agent-answer-mode live requires --search-agent");
    }
    return {
      kind: "live",
      requestPath: resolvePath(options.cwd, options.searchAgentAnswerRequest),
      evidencePath: resolvePath(options.cwd, options.searchAgentAnswerEvidence),
    };
  }
  if (options.searchAgent === true) {
    throw new Error("--search-agent-answer-mode deterministic cannot be combined with --search-agent");
  }
  return {
    kind: "deterministic",
    requestPath: resolvePath(options.cwd, options.searchAgentAnswerRequest),
    evidencePath: resolvePath(options.cwd, options.searchAgentAnswerEvidence),
  };
}

function runDeterministicRequestAnswer(
  options: SearchStrategyFlowCommandOptions,
  invocation: Extract<SearchStrategyFlowAnswerRequestInvocation, { kind: "deterministic" }>,
): void {
  const evidence = writeSearchStrategyFlowRequestAnswerEvidence(
    invocation.requestPath,
    invocation.evidencePath,
  );
  if (!options.searchJson) {
    console.error(
      `SearchStrategyFlow materialized answer evidence: wrote ${evidence.rowCount} row(s) to ${evidence.path}`,
    );
  }
}

async function runLiveRequestAnswer(
  options: SearchStrategyFlowCommandOptions,
  invocation: Extract<SearchStrategyFlowAnswerRequestInvocation, { kind: "live" }>,
): Promise<void> {
  const evidence = await writeSearchStrategyFlowLiveRequestAnswerEvidence({
    requestPath: invocation.requestPath,
    evidencePath: invocation.evidencePath,
    cwd: options.cwd,
    chunkSize: options.searchAgentAnswerChunkSize,
    resumeExisting: options.searchAgentAnswerResume,
    modelPattern: options.modelPattern,
    provider: options.provider,
    apiKey: options.apiKey,
    thinkingLevel: options.thinkingLevel,
    qianjiCommand: options.qianjiCommand,
    extensionPaths: options.extensionPaths,
    onChunkComplete: options.searchJson
      ? undefined
      : (progress) => {
          console.error(
            `SearchStrategyFlow live materialized answer chunk ${progress.chunkIndex}/${progress.chunkCount}: accepted ${progress.rowCount} row(s)`,
          );
        },
  });
  if (!options.searchJson) {
    console.error(
      `SearchStrategyFlow live materialized answer evidence: wrote ${evidence.rowCount} row(s) to ${evidence.path}`,
    );
  }
}

async function runSearchTraceCommand(options: SearchStrategyFlowCommandOptions): Promise<void> {
  const baseOptions = resolveSearchStrategyFlowCliOptions({
    intent: options.intent,
    cwd: options.cwd,
    wendaoGraph: options.wendaoGraph,
    searchJulia: options.searchJulia,
    searchBackend: options.searchBackend,
    searchRustWorkspace: options.searchRustWorkspace,
    searchRustCommand: options.searchRustCommand,
    searchRustBridgeBin: options.searchRustBridgeBin,
    searchRustBridgeSession: options.searchRustBridgeSession,
    searchFlightBaseUrl: options.searchFlightBaseUrl,
    searchFlightTimeoutSeconds: options.searchFlightTimeoutSeconds,
    searchStrategyFlowServiceBaseUrl: options.searchStrategyFlowServiceBaseUrl,
    searchStrategyFlowServiceTimeoutSeconds: options.searchStrategyFlowServiceTimeoutSeconds,
  });
  const trace = await runSearchStrategyFlow(baseOptions);
  const agentTrace =
    options.searchAgent === true
      ? await runSearchStrategyFlowAgentTrace({
          trace,
          cwd: options.cwd,
          modelPattern: options.modelPattern,
          provider: options.provider,
          apiKey: options.apiKey,
          thinkingLevel: options.thinkingLevel,
          qianjiCommand: options.qianjiCommand,
          extensionPaths: options.extensionPaths,
        })
      : undefined;
  const renderedTrace =
    agentTrace?.status === "completed" &&
    agentTrace.branchJudgements &&
    agentTrace.branchJudgements.length > 0
      ? await runSearchStrategyFlow({
          ...baseOptions,
          queryUnderstanding: trace.queryUnderstanding,
          branchJudgements: agentTrace.branchJudgements,
        })
      : trace;
  if (options.searchAgentAnswerEvidence) {
    if (options.searchAgent !== true) {
      throw new Error("--search-agent-answer-evidence requires --search-agent");
    }
    const evidence = writeSearchStrategyFlowAgentAnswerEvidence(
      resolvePath(options.cwd, options.searchAgentAnswerEvidence),
      renderedTrace,
      agentTrace,
      trace,
    );
    if (!options.searchJson) {
      console.error(
        `SearchStrategyFlow live answer evidence: wrote ${evidence.rowCount} row(s) to ${evidence.path}`,
      );
    }
  }
  await writeSearchStrategyFlowCommandStdout(
    options.searchJson
      ? `${JSON.stringify(agentTrace ? { ...renderedTrace, agentTrace } : renderedTrace, null, 2)}\n`
      : `${renderSearchStrategyFlowTrace(renderedTrace, agentTrace)}\n`,
  );
}

async function writeSearchStrategyFlowCommandStdout(text: string): Promise<void> {
  if (process.stdout.write(text)) return;
  await new Promise<void>((resolve) => {
    process.stdout.once("drain", resolve);
  });
}
