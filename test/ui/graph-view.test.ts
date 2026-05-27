import { describe, expect, it } from "vitest";
import { GraphView, LogView } from "../../src/ui/graph-view.js";
import { stripAnsi } from "../../src/ui/ansi.js";

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
    const plain = stripAnsi(lines.join("\n"));
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

    const plain = stripAnsi(lines.join("\n"));
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
    let plain = stripAnsi(lines.join("\n"));
    expect(plain).toContain("Task");

    // Update to active
    view.setNodeStatus("T1", "active");
    lines = view.render(40);
    plain = stripAnsi(lines.join("\n"));
    expect(plain).toContain("Task");
    expect(statusOf(view, "T1")).toBe("active");

    // Update to done
    view.setNodeStatus("T1", "done");
    lines = view.render(40);
    plain = stripAnsi(lines.join("\n"));
    expect(plain).toContain("Task");
    expect(statusOf(view, "T1")).toBe("done");
  });

  it("renders runtime details inside task nodes", () => {
    const view = new GraphView();
    view.addNode({ id: "T1", label: "Review", type: "task", status: "active" });
    view.setNodeDetails("T1", [
      "llm:bash t2/8 1t",
      "host:2 pi-subagents",
      "checkpoint:duckdb/fresh",
    ]);

    const plain = stripAnsi(view.render(80).join("\n"));

    expect(plain).toContain("Review");
    expect(plain).toContain("llm:bash t2/8 1t");
    expect(plain).toContain("host:2 pi-subagents");
    expect(plain).toContain("checkpoint:duckdb/fresh");
    expect(view.getNodeDetails("T1")).toEqual([
      "llm:bash t2/8 1t",
      "host:2 pi-subagents",
      "checkpoint:duckdb/fresh",
    ]);
  });

  it("centers a compact active graph in a wide viewport", () => {
    const view = new GraphView();
    view.addNode({ id: "T1", label: "Centered", type: "task", status: "active" });

    const line = stripAnsi(view.render(80).join("\n"))
      .split("\n")
      .find((item) => item.includes("Centered"));
    const leading = line?.search(/\S/) ?? -1;

    expect(leading).toBeGreaterThan(25);
    expect(leading).toBeLessThan(45);
  });

  it("recenters the viewport when the active parallel branch changes", () => {
    const view = new GraphView();
    view.addNode({ id: "S1", label: "Start", type: "start", status: "done" });
    view.addNode({ id: "G1", label: "Parallel", type: "gateway", status: "done" });
    for (const id of ["A", "B", "C", "D", "E", "F"]) {
      view.addNode({
        id,
        label: `Branch ${id}`,
        type: "task",
        status: id === "A" ? "active" : "done",
      });
      view.addEdge({ source: "G1", target: id, taken: id === "A" });
    }
    view.addEdge({ source: "S1", target: "G1", taken: true });

    const leftViewport = stripAnsi(view.render(24).join("\n"));
    view.setNodeStatus("A", "done");
    view.setNodeStatus("F", "active");
    const rightViewport = stripAnsi(view.render(24).join("\n"));

    expect(leftViewport).toContain("Branch A");
    expect(leftViewport).not.toContain("Branch F");
    expect(rightViewport).toContain("Branch F");
    expect(rightViewport).not.toContain("Branch A");
  });

  it("keeps the active branch visible in a narrow viewport", () => {
    const view = new GraphView();
    view.addNode({ id: "S1", label: "Start", type: "start", status: "done" });
    view.addNode({ id: "G1", label: "Parallel", type: "gateway", status: "done" });
    view.addNode({ id: "A", label: "Branch A", type: "task", status: "done" });
    view.addNode({ id: "B", label: "Branch B", type: "task", status: "done" });
    view.addNode({ id: "C", label: "Branch C", type: "task", status: "done" });
    view.addNode({ id: "D", label: "Branch D", type: "task", status: "done" });
    view.addNode({ id: "E", label: "Branch E", type: "task", status: "done" });
    view.addNode({ id: "F", label: "Branch F", type: "task", status: "active" });
    view.addNode({ id: "End", label: "End", type: "end", status: "pending" });
    view.addEdge({ source: "S1", target: "G1", taken: true });
    for (const id of ["A", "B", "C", "D", "E", "F"]) {
      view.addEdge({ source: "G1", target: id, taken: id !== "F" });
      view.addEdge({ source: id, target: "End", taken: false });
    }

    const plain = stripAnsi(view.render(24).join("\n"));

    expect(plain).toContain("Branch F");
    expect(plain).toContain("┌──────────┐");
    expect(plain).toContain("│ Branch F │");
    expect(plain).toContain("└──────────┘");
    expect(plain).not.toMatch(/^[┐┘]/m);
    expect(plain).not.toContain("││││");
  });
});

describe("LogView", () => {
  it("clears old workflow log lines", () => {
    const view = new LogView();
    view.appendLine("workflow: old.bpmn");
    view.clear();
    view.appendLine("workflow: new.bpmn");

    expect(view.getLines()).toEqual(["workflow: new.bpmn"]);
    expect(stripAnsi(view.render(80).join("\n"))).toBe("workflow: new.bpmn");
  });
});

function statusOf(view: GraphView, id: string): string | undefined {
  return (view as unknown as { nodes: Map<string, { status: string }> }).nodes.get(id)?.status;
}
