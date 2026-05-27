import dagre from "dagre";
import { type Component } from "@earendil-works/pi-tui";
import type { GraphEdge, GraphNode, NodeBounds, NodeStatus } from "./graph-view/types.js";
import { drawEdgeOnGrid } from "./graph-view/grid.js";
import {
  drawNodeOnGrid,
  formatNodeLabel,
  nodeBoxHeight,
  nodeBoxWidth,
} from "./graph-view/node-rendering.js";
import { arraysEqual, visibleSlice } from "./graph-view/text.js";
import { activeNodeBounds, resolveHorizontalOffset } from "./graph-view/viewport.js";

export type { GraphEdge, GraphNode, NodeBounds, NodeStatus } from "./graph-view/types.js";
export { LogView } from "./graph-view/log-view.js";

/**
 * pi-tui Component that renders a BPMN process graph using dagre layout
 * and box-drawing characters.
 */
export class GraphView implements Component {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: GraphEdge[] = [];
  private cachedWidth?: number;
  private cachedLines?: string[];
  /** Row of the currently active node in the full rendered output */
  private activeRow = 0;
  /** Column of the currently active node in the full rendered output */
  private activeColumn = 0;
  private nodeRows: Map<string, number> = new Map();
  private nodeColumns: Map<string, number> = new Map();
  private nodeBounds: Map<string, NodeBounds> = new Map();

  clear(): void {
    this.nodes.clear();
    this.edges = [];
    this.activeRow = 0;
    this.activeColumn = 0;
    this.nodeRows.clear();
    this.nodeColumns.clear();
    this.nodeBounds.clear();
    this.invalidate();
  }

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    this.invalidate();
  }

  addEdge(edge: GraphEdge): void {
    this.edges.push(edge);
    this.invalidate();
  }

  setNodeStatus(id: string, status: NodeStatus): void {
    const node = this.nodes.get(id);
    if (node && node.status !== status) {
      node.status = status;
      if (status === "active") {
        const row = this.nodeRows.get(id);
        const column = this.nodeColumns.get(id);
        if (row !== undefined) this.activeRow = row;
        if (column !== undefined) this.activeColumn = column;
      }
      this.invalidate();
    }
  }

  setNodeDetails(id: string, details: string[]): void {
    const node = this.nodes.get(id);
    if (!node) return;
    const normalized = details.map((detail) => detail.trim()).filter(Boolean);
    if (arraysEqual(node.details ?? [], normalized)) return;
    node.details = normalized.length > 0 ? normalized : undefined;
    this.invalidate();
  }

  getNodeDetails(id: string): string[] {
    return [...(this.nodes.get(id)?.details ?? [])];
  }

  /** Get the row of the currently active node in the full rendered graph */
  getActiveRow(): number {
    return this.activeRow;
  }

  setEdgeTaken(source: string, target: string): void {
    for (const edge of this.edges) {
      if (edge.source === source && edge.target === target) {
        edge.taken = true;
        this.invalidate();
      }
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    return this.renderLines(width);
  }

  private renderLines(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    if (this.nodes.size === 0) {
      this.cachedWidth = width;
      this.cachedLines = [];
      return [];
    }

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "TB", nodesep: 3, ranksep: 1, marginx: 1, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));

    const maxLabelWidth = Math.max(10, Math.min(30, Math.floor(width / 3)));

    for (const [id, node] of this.nodes) {
      const label = formatNodeLabel(node, maxLabelWidth);
      g.setNode(id, {
        label,
        width: nodeBoxWidth(node, maxLabelWidth),
        height: nodeBoxHeight(node),
      });
    }

    for (const edge of this.edges) {
      if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
        g.setEdge(edge.source, edge.target);
      }
    }

    dagre.layout(g);

    const graphInfo = g.graph();
    const gWidth = Math.ceil(graphInfo.width ?? 60);
    const gHeight = Math.ceil(graphInfo.height ?? 10);
    const horizontalPadding = Math.floor(width / 2);
    const gridW = Math.max(width, gWidth + horizontalPadding * 2);
    const gridH = gHeight + 2;

    const grid: string[][] = [];
    for (let y = 0; y < gridH; y++) {
      grid.push(Array.from({ length: gridW }, () => " "));
    }

    for (const edge of this.edges) {
      const dagreEdge = g.edge(edge.source, edge.target);
      if (!dagreEdge?.points) continue;
      drawEdgeOnGrid(
        grid,
        dagreEdge.points.map((point) => shiftX(point, horizontalPadding)),
        gridW,
        gridH,
        edge.taken,
      );
    }

    this.nodeRows.clear();
    this.nodeColumns.clear();
    this.nodeBounds.clear();
    for (const [id, node] of this.nodes) {
      const rawPos = g.node(id);
      if (!rawPos) continue;
      const pos = shiftX(rawPos, horizontalPadding);
      this.nodeRows.set(id, Math.round(pos.y));
      this.nodeColumns.set(id, Math.round(pos.x));
      const boxW = nodeBoxWidth(node, maxLabelWidth);
      const left = Math.max(0, Math.round(pos.x - boxW / 2));
      this.nodeBounds.set(id, { left, right: Math.min(gridW - 1, left + boxW - 1) });
      drawNodeOnGrid({ grid, pos, node, gridW, gridH, maxLabelWidth });
    }

    let hasActiveNode = false;
    for (const [id, node] of this.nodes) {
      if (node.status === "active") {
        hasActiveNode = true;
        const row = this.nodeRows.get(id);
        const column = this.nodeColumns.get(id);
        if (row !== undefined) this.activeRow = row;
        if (column !== undefined) this.activeColumn = column;
      }
    }
    if (!hasActiveNode) {
      this.activeColumn = horizontalPadding + Math.floor(gWidth / 2);
    }

    const activeBounds = activeNodeBounds(this.nodes, this.nodeBounds);
    const horizontalOffset = resolveHorizontalOffset({
      width,
      gridW,
      activeColumn: this.activeColumn,
      activeBounds,
      nodeBounds: [...this.nodeBounds.values()],
    });
    const lines: string[] = [];
    for (const row of grid) {
      lines.push(visibleSlice(row.join(""), horizontalOffset, width));
    }
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
      lines.pop();
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

function shiftX<T extends { x: number }>(value: T, offset: number): T {
  return { ...value, x: value.x + offset };
}
