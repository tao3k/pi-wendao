import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { XMLParser } from "fast-xml-parser";
import type { Model } from "@mariozechner/pi-ai";
import type { GraphNode, GraphView, NodeStatus } from "../output/graph-view.js";
import type {
	SkillscAgentExecutionMetadata,
	SkillscAgentHost,
	SkillscConfig,
	SkillscHostWorkKind,
	SkillscQianjiCheckpointFeedback,
	SkillscSubagentConfig,
} from "./agent-host.js";
import type { SkillscAgentEvent, SkillscAgentTool, SkillscThinkingLevel } from "./agent-runtime-types.js";
import { createPiAiHost } from "./node-runner.js";

export interface ExecuteOptions {
	/** BPMN 2.0 XML source */
	source: string;
	/** Existing BPMN source path. When omitted, the source is written to a temp file for qianji. */
	sourcePath?: string;
	/** BPMN process id. Defaults to the first process declared in the source. */
	processId?: string;
	/** Workflow instance id. Defaults to a generated pi-wendao id. */
	instanceId?: string;
	/** Qianji CLI command. Defaults to QIANJI_CLI or qianji on PATH. */
	qianjiCommand?: string;
	/** Additional DMN files passed through as repeated --dmn args. */
	dmnPaths?: string[];
	/** Optional qianji host fixture. */
	hostFixturePath?: string;
	/** Optional qianji event fixture. */
	eventFixturePath?: string;
	/** Raw JSON object merged after --var pairs for qianji --context-json. */
	context?: Record<string, unknown>;
	/** Deprecated compatibility field; execution is owned by the qianji CLI. */
	model?: Model<string>;
	/** Deprecated compatibility field; qianji CLI execution does not read API keys directly. */
	apiKey?: string;
	/** LLM thinking level for real host-side skill execution. */
	thinkingLevel?: SkillscThinkingLevel;
	/** Optional service-task agent host override. Defaults to pi-ai when model is provided. */
	agentHost?: SkillscAgentHost;
	/** Handles BPMN userTask host work as graph-local human input. */
	humanTaskHandler?: (request: HumanTaskPromptRequest) => Promise<string>;
	/** Display name for the active real-host backend in graph node runtime details. */
	hostBackend?: string;
	/** Extra tools exposed to the default pi-ai service-task host. */
	agentTools?: SkillscAgentTool<any>[];
	/** Working directory for the qianji process */
	cwd?: string;
	/** Initial variables as key=value pairs */
	variables?: string[];
	/** Called with qianji stdout/stderr once the CLI exits. */
	onCliOutput?: (output: string) => void;
	/** Retained for API compatibility; qianji CLI execution does not emit agent events. */
	onAgentEvent?: (event: SkillscAgentEvent) => void;
	/** Called from qianji execution trace when a BPMN node starts executing. */
	onActivityStart?: (activityId: string, activityName: string) => void;
	/** Called from qianji execution trace when a BPMN node reaches a terminal status. */
	onActivityEnd?: (activityId: string, activityName: string) => void;
	/** Called from qianji execution trace when a BPMN sequence flow is taken. */
	onFlowTake?: (flowId: string) => void;
	/** Called on error */
	onError?: (err: Error) => void;
	/** Retained for API compatibility; qianji CLI execution does not consume moddle options. */
	moddleOptions?: Record<string, unknown>;
	/** Graph view populated from BPMN and updated from qianji execution trace. */
	graphView?: GraphView;
	/** Called after the static BPMN graph has been loaded. */
	onGraphReady?: () => void;
	/** Called after each trace-backed graph mutation. */
	onGraphUpdate?: () => void;
	/** Called for every streamed or replayed qianji execution trace event. */
	onTraceEvent?: (event: QianjiTraceEvent) => void;
	/** Called when qianji exposes pending external host work tokens. */
	onHostWork?: (event: QianjiHostWorkEvent) => void;
	/** Delay between streamed graph trace events. Defaults to a small visual frame delay when graphView is enabled. */
	traceFrameDelayMs?: number;
}

export interface ExecuteResult {
	success: boolean;
	error?: string;
	variables: Record<string, unknown>;
	output: Record<string, unknown>;
	rawOutput?: string;
}

export interface HumanTaskPromptRequest {
	activityId: string;
	config: SkillscConfig;
	variables: Record<string, unknown>;
	execution?: SkillscAgentExecutionMetadata;
}

interface QianjiCliResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	streamedTrace: boolean;
	hostWork: QianjiHostWork[];
}

export type QianjiTraceEvent = QianjiTraceNodeStatusEvent | QianjiTraceFlowTakeEvent;

export interface QianjiHostWorkEvent {
	activityId: string;
	hostWorkCount: number;
	batchHostWorkCount: number;
	tokenIds: number[];
	hostKinds: SkillscHostWorkKind[];
	parallel: boolean;
	repeatKinds: string[];
	repeatSummaries: string[];
}

type QianjiHostWork = QianjiBaseHostWork;

interface QianjiBaseHostWork {
	kind: SkillscHostWorkKind;
	node_id: string;
	node_index?: number;
	token_id: number;
	variables?: Record<string, unknown>;
	repeat?: unknown;
}

interface QianjiTraceNodeStatusEvent {
	kind: "node_status";
	node_id: string;
	node_kind?: string | null;
	status: string;
}

interface QianjiTraceFlowTakeEvent {
	kind: "flow_take";
	source_id: string;
	target_id: string;
}

interface QianjiGraphSnapshotNode {
	node_id: string;
	status: string;
	node_kind?: string | null;
	node_index?: number;
}

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "",
	removeNSPrefix: true,
});

const DEFAULT_GRAPH_TRACE_FRAME_DELAY_MS = 60;

const GRAPH_NODE_SPECS: Array<{ element: string; type: GraphNode["type"] }> = [
	{ element: "startEvent", type: "start" },
	{ element: "endEvent", type: "end" },
	{ element: "serviceTask", type: "task" },
	{ element: "task", type: "task" },
	{ element: "userTask", type: "task" },
	{ element: "scriptTask", type: "task" },
	{ element: "businessRuleTask", type: "task" },
	{ element: "sendTask", type: "task" },
	{ element: "receiveTask", type: "task" },
	{ element: "manualTask", type: "task" },
	{ element: "callActivity", type: "task" },
	{ element: "subProcess", type: "task" },
	{ element: "exclusiveGateway", type: "gateway" },
	{ element: "parallelGateway", type: "gateway" },
	{ element: "inclusiveGateway", type: "gateway" },
	{ element: "eventBasedGateway", type: "gateway" },
	{ element: "complexGateway", type: "gateway" },
	{ element: "boundaryEvent", type: "boundary" },
	{ element: "intermediateCatchEvent", type: "boundary" },
	{ element: "intermediateThrowEvent", type: "boundary" },
];

/**
 * Execute a BPMN workflow through the qianji CLI.
 */
export async function execute(options: ExecuteOptions): Promise<ExecuteResult> {
	const tempDirs: string[] = [];
	try {
		const cwd = options.cwd ?? process.cwd();
		const sourcePath = options.sourcePath
			? resolve(cwd, options.sourcePath)
			: await writeTempBpmnSource(options.source).then(({ dir, path }) => {
				tempDirs.push(dir);
				return path;
			});
		const processId = options.processId ?? extractFirstProcessId(options.source);
		const instanceId = options.instanceId ?? `pi-wendao-${randomUUID()}`;
		const variables = {
			...parseVariablePairs(options.variables),
			...(options.context ?? {}),
		};
		const useRealHost = !options.hostFixturePath
			&& (Boolean(options.model) || Boolean(options.agentHost) || Boolean(options.humanTaskHandler));
		const command = options.qianjiCommand ?? defaultQianjiCommand(cwd);
		if (options.graphView) {
			populateGraphViewFromBpmn(options.source, processId, options.graphView);
			if (options.instanceId) {
				await applyCheckpointGraphSnapshot({
					command,
					sourcePath,
					instanceId,
					dmnPaths: options.dmnPaths ?? [],
					cwd,
					options,
				});
			}
			options.onGraphReady?.();
		}
		const hostFixturePath = useRealHost ? undefined : options.hostFixturePath
			?? await writeDefaultHostFixture(options.source, variables).then((fixture) => {
				if (!fixture) return undefined;
				tempDirs.push(fixture.dir);
				return fixture.path;
			});

		const args = buildQianjiArgs({
			sourcePath,
			processId,
			instanceId,
			context: variables,
			dmnPaths: options.dmnPaths ?? [],
			hostFixturePath,
			eventFixturePath: options.eventFixturePath,
			traceStream: Boolean(options.graphView),
			externalHost: false,
		});
		const traceFrameDelayMs = resolveTraceFrameDelayMs(options);
		const onTraceEvent = async (event: QianjiTraceEvent) => {
			applyQianjiTraceEvents([event], options);
			if (traceFrameDelayMs > 0) await delay(traceFrameDelayMs);
		};
		const cli = useRealHost
			? await runQianjiExternalHostLoop({
				command,
				sourcePath,
				processId,
				instanceId,
				context: variables,
				dmnPaths: options.dmnPaths ?? [],
				eventFixturePath: options.eventFixturePath,
				cwd,
				source: options.source,
				options,
				onTraceEvent,
				tempDirs,
			})
			: await runQianjiCli(command, args, cwd, onTraceEvent);
		const rawOutput = [cli.stdout, cli.stderr].filter(Boolean).join("\n");
		options.onCliOutput?.(rawOutput);
		if (!cli.streamedTrace) {
			applyQianjiTrace(rawOutput, options);
		}

		if (cli.exitCode !== 0) {
			const error = cli.stderr.trim() || cli.stdout.trim() || `qianji exited with code ${cli.exitCode}`;
			return {
				success: false,
				error,
				variables: {},
				output: {},
				rawOutput,
			};
		}

		const parsedVariables = parseQianjiVariables(cli.stdout);
		return {
			success: true,
			variables: { ...variables, ...parsedVariables },
			output: { qianji: cli.stdout },
			rawOutput,
		};
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		options.onError?.(error);
		return {
			success: false,
			error: error.message,
			variables: {},
			output: {},
		};
	} finally {
		for (const tempDir of tempDirs) {
			await rm(tempDir, { recursive: true, force: true });
		}
	}
}

function buildQianjiArgs(options: {
	sourcePath: string;
	processId: string;
	instanceId: string;
	context: Record<string, unknown>;
	dmnPaths: string[];
	hostFixturePath?: string;
	eventFixturePath?: string;
	traceStream: boolean;
	externalHost: boolean;
}): string[] {
	const args = [
		"bpmn",
		"run",
		"--bpmn",
		options.sourcePath,
		"--process",
		options.processId,
		"--instance-id",
		options.instanceId,
		"--context-json",
		JSON.stringify(options.context),
	];
	for (const dmnPath of options.dmnPaths) {
		args.push("--dmn", dmnPath);
	}
	if (options.hostFixturePath) {
		args.push("--host-fixture", options.hostFixturePath);
	}
	if (options.eventFixturePath) {
		args.push("--event-fixture", options.eventFixturePath);
	}
	if (options.traceStream) {
		args.push("--trace-stream");
	}
	if (options.externalHost) {
		args.push("--external-host");
	}
	return args;
}

function buildQianjiTaskCompleteArgs(options: {
	sourcePath: string;
	instanceId: string;
	dmnPaths: string[];
	hostFixturePath: string;
	traceStream: boolean;
	externalHost: boolean;
}): string[] {
	const args = [
		"bpmn",
		"tasks",
		"complete",
		"--bpmn",
		options.sourcePath,
		"--instance-id",
		options.instanceId,
		"--host-fixture",
		options.hostFixturePath,
	];
	for (const dmnPath of options.dmnPaths) {
		args.push("--dmn", dmnPath);
	}
	if (options.traceStream) {
		args.push("--trace-stream");
	}
	if (options.externalHost) {
		args.push("--external-host");
	}
	return args;
}

function buildQianjiStatusArgs(options: {
	sourcePath: string;
	instanceId: string;
	dmnPaths: string[];
}): string[] {
	const args = [
		"bpmn",
		"status",
		"--instance-id",
		options.instanceId,
		"--bpmn",
		options.sourcePath,
	];
	for (const dmnPath of options.dmnPaths) {
		args.push("--dmn", dmnPath);
	}
	return args;
}

async function applyCheckpointGraphSnapshot(options: {
	command: string;
	sourcePath: string;
	instanceId: string;
	dmnPaths: string[];
	cwd: string;
	options: ExecuteOptions;
}): Promise<void> {
	try {
		const cli = await runQianjiCli(
			options.command,
			buildQianjiStatusArgs({
				sourcePath: options.sourcePath,
				instanceId: options.instanceId,
				dmnPaths: options.dmnPaths,
			}),
			options.cwd,
			() => {},
		);
		if (cli.exitCode !== 0) return;
		const snapshot = parseQianjiGraphSnapshot(cli.stdout);
		if (snapshot.length === 0) return;
		let changed = false;
		for (const node of snapshot) {
			const status = toGraphNodeStatus(node.status);
			if (!status) continue;
			options.options.graphView?.setNodeStatus(node.node_id, status);
			changed = true;
		}
		if (changed) options.options.onGraphUpdate?.();
	} catch {
		// Status hydration is opportunistic; execution will report hard qianji errors.
	}
}

async function writeTempBpmnSource(source: string): Promise<{ dir: string; path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "skillsc-qianji-"));
	const path = join(dir, "workflow.bpmn");
	await writeFile(path, source, "utf-8");
	return { dir, path };
}

async function writeDefaultHostFixture(
	source: string,
	context: Record<string, unknown>,
): Promise<{ dir: string; path: string } | undefined> {
	const fixture = buildDefaultHostFixture(source, context);
	if (!fixture) return undefined;

	const dir = await mkdtemp(join(tmpdir(), "skillsc-qianji-host-"));
	const path = join(dir, "host-fixture.json");
	await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf-8");
	return { dir, path };
}

async function runQianjiExternalHostLoop(options: {
	command: string;
	sourcePath: string;
	processId: string;
	instanceId: string;
	context: Record<string, unknown>;
	dmnPaths: string[];
	eventFixturePath?: string;
	cwd: string;
	source: string;
	options: ExecuteOptions;
	onTraceEvent: (event: QianjiTraceEvent) => void | Promise<void>;
	tempDirs: string[];
}): Promise<QianjiCliResult> {
	const skillscConfigs = buildSkillscConfigMap(options.source, options.processId);
	const agentHost = options.options.agentHost ?? (options.options.model
		? createPiAiHost({
			model: options.options.model,
			apiKey: options.options.apiKey,
			cwd: options.cwd,
			extraTools: options.options.agentTools,
			onEvent: options.options.onAgentEvent,
			thinkingLevel: options.options.thinkingLevel,
		})
		: createMissingAgentHost());
	const pendingActivities = new Set<string>();
	const aggregate: QianjiCliResult = { exitCode: 0, stdout: "", stderr: "", streamedTrace: false, hostWork: [] };
	const onTraceEvent = async (event: QianjiTraceEvent) => {
		updatePendingActivities(pendingActivities, event);
		await options.onTraceEvent(event);
	};

	let latest = await runQianjiCli(
		options.command,
		buildQianjiArgs({
			sourcePath: options.sourcePath,
			processId: options.processId,
			instanceId: options.instanceId,
			context: options.context,
			dmnPaths: options.dmnPaths,
			eventFixturePath: options.eventFixturePath,
			traceStream: true,
			externalHost: true,
		}),
		options.cwd,
		onTraceEvent,
	);
	appendCliResult(aggregate, latest);

	let guard = 0;
	while (latest.exitCode === 0 && parseQianjiOutcome(latest.stdout) === "blocked_on_host") {
		guard += 1;
		if (guard > 100) {
			throw new Error("qianji external host loop exceeded 100 host-boundary iterations");
		}
			const checkpoint = parseQianjiCheckpointFeedback(latest.stdout, latest.hostWork.length);
			emitQianjiHostWorkEvents(latest.hostWork, options.options);
			applyQianjiHostWorkGraph({
				hostWork: latest.hostWork,
				skillscConfigs,
				checkpoint,
				hostBackend: resolveHostBackendLabel(options.options),
				options: options.options,
		});
		const hostData = await runPendingHostWork({
			agentHost,
			humanTaskHandler: options.options.humanTaskHandler,
			skillscConfigs,
			pendingHostWork: latest.hostWork,
			pendingActivityIds: Array.from(pendingActivities),
			variables: options.context,
			processId: options.processId,
			instanceId: options.instanceId,
			checkpoint,
		});
		if (!hostData) {
			throw new Error("qianji stopped on host work but did not stream an active BPMN activity");
		}
		const fixture = await writeHostCompletionFixture(hostData);
		options.tempDirs.push(fixture.dir);
		latest = await runQianjiCli(
			options.command,
			buildQianjiTaskCompleteArgs({
				sourcePath: options.sourcePath,
				instanceId: options.instanceId,
				dmnPaths: options.dmnPaths,
				hostFixturePath: fixture.path,
				traceStream: true,
				externalHost: true,
			}),
			options.cwd,
			onTraceEvent,
		);
		const variables = parseQianjiVariables(latest.stdout);
		Object.assign(options.context, variables);
		appendCliResult(aggregate, latest);
	}

	aggregate.exitCode = latest.exitCode;
	return aggregate;
}

interface HostCompletionFixture {
	send_tasks?: Record<string, { data: Record<string, unknown> }>;
	service_tasks?: Record<string, { data: Record<string, unknown> }>;
	service_task_tokens?: Record<string, { data: Record<string, unknown> }>;
	user_tasks?: Record<string, { data: Record<string, unknown> }>;
	manual_tasks?: Record<string, { data: Record<string, unknown> }>;
}

async function runPendingHostWork(options: {
	agentHost: SkillscAgentHost;
	humanTaskHandler?: (request: HumanTaskPromptRequest) => Promise<string>;
	skillscConfigs: Map<string, SkillscConfig>;
	pendingHostWork: QianjiHostWork[];
	pendingActivityIds: string[];
	variables: Record<string, unknown>;
	processId: string;
	instanceId: string;
	checkpoint?: SkillscQianjiCheckpointFeedback;
}): Promise<HostCompletionFixture | undefined> {
	const tokenResults = await Promise.all(options.pendingHostWork.map(async (work) => {
		const tokenVariables = { ...options.variables, ...(work.variables ?? {}) };
		const data = await runSkillscActivity({
			agentHost: options.agentHost,
			humanTaskHandler: options.humanTaskHandler,
			skillscConfigs: options.skillscConfigs,
			activityId: work.node_id,
			hostKind: work.kind,
			variables: tokenVariables,
			execution: {
				processId: options.processId,
				instanceId: options.instanceId,
				nodeIndex: work.node_index,
				tokenId: work.token_id,
				repeat: work.repeat,
				checkpoint: options.checkpoint,
			},
		});
		return { kind: work.kind, nodeId: work.node_id, tokenId: String(work.token_id), data };
	}));
	const fixture: HostCompletionFixture = {};
	for (const result of tokenResults) {
		Object.assign(options.variables, result.data);
		addHostCompletionResult(fixture, result);
	}
	if (hasHostCompletionResults(fixture)) {
		return fixture;
	}

	const activityResults = await Promise.all(options.pendingActivityIds.map(async (activityId) => {
		const activityVariables = { ...options.variables };
		const data = await runSkillscActivity({
			agentHost: options.agentHost,
			humanTaskHandler: options.humanTaskHandler,
			skillscConfigs: options.skillscConfigs,
			activityId,
			variables: activityVariables,
			execution: {
				processId: options.processId,
				instanceId: options.instanceId,
				checkpoint: options.checkpoint,
			},
		});
		return { activityId, data };
	}));
	const service_tasks: Record<string, { data: Record<string, unknown> }> = {};
	for (const result of activityResults) {
		Object.assign(options.variables, result.data);
		service_tasks[result.activityId] = { data: result.data };
	}
	if (Object.keys(service_tasks).length > 0) {
		return { service_tasks };
	}
	return undefined;
}

async function writeHostCompletionFixture(
	fixture: HostCompletionFixture,
): Promise<{ dir: string; path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "skillsc-qianji-host-"));
	const path = join(dir, "host-fixture.json");
	await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf-8");
	return { dir, path };
}

function addHostCompletionResult(
	fixture: HostCompletionFixture,
	result: {
		kind: SkillscHostWorkKind;
		nodeId: string;
		tokenId: string;
		data: Record<string, unknown>;
	},
): void {
	switch (result.kind) {
		case "service":
			fixture.service_task_tokens ??= {};
			fixture.service_task_tokens[result.tokenId] = { data: result.data };
			return;
		case "user":
			fixture.user_tasks ??= {};
			fixture.user_tasks[result.nodeId] = { data: result.data };
			return;
		case "manual":
			fixture.manual_tasks ??= {};
			fixture.manual_tasks[result.nodeId] = { data: result.data };
			return;
		case "send":
			fixture.send_tasks ??= {};
			fixture.send_tasks[result.nodeId] = { data: result.data };
			return;
		case "script":
		case "business_rule":
			fixture.service_task_tokens ??= {};
			fixture.service_task_tokens[result.tokenId] = { data: result.data };
			return;
	}
}

function hasHostCompletionResults(fixture: HostCompletionFixture): boolean {
	return Object.values(fixture).some((bucket) => bucket && Object.keys(bucket).length > 0);
}

async function runSkillscActivity(
	options: {
		agentHost: SkillscAgentHost;
		humanTaskHandler?: (request: HumanTaskPromptRequest) => Promise<string>;
		skillscConfigs: Map<string, SkillscConfig>;
		activityId: string;
		hostKind?: SkillscHostWorkKind;
		variables: Record<string, unknown>;
		execution: SkillscAgentExecutionMetadata;
	},
): Promise<Record<string, unknown>> {
	const config = options.skillscConfigs.get(options.activityId) ?? {
		prompt: "",
		tools: [],
		inputs: [],
		outputs: [],
	};
	if ((options.hostKind ?? config.hostKind) === "user") {
		if (!options.humanTaskHandler) {
			throw new Error(`BPMN userTask '${options.activityId}' requires a human task handler`);
		}
		const reply = await options.humanTaskHandler({
			activityId: options.activityId,
			config,
			variables: options.variables,
			execution: {
				...options.execution,
				activityId: options.activityId,
			},
		});
		const output = mapHumanTaskReplyToOutputs(reply, config.outputs);
		Object.assign(options.variables, output);
		return output;
	}
	const output = await options.agentHost.run({
		activityId: options.activityId,
		config,
		variables: options.variables,
		execution: {
			...options.execution,
			activityId: options.activityId,
		},
	});
	Object.assign(options.variables, output);
	return output;
}

export function mapHumanTaskReplyToOutputs(
	reply: string,
	outputNames: string[],
): Record<string, unknown> {
	if (outputNames.length === 0) return {};
	const trimmed = reply.trim() || "approved";
	const result: Record<string, unknown> = {};
	for (const outputName of outputNames) {
		result[outputName] = isHumanReplyTextOutput(outputName)
			? trimmed
			: isHumanApprovalOutput(outputName) ? parseHumanApprovalReply(trimmed) : trimmed;
	}
	return result;
}

function isHumanReplyTextOutput(outputName: string): boolean {
	const normalized = outputName.toLowerCase();
	return /reply|response|answer|feedback|idea|input|comment|note/.test(normalized);
}

function isHumanApprovalOutput(outputName: string): boolean {
	const normalized = outputName.toLowerCase();
	return normalized === "approved"
		|| normalized === "approval"
		|| normalized === "accepted"
		|| normalized === "confirmed"
		|| normalized === "continue"
		|| normalized === "proceed"
		|| normalized.startsWith("is")
		|| normalized.startsWith("has")
		|| normalized.startsWith("can")
		|| normalized.startsWith("should")
		|| normalized.endsWith("approved")
		|| normalized.endsWith("accepted")
		|| normalized.endsWith("confirmed");
}

function parseHumanApprovalReply(reply: string): boolean {
	const normalized = reply.trim().toLowerCase();
	if (!normalized) return true;
	if (/^(n|no|false|0|reject|rejected|decline|declined|deny|denied|stop|cancel|cancelled)\b/.test(normalized)) {
		return false;
	}
	if (/^(y|yes|true|1|approve|approved|accept|accepted|confirm|confirmed|ok|okay|continue|proceed)\b/.test(normalized)) {
		return true;
	}
	return true;
}

function updatePendingActivities(pendingActivities: Set<string>, event: QianjiTraceEvent): void {
	if (event.kind !== "node_status" || !isActivityTraceNode(event)) return;
	if (event.status === "executing") {
		pendingActivities.add(event.node_id);
		return;
	}
	if (event.status === "completed" || event.status === "cancelled" || event.status === "failed") {
		pendingActivities.delete(event.node_id);
	}
}

function applyQianjiHostWorkGraph(options: {
	hostWork: QianjiHostWork[];
	skillscConfigs: Map<string, SkillscConfig>;
	checkpoint?: SkillscQianjiCheckpointFeedback;
	hostBackend?: string;
	options: ExecuteOptions;
}): void {
	if (!options.options.graphView || options.hostWork.length === 0) return;
	const byNode = new Map<string, QianjiHostWork[]>();
	for (const work of options.hostWork) {
		const group = byNode.get(work.node_id) ?? [];
		group.push(work);
		byNode.set(work.node_id, group);
	}
	for (const [nodeId, work] of byNode) {
		options.options.graphView.setNodeStatus(nodeId, "active");
			options.options.graphView.setNodeDetails(nodeId, buildGraphRuntimeDetails({
				hostWorkCount: work.length,
				hostKinds: [...new Set(work.map((item) => item.kind))],
				config: options.skillscConfigs.get(nodeId),
				checkpoint: options.checkpoint,
				hostBackend: options.hostBackend,
				hostWork: work,
				batchHostWorkCount: options.hostWork.length,
			}));
		}
	options.options.onGraphUpdate?.();
}

function buildGraphRuntimeDetails(options: {
	hostWorkCount: number;
	hostKinds?: SkillscHostWorkKind[];
	config?: SkillscConfig;
	checkpoint?: SkillscQianjiCheckpointFeedback;
	hostBackend?: string;
	hostWork?: QianjiHostWork[];
	batchHostWorkCount?: number;
}): string[] {
	const details: string[] = [];
	const hostKind = options.hostKinds && options.hostKinds.length === 1 && options.hostKinds[0] !== "service"
		? `${options.hostKinds[0]}:`
		: "";
	const host = [
		`host:${hostKind}${options.hostWorkCount}`,
		options.hostBackend,
	].filter(Boolean).join(" ");
	if (host) details.push(host);
	const parallel = buildParallelRuntimeDetail(options.hostWork ?? [], options.batchHostWorkCount ?? 0);
	if (parallel) details.push(parallel);
	const checkpoint = [
		options.checkpoint?.backend,
		options.checkpoint?.source,
		options.checkpoint?.status,
	].filter(Boolean).join("/");
	if (checkpoint) details.push(`checkpoint:${checkpoint}`);
	if (options.config?.subagent?.type) {
		details.push(`subagent:${options.config.subagent.type}`);
	}
	return details;
}

function emitQianjiHostWorkEvents(hostWork: QianjiHostWork[], options: ExecuteOptions): void {
	if (!options.onHostWork || hostWork.length === 0) return;
	for (const event of buildQianjiHostWorkEvents(hostWork)) {
		options.onHostWork(event);
	}
}

function buildQianjiHostWorkEvents(hostWork: QianjiHostWork[]): QianjiHostWorkEvent[] {
	const byNode = new Map<string, QianjiHostWork[]>();
	for (const work of hostWork) {
		const group = byNode.get(work.node_id) ?? [];
		group.push(work);
		byNode.set(work.node_id, group);
	}
	const batchParallel = hostWork.length > 1;
	return [...byNode.entries()].map(([activityId, work]) => {
		const repeatKinds = uniqueStrings(work.map((item) => readRepeatKind(item.repeat)).filter(isNonEmptyString));
		return {
			activityId,
			hostWorkCount: work.length,
			batchHostWorkCount: hostWork.length,
			tokenIds: work.map((item) => item.token_id),
			hostKinds: uniqueHostKinds(work.map((item) => item.kind)),
			parallel: batchParallel || work.some((item) => isParallelRepeat(item.repeat)),
			repeatKinds,
			repeatSummaries: work.map((item) => summarizeRepeat(item.repeat)).filter(isNonEmptyString),
		};
	});
}

function buildParallelRuntimeDetail(hostWork: QianjiHostWork[], batchHostWorkCount: number): string | undefined {
	const parallel = batchHostWorkCount > 1 || hostWork.some((work) => isParallelRepeat(work.repeat));
	if (!parallel) return undefined;
	const tokens = hostWork.map((work) => work.token_id).join(",");
	const batch = batchHostWorkCount > hostWork.length ? `batch=${batchHostWorkCount} ` : "";
	return `parallel:${batch}${hostWork.length} jobs tokens=${tokens}`;
}

function isParallelRepeat(repeat: unknown): boolean {
	const kind = readRepeatKind(repeat);
	return !!kind && /\bparallel\b/i.test(kind);
}

function readRepeatKind(repeat: unknown): string | undefined {
	if (!isObject(repeat)) return undefined;
	return typeof repeat.kind === "string" && repeat.kind.trim() ? repeat.kind.trim() : undefined;
}

function summarizeRepeat(repeat: unknown): string | undefined {
	if (!isObject(repeat)) return undefined;
	const kind = readRepeatKind(repeat);
	const iteration = typeof repeat.iteration_index === "number" ? repeat.iteration_index + 1 : undefined;
	const total = typeof repeat.total_iterations === "number" ? repeat.total_iterations : undefined;
	if (kind && iteration !== undefined && total !== undefined) return `${kind} ${iteration}/${total}`;
	if (kind) return kind;
	if (iteration !== undefined && total !== undefined) return `${iteration}/${total}`;
	return undefined;
}

function uniqueHostKinds(values: SkillscHostWorkKind[]): SkillscHostWorkKind[] {
	return [...new Set(values)];
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}

function isNonEmptyString(value: string | undefined): value is string {
	return typeof value === "string" && value.length > 0;
}

function resolveHostBackendLabel(options: ExecuteOptions): string | undefined {
	if (options.hostBackend) return options.hostBackend;
	if (options.agentHost) return "custom-host";
	if (options.humanTaskHandler && !options.model) return "human";
	if (options.model) return "pi-ai";
	return undefined;
}

function createMissingAgentHost(): SkillscAgentHost {
	return {
		async run(request) {
			throw new Error(`BPMN serviceTask '${request.activityId}' requires a model or agent host`);
		},
	};
}

function appendCliResult(aggregate: QianjiCliResult, result: QianjiCliResult): void {
	if (result.stdout) aggregate.stdout += `${result.stdout}\n`;
	if (result.stderr) aggregate.stderr += `${result.stderr}\n`;
	aggregate.streamedTrace ||= result.streamedTrace;
	aggregate.hostWork.push(...result.hostWork);
	aggregate.exitCode = result.exitCode;
}

function buildDefaultHostFixture(
	source: string,
	context: Record<string, unknown>,
): HostCompletionFixture | undefined {
	const document = parser.parse(source) as { definitions?: { process?: unknown } };
	const tasks = collectSkillscHostTasks(document.definitions?.process)
		.filter((task) => task.hostKind === "service" || task.hostKind === "user" || task.hostKind === "manual");
	if (tasks.length === 0) return undefined;

	const fixture: HostCompletionFixture = {};
	for (const task of tasks) {
		const taskId = typeof task.id === "string" ? task.id.trim() : "";
		if (!taskId) continue;
		const data: Record<string, unknown> = {};
		for (const outputName of extractSkillscOutputs(task)) {
			data[outputName] = Object.prototype.hasOwnProperty.call(context, outputName)
				? context[outputName]
				: defaultFixtureValue(outputName);
		}
		addStaticHostFixtureEntry(fixture, task.hostKind, taskId, data);
	}

	return hasHostCompletionResults(fixture) ? fixture : undefined;
}

function buildSkillscConfigMap(source: string, processId: string): Map<string, SkillscConfig> {
	const document = parser.parse(source) as { definitions?: { process?: unknown } };
	const process = findProcess(document.definitions?.process, processId);
	const configs = new Map<string, SkillscConfig>();
	if (!process) return configs;

	for (const task of collectSkillscHostTasks(process)) {
		const id = readString(task.id);
		if (!id) continue;
		const extensionElements = task.extensionElements;
		if (!isObject(extensionElements)) continue;
		const config = firstObject(extensionElements.config);
		if (!config) continue;
		configs.set(id, {
			hostKind: task.hostKind,
			prompt: readText(config.prompt),
			tools: csv(readText(config.tools)),
			inputs: csv(readText(config.inputs)),
			outputs: csv(readText(config.outputs)),
			subagent: readSkillscSubagentConfig(config),
		});
	}

	return configs;
}

function addStaticHostFixtureEntry(
	fixture: HostCompletionFixture,
	hostKind: SkillscHostWorkKind,
	taskId: string,
	data: Record<string, unknown>,
): void {
	switch (hostKind) {
		case "user":
			fixture.user_tasks ??= {};
			fixture.user_tasks[taskId] = { data };
			return;
		case "manual":
			fixture.manual_tasks ??= {};
			fixture.manual_tasks[taskId] = { data };
			return;
		case "service":
		default:
			fixture.service_tasks ??= {};
			fixture.service_tasks[taskId] = { data };
			return;
	}
}

function readSkillscSubagentConfig(config: Record<string, unknown>): SkillscSubagentConfig | undefined {
	const subagent: SkillscSubagentConfig = {};
	const type = readText(config.agentType).trim();
	const description = readText(config.agentDescription).trim();
	const runInBackground = readOptionalBoolean(config.runInBackground);
	const maxTurns = readOptionalNumber(config.maxTurns);
	const isolated = readOptionalBoolean(config.isolated);
	const inheritContext = readOptionalBoolean(config.inheritContext);
	const model = readText(config.agentModel).trim();
	const thinking = readText(config.thinking).trim();
	const isolation = readText(config.isolation).trim();

	if (type) subagent.type = type;
	if (description) subagent.description = description;
	if (runInBackground !== undefined) subagent.runInBackground = runInBackground;
	if (model) subagent.model = model;
	if (thinking) subagent.thinking = thinking;
	if (maxTurns !== undefined) subagent.maxTurns = maxTurns;
	if (isolated !== undefined) subagent.isolated = isolated;
	if (isolation) subagent.isolation = isolation;
	if (inheritContext !== undefined) subagent.inheritContext = inheritContext;

	return Object.keys(subagent).length > 0 ? subagent : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
	const text = readText(value).trim().toLowerCase();
	if (!text) return undefined;
	if (["true", "1", "yes", "on"].includes(text)) return true;
	if (["false", "0", "no", "off"].includes(text)) return false;
	return undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
	const text = readText(value).trim();
	if (!text) return undefined;
	const parsed = Number(text);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function populateGraphViewFromBpmn(source: string, processId: string, graphView: GraphView): void {
	const document = parser.parse(source) as { definitions?: { process?: unknown } };
	const process = findProcess(document.definitions?.process, processId);
	if (!process) {
		throw new Error(`BPMN source does not declare process ${processId}`);
	}

	graphView.clear();
	for (const spec of GRAPH_NODE_SPECS) {
		for (const element of asArray(process[spec.element])) {
			if (!isObject(element)) continue;
			const id = readString(element.id);
			if (!id) continue;
			graphView.addNode({
				id,
				label: readString(element.name) || id,
				type: spec.type,
				status: "pending",
			});
		}
	}

	for (const flow of asArray(process.sequenceFlow)) {
		if (!isObject(flow)) continue;
		const sourceRef = readString(flow.sourceRef);
		const targetRef = readString(flow.targetRef);
		if (!sourceRef || !targetRef) continue;
		graphView.addEdge({
			source: sourceRef,
			target: targetRef,
			label: readString(flow.name) || undefined,
			taken: false,
		});
	}
}

function defaultFixtureValue(outputName: string): unknown {
	const normalized = outputName.toLowerCase();
	if (normalized === "retrycount") return 3;
	if (normalized === "status") return "ready";
	if (normalized === "resulta") return "alpha";
	if (normalized === "resultb") return "beta";
	if (normalized === "merged") return "alpha beta";
	if (normalized === "reason") return "validation failed";
	if (normalized === "filecount" || normalized.endsWith("count")) return 0;
	if (normalized.endsWith("list") || normalized.endsWith("items")) return [];
	if (normalized.startsWith("is") || normalized.startsWith("has") || normalized.startsWith("can") || normalized.startsWith("should")) {
		return !normalized.includes("rejected") && !normalized.includes("failed");
	}
	if (normalized === "valid" || normalized === "published" || normalized === "ready") return true;
	if (normalized === "rejected" || normalized === "failed") return false;
	return null;
}

type SkillscHostTaskElement = Record<string, unknown> & { hostKind: SkillscHostWorkKind };

const SKILLSC_HOST_TASK_ELEMENTS: Array<{ element: string; hostKind: SkillscHostWorkKind }> = [
	{ element: "serviceTask", hostKind: "service" },
	{ element: "userTask", hostKind: "user" },
	{ element: "manualTask", hostKind: "manual" },
	{ element: "sendTask", hostKind: "send" },
];

function collectSkillscHostTasks(processes: unknown): SkillscHostTaskElement[] {
	const tasks: SkillscHostTaskElement[] = [];
	for (const process of asArray(processes)) {
		if (!isObject(process)) continue;
		for (const spec of SKILLSC_HOST_TASK_ELEMENTS) {
			for (const task of asArray(process[spec.element])) {
				if (isObject(task)) tasks.push({ ...task, hostKind: spec.hostKind });
			}
		}
	}
	return tasks;
}

function extractSkillscOutputs(task: Record<string, unknown>): string[] {
	const extensionElements = task.extensionElements;
	if (!isObject(extensionElements)) return [];
	const config = firstObject(extensionElements.config);
	if (!config) return [];
	return csv(readText(config.outputs));
}

function extractFirstProcessId(source: string): string {
	const document = parser.parse(source) as { definitions?: { process?: unknown } };
	const processes = asArray(document.definitions?.process);
	for (const process of processes) {
		if (isObject(process) && typeof process.id === "string" && process.id.trim()) {
			return process.id;
		}
	}
	throw new Error("BPMN source does not declare a process id; pass --process explicitly");
}

function findProcess(processes: unknown, processId: string): Record<string, unknown> | undefined {
	for (const process of asArray(processes)) {
		if (isObject(process) && readString(process.id) === processId) {
			return process;
		}
	}
	return undefined;
}

function parseVariablePairs(pairs: string[] | undefined): Record<string, unknown> {
	const variables: Record<string, unknown> = {};
	for (const pair of pairs ?? []) {
		const idx = pair.indexOf("=");
		if (idx === -1) continue;
		variables[pair.slice(0, idx)] = pair.slice(idx + 1);
	}
	return variables;
}

function csv(value: string): string[] {
	if (!value.trim()) return [];
	return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function firstObject(value: unknown): Record<string, unknown> | undefined {
	const first = asArray(value).find(isObject);
	return first;
}

function readText(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (isObject(value) && typeof value["#text"] === "string") return value["#text"];
	return "";
}

function readString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function parseQianjiVariables(output: string): Record<string, unknown> {
	const variablesSection = output.lastIndexOf("## Variables");
	if (variablesSection === -1) return {};
	const match = output
		.slice(variablesSection)
		.match(/```json\s*([\s\S]*?)\s*```/);
	if (!match) return {};
	const parsed = JSON.parse(match[1]) as unknown;
	if (!isObject(parsed)) {
		throw new Error("qianji variables block did not contain a JSON object");
	}
	return parsed;
}

function applyQianjiTrace(output: string, options: ExecuteOptions): void {
	const trace = parseQianjiTrace(output);
	if (trace.length === 0) return;
	applyQianjiTraceEvents(trace, options);
}

function applyQianjiTraceEvents(trace: QianjiTraceEvent[], options: ExecuteOptions): void {
	for (const event of trace) {
		options.onTraceEvent?.(event);
		if (event.kind === "flow_take") {
			if (event.source_id && event.target_id) {
				options.graphView?.setEdgeTaken(event.source_id, event.target_id);
				options.onFlowTake?.(`${event.source_id}->${event.target_id}`);
			}
			options.onGraphUpdate?.();
			continue;
		}

		const status = toGraphNodeStatus(event.status);
		if (status) {
			options.graphView?.setNodeStatus(event.node_id, status);
		}
		if (event.status === "executing" && isActivityTraceNode(event)) {
			options.onActivityStart?.(event.node_id, event.node_id);
		}
		if ((event.status === "completed" || event.status === "cancelled" || event.status === "failed")
			&& isActivityTraceNode(event)) {
			options.onActivityEnd?.(event.node_id, event.node_id);
		}
		options.onGraphUpdate?.();
	}
}

function parseQianjiTrace(output: string): QianjiTraceEvent[] {
	const traceSection = output.lastIndexOf("## Trace");
	if (traceSection === -1) return [];
	const match = output
		.slice(traceSection)
		.match(/```json\s*([\s\S]*?)\s*```/);
	if (!match) return [];
	const parsed = JSON.parse(match[1]) as unknown;
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(isQianjiTraceEvent);
}

function parseQianjiGraphSnapshot(output: string): QianjiGraphSnapshotNode[] {
	const snapshotSection = output.lastIndexOf("## Graph Snapshot");
	if (snapshotSection === -1) return [];
	const match = output
		.slice(snapshotSection)
		.match(/```json\s*([\s\S]*?)\s*```/);
	if (!match) return [];
	const parsed = JSON.parse(match[1]) as unknown;
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(isQianjiGraphSnapshotNode);
}

function parseQianjiOutcome(output: string): string | undefined {
	const match = output.match(/^Outcome:\s*([a-z_]+)/m);
	return match?.[1];
}

function parseQianjiCheckpointFeedback(
	output: string,
	hostWorkCount = 0,
): SkillscQianjiCheckpointFeedback | undefined {
	const feedback: SkillscQianjiCheckpointFeedback = {
		...(extractQianjiReportField(output, "Outcome") ? { outcome: extractQianjiReportField(output, "Outcome") } : {}),
		...(extractQianjiReportField(output, "Checkpoint backend") ? { backend: extractQianjiReportField(output, "Checkpoint backend") } : {}),
		...(extractQianjiReportField(output, "Checkpoint source") ? { source: extractQianjiReportField(output, "Checkpoint source") } : {}),
		...(extractQianjiReportField(output, "Checkpoint saved") ? { saved: extractQianjiReportField(output, "Checkpoint saved") } : {}),
		...(extractQianjiReportField(output, "Checkpoint deleted") ? { deleted: extractQianjiReportField(output, "Checkpoint deleted") } : {}),
		...(extractQianjiReportField(output, "Checkpoint status") ? { status: extractQianjiReportField(output, "Checkpoint status") } : {}),
		...(extractQianjiReportField(output, "Pending host work") ? { pendingHostWork: extractQianjiReportField(output, "Pending host work") } : {}),
	};
	if (!feedback.pendingHostWork && hostWorkCount > 0) {
		feedback.pendingHostWork = String(hostWorkCount);
	}
	return Object.keys(feedback).length > 0 ? feedback : undefined;
}

function extractQianjiReportField(output: string, label: string): string | undefined {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = output.match(new RegExp(`^${escaped}:\\s*(.+)$`, "m"));
	return match?.[1]?.trim();
}

function isQianjiTraceEvent(value: unknown): value is QianjiTraceEvent {
	if (!isObject(value) || typeof value.kind !== "string") return false;
	if (value.kind === "node_status") {
		return typeof value.node_id === "string"
			&& typeof value.status === "string"
			&& (value.node_kind === undefined
				|| value.node_kind === null
				|| typeof value.node_kind === "string");
	}
	if (value.kind === "flow_take") {
		return typeof value.source_id === "string" && typeof value.target_id === "string";
	}
	return false;
}

function isQianjiGraphSnapshotNode(value: unknown): value is QianjiGraphSnapshotNode {
	if (!isObject(value)) return false;
	if (typeof value.node_id !== "string" || !value.node_id.trim()) return false;
	if (typeof value.status !== "string") return false;
	if (value.node_kind !== undefined && value.node_kind !== null && typeof value.node_kind !== "string") {
		return false;
	}
	if (value.node_index !== undefined && typeof value.node_index !== "number") return false;
	return true;
}

function isActivityTraceNode(event: QianjiTraceNodeStatusEvent): boolean {
	if (!event.node_kind) return true;
	return ACTIVITY_TRACE_NODE_KINDS.has(event.node_kind);
}

function toGraphNodeStatus(status: string): NodeStatus | undefined {
	switch (status) {
		case "idle":
			return "pending";
		case "queued":
		case "executing":
			return "active";
		case "completed":
			return "done";
		case "cancelled":
		case "failed":
			return "error";
		default:
			return undefined;
	}
}

const ACTIVITY_TRACE_NODE_KINDS = new Set([
	"business_rule_task",
	"manual_task",
	"receive_task",
	"script_task",
	"send_task",
	"service_task",
	"sub_process",
	"user_task",
]);

function runQianjiCli(
	command: string,
	args: string[],
	cwd: string,
	onTraceEvent: (event: QianjiTraceEvent) => void | Promise<void>,
): Promise<QianjiCliResult> {
	const commandLine = [command, ...args.map(shellQuote)].join(" ");
	return new Promise((resolvePromise, reject) => {
		const child = spawn(commandLine, {
			cwd,
			shell: true,
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		let stdoutLineBuffer = "";
		let streamedTrace = false;
		const hostWork: QianjiHostWork[] = [];
		let traceQueue = Promise.resolve();
		let traceError: unknown;
		const enqueueTraceEvent = (event: QianjiTraceEvent): void => {
			traceQueue = traceQueue.then(async () => {
				if (traceError) return;
				await onTraceEvent(event);
			}).catch((err: unknown) => {
				traceError = err;
			});
		};

		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			const consumed = consumeQianjiStdoutChunk(stdoutLineBuffer + chunk, enqueueTraceEvent);
			stdout += consumed.visibleOutput;
			stdoutLineBuffer = consumed.remainder;
			streamedTrace ||= consumed.streamedTrace;
			hostWork.push(...consumed.hostWork);
		});
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", async (exitCode) => {
			try {
				if (stdoutLineBuffer) {
					const consumed = consumeQianjiStdoutChunk(`${stdoutLineBuffer}\n`, enqueueTraceEvent);
					stdout += consumed.visibleOutput.replace(/\n$/, "");
					streamedTrace ||= consumed.streamedTrace;
					hostWork.push(...consumed.hostWork);
				}
				await traceQueue;
				if (traceError) {
					reject(traceError);
					return;
				}
				resolvePromise({ exitCode, stdout, stderr, streamedTrace, hostWork });
			} catch (err) {
				reject(err);
			}
		});
	});
}

function consumeQianjiStdoutChunk(
	chunk: string,
	onTraceEvent: (event: QianjiTraceEvent) => void,
): { visibleOutput: string; remainder: string; streamedTrace: boolean; hostWork: QianjiHostWork[] } {
	const lines = chunk.split("\n");
	const remainder = lines.pop() ?? "";
	let visibleOutput = "";
	let streamedTrace = false;
	const hostWork: QianjiHostWork[] = [];
	for (const line of lines) {
		const traceEvent = parseQianjiTraceStreamLine(line);
		if (traceEvent) {
			onTraceEvent(traceEvent);
			streamedTrace = true;
			continue;
		}
		const work = parseQianjiHostWorkStreamLine(line);
		if (work) {
			hostWork.push(work);
			continue;
		}
		visibleOutput += `${line}\n`;
	}
	return { visibleOutput, remainder, streamedTrace, hostWork };
}

function parseQianjiTraceStreamLine(line: string): QianjiTraceEvent | undefined {
	const prefix = "@@QIANJI_TRACE ";
	if (!line.startsWith(prefix)) return undefined;
	try {
		const parsed = JSON.parse(line.slice(prefix.length)) as unknown;
		return isQianjiTraceEvent(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function parseQianjiHostWorkStreamLine(line: string): QianjiHostWork | undefined {
	const prefix = "@@QIANJI_HOST_WORK ";
	if (!line.startsWith(prefix)) return undefined;
	try {
		const parsed = JSON.parse(line.slice(prefix.length)) as unknown;
		return isQianjiHostWork(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function isQianjiHostWork(value: unknown): value is QianjiHostWork {
	if (!isObject(value)) return false;
	if (!isSkillscHostWorkKind(value.kind)) return false;
	if (typeof value.node_id !== "string" || !value.node_id.trim()) return false;
	if (typeof value.token_id !== "number" || !Number.isFinite(value.token_id)) return false;
	if (value.node_index !== undefined && typeof value.node_index !== "number") return false;
	if (value.variables !== undefined && !isObject(value.variables)) return false;
	return true;
}

function isSkillscHostWorkKind(value: unknown): value is SkillscHostWorkKind {
	return typeof value === "string" && SKILLSC_HOST_WORK_KINDS.has(value as SkillscHostWorkKind);
}

const SKILLSC_HOST_WORK_KINDS = new Set<SkillscHostWorkKind>([
	"send",
	"service",
	"script",
	"user",
	"manual",
	"business_rule",
]);

function defaultQianjiCommand(cwd: string): string {
	const envCommand = process.env.QIANJI_CLI?.trim();
	if (envCommand) return envCommand;

	return "qianji";
}

function resolveTraceFrameDelayMs(options: ExecuteOptions): number {
	if (!options.graphView) return 0;
	if (typeof options.traceFrameDelayMs === "number") {
		return Math.max(0, options.traceFrameDelayMs);
	}
	const envValue = process.env.PI_WENDAO_TRACE_FRAME_MS?.trim();
	if (envValue) {
		const parsed = Number(envValue);
		if (Number.isFinite(parsed)) return Math.max(0, parsed);
	}
	return DEFAULT_GRAPH_TRACE_FRAME_DELAY_MS;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
