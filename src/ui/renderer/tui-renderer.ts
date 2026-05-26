import { matchesKey, ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { bold, cyan, dim, green, red, yellow } from "yoctocolors";
import type { PiWendaoAgentEvent } from "../../executor/agent-runtime-types.js";
import { WorkflowInterruptedError } from "../../executor/interrupt.js";
import { GraphView, LogView } from "../graph-view.js";
import { AgentEventLogBuffer, formatVariableValueForLog } from "./log-format.js";
import { isPrintableInput } from "./input.js";
import { appendLogBlock } from "./log-block.js";
import {
  appendPlannerPrompt,
  replyPromptForRequest,
  resolveReplyForRequest,
} from "./planner-prompt.js";
import { SplitLayout } from "./split-layout.js";
import { appendTraceEvent } from "./trace-log.js";
import type { PlannerReplyRequest, QianjiTraceLogEvent, Renderer } from "./types.js";

interface QueuedPlannerInput {
  request: PlannerReplyRequest;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
}

interface ActivePlannerInput extends QueuedPlannerInput {
  value: string;
}

export function createTuiRenderer(): Renderer {
  return createTuiRendererInternal();
}

function createTuiRendererInternal(): Renderer {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const graphView = new GraphView();
  const logView = new LogView();
  const agentLog = new AgentEventLogBuffer();
  const plannerInputQueue: QueuedPlannerInput[] = [];
  let activePlannerInput: ActivePlannerInput | undefined;

  const layout = new SplitLayout(graphView, logView, terminal);
  tui.addChild(layout);

  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      tui.stop();
      process.exit(130);
    }
    if (activePlannerInput) {
      handlePlannerInput(data);
      return { consume: true };
    }
    return undefined;
  });

  function refresh(): void {
    layout.invalidate();
    tui.requestRender();
  }

  return {
    graphView,
    refresh,

    start() {
      tui.start();
      refresh();
    },

    stop() {
      tui.stop();
    },

    appendLog(text: string) {
      appendLogBlock(logView, text);
      refresh();
    },

    requestPlannerReply(request: PlannerReplyRequest, signal?: AbortSignal) {
      return enqueuePlannerReplyRequest(request, signal);
    },

    waitForKey() {
      return new Promise<void>((resolve) => {
        tui.addInputListener(() => {
          resolve();
          return { consume: true };
        });
      });
    },

    onAgentEvent(event: PiWendaoAgentEvent) {
      const lines = agentLog.handle(event);
      if (lines.length === 0) return;
      for (const line of lines) {
        logView.appendLine(line);
      }
      refresh();
    },

    onNodeStart(activityId: string, activityName: string) {
      logView.appendLine(`${cyan(bold(`>> ${activityName}`))} ${dim(`(${activityId})`)}`);
      refresh();
    },

    onNodeEnd(_activityId: string, _activityName: string) {
      logView.appendLine(green("   done"));
      refresh();
    },

    onFlowTake(_flowId: string) {},

    onTraceEvent(event: QianjiTraceLogEvent) {
      appendTraceEvent(logView, event);
      refresh();
    },

    onError(err: Error) {
      logView.appendLine(red(`Error: ${err.message}`));
      refresh();
    },

    printVariables(variables: Record<string, unknown>) {
      const keys = Object.keys(variables);
      if (keys.length === 0) return;
      logView.appendLine("");
      logView.appendLine(bold("Variables:"));
      for (const [key, value] of Object.entries(variables)) {
        logView.appendLine(`  ${yellow(key)}: ${formatVariableValueForLog(value)}`);
      }
      refresh();
    },
  };

  function enqueuePlannerReplyRequest(
    request: PlannerReplyRequest,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      plannerInputQueue.push({ request, resolve, reject, signal });
      if (!activePlannerInput) startNextPlannerInput();
    });
  }

  function startNextPlannerInput(): void {
    const next = plannerInputQueue.shift();
    if (!next) return;
    activePlannerInput = { ...next, value: "" };
    appendPlannerPrompt(logView, next.request);
    refresh();
    if (next.signal?.aborted) {
      failPlannerInput(new WorkflowInterruptedError());
    }
  }

  function handlePlannerInput(data: string): void {
    if (!activePlannerInput) return;
    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      try {
        completePlannerInput(
          resolveReplyForRequest(activePlannerInput.request, activePlannerInput.value),
        );
      } catch (error) {
        failPlannerInput(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    if (matchesKey(data, "escape")) {
      failPlannerInput(
        new WorkflowInterruptedError("Workflow input cancelled; checkpoint preserved."),
      );
      return;
    }
    if (matchesKey(data, "backspace")) {
      activePlannerInput.value = activePlannerInput.value.slice(0, -1);
      renderPlannerInputLine();
      return;
    }
    if (isPrintableInput(data)) {
      activePlannerInput.value += data;
      renderPlannerInputLine();
    }
  }

  function completePlannerInput(answer: string): void {
    if (!activePlannerInput) return;
    const completed = activePlannerInput;
    activePlannerInput = undefined;
    logView.replaceLastLine(green(`${replyPromptForRequest(completed.request).prefix}> ${answer}`));
    completed.resolve(answer);
    refresh();
    startNextPlannerInput();
  }

  function failPlannerInput(error: Error): void {
    if (!activePlannerInput) return;
    const completed = activePlannerInput;
    activePlannerInput = undefined;
    logView.replaceLastLine(red(`${replyPromptForRequest(completed.request).prefix}> cancelled`));
    completed.reject(error);
    refresh();
    startNextPlannerInput();
  }

  function renderPlannerInputLine(): void {
    if (!activePlannerInput) return;
    logView.replaceLastLine(
      cyan(
        `${replyPromptForRequest(activePlannerInput.request).prefix}> ${activePlannerInput.value}`,
      ),
    );
    refresh();
  }
}
