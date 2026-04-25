import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createInMemoryPiSubagentsRunStore,
	createJsonFilePiSubagentsRunStore,
	createPiSubagentsClientFromTools,
	createPiSubagentsHost,
	type PiSubagentsHostEvent,
	type PiSubagentsHostUpdateEvent,
	type PiSubagentsSpawnRequest,
} from "../../src/executor/pi-subagents-host.js";

const tempDirs: string[] = [];

describe("createPiSubagentsHost", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("maps pi-wendao service task metadata to a pi-subagents request", async () => {
		const spawns: PiSubagentsSpawnRequest[] = [];
		const host = createPiSubagentsHost({
			client: {
				async spawn(request) {
					spawns.push(request);
					return { agent_id: "agent-1" };
				},
				async getResult(request) {
					expect(request).toMatchObject({
						agent_id: "agent-1",
						wait: true,
					});
					return {
						result: 'Done.\n```json\n{"result":"alpha_done"}\n```',
					};
				},
			},
		});

		const output = await host.run({
			activityId: "Task_BranchA",
			variables: { item: "alpha", hidden: "not visible" },
			config: {
				prompt: "Review ${environment.variables.item}.",
				tools: ["bash"],
				inputs: ["item"],
				outputs: ["result"],
				subagent: {
					type: "pi-wendao-worker",
					description: "Run Branch A",
					runInBackground: true,
					maxTurns: 8,
					isolation: "worktree",
					inheritContext: false,
					thinking: "medium",
				},
			},
			execution: {
				processId: "Process_1",
				instanceId: "instance-1",
				tokenId: 11,
				checkpoint: {
					backend: "duckdb",
					source: "resumed",
					status: "loaded",
					pendingHostWork: "2",
				},
			},
		});

		expect(output).toEqual({ result: "alpha_done" });
		expect(spawns).toHaveLength(1);
		expect(spawns[0]).toMatchObject({
			description: "Run Branch A",
			subagent_type: "pi-wendao-worker",
			run_in_background: true,
			max_turns: 8,
			isolation: "worktree",
			inherit_context: false,
			thinking: "medium",
		});
		expect(spawns[0]?.prompt).toContain('"alpha"');
		expect(spawns[0]?.prompt).toContain("Qianji BPMN execution context");
		expect(spawns[0]?.prompt).toContain("processId: Process_1");
		expect(spawns[0]?.prompt).toContain("activityId: Task_BranchA");
		expect(spawns[0]?.prompt).toContain("checkpoint.backend: duckdb");
		expect(spawns[0]?.prompt).toContain("checkpoint.source: resumed");
		expect(spawns[0]?.prompt).not.toContain("not visible");
	});

	it("emits host events and requests verbose results when observed", async () => {
		const events: PiSubagentsHostEvent[] = [];
		const updates: PiSubagentsHostUpdateEvent[] = [];
		let getResultRequest: unknown;
		const host = createPiSubagentsHost({
			onEvent: (event) => events.push(event),
			onUpdate: (event) => updates.push(event),
			client: {
				async spawn(_request, callbacks) {
					callbacks?.onUpdate?.({
						details: {
							activity: "running bash",
							toolUses: 1,
							turnCount: 1,
						},
					});
					return { agent_id: "agent-observed" };
				},
				async getResult(request) {
					getResultRequest = request;
					return [
						"Agent: agent-observed",
						"Type: Worker | Status: completed | Tool uses: 1 | Duration: 1s",
						"Description: Observe task",
						"",
						'```json\n{"ok":true}\n```',
						"",
						"--- Agent Conversation ---",
						"[Assistant]: Done.",
					].join("\n");
				},
			},
		});

		await expect(host.run({
			activityId: "Task_Observed",
			variables: {},
			config: {
				prompt: "Run observed task.",
				tools: [],
				inputs: [],
				outputs: ["ok"],
			},
		})).resolves.toEqual({ ok: true });

		expect(getResultRequest).toMatchObject({ agent_id: "agent-observed", wait: true, verbose: true });
		expect(events.map((event) => event.type)).toEqual(["spawned", "waiting", "result"]);
		expect(events[2]).toMatchObject({
			type: "result",
			activityId: "Task_Observed",
			agentId: "agent-observed",
		});
		expect(updates).toEqual([{
			type: "update",
			activityId: "Task_Observed",
			description: "Run BPMN service task Task_Observed",
			update: {
				details: {
					activity: "running bash",
					toolUses: 1,
					turnCount: 1,
				},
			},
		}]);
	});

	it("uses a background general-purpose subagent by default", async () => {
		let spawn: PiSubagentsSpawnRequest | undefined;
		const host = createPiSubagentsHost({
			client: {
				async spawn(request) {
					spawn = request;
					return "agent-2";
				},
				async getResult() {
					return '```json\n{"ok":true}\n```';
				},
			},
		});

		await host.run({
			activityId: "Task_Default",
			variables: {},
			config: {
				prompt: "Run default task.",
				tools: [],
				inputs: [],
				outputs: ["ok"],
			},
		});

		expect(spawn).toMatchObject({
			description: "Run BPMN service task Task_Default",
			subagent_type: "general-purpose",
			run_in_background: true,
		});
	});

	it("wraps pi-subagents tool functions as a client", async () => {
		const client = createPiSubagentsClientFromTools({
			async Agent() {
				return { agent_id: "agent-from-tool" };
			},
			async get_subagent_result(request) {
				return `agent=${request.agent_id}`;
			},
		});

		await expect(client.spawn({
			prompt: "Run",
			description: "Run task",
			subagent_type: "general-purpose",
			run_in_background: true,
		})).resolves.toEqual({ agent_id: "agent-from-tool" });
		await expect(client.getResult({
			agent_id: "agent-from-tool",
			wait: true,
		})).resolves.toBe("agent=agent-from-tool");
	});

	it("parses an agent id from a text tool result", async () => {
		const host = createPiSubagentsHost({
			client: {
				async spawn() {
					return "Agent started in background.\nAgent ID: agent-text\n";
				},
				async getResult(request) {
					expect(request.agent_id).toBe("agent-text");
					return '```json\n{"ok":true}\n```';
				},
			},
		});

		await expect(host.run({
			activityId: "Task_Text",
			variables: {},
			config: {
				prompt: "Run",
				tools: [],
				inputs: [],
				outputs: ["ok"],
			},
		})).resolves.toEqual({ ok: true });
	});

	it("reuses a spawned subagent record after an interrupted wait", async () => {
		const runStore = createInMemoryPiSubagentsRunStore();
		let spawnCount = 0;
		const request = {
			activityId: "Task_BranchA",
			variables: {},
			config: {
				prompt: "Run branch A.",
				tools: [],
				inputs: [],
				outputs: ["result"],
			},
			execution: {
				instanceId: "instance-recover",
				tokenId: 41,
			},
		};

		const firstHost = createPiSubagentsHost({
			runStore,
			client: {
				async spawn() {
					spawnCount += 1;
					return "agent-recover";
				},
				async getResult() {
					throw new Error("interrupted wait");
				},
			},
		});
		await expect(firstHost.run(request)).rejects.toThrow("interrupted wait");

		const secondHost = createPiSubagentsHost({
			runStore,
			client: {
				async spawn() {
					throw new Error("must not spawn twice");
				},
				async getResult(resultRequest) {
					expect(resultRequest.agent_id).toBe("agent-recover");
					return '```json\n{"result":"resumed"}\n```';
				},
			},
		});

		await expect(secondHost.run(request)).resolves.toEqual({ result: "resumed" });
		expect(spawnCount).toBe(1);
	});

	it("persists completed subagent output in a JSON file store", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-wendao-subagent-store-"));
		tempDirs.push(dir);
		const storePath = join(dir, "subagents.json");
		const request = {
			activityId: "Task_BranchB",
			variables: {},
			config: {
				prompt: "Run branch B.",
				tools: [],
				inputs: [],
				outputs: ["result"],
			},
			execution: {
				instanceId: "instance-json",
				tokenId: 42,
			},
		};

		const firstHost = createPiSubagentsHost({
			runStore: createJsonFilePiSubagentsRunStore(storePath),
			client: {
				async spawn() {
					return { agent_id: "agent-json" };
				},
				async getResult() {
					return '```json\n{"result":"cached"}\n```';
				},
			},
		});
		await expect(firstHost.run(request)).resolves.toEqual({ result: "cached" });

		let clientCalled = false;
		const secondHost = createPiSubagentsHost({
			runStore: createJsonFilePiSubagentsRunStore(storePath),
			client: {
				async spawn() {
					clientCalled = true;
					throw new Error("cached output should skip spawn");
				},
				async getResult() {
					clientCalled = true;
					throw new Error("cached output should skip result lookup");
				},
			},
		});

		await expect(secondHost.run(request)).resolves.toEqual({ result: "cached" });
		expect(clientCalled).toBe(false);
	});

	it("does not reuse cached output when qianji host inputs change", async () => {
		const runStore = createInMemoryPiSubagentsRunStore();
		let spawnCount = 0;
		const host = createPiSubagentsHost({
			runStore,
			client: {
				async spawn() {
					spawnCount += 1;
					return { agent_id: `agent-input-${spawnCount}` };
				},
				async getResult(request) {
					if (request.agent_id === "agent-input-1") {
						return '```json\n{"isRetryComplete":false}\n```';
					}
					return '```json\n{"isRetryComplete":true}\n```';
				},
			},
		});
		const baseRequest = {
			activityId: "Task_Check",
			config: {
				prompt: "Check retry count.",
				tools: [],
				inputs: ["retryCount"],
				outputs: ["isRetryComplete"],
			},
			execution: {
				instanceId: "instance-input-sensitive",
				tokenId: 61,
			},
		};

		await expect(host.run({
			...baseRequest,
			variables: { retryCount: 1 },
		})).resolves.toEqual({ isRetryComplete: false });
		await expect(host.run({
			...baseRequest,
			variables: { retryCount: 3 },
		})).resolves.toEqual({ isRetryComplete: true });
		expect(spawnCount).toBe(2);
	});

	it("reports pi-subagents runtime errors before completing host work", async () => {
		const runStore = createInMemoryPiSubagentsRunStore();
		const request = {
			activityId: "Task_Check",
			variables: {},
			config: {
				prompt: "Check retry count.",
				tools: [],
				inputs: [],
				outputs: ["isRetryComplete", "retryCount"],
			},
			execution: {
				instanceId: "instance-error",
				tokenId: 51,
			},
		};
		const host = createPiSubagentsHost({
			runStore,
			client: {
				async spawn() {
					return { agent_id: "agent-error" };
				},
				async getResult() {
					return [
						"Agent: agent-error",
						"Type: Agent | Status: error | Tool uses: 0 | 0 token | Duration: 0.0s",
						"Description: Check retry count",
						"",
						"Error: No API key found for anthropic.",
					].join("\n");
				},
			},
		});

		await expect(host.run(request)).rejects.toThrow("No API key found for anthropic");
		await expect(runStore.get(JSON.stringify({
			instanceId: "instance-error",
			activityId: "Task_Check",
			tokenId: 51,
			inputs: [],
		}))).resolves.toMatchObject({
			status: "failed",
			error: expect.stringContaining("No API key found for anthropic"),
		});
	});

	it("fails when a completed subagent omits declared outputs", async () => {
		const runStore = createInMemoryPiSubagentsRunStore();
		const request = {
			activityId: "Task_Check",
			variables: {},
			config: {
				prompt: "Check retry count.",
				tools: [],
				inputs: [],
				outputs: ["isRetryComplete", "retryCount"],
			},
			execution: {
				instanceId: "instance-missing-output",
				tokenId: 52,
			},
		};
		const host = createPiSubagentsHost({
			runStore,
			client: {
				async spawn() {
					return { agent_id: "agent-missing-output" };
				},
				async getResult() {
					return "Done, but without structured output.";
				},
			},
		});

		await expect(host.run(request)).rejects.toThrow(
			"did not produce required output(s) for Task_Check: isRetryComplete, retryCount",
		);
	});

	it("ignores stale completed cache records missing required outputs", async () => {
		const key = JSON.stringify({
			instanceId: "instance-stale",
			activityId: "Task_Stale",
			tokenId: 53,
			inputs: [],
		});
		const runStore = createInMemoryPiSubagentsRunStore([{
			key,
			agentId: "agent-stale",
			activityId: "Task_Stale",
			instanceId: "instance-stale",
			tokenId: 53,
			status: "completed",
			spawnRequest: {
				prompt: "Old prompt",
				description: "Old task",
				subagent_type: "general-purpose",
				run_in_background: true,
			},
			output: {},
			createdAt: "2026-04-24T00:00:00.000Z",
			updatedAt: "2026-04-24T00:00:00.000Z",
		}]);
		let spawnCount = 0;
		const host = createPiSubagentsHost({
			runStore,
			client: {
				async spawn() {
					spawnCount += 1;
					return { agent_id: "agent-fresh" };
				},
				async getResult() {
					return {
						content: [{ type: "text", text: '```json\n{"result":"fresh"}\n```' }],
					};
				},
			},
		});

		await expect(host.run({
			activityId: "Task_Stale",
			variables: {},
			config: {
				prompt: "Run fresh.",
				tools: [],
				inputs: [],
				outputs: ["result"],
			},
			execution: {
				instanceId: "instance-stale",
				tokenId: 53,
			},
		})).resolves.toEqual({ result: "fresh" });
		expect(spawnCount).toBe(1);
	});
});
