import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import type { FauxProviderRegistration } from "@mariozechner/pi-ai";
import { compileSkill } from "../../src/compiler/compiler.js";

const fixturesDir = join(import.meta.dirname, "../fixtures");

function qianjiTemplate() {
	return {
		runner: async (domain: "bpmn" | "dmn") => ({
			success: true as const,
			template: domain === "bpmn"
				? '<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="Process_1" isExecutable="true"/></definitions>'
				: '<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="Definitions_1" namespace="http://skillsc.dev/dmn"><decision id="skill-decision"><decisionTable id="table_1" hitPolicy="UNIQUE"><input id="input_1"><inputExpression id="input_expression_1" typeRef="string"><text>input</text></inputExpression></input><output id="output_1" name="decision" typeRef="string"/><rule id="rule_1"><inputEntry id="input_entry_1"><text>-</text></inputEntry><outputEntry id="output_entry_1"><text>"review"</text></outputEntry></rule></decisionTable></decision></definitions>',
		}),
	};
}

function bpmnTarget() {
	return {
		runner: async () => ({
			target: "bpmn" as const,
			reason: "test default",
			dmnDecisions: [],
		}),
	};
}

describe("compileSkill", () => {
	let faux: FauxProviderRegistration;

	beforeEach(() => {
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
	});

	it("compiles a skill into BPMN XML", async () => {
		const expectedXml = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");

		faux.setResponses([fauxAssistantMessage("```xml\n" + expectedXml + "\n```")]);

		const result = await compileSkill({
				skillContent: "# Simple Skill\nDo something.",
				model: faux.getModel(),
				template: qianjiTemplate(),
				target: bpmnTarget(),
				lint: false,
			});

		expect(result.success).toBe(true);
		expect(result.bpmnXml).toContain("<definitions");
		expect(result.bpmnXml).toContain("serviceTask");
	});

	it("handles raw XML without code fences", async () => {
		const xml = '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P1" isExecutable="true"><startEvent id="S1"/></process></definitions>';

		faux.setResponses([fauxAssistantMessage(xml)]);

		const result = await compileSkill({
				skillContent: "# Skill\nDo it.",
				model: faux.getModel(),
				template: qianjiTemplate(),
				target: bpmnTarget(),
				lint: false,
			});

		expect(result.success).toBe(true);
		expect(result.bpmnXml).toContain("<definitions");
	});

	it("lets the model choose BPMN+DMN and returns both artifacts", async () => {
		const bpmn = '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P1" isExecutable="true"><startEvent id="S1"/><businessRuleTask id="Decision_1" decisionRef="eligibility-decision"/><endEvent id="E1"/></process></definitions>';
		const dmn = '<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="Definitions_1" namespace="http://skillsc.dev/dmn"><decision id="eligibility-decision" name="Eligibility"><decisionTable id="Table_1" hitPolicy="UNIQUE"><input id="Input_1"><inputExpression id="InputExpression_1" typeRef="string"><text>tier</text></inputExpression></input><output id="Output_1" name="eligible" typeRef="boolean"/><rule id="Rule_1"><inputEntry id="InputEntry_1"><text>"gold"</text></inputEntry><outputEntry id="OutputEntry_1"><text>true</text></outputEntry></rule></decisionTable></decision></definitions>';

		faux.setResponses([
			fauxAssistantMessage('{"target":"bpmn-dmn","reason":"The skill has a stable eligibility table.","dmnDecisions":["eligibility-decision"]}'),
			fauxAssistantMessage("```bpmn\n" + bpmn + "\n```\n```dmn\n" + dmn + "\n```"),
		]);

		const result = await compileSkill({
			skillContent: "# Skill\nUse an eligibility table.",
			model: faux.getModel(),
			template: qianjiTemplate(),
			lint: false,
		});

		expect(result.success).toBe(true);
		expect(result.targetDecision?.target).toBe("bpmn-dmn");
		expect(result.bpmnXml).toContain("businessRuleTask");
		expect(result.dmnXml).toContain("eligibility-decision");
	});

	it("normalizes pure DMN target decisions into BPMN+DMN", async () => {
		const bpmn = '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P1" isExecutable="true"><startEvent id="S1"/><businessRuleTask id="Decision_1" decisionRef="eligibility-decision"/><endEvent id="E1"/></process></definitions>';
		const dmn = '<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="Definitions_1" namespace="http://skillsc.dev/dmn"><decision id="eligibility-decision" name="Eligibility"><decisionTable id="Table_1" hitPolicy="UNIQUE"><input id="Input_1"><inputExpression id="InputExpression_1" typeRef="string"><text>tier</text></inputExpression></input><output id="Output_1" name="eligible" typeRef="boolean"/><rule id="Rule_1"><inputEntry id="InputEntry_1"><text>-</text></inputEntry><outputEntry id="OutputEntry_1"><text>true</text></outputEntry></rule></decisionTable></decision></definitions>';

		faux.setResponses([
			fauxAssistantMessage('{"target":"dmn","reason":"The skill is mostly a decision table.","dmnDecisions":["eligibility-decision"]}'),
			fauxAssistantMessage("```bpmn\n" + bpmn + "\n```\n```dmn\n" + dmn + "\n```"),
		]);

		const result = await compileSkill({
			skillContent: "# Skill\nUse an eligibility table.",
			model: faux.getModel(),
			template: qianjiTemplate(),
			lint: false,
		});

		expect(result.success).toBe(true);
		expect(result.targetDecision?.target).toBe("bpmn-dmn");
		expect(result.targetDecision?.normalizedFrom).toBe("dmn");
		expect(result.dmnXml).toContain("eligibility-decision");
	});

	it("returns error when model produces no XML", async () => {
		faux.setResponses([fauxAssistantMessage("I cannot compile this skill.")]);

		const result = await compileSkill({
				skillContent: "# Skill\nDo it.",
				model: faux.getModel(),
				template: qianjiTemplate(),
				target: bpmnTarget(),
				lint: false,
			});

		expect(result.success).toBe(false);
		expect(result.errors).toContain("No valid XML found in model response");
	});

	it("returns error when model errors", async () => {
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Rate limit" })]);

		const result = await compileSkill({
				skillContent: "# Skill\nDo it.",
				model: faux.getModel(),
				template: qianjiTemplate(),
				target: bpmnTarget(),
				lint: false,
			});

		expect(result.success).toBe(false);
		expect(result.errors?.[0]).toContain("Rate limit");
	});

	it("loads qianji template before requesting BPMN from the model", async () => {
		const expectedXml = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
		const requestedTemplates: string[] = [];
		faux.setResponses([fauxAssistantMessage("```xml\n" + expectedXml + "\n```")]);

		const result = await compileSkill({
			skillContent: "# Skill\nDo it.",
			model: faux.getModel(),
				template: {
					runner: async (domain) => {
						requestedTemplates.push(domain);
						return { success: true, template: `<${domain}/>` };
					},
				},
				target: bpmnTarget(),
				lint: false,
			});

		expect(result.success).toBe(true);
		expect(requestedTemplates).toEqual(["bpmn"]);
	});

	it("returns template errors before model compilation", async () => {
		const result = await compileSkill({
			skillContent: "---\nname: [oops\n---\n# Skill",
			model: faux.getModel(),
				template: {
					runner: async () => ({ success: false, errors: ["qianji template failed"] }),
				},
				target: bpmnTarget(),
				lint: false,
			});

		expect(result.success).toBe(false);
		expect(result.errors).toEqual(["qianji template failed"]);
	});

	it("feeds qianji lint failures through the compile repair loop", async () => {
		const invalidXml = '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P1" isExecutable="true"><startEvent id="S1"/><exclusiveGateway id="Gateway_1"/><sequenceFlow id="Flow_1" sourceRef="Gateway_1" targetRef="S2"><conditionExpression>status == "ready"</conditionExpression></sequenceFlow><endEvent id="S2"/></process></definitions>';
		const repairedXml = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
		const lintedXml: string[] = [];

		faux.setResponses([
			fauxAssistantMessage("```xml\n" + invalidXml + "\n```"),
			fauxAssistantMessage("```xml\n" + repairedXml + "\n```"),
		]);

		const result = await compileSkill({
				skillContent: "# Skill\nDo it.",
				model: faux.getModel(),
				template: qianjiTemplate(),
				target: bpmnTarget(),
				lint: {
				maxRepairAttempts: 1,
				runner: async (xml) => {
					lintedXml.push(xml);
					if (xml.includes("status ==")) {
						return { success: false, output: "unsupported gateway condition" };
					}
					return { success: true, output: "ok" };
				},
			},
		});

		expect(result.success).toBe(true);
		expect(result.bpmnXml).toContain("<definitions");
		expect(lintedXml[0]).toBe(invalidXml);
		expect(lintedXml.at(-1)?.trim()).toBe(repairedXml.trim());
	});

	it("feeds pi-wendao compile contract failures back through the lint repair loop", async () => {
		const missingPiWendaoConfigXml = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="P1" isExecutable="true">
    <startEvent id="S1"/>
    <serviceTask id="Task_1"/>
    <endEvent id="E1"/>
    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_1"/>
    <sequenceFlow id="F2" sourceRef="Task_1" targetRef="E1"/>
  </process>
</definitions>`;
		const repairedXml = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
		const lintedXml: string[] = [];

		faux.setResponses([
			fauxAssistantMessage("```xml\n" + missingPiWendaoConfigXml + "\n```"),
			fauxAssistantMessage("```xml\n" + repairedXml + "\n```"),
		]);

		const result = await compileSkill({
				skillContent: "# Skill\nList files.",
				model: faux.getModel(),
				template: qianjiTemplate(),
				target: bpmnTarget(),
				lint: {
				maxRepairAttempts: 1,
				runner: async (xml) => {
					lintedXml.push(xml);
					return { success: true, output: "# Lint Passed" };
				},
			},
		});

		expect(result.success).toBe(true);
		expect(result.bpmnXml?.trim()).toBe(repairedXml.trim());
		expect(lintedXml).toHaveLength(2);
		expect(lintedXml[0]).toBe(missingPiWendaoConfigXml);
	});

	it("lints BPMN and DMN artifacts in the compile loop", async () => {
		const bpmn = '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P1" isExecutable="true"><startEvent id="S1"/><businessRuleTask id="Decision_1" decisionRef="eligibility-decision"/><endEvent id="E1"/></process></definitions>';
		const dmn = '<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="Definitions_1" namespace="http://skillsc.dev/dmn"><decision id="eligibility-decision" name="Eligibility"><decisionTable id="Table_1" hitPolicy="UNIQUE"><input id="Input_1"><inputExpression id="InputExpression_1" typeRef="string"><text>tier</text></inputExpression></input><output id="Output_1" name="eligible" typeRef="boolean"/><rule id="Rule_1"><inputEntry id="InputEntry_1"><text>-</text></inputEntry><outputEntry id="OutputEntry_1"><text>true</text></outputEntry></rule></decisionTable></decision></definitions>';
		const lintedBpmn: string[] = [];
		const lintedDmn: string[] = [];

		faux.setResponses([fauxAssistantMessage("```bpmn\n" + bpmn + "\n```\n```dmn\n" + dmn + "\n```")]);

		const result = await compileSkill({
			skillContent: "# Skill\nUse an eligibility table.",
			model: faux.getModel(),
			template: qianjiTemplate(),
			target: {
				runner: async () => ({
					target: "bpmn-dmn",
					reason: "test table target",
					dmnDecisions: ["eligibility-decision"],
				}),
			},
			lint: {
				maxRepairAttempts: 0,
				runner: async (xml) => {
					lintedBpmn.push(xml);
					return { success: true, output: "# BPMN Lint Passed" };
				},
				dmnRunner: async (xml) => {
					lintedDmn.push(xml);
					return { success: true, output: "# DMN Lint Passed" };
				},
			},
		});

		expect(result.success).toBe(true);
		expect(lintedBpmn).toEqual([bpmn]);
		expect(lintedDmn).toEqual([dmn]);
		expect(result.dmnXml).toBe(dmn);
	});

	it("reports unsupported pi-wendao runtime fields as lint feedback", async () => {
		const unsupportedRuntimeFieldsXml = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:skillsc="http://skillsc.dev/bpmn/extensions">
  <process id="P1" isExecutable="true">
    <startEvent id="S1"/>
    <serviceTask id="Task_1" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <skillsc:config>
          <skillsc:prompt>Fetch a remote page and summarize it.</skillsc:prompt>
          <skillsc:tools>bash,curl</skillsc:tools>
          <skillsc:inputs>source url</skillsc:inputs>
          <skillsc:outputs>report summary</skillsc:outputs>
        </skillsc:config>
      </extensionElements>
    </serviceTask>
    <endEvent id="E1"/>
    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_1"/>
    <sequenceFlow id="F2" sourceRef="Task_1" targetRef="E1"/>
  </process>
</definitions>`;

		faux.setResponses([fauxAssistantMessage("```xml\n" + unsupportedRuntimeFieldsXml + "\n```")]);

		const result = await compileSkill({
				skillContent: "# Skill\nFetch and summarize.",
				model: faux.getModel(),
				template: qianjiTemplate(),
				target: bpmnTarget(),
				lint: {
				maxRepairAttempts: 0,
				runner: async () => ({ success: true, output: "# Lint Passed" }),
			},
		});

		expect(result.success).toBe(false);
		expect(result.errors?.[0]).toContain("PI_WENDAO_TOOL_UNSUPPORTED");
		expect(result.errors?.[0]).toContain("curl");
		expect(result.errors?.[0]).toContain("PI_WENDAO_VARIABLE_IDENTIFIER");
		expect(result.errors?.[0]).toContain("source url");
		expect(result.errors?.[0]).toContain("report summary");
	});

	it("reports task-level error boundaries as lint feedback", async () => {
		const taskBoundaryXml = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:skillsc="http://skillsc.dev/bpmn/extensions">
  <process id="P1" isExecutable="true">
    <startEvent id="S1"/>
    <serviceTask id="Task_Risky" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <skillsc:config>
          <skillsc:prompt>Run risky work and output success.</skillsc:prompt>
          <skillsc:tools></skillsc:tools>
          <skillsc:inputs></skillsc:inputs>
          <skillsc:outputs>success</skillsc:outputs>
        </skillsc:config>
      </extensionElements>
    </serviceTask>
    <boundaryEvent id="BoundaryError_Risky" attachedToRef="Task_Risky">
      <errorEventDefinition/>
    </boundaryEvent>
    <endEvent id="E1"/>
    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_Risky"/>
    <sequenceFlow id="F2" sourceRef="Task_Risky" targetRef="E1"/>
  </process>
</definitions>`;

		faux.setResponses([fauxAssistantMessage("```xml\n" + taskBoundaryXml + "\n```")]);

		const result = await compileSkill({
				skillContent: "# Skill\nRun risky work with fallback.",
				model: faux.getModel(),
				template: qianjiTemplate(),
				target: bpmnTarget(),
				lint: {
				maxRepairAttempts: 0,
				runner: async () => ({ success: true, output: "# Lint Passed" }),
			},
		});

		expect(result.success).toBe(false);
		expect(result.errors?.[0]).toContain("PI_WENDAO_TASK_ERROR_BOUNDARY_UNSUPPORTED");
		expect(result.errors?.[0]).toContain("BoundaryError_Risky");
		expect(result.errors?.[0]).toContain("exclusiveGateway");
	});
});
