import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { NativeSubagentManager } from "./manager.js";
import type {
  NativeSubagentGetResultRequest,
  NativeSubagentSpawnRequest,
  NativeSubagentSteerRequest,
} from "./protocol.js";

export function registerPiWendaoNativeSubagents(pi: ExtensionAPI): void {
  const manager = new NativeSubagentManager();

  pi.registerTool({
    name: "Agent",
    label: "Agent",
    description:
      "Launch a pi-wendao native subagent for an autonomous child task. Use run_in_background for parallel Qianji service-task work.",
    promptSnippet:
      "Use Agent for complex child work that should be delegated to a pi-wendao native subagent.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The task for the subagent to perform." }),
      description: Type.String({ description: "Short task description for status surfaces." }),
      subagent_type: Type.String({
        description:
          "Subagent type such as pi-wendao-output-only, pi-wendao-readonly, pi-wendao-output-writer, or general-purpose.",
      }),
      model: Type.Optional(Type.String({ description: "Optional provider/model id override." })),
      thinking: Type.Optional(Type.String({ description: "Optional thinking level override." })),
      max_turns: Type.Optional(Type.Number({ minimum: 1 })),
      run_in_background: Type.Optional(Type.Boolean()),
      resume: Type.Optional(Type.String()),
      isolated: Type.Optional(Type.Boolean()),
      isolation: Type.Optional(Type.String()),
      inherit_context: Type.Optional(Type.Boolean()),
    }),
    executionMode: "parallel",
    execute: (_toolCallId, params, signal, onUpdate, ctx) =>
      manager.spawn(params as NativeSubagentSpawnRequest, ctx, signal, onUpdate),
  });

  pi.registerTool({
    name: "get_subagent_result",
    label: "Get Subagent Result",
    description: "Check status and retrieve results from a pi-wendao native subagent.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "Subagent id returned by Agent." }),
      wait: Type.Optional(Type.Boolean({ description: "Wait for completion before returning." })),
      verbose: Type.Optional(Type.Boolean({ description: "Include compact conversation trace." })),
    }),
    executionMode: "parallel",
    execute: (_toolCallId, params, signal) =>
      manager.getResult(params as NativeSubagentGetResultRequest, signal),
  });

  pi.registerTool({
    name: "steer_subagent",
    label: "Steer Subagent",
    description: "Send a steering message to a running pi-wendao native subagent.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "Subagent id returned by Agent." }),
      message: Type.String({ description: "Steering message for the subagent." }),
    }),
    executionMode: "sequential",
    execute: (_toolCallId, params, signal) =>
      manager.steer(params as NativeSubagentSteerRequest, signal),
  });

  pi.registerCommand("subagents", {
    description: "Show pi-wendao native subagent status.",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      await ctx.ui.custom(() => new Text("pi-wendao native subagents", 0, 0), {
        overlay: true,
      });
    },
  });
}
