import { describe, expect, it } from "vitest";
import {
	PiWendaoIntercomCorrelationState,
	createInMemoryPiWendaoIntercomRecordStore,
} from "../../src/executor/intercom-correlation.js";
import {
	collectPiIntercomRegisteredTools,
	createPiIntercomAgentTool,
	createPiIntercomClientFromLoadedExtensions,
	createPiIntercomClientFromRegisteredTools,
	tryCreatePiIntercomClientFromLoadedExtensions,
	type PiIntercomToolParams,
} from "../../src/executor/pi-intercom-runtime.js";
import type { PiRegisteredToolDefinition } from "../../src/executor/pi-subagents-runtime.js";

describe("pi-intercom runtime tool adapter", () => {
	it("discovers the intercom tool from loaded extensions", () => {
		const intercom = tool("intercom", async () => ({
			content: [{ type: "text", text: "ok" }],
		}));

		const tools = collectPiIntercomRegisteredTools({
			extensions: [{
				tools: new Map([
					["other", { definition: tool("other", async () => ({ content: [] })) }],
					["intercom", { definition: intercom }],
				]),
			}],
		});

		expect(tools.intercom).toBe(intercom);
		expect(tryCreatePiIntercomClientFromLoadedExtensions({
			extensions: [],
		}, { ctx: {} })).toBeUndefined();
	});

	it("maps client methods to pi-intercom tool actions", async () => {
		const calls: Array<{ params: Record<string, unknown>; ctx: unknown }> = [];
		const ctx = { cwd: "/repo" };
		const client = createPiIntercomClientFromRegisteredTools({
			intercom: tool("intercom", async (params, receivedCtx) => {
				calls.push({ params, ctx: receivedCtx });
				return {
					content: [{ type: "text", text: `action=${params.action}` }],
					details: {
						messageId: params.action === "send" ? "message-1" : undefined,
						delivered: params.action === "send" ? true : undefined,
					},
				};
			}),
		}, {
			ctx,
			toolCallIdPrefix: "test",
		});

		await expect(client.list()).resolves.toMatchObject({ text: "action=list" });
		await expect(client.status()).resolves.toMatchObject({ text: "action=status" });
		await expect(client.pending()).resolves.toMatchObject({ text: "action=pending" });
		await expect(client.send({
			to: "planner",
			message: "hello",
			attachments: [{ type: "context", name: "branch", content: "A" }],
		})).resolves.toMatchObject({
			text: "action=send",
			messageId: "message-1",
			delivered: true,
		});
		await expect(client.ask({
			to: "planner",
			message: "question",
			replyTo: "parent-message",
		})).resolves.toMatchObject({ text: "action=ask" });
		await expect(client.reply({
			to: "planner",
			message: "answer",
		})).resolves.toMatchObject({ text: "action=reply" });

		expect(calls.map((call) => call.params)).toEqual([
			{ action: "list" },
			{ action: "status" },
			{ action: "pending" },
			{
				action: "send",
				to: "planner",
				message: "hello",
				attachments: [{ type: "context", name: "branch", content: "A" }],
				replyTo: undefined,
			},
			{
				action: "ask",
				to: "planner",
				message: "question",
				attachments: undefined,
				replyTo: "parent-message",
			},
			{
				action: "reply",
				to: "planner",
				message: "answer",
				attachments: undefined,
				replyTo: undefined,
			},
		]);
		expect(calls.every((call) => call.ctx === ctx)).toBe(true);
	});

	it("creates a client from loaded extensions", async () => {
		const client = createPiIntercomClientFromLoadedExtensions({
			extensions: [{
				tools: new Map([
					["intercom", {
						definition: tool("intercom", async (params) => ({
							content: [{ type: "text", text: `${params.action}:ok` }],
						})),
					}],
				]),
			}],
		}, { ctx: {} });

		await expect(client.status()).resolves.toMatchObject({
			text: "status:ok",
			isError: false,
		});
	});

	it("wraps the client as an agent tool", async () => {
		const calls: PiIntercomToolParams[] = [];
		const tool = createPiIntercomAgentTool({
			execute: async (params) => {
				calls.push(params);
				return {
					text: "Connected: Yes",
					isError: false,
				};
			},
			list: async () => ({ text: "list", isError: false }),
			status: async () => ({ text: "status", isError: false }),
			pending: async () => ({ text: "pending", isError: false }),
			send: async () => ({ text: "send", isError: false }),
			ask: async () => ({ text: "ask", isError: false }),
			reply: async () => ({ text: "reply", isError: false }),
		});

		await expect(tool.execute("tool-1", { action: "status" })).resolves.toEqual({
			content: [{ type: "text", text: "Connected: Yes" }],
			details: undefined,
		});
		expect(calls).toEqual([{ action: "status" }]);
		await expect(tool.execute("tool-2", { action: "unknown" })).rejects.toThrow("intercom action");
	});

	it("throws agent-tool errors for pi-intercom failures", async () => {
		const tool = createPiIntercomAgentTool({
			execute: async () => ({
				text: "Intercom not connected",
				isError: true,
			}),
			list: async () => ({ text: "list", isError: false }),
			status: async () => ({ text: "status", isError: false }),
			pending: async () => ({ text: "pending", isError: false }),
			send: async () => ({ text: "send", isError: false }),
			ask: async () => ({ text: "ask", isError: false }),
			reply: async () => ({ text: "reply", isError: false }),
		});

		await expect(tool.execute("tool-1", { action: "status" }))
			.rejects.toThrow("Intercom not connected");
	});

	it("mirrors successful send and ask results into correlation state", async () => {
		const store = createInMemoryPiWendaoIntercomRecordStore();
		const correlation = new PiWendaoIntercomCorrelationState({
			self: { id: "session-worker", name: "worker" },
			store,
		});
		const client = createPiIntercomClientFromRegisteredTools({
			intercom: tool("intercom", async (params) => {
				if (params.action === "send") {
					return {
						content: [{ type: "text", text: "Message sent to planner" }],
						details: { messageId: "sent-message", delivered: true },
					};
				}
				return {
					content: [{ type: "text", text: "**Reply from planner:**\nready" }],
				};
			}),
		}, {
			ctx: {},
			correlation,
		});

		await client.send({
			to: "planner",
			message: "fire and forget",
			now: 1000,
			execution: {
				instanceId: "instance-intercom",
				activityId: "Task_Send",
				tokenId: 1,
			},
		});
		await client.ask({
			to: "planner",
			message: "are you ready?",
			now: 2000,
			execution: {
				instanceId: "instance-intercom",
				activityId: "Task_Ask",
				tokenId: 2,
			},
		});

		const records = await store.list();
		expect(records.map((record) => record.status).sort()).toEqual(["replied", "sent"]);
		expect(records.find((record) => record.status === "sent")?.context.message.id)
			.toBe("sent-message");
		expect(records.find((record) => record.status === "replied")?.reply?.text)
			.toContain("ready");
	});

	it("marks a mirrored ask as failed when the tool returns an error result", async () => {
		const store = createInMemoryPiWendaoIntercomRecordStore();
		const correlation = new PiWendaoIntercomCorrelationState({
			self: { id: "session-worker", name: "worker" },
			store,
		});
		const client = createPiIntercomClientFromRegisteredTools({
			intercom: tool("intercom", async () => ({
				content: [{ type: "text", text: "Failed: no session" }],
				isError: true,
			})),
		}, {
			ctx: {},
			correlation,
		});

		await expect(client.ask({
			to: "planner",
			message: "are you there?",
			now: 1000,
			execution: {
				instanceId: "instance-intercom",
				activityId: "Task_Ask",
				tokenId: 3,
			},
		})).resolves.toMatchObject({
			text: "Failed: no session",
			isError: true,
		});

		const records = await store.list();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			status: "failed",
			error: "Failed: no session",
		});
	});

	it("mirrors replies when correlation already has a pending inbound ask", async () => {
		const store = createInMemoryPiWendaoIntercomRecordStore();
		const correlation = new PiWendaoIntercomCorrelationState({
			self: { id: "session-worker", name: "worker" },
			store,
		});
		const inbound = await correlation.receiveAsk({
			from: { id: "session-planner", name: "planner" },
			messageId: "ask-1",
			text: "Need branch output",
			now: 1000,
			execution: {
				instanceId: "instance-intercom",
				activityId: "Task_BranchA",
				tokenId: 11,
			},
		});
		const client = createPiIntercomClientFromRegisteredTools({
			intercom: tool("intercom", async () => ({
				content: [{ type: "text", text: "Reply sent to planner" }],
				details: { messageId: "reply-1", delivered: true, replyTo: "ask-1" },
			})),
		}, {
			ctx: {},
			correlation,
		});

		await client.reply({
			to: "planner",
			replyTo: "ask-1",
			message: "Branch A is done",
			now: 1001,
		});

		expect((await store.get(inbound.key))?.status).toBe("replied");
		expect((await store.get(inbound.key))?.reply?.id).toBe("reply-1");
	});
});

function tool(
	name: string,
	execute: (
		params: PiIntercomToolParams,
		ctx: unknown,
	) => Promise<{
		content: Array<{ type: string; text?: string }>;
		details?: unknown;
		isError?: boolean;
	}>,
): PiRegisteredToolDefinition {
	return {
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			expect(_toolCallId).toContain(name);
			return execute(params as unknown as PiIntercomToolParams, ctx);
		},
	};
}
