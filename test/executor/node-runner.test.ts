import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import type { FauxProviderRegistration } from "@mariozechner/pi-ai";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { createRunAgentService } from "../../src/executor/node-runner.js";

describe("createRunAgentService", () => {
	let faux: FauxProviderRegistration;

	beforeEach(() => {
		faux = registerFauxProvider();
	});

	afterEach(() => {
		faux.unregister();
	});

	it("runs an agent and calls callback on success", async () => {
		faux.setResponses([fauxAssistantMessage('Done.\n```json\n{"greeting": "hello"}\n```')]);

		const events: string[] = [];
		const service = createRunAgentService({
			model: faux.getModel(),
			cwd: process.cwd(),
			onEvent: (event: AgentEvent) => {
				events.push(event.type);
			},
			getConfig: (id) =>
				id === "Task_1"
					? { prompt: "Say hello", tools: [], inputs: [], outputs: ["greeting"] }
					: undefined,
		});

		const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
			service(
				{
					content: { id: "Task_1" },
					environment: { variables: {}, output: {} },
				},
				(err, res) => {
					if (err) reject(err);
					else resolve(res ?? {});
				},
			);
		});

		expect(result).toHaveProperty("greeting", "hello");
		expect(events).toContain("agent_start");
		expect(events).toContain("agent_end");
	});

	it("passes scoped input variables to the agent", async () => {
		let capturedPrompt = "";
		faux.setResponses([
			(context) => {
				capturedPrompt = context.systemPrompt;
				return fauxAssistantMessage("Done.");
			},
		]);

		const service = createRunAgentService({
			model: faux.getModel(),
			cwd: process.cwd(),
			getConfig: (id) =>
				id === "Task_1"
					? { prompt: "Use the input", tools: [], inputs: ["myVar"], outputs: [] }
					: undefined,
		});

		await new Promise<void>((resolve, reject) => {
			service(
				{
					content: { id: "Task_1" },
					environment: {
						variables: { myVar: "someValue", otherVar: "hidden" },
						output: {},
					},
				},
				(err) => {
					if (err) reject(err);
					else resolve();
				},
			);
		});

		expect(capturedPrompt).toContain("myVar");
		expect(capturedPrompt).toContain("someValue");
		expect(capturedPrompt).not.toContain("otherVar");
		expect(capturedPrompt).not.toContain("hidden");
	});
});
