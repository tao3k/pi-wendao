import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  ModelRegistry,
  createExtensionRuntime,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import { createCliExtensionContext } from "../../src/cli/pi-subagents.js";
import { runWorkflowInRenderer } from "../../src/cli/workflow-runner.js";
import type { ResolvedModel } from "../../src/cli/model-resolver.js";
import type { PiWendaoAgentEvent } from "../../src/executor/agent-runtime-types.js";
import type { PiRegisteredToolDefinition } from "../../src/executor/pi-subagents-runtime.js";
import { GraphView } from "../../src/ui/graph-view.js";
import type { PlannerReplyRequest, QianjiTraceLogEvent, Renderer } from "../../src/ui/renderer.js";
import { nativeDefinitions, nativeServiceTask } from "../support/native-bpmn.js";
import {
  assertQianjiServerReady,
  resolveQianjiWorkflowServerSmokeUrl,
} from "../support/qianji-server-smoke.js";

const tempDirs: string[] = [];
const serverSmokeEnabled = process.env.RUN_PI_WENDAO_QIANJI_WORKFLOW_SERVER_SMOKE === "1";
const itServerSmoke = serverSmokeEnabled ? it : it.skip;
const serverSmokeTimeoutMs = readPositiveIntEnv(
  "PI_WENDAO_QIANJI_WORKFLOW_SERVER_SMOKE_TIMEOUT_MS",
  180_000,
);

describe("workflow runner qianji-server subagent smoke", () => {
  const originalRunStore = process.env.PI_WENDAO_SUBAGENTS_RUN_STORE;
  const originalWorkflowServerUrl = process.env.PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL;

  afterEach(() => {
    restoreEnv("PI_WENDAO_SUBAGENTS_RUN_STORE", originalRunStore);
    restoreEnv("PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL", originalWorkflowServerUrl);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  itServerSmoke(
    "executes native subagent host work through a real qianji-server workflow route",
    async () => {
      const serverUrl = resolveQianjiWorkflowServerSmokeUrl();
      await assertQianjiServerReady(serverUrl);
      process.env.PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL = serverUrl;

      const dir = mkdtempSync(join(tmpdir(), "pi-wendao-qianji-server-workflow-smoke-"));
      tempDirs.push(dir);
      process.env.PI_WENDAO_SUBAGENTS_RUN_STORE = join(dir, "subagents-server-smoke.json");
      const workflowPath = join(dir, "workflow-server-smoke.bpmn");
      writeFileSync(workflowPath, singleServiceTaskWorkflow(), "utf-8");

      const modelRegistry = ModelRegistry.create(AuthStorage.create());
      const faux = registerFauxProvider();
      const calls: string[] = [];
      const loadResult = loadResultWithTools({
        Agent: tool("Agent", async (params) => {
          expect(String(params.prompt)).toContain('item: "server"');
          calls.push("Agent");
          return {
            content: [{ type: "text", text: "Agent ID: agent-server\n" }],
            details: { agentId: "agent-server" },
          };
        }),
        get_subagent_result: tool("get_subagent_result", async (params) => {
          expect(params.agent_id).toBe("agent-server");
          calls.push("get_subagent_result");
          return {
            content: [
              {
                type: "text",
                text: 'Done.\n```json\n{"result":"server_done"}\n```',
              },
            ],
          };
        }),
      });
      const renderer = new RecordingRenderer();

      try {
        const result = await runWorkflowInRenderer({
          renderer,
          useGraph: false,
          resolvedWorkflowPath: workflowPath,
          options: {
            contextJson: JSON.stringify({ item: "server" }),
            qianjiWorkflowServerUrl: serverUrl,
            startAtNode: "Task_Review",
            traceFrameMs: 0,
          },
          instanceId: `wf_runner_native_subagents_real_server_${Date.now()}`,
          invocationCwd: dir,
          piContextCwd: dir,
          resolvedDmnPaths: [],
          thinkingLevel: "medium",
          preflightLint: false,
          resolvedModel: {
            model: faux.getModel(),
            apiKey: "test-key",
            loadResult,
            modelRegistry,
            cwd: dir,
            agentDir: dir,
            services: {},
            extensionPaths: [],
          } as unknown as ResolvedModel,
        });

        expect(result.success).toBe(true);
        expect(calls).toEqual(["Agent", "get_subagent_result"]);
        expect(renderer.logs.join("\n")).toContain("Host backend: pi-subagents");
        expect(
          renderer.traceEvents
            .filter(
              (event): event is Extract<QianjiTraceLogEvent, { kind: "node_status" }> =>
                event.kind === "node_status" && event.node_id === "Task_Review",
            )
            .map((event) => event.status),
        ).toEqual(["executing", "completed"]);
        expect(renderer.variables).toMatchObject({ result: "server_done" });
      } finally {
        faux.unregister();
      }
    },
    serverSmokeTimeoutMs,
  );
});

class RecordingRenderer implements Renderer {
  readonly graphView = new GraphView();
  readonly logs: string[] = [];
  readonly errors: string[] = [];
  readonly traceEvents: QianjiTraceLogEvent[] = [];
  variables: Record<string, unknown> = {};

  onAgentEvent(_event: PiWendaoAgentEvent): void {}
  onNodeStart(_activityId: string, _activityName: string): void {}
  onNodeEnd(_activityId: string, _activityName: string): void {}
  onFlowTake(_flowId: string): void {}
  onTraceEvent(event: QianjiTraceLogEvent): void {
    this.traceEvents.push(event);
  }

  onError(error: Error): void {
    this.errors.push(error.message);
  }

  printVariables(variables: Record<string, unknown>): void {
    this.variables = variables;
  }

  appendLog(text: string): void {
    this.logs.push(text);
  }

  async requestPlannerReply(_request: PlannerReplyRequest, _signal?: AbortSignal): Promise<string> {
    return "approved";
  }

  async waitForKey(): Promise<void> {}
  refresh(): void {}
  start(): void {}
  stop(): void {}
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
                path: "fixture.ts",
                resolvedPath: "fixture.ts",
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
): PiRegisteredToolDefinition {
  return {
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      expect(toolCallId).toContain(name);
      return execute(params, ctx as ReturnType<typeof createCliExtensionContext>);
    },
  };
}

function singleServiceTaskWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1" name="Start"/>',
      nativeServiceTask({
        id: "Task_Review",
        name: "Review item",
        documentation: "Review ${environment.variables.item}.",
        inputs: ["item"],
        outputs: ["result"],
      }),
      '    <endEvent id="End_1" name="Done"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Review" />',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_Review" targetRef="End_1" />',
    ].join("\n"),
  );
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
