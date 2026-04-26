import { type Component, truncateToWidth } from "@mariozechner/pi-tui";
import { dim } from "yoctocolors";
import type { GraphView } from "../graph-view.js";

/**
 * Split layout: top component gets its natural height,
 * bottom component fills the remaining terminal rows.
 * Bottom content is tail-scrolled (shows last N lines).
 */
export class SplitLayout implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private top: GraphView,
    private bottom: Component,
    private terminal: { rows: number },
  ) {}

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.top.invalidate();
    this.bottom.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const totalRows = this.terminal.rows;
    const allTopLines = this.top.render(width);
    if (allTopLines.length === 0) {
      const allBottomLines = this.bottom.render(width);
      const visibleBottom = allBottomLines.slice(-Math.max(1, totalRows));
      while (visibleBottom.length < totalRows) {
        visibleBottom.unshift("");
      }
      this.cachedWidth = width;
      this.cachedLines = visibleBottom;
      return visibleBottom;
    }

    const topHeight = Math.floor((totalRows * 2) / 3);
    const bottomHeight = Math.max(1, totalRows - topHeight - 1);

    const activeRow = this.top.getActiveRow();
    const scrollOffset = Math.max(
      0,
      Math.min(activeRow - Math.floor(topHeight / 2), Math.max(0, allTopLines.length - topHeight)),
    );
    const visibleTop = allTopLines.slice(scrollOffset, scrollOffset + topHeight);
    while (visibleTop.length < topHeight) {
      visibleTop.push("");
    }

    const separator = truncateToWidth(dim("─".repeat(width)), width);

    const allBottomLines = this.bottom.render(width);
    const visibleBottom = allBottomLines.slice(-bottomHeight);
    while (visibleBottom.length < bottomHeight) {
      visibleBottom.unshift("");
    }

    const lines = [...visibleTop, separator, ...visibleBottom];
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}
