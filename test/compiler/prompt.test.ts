import { describe, expect, it } from "vitest";
import { buildCompilePrompt, buildTargetDecisionPrompt } from "../../src/compiler/prompt.js";

const templates = {
	bpmn: "<definitions><process id=\"Process_1\" /></definitions>",
	dmn: "<definitions><decision id=\"skill-decision\" /></definitions>",
};

describe("buildCompilePrompt", () => {
	it("returns system prompt and user message", () => {
		const { systemPrompt, userMessage } = buildCompilePrompt(undefined, "# My Skill\nDo stuff", templates);

		expect(systemPrompt).toContain("BPMN");
		expect(systemPrompt).toContain("serviceTask");
		expect(systemPrompt).toContain("skillsc:config");
		expect(systemPrompt).toContain("environment.services.runAgent");
		expect(userMessage).toContain("Qianji BPMN template");
		expect(userMessage).toContain("Raw SKILL.md");
		expect(userMessage).toContain("Process_1");
		expect(userMessage).toContain("Do stuff");
	});

	it("system prompt describes the extension element format", () => {
		const { systemPrompt } = buildCompilePrompt();

		expect(systemPrompt).toContain("skillsc:prompt");
		expect(systemPrompt).toContain("skillsc:tools");
		expect(systemPrompt).toContain("skillsc:inputs");
		expect(systemPrompt).toContain("skillsc:outputs");
	});

	it("system prompt models graph-local human gates as BPMN userTask", () => {
		const { systemPrompt } = buildCompilePrompt();

		expect(systemPrompt).toContain("userTask");
		expect(systemPrompt).toContain("Human Input Format");
		expect(systemPrompt).toContain("graph TUI");
		expect(systemPrompt).toContain("approvedReply");
	});

	it("system prompt describes condition expression format", () => {
		const { systemPrompt } = buildCompilePrompt();

		expect(systemPrompt).toContain("conditionExpression");
		expect(systemPrompt).toContain("qianji-compatible");
		expect(systemPrompt).toContain("isReady");
		expect(systemPrompt).toContain("retryCount >= 3");
		expect(systemPrompt).toContain("serviceTask before");
	});

	it("system prompt describes qianji-compatible fallback handling", () => {
		const { systemPrompt } = buildCompilePrompt();

		expect(systemPrompt).toContain("Fallback Handling");
		expect(systemPrompt).toContain("Do NOT generate task-level `boundaryEvent`");
		expect(systemPrompt).toContain("exclusiveGateway");
	});

	it("system prompt describes qianji-native bounded repeat execution", () => {
		const { systemPrompt } = buildCompilePrompt();

		expect(systemPrompt).toContain("Qianji-Native Repeat Execution");
		expect(systemPrompt).toContain("standardLoopCharacteristics");
		expect(systemPrompt).toContain("multiInstanceLoopCharacteristics");
		expect(systemPrompt).toContain("qianji_lint");
		expect(systemPrompt).toContain("exact repeat syntax");
	});

	it("system prompt keeps qianji as the orchestration owner", () => {
		const { systemPrompt } = buildCompilePrompt();

		expect(systemPrompt).toContain("Architecture Ownership");
		expect(systemPrompt).toContain("Qianji owns");
		expect(systemPrompt).toContain("checkpoint persistence");
		expect(systemPrompt).toContain("serviceTask prompt describes only");
		expect(systemPrompt).toContain("Do not rely on a Markdown parser");
		expect(systemPrompt).toContain("Infer the workflow or");
	});

	it("builds a target decision prompt for BPMN vs BPMN+DMN", () => {
		const { systemPrompt, userMessage } = buildTargetDecisionPrompt("# My Skill\nUse a policy table.");

		expect(systemPrompt).toContain('"bpmn"');
		expect(systemPrompt).toContain('"bpmn-dmn"');
		expect(systemPrompt).toContain("Pure DMN is not an executable workflow");
		expect(systemPrompt).toContain("no Markdown semantic parser");
		expect(userMessage).toContain("qianji compile artifact target");
		expect(userMessage).toContain("Raw SKILL.md");
		expect(userMessage).toContain("Use a policy table");
	});

	it("compile prompt carries the selected target decision", () => {
		const { systemPrompt, userMessage } = buildCompilePrompt({
			target: "bpmn-dmn",
			reason: "stable table",
			dmnDecisions: ["eligibility-decision"],
		}, "# Skill\nUse table", templates);

		expect(systemPrompt).toContain("businessRuleTask");
		expect(systemPrompt).toContain("DMN only for tables");
		expect(userMessage).toContain('"target": "bpmn-dmn"');
		expect(userMessage).toContain("eligibility-decision");
		expect(userMessage).toContain("Qianji DMN template");
	});
});
