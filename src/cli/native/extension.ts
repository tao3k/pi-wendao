import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Text, type Component } from "@mariozechner/pi-tui";
import { isWorkflowInterruptedError } from "../../executor/interrupt.js";
import { parseNativeRunCommand, parseNativeShowCommand } from "./args.js";
import { WORKFLOW_MESSAGE_TYPE } from "./constants.js";
import { renderWorkflowMessage, sendWorkflowMessage } from "./messages.js";
import { registerAnthropicEnvProvider } from "./model.js";
import { runNativeWorkflow, showNativeWorkflowStatus } from "./runner.js";
import type {
  NativeRunCommand,
  PiWendaoNativeExtensionOptions,
  PiWendaoWorkflowMessageDetails,
} from "./types.js";

export function createPiWendaoNativeExtension(
  options: PiWendaoNativeExtensionOptions,
): ExtensionFactory {
  let activeRun: { controller: AbortController; workflowPath?: string } | undefined;

  return (pi: ExtensionAPI) => {
    registerAnthropicEnvProvider(pi);
    registerWorkflowMessageRenderers(pi);
    registerSessionLifecycleAliases(pi);

    pi.registerCommand("run", {
      description: "Run a qianji BPMN workflow in the native pi session",
      handler: async (args, ctx) => {
        if (activeRun) {
          ctx.ui.notify("A pi-wendao workflow is already running.", "warning");
          return;
        }
        let command: NativeRunCommand | undefined;
        const controller = new AbortController();
        try {
          command = parseNativeRunCommand(args);
          activeRun = { controller, workflowPath: command.workflowPath };
          await ctx.waitForIdle();
          await runNativeWorkflow(pi, ctx, options, command, controller.signal);
        } catch (error) {
          if (isWorkflowInterruptedError(error) || controller.signal.aborted) {
            ctx.ui.notify(
              "Workflow interrupted. Qianji checkpoint state was preserved.",
              "warning",
            );
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(message, "error");
          sendWorkflowMessage(pi, {
            kind: "error",
            workflowPath: command?.workflowPath,
            lines: [`Error: ${message}`],
            success: false,
          });
        } finally {
          activeRun = undefined;
          ctx.ui.setStatus("pi-wendao", undefined);
        }
      },
    });

    pi.registerCommand("stop", {
      description:
        "Interrupt the active pi-wendao workflow run and preserve qianji checkpoint state",
      handler: async (_args, ctx) => {
        if (!activeRun) {
          ctx.ui.notify("No pi-wendao workflow is running.", "warning");
          return;
        }
        const workflowPath = activeRun.workflowPath;
        activeRun.controller.abort();
        ctx.ui.notify("Stopping pi-wendao workflow...", "warning");
        sendWorkflowMessage(pi, {
          kind: "status",
          workflowPath,
          lines: ["Workflow interrupt requested. Qianji checkpoint state will be preserved."],
        });
      },
    });

    pi.registerCommand("show", {
      description: "Show qianji BPMN instances or an instance status",
      handler: async (args, ctx) => {
        try {
          await ctx.waitForIdle();
          await showNativeWorkflowStatus(pi, options, parseNativeShowCommand(args));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(message, "error");
          sendWorkflowMessage(pi, { kind: "error", lines: [`Error: ${message}`], success: false });
        }
      },
    });
  };
}

function registerSessionLifecycleAliases(pi: ExtensionAPI): void {
  pi.registerCommand("exit", {
    description: "Exit pi-wendao cleanly; alias for pi /quit",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });

  pi.registerCommand("clear", {
    description: "Start a fresh pi session; alias for pi /new",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const result = await ctx.newSession({
        withSession: async (newCtx) => {
          newCtx.ui.notify("New session started.", "info");
        },
      });
      if (result.cancelled) {
        ctx.ui.notify("New session cancelled.", "warning");
      }
    },
  });
}

function registerWorkflowMessageRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<PiWendaoWorkflowMessageDetails>(
    WORKFLOW_MESSAGE_TYPE,
    (message, renderOptions, theme) => {
      const details = message.details;
      if (!details) return new Text(String(message.content ?? ""), 0, 0);
      return new DynamicMessageText(() =>
        renderWorkflowMessage(details, renderOptions.expanded, theme),
      );
    },
  );
}

class DynamicMessageText implements Component {
  private readonly text = new Text("", 0, 0);

  constructor(private readonly getText: () => string) {}

  render(width: number): string[] {
    this.text.setText(this.getText());
    return this.text.render(width);
  }

  invalidate(): void {
    this.text.invalidate();
  }
}
