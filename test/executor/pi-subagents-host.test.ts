import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInMemoryPiSubagentsRunStore,
  createJsonFilePiSubagentsRunStore,
  createPiSubagentsClientFromTools,
  createPiSubagentsHost,
  type PiSubagentsHostEvent,
  type PiSubagentsHostUpdateEvent,
  type PiSubagentsSpawnRequest,
} from "../../src/executor/pi-subagents-host.js";

const tempDirs: string[] = [];

describe("createPiSubagentsHost", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps pi-wendao service task metadata to a pi-subagents request", async () => {
    const spawns: PiSubagentsSpawnRequest[] = [];
    const host = createPiSubagentsHost({
      client: {
        async spawn(request) {
          spawns.push(request);
          return { agent_id: "agent-1" };
        },
        async getResult(request) {
          expect(request).toMatchObject({
            agent_id: "agent-1",
            wait: true,
          });
          return {
            result: 'Done.\n```json\n{"result":"alpha_done"}\n```',
          };
        },
      },
    });

    const output = await host.run({
      activityId: "Task_BranchA",
      variables: { item: "alpha", hidden: "not visible" },
      config: {
        prompt: "Review ${environment.variables.item}.",
        tools: ["bash"],
        inputs: ["item"],
        outputs: ["result"],
        subagent: {
          type: "pi-wendao-worker",
          description: "Run Branch A",
          runInBackground: true,
          maxTurns: 8,
          isolation: "worktree",
          inheritContext: false,
          thinking: "medium",
        },
      },
      execution: {
        processId: "Process_1",
        instanceId: "instance-1",
        tokenId: 11,
        checkpoint: {
          backend: "duckdb",
          source: "resumed",
          status: "loaded",
          pendingHostWork: "2",
        },
      },
    });

    expect(output).toEqual({ result: "alpha_done" });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      description: "Run Branch A",
      subagent_type: "pi-wendao-worker",
      run_in_background: true,
      max_turns: 8,
      isolation: "worktree",
      inherit_context: false,
      thinking: "medium",
    });
    expect(spawns[0]?.prompt).toContain('"alpha"');
    expect(spawns[0]?.prompt).toContain("Current qianji task inputs");
    expect(spawns[0]?.prompt).toContain("Qianji BPMN task identity");
    expect(spawns[0]?.prompt).toContain("processId: Process_1");
    expect(spawns[0]?.prompt).toContain("activityId: Task_BranchA");
    expect(spawns[0]?.prompt).not.toContain("checkpoint.backend");
    expect(spawns[0]?.prompt).not.toContain("checkpoint.source");
    expect(spawns[0]?.prompt).not.toContain("pendingHostWork");
    expect(spawns[0]?.prompt).not.toContain("duckdb");
    expect(spawns[0]?.prompt).not.toContain("resumed");
    expect(spawns[0]?.prompt).not.toContain("not visible");
  });

  it("emits host events and requests verbose results when observed", async () => {
    const events: PiSubagentsHostEvent[] = [];
    const updates: PiSubagentsHostUpdateEvent[] = [];
    let getResultRequest: unknown;
    const host = createPiSubagentsHost({
      onEvent: (event) => events.push(event),
      onUpdate: (event) => updates.push(event),
      client: {
        async spawn(_request, callbacks) {
          callbacks?.onUpdate?.({
            details: {
              activity: "running bash",
              toolUses: 1,
              turnCount: 1,
            },
          });
          return { agent_id: "agent-observed" };
        },
        async getResult(request) {
          getResultRequest = request;
          return [
            "Agent: agent-observed",
            "Type: Worker | Status: completed | Tool uses: 1 | Duration: 1s",
            "Description: Observe task",
            "",
            '```json\n{"ok":true}\n```',
            "",
            "--- Agent Conversation ---",
            "[Assistant]: Done.",
          ].join("\n");
        },
      },
    });

    await expect(
      host.run({
        activityId: "Task_Observed",
        variables: {},
        config: {
          prompt: "Run observed task.",
          tools: [],
          inputs: [],
          outputs: ["ok"],
        },
      }),
    ).resolves.toEqual({ ok: true });

    expect(getResultRequest).toMatchObject({
      agent_id: "agent-observed",
      wait: true,
      verbose: true,
    });
    expect(events.map((event) => event.type)).toEqual(["spawned", "waiting", "result"]);
    expect(events[2]).toMatchObject({
      type: "result",
      activityId: "Task_Observed",
      agentId: "agent-observed",
    });
    expect(updates).toEqual([
      {
        type: "update",
        activityId: "Task_Observed",
        description: "Run BPMN service task Task_Observed",
        update: {
          details: {
            activity: "running bash",
            toolUses: 1,
            turnCount: 1,
          },
        },
      },
    ]);
  });

  it("uses an output-only subagent when qianji declares no tools", async () => {
    let spawn: PiSubagentsSpawnRequest | undefined;
    const host = createPiSubagentsHost({
      client: {
        async spawn(request) {
          spawn = request;
          return "agent-2";
        },
        async getResult() {
          return '```json\n{"ok":true}\n```';
        },
      },
    });

    await host.run({
      activityId: "Task_Default",
      variables: {},
      config: {
        prompt: "Run default task.",
        tools: [],
        inputs: [],
        outputs: ["ok"],
      },
    });

    expect(spawn).toMatchObject({
      description: "Run BPMN service task Task_Default",
      subagent_type: "pi-wendao-output-only",
      run_in_background: true,
    });
  });

  it("uses a write-only subagent when qianji declares only write", async () => {
    let spawn: PiSubagentsSpawnRequest | undefined;
    const host = createPiSubagentsHost({
      client: {
        async spawn(request) {
          spawn = request;
          return "agent-write";
        },
        async getResult() {
          return '```json\n{"path":"artifact.md"}\n```';
        },
      },
    });

    await host.run({
      activityId: "Task_WriteArtifact",
      variables: {},
      config: {
        prompt: "Write an artifact.",
        tools: ["write"],
        inputs: [],
        outputs: ["path"],
      },
    });

    expect(spawn).toMatchObject({
      description: "Run BPMN service task Task_WriteArtifact",
      subagent_type: "pi-wendao-output-writer",
      run_in_background: true,
    });
  });

  it("lets empty qianji tools choose output-only even when a broad subagent type is present", async () => {
    let spawn: PiSubagentsSpawnRequest | undefined;
    const host = createPiSubagentsHost({
      client: {
        async spawn(request) {
          spawn = request;
          return "agent-broad-empty";
        },
        async getResult() {
          return '```json\n{"ok":true}\n```';
        },
      },
    });

    await host.run({
      activityId: "Task_BroadEmpty",
      variables: {},
      config: {
        prompt: "Return output only.",
        tools: [],
        inputs: [],
        outputs: ["ok"],
        subagent: {
          type: "pi-wendao-worker",
          description: "Broad worker",
        },
      },
    });

    expect(spawn).toMatchObject({
      description: "Broad worker",
      subagent_type: "pi-wendao-output-only",
      run_in_background: true,
    });
  });

  it("uses a readonly subagent when qianji declares only read tools", async () => {
    let spawn: PiSubagentsSpawnRequest | undefined;
    const host = createPiSubagentsHost({
      client: {
        async spawn(request) {
          spawn = request;
          return "agent-broad";
        },
        async getResult() {
          return '```json\n{"ok":true}\n```';
        },
      },
    });

    await host.run({
      activityId: "Task_Read",
      variables: {},
      config: {
        prompt: "Read context.",
        tools: ["read"],
        inputs: [],
        outputs: ["ok"],
      },
    });

    expect(spawn).toMatchObject({
      description: "Run BPMN service task Task_Read",
      subagent_type: "pi-wendao-readonly",
      run_in_background: true,
    });
  });

  it("keeps broad subagents for shell qianji tool scopes", async () => {
    let spawn: PiSubagentsSpawnRequest | undefined;
    const host = createPiSubagentsHost({
      client: {
        async spawn(request) {
          spawn = request;
          return "agent-broad";
        },
        async getResult() {
          return '```json\n{"ok":true}\n```';
        },
      },
    });

    await host.run({
      activityId: "Task_Shell",
      variables: {},
      config: {
        prompt: "Run command.",
        tools: ["bash"],
        inputs: [],
        outputs: ["ok"],
      },
    });

    expect(spawn).toMatchObject({
      description: "Run BPMN service task Task_Shell",
      subagent_type: "general-purpose",
      run_in_background: true,
    });
  });

  it("defines pi-wendao output profiles with explicit tool denylists", () => {
    const outputOnlyProfile = readFileSync(
      join(process.cwd(), ".pi", "agents", "pi-wendao-output-only.md"),
      "utf-8",
    );
    const outputWriterProfile = readFileSync(
      join(process.cwd(), ".pi", "agents", "pi-wendao-output-writer.md"),
      "utf-8",
    );
    const readOnlyProfile = readFileSync(
      join(process.cwd(), ".pi", "agents", "pi-wendao-readonly.md"),
      "utf-8",
    );

    expect(outputOnlyProfile).toContain("tools: none");
    expect(outputOnlyProfile).toContain(
      "disallowed_tools: read, bash, edit, write, grep, find, ls",
    );
    expect(outputOnlyProfile).toContain("extensions: false");
    expect(outputOnlyProfile).toContain("skills: false");

    expect(outputWriterProfile).toContain("tools: write");
    expect(outputWriterProfile).toContain("disallowed_tools: read, bash, edit, grep, find, ls");
    expect(outputWriterProfile).toContain("extensions: false");
    expect(outputWriterProfile).toContain("skills: false");

    expect(readOnlyProfile).toContain("tools: read, grep, find, ls");
    expect(readOnlyProfile).toContain("disallowed_tools: bash, edit, write");
    expect(readOnlyProfile).toContain("extensions: false");
    expect(readOnlyProfile).toContain("skills: false");
  });

  it("wraps pi-subagents tool functions as a client", async () => {
    const client = createPiSubagentsClientFromTools({
      async Agent() {
        return { agent_id: "agent-from-tool" };
      },
      async get_subagent_result(request) {
        return `agent=${request.agent_id}`;
      },
    });

    await expect(
      client.spawn({
        prompt: "Run",
        description: "Run task",
        subagent_type: "general-purpose",
        run_in_background: true,
      }),
    ).resolves.toEqual({ agent_id: "agent-from-tool" });
    await expect(
      client.getResult({
        agent_id: "agent-from-tool",
        wait: true,
      }),
    ).resolves.toBe("agent=agent-from-tool");
  });

  it("parses an agent id from a text tool result", async () => {
    const host = createPiSubagentsHost({
      client: {
        async spawn() {
          return "Agent started in background.\nAgent ID: agent-text\n";
        },
        async getResult(request) {
          expect(request.agent_id).toBe("agent-text");
          return '```json\n{"ok":true}\n```';
        },
      },
    });

    await expect(
      host.run({
        activityId: "Task_Text",
        variables: {},
        config: {
          prompt: "Run",
          tools: [],
          inputs: [],
          outputs: ["ok"],
        },
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("reuses a spawned subagent record after an interrupted wait", async () => {
    const runStore = createInMemoryPiSubagentsRunStore();
    let spawnCount = 0;
    const request = {
      activityId: "Task_BranchA",
      variables: {},
      config: {
        prompt: "Run branch A.",
        tools: [],
        inputs: [],
        outputs: ["result"],
      },
      execution: {
        instanceId: "instance-recover",
        tokenId: 41,
      },
    };

    const firstHost = createPiSubagentsHost({
      runStore,
      client: {
        async spawn() {
          spawnCount += 1;
          return "agent-recover";
        },
        async getResult() {
          throw new Error("interrupted wait");
        },
      },
    });
    await expect(firstHost.run(request)).rejects.toThrow("interrupted wait");

    const secondHost = createPiSubagentsHost({
      runStore,
      client: {
        async spawn() {
          throw new Error("must not spawn twice");
        },
        async getResult(resultRequest) {
          expect(resultRequest.agent_id).toBe("agent-recover");
          return '```json\n{"result":"resumed"}\n```';
        },
      },
    });

    await expect(secondHost.run(request)).resolves.toEqual({ result: "resumed" });
    expect(spawnCount).toBe(1);
  });

  it("interrupts an in-flight subagent result wait immediately", async () => {
    const runStore = createInMemoryPiSubagentsRunStore();
    const controller = new AbortController();
    let spawnCount = 0;
    let releaseResult: (() => void) | undefined;
    let getResultStarted: (() => void) | undefined;
    const resultPending = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const getResultStartedPromise = new Promise<void>((resolve) => {
      getResultStarted = resolve;
    });
    const request = {
      activityId: "Task_Interrupt",
      variables: {},
      signal: controller.signal,
      config: {
        prompt: "Run interruptible task.",
        tools: [],
        inputs: [],
        outputs: ["result"],
      },
      execution: {
        instanceId: "instance-interrupt",
        tokenId: 42,
      },
    };
    const host = createPiSubagentsHost({
      runStore,
      client: {
        async spawn() {
          spawnCount += 1;
          return "agent-interrupt";
        },
        async getResult() {
          getResultStarted?.();
          await resultPending;
          return '```json\n{"result":"late"}\n```';
        },
      },
    });

    const run = host.run(request);
    await getResultStartedPromise;
    expect(spawnCount).toBe(1);
    controller.abort();

    await expect(run).rejects.toMatchObject({ name: "WorkflowInterruptedError" });
    releaseResult?.();

    const resumedHost = createPiSubagentsHost({
      runStore,
      client: {
        async spawn() {
          throw new Error("interrupted run should have preserved the spawned agent");
        },
        async getResult(resultRequest) {
          expect(resultRequest.agent_id).toBe("agent-interrupt");
          return '```json\n{"result":"resumed"}\n```';
        },
      },
    });
    await expect(resumedHost.run({ ...request, signal: undefined })).resolves.toEqual({
      result: "resumed",
    });
  });

  it("persists completed subagent output in a JSON file store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-subagent-store-"));
    tempDirs.push(dir);
    const storePath = join(dir, "subagents.json");
    const request = {
      activityId: "Task_BranchB",
      variables: {},
      config: {
        prompt: "Run branch B.",
        tools: [],
        inputs: [],
        outputs: ["result"],
      },
      execution: {
        instanceId: "instance-json",
        tokenId: 42,
      },
    };

    const firstHost = createPiSubagentsHost({
      runStore: createJsonFilePiSubagentsRunStore(storePath),
      client: {
        async spawn() {
          return { agent_id: "agent-json" };
        },
        async getResult() {
          return '```json\n{"result":"cached"}\n```';
        },
      },
    });
    await expect(firstHost.run(request)).resolves.toEqual({ result: "cached" });

    let clientCalled = false;
    const secondHost = createPiSubagentsHost({
      runStore: createJsonFilePiSubagentsRunStore(storePath),
      client: {
        async spawn() {
          clientCalled = true;
          throw new Error("cached output should skip spawn");
        },
        async getResult() {
          clientCalled = true;
          throw new Error("cached output should skip result lookup");
        },
      },
    });

    await expect(secondHost.run(request)).resolves.toEqual({ result: "cached" });
    expect(clientCalled).toBe(false);
  });

  it("does not reuse cached output when qianji host inputs change", async () => {
    const runStore = createInMemoryPiSubagentsRunStore();
    let spawnCount = 0;
    const host = createPiSubagentsHost({
      runStore,
      client: {
        async spawn() {
          spawnCount += 1;
          return { agent_id: `agent-input-${spawnCount}` };
        },
        async getResult(request) {
          if (request.agent_id === "agent-input-1") {
            return '```json\n{"isRetryComplete":false}\n```';
          }
          return '```json\n{"isRetryComplete":true}\n```';
        },
      },
    });
    const baseRequest = {
      activityId: "Task_Check",
      config: {
        prompt: "Check retry count.",
        tools: [],
        inputs: ["retryCount"],
        outputs: ["isRetryComplete"],
      },
      execution: {
        instanceId: "instance-input-sensitive",
        tokenId: 61,
      },
    };

    await expect(
      host.run({
        ...baseRequest,
        variables: { retryCount: 1 },
      }),
    ).resolves.toEqual({ isRetryComplete: false });
    await expect(
      host.run({
        ...baseRequest,
        variables: { retryCount: 3 },
      }),
    ).resolves.toEqual({ isRetryComplete: true });
    expect(spawnCount).toBe(2);
  });

  it("reports pi-subagents runtime errors before completing host work", async () => {
    const runStore = createInMemoryPiSubagentsRunStore();
    const request = {
      activityId: "Task_Check",
      variables: {},
      config: {
        prompt: "Check retry count.",
        tools: [],
        inputs: [],
        outputs: ["isRetryComplete", "retryCount"],
      },
      execution: {
        instanceId: "instance-error",
        tokenId: 51,
      },
    };
    const host = createPiSubagentsHost({
      runStore,
      client: {
        async spawn() {
          return { agent_id: "agent-error" };
        },
        async getResult() {
          return [
            "Agent: agent-error",
            "Type: Agent | Status: error | Tool uses: 0 | 0 token | Duration: 0.0s",
            "Description: Check retry count",
            "",
            "Error: No API key found for anthropic.",
          ].join("\n");
        },
      },
    });

    await expect(host.run(request)).rejects.toThrow("No API key found for anthropic");
    await expect(runStore.get(runKeyFor(request))).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("No API key found for anthropic"),
    });
  });

  it("fails when a completed subagent omits declared outputs", async () => {
    const runStore = createInMemoryPiSubagentsRunStore();
    const request = {
      activityId: "Task_Check",
      variables: {},
      config: {
        prompt: "Check retry count.",
        tools: [],
        inputs: [],
        outputs: ["isRetryComplete", "retryCount"],
      },
      execution: {
        instanceId: "instance-missing-output",
        tokenId: 52,
      },
    };
    const host = createPiSubagentsHost({
      runStore,
      client: {
        async spawn() {
          return { agent_id: "agent-missing-output" };
        },
        async getResult() {
          return "Done, but without structured output.";
        },
      },
    });

    await expect(host.run(request)).rejects.toThrow(
      "did not produce required output(s) for Task_Check: isRetryComplete, retryCount",
    );
  });

  it("extracts declared outputs from raw JSON embedded in verbose agent results", async () => {
    const host = createPiSubagentsHost({
      client: {
        async spawn() {
          return { agent_id: "agent-raw-json" };
        },
        async getResult() {
          return [
            "Agent: agent-raw-json",
            "Type: Pi Wendao Output Only | Status: completed | Tool uses: 0",
            "Description: Run BPMN service task Task_Review",
            JSON.stringify(
              {
                appointmentRequest: "Morning appointment requested.",
                routingUrgency: "urgent",
                requiresClinicianReview: true,
                patientPreparationChecklist: ["bring records"],
                staffTriageSummary: "Route to urgent review.",
                finalAdministrativeSummary: "Administrative intake complete.",
              },
              null,
              2,
            ),
          ].join("\n");
        },
      },
    });

    await expect(
      host.run({
        activityId: "Task_Review",
        variables: {},
        config: {
          prompt: "Review intake.",
          tools: [],
          inputs: [],
          outputs: [
            "appointmentRequest",
            "routingUrgency",
            "requiresClinicianReview",
            "patientPreparationChecklist",
            "staffTriageSummary",
            "finalAdministrativeSummary",
          ],
        },
      }),
    ).resolves.toEqual({
      appointmentRequest: "Morning appointment requested.",
      routingUrgency: "urgent",
      requiresClinicianReview: true,
      patientPreparationChecklist: ["bring records"],
      staffTriageSummary: "Route to urgent review.",
      finalAdministrativeSummary: "Administrative intake complete.",
    });
  });

  it("ignores stale completed cache records missing required outputs", async () => {
    const cachedRequest = {
      activityId: "Task_Stale",
      variables: {},
      config: {
        prompt: "Run fresh.",
        tools: [],
        inputs: [],
        outputs: ["result"],
      },
      execution: {
        instanceId: "instance-stale",
        tokenId: 53,
      },
    };
    const key = runKeyFor(cachedRequest);
    const runStore = createInMemoryPiSubagentsRunStore([
      {
        key,
        agentId: "agent-stale",
        activityId: "Task_Stale",
        instanceId: "instance-stale",
        tokenId: 53,
        status: "completed",
        spawnRequest: {
          prompt: "Old prompt",
          description: "Old task",
          subagent_type: "general-purpose",
          run_in_background: true,
        },
        output: {},
        createdAt: "2026-04-24T00:00:00.000Z",
        updatedAt: "2026-04-24T00:00:00.000Z",
      },
    ]);
    let spawnCount = 0;
    const host = createPiSubagentsHost({
      runStore,
      client: {
        async spawn() {
          spawnCount += 1;
          return { agent_id: "agent-fresh" };
        },
        async getResult() {
          return {
            content: [{ type: "text", text: '```json\n{"result":"fresh"}\n```' }],
          };
        },
      },
    });

    await expect(host.run(cachedRequest)).resolves.toEqual({ result: "fresh" });
    expect(spawnCount).toBe(1);
  });

  it("does not cache completed output that violates qianji output schemas", async () => {
    const runStore = createInMemoryPiSubagentsRunStore();
    const request = {
      activityId: "Task_PrepareNextQuestion",
      variables: {},
      config: {
        prompt: "Prepare choices.",
        tools: [],
        inputs: [],
        outputs: ["currentChoices"],
        outputSchemas: {
          currentChoices: {
            kind: "choice_array",
            value: "required" as const,
            label: "optional" as const,
            description: "optional" as const,
          },
        },
      },
      execution: {
        instanceId: "instance-invalid-schema",
        tokenId: 61,
      },
    };
    const host = createPiSubagentsHost({
      runStore,
      client: {
        async spawn() {
          return { agent_id: "agent-invalid-schema" };
        },
        async getResult() {
          return [
            "Done.",
            "```json",
            JSON.stringify({
              currentChoices: {
                kind: "choice_array",
                value: [
                  {
                    value: "test_fixtures",
                    label: "BPMN fixture-based integration tests",
                  },
                ],
              },
            }),
            "```",
          ].join("\n");
        },
      },
    });

    await expect(host.run(request)).rejects.toThrow("[pi-wendao.runtime.invalid_dynamic_choices]");
    await expect(runStore.get(runKeyFor(request))).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("[pi-wendao.runtime.invalid_dynamic_choices]"),
    });
  });

  it("does not reuse completed cache records that violate qianji output schemas", async () => {
    const request = {
      activityId: "Task_PrepareNextQuestion",
      variables: {},
      config: {
        prompt: "Prepare choices.",
        tools: [],
        inputs: [],
        outputs: ["currentChoices"],
        outputSchemas: {
          currentChoices: {
            kind: "choice_array",
            value: "required" as const,
            label: "optional" as const,
            description: "optional" as const,
          },
        },
      },
      execution: {
        instanceId: "instance-invalid-cache",
        tokenId: 62,
      },
    };
    const runStore = createInMemoryPiSubagentsRunStore([
      {
        key: runKeyFor(request),
        agentId: "agent-stale-invalid",
        activityId: "Task_PrepareNextQuestion",
        instanceId: "instance-invalid-cache",
        tokenId: 62,
        status: "completed",
        spawnRequest: {
          prompt: "Old prompt",
          description: "Old task",
          subagent_type: "general-purpose",
          run_in_background: true,
        },
        output: {
          currentChoices: {
            kind: "choice_array",
            value: [
              {
                value: "test_fixtures",
                label: "BPMN fixture-based integration tests",
              },
            ],
          },
        },
        createdAt: "2026-04-24T00:00:00.000Z",
        updatedAt: "2026-04-24T00:00:00.000Z",
      },
    ]);
    let spawnCount = 0;
    const host = createPiSubagentsHost({
      runStore,
      client: {
        async spawn() {
          spawnCount += 1;
          return { agent_id: "agent-fresh-schema" };
        },
        async getResult() {
          return '```json\n{"currentChoices":[{"value":"test_fixtures","label":"BPMN fixture-based integration tests"}]}\n```';
        },
      },
    });

    await expect(host.run(request)).resolves.toEqual({
      currentChoices: [
        {
          value: "test_fixtures",
          label: "BPMN fixture-based integration tests",
        },
      ],
    });
    expect(spawnCount).toBe(1);
  });
});

function runKeyFor(request: {
  activityId: string;
  variables: Record<string, unknown>;
  config: {
    prompt: string;
    tools: string[];
    toolScopes?: unknown;
    inputs: string[];
    outputs: string[];
    outputSchemas?: unknown;
    subagent?: unknown;
  };
  execution?: {
    instanceId?: string;
    tokenId?: number;
  };
}): string {
  return JSON.stringify({
    instanceId: request.execution?.instanceId,
    activityId: request.activityId,
    tokenId: request.execution?.tokenId ?? null,
    contract: createHash("sha256")
      .update(
        stableJson({
          prompt: request.config.prompt,
          tools: request.config.tools,
          toolScopes: request.config.toolScopes ?? [],
          outputs: request.config.outputs,
          outputSchemas: request.config.outputSchemas ?? {},
          subagent: request.config.subagent ?? {},
        }),
      )
      .digest("hex")
      .slice(0, 16),
    inputs: buildRunInputSnapshot(request),
  });
}

function buildRunInputSnapshot(request: {
  variables: Record<string, unknown>;
  config: { inputs: string[] };
}): Array<[string, unknown]> {
  const inputNames =
    request.config.inputs.length > 0
      ? request.config.inputs
      : Object.keys(request.variables).sort();
  const seen = new Set<string>();
  const snapshot: Array<[string, unknown]> = [];
  for (const name of inputNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (Object.prototype.hasOwnProperty.call(request.variables, name)) {
      snapshot.push([name, request.variables[name]]);
    }
  }
  return snapshot;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
