import { describe, expect, it } from "vitest";
import { buildCompilePrompt } from "../../src/compiler/prompt.js";

describe("buildCompilePrompt", () => {
	it("returns system prompt and user message", () => {
		const { systemPrompt, userMessage } = buildCompilePrompt("# My Skill\nDo stuff");

		expect(systemPrompt).toContain("BPMN");
		expect(systemPrompt).toContain("serviceTask");
		expect(systemPrompt).toContain("skillsc:config");
		expect(systemPrompt).toContain("environment.services.runAgent");
		expect(userMessage).toContain("# My Skill");
		expect(userMessage).toContain("Do stuff");
	});

	it("system prompt describes the extension element format", () => {
		const { systemPrompt } = buildCompilePrompt("test");

		expect(systemPrompt).toContain("skillsc:prompt");
		expect(systemPrompt).toContain("skillsc:tools");
		expect(systemPrompt).toContain("skillsc:inputs");
		expect(systemPrompt).toContain("skillsc:outputs");
	});

	it("system prompt describes condition expression format", () => {
		const { systemPrompt } = buildCompilePrompt("test");

		expect(systemPrompt).toContain("conditionExpression");
		expect(systemPrompt).toContain("environment.variables");
	});

	it("system prompt describes error handling", () => {
		const { systemPrompt } = buildCompilePrompt("test");

		expect(systemPrompt).toContain("boundaryEvent");
		expect(systemPrompt).toContain("errorEventDefinition");
	});
});
