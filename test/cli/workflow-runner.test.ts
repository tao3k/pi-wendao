import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function makeFakeQianjiPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-workflow-runner-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "qianji");
  writeFakeQianjiScript(scriptPath);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function writeFakeQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
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
