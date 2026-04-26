import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { GraphView, LogView } from "../../ui/graph-view.js";
import {
  AgentEventLogBuffer,
  createViewRenderer,
  type PlannerReplyRequest,
  type QianjiTraceLogEvent,
  type Renderer,
} from "../../ui/renderer.js";
import {
  clearNativeWorkflowGraphPanel,
  createNativeWorkflowWidget,
  setNativeWorkflowGraphPanel,
  type NativeWorkflowGraphPanelHandle,
  type NativeWorkflowWidgetHandle,
} from "./graph-panel.js";
import { requestNativeWorkflowInputReply } from "./input.js";
import {
  createFoldedWorkflowEvents,
  foldWorkflowEventLines,
  sendWorkflowMessage,
  startWorkflowRunMessage,
  type FoldedWorkflowEvents,
  type NativeWorkflowRunMessageHandle,
  workflowEventSummaryLines,
} from "./messages.js";
import type { PiWendaoWorkflowMessageDetails } from "./types.js";
import { defaultReply, formatVariable, isWorkflowErrorLine } from "./text.js";

export class PiWendaoNativeWorkflowRenderer implements Renderer {
  readonly graphView = new GraphView();
  readonly logView = new LogView(240);
  private readonly agentLog = new AgentEventLogBuffer();
  private readonly viewRenderer: Renderer;
  private widget: NativeWorkflowWidgetHandle | undefined;
  private graphPanel: NativeWorkflowGraphPanelHandle | undefined;
  private runMessage: NativeWorkflowRunMessageHandle | undefined;
  private finished = false;
  private readonly foldedEvents: FoldedWorkflowEvents = createFoldedWorkflowEvents();
  private readonly plannerInputQueue: Array<{
    request: PlannerReplyRequest;
    signal?: AbortSignal;
    resolve: (value: string) => void;
    reject: (error: unknown) => void;
  }> = [];
  private plannerInputActive = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionCommandContext,
    readonly workflowPath: string,
    private readonly graphInTopWindow: boolean,
  ) {
    this.viewRenderer = createViewRenderer({
      graphView: this.graphView,
      logView: this.logView,
      refresh: () => this.refresh(),
      requestPlannerReply: (request, signal) => this.requestPlannerReply(request, signal),
      start: () => {},
      stop: () => {},
    });
  }

  onAgentEvent = (event: Parameters<Renderer["onAgentEvent"]>[0]): void => {
    const lines = this.agentLog.handle(event);
    this.viewRenderer.onAgentEvent(event);
    if (lines.length > 0) {
      this.emit("agent", lines);
    }
  };

  onNodeStart(activityId: string, activityName: string): void {
    this.viewRenderer.onNodeStart(activityId, activityName);
    this.emit("event", [`node ${activityName} started (${activityId})`]);
  }

  onNodeEnd(activityId: string, activityName: string): void {
    this.viewRenderer.onNodeEnd(activityId, activityName);
    this.emit("event", [`node ${activityName} completed (${activityId})`]);
  }

  onFlowTake(flowId: string): void {
    this.viewRenderer.onFlowTake(flowId);
  }

  onTraceEvent(event: QianjiTraceLogEvent): void {
    this.viewRenderer.onTraceEvent(event);
    if (event.kind === "flow_take") {
      this.emit("event", [`flow ${event.source_id} -> ${event.target_id}`]);
    } else {
      this.emit("event", [`${event.node_kind ?? "node"} ${event.node_id} ${event.status}`]);
    }
  }

  onError = (err: Error): void => {
    this.viewRenderer.onError(err);
    this.emit("error", [`Error: ${err.message}`], false);
  };

  printVariables(variables: Record<string, unknown>): void {
    this.viewRenderer.printVariables(variables);
    const keys = Object.keys(variables);
    if (keys.length === 0) return;
    this.emit("status", [
      "Variables:",
      ...Object.entries(variables).map(([key, value]) => `  ${key}: ${formatVariable(value)}`),
    ]);
  }

  appendLog(text: string): void {
    this.viewRenderer.appendLog(text);
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.some((line) => isWorkflowErrorLine(line))) {
      this.emit("error", lines, false);
      return;
    }
    this.emit("event", lines);
  }

  async requestPlannerReply(request: PlannerReplyRequest, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      this.plannerInputQueue.push({ request, signal, resolve, reject });
      this.startNextPlannerInput();
    });
  }

  async waitForKey(): Promise<void> {}

  refresh(): void {
    this.widget?.invalidate();
    this.widget?.requestRender();
    this.ctx.ui.setStatus("pi-wendao", undefined);
  }

  start(): void {
    if (this.graphInTopWindow) {
      this.graphPanel = setNativeWorkflowGraphPanel(this.ctx, (tui, theme) => {
        this.widget = createNativeWorkflowWidget(this, tui, theme);
        return this.widget;
      });
    }
    this.runMessage = startWorkflowRunMessage(this.pi, this.workflowPath);
    this.emit("status", [`running workflow: ${this.workflowPath}`]);
  }

  stop(): void {
    this.finish(undefined);
  }

  finish(success: boolean | "interrupted" | undefined): void {
    if (this.finished) return;
    this.finished = true;
    if (this.graphPanel) {
      clearNativeWorkflowGraphPanel(this.graphPanel);
      this.graphPanel = undefined;
      this.widget = undefined;
    }
    this.runMessage?.complete(success);
    this.refresh();
    this.flushFoldedEvents();
    this.ctx.ui.setStatus("pi-wendao", undefined);
  }

  private emit(
    kind: PiWendaoWorkflowMessageDetails["kind"],
    lines: string[],
    success?: boolean,
  ): void {
    if (this.runMessage && kind !== "prompt" && kind !== "show") {
      this.runMessage.append(kind, lines, success);
      this.refresh();
      if (kind !== "error") return;
    }
    if (kind === "event") {
      foldWorkflowEventLines(this.foldedEvents, lines);
      return;
    }
    this.emitVisible(kind, lines, success);
  }

  private emitVisible(
    kind: PiWendaoWorkflowMessageDetails["kind"],
    lines: string[],
    success?: boolean,
  ): void {
    sendWorkflowMessage(this.pi, {
      kind,
      workflowPath: this.workflowPath,
      lines,
      ...(success === undefined ? {} : { success }),
    });
  }

  private flushFoldedEvents(): void {
    const lines = workflowEventSummaryLines(this.foldedEvents);
    if (lines.length === 0) return;
    this.emitVisible("status", lines);
  }

  private startNextPlannerInput(): void {
    if (this.plannerInputActive) return;
    const next = this.plannerInputQueue.shift();
    if (!next) return;
    this.plannerInputActive = true;
    requestNativeWorkflowInputReply(this.pi, this.ctx, this.workflowPath, next.request, next.signal)
      .then((answer) => {
        const reply = answer.trim() || defaultReply(next.request);
        next.resolve(reply);
      })
      .catch(next.reject)
      .finally(() => {
        this.plannerInputActive = false;
        this.startNextPlannerInput();
      });
  }
}
