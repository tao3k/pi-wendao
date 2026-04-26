import { bold, cyan, dim, green, red, yellow } from "yoctocolors";
import type { PiWendaoAgentEvent } from "../../executor/agent-runtime-types.js";
import { GraphView, LogView } from "../graph-view.js";
import { AgentEventLogBuffer, formatVariableValueForLog } from "./log-format.js";
import { appendLogBlock } from "./log-block.js";
import { appendTraceEvent } from "./trace-log.js";
import type { QianjiTraceLogEvent, Renderer } from "./types.js";

export function createViewRenderer(options: {
  graphView: GraphView;
  logView: LogView;
  refresh: () => void;
  requestPlannerReply: Renderer["requestPlannerReply"];
  waitForKey?: Renderer["waitForKey"];
  start?: () => void;
  stop?: () => void;
}): Renderer {
  const agentLog = new AgentEventLogBuffer();
  return {
    graphView: options.graphView,
    refresh: options.refresh,
    start: options.start ?? (() => {}),
    stop: options.stop ?? (() => {}),
    appendLog(text: string) {
      appendLogBlock(options.logView, text);
      options.refresh();
    },
    requestPlannerReply: options.requestPlannerReply,
    waitForKey: options.waitForKey ?? (async () => {}),
    onAgentEvent(event: PiWendaoAgentEvent) {
      const lines = agentLog.handle(event);
      if (lines.length === 0) return;
      for (const line of lines) {
        options.logView.appendLine(line);
      }
      options.refresh();
    },
    onNodeStart(activityId: string, activityName: string) {
      options.logView.appendLine(`${cyan(bold(`>> ${activityName}`))} ${dim(`(${activityId})`)}`);
      options.refresh();
    },
    onNodeEnd(_activityId: string, _activityName: string) {
      options.logView.appendLine(green("   done"));
      options.refresh();
    },
    onFlowTake(_flowId: string) {},
    onTraceEvent(event: QianjiTraceLogEvent) {
      appendTraceEvent(options.logView, event);
      options.refresh();
    },
    onError(err: Error) {
      options.logView.appendLine(red(`Error: ${err.message}`));
      options.refresh();
    },
    printVariables(variables: Record<string, unknown>) {
      const keys = Object.keys(variables);
      if (keys.length === 0) return;
      options.logView.appendLine("");
      options.logView.appendLine(bold("Variables:"));
      for (const [key, value] of Object.entries(variables)) {
        options.logView.appendLine(`  ${yellow(key)}: ${formatVariableValueForLog(value)}`);
      }
      options.refresh();
    },
  };
}
