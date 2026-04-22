import dagre from "dagre";
import { bold, dim, green, red, yellow } from "yoctocolors";

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
 * Renders a BPMN process graph in the terminal using box-drawing characters.
 * Uses dagre for automatic left-to-right layout.
 */
export class GraphView {
	private nodes: Map<string, GraphNode> = new Map();
	private edges: GraphEdge[] = [];
	private renderedHeight = 0;

	addNode(node: GraphNode): void {
		this.nodes.set(node.id, node);
	}

	addEdge(edge: GraphEdge): void {
		this.edges.push(edge);
	}

	setNodeStatus(id: string, status: NodeStatus): void {
		const node = this.nodes.get(id);
		if (node) node.status = status;
	}

	setEdgeTaken(source: string, target: string): void {
		for (const edge of this.edges) {
			if (edge.source === source && edge.target === target) {
				edge.taken = true;
			}
		}
	}

	/**
	 * Render the graph to an array of lines.
	 */
	render(maxWidth: number): string[] {
		const g = new dagre.graphlib.Graph();
		g.setGraph({
			rankdir: "LR",
			nodesep: 2,
			ranksep: 4,
			marginx: 1,
			marginy: 1,
		});
		g.setDefaultEdgeLabel(() => ({}));

		// Add nodes with sizes based on label length
		for (const [id, node] of this.nodes) {
			const label = formatNodeLabel(node);
			const width = visibleLen(label) + 4; // padding
			const height = 3;
			g.setNode(id, { label, width, height });
		}

		// Add edges
		for (const edge of this.edges) {
			if (g.hasNode(edge.source) && g.hasNode(edge.target)) {
				g.setEdge(edge.source, edge.target);
			}
		}

		dagre.layout(g);

		// Get graph dimensions
		const graphInfo = g.graph();
		const gWidth = Math.ceil(graphInfo.width ?? 60);
		const gHeight = Math.ceil(graphInfo.height ?? 10);

		// Create a character grid
		const gridW = Math.min(gWidth + 2, maxWidth);
		const gridH = gHeight + 2;
		const grid: string[][] = [];
		for (let y = 0; y < gridH; y++) {
			grid.push(new Array(gridW).fill(" "));
		}

		// Draw edges first (so nodes draw on top)
		for (const edge of this.edges) {
			const dagreEdge = g.edge(edge.source, edge.target);
			if (!dagreEdge?.points) continue;
			const char = edge.taken ? "─" : dim("·");
			drawEdgeOnGrid(grid, dagreEdge.points, gridW, gridH, char);
		}

		// Draw nodes
		for (const [id, node] of this.nodes) {
			const pos = g.node(id);
			if (!pos) continue;
			drawNodeOnGrid(grid, pos, node, gridW, gridH);
		}

		// Convert grid to lines
		const lines: string[] = [];
		for (const row of grid) {
			lines.push(row.join(""));
		}

		// Trim trailing empty lines
		while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
			lines.pop();
		}

		return lines;
	}

	/**
	 * Print the graph to stdout, clearing previous output.
	 */
	print(maxWidth?: number): void {
		const width = maxWidth ?? process.stdout.columns ?? 80;

		// Clear previous render
		if (this.renderedHeight > 0) {
			process.stdout.write(`\x1b[${this.renderedHeight}A`); // move up
			process.stdout.write("\x1b[0J"); // clear from cursor down
		}

		const lines = this.render(width);
		this.renderedHeight = lines.length;

		for (const line of lines) {
			console.log(line);
		}
	}
}

// -- Node rendering --

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
	const boxW = visibleLen(label) + 4;
	const startX = Math.round(pos.x - boxW / 2);
	const startY = Math.round(pos.y - 1);

	// Choose border/fill based on status and type
	const isSmall = node.type === "start" || node.type === "end";

	if (isSmall) {
		// Compact rendering for start/end
		const styled = styleLabel(label, node);
		writeAt(grid, startY + 1, startX + 1, styled, gridW, gridH);
		return;
	}

	// Draw box: top border, content, bottom border
	const top = "┌" + "─".repeat(boxW - 2) + "┐";
	const bot = "└" + "─".repeat(boxW - 2) + "┘";
	const content = "│ " + styleLabel(label, node) + " │";

	const borderStyle = getBorderStyle(node);
	writeAt(grid, startY, startX, borderStyle(top), gridW, gridH);
	writeAt(grid, startY + 1, startX, borderStyle("│") + " " + styleLabel(label, node) + " " + borderStyle("│"), gridW, gridH);
	writeAt(grid, startY + 2, startX, borderStyle(bot), gridW, gridH);
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

// -- Edge rendering --

function drawEdgeOnGrid(
	grid: string[][],
	points: Array<{ x: number; y: number }>,
	gridW: number,
	gridH: number,
	char: string,
): void {
	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[i];
		const p1 = points[i + 1];
		drawLineOnGrid(grid, Math.round(p0.x), Math.round(p0.y), Math.round(p1.x), Math.round(p1.y), gridW, gridH, char);
	}
	// Draw arrowhead at last point
	const last = points[points.length - 1];
	const prev = points[points.length - 2];
	if (last && prev) {
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
	// Simple bresenham-like line drawing
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
				// Choose character based on direction
				if (dx > dy) {
					grid[cy][cx] = char;
				} else {
					grid[cy][cx] = "│";
				}
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
	if (row < 0 || row >= gridH) return;
	// We need to handle styled text — write character by character
	// For ANSI-styled strings, we write the whole string starting at col
	// by replacing grid cells. Since grid is char-based and styled text
	// has invisible ANSI codes, we store the full styled string in cell 0
	// and blank subsequent cells.
	const len = visibleLen(text);
	if (col < 0 || col >= gridW) return;

	// Simple approach: write the styled string into the grid as a single unit
	grid[row][col] = text;
	for (let i = 1; i < len && col + i < gridW; i++) {
		grid[row][col + i] = "";
	}
}

function visibleLen(str: string): number {
	// Strip ANSI escape sequences to get visible length
	return str.replace(/\x1b\[[0-9;]*m/g, "").length;
}


