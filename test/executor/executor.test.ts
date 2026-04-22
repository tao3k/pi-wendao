import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import type { FauxProviderRegistration } from "@mariozechner/pi-ai";
import { execute } from "../../src/executor/executor.js";

const fixturesDir = join(import.meta.dirname, "../fixtures");

describe("executor", () => {
	let faux: FauxProviderRegistration;

	beforeEach(() => {
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
	});

	it("executes a simple linear workflow", async () => {
		const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");

		faux.setResponses([
			fauxAssistantMessage('Files found.\n```json\n{"fileList": ["a.ts", "b.ts"]}\n```'),
		]);

		const activityIds: string[] = [];

		const result = await execute({
			source,
			model: faux.getModel(),
			cwd: process.cwd(),
			onActivityStart: (id) => activityIds.push(`start:${id}`),
			onActivityEnd: (id) => activityIds.push(`end:${id}`),
		});

		expect(result.success).toBe(true);
		expect(activityIds).toContain("start:Task_1");
		expect(activityIds).toContain("end:Task_1");
	});

	it("executes a branching workflow — takes default path", async () => {
		const source = readFileSync(join(fixturesDir, "branching-workflow.bpmn"), "utf-8");

		// First response: run tests task — testsPassed not set to true,
		// so the exclusive gateway should take the default path (Flow_Fail -> Task_FixTests)
		faux.setResponses([
			fauxAssistantMessage("Tests failed.\n```json\n{}\n```"),
			fauxAssistantMessage("Fixed the tests."),
		]);

		const activityIds: string[] = [];

		const result = await execute({
			source,
			model: faux.getModel(),
			cwd: process.cwd(),
			onActivityEnd: (id) => activityIds.push(id),
		});

		expect(result.success).toBe(true);
		expect(activityIds).toContain("Task_RunTests");
		expect(activityIds).toContain("Task_FixTests");
		expect(activityIds).not.toContain("Task_ReportSuccess");
	});

	it("executes a branching workflow — takes condition path", async () => {
		const source = readFileSync(join(fixturesDir, "branching-workflow.bpmn"), "utf-8");

		// First response: run tests task — sets testsPassed = true
		faux.setResponses([
			fauxAssistantMessage('All passed.\n```json\n{"testsPassed": true}\n```'),
			fauxAssistantMessage("Success reported."),
		]);

		const activityIds: string[] = [];

		const result = await execute({
			source,
			model: faux.getModel(),
			cwd: process.cwd(),
			onActivityEnd: (id) => activityIds.push(id),
		});

		expect(result.success).toBe(true);
		expect(activityIds).toContain("Task_RunTests");
		expect(activityIds).toContain("Task_ReportSuccess");
		expect(activityIds).not.toContain("Task_FixTests");
	});

	it("handles error boundary events", async () => {
		const source = readFileSync(join(fixturesDir, "error-workflow.bpmn"), "utf-8");

		// First response: risky task fails (agent returns error)
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Something went wrong" }),
			fauxAssistantMessage('Fallback done.\n```json\n{"fallbackResult": "recovered"}\n```'),
		]);

		const activityIds: string[] = [];

		const result = await execute({
			source,
			model: faux.getModel(),
			cwd: process.cwd(),
			onActivityEnd: (id) => activityIds.push(id),
		});

		expect(result.success).toBe(true);
		expect(activityIds).toContain("Task_Fallback");
	});

	it("passes CLI variables to the engine", async () => {
		const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");

		let capturedVars: Record<string, unknown> = {};
		faux.setResponses([
			(context) => {
				// The system prompt should contain the variable if it's in inputs
				// For this test, just verify the engine received the variables
				return fauxAssistantMessage("Done.");
			},
		]);

		const result = await execute({
			source,
			model: faux.getModel(),
			cwd: process.cwd(),
			variables: ["myKey=myValue", "count=42"],
		});

		expect(result.success).toBe(true);
		expect(result.variables.myKey).toBe("myValue");
		expect(result.variables.count).toBe("42");
	});
});
