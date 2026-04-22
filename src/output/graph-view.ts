import dagre from "dagre";
import { bold, dim, green, red, yellow } from "yoctocolors";
import { type Component, Container, Text } from "@mariozechner/pi-tui";

export type NodeStatus = "pending" | "active" | "done" | "error";

export interface GraphNode {
	id: string;
	label: string;
	type: "start" | "end" | "task" | "gateway" | "boundary";
	status: NodeStatus;
}

export interface GraphEdge {
	source: string;
	target: string;
	label?: string;
	taken: boolean;
}

/**
 * pi-tui Component that renders a BPMN process graph using dagre layout
 * and box-drawing characters.
 */
export class GraphView implements Component {
	private nodes: Map<string, GraphNode> = new Map();
	private edges: GraphEdge[] = [];
	private cachedWidth?: number;
	private cachedLines?: string[];

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
			this.invalidate();
		}
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
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		if (this.nodes.size === 0) {
			this.cachedWidth = width;
			this.cachedLines = [];
			return [];
		}

		const g = new dagre.graphlib.Graph();
		g.setGraph({ rankdir: "LR", nodesep: 2, ranksep: 4, marginx: 1, marginy: 1 });
		g.setDefaultEdgeLabel(() => ({}));

		for (const [id, node] of this.nodes) {
			const label = formatNodeLabel(node);
			const w = stripAnsi(label).length + 4;
			g.setNode(id, { label, width: w, height: 3 });
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
		const gridW = Math.min(gWidth + 2, width);
		const gridH = gHeight + 2;

		// Build a plain char grid, then convert to styled lines
		const grid: string[][] = [];
		for (let y = 0; y < gridH; y++) {
			grid.push(new Array(gridW).fill(" "));
		}

		// Draw edges
		for (const edge of this.edges) {
			const dagreEdge = g.edge(edge.source, edge.target);
			if (!dagreEdge?.points) continue;
			drawEdgeOnGrid(grid, dagreEdge.points, gridW, gridH, edge.taken);
		}

		// Draw nodes
		for (const [id, node] of this.nodes) {
			const pos = g.node(id);
			if (!pos) continue;
			drawNodeOnGrid(grid, pos, node, gridW, gridH);
		}

		// Convert grid to lines, trim trailing blanks
		const lines: string[] = [];
		for (const row of grid) {
			lines.push(row.join(""));
		}
		while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
			lines.pop();
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

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

	appendLine(line: string): void {
		this.lines.push(line);
		if (this.lines.length > this.maxLines) {
			this.lines.shift();
		}
		this.invalidate();
	}

	appendText(text: string): void {
		// Append to last line or create new
		if (this.lines.length === 0) {
			this.lines.push("");
		}
		const parts = text.split("\n");
		this.lines[this.lines.length - 1] += parts[0];
		for (let i = 1; i < parts.length; i++) {
			this.lines.push(parts[i]);
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

		// Truncate lines to width
		const rendered = this.lines.map((line) => {
			const vis = stripAnsi(line).length;
			if (vis <= width) return line;
			// Rough truncation — good enough for log output
			return line.slice(0, width);
		});

		this.cachedWidth = width;
		this.cachedRendered = rendered;
		return rendered;
	}
}

// -- Node helpers --

function formatNodeLabel(node: GraphNode): string {
	switch (node.type) {
		case "start":
			return "( )";
		case "end":
			return "(*)";
		case "gateway":
			return `<${truncLabel(node.label, 16)}>`;
		case "task":
			return truncLabel(node.label, 20);
		case "boundary":
			return "err";
		default:
			return node.label;
	}
}

function truncLabel(label: string, max: number): string {
	if (label.length <= max) return label;
	return label.slice(0, max - 1) + "\u2026";
}

function drawNodeOnGrid(
	grid: string[][],
	pos: { x: number; y: number; width: number; height: number },
	node: GraphNode,
	gridW: number,
	gridH: number,
): void {
	const label = formatNodeLabel(node);
	const boxW = stripAnsi(label).length + 4;
	const startX = Math.round(pos.x - boxW / 2);
	const startY = Math.round(pos.y - 1);

	const isSmall = node.type === "start" || node.type === "end";
	if (isSmall) {
		writeAt(grid, startY + 1, startX + 1, styleLabel(label, node), gridW, gridH);
		return;
	}

	const border = getBorderStyle(node);
	const top = border("┌" + "─".repeat(boxW - 2) + "┐");
	const mid = border("│") + " " + styleLabel(label, node) + " " + border("│");
	const bot = border("└" + "─".repeat(boxW - 2) + "┘");

	writeAt(grid, startY, startX, top, gridW, gridH);
	writeAt(grid, startY + 1, startX, mid, gridW, gridH);
	writeAt(grid, startY + 2, startX, bot, gridW, gridH);
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

// -- Edge helpers --

function drawEdgeOnGrid(
	grid: string[][],
	points: Array<{ x: number; y: number }>,
	gridW: number,
	gridH: number,
	taken: boolean,
): void {
	const char = taken ? "─" : dim("·");
	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[i];
		const p1 = points[i + 1];
		drawLineOnGrid(grid, Math.round(p0.x), Math.round(p0.y), Math.round(p1.x), Math.round(p1.y), gridW, gridH, char);
	}
	const last = points[points.length - 1];
	if (last) {
		const lx = Math.round(last.x);
		const ly = Math.round(last.y);
		if (lx >= 0 && lx < gridW && ly >= 0 && ly < gridH) {
			grid[ly][lx] = "▸";
		}
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
	char: string,
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
			if (grid[cy][cx] === " ") {
				grid[cy][cx] = dx > dy ? char : "│";
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

function writeAt(grid: string[][], row: number, col: number, text: string, gridW: number, gridH: number): void {
	if (row < 0 || row >= gridH || col < 0 || col >= gridW) return;
	const len = stripAnsi(text).length;
	grid[row][col] = text;
	for (let i = 1; i < len && col + i < gridW; i++) {
		grid[row][col + i] = "";
	}
}

function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}
