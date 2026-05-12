import { resolve as resolvePath } from "node:path";
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
  searchRoot?: string;
  searchJulia?: string;
  searchBackend?: string;
  searchRustWorkspace?: string;
  searchRustCommand?: string;
  searchFlightBaseUrl?: string;
  searchFlightRepo?: string;
  searchFlightTimeoutSeconds?: number;
  searchAgent?: boolean;
  searchAgentAnswerRequest?: string;
  searchAgentAnswerMode?: string;
  searchAgentAnswerChunkSize?: number;
  searchAgentAnswerResume?: boolean;
  searchAgentAnswerEvidence?: string;
  searchJson?: boolean;
  modelPattern: string;
  provider?: string;
  apiKey?: string;
  thinkingLevel?: string;
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
  const trace = await runSearchStrategyFlow(resolveSearchStrategyFlowCliOptions({
    intent: options.intent,
    cwd: options.cwd,
    wendaoGraph: options.wendaoGraph,
    searchRoot: options.searchRoot,
    searchJulia: options.searchJulia,
    searchBackend: options.searchBackend,
    searchRustWorkspace: options.searchRustWorkspace,
    searchRustCommand: options.searchRustCommand,
    searchFlightBaseUrl: options.searchFlightBaseUrl,
    searchFlightRepo: options.searchFlightRepo,
    searchFlightTimeoutSeconds: options.searchFlightTimeoutSeconds,
  }));
  const agentTrace =
    options.searchAgent === true
      ? await runSearchStrategyFlowAgentTrace({
          trace,
          cwd: options.cwd,
          modelPattern: options.modelPattern,
          provider: options.provider,
          apiKey: options.apiKey,
          thinkingLevel: options.thinkingLevel,
          extensionPaths: options.extensionPaths,
        })
      : undefined;
  if (options.searchAgentAnswerEvidence) {
    if (options.searchAgent !== true) {
      throw new Error("--search-agent-answer-evidence requires --search-agent");
    }
    const evidence = writeSearchStrategyFlowAgentAnswerEvidence(
      resolvePath(options.cwd, options.searchAgentAnswerEvidence),
      trace,
      agentTrace,
    );
    if (!options.searchJson) {
      console.error(
        `SearchStrategyFlow live answer evidence: wrote ${evidence.rowCount} row(s) to ${evidence.path}`,
      );
    }
  }
  console.log(
    options.searchJson
      ? `${JSON.stringify(agentTrace ? { ...trace, agentTrace } : trace, null, 2)}\n`
      : renderSearchStrategyFlowTrace(trace, agentTrace),
  );
}
