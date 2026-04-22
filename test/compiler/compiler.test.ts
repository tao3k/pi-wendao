import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import type { FauxProviderRegistration } from "@mariozechner/pi-ai";
import { compileSkill } from "../../src/compiler/compiler.js";

const fixturesDir = join(import.meta.dirname, "../fixtures");

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
		});

		expect(result.success).toBe(true);
		expect(result.bpmnXml).toContain("<definitions");
	});

	it("returns error when model produces no XML", async () => {
		faux.setResponses([fauxAssistantMessage("I cannot compile this skill.")]);

		const result = await compileSkill({
			skillContent: "# Skill\nDo it.",
			model: faux.getModel(),
		});

		expect(result.success).toBe(false);
		expect(result.errors).toContain("No valid XML found in model response");
	});

	it("returns error when model errors", async () => {
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Rate limit" })]);

		const result = await compileSkill({
			skillContent: "# Skill\nDo it.",
			model: faux.getModel(),
		});

		expect(result.success).toBe(false);
		expect(result.errors?.[0]).toContain("Rate limit");
	});
});
