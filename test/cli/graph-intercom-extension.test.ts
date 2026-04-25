import { afterEach, describe, expect, it } from "vitest";
import registerPiWendaoPiIntercom from "../../src/cli/graph-intercom-extension.js";
import {
	GRAPH_INTERCOM_BRIDGE_KEY,
	type PiWendaoGraphIntercomBridge,
} from "../../src/cli/pi-intercom.js";

describe("pi-wendao graph intercom extension", () => {
	afterEach(() => {
		(globalThis as typeof globalThis & Record<string, PiWendaoGraphIntercomBridge | undefined>)[
			GRAPH_INTERCOM_BRIDGE_KEY
		] = undefined;
	});

	it("blocks ask on the graph planner reply bridge", async () => {
		const tool = loadTool();
		const events: unknown[] = [];
		(globalThis as typeof globalThis & Record<string, PiWendaoGraphIntercomBridge>)[GRAPH_INTERCOM_BRIDGE_KEY] = {
			requestPlannerReply: async (request) => {
				expect(request).toMatchObject({
					toolCallId: "tool-ask-1",
					action: "ask",
					to: "planner",
					message: "Approve discovery escalation?",
				});
				return "approved: continue";
			},
			onEvent: (event) => events.push(event),
		};

		await expect(tool.execute("tool-ask-1", {
			action: "ask",
			to: "planner",
			message: "Approve discovery escalation?",
		})).resolves.toMatchObject({
			content: [{ type: "text", text: "Planner replied:\napproved: continue" }],
			details: {
				action: "ask",
				delivered: true,
				to: "planner",
				reply: "approved: continue",
			},
		});
		expect(events).toEqual([
			expect.objectContaining({ type: "intercom_call", action: "ask" }),
			expect.objectContaining({ type: "intercom_answer", message: "approved: continue" }),
		]);
	});

	it("logs send without waiting for a planner reply", async () => {
		const tool = loadTool();
		const events: unknown[] = [];
		(globalThis as typeof globalThis & Record<string, PiWendaoGraphIntercomBridge>)[GRAPH_INTERCOM_BRIDGE_KEY] = {
			onEvent: (event) => events.push(event),
		};

		await expect(tool.execute("tool-send-1", {
			action: "send",
			to: "worker",
			message: "Branch A is delegated.",
		})).resolves.toMatchObject({
			content: [{ type: "text", text: "Sent to worker: Branch A is delegated." }],
			details: {
				action: "send",
				delivered: true,
				to: "worker",
			},
		});
		expect(events).toEqual([
			expect.objectContaining({ type: "intercom_call", action: "send" }),
			expect.objectContaining({ type: "intercom_send", to: "worker" }),
		]);
	});
});

function loadTool(): {
	execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
} {
	let registered:
		| { execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> }
		| undefined;
	registerPiWendaoPiIntercom({
		registerTool(tool) {
			registered = tool;
		},
	});
	if (!registered) throw new Error("intercom tool was not registered");
	return registered;
}
