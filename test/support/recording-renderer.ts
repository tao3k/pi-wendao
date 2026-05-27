import type { PiWendaoAgentEvent } from "../../src/executor/agent-runtime-types.js";
import { GraphView } from "../../src/ui/graph-view.js";
import type { PlannerReplyRequest, QianjiTraceLogEvent, Renderer } from "../../src/ui/renderer.js";

export class RecordingRenderer implements Renderer {
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
