import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type Context } from "@mariozechner/pi-ai";
import {
  execute,
  mapHumanTaskReplyToOutputs,
  type QianjiHostWorkEvent,
} from "../../src/executor/executor.js";
import type { PiWendaoAgentHost } from "../../src/executor/agent-host.js";
import { buildPiWendaoConfigMap } from "../../src/executor/bpmn-config.js";
import { buildQianjiArgs, runQianjiCli } from "../../src/executor/qianji-cli.js";
import { GraphView } from "../../src/ui/graph-view.js";

const fixturesDir = join(import.meta.dirname, "../fixtures");
const tempDirs: string[] = [];

describe("executor", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
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
      hostFixtureSeen: true,
      fixtureServiceTasks: ["Task_1"],
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
    const run = runQianjiCli(
      process.execPath,
      ["-e", "setTimeout(() => {}, 10000)"],
      process.cwd(),
      () => undefined,
      controller.signal,
    );

    setTimeout(() => controller.abort(), 25);

    await expect(run).rejects.toMatchObject({ name: "WorkflowInterruptedError" });
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
      expect(prompts[0]).toContain("Qianji BPMN execution context");
      expect(prompts[0]).toContain("processId: Process_1");
      expect(prompts[0]).toContain("instanceId: wf_token_host");
      expect(prompts[0]).toContain("activityId: Task_Review");
      expect(prompts[0]).toContain("tokenId: 11");
      expect(prompts[0]).toContain("checkpoint.backend: duckdb");
      expect(prompts[0]).toContain("checkpoint.source: fresh");
      expect(prompts[0]).toContain("checkpoint.pendingHostWork: 2");
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
      { activityId: "Task_Review", tokenId: 11, item: "alpha", subagentType: "pi-wendao-worker" },
      { activityId: "Task_Review", tokenId: 12, item: "beta", subagentType: "pi-wendao-worker" },
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
      "subagent:pi-wendao-worker",
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
        prompts.push(request.config.prompt);
        expect(request.config.interaction).toEqual({
          type: "choice_input",
          question: "How should the workflow proceed?",
          choices: [
            {
              value: "approved",
              label: "Approve",
              description: "Continue to the next BPMN checkpoint.",
            },
            { value: "rejected", label: "Reject", description: "Stop and revise the plan." },
          ],
          freeText: { name: "approvedReply", optional: true },
          result: { output: "approvedReply" },
        });
        return "y";
      },
      graphView,
      traceFrameDelayMs: 0,
    });

    expect(result.success).toBe(true);
    expect(prompts).toEqual(["Review the proposal and approve before continuing."]);
    expect(result.rawOutput).not.toContain("@@QIANJI_HOST_WORK");
    expect(result.variables).toMatchObject({
      approved: true,
      approvedReply: "y",
      fixtureUserTasks: ["Task_Approve"],
    });
    const internals = graphView as unknown as {
      nodes: Map<string, { details?: string[] }>;
    };
    expect(internals.nodes.get("Task_Approve")?.details).toContain("host:user:1 human");
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
    expect(result.error).toContain("Producer activity: Task_PrepareQuestion");
    expect(result.error).toContain("Variable: currentChoices");
    expect(result.error).toContain("Item: 1");
    expect(result.error).toContain("Problem: item is missing required non-empty value");
    expect(result.error).toContain(
      "Help: currentChoices must be Array<{ value: string; label?: string; description?: string }>.",
    );
    expect(result.error).toContain('Contract: qianji:outputSchema kind="choice_array"');
    expect(result.error).toContain('"currentChoices": [');
    expect(result.error).toContain('"value": "minimal"');
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
      approved: true,
      finalStatus: "fixture-completed",
      fixtureServiceTaskTokens: ["52"],
      fixtureUserTasks: ["Task_Approve"],
    });
  });

  it("parses qianji dynamic choices refs from BPMN userTask metadata", () => {
    const configs = buildPiWendaoConfigMap(dynamicHumanQuestionWorkflow(), "Process_1");

    expect(configs.get("Task_Approve")?.interaction).toMatchObject({
      type: "choice_input",
      questionRef: "proposal",
      choicesRef: "currentChoices",
      result: { output: "userAnswer" },
    });
    expect(configs.get("Task_Approve")?.interaction?.choices).toBeUndefined();
  });

  it("maps human replies to approval booleans and raw reply outputs", () => {
    expect(mapHumanTaskReplyToOutputs("n", ["approved", "approvedReply", "feedback"])).toEqual({
      approved: false,
      approvedReply: "n",
      feedback: "n",
    });
    expect(mapHumanTaskReplyToOutputs("revise", ["designApproved", "designFeedback"])).toEqual({
      designApproved: false,
      designFeedback: "revise",
    });
    expect(mapHumanTaskReplyToOutputs("changes", ["specApproved", "specFeedback"])).toEqual({
      specApproved: false,
      specFeedback: "changes",
    });
    expect(mapHumanTaskReplyToOutputs("approved", ["approved"])).toEqual({ approved: true });
    expect(mapHumanTaskReplyToOutputs("yes", ["needsMoreQuestions"])).toEqual({
      needsMoreQuestions: true,
    });
    expect(mapHumanTaskReplyToOutputs("no", ["needsMoreQuestions"])).toEqual({
      needsMoreQuestions: false,
    });
    expect(mapHumanTaskReplyToOutputs("false", ["redFlagDetected"])).toEqual({
      redFlagDetected: false,
    });
    expect(mapHumanTaskReplyToOutputs("true", ["redFlagDetected"])).toEqual({
      redFlagDetected: true,
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
  writeFakeExternalHostQianjiScript(scriptPath);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeUserTaskExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-user-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-user-host.cjs");
  writeFakeUserTaskExternalHostQianjiScript(scriptPath);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeRepeatingUserTaskExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-repeating-user-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-repeating-user-host.cjs");
  writeFakeRepeatingUserTaskExternalHostQianjiScript(scriptPath);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeProgressingUserTaskExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-progressing-user-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-progressing-user-host.cjs");
  writeFakeProgressingUserTaskExternalHostQianjiScript(scriptPath);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeUserThenServiceExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-user-service-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-user-service-host.cjs");
  writeFakeUserThenServiceExternalHostQianjiScript(scriptPath);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeServiceThenUserExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-service-user-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-service-user-host.cjs");
  writeFakeServiceThenUserExternalHostQianjiScript(scriptPath);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeSequentialExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-sequential-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-sequential-host.cjs");
  writeFakeSequentialExternalHostQianjiScript(scriptPath);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeRetryLoopExternalHostQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-retry-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-retry-host.cjs");
  writeFakeRetryLoopExternalHostQianjiScript(scriptPath);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeSingleHostBoundaryQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-single-host-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-single-host.cjs");
  writeFakeSingleHostBoundaryQianjiScript(scriptPath);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
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
if (args.includes("--checkpoint-runtime") || args.includes("--checkpoint-sqlite")) {
  console.error("pi-wendao must let qianji choose its checkpoint backend: " + args.join(" "));
  process.exit(65);
}
if (args[1] === "run") {
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
  const hostFixture = JSON.parse(readFileSync(get("--host-fixture"), "utf-8"));
  const serviceTaskTokens = hostFixture.service_task_tokens ?? {};
  const tokenIds = Object.keys(serviceTaskTokens);
  if (args.includes("--trace-stream")) {
    console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", node_id: "Task_Review", node_kind: "service_task", status: "completed" }));
  }
  printVariables("BPMN Task Complete", "completed", {
    results: tokenIds.map((tokenId) => serviceTaskTokens[tokenId].data.result),
    fixtureServiceTaskTokens: tokenIds,
  });
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
    variables: {
      proposal: "Ship the plan",
      currentChoices: [
        { value: "direct", label: "Use direct path", description: "Proceed with the shortest implementation path." },
        { value: "research", label: "Research first", description: "Pause and gather more context." },
      ],
    },
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
  const hostFixture = JSON.parse(readFileSync(get("--host-fixture"), "utf-8"));
  const userTasks = hostFixture.user_tasks ?? {};
  if (args.includes("--trace-stream")) {
    console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", node_id: "Task_Approve", node_kind: "user_task", status: "completed" }));
  }
  printVariables("BPMN Task Complete", "completed", {
    ...userTasks.Task_Approve?.data,
    fixtureUserTasks: Object.keys(userTasks),
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
  JSON.parse(readFileSync(get("--host-fixture"), "utf-8"));
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
  const hostFixture = JSON.parse(readFileSync(get("--host-fixture"), "utf-8"));
  const userTasks = hostFixture.user_tasks ?? {};
  state.variables = { ...state.variables, ...userTasks.Task_Approve?.data };
  if (state.step === 1) {
    save({ step: 2, variables: state.variables });
    emitUserTask("BPMN Task Complete", "Second question?", 52, state.variables);
    process.exit(0);
  }
  printCompleted({
    ...state.variables,
    fixtureUserTasks: Object.keys(userTasks),
  });
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
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
  }));
  printVariables("BPMN Run", "blocked_on_host", {}, 1);
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const state = load();
  const hostFixture = JSON.parse(readFileSync(get("--host-fixture"), "utf-8"));
  const userTasks = hostFixture.user_tasks ?? {};
  const serviceTaskTokens = hostFixture.service_task_tokens ?? {};
  if (userTasks.Task_Approve) {
    state.variables = { ...state.variables, ...userTasks.Task_Approve.data };
    save(state);
    console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
      kind: "service",
      node_id: "Task_Final",
      node_index: 2,
      token_id: 52,
      variables: state.variables,
    }));
    printVariables("BPMN Task Complete", "blocked_on_host", {
      ...state.variables,
      fixtureUserTasks: Object.keys(userTasks),
    }, 1);
    process.exit(0);
  }
  if (serviceTaskTokens["52"]) {
    state.variables = { ...state.variables, ...serviceTaskTokens["52"].data };
    save(state);
    printVariables("BPMN Task Complete", "completed", {
      ...state.variables,
      fixtureServiceTaskTokens: Object.keys(serviceTaskTokens),
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
  const hostFixture = JSON.parse(readFileSync(get("--host-fixture"), "utf-8"));
  const serviceTaskTokens = hostFixture.service_task_tokens ?? {};
  const userTasks = hostFixture.user_tasks ?? {};
  if (serviceTaskTokens["61"]) {
    state.variables = { ...state.variables, ...serviceTaskTokens["61"].data };
    save(state);
    console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
      kind: "user",
      node_id: "Task_AskQuestion",
      node_index: 2,
      token_id: 62,
      variables: state.variables,
    }));
    printVariables("BPMN Task Complete", "blocked_on_host", state.variables, 1);
    process.exit(0);
  }
  if (userTasks.Task_AskQuestion) {
    state.variables = { ...state.variables, ...userTasks.Task_AskQuestion.data };
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
  const hostFixture = JSON.parse(readFileSync(get("--host-fixture"), "utf-8"));
  const serviceTaskTokens = hostFixture.service_task_tokens ?? {};
  if (serviceTaskTokens["21"]) {
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
  printVariables("BPMN Task Complete", "completed", serviceTaskTokens["22"]?.data ?? {});
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
  const hostFixture = JSON.parse(readFileSync(get("--host-fixture"), "utf-8"));
  const serviceTaskTokens = hostFixture.service_task_tokens ?? {};
  const tokenId = Object.keys(serviceTaskTokens)[0];
  const data = serviceTaskTokens[tokenId]?.data ?? {};
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
  const hostFixture = JSON.parse(readFileSync(get("--host-fixture"), "utf-8"));
  const serviceTaskTokens = hostFixture.service_task_tokens ?? {};
  const tokenId = Object.keys(serviceTaskTokens)[0];
  printVariables("BPMN Task Complete", "completed", serviceTaskTokens[tokenId]?.data ?? {});
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
	`,
    "utf-8",
  );
}

function tokenScopedServiceTaskWorkflow(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
	<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:qianji="https://qianji.dev/bpmn/extensions"
             id="Definitions_1"
             targetNamespace="https://qianji.dev">
  <process id="Process_1" isExecutable="true">
    <startEvent id="Start_1"/>
    <serviceTask id="Task_Review" name="Review item" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Review the current item and output result.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs>item</qianji:inputs>
          <qianji:outputs>result</qianji:outputs>
          <qianji:agentType>pi-wendao-worker</qianji:agentType>
          <qianji:runInBackground>true</qianji:runInBackground>
          <qianji:maxTurns>8</qianji:maxTurns>
        </qianji:config>
      </extensionElements>
      <multiInstanceLoopCharacteristics>
        <loopDataInputRef>items</loopDataInputRef>
        <inputDataItem id="item"/>
        <loopDataOutputRef>results</loopDataOutputRef>
        <outputDataItem id="result"/>
      </multiInstanceLoopCharacteristics>
    </serviceTask>
    <endEvent id="End_1"/>
    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Review"/>
    <sequenceFlow id="Flow_2" sourceRef="Task_Review" targetRef="End_1"/>
	</process>
	</definitions>`;
}

function humanApprovalWorkflow(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
	<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:qianji="https://qianji.dev/bpmn/extensions"
             id="Definitions_1"
             targetNamespace="https://qianji.dev">
  <process id="Process_1" isExecutable="true">
    <startEvent id="Start_1"/>
    <userTask id="Task_Approve" name="Approve proposal">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Review the proposal and approve before continuing.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs>proposal</qianji:inputs>
          <qianji:outputs>approved,approvedReply</qianji:outputs>
          <qianji:interaction type="choice_input">
            <qianji:question>How should the workflow proceed?</qianji:question>
            <qianji:choice value="approved" label="Approve">Continue to the next BPMN checkpoint.</qianji:choice>
            <qianji:choice value="rejected" label="Reject">Stop and revise the plan.</qianji:choice>
            <qianji:freeText name="approvedReply" optional="true"/>
            <qianji:result output="approvedReply"/>
          </qianji:interaction>
        </qianji:config>
      </extensionElements>
    </userTask>
    <endEvent id="End_1"/>
    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Approve"/>
    <sequenceFlow id="Flow_2" sourceRef="Task_Approve" targetRef="End_1"/>
	</process>
	</definitions>`;
}

function dynamicHumanQuestionWorkflow(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
	<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:qianji="https://qianji.dev/bpmn/extensions"
             id="Definitions_1"
             targetNamespace="https://qianji.dev">
  <process id="Process_1" isExecutable="true">
    <startEvent id="Start_1"/>
    <userTask id="Task_Approve" name="Answer generated question">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Answer the generated question.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs>proposal,currentChoices</qianji:inputs>
          <qianji:outputs>userAnswer</qianji:outputs>
          <qianji:interaction type="choice_input">
            <qianji:question>proposal</qianji:question>
            <qianji:choices ref="currentChoices"/>
            <qianji:result output="userAnswer"/>
          </qianji:interaction>
        </qianji:config>
      </extensionElements>
    </userTask>
    <endEvent id="End_1"/>
    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Approve"/>
    <sequenceFlow id="Flow_2" sourceRef="Task_Approve" targetRef="End_1"/>
	</process>
	</definitions>`;
}

function serviceGeneratedDynamicChoicesWorkflow(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
	<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:qianji="https://qianji.dev/bpmn/extensions"
             id="Definitions_1"
             targetNamespace="https://qianji.dev">
  <process id="Process_1" isExecutable="true">
    <startEvent id="Start_1"/>
    <serviceTask id="Task_PrepareQuestion" name="Prepare generated question" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Output currentQuestion and currentChoices.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs>context</qianji:inputs>
          <qianji:outputs>currentQuestion,currentChoices</qianji:outputs>
          <qianji:outputSchema name="currentChoices" kind="choice_array" value="required" label="optional" description="optional"/>
        </qianji:config>
      </extensionElements>
    </serviceTask>
    <userTask id="Task_AskQuestion" name="Answer generated question">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Answer the generated question.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs>currentQuestion,currentChoices</qianji:inputs>
          <qianji:outputs>userAnswer</qianji:outputs>
          <qianji:interaction type="choice_input">
            <qianji:question ref="currentQuestion"/>
            <qianji:choices ref="currentChoices"/>
            <qianji:result output="userAnswer"/>
          </qianji:interaction>
        </qianji:config>
      </extensionElements>
    </userTask>
    <endEvent id="End_1"/>
    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_PrepareQuestion"/>
    <sequenceFlow id="Flow_2" sourceRef="Task_PrepareQuestion" targetRef="Task_AskQuestion"/>
    <sequenceFlow id="Flow_3" sourceRef="Task_AskQuestion" targetRef="End_1"/>
	</process>
	</definitions>`;
}

function userThenServiceWorkflow(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
	<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
	             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
	             xmlns:qianji="https://qianji.dev/bpmn/extensions"
	             id="Definitions_1"
	             targetNamespace="https://qianji.dev">
	  <process id="Process_1" isExecutable="true">
	    <startEvent id="Start_1"/>
	    <userTask id="Task_Approve" name="Approve">
	      <extensionElements>
	        <qianji:config>
	          <qianji:prompt>Approve before running the final service task.</qianji:prompt>
	          <qianji:tools></qianji:tools>
	          <qianji:inputs></qianji:inputs>
	          <qianji:outputs>approved</qianji:outputs>
	          <qianji:interaction type="confirm">
	            <qianji:question>Continue?</qianji:question>
	            <qianji:result output="approved"/>
	          </qianji:interaction>
	        </qianji:config>
	      </extensionElements>
	    </userTask>
	    <serviceTask id="Task_Final" name="Final service" implementation="\${environment.services.runAgent}">
	      <extensionElements>
	        <qianji:config>
	          <qianji:prompt>Run final service task.</qianji:prompt>
	          <qianji:tools></qianji:tools>
	          <qianji:inputs>approved</qianji:inputs>
	          <qianji:outputs>finalStatus</qianji:outputs>
	        </qianji:config>
	      </extensionElements>
	    </serviceTask>
	    <endEvent id="End_1"/>
	    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Approve"/>
	    <sequenceFlow id="Flow_2" sourceRef="Task_Approve" targetRef="Task_Final"/>
	    <sequenceFlow id="Flow_3" sourceRef="Task_Final" targetRef="End_1"/>
	  </process>
	</definitions>`;
}

function promptDerivedOutputWorkflow(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
	<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
	             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
	             xmlns:qianji="https://qianji.dev/bpmn/extensions"
	             id="Definitions_1"
	             targetNamespace="https://qianji.dev">
	  <process id="Process_1" isExecutable="true">
	    <startEvent id="Start_1"/>
	    <serviceTask id="Task_SetStatus" name="Set status" implementation="\${environment.services.runAgent}">
	      <extensionElements>
	        <qianji:config>
	          <qianji:prompt>Set status to "ready". Output status.</qianji:prompt>
	          <qianji:tools></qianji:tools>
	          <qianji:inputs></qianji:inputs>
	          <qianji:outputs>status</qianji:outputs>
	        </qianji:config>
	      </extensionElements>
	    </serviceTask>
	    <endEvent id="End_1"/>
	    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_SetStatus"/>
	    <sequenceFlow id="Flow_2" sourceRef="Task_SetStatus" targetRef="End_1"/>
	  </process>
	</definitions>`;
}

function retryLoopWorkflow(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
	<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:qianji="https://qianji.dev/bpmn/extensions"
             id="Definitions_1"
             targetNamespace="https://qianji.dev">
  <process id="Process_1" isExecutable="true">
    <startEvent id="Start_1"/>
    <serviceTask id="Task_1" name="Initialize system" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Set retryCount to 1 and status to "not ready". Output both variables.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs></qianji:inputs>
          <qianji:outputs>retryCount,status</qianji:outputs>
        </qianji:config>
      </extensionElements>
    </serviceTask>
    <serviceTask id="Task_2" name="Check retry count" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Check if retryCount is greater than or equal to 3. Output isRetryComplete as true if retryCount &gt;= 3, false otherwise. Also output the current retryCount value.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs>retryCount</qianji:inputs>
          <qianji:outputs>isRetryComplete,retryCount</qianji:outputs>
        </qianji:config>
      </extensionElements>
    </serviceTask>
    <exclusiveGateway id="Gateway_1" name="Retry complete?" default="Flow_5"/>
    <serviceTask id="Task_3" name="Set status ready" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Set status to "ready". Output status as "ready".</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs></qianji:inputs>
          <qianji:outputs>status</qianji:outputs>
        </qianji:config>
      </extensionElements>
    </serviceTask>
    <serviceTask id="Task_4" name="Increment retry count" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Increment retryCount by 1. Output the new retryCount value.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs>retryCount</qianji:inputs>
          <qianji:outputs>retryCount</qianji:outputs>
        </qianji:config>
      </extensionElements>
    </serviceTask>
    <endEvent id="End_1"/>
    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1"/>
    <sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="Task_2"/>
    <sequenceFlow id="Flow_3" sourceRef="Task_2" targetRef="Gateway_1"/>
    <sequenceFlow id="Flow_4" sourceRef="Gateway_1" targetRef="Task_3">
      <conditionExpression xsi:type="tFormalExpression">isRetryComplete</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="Flow_5" sourceRef="Gateway_1" targetRef="Task_4"/>
    <sequenceFlow id="Flow_6" sourceRef="Task_4" targetRef="Task_2"/>
    <sequenceFlow id="Flow_7" sourceRef="Task_3" targetRef="End_1"/>
  </process>
</definitions>`;
}

function sequentialServiceTaskWorkflow(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:qianji="https://qianji.dev/bpmn/extensions"
             id="Definitions_1"
             targetNamespace="https://qianji.dev">
  <process id="Process_1" isExecutable="true">
    <startEvent id="Start_1"/>
    <serviceTask id="Task_List" name="List files" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>List files and output fileList.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs></qianji:inputs>
          <qianji:outputs>fileList</qianji:outputs>
        </qianji:config>
      </extensionElements>
    </serviceTask>
    <serviceTask id="Task_Report" name="Report files" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Write a report from fileList.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs>fileList</qianji:inputs>
          <qianji:outputs>report</qianji:outputs>
        </qianji:config>
      </extensionElements>
    </serviceTask>
    <endEvent id="End_1"/>
    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_List"/>
    <sequenceFlow id="Flow_2" sourceRef="Task_List" targetRef="Task_Report"/>
    <sequenceFlow id="Flow_3" sourceRef="Task_Report" targetRef="End_1"/>
  </process>
</definitions>`;
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
