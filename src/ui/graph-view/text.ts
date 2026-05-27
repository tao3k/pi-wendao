import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ansiReset, readAnsiSequenceAt } from "../ansi.js";

export { stripAnsi } from "../ansi.js";

export function visibleSlice(text: string, start: number, width: number): string {
  if (width <= 0) return "";
  let column = 0;
  let emitted = 0;
  let result = "";
  let sawAnsi = false;

  for (let index = 0; index < text.length; ) {
    const ansi = readAnsiSequenceAt(text, index);
    if (ansi) {
      sawAnsi = true;
      if (column >= start && emitted < width) result += ansi;
      index += ansi.length;
      continue;
    }

    const char = text[index]!;
    const charWidth = visibleWidth(char);
    const charStart = column;
    const charEnd = column + charWidth;
    if (charEnd > start && emitted + charWidth <= width) {
      result += char;
      emitted += charWidth;
    } else if (emitted > 0 && emitted + charWidth > width) {
      break;
    }
    column = charEnd;
    index += char.length;
    if (charStart >= start && emitted >= width) break;
  }

  if (sawAnsi && result) result += ansiReset();
  return truncateToWidth(result, width);
}

export function truncLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  return label.slice(0, max - 1) + "\u2026";
}

export function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
