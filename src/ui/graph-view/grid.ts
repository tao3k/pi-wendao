import { visibleWidth } from "@earendil-works/pi-tui";
import { dim } from "yoctocolors";

export function drawEdgeOnGrid(
  grid: string[][],
  points: Array<{ x: number; y: number }>,
  gridW: number,
  gridH: number,
  taken: boolean,
): void {
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i]!;
    const p1 = points[i + 1]!;
    drawLineOnGrid(
      grid,
      Math.round(p0.x),
      Math.round(p0.y),
      Math.round(p1.x),
      Math.round(p1.y),
      gridW,
      gridH,
      taken,
    );
  }
  const last = points[points.length - 1];
  if (last) {
    const lx = Math.round(last.x);
    const ly = Math.round(last.y);
    if (lx >= 0 && lx < gridW && ly >= 0 && ly < gridH) {
      grid[ly]![lx] = "▾";
    }
  }
}

export interface GridWriteRequest {
  grid: string[][];
  row: number;
  col: number;
  text: string;
  gridW: number;
  gridH: number;
}

export function writeAt({ grid, row, col, text, gridW, gridH }: GridWriteRequest): void {
  if (row < 0 || row >= gridH || col < 0 || col >= gridW) return;
  const cells = splitStyledCells(text);
  for (let i = 0; i < cells.length && col + i < gridW; i++) {
    grid[row]![col + i] = cells[i] ?? "";
  }
}

function drawLineOnGrid(
  grid: string[][],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  gridW: number,
  gridH: number,
  taken: boolean,
): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let cx = x0;
  let cy = y0;

  while (true) {
    if (cx >= 0 && cx < gridW && cy >= 0 && cy < gridH) {
      if (grid[cy]![cx] === " ") {
        grid[cy]![cx] = edgeGlyph(dx, dy, taken);
      }
    }
    if (cx === x1 && cy === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
    }
  }
}

function edgeGlyph(dx: number, dy: number, taken: boolean): string {
  if (!taken) return dim("·");
  return dx > dy ? "─" : "│";
}

function splitStyledCells(text: string): string[] {
  const cells: string[] = [];
  let activeAnsi = "";
  for (let index = 0; index < text.length; ) {
    const ansi = text.slice(index).match(/^\x1b\[[0-9;]*m/);
    if (ansi) {
      activeAnsi = updateActiveAnsi(activeAnsi, ansi[0]);
      index += ansi[0].length;
      continue;
    }

    const char = text[index]!;
    const width = Math.max(0, visibleWidth(char));
    if (width > 0) {
      cells.push(activeAnsi ? `${activeAnsi}${char}\x1b[0m` : char);
      for (let extra = 1; extra < width; extra += 1) {
        cells.push("");
      }
    }
    index += char.length;
  }
  return cells;
}

function updateActiveAnsi(activeAnsi: string, ansi: string): string {
  if (/\[(?:0|22|23|24|29|39)m$/.test(ansi)) return "";
  return `${activeAnsi}${ansi}`;
}
