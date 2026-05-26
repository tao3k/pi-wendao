import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type Context } from "@earendil-works/pi-ai";
import {
  execute,
  mapHumanTaskReplyToOutputs,
  resolveTraceFrameDelayMs,
  type QianjiHostWorkEvent,
} from "../../src/executor/executor.js";
import type { PiWendaoAgentHost } from "../../src/executor/agent-host.js";
import { buildPiWendaoConfigMap } from "../../src/executor/bpmn-config.js";
import { buildQianjiArgs, QianjiHostSession, runQianjiCli } from "../../src/executor/qianji-cli.js";
import { GraphView } from "../../src/ui/graph-view.js";
import {
  nativeDefinitions,
  nativeHumanTask,
  nativeServiceTask,
} from "../support/native-bpmn.js";

const fixturesDir = join(import.meta.dirname, "../fixtures");
const tempDirs: string[] = [];

describe("executor", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses native service-task documentation and IO metadata", () => {
    const source = nativeDefinitions(
      "Process_1",
      nativeServiceTask({
        id: "Task_Run",
        documentation: "Run npm test.",
        outputs: ["ok"],
      }),
    );

    const config = buildPiWendaoConfigMap(source, "Process_1").get("Task_Run");

    expect(config).toMatchObject({
      prompt: "Run npm test.",
      inputs: [],
      outputs: ["ok"],
      tools: [],
    });
  });

  it("executes a workflow through qianji CLI", async () => {
    const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
    const outputChunks: string[] = [];

    const result = await execute({
      source,
      qianjiCommand: makeFakeQianjiCommand(),
      instanceId: "wf_test",
      variables: ["myKey=myValue", "count=42"],
      onCliOutput: (output) => outputChunks.push(output),
    });

    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({
      myKey: "myValue",
      count: "42",
      process: "Process_1",
      instance: "wf_test",
      bpmnSeen: true,
      hostFixtureSeen: false,
      fixtureServiceTasks: [],
    });
    expect(outputChunks.join("\n")).toContain("# BPMN Run");
  });

  it("returns an interrupted result when execution is aborted before qianji starts", async () => {
    const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
    const controller = new AbortController();
    controller.abort();

    const result = await execute({
      source,
      qianjiCommand: makeFakeQianjiCommand(),
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      success: false,
      interrupted: true,
    });
  });

  it("interrupts a running qianji CLI process", async () => {
    const controller = new AbortController();
    const run = runQianjiCli({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      cwd: process.cwd(),
      onTraceEvent: () => undefined,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 25);

    await expect(run).rejects.toMatchObject({ name: "WorkflowInterruptedError" });
  });

  it("ignores broken pipe errors while closing a finished host-session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-closed-stdin-"));
    tempDirs.push(dir);
    const scriptPath = join(dir, "fake-qianji-closed-stdin.cjs");
    writeFileSync(
      scriptPath,
      `const result = { exitCode: 0, stdout: "", stderr: "", pendingHostWork: 0, variables: {} };
console.log("@@QIANJI_SESSION_RESULT " + JSON.stringify(result));
process.stdin.destroy();
setTimeout(() => {}, 200);
`,
    );
    const session = new QianjiHostSession(process.execPath, [scriptPath], process.cwd(), () => {
      return undefined;
    });

    await expect(session.initial).resolves.toMatchObject({ exitCode: 0 });
    expect(() => session.close()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 25));
    session.terminate();
  });

  it("passes explicit process and context to qianji", async () => {
    const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");

    const result = await execute({
      source,
      qianjiCommand: makeFakeQianjiCommand(),
      processId: "Explicit_Process",
      context: { same: "context", extra: true },
      variables: ["same=var"],
    });

    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({
      process: "Explicit_Process",
      same: "context",
      extra: true,
    });
  });

  it("builds qianji start-at args for direct node entry", () => {
    expect(
      buildQianjiArgs({
        sourcePath: "/tmp/workflow.bpmn",
        processId: "Process_1",
        instanceId: "wf_start_at",
        context: { currentQuestion: "Ready?" },
        dmnPaths: ["/tmp/decision.dmn"],
        traceStream: true,
        externalHost: true,
        startAtNode: "Task_Question",
      }),
    ).toEqual([
      "bpmn",
      "start-at",
      "--bpmn",
      "/tmp/workflow.bpmn",
      "--process",
      "Process_1",
      "--instance-id",
      "wf_start_at",
      "--context-json",
      '{"currentQuestion":"Ready?"}',
      "--node",
      "Task_Question",
      "--dmn",
      "/tmp/decision.dmn",
      "--trace-stream",
      "--external-host",
    ]);
  });

  it("populates the graph view and applies qianji execution trace", async () => {
    const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
    const graphView = new GraphView();
    let graphReadyCount = 0;
    let graphUpdateCount = 0;
    const started: string[] = [];
    const ended: string[] = [];
    const flows: string[] = [];

    const result = await execute({
      source,
      qianjiCommand: makeFakeQianjiCommand(),
      graphView,
      traceFrameDelayMs: 0,
      onGraphReady: () => {
        graphReadyCount += 1;
      },
      onGraphUpdate: () => {
        graphUpdateCount += 1;
      },
      onActivityStart: (activityId) => started.push(activityId),
      onActivityEnd: (activityId) => ended.push(activityId),
      onFlowTake: (flowId) => flows.push(flowId),
    });

    expect(result.success).toBe(true);
    expect(result.rawOutput).not.toContain("@@QIANJI_TRACE");
    expect(graphReadyCount).toBe(1);
    expect(graphUpdateCount).toBeGreaterThan(0);
    expect(started).toContain("Task_1");
    expect(ended).toContain("Task_1");
    expect(flows).toEqual(["Start_1->Task_1", "Task_1->End_1"]);
    const internals = graphView as unknown as {
      nodes: Map<string, { status: string }>;
      edges: Array<{ source: string; target: string; taken: boolean }>;
    };
    expect(internals.nodes.get("Task_1")?.status).toBe("done");
    expect(
      internals.edges.find((edge) => edge.source === "Start_1" && edge.target === "Task_1")?.taken,
    ).toBe(true);
    expect(
      internals.edges.find((edge) => edge.source === "Task_1" && edge.target === "End_1")?.taken,
    ).toBe(true);
    const plainGraph = graphView
      .render(80)
      .join("\n")
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(plainGraph).toContain("( )");
    expect(plainGraph).toContain("List files");
    expect(plainGraph).toContain("(*)");
  });

  it("hydrates the graph view from qianji status for an explicit instance", async () => {
    const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
    const graphView = new GraphView();
    let graphUpdateCount = 0;

    const result = await execute({
      source,
      qianjiCommand: makeFakeQianjiGraphSnapshotCommand(),
      instanceId: "wf_resume",
      graphView,
      traceFrameDelayMs: 0,
      onGraphUpdate: () => {
        graphUpdateCount += 1;
      },
    });

    expect(result.success).toBe(true);
    expect(graphUpdateCount).toBeGreaterThan(0);
    const internals = graphView as unknown as {
      nodes: Map<string, { status: string }>;
    };
    expect(internals.nodes.get("Start_1")?.status).toBe("done");
    expect(internals.nodes.get("Task_1")?.status).toBe("active");
    expect(internals.nodes.get("End_1")?.status).toBe("pending");
  });

  it("paces streamed graph updates before final CLI output", async () => {
    const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
    const graphView = new GraphView();
    const updateTimes: number[] = [];
    let cliOutputSeen = false;

    const result = await execute({
      source,
      qianjiCommand: makeFakeQianjiCommand(),
      graphView,
      traceFrameDelayMs: 5,
      onGraphUpdate: () => {
        updateTimes.push(performance.now());
        expect(cliOutputSeen).toBe(false);
      },
      onCliOutput: () => {
        cliOutputSeen = true;
      },
    });

    expect(result.success).toBe(true);
    expect(updateTimes.length).toBeGreaterThan(1);
    expect(updateTimes[updateTimes.length - 1] - updateTimes[0]).toBeGreaterThanOrEqual(10);
    expect(cliOutputSeen).toBe(true);
  });

  it("does not pace graph trace updates by default", () => {
    const original = process.env.PI_WENDAO_TRACE_FRAME_MS;
    try {
      delete process.env.PI_WENDAO_TRACE_FRAME_MS;
      expect(resolveTraceFrameDelayMs({ graphView: new GraphView() })).toBe(0);
      expect(resolveTraceFrameDelayMs({})).toBe(0);
    } finally {
      restoreEnv("PI_WENDAO_TRACE_FRAME_MS", original);
    }
  });

  it("allows explicit graph trace pacing", () => {
    const original = process.env.PI_WENDAO_TRACE_FRAME_MS;
    try {
      process.env.PI_WENDAO_TRACE_FRAME_MS = "7";
      expect(resolveTraceFrameDelayMs({ graphView: new GraphView() })).toBe(7);
      expect(resolveTraceFrameDelayMs({ graphView: new GraphView(), traceFrameDelayMs: 5 })).toBe(
        5,
      );
    } finally {
      restoreEnv("PI_WENDAO_TRACE_FRAME_MS", original);
    }
  });

  it("resolves qianji from PATH by default", async () => {
    const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
    const originalPath = process.env.PATH;
    const originalQianjiCli = process.env.QIANJI_CLI;
    const binDir = makeFakeQianjiPathDir();

    try {
      delete process.env.QIANJI_CLI;
      process.env.PATH = [binDir, originalPath].filter(Boolean).join(delimiter);

      const result = await execute({
        source,
        cwd: binDir,
        instanceId: "wf_path",
      });

      expect(result.success).toBe(true);
      expect(result.variables).toMatchObject({
        process: "Process_1",
        instance: "wf_path",
        bpmnSeen: true,
      });
    } finally {
      restoreEnv("PATH", originalPath);
      restoreEnv("QIANJI_CLI", originalQianjiCli);
    }
  });

  it("resolves token-scoped qianji host work with real agent services", async () => {
    const faux = registerFauxProvider();
    const prompts: string[] = [];
    const starts: Record<string, number> = {};
    const delayedResponse = async (context: Context) => {
      const item = context.systemPrompt.includes('item: "alpha"') ? "alpha" : "beta";
      starts[item] = performance.now();
      prompts.push(context.systemPrompt);
      await delay(80);
      return fauxAssistantMessage(`Done.\n\`\`\`json\n{"result":"${item}_done"}\n\`\`\``);
    };
    faux.setResponses([delayedResponse, delayedResponse]);

    try {
      const result = await execute({
        source: tokenScopedServiceTaskWorkflow(),
        qianjiCommand: makeFakeExternalHostQianjiCommand(),
        instanceId: "wf_token_host",
        context: { items: ["alpha", "beta"] },
        model: faux.getModel(),
        apiKey: "test-key",
      });

      expect(result.success).toBe(true);
      expect(result.rawOutput).not.toContain("@@QIANJI_HOST_WORK");
      expect(prompts[0]).toContain('item: "alpha"');
      expect(prompts[1]).toContain('item: "beta"');
      expect(prompts[0]).toContain("Current qianji task inputs");
      expect(prompts[0]).toContain("Qianji BPMN task identity");
      expect(prompts[0]).toContain("processId: Process_1");
      expect(prompts[0]).toContain("activityId: Task_Review");
      expect(prompts[0]).toContain("tokenId: 11");
      expect(prompts[0]).not.toContain("instanceId: wf_token_host");
      expect(prompts[0]).not.toContain("checkpoint.backend");
      expect(prompts[0]).not.toContain("checkpoint.source");
      expect(prompts[0]).not.toContain("checkpoint.pendingHostWork");
      expect(prompts[0]).not.toContain("blocked_on_host");
      expect(Math.abs(starts.beta - starts.alpha)).toBeLessThan(60);
      expect(result.variables).toMatchObject({
        results: ["alpha_done", "beta_done"],
        fixtureServiceTaskTokens: ["11", "12"],
      });
    } finally {
      faux.unregister();
    }
  });

  it("dispatches token-scoped qianji host work through an injected host in parallel", async () => {
    const starts: Record<string, number> = {};
    const executions: Array<{
      activityId: string;
      tokenId?: number;
      item: unknown;
      subagentType?: string;
    }> = [];
    const hostWorkEvents: QianjiHostWorkEvent[] = [];
    const graphView = new GraphView();
    const agentHost: PiWendaoAgentHost = {
      async run(request) {
        const item = request.variables.item as string;
        starts[item] = performance.now();
        executions.push({
          activityId: request.activityId,
          tokenId: request.execution?.tokenId,
          item,
          subagentType: request.config.subagent?.type,
        });
        await delay(80);
        return { result: `${item}_done` };
      },
    };

    const result = await execute({
      source: tokenScopedServiceTaskWorkflow(),
      qianjiCommand: makeFakeExternalHostQianjiCommand(),
      instanceId: "wf_token_injected_host",
      context: { items: ["alpha", "beta"] },
      agentHost,
      hostBackend: "pi-subagents",
      graphView,
      onHostWork: (event) => hostWorkEvents.push(event),
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(Math.abs(starts.beta - starts.alpha)).toBeLessThan(60);
    expect(executions).toEqual([
      { activityId: "Task_Review", tokenId: 11, item: "alpha", subagentType: undefined },
      { activityId: "Task_Review", tokenId: 12, item: "beta", subagentType: undefined },
    ]);
    expect(result.variables).toMatchObject({
      results: ["alpha_done", "beta_done"],
      fixtureServiceTaskTokens: ["11", "12"],
    });
    const internals = graphView as unknown as {
      nodes: Map<string, { details?: string[] }>;
    };
    expect(internals.nodes.get("Task_Review")?.details).toEqual([
      "host:2 pi-subagents",
      "parallel:2 jobs tokens=11,12",
      "checkpoint:duckdb/fresh/saved",
    ]);
    expect(hostWorkEvents).toEqual([
      {
        activityId: "Task_Review",
        hostWorkCount: 2,
        batchHostWorkCount: 2,
        tokenIds: [11, 12],
        hostKinds: ["service"],
        parallel: true,
        repeatKinds: ["parallel_multi_instance"],
        repeatSummaries: ["parallel_multi_instance 1/2", "parallel_multi_instance 2/2"],
      },
    ]);
  });

  it("routes qianji userTask host work through the human task handler", async () => {
    const prompts: string[] = [];
    const graphView = new GraphView();

    const result = await execute({
      source: humanApprovalWorkflow(),
      qianjiCommand: makeFakeUserTaskExternalHostQianjiCommand(),
      instanceId: "wf_human_approval",
      humanTaskHandler: async (request) => {
        prompts.push(request.config.interaction?.question ?? request.config.prompt);
        expect(request.config.interaction).toEqual({
          type: "choice_input",
          question: "How should the workflow proceed?",
          choices: [
            { value: "approved", label: "Approve" },
            { value: "rejected", label: "Reject" },
          ],
          result: { output: "approved" },
        });
        return "y";
      },
      graphView,
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(prompts).toEqual(["How should the workflow proceed?"]);
    expect(result.rawOutput).not.toContain("@@QIANJI_HOST_WORK");
    expect(result.variables).toMatchObject({
      approved: "y",
      fixtureUserTasks: ["Task_Approve"],
    });
    const internals = graphView as unknown as {
      nodes: Map<string, { details?: string[] }>;
    };
    expect(internals.nodes.get("Task_Approve")?.details).toContain("host:user:1 human");
  });

  it("rejects streamed userTask host work without native form metadata", async () => {
    const result = await execute({
      source: humanApprovalWorkflow(),
      qianjiCommand: makeFakeMissingFormUserTaskQianjiCommand(),
      instanceId: "wf_missing_human_form",
      humanTaskHandler: async () => "approved",
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("[pi-wendao.runtime.missing_native_human_task_form]");
    expect(result.error).toContain("did not include native host-work form metadata");
    expect(result.error).toContain("no longer infers human-task interaction metadata");
  });

  it("rejects streamed userTask host work without native result_output", async () => {
    const result = await execute({
      source: humanApprovalWorkflow(),
      qianjiCommand: makeFakeMissingResultOutputUserTaskQianjiCommand(),
      instanceId: "wf_missing_human_result_output",
      humanTaskHandler: async () => "approved",
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("[pi-wendao.runtime.missing_native_answer_output]");
    expect(result.error).toContain("did not include native form result_output");
    expect(result.error).toContain("pi-wendao does not infer outputs from local XML");
  });

  it("uses streamed qianji human-task form and claim identity for typed completion", async () => {
    const interactions: unknown[] = [];
    const assignments: unknown[] = [];
    const claims: unknown[] = [];
    const hostWorkEvents: QianjiHostWorkEvent[] = [];
    const graphView = new GraphView();

    const result = await execute({
      source: rustSourcedHumanTaskWorkflow(),
      qianjiCommand: makeFakeRustFormHumanTaskQianjiCommand(),
      instanceId: "wf_rust_sourced_human_task",
      humanTaskHandler: async (request) => {
        expect(request.activityId).toBe("Task_RustApprove");
        expect(request.execution).toMatchObject({
          processId: "Rust_Process",
          activityId: "Task_RustApprove",
          tokenId: 91,
        });
        expect(request.config.outputs).toEqual(["rustAnswer"]);
        expect(request.config.interaction).toEqual({
          type: "choice_input",
          question: "Rust-sourced question?",
          choices: [
            { value: "direct", label: "Use direct path" },
            { value: "research", label: "Research first" },
          ],
          result: { output: "rustAnswer" },
        });
        expect(request.assignment).toEqual({
          human_performers: [
            {
              name: "reviewer",
              assignment_expression: "users.alice",
            },
          ],
          potential_owners: [
            {
              name: "review_team",
              resource_ref: "reviewers",
            },
          ],
        });
        expect(request.claim).toEqual({ claimant: "alice", claimed_at_ms: 123 });
        interactions.push(request.config.interaction);
        assignments.push(request.assignment);
        claims.push(request.claim);
        return "direct";
      },
      graphView,
      onHostWork: (event) => hostWorkEvents.push(event),
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(interactions).toHaveLength(1);
    expect(assignments).toHaveLength(1);
    expect(claims).toHaveLength(1);
    expect(hostWorkEvents).toEqual([
      {
        activityId: "Task_RustApprove",
        hostWorkCount: 1,
        batchHostWorkCount: 1,
        tokenIds: [91],
        hostKinds: ["user"],
        parallel: false,
        repeatKinds: [],
        repeatSummaries: [],
        assignmentSummaries: [
          "human_performer:reviewer:expr=users.alice;potential_owner:review_team:ref=reviewers",
        ],
      },
    ]);
    expect(result.variables).toMatchObject({
      rustAnswer: "direct",
      typedProcess: "Rust_Process",
      typedActivity: "Task_RustApprove",
      claimant: "alice",
    });
    const internals = graphView as unknown as {
      nodes: Map<string, { details?: string[] }>;
    };
    expect(internals.nodes.get("Task_RustApprove")?.details).toContain(
      "assignment:human_performer:reviewer:expr=users.alice;potential_owner:review_team:ref=reviewers",
    );
  });

  it("does not synthesize assignment or claim metadata when qianji host-work omits them", async () => {
    const humanRequests: unknown[] = [];

    const result = await execute({
      source: manualCheckpointWorkflow(),
      qianjiCommand: makeFakeManualTaskExternalHostQianjiCommand(),
      instanceId: "wf_manual_checkpoint_no_metadata_fallback",
      humanTaskHandler: async (request) => {
        humanRequests.push({
          assignment: request.assignment,
          claim: request.claim,
          interaction: request.config.interaction,
          outputs: request.config.outputs,
        });
        return "Operator acknowledged checkpoint";
      },
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(humanRequests).toEqual([
      {
        assignment: undefined,
        claim: undefined,
        interaction: {
          type: "input",
          question: "Complete the manual checkpoint before continuing.",
          freeText: {
            name: "manualNote",
            optional: false,
          },
          result: { output: "manualNote" },
        },
        outputs: ["manualNote"],
      },
    ]);
    expect(result.variables).toMatchObject({
      manualNote: "Operator acknowledged checkpoint",
      fixtureManualTasks: ["Task_ManualCheckpoint"],
    });
    expect(result.variables).not.toHaveProperty("claimant");
  });

  it("uses qianji host-session for external host completions", async () => {
    const prompts: string[] = [];

    const result = await execute({
      source: humanApprovalWorkflow(),
      qianjiCommand: makeFakeHostSessionQianjiCommand(),
      instanceId: "wf_human_approval_session",
      humanTaskHandler: async (request) => {
        prompts.push(request.activityId);
        expect(request.execution?.processId).toBe("Session_Process");
        return "approved";
      },
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(prompts).toEqual(["Task_Approve"]);
    expect(result.variables).toMatchObject({
      sessionMode: "host-session",
      receivedKind: "user",
      usedContinueUntilHumanBoundary: true,
      receivedProcess: "Session_Process",
      receivedActivity: "Task_Approve",
      receivedClaimant: "session-user",
    });
    expect(result.rawOutput).toContain("qianji task complete: completed");
    expect(result.rawOutput).not.toContain("## Variables");
  });

  it("runs generated BPMN fixture from streamed host-work without local interaction fallback", async () => {
    const source = readFileSync(join(fixturesDir, "human-approval.bpmn"), "utf-8");
    expect(source).toContain('<dataOutput id="Task_Approve_output_answer" name="answer"');
    expect(source).not.toContain("qianji:");
    const humanRequests: unknown[] = [];
    const hostWorkEvents: QianjiHostWorkEvent[] = [];

    const result = await execute({
      source,
      qianjiCommand: makeFakeGeneratedBpmnSmokeQianjiCommand(),
      instanceId: "wf_generated_bpmn_smoke",
      humanTaskHandler: async (request) => {
        humanRequests.push({
          activityId: request.activityId,
          execution: request.execution
            ? {
                processId: request.execution.processId,
                activityId: request.execution.activityId,
                tokenId: request.execution.tokenId,
              }
            : undefined,
          interaction: request.config.interaction,
          outputs: request.config.outputs,
          assignment: request.assignment,
          claim: request.claim,
        });
        return "runtime-approved";
      },
      onHostWork: (event) => hostWorkEvents.push(event),
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(humanRequests).toEqual([
      {
        activityId: "Task_Approve",
        execution: {
          processId: "Process_1",
          activityId: "Task_Approve",
          tokenId: 151,
        },
        interaction: {
          type: "confirm",
          question: "Runtime approval streamed by qianji?",
          result: { output: "runtimeApproval" },
        },
        outputs: ["runtimeApproval"],
        assignment: {
          potential_owners: [
            {
              name: "generated_reviewers",
              resource_ref: "reviewers",
            },
          ],
        },
        claim: { claimant: "generated-smoke-user", claimed_at_ms: 789 },
      },
    ]);
    expect(hostWorkEvents).toEqual([
      {
        activityId: "Task_Approve",
        hostWorkCount: 1,
        batchHostWorkCount: 1,
        tokenIds: [151],
        hostKinds: ["user"],
        parallel: false,
        repeatKinds: [],
        repeatSummaries: [],
        assignmentSummaries: ["potential_owner:generated_reviewers:ref=reviewers"],
      },
    ]);
    expect(result.variables).toMatchObject({
      runtimeApproval: "runtime-approved",
      generatedSmoke: true,
      localInteractionSeen: true,
      localResultOutput: "approved",
      completionProcess: "Process_1",
      completionActivity: "Task_Approve",
      completionClaimant: "generated-smoke-user",
    });
    expect(result.variables).not.toHaveProperty("approved");
  });

  it("routes qianji manualTask host work through the human task handler", async () => {
    const prompts: string[] = [];
    const graphView = new GraphView();
    const agentHost: PiWendaoAgentHost = {
      async run() {
        throw new Error("manual tasks must not run through the agent host");
      },
    };

    const result = await execute({
      source: manualCheckpointWorkflow(),
      qianjiCommand: makeFakeManualTaskExternalHostQianjiCommand(),
      instanceId: "wf_manual_checkpoint",
      agentHost,
      humanTaskHandler: async (request) => {
        prompts.push(request.config.prompt);
        expect(request.config.hostKind).toBe("manual");
        return "Operator acknowledged checkpoint";
      },
      hostBackend: "pi-subagents",
      graphView,
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(prompts).toEqual(["Complete the manual checkpoint before continuing."]);
    expect(result.variables).toMatchObject({
      manualNote: "Operator acknowledged checkpoint",
      fixtureManualTasks: ["Task_ManualCheckpoint"],
    });
    const internals = graphView as unknown as {
      nodes: Map<string, { details?: string[] }>;
    };
    expect(internals.nodes.get("Task_ManualCheckpoint")?.details).toContain(
      "host:manual:1 human",
    );
  });

  it("maps userTask replies only to the streamed native result output", async () => {
    const result = await execute({
      source: ambiguousHumanOutputsWorkflow(),
      qianjiCommand: makeFakeUserTaskExternalHostQianjiCommand(),
      instanceId: "wf_human_ambiguous_outputs",
      humanTaskHandler: async () => "y",
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({
      approvedReply: "y",
      fixtureUserTasks: ["Task_Approve"],
    });
    expect(result.variables).not.toHaveProperty("approved");
  });

  it("renders userTask interaction questions from workflow variables", async () => {
    const interactions: unknown[] = [];

    const result = await execute({
      source: dynamicHumanQuestionWorkflow(),
      qianjiCommand: makeFakeUserTaskExternalHostQianjiCommand(),
      instanceId: "wf_dynamic_question",
      humanTaskHandler: async (request) => {
        interactions.push(request.config.interaction);
        return "Use the direct path";
      },
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(interactions).toEqual([
      {
        type: "choice_input",
        question: "Ship the plan",
        questionRef: "proposal",
        choices: [
          {
            value: "direct",
            label: "Use direct path",
            description: "Proceed with the shortest implementation path.",
          },
          {
            value: "research",
            label: "Research first",
            description: "Pause and gather more context.",
          },
        ],
        choicesRef: "currentChoices",
        result: { output: "userAnswer" },
      },
    ]);
    expect(result.variables).toMatchObject({
      userAnswer: "Use the direct path",
    });
  });

  it("reports compact schema diagnostics when a service task generates invalid dynamic choices", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-invalid-choices-fixture-"));
    tempDirs.push(dir);
    const fixturePath = join(dir, "host-fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        service_tasks: {
          Task_PrepareQuestion: {
            data: {
              currentQuestion: "Which repair path should the workflow use?",
              currentChoices: [
                {
                  label: "Minimal repair",
                  description: "Repair only the invalid BPMN contract.",
                },
              ],
            },
          },
        },
      }),
    );
    const prompts: unknown[] = [];

    const result = await execute({
      source: serviceGeneratedDynamicChoicesWorkflow(),
      qianjiCommand: makeFakeServiceThenUserExternalHostQianjiCommand(),
      instanceId: "wf_invalid_dynamic_choices",
      hostFixturePath: fixturePath,
      humanTaskHandler: async (request) => {
        prompts.push(request.config.interaction);
        return "minimal";
      },
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(false);
    expect(prompts).toHaveLength(0);
    expect(result.error).toContain("[pi-wendao.runtime.invalid_dynamic_choices]");
    expect(result.error).toContain("Consumer activity: Task_AskQuestion");
    expect(result.error).toContain("Variable: currentChoices");
    expect(result.error).toContain("Item: 1");
    expect(result.error).toContain("Problem: item is missing required non-empty value");
    expect(result.error).toContain(
      "Help: currentChoices must be a native Array<{ value: string; label?: string; description?: string }>",
    );
    expect(result.error).toContain(
      "Contract: native choices data must be a JSON array whose items have a non-empty string value.",
    );
    expect(result.error).toContain('"currentChoices": [');
    expect(result.error).toContain('"value": "minimal"');
  });

  it("reports compact schema diagnostics when a service task generates a non-string question", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-invalid-question-fixture-"));
    tempDirs.push(dir);
    const fixturePath = join(dir, "host-fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        service_tasks: {
          Task_PrepareQuestion: {
            data: {
              currentQuestion: {
                prompt: "Which repair path should the workflow use?",
                choices: ["minimal", "broaden"],
              },
              currentChoices: [
                {
                  value: "minimal",
                  label: "Minimal repair",
                  description: "Repair only the invalid BPMN contract.",
                },
              ],
            },
          },
        },
      }),
    );
    const prompts: unknown[] = [];

    const result = await execute({
      source: serviceGeneratedDynamicChoicesWorkflow(),
      qianjiCommand: makeFakeServiceThenUserExternalHostQianjiCommand(),
      instanceId: "wf_invalid_dynamic_question",
      hostFixturePath: fixturePath,
      humanTaskHandler: async (request) => {
        prompts.push(request.config.interaction);
        return "minimal";
      },
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(false);
    expect(prompts).toHaveLength(0);
    expect(result.error).toContain("[pi-wendao.runtime.invalid_dynamic_question]");
    expect(result.error).toContain("Consumer activity: Task_AskQuestion");
    expect(result.error).toContain("Variable: currentQuestion");
    expect(result.error).toContain("Problem: ref did not resolve to a non-empty string");
    expect(result.error).toContain(
      "Help: currentQuestion must be a non-empty string used as the user-facing prompt.",
    );
    expect(result.error).toContain(
      "Contract: bpmn.native_human_task_io.v1 requires question source values",
    );
  });

  it("stops before repeating the same userTask prompt without progress", async () => {
    const prompts: unknown[] = [];

    const result = await execute({
      source: dynamicHumanQuestionWorkflow(),
      qianjiCommand: makeFakeRepeatingUserTaskExternalHostQianjiCommand(),
      instanceId: "wf_repeating_question",
      humanTaskHandler: async (request) => {
        prompts.push(request.config.interaction);
        return "direct";
      },
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("[pi-wendao.runtime.user_prompt_stall]");
    expect(result.error).toContain("Activity: Task_Approve");
    expect(result.error).toContain("Question: Ship the plan");
    expect(result.error).toContain("UserTask outputs: userAnswer");
    expect(result.error).toContain('- proposal: "Ship the plan"');
    expect(result.error).toContain("- currentChoices: [");
    expect(prompts).toHaveLength(1);
  });

  it("allows the same userTask to ask again when declared inputs change", async () => {
    const questions: string[] = [];

    const result = await execute({
      source: dynamicHumanQuestionWorkflow(),
      qianjiCommand: makeFakeProgressingUserTaskExternalHostQianjiCommand(),
      instanceId: "wf_progressing_question",
      humanTaskHandler: async (request) => {
        questions.push(request.config.interaction?.question ?? "");
        return questions.length === 1 ? "first answer" : "second answer";
      },
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(questions).toEqual(["First question?", "Second question?"]);
    expect(result.variables).toMatchObject({
      userAnswer: "second answer",
      fixtureUserTasks: ["Task_Approve"],
    });
  });

  it("uses host fixtures for non-user work while keeping user tasks native", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-mixed-host-fixture-"));
    tempDirs.push(dir);
    const fixturePath = join(dir, "host-fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        service_tasks: {
          Task_Final: {
            data: {
              finalStatus: "fixture-completed",
            },
          },
        },
      }),
    );
    const prompts: string[] = [];

    const result = await execute({
      source: userThenServiceWorkflow(),
      qianjiCommand: makeFakeUserThenServiceExternalHostQianjiCommand(),
      instanceId: "wf_mixed_fixture",
      hostFixturePath: fixturePath,
      humanTaskHandler: async (request) => {
        prompts.push(request.activityId);
        return "approved";
      },
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(prompts).toEqual(["Task_Approve"]);
    expect(result.variables).toMatchObject({
      approved: "approved",
      finalStatus: "fixture-completed",
      fixtureServiceTaskTokens: ["52"],
      fixtureUserTasks: ["Task_Approve"],
    });
  });

  it("parses native dynamic choices refs from BPMN userTask metadata", () => {
    const configs = buildPiWendaoConfigMap(dynamicHumanQuestionWorkflow(), "Process_1");

    expect(configs.get("Task_Approve")?.interaction).toMatchObject({
      type: "choice_input",
      questionRef: "proposal",
      choicesRef: "currentChoices",
      result: { output: "userAnswer" },
    });
    expect(configs.get("Task_Approve")?.interaction?.choices).toBeUndefined();
  });

  it("maps human replies only to the native answer output as plain strings", () => {
    expect(() => mapHumanTaskReplyToOutputs("n", [])).toThrow(
      "[pi-wendao.runtime.invalid_native_answer_output]",
    );
    expect(() => mapHumanTaskReplyToOutputs("n", ["approved", "approvedReply"])).toThrow(
      "[pi-wendao.runtime.invalid_native_answer_output]",
    );
    expect(mapHumanTaskReplyToOutputs("approved", ["approved"])).toEqual({
      approved: "approved",
    });
    expect(mapHumanTaskReplyToOutputs("yes", ["needsMoreQuestions"])).toEqual({
      needsMoreQuestions: "yes",
    });
    expect(mapHumanTaskReplyToOutputs("false", ["redFlagDetected"])).toEqual({
      redFlagDetected: "false",
    });
    expect(mapHumanTaskReplyToOutputs("false", ["userAnswer"])).toEqual({ userAnswer: "false" });
    expect(mapHumanTaskReplyToOutputs("", ["userAnswer"])).toEqual({ userAnswer: "" });
  });

  it("carries accumulated host outputs across partial qianji host variable snapshots", async () => {
    const faux = registerFauxProvider();
    const prompts: string[] = [];
    faux.setResponses([
      fauxAssistantMessage('Done.\n```json\n{"fileList":["package.json","src"]}\n```'),
      (context) => {
        prompts.push(context.systemPrompt);
        return fauxAssistantMessage(
          'Done.\n```json\n{"report":"package.json exists in package.json, src"}\n```',
        );
      },
    ]);

    try {
      const result = await execute({
        source: sequentialServiceTaskWorkflow(),
        qianjiCommand: makeFakeSequentialExternalHostQianjiCommand(),
        instanceId: "wf_sequential_host",
        model: faux.getModel(),
        apiKey: "test-key",
      });

      expect(result.success).toBe(true);
      expect(prompts[0]).toContain('fileList: ["package.json","src"]');
      expect(result.variables).toMatchObject({
        fileList: ["package.json", "src"],
        report: "package.json exists in package.json, src",
      });
    } finally {
      faux.unregister();
    }
  });

  it("feeds host retry outputs back to qianji checkpoints without local scheduling", async () => {
    const executions: Array<{ activityId: string; retryCount: unknown }> = [];
    const agentHost: PiWendaoAgentHost = {
      async run(request) {
        executions.push({
          activityId: request.activityId,
          retryCount: request.variables.retryCount,
        });
        if (request.activityId === "Task_1") {
          return { retryCount: 1, status: "not ready" };
        }
        if (request.activityId === "Task_2") {
          const retryCount = Number(request.variables.retryCount);
          return { isRetryComplete: retryCount >= 3, retryCount };
        }
        if (request.activityId === "Task_4") {
          return { retryCount: Number(request.variables.retryCount) + 1 };
        }
        if (request.activityId === "Task_3") {
          return { status: "ready" };
        }
        return {};
      },
    };

    const result = await execute({
      source: retryLoopWorkflow(),
      qianjiCommand: makeFakeRetryLoopExternalHostQianjiCommand(),
      instanceId: "wf_retry_checkpoint",
      agentHost,
      hostBackend: "pi-subagents",
    });

    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({
      retryCount: 3,
      isRetryComplete: true,
      status: "ready",
    });
    expect(
      executions
        .filter((execution) => execution.activityId === "Task_2")
        .map((execution) => execution.retryCount),
    ).toEqual([1, 2, 3]);
    expect(
      executions
        .filter((execution) => execution.activityId === "Task_4")
        .map((execution) => execution.retryCount),
    ).toEqual([1, 2]);
  });

  it("does not synthesize task outputs from service-task prompt text", async () => {
    const agentHost: PiWendaoAgentHost = {
      async run() {
        return { status: "host-owned" };
      },
    };

    const result = await execute({
      source: promptDerivedOutputWorkflow(),
      qianjiCommand: makeFakeSingleHostBoundaryQianjiCommand(),
      instanceId: "wf_no_prompt_output_synthesis",
      agentHost,
      hostBackend: "pi-subagents",
    });

    expect(result.success).toBe(true);
    expect(result.variables).toMatchObject({
      status: "host-owned",
    });
  });

  it("reports qianji CLI failures", async () => {
    const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");

    const result = await execute({
      source,
      qianjiCommand: makeFakeQianjiCommand({ exitCode: 2, stderr: "qianji failed" }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("qianji failed");
  });
});

function makeFakeQianjiCommand(options: { exitCode?: number; stderr?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji.cjs");
  writeFakeQianjiScript(scriptPath, options);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeQianjiGraphSnapshotCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-snapshot-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-snapshot.cjs");
  writeFakeQianjiGraphSnapshotScript(scriptPath);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeQianjiPathDir(options: { exitCode?: number; stderr?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-path-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "qianji");
  writeFakeQianjiScript(scriptPath, options, true);
  chmodSync(scriptPath, 0o755);
  return dir;
}

function makeFakeExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-external-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-external-host.cjs");
  writeFakeHostSessionScenarioQianjiScript(scriptPath, "parallel-service");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeUserTaskExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-user-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-user-host.cjs");
  writeFakeHostSessionScenarioQianjiScript(scriptPath, "user-task");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeMissingFormUserTaskQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-missing-form-user-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-missing-form-user-host.cjs");
  writeFakeHostSessionScenarioQianjiScript(scriptPath, "missing-form");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeMissingResultOutputUserTaskQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-missing-result-user-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-missing-result-user-host.cjs");
  writeFakeHostSessionScenarioQianjiScript(scriptPath, "missing-result-output");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeRustFormHumanTaskQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-rust-form-human-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-rust-form-human-host.cjs");
  writeFakeHostSessionScenarioQianjiScript(scriptPath, "rust-form");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeHostSessionQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-host-session-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-host-session.cjs");
  writeFakeHostSessionQianjiScript(scriptPath);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeGeneratedBpmnSmokeQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-generated-bpmn-smoke-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-generated-bpmn-smoke.cjs");
  writeFakeHostSessionScenarioQianjiScript(scriptPath, "generated-bpmn-smoke");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeManualTaskExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-manual-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-manual-host.cjs");
  writeFakeHostSessionScenarioQianjiScript(scriptPath, "manual-task");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeRepeatingUserTaskExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-repeating-user-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-repeating-user-host.cjs");
  writeFakeHostSessionScenarioQianjiScript(scriptPath, "repeating-user");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeProgressingUserTaskExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-progressing-user-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-progressing-user-host.cjs");
  writeFakeHostSessionScenarioQianjiScript(scriptPath, "progressing-user");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeUserThenServiceExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-user-service-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-user-service-host.cjs");
  writeFakeHostSessionScenarioQianjiScript(scriptPath, "user-then-service");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeServiceThenUserExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-service-user-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-service-user-host.cjs");
  writeFakeHostSessionScenarioQianjiScript(scriptPath, "service-then-user");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeSequentialExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-sequential-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-sequential-host.cjs");
  writeFakeHostSessionScenarioQianjiScript(scriptPath, "sequential-service");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeRetryLoopExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-retry-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-retry-host.cjs");
  writeFakeHostSessionScenarioQianjiScript(scriptPath, "retry-loop");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeSingleHostBoundaryQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-single-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-single-host.cjs");
  writeFakeHostSessionScenarioQianjiScript(scriptPath, "single-service");
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function writeFakeHostSessionScenarioQianjiScript(scriptPath: string, scenario: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const readline = require("node:readline");
const scenario = ${JSON.stringify(scenario)};
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const readJsonFile = (path, fallback) => path ? JSON.parse(readFileSync(path, "utf-8")) : fallback;
const context = JSON.parse(get("--context-json") || "{}");
const hostFixture = readJsonFile(get("--host-fixture"), {});
const source = get("--bpmn") ? readFileSync(get("--bpmn"), "utf-8") : "";
const currentChoices = [
  { value: "direct", label: "Use direct path", description: "Proceed with the shortest implementation path." },
  { value: "research", label: "Research first", description: "Pause and gather more context." },
];
const state = { variables: {}, completed: {}, step: 0, nextTokenId: 40, awaiting: undefined };

const emitTrace = (node_id, node_kind, status) => {
  if (args.includes("--trace-stream")) {
    console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", process_id: get("--process") || "Process_1", node_id, node_kind, status }));
  }
};
const emitResult = (commandLabel, outcome, variables, pendingHostWork, source = "resumed") => {
  const stdout = commandLabel + ": " + outcome + " (checkpoint=duckdb, source=" + source + ", saved=yes, deleted=no, pending_host=" + pendingHostWork + ")";
  console.log("@@QIANJI_SESSION_RESULT " + JSON.stringify({
    exitCode: 0,
    stdout,
    stderr: "",
    outcome,
    checkpoint: {
      backend: "duckdb",
      source,
      saved: "yes",
      deleted: "no",
      status: "saved",
    },
    pendingHostWork,
    variables,
  }));
};
const emitHostWork = (work) => {
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify(work));
};
const approveForm = () => {
  if (source.includes("approvedReply")) {
    return {
      interaction_type: "choice_input",
      question_text: "How should the workflow proceed?",
      choices: [
        { value: "approved", label: "Approve" },
        { value: "rejected", label: "Reject" },
      ],
      free_text_fields: [{ name: "approvedReply", optional: true }],
      result_output: "approvedReply",
    };
  }
  if (source.includes("userAnswer")) {
    return {
      interaction_type: "choice_input",
      question_ref: "proposal",
      choices_ref: "currentChoices",
      result_output: "userAnswer",
    };
  }
  return {
    interaction_type: "choice_input",
    question_text: "How should the workflow proceed?",
    choices: [
      { value: "approved", label: "Approve" },
      { value: "rejected", label: "Reject" },
    ],
    result_output: "approved",
  };
};
const emitApproveTask = (variables = {}) => {
  emitTrace("Task_Approve", "user_task", "executing");
  emitHostWork({
    kind: "user",
    node_id: "Task_Approve",
    node_index: 1,
    token_id: 51,
    repeat: null,
    variables: {
      proposal: "Ship the plan",
      currentChoices,
      ...variables,
    },
    form: approveForm(),
    assignment: null,
    claim: null,
  });
};
const emitDynamicQuestionTask = (nodeId, tokenId, variables) => {
  emitHostWork({
    kind: "user",
    node_id: nodeId,
    node_index: 2,
    token_id: tokenId,
    variables,
    form: {
      interaction_type: "choice_input",
      question_ref: "currentQuestion",
      choices_ref: "currentChoices",
      result_output: "userAnswer",
    },
  });
};
const emitServiceTask = (nodeId, tokenId, variables = {}) => {
  emitTrace(nodeId, "service_task", "executing");
  emitHostWork({
    kind: "service",
    node_id: nodeId,
    node_index: tokenId,
    token_id: tokenId,
    variables,
  });
};
const startScenario = () => {
  if (scenario === "parallel-service") {
    emitTrace("Task_Review", "service_task", "executing");
    emitHostWork({
      kind: "service",
      node_id: "Task_Review",
      node_index: 1,
      token_id: 11,
      variables: { items: ["alpha", "beta"], item: "alpha" },
      repeat: { kind: "parallel_multi_instance", iteration_index: 0, total_iterations: 2 },
    });
    emitHostWork({
      kind: "service",
      node_id: "Task_Review",
      node_index: 1,
      token_id: 12,
      variables: { items: ["alpha", "beta"], item: "beta" },
      repeat: { kind: "parallel_multi_instance", iteration_index: 1, total_iterations: 2 },
    });
    emitResult("qianji run", "blocked_on_host", { items: ["alpha", "beta"] }, 2, "fresh");
    return;
  }
  if (scenario === "user-task") {
    emitApproveTask();
    emitResult("qianji run", "blocked_on_host", {
      proposal: "Ship the plan",
      currentChoices,
    }, 1, "fresh");
    return;
  }
  if (scenario === "generated-bpmn-smoke") {
    const localInteractionSeen = source.includes("How should the workflow proceed?");
    const localResultOutput = source.includes("<targetRef>approved</targetRef>") ? "approved" : "missing";
    emitTrace("Task_Approve", "user_task", "executing");
    emitHostWork({
      kind: "user",
      process_id: "Process_1",
      activity_id: "Task_Approve",
      node_id: "Task_Approve",
      node_index: 1,
      token_id: 151,
      variables: {
        localInteractionSeen,
        localResultOutput,
      },
      form: {
        interaction_type: "confirm",
        question_text: "Runtime approval streamed by qianji?",
        result_output: "runtimeApproval",
      },
      assignment: {
        potential_owners: [{ name: "generated_reviewers", resource_ref: "reviewers" }],
      },
      claim: { claimant: "generated-smoke-user", claimed_at_ms: 789 },
    });
    emitResult("qianji run", "blocked_on_host", {
      localInteractionSeen,
      localResultOutput,
    }, 1, "fresh");
    return;
  }
  if (scenario === "missing-form") {
    emitHostWork({
      kind: "user",
      node_id: "Task_Approve",
      node_index: 1,
      token_id: 51,
      variables: {},
    });
    emitResult("qianji run", "blocked_on_host", {}, 1, "fresh");
    return;
  }
  if (scenario === "missing-result-output") {
    emitHostWork({
      kind: "user",
      node_id: "Task_Approve",
      node_index: 1,
      token_id: 51,
      variables: {},
      form: {
        interaction_type: "confirm",
        question_text: "Continue?",
      },
    });
    emitResult("qianji run", "blocked_on_host", {}, 1, "fresh");
    return;
  }
  if (scenario === "rust-form") {
    emitHostWork({
      kind: "user",
      process_id: "Rust_Process",
      activity_id: "Task_RustApprove",
      node_id: "Task_RustApprove",
      node_index: 1,
      token_id: 91,
      variables: {},
      form: {
        interaction_type: "choice_input",
        question_text: "Rust-sourced question?",
        choices: [
          { value: "direct", label: "Use direct path" },
          { value: "research", label: "Research first" },
        ],
        result_output: "rustAnswer",
      },
      assignment: {
        human_performers: [{ name: "reviewer", assignment_expression: "users.alice" }],
        potential_owners: [{ name: "review_team", resource_ref: "reviewers" }],
      },
      claim: { claimant: "alice", claimed_at_ms: 123 },
    });
    emitResult("qianji run", "blocked_on_host", {}, 1, "fresh");
    return;
  }
  if (scenario === "manual-task") {
    emitTrace("Task_ManualCheckpoint", "manual_task", "executing");
    emitHostWork({
      kind: "manual",
      node_id: "Task_ManualCheckpoint",
      node_index: 1,
      token_id: 71,
      variables: {},
      form: {
        interaction_type: "input",
        question_text: "Complete the manual checkpoint before continuing.",
        free_text_fields: [{ name: "manualNote", optional: false }],
        result_output: "manualNote",
      },
    });
    emitResult("qianji run", "blocked_on_host", {}, 1, "fresh");
    return;
  }
  if (scenario === "repeating-user") {
    state.variables = { proposal: "Ship the plan", currentChoices };
    emitHostWork({
      kind: "user",
      node_id: "Task_Approve",
      node_index: 1,
      token_id: 51,
      variables: state.variables,
      form: {
        interaction_type: "choice_input",
        question_ref: "proposal",
        choices_ref: "currentChoices",
        result_output: "userAnswer",
      },
    });
    emitResult("qianji run", "blocked_on_host", state.variables, 1, "fresh");
    return;
  }
  if (scenario === "progressing-user") {
    state.step = 1;
    state.variables = {};
    const variables = { proposal: "First question?", currentChoices };
    emitHostWork({
      kind: "user",
      node_id: "Task_Approve",
      node_index: 1,
      token_id: 51,
      variables,
      form: {
        interaction_type: "choice_input",
        question_ref: "proposal",
        choices_ref: "currentChoices",
        result_output: "userAnswer",
      },
    });
    emitResult("qianji run", "blocked_on_host", variables, 1, "fresh");
    return;
  }
  if (scenario === "user-then-service") {
    emitHostWork({
      kind: "user",
      node_id: "Task_Approve",
      node_index: 1,
      token_id: 51,
      variables: {},
      form: {
        interaction_type: "confirm",
        question_text: "Continue?",
        result_output: "approved",
      },
    });
    emitResult("qianji run", "blocked_on_host", {}, 1, "fresh");
    return;
  }
  if (scenario === "service-then-user") {
    const serviceTask = hostFixture.service_tasks?.Task_PrepareQuestion;
    if (serviceTask) {
      state.variables = { ...serviceTask.data };
      emitDynamicQuestionTask("Task_AskQuestion", 62, state.variables);
      emitResult("qianji run", "blocked_on_host", state.variables, 1, "fresh");
      return;
    }
    emitServiceTask("Task_PrepareQuestion", 61);
    emitResult("qianji run", "blocked_on_host", {}, 1, "fresh");
    return;
  }
  if (scenario === "sequential-service") {
    emitServiceTask("Task_List", 21);
    emitResult("qianji run", "blocked_on_host", {}, 1, "fresh");
    return;
  }
  if (scenario === "retry-loop") {
    state.awaiting = "Task_1";
    emitServiceTask("Task_1", 40);
    emitResult("qianji run", "blocked_on_host", {}, 1, "fresh");
    return;
  }
  if (scenario === "single-service") {
    emitServiceTask("Task_SetStatus", 31);
    emitResult("qianji run", "blocked_on_host", {}, 1, "fresh");
    return;
  }
  emitResult("qianji run", "failed", { error: "unknown scenario: " + scenario }, 0, "fresh");
};

const handleCompletion = (request) => {
  if (scenario === "parallel-service") {
    state.completed[String(request.token_id)] = request.data.result;
    const tokenIds = Object.keys(state.completed).sort((a, b) => Number(a) - Number(b));
    if (tokenIds.length < 2) {
      emitResult("qianji task complete", "blocked_on_host", {
        partialResults: tokenIds.map((tokenId) => state.completed[tokenId]),
      }, 2 - tokenIds.length);
      return;
    }
    emitTrace("Task_Review", "service_task", "completed");
    emitResult("qianji task complete", "completed", {
      results: tokenIds.map((tokenId) => state.completed[tokenId]),
      fixtureServiceTaskTokens: tokenIds,
    }, 0);
    return;
  }
  if (scenario === "user-task") {
    emitTrace("Task_Approve", "user_task", "completed");
    emitResult("qianji task complete", "completed", {
      ...request.data,
      fixtureUserTasks: ["Task_Approve"],
    }, 0);
    return;
  }
  if (scenario === "generated-bpmn-smoke") {
    emitTrace("Task_Approve", "user_task", "completed");
    emitResult("qianji task complete", "completed", {
      ...request.data,
      generatedSmoke: true,
      localInteractionSeen: source.includes("How should the workflow proceed?"),
      localResultOutput: source.includes("<targetRef>approved</targetRef>") ? "approved" : "missing",
      completionProcess: request.process_id,
      completionActivity: request.activity_id,
      completionClaimant: request.claimant,
    }, 0);
    return;
  }
  if (scenario === "rust-form") {
    emitResult("qianji task complete", "completed", {
      ...request.data,
      typedProcess: request.process_id,
      typedActivity: request.activity_id,
      claimant: request.claimant,
    }, 0);
    return;
  }
  if (scenario === "manual-task") {
    emitTrace("Task_ManualCheckpoint", "manual_task", "completed");
    emitResult("qianji task complete", "completed", {
      ...request.data,
      fixtureManualTasks: ["Task_ManualCheckpoint"],
    }, 0);
    return;
  }
  if (scenario === "repeating-user") {
    emitHostWork({
      kind: "user",
      node_id: "Task_Approve",
      node_index: 1,
      token_id: 52,
      variables: state.variables,
      form: {
        interaction_type: "choice_input",
        question_ref: "proposal",
        choices_ref: "currentChoices",
        result_output: "userAnswer",
      },
    });
    emitResult("qianji task complete", "blocked_on_host", state.variables, 1);
    return;
  }
  if (scenario === "progressing-user") {
    state.variables = { ...state.variables, ...request.data };
    if (state.step === 1) {
      state.step = 2;
      const variables = { ...state.variables, proposal: "Second question?", currentChoices };
      emitHostWork({
        kind: "user",
        node_id: "Task_Approve",
        node_index: 1,
        token_id: 52,
        variables,
        form: {
          interaction_type: "choice_input",
          question_ref: "proposal",
          choices_ref: "currentChoices",
          result_output: "userAnswer",
        },
      });
      emitResult("qianji task complete", "blocked_on_host", variables, 1);
      return;
    }
    emitResult("qianji task complete", "completed", {
      ...state.variables,
      fixtureUserTasks: ["Task_Approve"],
    }, 0);
    return;
  }
  if (scenario === "user-then-service") {
    state.variables = { ...state.variables, ...request.data };
    const serviceTask = hostFixture.service_tasks?.Task_Final;
    if (serviceTask) {
      state.variables = { ...state.variables, ...serviceTask.data };
      emitResult("qianji task complete", "completed", {
        ...state.variables,
        fixtureServiceTaskTokens: ["52"],
        fixtureServiceTasks: Object.keys(hostFixture.service_tasks ?? {}),
        fixtureUserTasks: ["Task_Approve"],
      }, 0);
      return;
    }
    emitServiceTask("Task_Final", 52, state.variables);
    emitResult("qianji task complete", "blocked_on_host", {
      ...state.variables,
      fixtureUserTasks: ["Task_Approve"],
    }, 1);
    return;
  }
  if (scenario === "service-then-user") {
    if (request.kind === "service") {
      state.variables = { ...state.variables, ...request.data };
      emitDynamicQuestionTask("Task_AskQuestion", 62, state.variables);
      emitResult("qianji task complete", "blocked_on_host", state.variables, 1);
      return;
    }
    state.variables = { ...state.variables, ...request.data };
    emitResult("qianji task complete", "completed", state.variables, 0);
    return;
  }
  if (scenario === "sequential-service") {
    if (request.token_id === 21) {
      state.variables = { ...state.variables, ...request.data };
      emitServiceTask("Task_Report", 22, state.variables);
      emitResult("qianji task complete", "blocked_on_host", state.variables, 1);
      return;
    }
    state.variables = { ...state.variables, ...request.data };
    emitResult("qianji task complete", "completed", state.variables, 0);
    return;
  }
  if (scenario === "retry-loop") {
    state.variables = { ...state.variables, ...request.data };
    if (state.awaiting === "Task_1") {
      state.awaiting = "Task_2";
      emitServiceTask("Task_2", 41, { retryCount: state.variables.retryCount });
      emitResult("qianji task complete", "blocked_on_host", state.variables, 1);
      return;
    }
    if (state.awaiting === "Task_2") {
      if (state.variables.isRetryComplete === true) {
        state.awaiting = "Task_3";
        emitServiceTask("Task_3", 42, {
          retryCount: state.variables.retryCount,
          isRetryComplete: true,
        });
        emitResult("qianji task complete", "blocked_on_host", state.variables, 1);
        return;
      }
      state.awaiting = "Task_4";
      emitServiceTask("Task_4", 43, { retryCount: state.variables.retryCount });
      emitResult("qianji task complete", "blocked_on_host", state.variables, 1);
      return;
    }
    if (state.awaiting === "Task_4") {
      state.awaiting = "Task_2";
      emitServiceTask("Task_2", 44, { retryCount: state.variables.retryCount });
      emitResult("qianji task complete", "blocked_on_host", state.variables, 1);
      return;
    }
    if (state.awaiting === "Task_3") {
      emitResult("qianji task complete", "completed", state.variables, 0);
      return;
    }
  }
  if (scenario === "single-service") {
    emitResult("qianji task complete", "completed", request.data, 0);
    return;
  }
  emitResult("qianji task complete", "failed", { error: "unexpected completion" }, 0);
};

if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args.includes("--checkpoint-runtime") || args.includes("--checkpoint-sqlite")) {
  console.error("pi-wendao must let qianji choose its checkpoint backend: " + args.join(" "));
  process.exit(65);
}
if (args[1] === "status") {
  emitResult("qianji status", "missing", {}, 0, "fresh");
  process.exit(0);
}
if (args[1] !== "host-session") {
  console.error("non-session qianji command should not be used: " + args.join(" "));
  process.exit(64);
}
startScenario();
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "stop") {
    process.exit(0);
  }
  if (request.type !== "task_complete") {
    emitResult("qianji host-session", "failed", { error: "unexpected request" }, 0);
    return;
  }
  handleCompletion(request);
});
`,
    "utf-8",
  );
}

function writeFakeQianjiGraphSnapshotScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args[1] === "status") {
  if (!get("--bpmn")) {
    console.error("status graph hydration requires --bpmn");
    process.exit(65);
  }
  const snapshot = [
    { node_id: "Start_1", node_index: 0, node_kind: "start_event", status: "completed" },
    { node_id: "Task_1", node_index: 1, node_kind: "service_task", status: "executing" },
    { node_id: "End_1", node_index: 2, node_kind: "end_event", status: "idle" },
  ];
  console.log("# BPMN Status\\n\\nInstance: " + get("--instance-id") + "\\nCheckpoint status: loaded\\n\\n## Graph Snapshot\\n" + fence + "json\\n" + JSON.stringify(snapshot, null, 2) + "\\n" + fence + "\\n");
  process.exit(0);
}
if (args[1] === "run") {
  console.log("# BPMN Run\\n\\nOutcome: blocked_on_host\\n\\n## Variables\\n" + fence + "json\\n{}\\n" + fence + "\\n");
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`,
    "utf-8",
  );
}

function writeFakeQianjiScript(
  scriptPath: string,
  options: { exitCode?: number; stderr?: string },
  executable = false,
): void {
  const exitCode = options.exitCode ?? 0;
  const stderr = JSON.stringify(options.stderr ?? "");
  writeFileSync(
    scriptPath,
    `${executable ? "#!/usr/bin/env node\n" : ""}
const args = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
if (args[0] !== "bpmn" || args[1] !== "run") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args.includes("--checkpoint-runtime") || args.includes("--checkpoint-sqlite")) {
  console.error("pi-wendao must let qianji choose its checkpoint backend: " + args.join(" "));
  process.exit(65);
}
if (${exitCode} !== 0) {
  const message = ${stderr};
  if (message) console.error(message);
  process.exit(${exitCode});
}
const context = JSON.parse(get("--context-json") ?? "{}");
const hostFixturePath = get("--host-fixture");
const hostFixture = hostFixturePath ? JSON.parse(readFileSync(hostFixturePath, "utf-8")) : undefined;
const variables = {
  ...context,
  process: get("--process"),
  instance: get("--instance-id"),
  bpmnSeen: Boolean(get("--bpmn")),
  hostFixtureSeen: Boolean(hostFixturePath),
  fixtureServiceTasks: Object.keys(hostFixture?.service_tasks ?? {}),
};
const trace = [
  { sequence: 1, kind: "node_status", process_id: get("--process"), node_id: "Start_1", node_kind: "start_event", status: "queued" },
  { sequence: 2, kind: "node_status", process_id: get("--process"), node_id: "Start_1", node_kind: "start_event", status: "completed" },
  { sequence: 3, kind: "flow_take", process_id: get("--process"), source_id: "Start_1", target_id: "Task_1" },
  { sequence: 4, kind: "node_status", process_id: get("--process"), node_id: "Task_1", node_kind: "service_task", status: "executing" },
  { sequence: 5, kind: "node_status", process_id: get("--process"), node_id: "Task_1", node_kind: "service_task", status: "completed" },
  { sequence: 6, kind: "flow_take", process_id: get("--process"), source_id: "Task_1", target_id: "End_1" },
  { sequence: 7, kind: "node_status", process_id: get("--process"), node_id: "End_1", node_kind: "end_event", status: "completed" },
];
const fence = String.fromCharCode(96, 96, 96);
if (args.includes("--trace-stream")) {
  for (const event of trace) {
    console.log("@@QIANJI_TRACE " + JSON.stringify(event));
  }
}
console.log("# BPMN Run\\n\\nOutcome: completed\\n\\n## Trace\\n" + fence + "json\\n" + JSON.stringify(trace, null, 2) + "\\n" + fence + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
`,
    "utf-8",
  );
}

function writeFakeExternalHostQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const statePath = join(__dirname, "parallel-state.json");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const load = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf-8")) : { results: {}, tokenIds: [] };
const save = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2));
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables, checkpoint = "") => {
  console.log("# " + title + "\\n\\nOutcome: " + outcome + checkpoint + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
const source = readFileSync(get("--bpmn"), "utf-8");
const hostForm = () => {
  if (source.includes("approvedReply")) {
    return {
      interaction_type: "choice_input",
      question_ref: null,
      question_text: "How should the workflow proceed?",
      choices_ref: null,
      choices: [
        { value: "approved", label: "Approve", description: "Continue the workflow." },
        { value: "rejected", label: "Reject", description: "Stop the workflow." },
      ],
      free_text_fields: [{ name: "approvedReply", optional: true }],
      result_output: "approvedReply",
    };
  }
  if (source.includes("userAnswer")) {
    return {
      interaction_type: "choice_input",
      question_ref: "proposal",
      choices_ref: "currentChoices",
      result_output: "userAnswer",
    };
  }
  return {
    interaction_type: "choice_input",
    question_ref: null,
    question_text: "How should the workflow proceed?",
    choices_ref: null,
    choices: [
      { value: "approved", label: "Approve", description: "Continue the workflow." },
      { value: "rejected", label: "Reject", description: "Stop the workflow." },
    ],
    result_output: "approved",
  };
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args.includes("--checkpoint-runtime") || args.includes("--checkpoint-sqlite")) {
  console.error("pi-wendao must let qianji choose its checkpoint backend: " + args.join(" "));
  process.exit(65);
}
if (args[1] === "run") {
  save({ results: {}, tokenIds: [] });
  const processId = get("--process");
  if (args.includes("--trace-stream")) {
    console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", process_id: processId, node_id: "Task_Review", node_kind: "service_task", status: "executing" }));
  }
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: "Task_Review",
    node_index: 1,
    token_id: 11,
    variables: { items: ["alpha", "beta"], item: "alpha" },
    repeat: { kind: "parallel_multi_instance", iteration_index: 0, total_iterations: 2 },
  }));
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: "Task_Review",
    node_index: 1,
    token_id: 12,
    variables: { items: ["alpha", "beta"], item: "beta" },
    repeat: { kind: "parallel_multi_instance", iteration_index: 1, total_iterations: 2 },
  }));
  printVariables("BPMN Run", "blocked_on_host", { items: ["alpha", "beta"] }, "\\nCheckpoint backend: duckdb\\nCheckpoint source: fresh\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: 2");
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const state = load();
  const tokenId = get("--token-id");
  const data = JSON.parse(get("--data-json") ?? "{}");
  state.results[tokenId] = data.result;
  state.tokenIds = Array.from(new Set([...(state.tokenIds ?? []), tokenId]));
  save(state);
  if (args.includes("--trace-stream")) {
    console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", node_id: "Task_Review", node_kind: "service_task", status: "completed" }));
  }
  const completed = state.tokenIds.length >= 2;
  printVariables("BPMN Task Complete", completed ? "completed" : "blocked_on_host", {
    results: state.tokenIds.map((tokenId) => state.results[tokenId]),
    fixtureServiceTaskTokens: state.tokenIds,
  }, completed ? "" : "\\nCheckpoint backend: duckdb\\nCheckpoint source: resumed\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: 1");
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`,
    "utf-8",
  );
}

function writeFakeUserTaskExternalHostQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables, checkpoint = "") => {
  console.log("# " + title + "\\n\\nOutcome: " + outcome + checkpoint + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
const source = readFileSync(get("--bpmn"), "utf-8");
const hostForm = () => {
  if (source.includes("approvedReply")) {
    return {
      interaction_type: "choice_input",
      question_text: "How should the workflow proceed?",
      choices: [
        { value: "approved", label: "Approve" },
        { value: "rejected", label: "Reject" },
      ],
      free_text_fields: [{ name: "approvedReply", optional: true }],
      result_output: "approvedReply",
    };
  }
  if (source.includes("userAnswer")) {
    return {
      interaction_type: "choice_input",
      question_ref: "proposal",
      choices_ref: "currentChoices",
      result_output: "userAnswer",
    };
  }
  return {
    interaction_type: "choice_input",
    question_text: "How should the workflow proceed?",
    choices: [
      { value: "approved", label: "Approve" },
      { value: "rejected", label: "Reject" },
    ],
    result_output: "approved",
  };
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args[1] === "status") {
  printVariables("BPMN Status", "missing", {});
  process.exit(0);
}
if (args[1] === "run") {
  if (args.includes("--trace-stream")) {
    console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", node_id: "Task_Approve", node_kind: "user_task", status: "executing" }));
  }
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "user",
    node_id: "Task_Approve",
    node_index: 1,
    token_id: 51,
    repeat: null,
    variables: {
      proposal: "Ship the plan",
      currentChoices: [
        { value: "direct", label: "Use direct path", description: "Proceed with the shortest implementation path." },
        { value: "research", label: "Research first", description: "Pause and gather more context." },
      ],
    },
    form: hostForm(),
    assignment: null,
    claim: null,
  }));
  printVariables("BPMN Run", "blocked_on_host", {
    proposal: "Ship the plan",
    currentChoices: [
      { value: "direct", label: "Use direct path", description: "Proceed with the shortest implementation path." },
      { value: "research", label: "Research first", description: "Pause and gather more context." },
    ],
  }, "\\nCheckpoint backend: duckdb\\nCheckpoint source: fresh\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: 1");
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const data = JSON.parse(get("--data-json") ?? "{}");
  if (args.includes("--trace-stream")) {
    console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", node_id: "Task_Approve", node_kind: "user_task", status: "completed" }));
  }
  printVariables("BPMN Task Complete", "completed", {
    ...data,
    fixtureUserTasks: ["Task_Approve"],
  });
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`,
    "utf-8",
  );
}

function writeFakeMissingFormUserTaskQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables, checkpoint = "") => {
  console.log("# " + title + "\\n\\nOutcome: " + outcome + checkpoint + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args[1] === "host-session") {
  console.error("unexpected qianji args: " + args.slice(0, 2).join(" "));
  process.exit(64);
}
if (args[1] === "status") {
  printVariables("BPMN Status", "missing", {});
  process.exit(0);
}
if (args[1] === "run") {
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "user",
    node_id: "Task_Approve",
    node_index: 1,
    token_id: 51,
    variables: {},
  }));
  printVariables("BPMN Run", "blocked_on_host", {}, "\\nCheckpoint backend: duckdb\\nCheckpoint source: fresh\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: 1");
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`,
    "utf-8",
  );
}

function writeFakeMissingResultOutputUserTaskQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables, checkpoint = "") => {
  console.log("# " + title + "\\n\\nOutcome: " + outcome + checkpoint + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args[1] === "host-session") {
  console.error("unexpected qianji args: " + args.slice(0, 2).join(" "));
  process.exit(64);
}
if (args[1] === "status") {
  printVariables("BPMN Status", "missing", {});
  process.exit(0);
}
if (args[1] === "run") {
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "user",
    node_id: "Task_Approve",
    node_index: 1,
    token_id: 51,
    variables: {},
    form: {
      interaction_type: "confirm",
      question_text: "Continue?",
    },
  }));
  printVariables("BPMN Run", "blocked_on_host", {}, "\\nCheckpoint backend: duckdb\\nCheckpoint source: fresh\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: 1");
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`,
    "utf-8",
  );
}

function writeFakeRustFormHumanTaskQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables, checkpoint = "") => {
  console.log("# " + title + "\\n\\nOutcome: " + outcome + checkpoint + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args[1] === "host-session") {
  console.error("unexpected qianji args: " + args.slice(0, 2).join(" "));
  process.exit(64);
}
if (args[1] === "status") {
  printVariables("BPMN Status", "missing", {});
  process.exit(0);
}
if (args[1] === "run") {
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "user",
    process_id: "Rust_Process",
    activity_id: "Task_RustApprove",
    node_id: "Task_RustApprove",
    node_index: 1,
    token_id: 91,
    variables: {},
    form: {
      interaction_type: "choice_input",
      question_text: "Rust-sourced question?",
      choices: [
        { value: "direct", label: "Use direct path" },
        { value: "research", label: "Research first" },
      ],
      result_output: "rustAnswer",
    },
    assignment: {
      human_performers: [
        { name: "reviewer", assignment_expression: "users.alice" },
      ],
      potential_owners: [
        { name: "review_team", resource_ref: "reviewers" },
      ],
    },
    claim: { claimant: "alice", claimed_at_ms: 123 },
  }));
  printVariables("BPMN Run", "blocked_on_host", {}, "\\nCheckpoint backend: duckdb\\nCheckpoint source: fresh\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: 1");
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const data = JSON.parse(get("--data-json") ?? "{}");
  const expected = {
    processId: "Rust_Process",
    activityId: "Task_RustApprove",
    claimant: "alice",
  };
  if (get("--process-id") !== expected.processId) {
    console.error("unexpected process-id: " + get("--process-id"));
    process.exit(65);
  }
  if (get("--activity-id") !== expected.activityId) {
    console.error("unexpected activity-id: " + get("--activity-id"));
    process.exit(65);
  }
  if (get("--claimant") !== expected.claimant) {
    console.error("unexpected claimant: " + get("--claimant"));
    process.exit(65);
  }
  if (data.rustAnswer !== "direct") {
    console.error("unexpected completion data: " + JSON.stringify(data));
    process.exit(65);
  }
  printVariables("BPMN Task Complete", "completed", {
    ...data,
    typedProcess: get("--process-id"),
    typedActivity: get("--activity-id"),
    claimant: get("--claimant"),
  });
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`,
    "utf-8",
  );
}

function writeFakeManualTaskExternalHostQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables, checkpoint = "") => {
  console.log("# " + title + "\\n\\nOutcome: " + outcome + checkpoint + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args[1] === "run") {
  if (args.includes("--trace-stream")) {
    console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", node_id: "Task_ManualCheckpoint", node_kind: "manual_task", status: "executing" }));
  }
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "manual",
    node_id: "Task_ManualCheckpoint",
    node_index: 1,
    token_id: 71,
    variables: {},
    form: {
      interaction_type: "input",
      question_text: "Complete the manual checkpoint before continuing.",
      free_text_fields: [{ name: "manualNote", optional: false }],
      result_output: "manualNote",
    },
  }));
  printVariables("BPMN Run", "blocked_on_host", {}, "\\nCheckpoint backend: duckdb\\nCheckpoint source: fresh\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: 1");
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const data = JSON.parse(get("--data-json") ?? "{}");
  if (args.includes("--trace-stream")) {
    console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", node_id: "Task_ManualCheckpoint", node_kind: "manual_task", status: "completed" }));
  }
  printVariables("BPMN Task Complete", "completed", {
    ...data,
    fixtureManualTasks: ["Task_ManualCheckpoint"],
  });
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`,
    "utf-8",
  );
}

function writeFakeRepeatingUserTaskExternalHostQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const currentChoices = [
  { value: "direct", label: "Use direct path", description: "Proceed with the shortest implementation path." },
  { value: "research", label: "Research first", description: "Pause and gather more context." },
];
const variables = { proposal: "Ship the plan", currentChoices };
const printVariables = (title, outcome, tokenId) => {
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "user",
    node_id: "Task_Approve",
    node_index: 1,
    token_id: tokenId,
    variables,
    form: {
      interaction_type: "choice_input",
      question_ref: "proposal",
      choices_ref: "currentChoices",
      result_output: "userAnswer",
    },
  }));
  console.log("# " + title + "\\n\\nOutcome: " + outcome + "\\nCheckpoint backend: duckdb\\nCheckpoint source: resumed\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: 1\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args[1] === "status") {
  console.log("# BPMN Status\\n\\nOutcome: missing\\n\\n## Variables\\n" + fence + "json\\n{}\\n" + fence + "\\n");
  process.exit(0);
}
if (args[1] === "run") {
  printVariables("BPMN Run", "blocked_on_host", 51);
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  printVariables("BPMN Task Complete", "blocked_on_host", 52);
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`,
    "utf-8",
  );
}

function writeFakeProgressingUserTaskExternalHostQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const statePath = join(__dirname, "progress-state.json");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const currentChoices = [
  { value: "direct", label: "Use direct path", description: "Proceed with the shortest implementation path." },
  { value: "research", label: "Research first", description: "Pause and gather more context." },
];
const load = () => existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf-8"))
  : { step: 0 };
const save = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2));
const emitUserTask = (title, proposal, tokenId, variables = {}) => {
  const outputVariables = { ...variables, proposal, currentChoices };
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "user",
    node_id: "Task_Approve",
    node_index: 1,
    token_id: tokenId,
    variables: outputVariables,
    form: {
      interaction_type: "choice_input",
      question_ref: "proposal",
      choices_ref: "currentChoices",
      result_output: "userAnswer",
    },
  }));
  console.log("# " + title + "\\n\\nOutcome: blocked_on_host\\nCheckpoint backend: duckdb\\nCheckpoint source: resumed\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: 1\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(outputVariables, null, 2) + "\\n" + fence + "\\n");
};
const printCompleted = (variables) => {
  console.log("# BPMN Task Complete\\n\\nOutcome: completed\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args[1] === "status") {
  console.log("# BPMN Status\\n\\nOutcome: missing\\n\\n## Variables\\n" + fence + "json\\n{}\\n" + fence + "\\n");
  process.exit(0);
}
if (args[1] === "run") {
  save({ step: 1, variables: {} });
  emitUserTask("BPMN Run", "First question?", 51);
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const state = load();
  const data = JSON.parse(get("--data-json") ?? "{}");
  state.variables = { ...state.variables, ...data };
  if (state.step === 1) {
    save({ step: 2, variables: state.variables });
    emitUserTask("BPMN Task Complete", "Second question?", 52, state.variables);
    process.exit(0);
  }
  printCompleted({
    ...state.variables,
    fixtureUserTasks: ["Task_Approve"],
  });
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`,
    "utf-8",
  );
}

function writeFakeHostSessionQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const readline = require("node:readline");
const emitResult = (title, outcome, variables, pendingHostWork) => {
  const commandLabel = title === "BPMN Run" ? "qianji run" : "qianji task complete";
  const stdout = commandLabel + ": " + outcome + " (checkpoint=duckdb, source=resumed, saved=yes, deleted=no, pending_host=" + pendingHostWork + ")";
  console.log("@@QIANJI_SESSION_RESULT " + JSON.stringify({
    exitCode: 0,
    stdout,
    stderr: "",
    outcome,
    checkpoint: {
      backend: "duckdb",
      source: "resumed",
      saved: "yes",
      deleted: "no",
      status: "saved",
    },
    pendingHostWork,
    variables,
  }));
};
if (args[0] !== "bpmn" || args[1] !== "host-session") {
  console.error("non-session qianji command should not be used: " + args.join(" "));
  process.exit(64);
}
console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
  kind: "user",
  process_id: "Session_Process",
  activity_id: "Task_Approve",
  node_id: "Task_Approve",
  node_index: 1,
  token_id: 51,
  variables: {},
  form: {
    interaction_type: "confirm",
    question_text: "Continue?",
    result_output: "approved",
  },
  claim: { claimant: "session-user", claimed_at_ms: 456 },
}));
emitResult("BPMN Run", "blocked_on_host", {}, 1);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "stop") {
    process.exit(0);
  }
  if (request.type !== "task_complete") {
    emitResult("BPMN Host Session", "failed", { error: "unexpected request" }, 0);
    return;
  }
  emitResult("BPMN Task Complete", "completed", {
    ...request.data,
    sessionMode: "host-session",
    receivedKind: request.kind,
    receivedProcess: request.process_id,
    receivedActivity: request.activity_id,
    receivedClaimant: request.claimant,
    usedContinueUntilHumanBoundary: request.continue_until_human_boundary,
  }, 0);
});
`,
    "utf-8",
  );
}

function writeFakeUserThenServiceExternalHostQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const statePath = join(__dirname, "state.json");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables, pendingHostWork) => {
  const checkpoint = "\\nCheckpoint backend: duckdb\\nCheckpoint source: resumed\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: " + pendingHostWork;
  console.log("# " + title + "\\n\\nOutcome: " + outcome + checkpoint + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
const save = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2));
const load = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf-8")) : { variables: {} };
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args[1] === "status") {
  printVariables("BPMN Status", "missing", {}, 0);
  process.exit(0);
}
if (args[1] === "run") {
  save({ variables: {} });
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "user",
    node_id: "Task_Approve",
    node_index: 1,
    token_id: 51,
    variables: {},
    form: {
      interaction_type: "confirm",
      question_text: "Continue?",
      result_output: "approved",
    },
  }));
  printVariables("BPMN Run", "blocked_on_host", {}, 1);
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const state = load();
  const data = JSON.parse(get("--data-json") ?? "{}");
  const hostFixturePath = get("--host-fixture");
  const hostFixture = hostFixturePath ? JSON.parse(readFileSync(hostFixturePath, "utf-8")) : {};
  const serviceTasks = hostFixture.service_tasks ?? {};
  if (get("--kind") === "user") {
    state.variables = { ...state.variables, ...data };
    save(state);
    if (serviceTasks.Task_Final) {
      state.variables = { ...state.variables, ...serviceTasks.Task_Final.data };
      save(state);
      printVariables("BPMN Task Complete", "completed", {
        ...state.variables,
        fixtureServiceTaskTokens: ["52"],
        fixtureServiceTasks: Object.keys(serviceTasks),
        fixtureUserTasks: ["Task_Approve"],
      }, 0);
      process.exit(0);
    }
    console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
      kind: "service",
      node_id: "Task_Final",
      node_index: 2,
      token_id: 52,
      variables: state.variables,
    }));
    printVariables("BPMN Task Complete", "blocked_on_host", {
      ...state.variables,
      fixtureUserTasks: ["Task_Approve"],
    }, 1);
    process.exit(0);
  }
  if (get("--kind") === "service") {
    state.variables = { ...state.variables, ...data };
    save(state);
    printVariables("BPMN Task Complete", "completed", {
      ...state.variables,
      fixtureServiceTaskTokens: [get("--token-id")],
      fixtureUserTasks: ["Task_Approve"],
    }, 0);
    process.exit(0);
  }
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`,
    "utf-8",
  );
}

function writeFakeServiceThenUserExternalHostQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const statePath = join(__dirname, "service-user-state.json");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const save = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2));
const load = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf-8")) : { variables: {} };
const printVariables = (title, outcome, variables, pendingHostWork) => {
  const checkpoint = "\\nCheckpoint backend: duckdb\\nCheckpoint source: resumed\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: " + pendingHostWork;
  console.log("# " + title + "\\n\\nOutcome: " + outcome + checkpoint + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args[1] === "status") {
  printVariables("BPMN Status", "missing", {}, 0);
  process.exit(0);
}
if (args[1] === "run") {
  save({ variables: {} });
  const hostFixturePath = get("--host-fixture");
  const hostFixture = hostFixturePath ? JSON.parse(readFileSync(hostFixturePath, "utf-8")) : {};
  const serviceTasks = hostFixture.service_tasks ?? {};
  if (serviceTasks.Task_PrepareQuestion) {
    const state = { variables: { ...serviceTasks.Task_PrepareQuestion.data } };
    save(state);
    console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
      kind: "user",
      node_id: "Task_AskQuestion",
      node_index: 2,
      token_id: 62,
      variables: state.variables,
      form: {
        interaction_type: "choice_input",
        question_ref: "currentQuestion",
        choices_ref: "currentChoices",
        result_output: "userAnswer",
      },
    }));
    printVariables("BPMN Run", "blocked_on_host", state.variables, 1);
    process.exit(0);
  }
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: "Task_PrepareQuestion",
    node_index: 1,
    token_id: 61,
    variables: {},
  }));
  printVariables("BPMN Run", "blocked_on_host", {}, 1);
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const state = load();
  const data = JSON.parse(get("--data-json") ?? "{}");
  if (get("--kind") === "service") {
    state.variables = { ...state.variables, ...data };
    save(state);
    console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
      kind: "user",
      node_id: "Task_AskQuestion",
      node_index: 2,
      token_id: 62,
      variables: state.variables,
      form: {
        interaction_type: "choice_input",
        question_ref: "currentQuestion",
        choices_ref: "currentChoices",
        result_output: "userAnswer",
      },
    }));
    printVariables("BPMN Task Complete", "blocked_on_host", state.variables, 1);
    process.exit(0);
  }
  if (get("--kind") === "user") {
    state.variables = { ...state.variables, ...data };
    save(state);
    printVariables("BPMN Task Complete", "completed", state.variables, 0);
    process.exit(0);
  }
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`,
    "utf-8",
  );
}

function writeFakeSequentialExternalHostQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables) => {
  console.log("# " + title + "\\n\\nOutcome: " + outcome + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args.includes("--checkpoint-runtime") || args.includes("--checkpoint-sqlite")) {
  console.error("pi-wendao must let qianji choose its checkpoint backend: " + args.join(" "));
  process.exit(65);
}
if (args[1] === "run") {
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: "Task_List",
    node_index: 1,
    token_id: 21,
    variables: {},
  }));
  printVariables("BPMN Run", "blocked_on_host", {});
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const data = JSON.parse(get("--data-json") ?? "{}");
  if (get("--token-id") === "21") {
    console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
      kind: "service",
      node_id: "Task_Report",
      node_index: 2,
      token_id: 22,
      variables: {},
    }));
    printVariables("BPMN Task Complete", "blocked_on_host", {});
    process.exit(0);
  }
  printVariables("BPMN Task Complete", "completed", data);
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`,
    "utf-8",
  );
}

function writeFakeRetryLoopExternalHostQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const statePath = join(__dirname, "retry-state.json");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables, pendingHostWork, checkpointSource) => {
  const checkpoint = "\\nCheckpoint backend: duckdb\\nCheckpoint source: " + checkpointSource + "\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: " + pendingHostWork;
  console.log("# " + title + "\\n\\nOutcome: " + outcome + checkpoint + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
const save = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2));
const load = () => existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf-8"))
  : { awaiting: undefined, nextTokenId: 40, variables: {} };
const emitHostWork = (state, nodeId, variables, source) => {
  const tokenId = state.nextTokenId++;
  state.awaiting = nodeId;
  save(state);
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: nodeId,
    node_index: tokenId,
    token_id: tokenId,
    variables,
  }));
  printVariables("BPMN Host Boundary", "blocked_on_host", state.variables, 1, source);
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args.includes("--checkpoint-runtime") || args.includes("--checkpoint-sqlite")) {
  console.error("pi-wendao must let qianji choose its checkpoint backend: " + args.join(" "));
  process.exit(65);
}
if (args[1] === "run") {
  const state = { awaiting: "Task_1", nextTokenId: 41, variables: {} };
  save(state);
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: "Task_1",
    node_index: 40,
    token_id: 40,
    variables: {},
  }));
  printVariables("BPMN Run", "blocked_on_host", {}, 1, "fresh");
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const state = load();
  const data = JSON.parse(get("--data-json") ?? "{}");
  state.variables = { ...state.variables, ...data };
  if (state.awaiting === "Task_1") {
    emitHostWork(state, "Task_2", { retryCount: state.variables.retryCount }, "resumed");
    process.exit(0);
  }
  if (state.awaiting === "Task_2") {
    if (state.variables.isRetryComplete === true) {
      emitHostWork(state, "Task_3", { retryCount: state.variables.retryCount, isRetryComplete: true }, "resumed");
      process.exit(0);
    }
    emitHostWork(state, "Task_4", { retryCount: state.variables.retryCount }, "resumed");
    process.exit(0);
  }
  if (state.awaiting === "Task_4") {
    emitHostWork(state, "Task_2", { retryCount: state.variables.retryCount }, "resumed");
    process.exit(0);
  }
  if (state.awaiting === "Task_3") {
    state.awaiting = "completed";
    save(state);
    printVariables("BPMN Task Complete", "completed", state.variables, 0, "resumed");
    process.exit(0);
  }
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
	`,
    "utf-8",
  );
}

function writeFakeSingleHostBoundaryQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables) => {
  console.log("# " + title + "\\n\\nOutcome: " + outcome + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args[1] === "run") {
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: "Task_SetStatus",
    node_index: 1,
    token_id: 31,
    variables: {},
  }));
  printVariables("BPMN Run", "blocked_on_host", {});
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const data = JSON.parse(get("--data-json") ?? "{}");
  printVariables("BPMN Task Complete", "completed", data);
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
	`,
    "utf-8",
  );
}

function tokenScopedServiceTaskWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1"/>',
      nativeServiceTask({
        id: "Task_Review",
        name: "Review item",
        documentation: "Review the current item and output result.",
        inputs: ["item"],
        outputs: ["result"],
      }),
      '    <endEvent id="End_1"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Review"/>',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_Review" targetRef="End_1"/>',
    ].join("\n"),
  );
}

function humanApprovalWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1"/>',
      nativeHumanTask({
        id: "Task_Approve",
        name: "Approve proposal",
        documentation: "How should the workflow proceed?",
        inputs: ["proposal"],
        resultOutput: "approved",
        interactionType: "choice_input",
        choices: [
          {
            value: "approved",
            label: "Approve",
            description: "Continue to the next BPMN checkpoint.",
          },
          {
            value: "rejected",
            label: "Reject",
            description: "Stop and revise the plan.",
          },
        ],
      }),
      '    <endEvent id="End_1"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Approve"/>',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_Approve" targetRef="End_1"/>',
    ].join("\n"),
  );
}

function rustSourcedHumanTaskWorkflow(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
  <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             id="Definitions_Rust_Form"
             targetNamespace="https://qianji.dev">
  <process id="Process_1" isExecutable="true">
    <startEvent id="Start_1"/>
    <userTask id="Task_RustApprove" name="Rust sourced prompt"/>
    <endEvent id="End_1"/>
    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_RustApprove"/>
    <sequenceFlow id="Flow_2" sourceRef="Task_RustApprove" targetRef="End_1"/>
  </process>
  </definitions>`;
}

function manualCheckpointWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1"/>',
      nativeHumanTask({
        id: "Task_ManualCheckpoint",
        kind: "manualTask",
        name: "Manual checkpoint",
        documentation: "Complete the manual checkpoint before continuing.",
        resultOutput: "manualNote",
        interactionType: "input",
        freeText: { name: "manualNote", optional: false },
      }),
      '    <endEvent id="End_1"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_ManualCheckpoint"/>',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_ManualCheckpoint" targetRef="End_1"/>',
    ].join("\n"),
  );
}

function ambiguousHumanOutputsWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1"/>',
      nativeHumanTask({
        id: "Task_Approve",
        name: "Approve proposal",
        documentation: "How should the workflow proceed?",
        inputs: ["proposal"],
        resultOutput: "approvedReply",
        interactionType: "choice_input",
        choices: [
          {
            value: "approved",
            label: "Approve",
            description: "Continue to the next BPMN checkpoint.",
          },
          {
            value: "rejected",
            label: "Reject",
            description: "Stop and revise the plan.",
          },
        ],
        freeText: { name: "approvedReply", optional: true },
      }),
      '    <endEvent id="End_1"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Approve"/>',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_Approve" targetRef="End_1"/>',
    ].join("\n"),
  );
}

function dynamicHumanQuestionWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1"/>',
      nativeHumanTask({
        id: "Task_Approve",
        name: "Answer generated question",
        documentation: "Answer the generated question.",
        inputs: ["proposal", "currentChoices"],
        resultOutput: "userAnswer",
        interactionType: "choice_input",
        questionRef: "proposal",
        choicesRef: "currentChoices",
      }),
      '    <endEvent id="End_1"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Approve"/>',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_Approve" targetRef="End_1"/>',
    ].join("\n"),
  );
}

function serviceGeneratedDynamicChoicesWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1"/>',
      nativeServiceTask({
        id: "Task_PrepareQuestion",
        name: "Prepare generated question",
        documentation: "Output currentQuestion and currentChoices.",
        inputs: ["context"],
        outputs: ["currentQuestion", "currentChoices"],
      }),
      nativeHumanTask({
        id: "Task_AskQuestion",
        name: "Answer generated question",
        documentation: "Answer the generated question.",
        inputs: ["currentQuestion", "currentChoices"],
        resultOutput: "userAnswer",
        interactionType: "choice_input",
        questionRef: "currentQuestion",
        choicesRef: "currentChoices",
      }),
      '    <endEvent id="End_1"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_PrepareQuestion"/>',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_PrepareQuestion" targetRef="Task_AskQuestion"/>',
      '    <sequenceFlow id="Flow_3" sourceRef="Task_AskQuestion" targetRef="End_1"/>',
    ].join("\n"),
  );
}

function userThenServiceWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1"/>',
      nativeHumanTask({
        id: "Task_Approve",
        name: "Approve",
        documentation: "Continue?",
        resultOutput: "approved",
        interactionType: "confirm",
      }),
      nativeServiceTask({
        id: "Task_Final",
        name: "Final service",
        documentation: "Run final service task.",
        inputs: ["approved"],
        outputs: ["finalStatus"],
      }),
      '    <endEvent id="End_1"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Approve"/>',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_Approve" targetRef="Task_Final"/>',
      '    <sequenceFlow id="Flow_3" sourceRef="Task_Final" targetRef="End_1"/>',
    ].join("\n"),
  );
}

function promptDerivedOutputWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1"/>',
      nativeServiceTask({
        id: "Task_SetStatus",
        name: "Set status",
        documentation: 'Set status to "ready". Output status.',
        outputs: ["status"],
      }),
      '    <endEvent id="End_1"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_SetStatus"/>',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_SetStatus" targetRef="End_1"/>',
    ].join("\n"),
  );
}

function retryLoopWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1"/>',
      nativeServiceTask({
        id: "Task_1",
        name: "Initialize system",
        documentation: 'Set retryCount to 1 and status to "not ready". Output both variables.',
        outputs: ["retryCount", "status"],
      }),
      nativeServiceTask({
        id: "Task_2",
        name: "Check retry count",
        documentation:
          "Check if retryCount is greater than or equal to 3. Output isRetryComplete as true if retryCount >= 3, false otherwise. Also output the current retryCount value.",
        inputs: ["retryCount"],
        outputs: ["isRetryComplete", "retryCount"],
      }),
      '    <exclusiveGateway id="Gateway_1" name="Retry complete?" default="Flow_5"/>',
      nativeServiceTask({
        id: "Task_3",
        name: "Set status ready",
        documentation: 'Set status to "ready". Output status as "ready".',
        outputs: ["status"],
      }),
      nativeServiceTask({
        id: "Task_4",
        name: "Increment retry count",
        documentation: "Increment retryCount by 1. Output the new retryCount value.",
        inputs: ["retryCount"],
        outputs: ["retryCount"],
      }),
      '    <endEvent id="End_1"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1"/>',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="Task_2"/>',
      '    <sequenceFlow id="Flow_3" sourceRef="Task_2" targetRef="Gateway_1"/>',
      '    <sequenceFlow id="Flow_4" sourceRef="Gateway_1" targetRef="Task_3">',
      '      <conditionExpression xsi:type="tFormalExpression">isRetryComplete</conditionExpression>',
      "    </sequenceFlow>",
      '    <sequenceFlow id="Flow_5" sourceRef="Gateway_1" targetRef="Task_4"/>',
      '    <sequenceFlow id="Flow_6" sourceRef="Task_4" targetRef="Task_2"/>',
      '    <sequenceFlow id="Flow_7" sourceRef="Task_3" targetRef="End_1"/>',
    ].join("\n"),
  );
}

function sequentialServiceTaskWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1"/>',
      nativeServiceTask({
        id: "Task_List",
        name: "List files",
        documentation: "List files and output fileList.",
        outputs: ["fileList"],
      }),
      nativeServiceTask({
        id: "Task_Report",
        name: "Report files",
        documentation: "Write a report from fileList.",
        inputs: ["fileList"],
        outputs: ["report"],
      }),
      '    <endEvent id="End_1"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_List"/>',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_List" targetRef="Task_Report"/>',
      '    <sequenceFlow id="Flow_3" sourceRef="Task_Report" targetRef="End_1"/>',
    ].join("\n"),
  );
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
