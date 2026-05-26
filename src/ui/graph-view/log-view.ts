import { type Component, truncateToWidth } from "@earendil-works/pi-tui";

/**
 * A scrolling log component that keeps the last N lines.
 */
export class LogView implements Component {
  private lines: string[] = [];
  private maxLines: number;
  private cachedWidth?: number;
  private cachedRendered?: string[];

  constructor(maxLines = 200) {
    this.maxLines = maxLines;
  }

  clear(): void {
    this.lines = [];
    this.invalidate();
  }

  getLines(): string[] {
    return [...this.lines];
  }

  appendLine(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.maxLines) {
      this.lines.shift();
    }
    this.invalidate();
  }

  replaceLastLine(line: string): void {
    if (this.lines.length === 0) {
      this.lines.push(line);
    } else {
      this.lines[this.lines.length - 1] = line;
    }
    this.invalidate();
  }

  appendText(text: string): void {
    if (this.lines.length === 0) {
      this.lines.push("");
    }
    const parts = text.split("\n");
    this.lines[this.lines.length - 1] += parts[0] ?? "";
    for (let i = 1; i < parts.length; i++) {
      this.lines.push(parts[i] ?? "");
    }
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(-this.maxLines);
    }
    this.invalidate();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRendered = undefined;
  }

  render(width: number): string[] {
    if (this.cachedRendered && this.cachedWidth === width) {
      return this.cachedRendered;
    }

    const rendered = this.lines.map((line) => truncateToWidth(line, width));

    this.cachedWidth = width;
    this.cachedRendered = rendered;
    return rendered;
  }
}
