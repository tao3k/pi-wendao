import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { runWorkflowInRenderer } from "../../src/cli/workflow-runner.js";
import type { ResolvedModel } from "../../src/cli/model-resolver.js";
import { readPositiveIntEnv, restoreEnv } from "../support/env.js";
import { loadResultWithTools, tool } from "../support/pi-tool-fixtures.js";
import {
  assertQianjiServerReady,
  controlEventFailureCode,
  controlEventFailureMessage,
  controlEventKind,
  loadQianjiServerControlHistory,
  resolveQianjiWorkflowServerSmokeUrl,
  startEphemeralQianjiWorkflowServer,
  type EphemeralQianjiWorkflowServer,
} from "../support/qianji-server-smoke.js";
import { singleServiceTaskWorkflow } from "../support/qianji-workflow-fixtures.js";
import { RecordingRenderer } from "../support/recording-renderer.js";

const qianjiServerRepoRoot = resolveQianjiServerRepoRoot();
const flowhubRoot = join(qianjiServerRepoRoot, "qianji-flowhub");
const tempDirs: string[] = [];
const ephemeralServers: EphemeralQianjiWorkflowServer[] = [];
const serverSmokeEnabled = process.env.RUN_PI_WENDAO_QIANJI_WORKFLOW_SERVER_SMOKE === "1";
const itServerSmoke = serverSmokeEnabled ? it : it.skip;
const serverSmokeTimeoutMs = readPositiveIntEnv(
  "PI_WENDAO_QIANJI_WORKFLOW_SERVER_SMOKE_TIMEOUT_MS",
  600_000,
);

describe("workflow runner qianji-server subagent smoke", () => {
  const originalRunStore = process.env.PI_WENDAO_SUBAGENTS_RUN_STORE;
  const originalWorkflowServerUrl = process.env.PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL;

  afterEach(async () => {
    restoreEnv("PI_WENDAO_SUBAGENTS_RUN_STORE", originalRunStore);
    restoreEnv("PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL", originalWorkflowServerUrl);
    await Promise.all(ephemeralServers.splice(0).map((server) => server.stop()));
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  itServerSmoke(
    "executes native subagent host work through a real qianji-server workflow route",
    async () => {
      const serverUrl = resolveQianjiWorkflowServerSmokeUrl();
      await assertQianjiServerReady(serverUrl, serverSmokeTimeoutMs, {
        buildTimeoutMs: serverSmokeTimeoutMs,
        qianjiServerRepoRoot,
      });
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

  itServerSmoke(
    "records failed native host work in a real qianji-server control ledger",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-wendao-qianji-server-failure-ledger-smoke-"));
      tempDirs.push(dir);
      const ledgerPath = join(dir, "qianji-control.duckdb");
      const server = await startEphemeralQianjiWorkflowServer({
        qianjiServerRepoRoot,
        flowhubRoot,
        runtimeDir: dir,
        controlLedgerPath: ledgerPath,
        startupTimeoutMs: serverSmokeTimeoutMs,
      });
      ephemeralServers.push(server);
      process.env.PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL = server.baseUrl;
      process.env.PI_WENDAO_SUBAGENTS_RUN_STORE = join(dir, "subagents-failure-ledger-smoke.json");

      const workflowPath = join(dir, "workflow-failure-ledger-smoke.bpmn");
      writeFileSync(workflowPath, singleServiceTaskWorkflow(), "utf-8");
      const instanceId = `wf_runner_native_subagents_real_server_fail_${Date.now()}`;
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
            contextJson: JSON.stringify({ item: "server" }),
            qianjiWorkflowServerUrl: server.baseUrl,
            startAtNode: "Task_Review",
            traceFrameMs: 0,
          },
          instanceId,
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

        expect(result.success).toBe(false);
        expect(renderer.logs.join("\n")).toContain("qianji control recovery: reported");
        expect(renderer.logs.join("\n")).toContain("action=review_retryable_activity");
        expect(renderer.graphView.getNodeDetails("Task_Review")).toContain(
          "recovery:total 1, retry 0, review 1, terminal 0",
        );
        expect(renderer.graphView.getNodeDetails("Task_Review")).toContainEqual(
          expect.stringContaining("recovery-action:review_retryable_activity"),
        );
        expect(renderer.logs.join("\n")).toContain("Execution failed: agent execution failed");
        expect(
          renderer.traceEvents
            .filter(
              (event): event is Extract<QianjiTraceLogEvent, { kind: "node_status" }> =>
                event.kind === "node_status" && event.node_id === "Task_Review",
            )
            .map((event) => event.status),
        ).toEqual(["executing", "failed"]);

        const history = await loadQianjiServerControlHistory({
          baseUrl: server.baseUrl,
          runId: `bpmn.workflow.${instanceId}`,
        });
        expect(history.map(controlEventKind)).toEqual([
          "run_created",
          "activity_scheduled",
          "activity_started",
          "activity_failed",
        ]);
        const failure = history.at(-1);
        expect(controlEventFailureCode(failure)).toBe("native_host_execution_failed");
        expect(controlEventFailureMessage(failure)).toBe("agent execution failed");
      } finally {
        faux.unregister();
      }
    },
    serverSmokeTimeoutMs + 180_000,
  );

  itServerSmoke(
    "applies explicit recovery through a real Valkey-capable qianji-server",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-wendao-qianji-server-recovery-apply-smoke-"));
      tempDirs.push(dir);
      const ledgerPath = join(dir, "qianji-control.duckdb");
      const server = await startEphemeralQianjiWorkflowServer({
        qianjiServerRepoRoot,
        flowhubRoot,
        runtimeDir: dir,
        controlLedgerPath: ledgerPath,
        qianjiServerFeatures: ["valkey"],
        startupTimeoutMs: serverSmokeTimeoutMs,
      });
      ephemeralServers.push(server);
      process.env.PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL = server.baseUrl;
      process.env.PI_WENDAO_SUBAGENTS_RUN_STORE = join(dir, "subagents-recovery-apply-smoke.json");

      const workflowPath = join(dir, "workflow-recovery-apply-smoke.bpmn");
      writeFileSync(workflowPath, singleServiceTaskWorkflow(), "utf-8");
      const instanceId = `wf_runner_native_subagents_real_server_apply_${Date.now()}`;
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
            contextJson: JSON.stringify({ item: "server" }),
            qianjiWorkflowServerUrl: server.baseUrl,
            qianjiControlApplyRecovery: true,
            startAtNode: "Task_Review",
            traceFrameMs: 0,
          },
          instanceId,
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

        expect(result.success).toBe(false);
        expect(renderer.logs.join("\n")).toContain("qianji control recovery apply: attempted");
        expect(renderer.logs.join("\n")).toContain("action=review_retryable_activity");
        expect(renderer.graphView.getNodeDetails("Task_Review")).toContain(
          "recovery:total 1, retry 0, review 1, terminal 0",
        );

        const history = await loadQianjiServerControlHistory({
          baseUrl: server.baseUrl,
          runId: `bpmn.workflow.${instanceId}`,
        });
        expect(history.map(controlEventKind)).toEqual([
          "run_created",
          "activity_scheduled",
          "activity_started",
          "activity_failed",
          "recovery_started",
        ]);
      } finally {
        faux.unregister();
      }
    },
    serverSmokeTimeoutMs + 240_000,
  );
});

function resolveQianjiServerRepoRoot(): string {
  const configured = process.env.XIUXIAN_ARTISAN_WORKSHOP_ROOT?.trim();
  if (configured) {
    if (existsSync(join(configured, "Cargo.toml"))) return configured;
    throw new Error(`XIUXIAN_ARTISAN_WORKSHOP_ROOT does not contain Cargo.toml: ${configured}`);
  }
  const cwd = process.cwd();
  if (existsSync(join(cwd, "Cargo.toml"))) return cwd;
  const parentWorkspace = join(cwd, "..", "..");
  if (existsSync(join(parentWorkspace, "Cargo.toml"))) return parentWorkspace;
  throw new Error(
    [
      `could not resolve qianji-server repo root from ${cwd}`,
      "Set XIUXIAN_ARTISAN_WORKSHOP_ROOT to the xiuxian-artisan-workshop repository root.",
    ].join("\n"),
  );
}
