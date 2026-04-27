import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import { runWorkflowInRenderer } from "../../src/cli/workflow-runner.js";
import { GraphView } from "../../src/ui/graph-view.js";
import type { PlannerReplyRequest, QianjiTraceLogEvent, Renderer } from "../../src/ui/renderer.js";
import type { PiWendaoAgentEvent } from "../../src/executor/agent-runtime-types.js";

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
});

class ReceiverSensitiveRenderer implements Renderer {
  readonly graphView = new GraphView();
  readonly logs: string[] = [];
  readonly errors: string[] = [];
  traceEvents = 0;
  flowTakes: string[] = [];

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
  options: { lintExitCode?: number; lintOutput?: string; lintFailureMarker?: string } = {},
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
  options: { lintExitCode?: number; lintOutput?: string; lintFailureMarker?: string },
): void {
  const lintExitCode = options.lintExitCode;
  const lintOutput = options.lintOutput ?? "[ok] lint passed";
  const lintFailureMarker = options.lintFailureMarker;
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
if (args[0] === "lint") {
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
if (args[0] !== "bpmn" || args[1] !== "run") {
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
console.log("# BPMN Run\\n\\nOutcome: completed\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify({ ...context, ok: true }, null, 2) + "\\n" + fence + "\\n");
`,
    "utf-8",
  );
}
