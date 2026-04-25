import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	PiWendaoIntercomCorrelationState,
	PiWendaoIntercomReplyTracker,
	buildPiWendaoIntercomCorrelationKey,
	createInMemoryPiWendaoIntercomRecordStore,
	createJsonFilePiWendaoIntercomRecordStore,
} from "../../src/executor/intercom-correlation.js";

const tempDirs: string[] = [];

const self = { id: "session-worker", name: "worker" };
const planner = { id: "session-planner", name: "planner" };
const reviewer = { id: "session-reviewer", name: "reviewer" };

describe("PiWendaoIntercomReplyTracker", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resolves a reply from the current turn context", () => {
		const tracker = new PiWendaoIntercomReplyTracker();
		tracker.queueTurnContext({
			from: planner,
			to: self,
			message: {
				id: "ask-1",
				text: "Need branch A output",
				timestamp: 1000,
				expectsReply: true,
			},
			receivedAt: 1000,
			execution: {
				instanceId: "pi-wendao-complex",
				activityId: "Task_BranchA",
				tokenId: 11,
			},
		});

		expect(tracker.beginTurn(1001)?.message.id).toBe("ask-1");
		expect(tracker.resolveReplyTarget({ now: 1002 }).message.id).toBe("ask-1");
		expect(tracker.markReplied("ask-1")).toBe(true);
		expect(tracker.listPending(1003)).toHaveLength(0);
	});

	it("resolves a single pending ask without an explicit target", () => {
		const tracker = new PiWendaoIntercomReplyTracker();
		tracker.recordIncomingAsk({
			from: planner,
			message: {
				id: "ask-single",
				text: "Summarize the result",
				timestamp: 1000,
				expectsReply: true,
			},
			receivedAt: 1000,
		});

		expect(tracker.resolveReplyTarget({ now: 1001 }).message.id).toBe("ask-single");
	});

	it("uses sender id or name to disambiguate multiple pending asks", () => {
		const tracker = new PiWendaoIntercomReplyTracker();
		tracker.recordIncomingAsk({
			from: planner,
			message: {
				id: "ask-planner",
				text: "Need planner reply",
				timestamp: 1000,
				expectsReply: true,
			},
			receivedAt: 1000,
		});
		tracker.recordIncomingAsk({
			from: reviewer,
			message: {
				id: "ask-reviewer",
				text: "Need reviewer reply",
				timestamp: 1001,
				expectsReply: true,
			},
			receivedAt: 1001,
		});

		expect(() => tracker.resolveReplyTarget({ now: 1002 })).toThrow("Multiple pending asks");
		expect(tracker.resolveReplyTarget({ to: "reviewer", now: 1002 }).message.id)
			.toBe("ask-reviewer");
		expect(tracker.resolveReplyTarget({ to: "session-planner", now: 1002 }).message.id)
			.toBe("ask-planner");
	});

	it("expires pending asks after the configured timeout", () => {
		const tracker = new PiWendaoIntercomReplyTracker({ askTimeoutMs: 50 });
		tracker.recordIncomingAsk({
			from: planner,
			message: {
				id: "ask-timeout",
				text: "This should expire",
				timestamp: 1000,
				expectsReply: true,
			},
			receivedAt: 1000,
		});

		expect(tracker.listPending(1050)).toHaveLength(1);
		expect(tracker.pruneExpired(1051).map((context) => context.message.id))
			.toEqual(["ask-timeout"]);
		expect(tracker.listPending(1052)).toHaveLength(0);
	});

	it("builds token-scoped BPMN correlation keys", () => {
		expect(buildPiWendaoIntercomCorrelationKey({
			instanceId: "pi-wendao-jump-parallel-test",
			processId: "Process_1",
			activityId: "Task_BranchA",
			tokenId: 11,
		}, "ask-branch-a")).toBe(JSON.stringify({
			instanceId: "pi-wendao-jump-parallel-test",
			processId: "Process_1",
			activityId: "Task_BranchA",
			tokenId: 11,
			messageId: "ask-branch-a",
		}));
	});
});

describe("PiWendaoIntercomCorrelationState", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records send, ask, pending, and reply state transitions", async () => {
		const store = createInMemoryPiWendaoIntercomRecordStore();
		const state = new PiWendaoIntercomCorrelationState({
			self,
			store,
			askTimeoutMs: 1000,
			now: () => 1000,
		});

		const sent = await state.send({
			to: planner,
			text: "Fire and forget",
			messageId: "send-1",
			execution: {
				instanceId: "instance-1",
				activityId: "Task_Send",
				tokenId: 7,
			},
		});
		expect(sent.status).toBe("sent");

		await state.ask({
			to: planner,
			text: "Outbound ask",
			messageId: "outbound-ask",
			execution: {
				instanceId: "instance-1",
				activityId: "Task_Ask",
				tokenId: 8,
			},
		});

		const inbound = await state.receiveAsk({
			from: planner,
			text: "Need branch result",
			messageId: "inbound-ask",
			execution: {
				instanceId: "instance-1",
				activityId: "Task_BranchA",
				tokenId: 11,
			},
		});
		expect(inbound.status).toBe("waiting");
		await expect(state.pending(1001)).resolves.toHaveLength(1);

		const reply = await state.reply({
			text: "Branch result ready",
			replyTo: "inbound-ask",
			messageId: "reply-1",
			now: 1002,
		});
		expect(reply.context.message.replyTo).toBe("inbound-ask");
		await expect(state.pending(1003)).resolves.toHaveLength(0);

		const original = await store.get(inbound.key);
		expect(original?.status).toBe("replied");
		expect(original?.reply?.id).toBe("reply-1");
	});

	it("marks expired pending asks in the store", async () => {
		const store = createInMemoryPiWendaoIntercomRecordStore();
		const state = new PiWendaoIntercomCorrelationState({
			self,
			store,
			askTimeoutMs: 10,
		});
		const inbound = await state.receiveAsk({
			from: planner,
			text: "Expire this ask",
			messageId: "expire-me",
			now: 1000,
		});

		await expect(state.pending(1011)).resolves.toHaveLength(0);
		expect((await store.get(inbound.key))?.status).toBe("expired");
	});

	it("persists records in a JSON store", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-wendao-intercom-store-"));
		tempDirs.push(dir);
		const storePath = join(dir, "intercom.json");
		const firstStore = createJsonFilePiWendaoIntercomRecordStore(storePath);
		const state = new PiWendaoIntercomCorrelationState({
			self,
			store: firstStore,
		});
		const inbound = await state.receiveAsk({
			from: planner,
			text: "Persist me",
			messageId: "persisted-ask",
			now: 1000,
			execution: {
				instanceId: "instance-json",
				activityId: "Task_Message",
				tokenId: 3,
			},
		});

		const secondStore = createJsonFilePiWendaoIntercomRecordStore(storePath);
		expect((await secondStore.get(inbound.key))?.context.message.text).toBe("Persist me");
		expect((await secondStore.list()).map((record) => record.key)).toEqual([inbound.key]);
	});
});
