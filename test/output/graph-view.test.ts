import { describe, expect, it } from "vitest";
import { GraphView } from "../../src/output/graph-view.js";

describe("GraphView", () => {
	it("renders a simple linear graph", () => {
		const view = new GraphView();
		view.addNode({ id: "S1", label: "Start", type: "start", status: "done" });
		view.addNode({ id: "T1", label: "Run tests", type: "task", status: "active" });
		view.addNode({ id: "E1", label: "End", type: "end", status: "pending" });
		view.addEdge({ source: "S1", target: "T1", taken: true });
		view.addEdge({ source: "T1", target: "E1", taken: false });

		const lines = view.render(80);
		expect(lines.length).toBeGreaterThan(0);

		// The rendered output should contain node labels (stripped of ANSI)
		const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("( )"); // start
		expect(plain).toContain("Run tests"); // task
		expect(plain).toContain("(*)"); // end
	});

	it("renders a branching graph", () => {
		const view = new GraphView();
		view.addNode({ id: "S1", label: "Start", type: "start", status: "done" });
		view.addNode({ id: "T1", label: "Check", type: "task", status: "done" });
		view.addNode({ id: "G1", label: "OK?", type: "gateway", status: "done" });
		view.addNode({ id: "T2", label: "Success", type: "task", status: "active" });
		view.addNode({ id: "T3", label: "Fix", type: "task", status: "pending" });
		view.addNode({ id: "E1", label: "End", type: "end", status: "pending" });

		view.addEdge({ source: "S1", target: "T1", taken: true });
		view.addEdge({ source: "T1", target: "G1", taken: true });
		view.addEdge({ source: "G1", target: "T2", taken: true });
		view.addEdge({ source: "G1", target: "T3", taken: false });
		view.addEdge({ source: "T2", target: "E1", taken: false });
		view.addEdge({ source: "T3", target: "E1", taken: false });

		const lines = view.render(100);
		expect(lines.length).toBeGreaterThan(0);

		const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("Check");
		expect(plain).toContain("OK?");
		expect(plain).toContain("Success");
		expect(plain).toContain("Fix");
	});

	it("updates node status", () => {
		const view = new GraphView();
		view.addNode({ id: "T1", label: "Task", type: "task", status: "pending" });
		view.addEdge({ source: "T1", target: "T1", taken: false }); // self-loop just for test

		// Render pending
		let lines = view.render(40);
		let plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("Task");

		// Update to active
		view.setNodeStatus("T1", "active");
		lines = view.render(40);
		const raw = lines.join("\n");
		// Active nodes use yellow (ANSI 33)
		expect(raw).toContain("\x1b[33m");

		// Update to done
		view.setNodeStatus("T1", "done");
		lines = view.render(40);
		const rawDone = lines.join("\n");
		// Done nodes use green (ANSI 32)
		expect(rawDone).toContain("\x1b[32m");
	});
});
