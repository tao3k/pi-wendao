import type { LogView } from "../graph-view.js";

export function appendLogBlock(logView: LogView, text: string): void {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    logView.appendLine(line);
  }
}
