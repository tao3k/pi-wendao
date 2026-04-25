import dagre from "dagre";
import { bold, dim, green, red, yellow } from "yoctocolors";
import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export type NodeStatus = "pending" | "active" | "done" | "error";

export interface GraphNode {
	id: string;
	label: string;
	type: "start" | "end" | "task" | "gateway" | "boundary";
	status: NodeStatus;
	details?: string[];
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
	/** Row of the currently active node in the full rendered output */
	private activeRow = 0;
	/** Column of the currently active node in the full rendered output */
	private activeColumn = 0;
	private nodeRows: Map<string, number> = new Map();
	private nodeColumns: Map<string, number> = new Map();
	private nodeBounds: Map<string, { left: number; right: number }> = new Map();

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

		// Cap node label width — use wider labels since TB layout is narrow
		const maxLabelWidth = Math.max(10, Math.min(30, Math.floor(width / 3)));

		for (const [id, node] of this.nodes) {
			const label = formatNodeLabel(node, maxLabelWidth);
			g.setNode(id, { label, width: nodeBoxWidth(node, maxLabelWidth), height: nodeBoxHeight(node) });
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
			const gridW = Math.max(width, gWidth + width);
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

		// Draw nodes and record positions
		this.nodeRows.clear();
		this.nodeColumns.clear();
		this.nodeBounds.clear();
		for (const [id, node] of this.nodes) {
			const pos = g.node(id);
			if (!pos) continue;
			this.nodeRows.set(id, Math.round(pos.y));
			this.nodeColumns.set(id, Math.round(pos.x));
			const boxW = nodeBoxWidth(node, maxLabelWidth);
			const left = Math.max(0, Math.round(pos.x - boxW / 2));
			this.nodeBounds.set(id, { left, right: Math.min(gridW - 1, left + boxW - 1) });
			drawNodeOnGrid(grid, pos, node, gridW, gridH, maxLabelWidth);
		}

		// Update active viewport anchor for the currently active node
		for (const [id, node] of this.nodes) {
			if (node.status === "active") {
				const row = this.nodeRows.get(id);
				const column = this.nodeColumns.get(id);
				if (row !== undefined) this.activeRow = row;
				if (column !== undefined) this.activeColumn = column;
			}
		}

			// Convert grid to lines, keeping the active node box intact.
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
		while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
			lines.pop();
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

function resolveHorizontalOffset(options: {
	width: number;
	gridW: number;
	activeColumn: number;
	activeBounds?: { left: number; right: number };
	nodeBounds: Array<{ left: number; right: number }>;
}): number {
	const maxOffset = Math.max(0, options.gridW - options.width);
	let offset = clamp(options.activeColumn - Math.floor(options.width / 2), 0, maxOffset);
	const bounds = options.activeBounds;
	if (bounds) {
		const padding = Math.min(2, Math.max(0, Math.floor((options.width - 1) / 4)));
		const left = Math.max(0, bounds.left - padding);
		const right = Math.min(options.gridW - 1, bounds.right + padding);
		if (right - left + 1 <= options.width) {
			offset = left;
			if (offset + options.width - 1 < right) offset = right - options.width + 1;
		}
	}

	return avoidClippedNodeBoxes(clamp(offset, 0, maxOffset), options.width, maxOffset, options.nodeBounds, bounds);
}

function activeNodeBounds(
	nodes: Map<string, GraphNode>,
	nodeBounds: Map<string, { left: number; right: number }>,
): { left: number; right: number } | undefined {
	let bounds: { left: number; right: number } | undefined;
	for (const [id, node] of nodes) {
		if (node.status === "active") bounds = nodeBounds.get(id);
	}
	return bounds;
}

function avoidClippedNodeBoxes(
	initialOffset: number,
	width: number,
	maxOffset: number,
	nodeBounds: Array<{ left: number; right: number }>,
	activeBounds?: { left: number; right: number },
): number {
	let offset = initialOffset;
	for (let pass = 0; pass < 2; pass += 1) {
		let changed = false;
		for (const bounds of nodeBounds) {
			if (sameBounds(bounds, activeBounds)) continue;
			const rightEdge = offset + width - 1;
			if (bounds.left < offset && offset <= bounds.right) {
				const candidate = clamp(bounds.right + 1, 0, maxOffset);
				if (keepsActiveVisible(candidate, width, activeBounds)) {
					offset = candidate;
					changed = true;
				}
			} else if (bounds.left <= rightEdge && rightEdge < bounds.right) {
				const candidate = clamp(bounds.left - width, 0, maxOffset);
				if (keepsActiveVisible(candidate, width, activeBounds)) {
					offset = candidate;
					changed = true;
				}
			}
		}
		if (!changed) break;
	}
	return offset;
}

function sameBounds(
	left: { left: number; right: number },
	right: { left: number; right: number } | undefined,
): boolean {
	return !!right && left.left === right.left && left.right === right.right;
}

function keepsActiveVisible(offset: number, width: number, activeBounds: { left: number; right: number } | undefined): boolean {
	if (!activeBounds) return true;
	return activeBounds.left >= offset && activeBounds.right <= offset + width - 1;
}

function visibleSlice(text: string, start: number, width: number): string {
	if (width <= 0) return "";
	let column = 0;
	let emitted = 0;
	let result = "";
	let sawAnsi = false;

	for (let index = 0; index < text.length;) {
		const ansi = text.slice(index).match(/^\x1b\[[0-9;]*m/);
		if (ansi) {
			sawAnsi = true;
			if (column >= start && emitted < width) result += ansi[0];
			index += ansi[0].length;
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

	if (sawAnsi && result) result += "\x1b[0m";
	return truncateToWidth(result, width);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
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

		const rendered = this.lines.map((line) => truncateToWidth(line, width));

		this.cachedWidth = width;
		this.cachedRendered = rendered;
		return rendered;
	}
}

// -- Node helpers --

function formatNodeLabel(node: GraphNode, maxWidth = 20): string {
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

function truncLabel(label: string, max: number): string {
	if (label.length <= max) return label;
	return label.slice(0, max - 1) + "\u2026";
}

function formatNodeDetails(node: GraphNode, maxWidth = 20): string[] {
	if (node.type === "start" || node.type === "end") return [];
	return (node.details ?? []).slice(0, 3).map((detail) => truncLabel(detail, maxWidth));
}

function nodeBoxHeight(node: GraphNode): number {
	if (node.type === "start" || node.type === "end") return 3;
	return 3 + formatNodeDetails(node).length;
}

function nodeBoxWidth(node: GraphNode, maxLabelWidth = 20): number {
	const label = formatNodeLabel(node, maxLabelWidth);
	const details = formatNodeDetails(node, maxLabelWidth);
	if (node.type === "start" || node.type === "end") {
		return stripAnsi(label).length + 2;
	}
	return Math.max(
		stripAnsi(label).length,
		...details.map((detail) => stripAnsi(detail).length),
	) + 4;
}

function drawNodeOnGrid(
	grid: string[][],
	pos: { x: number; y: number; width: number; height: number },
	node: GraphNode,
	gridW: number,
	gridH: number,
	maxLabelWidth = 20,
): void {
	const label = formatNodeLabel(node, maxLabelWidth);
	const details = formatNodeDetails(node, maxLabelWidth);
	const boxW = nodeBoxWidth(node, maxLabelWidth);
	const boxH = nodeBoxHeight(node);
	const startX = Math.round(pos.x - boxW / 2);
	const startY = Math.round(pos.y - boxH / 2);

	const isSmall = node.type === "start" || node.type === "end";
	if (isSmall) {
		writeAt(grid, startY + 1, startX + 1, styleLabel(label, node), gridW, gridH);
		return;
	}

	const border = getBorderStyle(node);
	const top = border("┌" + "─".repeat(boxW - 2) + "┐");
	const mid = boxLine(label, boxW, border, (text) => styleLabel(text, node));
	const bot = border("└" + "─".repeat(boxW - 2) + "┘");

	writeAt(grid, startY, startX, top, gridW, gridH);
	writeAt(grid, startY + 1, startX, mid, gridW, gridH);
	for (let i = 0; i < details.length; i++) {
		writeAt(grid, startY + 2 + i, startX, boxLine(details[i], boxW, border, dim), gridW, gridH);
	}
	writeAt(grid, startY + boxH - 1, startX, bot, gridW, gridH);
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

// -- Edge helpers --

function drawEdgeOnGrid(
	grid: string[][],
	points: Array<{ x: number; y: number }>,
	gridW: number,
	gridH: number,
	taken: boolean,
): void {
	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[i];
		const p1 = points[i + 1];
		drawLineOnGrid(grid, Math.round(p0.x), Math.round(p0.y), Math.round(p1.x), Math.round(p1.y), gridW, gridH, taken);
	}
	const last = points[points.length - 1];
	if (last) {
		const lx = Math.round(last.x);
		const ly = Math.round(last.y);
		if (lx >= 0 && lx < gridW && ly >= 0 && ly < gridH) {
			grid[ly][lx] = "▾";
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
			if (grid[cy][cx] === " ") {
				grid[cy][cx] = edgeGlyph(dx, dy, taken);
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

function writeAt(grid: string[][], row: number, col: number, text: string, gridW: number, gridH: number): void {
	if (row < 0 || row >= gridH || col < 0 || col >= gridW) return;
	const cells = splitStyledCells(text);
	for (let i = 0; i < cells.length && col + i < gridW; i++) {
		grid[row][col + i] = cells[i] ?? "";
	}
}

function splitStyledCells(text: string): string[] {
	const cells: string[] = [];
	let activeAnsi = "";
	for (let index = 0; index < text.length;) {
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

function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function arraysEqual(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((value, index) => value === right[index]);
}
