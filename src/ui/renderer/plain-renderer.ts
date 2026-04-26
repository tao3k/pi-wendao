import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { bold, cyan, dim, green, red, yellow } from "yoctocolors";
import type { PiWendaoAgentEvent } from "../../executor/agent-runtime-types.js";
import { GraphView } from "../graph-view.js";
import { AgentEventLogBuffer, formatVariableValueForLog } from "./log-format.js";
import {
  questionTextForRequest,
  replyPromptForRequest,
  resolveReplyForRequest,
} from "./planner-prompt.js";
import { waitForTerminalKey } from "./terminal.js";
import { appendTraceEventToConsole } from "./trace-log.js";
import type { PlannerReplyRequest, QianjiTraceLogEvent, Renderer } from "./types.js";

export function createPlainRenderer(): Renderer {
  const graphView = new GraphView();
  const agentLog = new AgentEventLogBuffer();
  let plannerInput: ReturnType<typeof createInterface> | undefined;
  let pipedPlannerAnswers: string[] | undefined;

  const readPlannerInput = () => {
    plannerInput ??= createInterface({ input: process.stdin, output: process.stdout });
    return plannerInput;
  };
  const readPipedPlannerAnswer = () => {
    pipedPlannerAnswers ??= readFileSync(0, "utf-8").split(/\r?\n/);
    return pipedPlannerAnswers.shift() ?? "";
  };

  return {
    graphView,
    refresh() {},
    start() {},
    stop() {
      plannerInput?.close();
      plannerInput = undefined;
    },

    appendLog(text: string) {
      console.log(text);
    },

    async requestPlannerReply(request: PlannerReplyRequest, signal?: AbortSignal) {
      if (signal?.aborted) return "rejected";
      const prompt = replyPromptForRequest(request);
      const promptText = `${prompt.label}: ${questionTextForRequest(request)}\n${prompt.prefix}> `;
      if (!process.stdin.isTTY) {
        const answer = readPipedPlannerAnswer();
        process.stdout.write(promptText);
        process.stdout.write(`${answer}\n`);
        return resolveReplyForRequest(request, answer);
      }
      const answer = await readPlannerInput().question(promptText);
      return resolveReplyForRequest(request, answer);
    },

    async waitForKey() {
      await waitForTerminalKey();
    },

    onAgentEvent(event: PiWendaoAgentEvent) {
      for (const line of agentLog.handle(event)) {
        console.log(line);
      }
    },

    onNodeStart(activityId: string, activityName: string) {
      console.log(`\n${cyan(bold(`>> ${activityName}`))} ${dim(`(${activityId})`)}`);
    },

    onNodeEnd(_activityId: string, _activityName: string) {
      console.log(green("   done"));
    },

    onFlowTake(_flowId: string) {},

    onTraceEvent(event: QianjiTraceLogEvent) {
      appendTraceEventToConsole(event);
    },

    onError(err: Error) {
      console.error(red(`Error: ${err.message}`));
    },

    printVariables(variables: Record<string, unknown>) {
      const keys = Object.keys(variables);
      if (keys.length === 0) return;
      console.log(`\n${bold("Variables:")}`);
      for (const [key, value] of Object.entries(variables)) {
        console.log(`  ${yellow(key)}: ${formatVariableValueForLog(value)}`);
      }
    },
  };
}
