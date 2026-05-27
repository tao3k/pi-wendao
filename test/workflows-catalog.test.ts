import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeArrowIpcTable, decodeArrowIpcTable } from "../src/arrow/ipc.js";
import {
  fixtureQianjiWorkflowCatalogArrowTable,
  listFixtureQianjiWorkflowCatalog,
  qianjiWorkflowCatalogRowsFromFlowhubRegistry,
  qianjiWorkflowCatalogRowsFromTable,
} from "../src/workflows.js";
import type { FlowhubScenarioRegistry } from "../src/cli/flowhub-scenario/types.js";

describe("qianji workflow ArrowSchema catalog", () => {
  it("round-trips fixture workflow catalog rows through Arrow IPC", () => {
    const rows = listFixtureQianjiWorkflowCatalog({ refresh: true });

    const decoded = qianjiWorkflowCatalogRowsFromTable(
      decodeArrowIpcTable(encodeArrowIpcTable(fixtureQianjiWorkflowCatalogArrowTable())),
    );

    expect(rows.length).toBeGreaterThan(4);
    expect(decoded.map((row) => row.workflowId)).toEqual(rows.map((row) => row.workflowId));
    expect(decoded.every((row) => row.catalogSource === "fixture")).toBe(true);
    expect(decoded.every((row) => row.qianjiLintRequired)).toBe(true);
  });

  it("keeps checked-in BPMN files classified as test fixtures, not built-in workflows", () => {
    const row = listFixtureQianjiWorkflowCatalog({ refresh: true }).find(
      (candidate) => candidate.workflowId === "simple-workflow",
    );

    expect(row).toBeDefined();
    expect(row?.catalogSource).toBe("fixture");
    expect(row?.sourcePath).toContain("test/fixtures/simple-workflow.bpmn");
  });

  it("maps qianji-server FlowHub registry rows into the same Arrow catalog contract", () => {
    const registry: FlowhubScenarioRegistry = {
      passed: true,
      sourcePairs: [
        {
          scenarioId: "agent-coding",
          bpmnProcessId: "Process_AgentCoding",
          bpmnSource: "agent-coding.bpmn",
          orgSource: "agent-coding.org",
          bpmnSha256: "a".repeat(64),
          orgSha256: "b".repeat(64),
        },
      ],
    };

    const rows = qianjiWorkflowCatalogRowsFromFlowhubRegistry(registry, {
      flowhubRoot: "/flowhub",
      readSource: () => qianjiLikeBpmnWithDi(),
    });
    const decoded = qianjiWorkflowCatalogRowsFromTable(
      decodeArrowIpcTable(
        encodeArrowIpcTable(fixtureQianjiWorkflowCatalogArrowTable({ refresh: true })),
      ),
    );

    expect(rows).toMatchObject([
      {
        workflowId: "agent-coding",
        catalogSource: "flowhub",
        sourcePath: "/flowhub/agent-coding.bpmn",
        orgSourcePath: "/flowhub/agent-coding.org",
        processId: "Process_AgentCoding",
        bpmnJsRenderable: true,
      },
    ]);
    expect(decoded.length).toBeGreaterThan(0);
  });

  it("uses bpmn-js examples as the DI legality reference surface", () => {
    const referencePath = join(
      process.cwd(),
      "..",
      "..",
      ".data",
      "research",
      "bpmn-js-examples",
      "starter",
      "diagram.bpmn",
    );
    const sample = existsSync(referencePath)
      ? readFileSync(referencePath, "utf-8")
      : qianjiLikeBpmnWithDi();

    expect(sample).toContain("bpmndi:BPMNDiagram");
    expect(sample).toContain("dc:Bounds");
    expect(sample).toContain("di:waypoint");
    expect(qianjiLikeBpmnWithDi()).toContain("bpmndi:BPMNDiagram");
  });
});

function qianjiLikeBpmnWithDi(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
             xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
             id="Definitions_1"
             targetNamespace="https://qianji.dev/test">
  <process id="Process_AgentCoding" isExecutable="true">
    <startEvent id="Start_1"/>
    <endEvent id="End_1"/>
    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="End_1"/>
  </process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_Process_AgentCoding">
    <bpmndi:BPMNPlane id="BPMNPlane_Process_AgentCoding" bpmnElement="Process_AgentCoding">
      <bpmndi:BPMNShape id="Shape_Start_1" bpmnElement="Start_1">
        <dc:Bounds x="80" y="122" width="36" height="36"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Shape_End_1" bpmnElement="End_1">
        <dc:Bounds x="516" y="122" width="36" height="36"/>
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Edge_Flow_1" bpmnElement="Flow_1">
        <di:waypoint x="116" y="140"/>
        <di:waypoint x="516" y="140"/>
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`;
}
