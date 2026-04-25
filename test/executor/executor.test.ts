import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider, type Context } from "@mariozechner/pi-ai";
import { execute, mapHumanTaskReplyToOutputs, type QianjiHostWorkEvent } from "../../src/executor/executor.js";
import type { PiWendaoAgentHost } from "../../src/executor/agent-host.js";
import { GraphView } from "../../src/output/graph-view.js";

const fixturesDir = join(import.meta.dirname, "../fixtures");
const tempDirs: string[] = [];

describe("executor", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("executes a workflow through qianji CLI", async () => {
		const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
		const outputChunks: string[] = [];

		const result = await execute({
			source,
			qianjiCommand: makeFakeQianjiCommand(),
			instanceId: "wf_test",
			variables: ["myKey=myValue", "count=42"],
			onCliOutput: (output) => outputChunks.push(output),
		});

		expect(result.success).toBe(true);
		expect(result.variables).toMatchObject({
			myKey: "myValue",
			count: "42",
			process: "Process_1",
			instance: "wf_test",
			bpmnSeen: true,
			hostFixtureSeen: true,
			fixtureServiceTasks: ["Task_1"],
		});
		expect(outputChunks.join("\n")).toContain("# BPMN Run");
	});

	it("passes explicit process and context to qianji", async () => {
		const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");

		const result = await execute({
			source,
			qianjiCommand: makeFakeQianjiCommand(),
			processId: "Explicit_Process",
			context: { same: "context", extra: true },
			variables: ["same=var"],
		});

		expect(result.success).toBe(true);
		expect(result.variables).toMatchObject({
			process: "Explicit_Process",
			same: "context",
			extra: true,
		});
	});

	it("populates the graph view and applies qianji execution trace", async () => {
		const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
		const graphView = new GraphView();
		let graphReadyCount = 0;
		let graphUpdateCount = 0;
		const started: string[] = [];
		const ended: string[] = [];
		const flows: string[] = [];

		const result = await execute({
			source,
			qianjiCommand: makeFakeQianjiCommand(),
			graphView,
			traceFrameDelayMs: 0,
			onGraphReady: () => {
				graphReadyCount += 1;
			},
			onGraphUpdate: () => {
				graphUpdateCount += 1;
			},
			onActivityStart: (activityId) => started.push(activityId),
			onActivityEnd: (activityId) => ended.push(activityId),
			onFlowTake: (flowId) => flows.push(flowId),
		});

		expect(result.success).toBe(true);
		expect(result.rawOutput).not.toContain("@@QIANJI_TRACE");
		expect(graphReadyCount).toBe(1);
		expect(graphUpdateCount).toBeGreaterThan(0);
		expect(started).toContain("Task_1");
		expect(ended).toContain("Task_1");
		expect(flows).toEqual(["Start_1->Task_1", "Task_1->End_1"]);
		const internals = graphView as unknown as {
			nodes: Map<string, { status: string }>;
			edges: Array<{ source: string; target: string; taken: boolean }>;
		};
		expect(internals.nodes.get("Task_1")?.status).toBe("done");
		expect(internals.edges.find((edge) => edge.source === "Start_1" && edge.target === "Task_1")?.taken).toBe(true);
		expect(internals.edges.find((edge) => edge.source === "Task_1" && edge.target === "End_1")?.taken).toBe(true);
		const plainGraph = graphView.render(80).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(plainGraph).toContain("( )");
		expect(plainGraph).toContain("List files");
		expect(plainGraph).toContain("(*)");
	});

	it("hydrates the graph view from qianji status for an explicit instance", async () => {
		const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
		const graphView = new GraphView();
		let graphUpdateCount = 0;

		const result = await execute({
			source,
			qianjiCommand: makeFakeQianjiGraphSnapshotCommand(),
			instanceId: "wf_resume",
			graphView,
			traceFrameDelayMs: 0,
			onGraphUpdate: () => {
				graphUpdateCount += 1;
			},
		});

		expect(result.success).toBe(true);
		expect(graphUpdateCount).toBeGreaterThan(0);
		const internals = graphView as unknown as {
			nodes: Map<string, { status: string }>;
		};
		expect(internals.nodes.get("Start_1")?.status).toBe("done");
		expect(internals.nodes.get("Task_1")?.status).toBe("active");
		expect(internals.nodes.get("End_1")?.status).toBe("pending");
	});

	it("paces streamed graph updates before final CLI output", async () => {
		const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
		const graphView = new GraphView();
		const updateTimes: number[] = [];
		let cliOutputSeen = false;

		const result = await execute({
			source,
			qianjiCommand: makeFakeQianjiCommand(),
			graphView,
			traceFrameDelayMs: 5,
			onGraphUpdate: () => {
				updateTimes.push(performance.now());
				expect(cliOutputSeen).toBe(false);
			},
			onCliOutput: () => {
				cliOutputSeen = true;
			},
		});

		expect(result.success).toBe(true);
		expect(updateTimes.length).toBeGreaterThan(1);
		expect(updateTimes[updateTimes.length - 1] - updateTimes[0]).toBeGreaterThanOrEqual(10);
		expect(cliOutputSeen).toBe(true);
	});

	it("resolves qianji from PATH by default", async () => {
		const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
		const originalPath = process.env.PATH;
		const originalQianjiCli = process.env.QIANJI_CLI;
		const binDir = makeFakeQianjiPathDir();

		try {
			delete process.env.QIANJI_CLI;
			process.env.PATH = [binDir, originalPath].filter(Boolean).join(delimiter);

			const result = await execute({
				source,
				instanceId: "wf_path",
			});

			expect(result.success).toBe(true);
			expect(result.variables).toMatchObject({
				process: "Process_1",
				instance: "wf_path",
				bpmnSeen: true,
			});
		} finally {
			restoreEnv("PATH", originalPath);
			restoreEnv("QIANJI_CLI", originalQianjiCli);
		}
	});

	it("resolves token-scoped qianji host work with real agent services", async () => {
		const faux = registerFauxProvider();
		const prompts: string[] = [];
		const starts: Record<string, number> = {};
		const delayedResponse = async (context: Context) => {
			const item = context.systemPrompt.includes('item: "alpha"') ? "alpha" : "beta";
			starts[item] = performance.now();
			prompts.push(context.systemPrompt);
			await delay(80);
			return fauxAssistantMessage(`Done.\n\`\`\`json\n{"result":"${item}_done"}\n\`\`\``);
		};
		faux.setResponses([delayedResponse, delayedResponse]);

		try {
			const result = await execute({
				source: tokenScopedServiceTaskWorkflow(),
				qianjiCommand: makeFakeExternalHostQianjiCommand(),
				instanceId: "wf_token_host",
				context: { items: ["alpha", "beta"] },
				model: faux.getModel(),
				apiKey: "test-key",
			});

			expect(result.success).toBe(true);
			expect(result.rawOutput).not.toContain("@@QIANJI_HOST_WORK");
			expect(prompts[0]).toContain('item: "alpha"');
			expect(prompts[1]).toContain('item: "beta"');
			expect(prompts[0]).toContain("Qianji BPMN execution context");
			expect(prompts[0]).toContain("processId: Process_1");
			expect(prompts[0]).toContain("instanceId: wf_token_host");
			expect(prompts[0]).toContain("activityId: Task_Review");
			expect(prompts[0]).toContain("tokenId: 11");
			expect(prompts[0]).toContain("checkpoint.backend: duckdb");
			expect(prompts[0]).toContain("checkpoint.source: fresh");
			expect(prompts[0]).toContain("checkpoint.pendingHostWork: 2");
			expect(Math.abs(starts.beta - starts.alpha)).toBeLessThan(60);
			expect(result.variables).toMatchObject({
				results: ["alpha_done", "beta_done"],
				fixtureServiceTaskTokens: ["11", "12"],
			});
		} finally {
			faux.unregister();
		}
	});

	it("dispatches token-scoped qianji host work through an injected host in parallel", async () => {
		const starts: Record<string, number> = {};
		const executions: Array<{ activityId: string; tokenId?: number; item: unknown; subagentType?: string }> = [];
		const hostWorkEvents: QianjiHostWorkEvent[] = [];
		const graphView = new GraphView();
		const agentHost: PiWendaoAgentHost = {
			async run(request) {
				const item = request.variables.item as string;
				starts[item] = performance.now();
				executions.push({
					activityId: request.activityId,
					tokenId: request.execution?.tokenId,
					item,
					subagentType: request.config.subagent?.type,
				});
				await delay(80);
				return { result: `${item}_done` };
			},
		};

		const result = await execute({
			source: tokenScopedServiceTaskWorkflow(),
			qianjiCommand: makeFakeExternalHostQianjiCommand(),
			instanceId: "wf_token_injected_host",
			context: { items: ["alpha", "beta"] },
			agentHost,
			hostBackend: "pi-subagents",
			graphView,
			onHostWork: (event) => hostWorkEvents.push(event),
			traceFrameDelayMs: 0,
		});

		expect(result.success).toBe(true);
		expect(Math.abs(starts.beta - starts.alpha)).toBeLessThan(60);
		expect(executions).toEqual([
			{ activityId: "Task_Review", tokenId: 11, item: "alpha", subagentType: "pi-wendao-worker" },
			{ activityId: "Task_Review", tokenId: 12, item: "beta", subagentType: "pi-wendao-worker" },
		]);
		expect(result.variables).toMatchObject({
			results: ["alpha_done", "beta_done"],
			fixtureServiceTaskTokens: ["11", "12"],
		});
		const internals = graphView as unknown as {
			nodes: Map<string, { details?: string[] }>;
		};
		expect(internals.nodes.get("Task_Review")?.details).toEqual([
			"host:2 pi-subagents",
			"parallel:2 jobs tokens=11,12",
			"checkpoint:duckdb/fresh/saved",
			"subagent:pi-wendao-worker",
		]);
		expect(hostWorkEvents).toEqual([{
			activityId: "Task_Review",
			hostWorkCount: 2,
			batchHostWorkCount: 2,
			tokenIds: [11, 12],
			hostKinds: ["service"],
			parallel: true,
			repeatKinds: ["parallel_multi_instance"],
			repeatSummaries: ["parallel_multi_instance 1/2", "parallel_multi_instance 2/2"],
		}]);
	});

	it("routes qianji userTask host work through the human task handler", async () => {
		const prompts: string[] = [];
		const graphView = new GraphView();

		const result = await execute({
			source: humanApprovalWorkflow(),
			qianjiCommand: makeFakeUserTaskExternalHostQianjiCommand(),
			instanceId: "wf_human_approval",
			humanTaskHandler: async (request) => {
				prompts.push(request.config.prompt);
				return "y";
			},
			graphView,
			traceFrameDelayMs: 0,
		});

		expect(result.success).toBe(true);
		expect(prompts).toEqual(["Review the proposal and approve before continuing."]);
		expect(result.rawOutput).not.toContain("@@QIANJI_HOST_WORK");
		expect(result.variables).toMatchObject({
			approved: true,
			approvedReply: "y",
			fixtureUserTasks: ["Task_Approve"],
		});
		const internals = graphView as unknown as {
			nodes: Map<string, { details?: string[] }>;
		};
		expect(internals.nodes.get("Task_Approve")?.details).toContain("host:user:1 human");
	});

	it("maps human replies to approval booleans and raw reply outputs", () => {
		expect(mapHumanTaskReplyToOutputs("n", ["approved", "approvedReply", "feedback"]))
			.toEqual({ approved: false, approvedReply: "n", feedback: "n" });
		expect(mapHumanTaskReplyToOutputs("approved", ["approved"]))
			.toEqual({ approved: true });
	});

	it("carries accumulated host outputs across partial qianji host variable snapshots", async () => {
		const faux = registerFauxProvider();
		const prompts: string[] = [];
		faux.setResponses([
			fauxAssistantMessage('Done.\n```json\n{"fileList":["package.json","src"]}\n```'),
			(context) => {
				prompts.push(context.systemPrompt);
				return fauxAssistantMessage('Done.\n```json\n{"report":"package.json exists in package.json, src"}\n```');
			},
		]);

		try {
			const result = await execute({
				source: sequentialServiceTaskWorkflow(),
				qianjiCommand: makeFakeSequentialExternalHostQianjiCommand(),
				instanceId: "wf_sequential_host",
				model: faux.getModel(),
				apiKey: "test-key",
			});

			expect(result.success).toBe(true);
			expect(prompts[0]).toContain('fileList: ["package.json","src"]');
			expect(result.variables).toMatchObject({
				fileList: ["package.json", "src"],
				report: "package.json exists in package.json, src",
			});
		} finally {
			faux.unregister();
		}
	});

	it("feeds host retry outputs back to qianji checkpoints without local scheduling", async () => {
		const executions: Array<{ activityId: string; retryCount: unknown }> = [];
		const agentHost: PiWendaoAgentHost = {
			async run(request) {
				executions.push({
					activityId: request.activityId,
					retryCount: request.variables.retryCount,
				});
				if (request.activityId === "Task_1") {
					return { retryCount: 1, status: "not ready" };
				}
				if (request.activityId === "Task_2") {
					const retryCount = Number(request.variables.retryCount);
					return { isRetryComplete: retryCount >= 3, retryCount };
				}
				if (request.activityId === "Task_4") {
					return { retryCount: Number(request.variables.retryCount) + 1 };
				}
				if (request.activityId === "Task_3") {
					return { status: "ready" };
				}
				return {};
			},
		};

		const result = await execute({
			source: retryLoopWorkflow(),
			qianjiCommand: makeFakeRetryLoopExternalHostQianjiCommand(),
			instanceId: "wf_retry_checkpoint",
			agentHost,
			hostBackend: "pi-subagents",
		});

		expect(result.success).toBe(true);
		expect(result.variables).toMatchObject({
			retryCount: 3,
			isRetryComplete: true,
			status: "ready",
		});
		expect(executions.filter((execution) => execution.activityId === "Task_2").map((execution) => execution.retryCount))
			.toEqual([1, 2, 3]);
		expect(executions.filter((execution) => execution.activityId === "Task_4").map((execution) => execution.retryCount))
			.toEqual([1, 2]);
	});

	it("does not synthesize task outputs from service-task prompt text", async () => {
		const agentHost: PiWendaoAgentHost = {
			async run() {
				return { status: "host-owned" };
			},
		};

		const result = await execute({
			source: promptDerivedOutputWorkflow(),
			qianjiCommand: makeFakeSingleHostBoundaryQianjiCommand(),
			instanceId: "wf_no_prompt_output_synthesis",
			agentHost,
			hostBackend: "pi-subagents",
		});

		expect(result.success).toBe(true);
		expect(result.variables).toMatchObject({
			status: "host-owned",
		});
	});

	it("reports qianji CLI failures", async () => {
		const source = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");

		const result = await execute({
			source,
			qianjiCommand: makeFakeQianjiCommand({ exitCode: 2, stderr: "qianji failed" }),
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("qianji failed");
	});
});

function makeFakeQianjiCommand(options: { exitCode?: number; stderr?: string } = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-"));
	tempDirs.push(dir);
	const scriptPath = join(dir, "fake-qianji.cjs");
	writeFakeQianjiScript(scriptPath, options);
	return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeQianjiGraphSnapshotCommand(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-snapshot-"));
	tempDirs.push(dir);
	const scriptPath = join(dir, "fake-qianji-snapshot.cjs");
	writeFakeQianjiGraphSnapshotScript(scriptPath);
	return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeQianjiPathDir(options: { exitCode?: number; stderr?: string } = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-path-"));
	tempDirs.push(dir);
	const scriptPath = join(dir, "qianji");
	writeFakeQianjiScript(scriptPath, options, true);
	chmodSync(scriptPath, 0o755);
	return dir;
}

function makeFakeExternalHostQianjiCommand(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-external-host-"));
	tempDirs.push(dir);
	const scriptPath = join(dir, "fake-qianji-external-host.cjs");
	writeFakeExternalHostQianjiScript(scriptPath);
	return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeUserTaskExternalHostQianjiCommand(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-user-host-"));
	tempDirs.push(dir);
	const scriptPath = join(dir, "fake-qianji-user-host.cjs");
	writeFakeUserTaskExternalHostQianjiScript(scriptPath);
	return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeSequentialExternalHostQianjiCommand(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-sequential-host-"));
	tempDirs.push(dir);
	const scriptPath = join(dir, "fake-qianji-sequential-host.cjs");
	writeFakeSequentialExternalHostQianjiScript(scriptPath);
	return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeRetryLoopExternalHostQianjiCommand(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-retry-host-"));
	tempDirs.push(dir);
	const scriptPath = join(dir, "fake-qianji-retry-host.cjs");
	writeFakeRetryLoopExternalHostQianjiScript(scriptPath);
	return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function makeFakeSingleHostBoundaryQianjiCommand(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-single-host-"));
	tempDirs.push(dir);
	const scriptPath = join(dir, "fake-qianji-single-host.cjs");
	writeFakeSingleHostBoundaryQianjiScript(scriptPath);
	return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function writeFakeQianjiGraphSnapshotScript(scriptPath: string): void {
	writeFileSync(scriptPath, `
const args = process.argv.slice(2);
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args[1] === "status") {
  if (!get("--bpmn")) {
    console.error("status graph hydration requires --bpmn");
    process.exit(65);
  }
  const snapshot = [
    { node_id: "Start_1", node_index: 0, node_kind: "start_event", status: "completed" },
    { node_id: "Task_1", node_index: 1, node_kind: "service_task", status: "executing" },
    { node_id: "End_1", node_index: 2, node_kind: "end_event", status: "idle" },
  ];
  console.log("# BPMN Status\\n\\nInstance: " + get("--instance-id") + "\\nCheckpoint status: loaded\\n\\n## Graph Snapshot\\n" + fence + "json\\n" + JSON.stringify(snapshot, null, 2) + "\\n" + fence + "\\n");
  process.exit(0);
}
if (args[1] === "run") {
  console.log("# BPMN Run\\n\\nOutcome: blocked_on_host\\n\\n## Variables\\n" + fence + "json\\n{}\\n" + fence + "\\n");
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`, "utf-8");
}

function writeFakeQianjiScript(scriptPath: string, options: { exitCode?: number; stderr?: string }, executable = false): void {
	const exitCode = options.exitCode ?? 0;
	const stderr = JSON.stringify(options.stderr ?? "");
	writeFileSync(scriptPath, `${executable ? "#!/usr/bin/env node\n" : ""}
const args = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
if (args[0] !== "bpmn" || args[1] !== "run") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args.includes("--checkpoint-runtime") || args.includes("--checkpoint-sqlite")) {
  console.error("pi-wendao must let qianji choose its checkpoint backend: " + args.join(" "));
  process.exit(65);
}
if (${exitCode} !== 0) {
  const message = ${stderr};
  if (message) console.error(message);
  process.exit(${exitCode});
}
const context = JSON.parse(get("--context-json") ?? "{}");
const hostFixturePath = get("--host-fixture");
const hostFixture = hostFixturePath ? JSON.parse(readFileSync(hostFixturePath, "utf-8")) : undefined;
const variables = {
  ...context,
  process: get("--process"),
  instance: get("--instance-id"),
  bpmnSeen: Boolean(get("--bpmn")),
  hostFixtureSeen: Boolean(hostFixturePath),
  fixtureServiceTasks: Object.keys(hostFixture?.service_tasks ?? {}),
};
const trace = [
  { sequence: 1, kind: "node_status", process_id: get("--process"), node_id: "Start_1", node_kind: "start_event", status: "queued" },
  { sequence: 2, kind: "node_status", process_id: get("--process"), node_id: "Start_1", node_kind: "start_event", status: "completed" },
  { sequence: 3, kind: "flow_take", process_id: get("--process"), source_id: "Start_1", target_id: "Task_1" },
  { sequence: 4, kind: "node_status", process_id: get("--process"), node_id: "Task_1", node_kind: "service_task", status: "executing" },
  { sequence: 5, kind: "node_status", process_id: get("--process"), node_id: "Task_1", node_kind: "service_task", status: "completed" },
  { sequence: 6, kind: "flow_take", process_id: get("--process"), source_id: "Task_1", target_id: "End_1" },
  { sequence: 7, kind: "node_status", process_id: get("--process"), node_id: "End_1", node_kind: "end_event", status: "completed" },
];
const fence = String.fromCharCode(96, 96, 96);
if (args.includes("--trace-stream")) {
  for (const event of trace) {
    console.log("@@QIANJI_TRACE " + JSON.stringify(event));
  }
}
console.log("# BPMN Run\\n\\nOutcome: completed\\n\\n## Trace\\n" + fence + "json\\n" + JSON.stringify(trace, null, 2) + "\\n" + fence + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
`, "utf-8");
}

function writeFakeExternalHostQianjiScript(scriptPath: string): void {
	writeFileSync(scriptPath, `
const args = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables, checkpoint = "") => {
  console.log("# " + title + "\\n\\nOutcome: " + outcome + checkpoint + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args.includes("--checkpoint-runtime") || args.includes("--checkpoint-sqlite")) {
  console.error("pi-wendao must let qianji choose its checkpoint backend: " + args.join(" "));
  process.exit(65);
}
if (args[1] === "run") {
  const processId = get("--process");
  if (args.includes("--trace-stream")) {
    console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", process_id: processId, node_id: "Task_Review", node_kind: "service_task", status: "executing" }));
  }
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: "Task_Review",
    node_index: 1,
    token_id: 11,
    variables: { items: ["alpha", "beta"], item: "alpha" },
    repeat: { kind: "parallel_multi_instance", iteration_index: 0, total_iterations: 2 },
  }));
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: "Task_Review",
    node_index: 1,
    token_id: 12,
    variables: { items: ["alpha", "beta"], item: "beta" },
    repeat: { kind: "parallel_multi_instance", iteration_index: 1, total_iterations: 2 },
  }));
  printVariables("BPMN Run", "blocked_on_host", { items: ["alpha", "beta"] }, "\\nCheckpoint backend: duckdb\\nCheckpoint source: fresh\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: 2");
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const hostFixture = JSON.parse(readFileSync(get("--host-fixture"), "utf-8"));
  const serviceTaskTokens = hostFixture.service_task_tokens ?? {};
  const tokenIds = Object.keys(serviceTaskTokens);
  if (args.includes("--trace-stream")) {
    console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", node_id: "Task_Review", node_kind: "service_task", status: "completed" }));
  }
  printVariables("BPMN Task Complete", "completed", {
    results: tokenIds.map((tokenId) => serviceTaskTokens[tokenId].data.result),
    fixtureServiceTaskTokens: tokenIds,
  });
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`, "utf-8");
}

function writeFakeUserTaskExternalHostQianjiScript(scriptPath: string): void {
	writeFileSync(scriptPath, `
const args = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables, checkpoint = "") => {
  console.log("# " + title + "\\n\\nOutcome: " + outcome + checkpoint + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args[1] === "status") {
  printVariables("BPMN Status", "missing", {});
  process.exit(0);
}
if (args[1] === "run") {
  if (args.includes("--trace-stream")) {
    console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", node_id: "Task_Approve", node_kind: "user_task", status: "executing" }));
  }
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "user",
    node_id: "Task_Approve",
    node_index: 1,
    token_id: 51,
    variables: { proposal: "Ship the plan" },
  }));
  printVariables("BPMN Run", "blocked_on_host", { proposal: "Ship the plan" }, "\\nCheckpoint backend: duckdb\\nCheckpoint source: fresh\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: 1");
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const hostFixture = JSON.parse(readFileSync(get("--host-fixture"), "utf-8"));
  const userTasks = hostFixture.user_tasks ?? {};
  if (args.includes("--trace-stream")) {
    console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", node_id: "Task_Approve", node_kind: "user_task", status: "completed" }));
  }
  printVariables("BPMN Task Complete", "completed", {
    ...userTasks.Task_Approve?.data,
    fixtureUserTasks: Object.keys(userTasks),
  });
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`, "utf-8");
}

function writeFakeSequentialExternalHostQianjiScript(scriptPath: string): void {
	writeFileSync(scriptPath, `
const args = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables) => {
  console.log("# " + title + "\\n\\nOutcome: " + outcome + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args.includes("--checkpoint-runtime") || args.includes("--checkpoint-sqlite")) {
  console.error("pi-wendao must let qianji choose its checkpoint backend: " + args.join(" "));
  process.exit(65);
}
if (args[1] === "run") {
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: "Task_List",
    node_index: 1,
    token_id: 21,
    variables: {},
  }));
  printVariables("BPMN Run", "blocked_on_host", {});
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const hostFixture = JSON.parse(readFileSync(get("--host-fixture"), "utf-8"));
  const serviceTaskTokens = hostFixture.service_task_tokens ?? {};
  if (serviceTaskTokens["21"]) {
    console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
      kind: "service",
      node_id: "Task_Report",
      node_index: 2,
      token_id: 22,
      variables: {},
    }));
    printVariables("BPMN Task Complete", "blocked_on_host", {});
    process.exit(0);
  }
  printVariables("BPMN Task Complete", "completed", serviceTaskTokens["22"]?.data ?? {});
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`, "utf-8");
}

function writeFakeRetryLoopExternalHostQianjiScript(scriptPath: string): void {
	writeFileSync(scriptPath, `
const args = process.argv.slice(2);
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const statePath = join(__dirname, "retry-state.json");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables, pendingHostWork, checkpointSource) => {
  const checkpoint = "\\nCheckpoint backend: duckdb\\nCheckpoint source: " + checkpointSource + "\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: " + pendingHostWork;
  console.log("# " + title + "\\n\\nOutcome: " + outcome + checkpoint + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
const save = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2));
const load = () => existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf-8"))
  : { awaiting: undefined, nextTokenId: 40, variables: {} };
const emitHostWork = (state, nodeId, variables, source) => {
  const tokenId = state.nextTokenId++;
  state.awaiting = nodeId;
  save(state);
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: nodeId,
    node_index: tokenId,
    token_id: tokenId,
    variables,
  }));
  printVariables("BPMN Host Boundary", "blocked_on_host", state.variables, 1, source);
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args.includes("--checkpoint-runtime") || args.includes("--checkpoint-sqlite")) {
  console.error("pi-wendao must let qianji choose its checkpoint backend: " + args.join(" "));
  process.exit(65);
}
if (args[1] === "run") {
  const state = { awaiting: "Task_1", nextTokenId: 41, variables: {} };
  save(state);
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: "Task_1",
    node_index: 40,
    token_id: 40,
    variables: {},
  }));
  printVariables("BPMN Run", "blocked_on_host", {}, 1, "fresh");
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const state = load();
  const hostFixture = JSON.parse(readFileSync(get("--host-fixture"), "utf-8"));
  const serviceTaskTokens = hostFixture.service_task_tokens ?? {};
  const tokenId = Object.keys(serviceTaskTokens)[0];
  const data = serviceTaskTokens[tokenId]?.data ?? {};
  state.variables = { ...state.variables, ...data };
  if (state.awaiting === "Task_1") {
    emitHostWork(state, "Task_2", { retryCount: state.variables.retryCount }, "resumed");
    process.exit(0);
  }
  if (state.awaiting === "Task_2") {
    if (state.variables.isRetryComplete === true) {
      emitHostWork(state, "Task_3", { retryCount: state.variables.retryCount, isRetryComplete: true }, "resumed");
      process.exit(0);
    }
    emitHostWork(state, "Task_4", { retryCount: state.variables.retryCount }, "resumed");
    process.exit(0);
  }
  if (state.awaiting === "Task_4") {
    emitHostWork(state, "Task_2", { retryCount: state.variables.retryCount }, "resumed");
    process.exit(0);
  }
  if (state.awaiting === "Task_3") {
    state.awaiting = "completed";
    save(state);
    printVariables("BPMN Task Complete", "completed", state.variables, 0, "resumed");
    process.exit(0);
  }
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
	`, "utf-8");
}

function writeFakeSingleHostBoundaryQianjiScript(scriptPath: string): void {
	writeFileSync(scriptPath, `
const args = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables) => {
  console.log("# " + title + "\\n\\nOutcome: " + outcome + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};
if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
if (args[1] === "run") {
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: "Task_SetStatus",
    node_index: 1,
    token_id: 31,
    variables: {},
  }));
  printVariables("BPMN Run", "blocked_on_host", {});
  process.exit(0);
}
if (args[1] === "tasks" && args[2] === "complete") {
  const hostFixture = JSON.parse(readFileSync(get("--host-fixture"), "utf-8"));
  const serviceTaskTokens = hostFixture.service_task_tokens ?? {};
  const tokenId = Object.keys(serviceTaskTokens)[0];
  printVariables("BPMN Task Complete", "completed", serviceTaskTokens[tokenId]?.data ?? {});
  process.exit(0);
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
	`, "utf-8");
}

function tokenScopedServiceTaskWorkflow(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
	<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:skillsc="http://skillsc.dev/bpmn/extensions"
             id="Definitions_1"
             targetNamespace="http://skillsc.dev">
  <process id="Process_1" isExecutable="true">
    <startEvent id="Start_1"/>
    <serviceTask id="Task_Review" name="Review item" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <skillsc:config>
          <skillsc:prompt>Review the current item and output result.</skillsc:prompt>
          <skillsc:tools></skillsc:tools>
          <skillsc:inputs>item</skillsc:inputs>
          <skillsc:outputs>result</skillsc:outputs>
          <skillsc:agentType>pi-wendao-worker</skillsc:agentType>
          <skillsc:runInBackground>true</skillsc:runInBackground>
          <skillsc:maxTurns>8</skillsc:maxTurns>
        </skillsc:config>
      </extensionElements>
      <multiInstanceLoopCharacteristics>
        <loopDataInputRef>items</loopDataInputRef>
        <inputDataItem id="item"/>
        <loopDataOutputRef>results</loopDataOutputRef>
        <outputDataItem id="result"/>
      </multiInstanceLoopCharacteristics>
    </serviceTask>
    <endEvent id="End_1"/>
    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Review"/>
    <sequenceFlow id="Flow_2" sourceRef="Task_Review" targetRef="End_1"/>
	</process>
	</definitions>`;
}

function humanApprovalWorkflow(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
	<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:skillsc="http://skillsc.dev/bpmn/extensions"
             id="Definitions_1"
             targetNamespace="http://skillsc.dev">
  <process id="Process_1" isExecutable="true">
    <startEvent id="Start_1"/>
    <userTask id="Task_Approve" name="Approve proposal">
      <extensionElements>
        <skillsc:config>
          <skillsc:prompt>Review the proposal and approve before continuing.</skillsc:prompt>
          <skillsc:tools></skillsc:tools>
          <skillsc:inputs>proposal</skillsc:inputs>
          <skillsc:outputs>approved,approvedReply</skillsc:outputs>
        </skillsc:config>
      </extensionElements>
    </userTask>
    <endEvent id="End_1"/>
    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Approve"/>
    <sequenceFlow id="Flow_2" sourceRef="Task_Approve" targetRef="End_1"/>
	</process>
	</definitions>`;
}

function promptDerivedOutputWorkflow(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
	<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
	             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
	             xmlns:skillsc="http://skillsc.dev/bpmn/extensions"
	             id="Definitions_1"
	             targetNamespace="http://skillsc.dev">
	  <process id="Process_1" isExecutable="true">
	    <startEvent id="Start_1"/>
	    <serviceTask id="Task_SetStatus" name="Set status" implementation="\${environment.services.runAgent}">
	      <extensionElements>
	        <skillsc:config>
	          <skillsc:prompt>Set status to "ready". Output status.</skillsc:prompt>
	          <skillsc:tools></skillsc:tools>
	          <skillsc:inputs></skillsc:inputs>
	          <skillsc:outputs>status</skillsc:outputs>
	        </skillsc:config>
	      </extensionElements>
	    </serviceTask>
	    <endEvent id="End_1"/>
	    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_SetStatus"/>
	    <sequenceFlow id="Flow_2" sourceRef="Task_SetStatus" targetRef="End_1"/>
	  </process>
	</definitions>`;
}

function retryLoopWorkflow(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
	<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:skillsc="http://skillsc.dev/bpmn/extensions"
             id="Definitions_1"
             targetNamespace="http://skillsc.dev">
  <process id="Process_1" isExecutable="true">
    <startEvent id="Start_1"/>
    <serviceTask id="Task_1" name="Initialize system" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <skillsc:config>
          <skillsc:prompt>Set retryCount to 1 and status to "not ready". Output both variables.</skillsc:prompt>
          <skillsc:tools></skillsc:tools>
          <skillsc:inputs></skillsc:inputs>
          <skillsc:outputs>retryCount,status</skillsc:outputs>
        </skillsc:config>
      </extensionElements>
    </serviceTask>
    <serviceTask id="Task_2" name="Check retry count" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <skillsc:config>
          <skillsc:prompt>Check if retryCount is greater than or equal to 3. Output isRetryComplete as true if retryCount &gt;= 3, false otherwise. Also output the current retryCount value.</skillsc:prompt>
          <skillsc:tools></skillsc:tools>
          <skillsc:inputs>retryCount</skillsc:inputs>
          <skillsc:outputs>isRetryComplete,retryCount</skillsc:outputs>
        </skillsc:config>
      </extensionElements>
    </serviceTask>
    <exclusiveGateway id="Gateway_1" name="Retry complete?" default="Flow_5"/>
    <serviceTask id="Task_3" name="Set status ready" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <skillsc:config>
          <skillsc:prompt>Set status to "ready". Output status as "ready".</skillsc:prompt>
          <skillsc:tools></skillsc:tools>
          <skillsc:inputs></skillsc:inputs>
          <skillsc:outputs>status</skillsc:outputs>
        </skillsc:config>
      </extensionElements>
    </serviceTask>
    <serviceTask id="Task_4" name="Increment retry count" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <skillsc:config>
          <skillsc:prompt>Increment retryCount by 1. Output the new retryCount value.</skillsc:prompt>
          <skillsc:tools></skillsc:tools>
          <skillsc:inputs>retryCount</skillsc:inputs>
          <skillsc:outputs>retryCount</skillsc:outputs>
        </skillsc:config>
      </extensionElements>
    </serviceTask>
    <endEvent id="End_1"/>
    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1"/>
    <sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="Task_2"/>
    <sequenceFlow id="Flow_3" sourceRef="Task_2" targetRef="Gateway_1"/>
    <sequenceFlow id="Flow_4" sourceRef="Gateway_1" targetRef="Task_3">
      <conditionExpression xsi:type="tFormalExpression">isRetryComplete</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="Flow_5" sourceRef="Gateway_1" targetRef="Task_4"/>
    <sequenceFlow id="Flow_6" sourceRef="Task_4" targetRef="Task_2"/>
    <sequenceFlow id="Flow_7" sourceRef="Task_3" targetRef="End_1"/>
  </process>
</definitions>`;
}

function sequentialServiceTaskWorkflow(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:skillsc="http://skillsc.dev/bpmn/extensions"
             id="Definitions_1"
             targetNamespace="http://skillsc.dev">
  <process id="Process_1" isExecutable="true">
    <startEvent id="Start_1"/>
    <serviceTask id="Task_List" name="List files" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <skillsc:config>
          <skillsc:prompt>List files and output fileList.</skillsc:prompt>
          <skillsc:tools></skillsc:tools>
          <skillsc:inputs></skillsc:inputs>
          <skillsc:outputs>fileList</skillsc:outputs>
        </skillsc:config>
      </extensionElements>
    </serviceTask>
    <serviceTask id="Task_Report" name="Report files" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <skillsc:config>
          <skillsc:prompt>Write a report from fileList.</skillsc:prompt>
          <skillsc:tools></skillsc:tools>
          <skillsc:inputs>fileList</skillsc:inputs>
          <skillsc:outputs>report</skillsc:outputs>
        </skillsc:config>
      </extensionElements>
    </serviceTask>
    <endEvent id="End_1"/>
    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_List"/>
    <sequenceFlow id="Flow_2" sourceRef="Task_List" targetRef="Task_Report"/>
    <sequenceFlow id="Flow_3" sourceRef="Task_Report" targetRef="End_1"/>
  </process>
</definitions>`;
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
