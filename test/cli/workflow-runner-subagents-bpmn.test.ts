import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
import { resolveModel, type ResolvedModel } from "../../src/cli/model-resolver.js";
import { createCliExtensionContext } from "../../src/cli/pi-subagents.js";
import { runWorkflowInRenderer } from "../../src/cli/workflow-runner.js";
import type { PiRegisteredToolDefinition } from "../../src/executor/pi-subagents-runtime.js";
import type { PiWendaoAgentEvent } from "../../src/executor/agent-runtime-types.js";
import { GraphView } from "../../src/ui/graph-view.js";
import type { PlannerReplyRequest, QianjiTraceLogEvent, Renderer } from "../../src/ui/renderer.js";
import { nativeDefinitions, nativeServiceTask } from "../support/native-bpmn.js";

const tempDirs: string[] = [];
const liveEnabled =
  process.env.RUN_PI_WENDAO_WORKFLOW_SUBAGENT_BPMN_LIVE === "1" && hasLiveModelAuth();
const itLive = liveEnabled ? it : it.skip;

describe("workflow runner native subagent BPMN integration", () => {
  const originalRunStore = process.env.PI_WENDAO_SUBAGENTS_RUN_STORE;
  const originalWorkflowServerUrl = process.env.PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL;

  afterEach(() => {
    restoreEnv("PI_WENDAO_SUBAGENTS_RUN_STORE", originalRunStore);
    restoreEnv("PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL", originalWorkflowServerUrl);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("executes qianji BPMN host-session work through loaded native subagent tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-workflow-subagents-"));
    tempDirs.push(dir);
    process.env.PI_WENDAO_SUBAGENTS_RUN_STORE = join(dir, "subagents.json");
    const workflowPath = join(dir, "workflow.bpmn");
    writeFileSync(workflowPath, tokenScopedServiceTaskWorkflow(), "utf-8");

    const modelRegistry = ModelRegistry.create(AuthStorage.create());
    const faux = registerFauxProvider();
    const calls: Array<{
      name: string;
      item?: string;
      subagentType?: unknown;
      wait?: unknown;
      verbose?: unknown;
    }> = [];
    const prompts: string[] = [];
    const loadResult = loadResultWithTools({
      Agent: tool("Agent", async (params, ctx) => {
        expect(ctx.cwd).toBe(dir);
        expect(ctx.modelRegistry).toBe(modelRegistry);
        const prompt = String(params.prompt);
        prompts.push(prompt);
        const item = prompt.includes('item: "alpha"') ? "alpha" : "beta";
        calls.push({
          name: "Agent",
          item,
          subagentType: params.subagent_type,
        });
        return {
          content: [{ type: "text", text: `Agent ID: agent-${item}\n` }],
          details: { agentId: `agent-${item}` },
        };
      }),
      get_subagent_result: tool("get_subagent_result", async (params) => {
        const agentId = String(params.agent_id);
        const item = agentId.endsWith("alpha") ? "alpha" : "beta";
        calls.push({
          name: "get_subagent_result",
          item,
          wait: params.wait,
          verbose: params.verbose,
        });
        return {
          content: [
            {
              type: "text",
              text: `Done.\n\`\`\`json\n{"result":"${item}_done"}\n\`\`\``,
            },
          ],
        };
      }),
    });
    const renderer = new RecordingRenderer();

    try {
      const result = await runWorkflowInRenderer({
        renderer,
        useGraph: true,
        resolvedWorkflowPath: workflowPath,
        options: {
          qianji: makeFakeExternalHostQianjiCommand(),
          contextJson: JSON.stringify({ items: ["alpha", "beta"] }),
          startAtNode: "Task_Review",
          traceFrameMs: 0,
        },
        instanceId: "wf_runner_native_subagents",
        invocationCwd: dir,
        piContextCwd: dir,
        resolvedDmnPaths: [],
        thinkingLevel: "medium",
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
      expect(renderer.logs.join("\n")).toContain("Host backend: pi-subagents");
      expect(renderer.logs.join("\n")).toContain("parallel jobs Task_Review: 2 jobs tokens=11,12");
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("Qianji BPMN task identity");
      expect(prompts[0]).toContain("activityId: Task_Review");
      expect(prompts[0]).toContain("tokenId: 11");
      expect(prompts[1]).toContain("tokenId: 12");
      expect(calls).toEqual([
        { name: "Agent", item: "alpha", subagentType: "pi-wendao-output-only" },
        { name: "Agent", item: "beta", subagentType: "pi-wendao-output-only" },
        { name: "get_subagent_result", item: "alpha", wait: true, verbose: true },
        { name: "get_subagent_result", item: "beta", wait: true, verbose: true },
      ]);
      expect(renderer.variables).toMatchObject({
        results: ["alpha_done", "beta_done"],
        fixtureServiceTaskTokens: ["11", "12"],
      });
    } finally {
      faux.unregister();
    }
  });

  it("executes qianji-server workflow host work through loaded native subagent tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-workflow-server-subagents-"));
    tempDirs.push(dir);
    process.env.PI_WENDAO_SUBAGENTS_RUN_STORE = join(dir, "subagents-server.json");
    const workflowPath = join(dir, "workflow-server.bpmn");
    writeFileSync(workflowPath, tokenScopedServiceTaskWorkflow(), "utf-8");
    const server = await serveQianjiWorkflowServer(["alpha", "beta"]);
    process.env.PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL = server.url;

    const modelRegistry = ModelRegistry.create(AuthStorage.create());
    const faux = registerFauxProvider();
    const calls: Array<{ name: string; item?: string }> = [];
    const loadResult = loadResultWithTools({
      Agent: tool("Agent", async (params) => {
        const prompt = String(params.prompt);
        const item = prompt.includes('item: "alpha"') ? "alpha" : "beta";
        calls.push({ name: "Agent", item });
        return {
          content: [{ type: "text", text: `Agent ID: agent-${item}\n` }],
          details: { agentId: `agent-${item}` },
        };
      }),
      get_subagent_result: tool("get_subagent_result", async (params) => {
        const agentId = String(params.agent_id);
        const item = agentId.endsWith("alpha") ? "alpha" : "beta";
        calls.push({ name: "get_subagent_result", item });
        return {
          content: [
            {
              type: "text",
              text: `Done.\n\`\`\`json\n{"result":"${item}_done"}\n\`\`\``,
            },
          ],
        };
      }),
    });
    const renderer = new RecordingRenderer();

    try {
      const result = await runWorkflowInRenderer({
        renderer,
        useGraph: true,
        resolvedWorkflowPath: workflowPath,
        options: {
          qianji: makeFakeExternalHostQianjiCommand(),
          contextJson: JSON.stringify({ items: ["alpha", "beta"] }),
          startAtNode: "Task_Review",
          traceFrameMs: 0,
        },
        instanceId: "wf_runner_native_subagents_server",
        invocationCwd: dir,
        piContextCwd: dir,
        resolvedDmnPaths: [],
        thinkingLevel: "medium",
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
      expect(server.requests).toEqual([
        "POST /workflows/start",
        "POST /workflows/wf_runner_native_subagents_server/tasks/complete-batch",
      ]);
      expect(server.requestBodies[0]?.start_at_node_id).toBe("Task_Review");
      const completions = server.requestBodies[1]?.completions as
        | Array<Record<string, unknown>>
        | undefined;
      expect(completions?.map((completion) => completion.token_id)).toEqual([11, 12]);
      expect(
        renderer.traceEvents
          .filter(
            (event): event is Extract<QianjiTraceLogEvent, { kind: "node_status" }> =>
              event.kind === "node_status" && event.node_id === "Task_Review",
          )
          .map((event) => event.status),
      ).toEqual(["executing", "completed"]);
      expect(calls).toEqual([
        { name: "Agent", item: "alpha" },
        { name: "Agent", item: "beta" },
        { name: "get_subagent_result", item: "alpha" },
        { name: "get_subagent_result", item: "beta" },
      ]);
      expect(renderer.variables).toMatchObject({
        results: ["alpha_done", "beta_done"],
        fixtureServiceTaskTokens: ["11", "12"],
      });
    } finally {
      faux.unregister();
      await server.close();
    }
  });

  it("resumes qianji-server workflow checkpoints before starting fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-workflow-server-resume-"));
    tempDirs.push(dir);
    process.env.PI_WENDAO_SUBAGENTS_RUN_STORE = join(dir, "subagents-server-resume.json");
    const workflowPath = join(dir, "workflow-server-resume.bpmn");
    writeFileSync(workflowPath, tokenScopedServiceTaskWorkflow(), "utf-8");
    const server = await serveQianjiWorkflowServer(["alpha"], {
      resumeMode: "available",
    });
    process.env.PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL = server.url;

    const modelRegistry = ModelRegistry.create(AuthStorage.create());
    const faux = registerFauxProvider();
    const loadResult = loadResultWithTools({
      Agent: tool("Agent", async () => ({
        content: [{ type: "text", text: "Agent ID: agent-alpha\n" }],
        details: { agentId: "agent-alpha" },
      })),
      get_subagent_result: tool("get_subagent_result", async () => ({
        content: [
          {
            type: "text",
            text: 'Done.\n```json\n{"result":"alpha_done"}\n```',
          },
        ],
      })),
    });
    const renderer = new RecordingRenderer();

    try {
      const result = await runWorkflowInRenderer({
        renderer,
        useGraph: true,
        resolvedWorkflowPath: workflowPath,
        options: {
          qianji: makeFakeExternalHostQianjiCommand(),
          contextJson: JSON.stringify({ items: ["alpha"] }),
          traceFrameMs: 0,
        },
        instanceId: "wf_runner_native_subagents_server_resume",
        invocationCwd: dir,
        piContextCwd: dir,
        resolvedDmnPaths: [],
        thinkingLevel: "medium",
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
      expect(server.requests).toEqual([
        "POST /workflows/wf_runner_native_subagents_server_resume/resume",
        "POST /workflows/wf_runner_native_subagents_server_resume/tasks/complete",
      ]);
      expect(server.requestBodies[0]).toEqual({
        bpmn_path: workflowPath,
        dmn_paths: [],
      });
      expect(renderer.variables).toMatchObject({
        results: ["alpha_done"],
        fixtureServiceTaskTokens: ["11"],
      });
    } finally {
      faux.unregister();
      await server.close();
    }
  });

  it("starts qianji-server workflows directly when fresh-start admission is requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-workflow-server-fresh-start-"));
    tempDirs.push(dir);
    process.env.PI_WENDAO_SUBAGENTS_RUN_STORE = join(dir, "subagents-server-fresh-start.json");
    const workflowPath = join(dir, "workflow-server-fresh-start.bpmn");
    writeFileSync(workflowPath, tokenScopedServiceTaskWorkflow(), "utf-8");
    const server = await serveQianjiWorkflowServer(["alpha"]);
    process.env.PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL = server.url;

    const modelRegistry = ModelRegistry.create(AuthStorage.create());
    const faux = registerFauxProvider();
    const loadResult = loadResultWithTools({
      Agent: tool("Agent", async () => ({
        content: [{ type: "text", text: "Agent ID: agent-alpha\n" }],
        details: { agentId: "agent-alpha" },
      })),
      get_subagent_result: tool("get_subagent_result", async () => ({
        content: [
          {
            type: "text",
            text: 'Done.\n```json\n{"result":"alpha_done"}\n```',
          },
        ],
      })),
    });
    const renderer = new RecordingRenderer();

    try {
      const result = await runWorkflowInRenderer({
        renderer,
        useGraph: true,
        resolvedWorkflowPath: workflowPath,
        options: {
          qianji: makeFakeExternalHostQianjiCommand(),
          contextJson: JSON.stringify({ items: ["alpha"] }),
          qianjiWorkflowStartMode: "start",
          traceFrameMs: 0,
        },
        instanceId: "wf_runner_native_subagents_server_fresh_start",
        invocationCwd: dir,
        piContextCwd: dir,
        resolvedDmnPaths: [],
        thinkingLevel: "medium",
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
      expect(server.requests).toEqual([
        "POST /workflows/start",
        "POST /workflows/wf_runner_native_subagents_server_fresh_start/tasks/complete",
      ]);
      expect(server.requestBodies[0]).toMatchObject({
        bpmn_path: workflowPath,
        dmn_paths: [],
        process_id: "Process_1",
        instance_id: "wf_runner_native_subagents_server_fresh_start",
        initial_variables: { items: ["alpha"] },
      });
      expect(renderer.variables).toMatchObject({
        results: ["alpha_done"],
        fixtureServiceTaskTokens: ["11"],
      });
    } finally {
      faux.unregister();
      await server.close();
    }
  });

  it("marks qianji-server workflow host work failed when native subagent execution fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-workflow-server-subagents-fail-"));
    tempDirs.push(dir);
    process.env.PI_WENDAO_SUBAGENTS_RUN_STORE = join(dir, "subagents-server-fail.json");
    const workflowPath = join(dir, "workflow-server-fail.bpmn");
    writeFileSync(workflowPath, tokenScopedServiceTaskWorkflow(), "utf-8");
    const server = await serveQianjiWorkflowServer(["alpha"]);
    process.env.PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL = server.url;

    const modelRegistry = ModelRegistry.create(AuthStorage.create());
    const faux = registerFauxProvider();
    const loadResult = loadResultWithTools({
      Agent: tool("Agent", async () => {
        throw new Error("agent execution failed");
      }),
      get_subagent_result: tool("get_subagent_result", async () => {
        throw new Error("get_subagent_result should not run after Agent failure");
      }),
    });
    const renderer = new RecordingRenderer();

    try {
      const result = await runWorkflowInRenderer({
        renderer,
        useGraph: true,
        resolvedWorkflowPath: workflowPath,
        options: {
          qianji: makeFakeExternalHostQianjiCommand(),
          contextJson: JSON.stringify({ items: ["alpha"] }),
          traceFrameMs: 0,
        },
        instanceId: "wf_runner_native_subagents_server_fail",
        invocationCwd: dir,
        piContextCwd: dir,
        resolvedDmnPaths: [],
        thinkingLevel: "medium",
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

      expect(result.success).toBe(false);
      expect(renderer.logs.join("\n")).toContain(
        "qianji server workflow: blocked_on_host (checkpoint=runtime_valkey, source=qianji-server, saved=true, deleted=false, pending_host=1)",
      );
      expect(renderer.logs.join("\n")).toContain("Execution failed: agent execution failed");
      expect(server.requests).toEqual([
        "POST /workflows/wf_runner_native_subagents_server_fail/resume",
        "POST /workflows/start",
      ]);
      expect(
        renderer.traceEvents
          .filter(
            (event): event is Extract<QianjiTraceLogEvent, { kind: "node_status" }> =>
              event.kind === "node_status" && event.node_id === "Task_Review",
          )
          .map((event) => event.status),
      ).toEqual(["executing", "failed"]);
    } finally {
      faux.unregister();
      await server.close();
    }
  });

  itLive(
    "executes qianji BPMN host-session work through the live native subagent model",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-wendao-workflow-subagents-live-"));
      tempDirs.push(dir);
      process.env.PI_WENDAO_SUBAGENTS_RUN_STORE = join(dir, "subagents-live.json");
      const workflowPath = join(dir, "workflow-live.bpmn");
      writeFileSync(workflowPath, liveSingleOutputWorkflow(), "utf-8");
      const renderer = new RecordingRenderer();
      const modelPattern =
        process.env.PI_WENDAO_WORKFLOW_SUBAGENT_BPMN_LIVE_MODEL ??
        "anthropic/deepseek-v4-pro";
      const resolvedModel = await resolveModel(modelPattern);

      const result = await runWorkflowInRenderer({
        renderer,
        useGraph: false,
        resolvedWorkflowPath: workflowPath,
        options: {
          qianji: makeFakeExternalHostQianjiCommand(["live"]),
          contextJson: JSON.stringify({ items: ["live"] }),
          traceFrameMs: 0,
        },
        instanceId: "wf_runner_native_subagents_live",
        invocationCwd: dir,
        piContextCwd: dir,
        resolvedDmnPaths: [],
        thinkingLevel: "medium",
        resolvedModel,
      });

      expect(result.success).toBe(true);
      expect(renderer.logs.join("\n")).toContain("Host backend: pi-subagents");
      expect(renderer.variables).toMatchObject({
        results: ["live_done"],
        fixtureServiceTaskTokens: ["11"],
      });
    },
    180_000,
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

function makeFakeExternalHostQianjiCommand(items = ["alpha", "beta"]): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-workflow-subagents-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-host-session.cjs");
  writeFakeExternalHostQianjiScript(scriptPath, items);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function writeFakeExternalHostQianjiScript(scriptPath: string, items: string[]): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const items = ${JSON.stringify(items)};
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const emitResult = (commandLabel, outcome, variables, pendingHostWork, source = "resumed") => {
  const stdout = commandLabel + ": " + outcome + " (checkpoint=duckdb, source=" + source + ", saved=yes, deleted=no, pending_host=" + pendingHostWork + ")";
  console.log("@@QIANJI_SESSION_RESULT " + JSON.stringify({
    exitCode: 0,
    stdout,
    stderr: "",
    outcome,
    checkpoint: { backend: "duckdb", source, saved: "yes", deleted: "no", status: "saved" },
    pendingHostWork,
    variables,
  }));
};
if (args[0] === "lint") {
  console.log("[ok] lint passed");
  process.exit(0);
}
if (args[0] !== "bpmn" || args[1] !== "host-session") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
const processId = get("--process") || "Process_1";
const context = JSON.parse(get("--context-json") || "{}");
console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", process_id: processId, node_id: "Task_Review", node_kind: "service_task", status: "executing" }));
for (const [index, item] of items.entries()) {
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    process_id: processId,
    node_id: "Task_Review",
    node_index: 2,
    token_id: 11 + index,
    variables: { item },
    repeat: { kind: "parallel_multi_instance", item, index, total: items.length }
  }));
}
emitResult("qianji run", "blocked_on_host", { items: context.items || [] }, items.length, "fresh");
const completed = {};
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "stop") {
    process.exit(0);
  }
  if (request.type !== "task_complete") {
    emitResult("qianji task complete", "failed", { error: "unexpected request" }, 0);
    return;
  }
  completed[String(request.token_id)] = request.data.result;
  const tokenIds = Object.keys(completed).sort((a, b) => Number(a) - Number(b));
  if (tokenIds.length < items.length) {
    emitResult("qianji task complete", "blocked_on_host", { partialResults: tokenIds.map((id) => completed[id]) }, items.length - tokenIds.length);
    return;
  }
  console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", process_id: processId, node_id: "Task_Review", node_kind: "service_task", status: "completed" }));
  emitResult("qianji task complete", "completed", {
    results: tokenIds.map((id) => completed[id]),
    fixtureServiceTaskTokens: tokenIds
  }, 0);
});
`,
    "utf-8",
  );
}

function liveSingleOutputWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1" name="Start"/>',
      nativeServiceTask({
        id: "Task_Review",
        name: "Live native subagent gate",
        documentation:
          'Return only a fenced JSON object with exactly this payload: {"result":"live_done"}.',
        inputs: ["item"],
        outputs: ["result"],
      }),
      '    <endEvent id="End_1" name="Done"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Review" />',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_Review" targetRef="End_1" />',
    ].join("\n"),
  );
}

function tokenScopedServiceTaskWorkflow(): string {
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

type QianjiWorkflowServerResumeMode = "checkpoint_missing" | "available";

async function serveQianjiWorkflowServer(
  items: string[],
  options: { resumeMode?: QianjiWorkflowServerResumeMode } = {},
): Promise<{
  url: string;
  requests: string[];
  requestBodies: Record<string, unknown>[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const requestBodies: Record<string, unknown>[] = [];
  const completed = new Map<string, string>();
  const server = createServer(async (request, response) => {
    try {
      requests.push(`${request.method} ${request.url}`);
      const body = (await readJsonBody(request)) as Record<string, unknown>;
      requestBodies.push(body);
      if (request.method === "POST" && request.url === "/workflows/start") {
        writeJson(response, workflowResponse(body, items, completed));
        return;
      }
      if (
        request.method === "POST" &&
        request.url?.startsWith("/workflows/") &&
        request.url.endsWith("/resume")
      ) {
        if ((options.resumeMode ?? "checkpoint_missing") === "checkpoint_missing") {
          response.statusCode = 404;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              code: "checkpoint_missing",
              message: "workflow checkpoint is missing",
            }),
          );
          return;
        }
        writeJson(response, workflowResponse(body, items, completed, true));
        return;
      }
      if (
        request.method === "POST" &&
        request.url?.startsWith("/workflows/") &&
        request.url.endsWith("/tasks/complete-batch")
      ) {
        const completions = body.completions as Array<Record<string, unknown>>;
        for (const completion of completions) {
          completed.set(String(completion.token_id), readCompletionResult(completion.data));
        }
        writeJson(response, workflowResponse(body, items, completed));
        return;
      }
      if (
        request.method === "POST" &&
        request.url?.startsWith("/workflows/") &&
        request.url.endsWith("/tasks/complete")
      ) {
        const completion = body.completion as Record<string, unknown>;
        completed.set(String(completion.token_id), readCompletionResult(completion.data));
        writeJson(response, workflowResponse(body, items, completed));
        return;
      }
      response.statusCode = 404;
      response.end("not found");
    } catch (error) {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server should listen on TCP");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    requestBodies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function workflowResponse(
  body: Record<string, unknown>,
  items: string[],
  completed: Map<string, string>,
  resumedFromCheckpoint = false,
): Record<string, unknown> {
  const processId = String(body.process_id ?? "Process_1");
  const allDone = completed.size >= items.length;
  const pending = items
    .map((item, index) => ({ item, index, tokenId: 11 + index }))
    .filter(({ tokenId }) => !completed.has(String(tokenId)));
  return {
    outcome: allDone ? "completed" : "blocked_on_host",
    resumed_from_checkpoint: resumedFromCheckpoint,
    checkpoint_saved: true,
    checkpoint_deleted: allDone,
    checkpoint_backend: "runtime_valkey",
    workflow: {
      variables: allDone
        ? {
            results: [...completed.entries()]
              .sort(([left], [right]) => Number(left) - Number(right))
              .map(([, result]) => result),
            fixtureServiceTaskTokens: [...completed.keys()].sort(
              (left, right) => Number(left) - Number(right),
            ),
          }
        : { items },
      pending_host_work_count: pending.length,
      pending_host_work: pending.map(({ item, index, tokenId }) => ({
        kind: "service",
        process_id: processId,
        activity_id: "Task_Review",
        node_id: "Task_Review",
        node_index: 2,
        token_id: tokenId,
        variables: {},
        inputs: { item },
        repeat: {
          kind: "parallel_multi_instance",
          iteration_index: index,
          total_iterations: items.length,
        },
      })),
    },
  };
}

function readCompletionResult(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("completion data must be an object");
  }
  const result = (data as Record<string, unknown>).result;
  if (typeof result !== "string") {
    throw new Error("completion data result must be a string");
  }
  return result;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  return text ? JSON.parse(text) : {};
}

function writeJson(response: ServerResponse, value: unknown): void {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function hasLiveModelAuth(): boolean {
  return [
    "DEEPSEEK_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "OPENROUTER_API_KEY",
    "OPENROUTE_API_KEY",
    "WENDAO_OPENROUTER_API_KEY",
  ].some((name) => Boolean(process.env[name]?.trim()));
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
