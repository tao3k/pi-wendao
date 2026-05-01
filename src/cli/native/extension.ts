import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionFactory,
  TerminalInputHandler,
} from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, Text, type Component } from "@mariozechner/pi-tui";
import { isWorkflowInterruptedError } from "../../executor/interrupt.js";
import { parseNativeRunCommand, parseNativeShowCommand } from "./args.js";
import { WORKFLOW_MESSAGE_TYPE } from "./constants.js";
import { renderWorkflowMessage, sendWorkflowMessage } from "./messages.js";
import { registerAnthropicEnvProvider } from "./model.js";
import { runNativeWorkflow, showNativeWorkflowStatus } from "./runner.js";
import { isNativeWorkflowUiEscScopeActive } from "./esc-scope.js";
import { resetNativeSessionSurfaces } from "./session-surfaces.js";
import type {
  NativeRunCommand,
  PiWendaoNativeExtensionOptions,
  PiWendaoWorkflowMessageDetails,
} from "./types.js";

export function createPiWendaoNativeExtension(
  options: PiWendaoNativeExtensionOptions,
): ExtensionFactory {
  let activeRun: ActiveWorkflowRun | undefined;

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
        let unsubscribeInterruptInput: (() => void) | undefined;
        try {
          command = parseNativeRunCommand(args);
          activeRun = { controller, workflowPath: command.workflowPath };
          unsubscribeInterruptInput = ctx.ui.onTerminalInput(
            createWorkflowInterruptInputHandler(pi, ctx, () => activeRun),
          );
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
          unsubscribeInterruptInput?.();
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
        requestWorkflowStop(pi, ctx, activeRun);
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

type ActiveWorkflowRun = {
  controller: AbortController;
  workflowPath?: string;
  stopRequested?: boolean;
};

function createWorkflowInterruptInputHandler(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  getActiveRun: () => ActiveWorkflowRun | undefined,
): TerminalInputHandler {
  return (data) => {
    if (!isWorkflowInterruptKey(data)) return undefined;
    if (isNativeWorkflowUiEscScopeActive()) return undefined;
    const run = getActiveRun();
    if (!run) return undefined;
    requestWorkflowStop(pi, ctx, run);
    return { consume: true };
  };
}

function requestWorkflowStop(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionCommandContext, "ui">,
  activeRun: ActiveWorkflowRun,
): void {
  if (activeRun.stopRequested) return;
  activeRun.stopRequested = true;
  activeRun.controller.abort();
  ctx.ui.notify("Stopping pi-wendao workflow...", "warning");
  sendWorkflowMessage(pi, {
    kind: "status",
    workflowPath: activeRun.workflowPath,
    lines: ["Workflow interrupt requested. Qianji checkpoint state will be preserved."],
  });
}

function isWorkflowInterruptKey(data: string): boolean {
  return matchesKey(data, Key.escape);
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
      resetNativeSessionSurfaces(pi, ctx);
      const result = await ctx.newSession({
        withSession: async (newCtx) => {
          resetNativeSessionSurfaces(pi, newCtx);
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
