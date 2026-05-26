import type { PiWendaoAgentEvent } from "../../executor/agent-runtime-types.js";
import { GraphView } from "../../ui/graph-view.js";
import type { PlannerReplyRequest, QianjiTraceLogEvent, Renderer } from "../../ui/renderer.js";

export class BenchmarkRenderer implements Renderer {
  graphView = new GraphView();
  logs: string[] = [];
  errors: Error[] = [];
  traceEvents: QianjiTraceLogEvent[] = [];
  variables: Record<string, unknown> = {};

  refresh(): void {}
  start(): void {}
  stop(): void {}
  async waitForKey(): Promise<void> {}

  appendLog(text: string): void {
    this.logs.push(text);
  }

  onAgentEvent(event: PiWendaoAgentEvent): void {
    this.logs.push(JSON.stringify(event));
  }

  onNodeStart(activityId: string, activityName: string): void {
    this.logs.push(`node start ${activityId} ${activityName}`);
  }

  onNodeEnd(activityId: string, activityName: string): void {
    this.logs.push(`node end ${activityId} ${activityName}`);
  }

  onFlowTake(flowId: string): void {
    this.logs.push(`flow ${flowId}`);
  }

  onTraceEvent(event: QianjiTraceLogEvent): void {
    this.traceEvents.push(event);
  }

  onError(error: Error): void {
    this.errors.push(error);
  }

  printVariables(variables: Record<string, unknown>): void {
    this.variables = { ...variables };
  }

  async requestPlannerReply(_request: PlannerReplyRequest): Promise<string> {
    return "rejected";
  }
}

export function countLiveWorkflowTraceLogs(logs: string[], fallback: number): number {
  const traceLineCount = logs
    .flatMap((entry) => entry.split(/\r?\n/))
    .filter((line) =>
      /^(start event|end event|service task|gateway|flow)\b/.test(line.trim()),
    ).length;
  return Math.max(traceLineCount, fallback);
}

export function countParallelHostWorkBatches(logs: string[]): number {
  return logs.filter((line) => line.includes("parallel jobs")).length;
}
