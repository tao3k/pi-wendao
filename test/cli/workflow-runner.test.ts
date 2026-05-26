import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { runWorkflowInRenderer } from "../../src/cli/workflow-runner.js";
import { GraphView } from "../../src/ui/graph-view.js";
import type { PlannerReplyRequest, QianjiTraceLogEvent, Renderer } from "../../src/ui/renderer.js";
import type { PiWendaoAgentEvent } from "../../src/executor/agent-runtime-types.js";
import {
  nativeDefinitions,
  nativeHumanTask,
  nativeServiceTask,
} from "../support/native-bpmn.js";

const fixturesDir = join(import.meta.dirname, "../fixtures");
const tempDirs: string[] = [];

describe("workflow runner", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves renderer receiver state for qianji trace callbacks", async () => {
    const renderer = new ReceiverSensitiveRenderer();
    const workflowPath = join(fixturesDir, "simple-workflow.bpmn");

    const result = await runWorkflowInRenderer({
      renderer,
      useGraph: true,
      resolvedWorkflowPath: workflowPath,
      options: {
        qianji: makeFakeQianjiPath(),
        traceFrameMs: 0,
      },
      invocationCwd: fixturesDir,
      piContextCwd: fixturesDir,
      resolvedDmnPaths: [],
      thinkingLevel: "medium",
    });

    expect(result.success).toBe(true);
    expect(renderer.traceEvents).toBeGreaterThan(0);
    expect(renderer.flowTakes).toEqual(["Start_1->Task_1", "Task_1->End_1"]);
    expect(renderer.errors).toEqual([]);
  });

  it("blocks execution when qianji lint preflight fails", async () => {
    const renderer = new ReceiverSensitiveRenderer();
    const workflowPath = join(fixturesDir, "simple-workflow.bpmn");

    const result = await runWorkflowInRenderer({
      renderer,
      useGraph: false,
      resolvedWorkflowPath: workflowPath,
      options: {
        qianji: makeFakeQianjiPath({
          lintExitCode: 2,
          lintOutput: "[lint:error] old BPMN contract drift",
        }),
        traceFrameMs: 0,
      },
      invocationCwd: fixturesDir,
      piContextCwd: fixturesDir,
      resolvedDmnPaths: [],
      thinkingLevel: "medium",
    });

    expect(result.success).toBe(false);
    expect(renderer.logs.join("\n")).toContain("[lint:error] old BPMN contract drift");
    expect(renderer.logs.join("\n")).toContain("Workflow was not started.");
    expect(renderer.traceEvents).toBe(0);
    expect(renderer.flowTakes).toEqual([]);
  });

  it("repairs BPMN with the pi-wendao model before execution", async () => {
    const renderer = new ReceiverSensitiveRenderer();
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-workflow-repair-"));
    tempDirs.push(dir);
    const workflowPath = join(dir, "old-workflow.bpmn");
    const repairedXml = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
    writeFileSync(workflowPath, repairedXml.replace("List files", "needs-repair"), "utf-8");
    const faux = registerFauxProvider();
    faux.setResponses([fauxAssistantMessage("```bpmn\n" + repairedXml + "\n```")]);

    try {
      const result = await runWorkflowInRenderer({
        renderer,
        useGraph: true,
        resolvedWorkflowPath: workflowPath,
        options: {
          qianji: makeFakeQianjiPath({
            lintFailureMarker: "needs-repair",
            lintOutput: "[lint:error] old BPMN contract drift",
          }),
          traceFrameMs: 0,
        },
        invocationCwd: fixturesDir,
        piContextCwd: fixturesDir,
        resolvedDmnPaths: [],
        thinkingLevel: "medium",
        resolveRepairModel: async () => ({ model: faux.getModel() }),
      });

      expect(result.success).toBe(true);
      expect(renderer.logs.join("\n")).toContain("requesting BPMN repair 1/2");
      expect(renderer.logs.join("\n")).toContain("qianji lint preflight passed after repair");
      expect(renderer.flowTakes).toEqual(["Start_1->Task_1", "Task_1->End_1"]);
    } finally {
      faux.unregister();
    }
  });

  it("repairs stale pi-wendao interaction contracts before execution", async () => {
    const renderer = new ReceiverSensitiveRenderer();
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-workflow-contract-repair-"));
    tempDirs.push(dir);
    const workflowPath = join(dir, "old-interaction-workflow.bpmn");
    writeFileSync(workflowPath, staleStaticPiAskProducerWorkflow(), "utf-8");
    const faux = registerFauxProvider();
    faux.setResponses([fauxAssistantMessage("```bpmn\n" + staticPiAskChoicesWorkflow() + "\n```")]);

    try {
      const result = await runWorkflowInRenderer({
        renderer,
        useGraph: false,
        resolvedWorkflowPath: workflowPath,
        options: {
          qianji: makeFakeQianjiPath(),
          traceFrameMs: 0,
        },
        invocationCwd: fixturesDir,
        piContextCwd: fixturesDir,
        resolvedDmnPaths: [],
        thinkingLevel: "medium",
        resolveRepairModel: async () => ({ model: faux.getModel() }),
      });

      expect(result.success).toBe(true);
      expect(renderer.logs.join("\n")).toContain("requesting BPMN repair 1/2");
      expect(renderer.logs.join("\n")).toContain("qianji lint preflight passed after repair");
    } finally {
      faux.unregister();
    }
  });

  it("uses cached qianji lint preflight for unchanged workflow content", async () => {
    const renderer = new ReceiverSensitiveRenderer();
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-workflow-lint-cache-"));
    tempDirs.push(dir);
    const workflowPath = join(dir, "workflow.bpmn");
    const lintCountPath = join(dir, "lint-count.txt");
    const originalCacheHome = process.env.PRJ_CACHE_HOME;
    const workflowSource = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
    writeFileSync(workflowPath, workflowSource, "utf-8");

    try {
      process.env.PRJ_CACHE_HOME = join(dir, ".cache");
      const qianji = makeFakeQianjiPath({ lintCountPath });
      const run = () =>
        runWorkflowInRenderer({
          renderer,
          useGraph: false,
          resolvedWorkflowPath: workflowPath,
          options: {
            qianji,
            traceFrameMs: 0,
          },
          invocationCwd: dir,
          piContextCwd: dir,
          resolvedDmnPaths: [],
          thinkingLevel: "medium",
        });

      expect((await run()).success).toBe(true);
      expect(readFileSync(lintCountPath, "utf-8")).toBe("1");

      expect((await run()).success).toBe(true);
      expect(readFileSync(lintCountPath, "utf-8")).toBe("1");
      expect(renderer.logs.join("\n")).toContain("qianji lint preflight cache hit");

      writeFileSync(workflowPath, workflowSource.replace("List files", "List files again"), "utf-8");
      expect((await run()).success).toBe(true);
      expect(readFileSync(lintCountPath, "utf-8")).toBe("2");
    } finally {
      restoreEnv("PRJ_CACHE_HOME", originalCacheHome);
    }
  });

  it("reports malformed service-produced dynamic choices during no-graph runs before prompting", async () => {
    const renderer = new ReceiverSensitiveRenderer();
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-workflow-runner-choices-"));
    tempDirs.push(dir);
    const workflowPath = join(dir, "service-generated-choices.bpmn");
    const hostFixturePath = join(dir, "host-fixture.json");
    writeFileSync(workflowPath, serviceGeneratedDynamicChoicesWorkflow(), "utf-8");
    writeFileSync(
      hostFixturePath,
      JSON.stringify(
        {
          service_tasks: {
            Task_PrepareQuestion: {
              data: {
                currentQuestion: "Which BPMN interaction test should run next?",
                currentChoices: {
                  kind: "choice_array",
                  value: [
                    {
                      value: "test_fixtures",
                      label: "BPMN fixture-based integration tests",
                      description: "Debug or extend BPMN fixture-driven Vitest coverage.",
                    },
                  ],
                },
              },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await runWorkflowInRenderer({
      renderer,
      useGraph: false,
      resolvedWorkflowPath: workflowPath,
      options: {
        qianji: makeFakeServiceThenUserQianjiPath(),
        traceFrameMs: 0,
      },
      invocationCwd: dir,
      piContextCwd: dir,
      resolvedDmnPaths: [],
      resolvedHostFixturePath: hostFixturePath,
      thinkingLevel: "medium",
    });

    const output = [renderer.errors.join("\n"), renderer.logs.join("\n")].join("\n");
    expect(result.success).toBe(false);
    expect(output).toContain("[pi-wendao.runtime.invalid_dynamic_choices]");
    expect(output).toContain("Consumer activity: Task_AskQuestion");
    expect(output).toContain("Variable: currentChoices");
    expect(output).toContain("Problem: ref did not resolve to a JSON array");
    expect(output).toContain(
      'Bad payload: {"kind":"choice_array","value":[{"value":"test_fixtures"',
    );
    expect(output).toContain("Expected value:");
    expect(renderer.logs.join("\n")).not.toContain("human task Task_AskQuestion");
    expect(renderer.plannerReplyRequests).toBe(0);
  });
});

class ReceiverSensitiveRenderer implements Renderer {
  readonly graphView = new GraphView();
  readonly logs: string[] = [];
  readonly errors: string[] = [];
  traceEvents = 0;
  flowTakes: string[] = [];
  plannerReplyRequests = 0;

  onAgentEvent(_event: PiWendaoAgentEvent): void {
    this.assertReceiver();
  }

  onNodeStart(_activityId: string, _activityName: string): void {
    this.assertReceiver();
  }

  onNodeEnd(_activityId: string, _activityName: string): void {
    this.assertReceiver();
  }

  onFlowTake(flowId: string): void {
    this.assertReceiver();
    this.flowTakes.push(flowId);
  }

  onTraceEvent(_event: QianjiTraceLogEvent): void {
    this.assertReceiver();
    this.traceEvents += 1;
  }

  onError(error: Error): void {
    this.assertReceiver();
    this.errors.push(error.message);
  }

  printVariables(variables: Record<string, unknown>): void {
    this.assertReceiver();
    this.logs.push(JSON.stringify(variables));
  }

  appendLog(text: string): void {
    this.assertReceiver();
    this.logs.push(text);
  }

  async requestPlannerReply(_request: PlannerReplyRequest, _signal?: AbortSignal): Promise<string> {
    this.assertReceiver();
    this.plannerReplyRequests += 1;
    return "approved";
  }

  async waitForKey(): Promise<void> {
    this.assertReceiver();
  }

  refresh(): void {
    this.assertReceiver();
  }

  start(): void {
    this.assertReceiver();
  }

  stop(): void {
    this.assertReceiver();
  }

  private assertReceiver(): void {
    if (!(this instanceof ReceiverSensitiveRenderer)) {
      throw new Error("renderer receiver was not preserved");
    }
  }
}

function makeFakeQianjiPath(
  options: {
    lintExitCode?: number;
    lintOutput?: string;
    lintFailureMarker?: string;
    lintCountPath?: string;
  } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-workflow-runner-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "qianji");
  writeFakeQianjiScript(scriptPath, options);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeFakeQianjiScript(
  scriptPath: string,
  options: {
    lintExitCode?: number;
    lintOutput?: string;
    lintFailureMarker?: string;
    lintCountPath?: string;
  },
): void {
  const lintExitCode = options.lintExitCode;
  const lintOutput = options.lintOutput ?? "[ok] lint passed";
  const lintFailureMarker = options.lintFailureMarker;
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
if (args[0] === "lint") {
  const lintCountPath = ${JSON.stringify(options.lintCountPath)};
  if (lintCountPath) {
    const previous = existsSync(lintCountPath) ? Number(readFileSync(lintCountPath, "utf-8")) : 0;
    writeFileSync(lintCountPath, String(previous + 1));
  }
  const lintBpmnPath = get("--bpmn");
  if (${JSON.stringify(lintFailureMarker)} && lintBpmnPath) {
    const source = readFileSync(lintBpmnPath, "utf-8");
    if (source.includes(${JSON.stringify(lintFailureMarker)})) {
      console.log(${JSON.stringify(lintOutput)});
      process.exit(2);
    }
    console.log("[ok] lint passed");
    process.exit(0);
  }
  console.log(${JSON.stringify(lintOutput)});
  process.exit(${lintExitCode ?? 0});
}
if (args[0] !== "bpmn" || (args[1] !== "run" && args[1] !== "host-session" && args[1] !== "status")) {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
const context = JSON.parse(get("--context-json") ?? "{}");
const hostFixturePath = get("--host-fixture");
if (hostFixturePath) readFileSync(hostFixturePath, "utf-8");
const trace = [
  { sequence: 1, kind: "node_status", process_id: get("--process"), node_id: "Start_1", node_kind: "start_event", status: "queued" },
  { sequence: 2, kind: "node_status", process_id: get("--process"), node_id: "Start_1", node_kind: "start_event", status: "completed" },
  { sequence: 3, kind: "flow_take", process_id: get("--process"), source_id: "Start_1", target_id: "Task_1" },
  { sequence: 4, kind: "node_status", process_id: get("--process"), node_id: "Task_1", node_kind: "service_task", status: "executing" },
  { sequence: 5, kind: "node_status", process_id: get("--process"), node_id: "Task_1", node_kind: "service_task", status: "completed" },
  { sequence: 6, kind: "flow_take", process_id: get("--process"), source_id: "Task_1", target_id: "End_1" },
  { sequence: 7, kind: "node_status", process_id: get("--process"), node_id: "End_1", node_kind: "end_event", status: "completed" }
];
const fence = String.fromCharCode(96, 96, 96);
if (args.includes("--trace-stream")) {
  for (const event of trace) {
    console.log("@@QIANJI_TRACE " + JSON.stringify(event));
  }
}
if (args[1] === "status") {
  console.log("@@QIANJI_SESSION_RESULT " + JSON.stringify({
    exitCode: 0,
    stdout: "qianji status: missing (checkpoint=duckdb, source=fresh, saved=no, deleted=no, pending_host=0)",
    stderr: "",
    outcome: "missing",
    checkpoint: { backend: "duckdb", source: "fresh", saved: "no", deleted: "no", status: "missing" },
    pendingHostWork: 0,
    variables: {},
  }));
  process.exit(0);
}
if (args[1] === "host-session") {
  console.log("@@QIANJI_SESSION_RESULT " + JSON.stringify({
    exitCode: 0,
    stdout: "qianji run: completed (checkpoint=duckdb, source=fresh, saved=yes, deleted=no, pending_host=0)",
    stderr: "",
    outcome: "completed",
    checkpoint: { backend: "duckdb", source: "fresh", saved: "yes", deleted: "no", status: "saved" },
    pendingHostWork: 0,
    variables: { ...context, ok: true },
  }));
  process.exit(0);
}
console.log("# BPMN Run\\n\\nOutcome: completed\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify({ ...context, ok: true }, null, 2) + "\\n" + fence + "\\n");
`,
    "utf-8",
  );
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function makeFakeServiceThenUserQianjiPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-workflow-runner-service-user-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "qianji");
  writeFakeServiceThenUserQianjiScript(scriptPath);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeFakeServiceThenUserQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const readline = require("node:readline");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const state = { variables: {} };
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
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args[1] !== "host-session") {
  console.error("non-session qianji command should not be used: " + args.join(" "));
  process.exit(64);
}
console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: "Task_PrepareQuestion",
    node_index: 1,
    token_id: 61,
    variables: {},
}));
emitResult("qianji run", "blocked_on_host", {}, 1, "fresh");
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
  const hostFixture = get("--host-fixture") ? JSON.parse(readFileSync(get("--host-fixture"), "utf-8")) : {};
  const serviceTaskTokens = hostFixture.service_task_tokens ?? {};
  const userTasks = hostFixture.user_tasks ?? {};
  if (request.kind === "service" || serviceTaskTokens["61"]) {
    state.variables = { ...state.variables, ...(serviceTaskTokens["61"]?.data ?? request.data) };
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
    emitResult("qianji task complete", "blocked_on_host", state.variables, 1);
    return;
  }
  state.variables = { ...state.variables, ...(userTasks.Task_AskQuestion?.data ?? request.data) };
  emitResult("qianji task complete", "completed", state.variables, 0);
});
`,
    "utf-8",
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

function staleStaticPiAskProducerWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1"/>',
      `    <userTask id="Task_Screen" name="Safety screen">
      <documentation>Answer the safety screen.</documentation>
      <ioSpecification>
        <dataInput id="Task_Screen_input_interactionType" name="interactionType" />
        <dataOutput id="Task_Screen_output_answer" name="answer" />
        <inputSet id="Task_Screen_input_set">
          <dataInputRefs>Task_Screen_input_interactionType</dataInputRefs>
        </inputSet>
        <outputSet id="Task_Screen_output_set">
          <dataOutputRefs>Task_Screen_output_answer</dataOutputRefs>
        </outputSet>
      </ioSpecification>
      <dataInputAssociation>
        <assignment><from>choice</from><to>Task_Screen_input_interactionType</to></assignment>
      </dataInputAssociation>
      <dataOutputAssociation>
        <sourceRef>Task_Screen_output_answer</sourceRef>
        <targetRef>safetyAnswer</targetRef>
      </dataOutputAssociation>
    </userTask>`,
      '    <endEvent id="End_1"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Screen"/>',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_Screen" targetRef="End_1"/>',
    ].join("\n"),
  );
}

function staticPiAskChoicesWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1"/>',
      nativeHumanTask({
        id: "Task_Screen",
        name: "Safety screen",
        documentation: "Are any of these happening now or worsening quickly?",
        resultOutput: "safetyAnswer",
        interactionType: "choice_input",
        choices: [
          {
            value: "red_flags",
            label: "Emergency red flags",
            description: "Stop normal scheduling and escalate.",
          },
          {
            value: "routine",
            label: "Routine or none",
            description: "Continue the normal administrative flow.",
          },
        ],
      }),
      '    <endEvent id="End_1"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Screen"/>',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_Screen" targetRef="End_1"/>',
    ].join("\n"),
  );
}
