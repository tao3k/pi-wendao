import { createPlainRenderer } from "./renderer/plain-renderer.js";
import { createTuiRenderer } from "./renderer/tui-renderer.js";
import type { Renderer } from "./renderer/types.js";

export { createViewRenderer } from "./renderer/view-renderer.js";
export type {
  PiSubagentsHostLogEvent,
  PiSubagentsHostToolLogEvent,
  PlannerReplyRequest,
  QianjiHostWorkLogEvent,
  QianjiTraceLogEvent,
  Renderer,
} from "./renderer/types.js";
export {
  AgentEventLogBuffer,
  formatArgsForLog,
  formatAssistantMessageForLog,
  formatPiSubagentsHostEventForLog,
  formatPiSubagentsHostToolEventForGraphDetail,
  formatPiSubagentsHostToolEventForLog,
  formatPiSubagentsToolUpdateForGraphDetail,
  formatPiSubagentsToolUpdateForLog,
  formatQianjiCliOutputForLog,
  formatQianjiHostWorkEventForLog,
  formatThinkingMessageForLog,
  formatToolResultForLog,
  formatVariableValueForLog,
} from "./renderer/log-format.js";
export { waitForTerminalKey } from "./renderer/terminal.js";

/**
 * Create a TUI-based renderer with graph at top, log output below.
 * If `useGraph` is false, creates a plain text renderer (no TUI).
 */
export function createRenderer(useGraph: boolean): Renderer {
  if (!useGraph) {
    return createPlainRenderer();
  }
  return createTuiRenderer();
}
