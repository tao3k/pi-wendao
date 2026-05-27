import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  ModelRegistry,
  createExtensionRuntime,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedModel } from "../model-resolver.js";
import { createCliExtensionContext } from "../pi-subagents.js";
import { runWorkflowInRenderer } from "../workflow-runner.js";
import type { PiRegisteredToolDefinition } from "../../executor/pi-subagents-runtime.js";
import {
  complexTaskOutput,
  hasExpectedComplexVariables,
  parseActivityIdFromPrompt,
} from "./fixture.js";
import {
  BenchmarkRenderer,
  countLiveWorkflowTraceLogs,
  countParallelHostWorkBatches,
} from "./renderer.js";
import type { WorkflowSubagentBenchmarkRow } from "./types.js";
import type { WorkflowSubagentBenchmarkServerStartMode } from "./types.js";

export async function runDeterministicComplexBpmnSubagent(input: {
  cwd: string;
  fixturePath: string;
  processId: string;
  iteration: number;
  serverUrl?: string;
  serverStartMode?: WorkflowSubagentBenchmarkServerStartMode;
}): Promise<WorkflowSubagentBenchmarkRow> {
  const started = performance.now();
  const renderer = new BenchmarkRenderer();
  const phaseTimings = new BenchmarkPhaseTimings(input.serverUrl);
  const originalStore = process.env.PI_WENDAO_SUBAGENTS_RUN_STORE;
  const restoreFetch = phaseTimings.installFetchProbe();
  process.env.PI_WENDAO_SUBAGENTS_RUN_STORE ??= join(
    mkdtempSync(join(tmpdir(), "pi-wendao-complex-bpmn-deterministic-subagent-")),
    "subagents.json",
  );
  const modelRegistry = ModelRegistry.create(AuthStorage.create());
  const faux = registerFauxProvider();
  const activityByAgentId = new Map<string, string>();
  const loadResult = loadResultWithTools({
    Agent: tool(
      "Agent",
      async (params) => {
        const prompt = String(params.prompt ?? "");
        const activityId = parseActivityIdFromPrompt(prompt);
        const agentId = `agent-${activityId}-${activityByAgentId.size + 1}`;
        activityByAgentId.set(agentId, activityId);
        return {
          content: [{ type: "text", text: `Agent ID: ${agentId}\n` }],
          details: { agentId },
        };
      },
      phaseTimings,
    ),
    get_subagent_result: tool(
      "get_subagent_result",
      async (params) => {
        const agentId = String(params.agent_id ?? "");
        const activityId = activityByAgentId.get(agentId) ?? "Task_Unknown";
        return {
          content: [
            {
              type: "text",
              text: `Done.\n\`\`\`json\n${JSON.stringify(complexTaskOutput(activityId))}\n\`\`\``,
            },
          ],
        };
      },
      phaseTimings,
    ),
  });
  try {
    const startMode = input.serverStartMode ?? "resume-or-start";
    const result = await runWorkflowInRenderer({
      renderer,
      useGraph: false,
      resolvedWorkflowPath: input.fixturePath,
      options: {
        process: input.processId,
        contextJson: "{}",
        traceFrameMs: 0,
        qianjiWorkflowServerUrl: input.serverUrl,
        qianjiWorkflowStartMode: input.serverUrl ? startMode : undefined,
      },
      instanceId: `wf_complex_deterministic_subagent_${startMode}_${Date.now()}_${input.iteration}`,
      invocationCwd: input.cwd,
      piContextCwd: input.cwd,
      resolvedDmnPaths: [],
      thinkingLevel: "medium",
      preflightLint: input.serverUrl ? false : undefined,
      resolvedModel: {
        model: faux.getModel(),
        apiKey: "test-key",
        loadResult,
        modelRegistry,
        cwd: input.cwd,
        agentDir: input.cwd,
        services: {},
        extensionPaths: [],
      } as unknown as ResolvedModel,
    });
    const success = result.success && hasExpectedComplexVariables(renderer.variables);
    return benchmarkRow({
      input,
      renderer,
      phaseTimings,
      started,
      success,
      error: success ? undefined : renderer.errors.map((error) => error.message).join("; "),
    });
  } catch (error) {
    return benchmarkRow({
      input,
      renderer,
      phaseTimings,
      started,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    restoreFetch();
    faux.unregister();
    if (originalStore === undefined) {
      delete process.env.PI_WENDAO_SUBAGENTS_RUN_STORE;
    } else {
      process.env.PI_WENDAO_SUBAGENTS_RUN_STORE = originalStore;
    }
  }
}

function benchmarkRow(input: {
  input: {
    fixturePath: string;
    processId: string;
    iteration: number;
    serverUrl?: string;
    serverStartMode?: WorkflowSubagentBenchmarkServerStartMode;
  };
  renderer: BenchmarkRenderer;
  phaseTimings: BenchmarkPhaseTimings;
  started: number;
  success: boolean;
  error?: string;
}): WorkflowSubagentBenchmarkRow {
  const wallMs = performance.now() - input.started;
  const timingSummary = input.phaseTimings.summary(wallMs);
  const traceEventCount = countLiveWorkflowTraceLogs(
    input.renderer.logs,
    input.renderer.traceEvents.length,
  );
  const serverUrl = input.input.serverUrl?.trim();
  const startMode = serverUrl ? (input.input.serverStartMode ?? "resume-or-start") : undefined;
  return {
    variant: benchmarkVariant(serverUrl, startMode),
    iteration: input.input.iteration,
    status: input.success ? "passed" : "failed",
    success: input.success,
    wallMs,
    workflowPath: input.input.fixturePath,
    processId: input.input.processId,
    serverUrl: serverUrl || undefined,
    serverStartMode: startMode,
    httpCallCount: timingSummary.httpCallCount,
    httpMs: timingSummary.httpMs,
    subagentToolCallCount: timingSummary.subagentToolCallCount,
    subagentToolMs: timingSummary.subagentToolMs,
    unaccountedMs: timingSummary.unaccountedMs,
    traceEventCount,
    parallelBatchCount: countParallelHostWorkBatches(input.renderer.logs),
    variableKeys: Object.keys(input.renderer.variables),
    variables: input.renderer.variables,
    error: input.error,
  };
}

function benchmarkVariant(
  serverUrl: string | undefined,
  startMode: WorkflowSubagentBenchmarkServerStartMode | undefined,
): WorkflowSubagentBenchmarkRow["variant"] {
  if (!serverUrl) return "pi-wendao-deterministic-complex-subagent";
  if (startMode === "start") return "qianji-server-fresh-start-deterministic-complex-subagent";
  return "qianji-server-deterministic-complex-subagent";
}

function loadResultWithTools(
  tools: Record<string, PiRegisteredToolDefinition>,
): LoadExtensionsResult {
  return {
    extensions: [
      {
        tools: new Map(
          Object.entries(tools).map(([name, definition]) => [
            name,
            {
              definition,
              sourceInfo: {
                path: "workflow-subagent-benchmark.ts",
                resolvedPath: "workflow-subagent-benchmark.ts",
                type: "extension",
              },
            },
          ]),
        ),
      },
    ],
    errors: [],
    runtime: createExtensionRuntime(),
  } as unknown as LoadExtensionsResult;
}

function tool(
  name: string,
  execute: (
    params: Record<string, unknown>,
    ctx: ReturnType<typeof createCliExtensionContext>,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>,
  phaseTimings: BenchmarkPhaseTimings,
): PiRegisteredToolDefinition {
  return {
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!toolCallId.includes(name)) {
        throw new Error(`unexpected benchmark tool call id: ${toolCallId}`);
      }
      return phaseTimings.measureSubagentTool(() =>
        execute(params, ctx as ReturnType<typeof createCliExtensionContext>),
      );
    },
  };
}

class BenchmarkPhaseTimings {
  private readonly serverUrl?: string;
  private httpMs = 0;
  private httpCallCount = 0;
  private subagentToolMs = 0;
  private subagentToolCallCount = 0;

  constructor(serverUrl: string | undefined) {
    const trimmed = serverUrl?.trim();
    this.serverUrl = trimmed || undefined;
  }

  installFetchProbe(): () => void {
    if (!this.serverUrl) return () => {};
    const baseUrl = this.serverUrl.endsWith("/") ? this.serverUrl : `${this.serverUrl}/`;
    const originalFetch = globalThis.fetch;
    const shouldMeasure = (input: Parameters<typeof fetch>[0]) => {
      try {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return url.href.startsWith(baseUrl) && url.pathname.startsWith("/workflows/");
      } catch {
        return false;
      }
    };
    globalThis.fetch = (async (input, init) => {
      if (!shouldMeasure(input)) return originalFetch(input, init);
      const started = performance.now();
      try {
        return await originalFetch(input, init);
      } finally {
        this.httpCallCount += 1;
        this.httpMs += performance.now() - started;
      }
    }) as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  async measureSubagentTool<T>(run: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await run();
    } finally {
      this.subagentToolCallCount += 1;
      this.subagentToolMs += performance.now() - started;
    }
  }

  summary(wallMs: number): {
    httpCallCount?: number;
    httpMs?: number;
    subagentToolCallCount: number;
    subagentToolMs: number;
    unaccountedMs: number;
  } {
    const measuredMs = this.httpMs + this.subagentToolMs;
    return {
      httpCallCount: this.httpCallCount > 0 ? this.httpCallCount : undefined,
      httpMs: this.httpCallCount > 0 ? this.httpMs : undefined,
      subagentToolCallCount: this.subagentToolCallCount,
      subagentToolMs: this.subagentToolMs,
      unaccountedMs: Math.max(0, wallMs - measuredMs),
    };
  }
}
