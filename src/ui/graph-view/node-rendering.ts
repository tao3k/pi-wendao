import { bold, dim, green, red, yellow } from "yoctocolors";
import type { GraphNode } from "./types.js";
import { stripAnsi, truncLabel } from "./text.js";
import { writeAt } from "./grid.js";

export function formatNodeLabel(node: GraphNode, maxWidth = 20): string {
  switch (node.type) {
    case "start":
      return "( )";
    case "end":
      return "(*)";
    case "gateway":
      return `<${truncLabel(node.label, Math.max(3, maxWidth - 2))}>`;
    case "task":
      return truncLabel(node.label, maxWidth);
    case "boundary":
      return "err";
    default:
      return truncLabel(node.label, maxWidth);
  }
}

export function formatNodeDetails(node: GraphNode, maxWidth = 20): string[] {
  if (node.type === "start" || node.type === "end") return [];
  return (node.details ?? []).slice(0, 3).map((detail) => truncLabel(detail, maxWidth));
}

export function nodeBoxHeight(node: GraphNode): number {
  if (node.type === "start" || node.type === "end") return 3;
  return 3 + formatNodeDetails(node).length;
}

export function nodeBoxWidth(node: GraphNode, maxLabelWidth = 20): number {
  const label = formatNodeLabel(node, maxLabelWidth);
  const details = formatNodeDetails(node, maxLabelWidth);
  if (node.type === "start" || node.type === "end") {
    return stripAnsi(label).length + 2;
  }
  return (
    Math.max(stripAnsi(label).length, ...details.map((detail) => stripAnsi(detail).length)) + 4
  );
}

export interface DrawNodeOnGridRequest {
  grid: string[][];
  pos: { x: number; y: number; width: number; height: number };
  node: GraphNode;
  gridW: number;
  gridH: number;
  maxLabelWidth?: number;
}

export function drawNodeOnGrid({
  grid,
  pos,
  node,
  gridW,
  gridH,
  maxLabelWidth = 20,
}: DrawNodeOnGridRequest): void {
  const label = formatNodeLabel(node, maxLabelWidth);
  const details = formatNodeDetails(node, maxLabelWidth);
  const boxW = nodeBoxWidth(node, maxLabelWidth);
  const boxH = nodeBoxHeight(node);
  const startX = Math.round(pos.x - boxW / 2);
  const startY = Math.round(pos.y - boxH / 2);

  const isSmall = node.type === "start" || node.type === "end";
  if (isSmall) {
    writeAt({
      grid,
      row: startY + 1,
      col: startX + 1,
      text: styleLabel(label, node),
      gridW,
      gridH,
    });
    return;
  }

  const border = getBorderStyle(node);
  const top = border("┌" + "─".repeat(boxW - 2) + "┐");
  const mid = boxLine(label, boxW, border, (text) => styleLabel(text, node));
  const bot = border("└" + "─".repeat(boxW - 2) + "┘");

  writeAt({ grid, row: startY, col: startX, text: top, gridW, gridH });
  writeAt({ grid, row: startY + 1, col: startX, text: mid, gridW, gridH });
  for (let i = 0; i < details.length; i++) {
    writeAt({
      grid,
      row: startY + 2 + i,
      col: startX,
      text: boxLine(details[i]!, boxW, border, dim),
      gridW,
      gridH,
    });
  }
  writeAt({ grid, row: startY + boxH - 1, col: startX, text: bot, gridW, gridH });
}

function boxLine(
  text: string,
  width: number,
  border: (s: string) => string,
  style: (s: string) => string,
): string {
  const visibleLength = stripAnsi(text).length;
  const rightPadding = Math.max(0, width - visibleLength - 3);
  return border("│") + " " + style(text) + " ".repeat(rightPadding) + border("│");
}

function styleLabel(label: string, node: GraphNode): string {
  switch (node.status) {
    case "active":
      return bold(yellow(label));
    case "done":
      return green(label);
    case "error":
      return red(label);
    default:
      return dim(label);
  }
}

function getBorderStyle(node: GraphNode): (s: string) => string {
  switch (node.status) {
    case "active":
      return yellow;
    case "done":
      return green;
    case "error":
      return red;
    default:
      return dim;
  }
}
