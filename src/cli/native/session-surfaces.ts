import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { clearAllNativeWorkflowGraphPanels } from "./graph-panel.js";
import { PI_WENDAO_RESET_NATIVE_SESSION_SURFACES_EVENT } from "./pi-subagents-extension.js";

const NATIVE_SESSION_WIDGET_KEYS = ["agents"] as const;
const NATIVE_SESSION_STATUS_KEYS = ["pi-wendao", "subagents"] as const;

export function clearNativeSessionSurfaces(ctx: Pick<ExtensionCommandContext, "ui">): void {
  clearAllNativeWorkflowGraphPanels();
  for (const key of NATIVE_SESSION_WIDGET_KEYS) {
    ctx.ui.setWidget(key, undefined);
  }
  for (const key of NATIVE_SESSION_STATUS_KEYS) {
    ctx.ui.setStatus(key, undefined);
  }
}

export function resetNativeSessionSurfaces(
  pi: Pick<ExtensionAPI, "events">,
  ctx: Pick<ExtensionCommandContext, "ui">,
): void {
  pi.events.emit(PI_WENDAO_RESET_NATIVE_SESSION_SURFACES_EVENT, {});
  clearNativeSessionSurfaces(ctx);
}
