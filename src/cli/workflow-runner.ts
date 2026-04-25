import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { PiWendaoThinkingLevel } from "../executor/agent-runtime-types.js";
import { execute } from "../executor/executor.js";
import {
	formatPiSubagentsHostEventForLog,
	formatPiSubagentsHostToolEventForGraphDetail,
	formatPiSubagentsHostToolEventForLog,
	formatPiSubagentsToolUpdateForGraphDetail,
	formatPiSubagentsToolUpdateForLog,
	formatQianjiCliOutputForLog,
	formatQianjiHostWorkEventForLog,
	type Renderer,
} from "../output/renderer.js";
import type { ResolvedModel } from "./model-resolver.js";
import {
	createCliPiIntercomAgentTool,
	hasLoadedPiIntercomTool,
	installGlobalPiIntercomBridge,
	type PiWendaoGraphIntercomEvent,
} from "./pi-intercom.js";
import { createCliPiSubagentsHost } from "./pi-subagents.js";

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "",
	removeNSPrefix: true,
});
const BPMN_NODE_ELEMENTS = [
	"startEvent",
	"endEvent",
	"serviceTask",
	"task",
	"userTask",
	"scriptTask",
	"businessRuleTask",
	"sendTask",
	"receiveTask",
	"manualTask",
	"callActivity",
	"subProcess",
	"exclusiveGateway",
	"parallelGateway",
	"inclusiveGateway",
	"eventBasedGateway",
	"complexGateway",
	"boundaryEvent",
	"intermediateCatchEvent",
	"intermediateThrowEvent",
];

export interface PiWendaoWorkflowOptions {
	process?: string;
	instanceId?: string;
	qianji?: string;
	contextJson?: string;
	traceFrameMs?: number;
	var?: string[];
}

export interface RunWorkflowInRendererParams {
	renderer: Renderer;
	useGraph: boolean;
	resolvedWorkflowPath: string;
	options: PiWendaoWorkflowOptions;
	instanceId?: string;
	invocationCwd: string;
	piContextCwd: string;
	resolvedDmnPaths: string[];
	resolvedHostFixturePath?: string;
	resolvedEventFixturePath?: string;
	resolvedModel?: ResolvedModel;
	thinkingLevel: PiWendaoThinkingLevel;
	agentSession?: AgentSession;
}

export async function runWorkflowInRenderer(
	params: RunWorkflowInRendererParams,
): Promise<{ success: boolean }> {
	const source = readFileSync(params.resolvedWorkflowPath, "utf-8");
	const renderer = params.renderer;
	const appendSubagentUpdate = createSubagentUpdateAppender((line) => renderer.appendLog(line));
	installGlobalPiIntercomBridge(params.resolvedModel
		? {
			requestPlannerReply: async (request, signal) => {
				if (params.useGraph && request.context?.activityId) {
					updateSubagentGraphDetail(renderer.graphView, request.context.activityId, "intercom:awaiting planner");
					renderer.refresh();
				}
				const answer = await renderer.requestPlannerReply(request, signal);
				if (params.useGraph && request.context?.activityId) {
					updateSubagentGraphDetail(renderer.graphView, request.context.activityId, "intercom:planner replied");
					renderer.refresh();
				}
				return answer;
			},
			onEvent: (event) => {
				for (const line of formatGraphIntercomEventForLog(event)) {
					renderer.appendLog(line);
				}
			},
		}
		: undefined);

	try {
		const piSubagentsHost = params.resolvedModel
			? createCliPiSubagentsHost({
				loadResult: params.resolvedModel.loadResult,
				modelRegistry: params.resolvedModel.modelRegistry,
				model: params.resolvedModel.model,
				session: params.agentSession,
				cwd: params.piContextCwd,
				onUpdate: (event) => {
					const detail = formatPiSubagentsToolUpdateForGraphDetail(event.update);
					if (detail && params.useGraph) {
						updateSubagentGraphDetail(renderer.graphView, event.activityId, detail);
						renderer.refresh();
					}
					for (const line of formatPiSubagentsToolUpdateForLog(event.update, { activityId: event.activityId })) {
						appendSubagentUpdate(line);
					}
				},
				onEvent: (event) => {
					for (const line of formatPiSubagentsHostEventForLog(event)) {
						renderer.appendLog(line);
					}
				},
				onToolEvent: (event) => {
					const detail = formatPiSubagentsHostToolEventForGraphDetail(event);
					if (detail && params.useGraph) {
						updateSubagentGraphDetail(renderer.graphView, event.activityId, detail);
						renderer.refresh();
					}
					for (const line of formatPiSubagentsHostToolEventForLog(event)) {
						renderer.appendLog(line);
					}
				},
			})
			: undefined;
		if (piSubagentsHost) {
			renderer.appendLog("Host backend: pi-subagents");
		}

		const piIntercomAvailable = params.resolvedModel ? hasLoadedPiIntercomTool(params.resolvedModel.loadResult) : false;
		const piIntercomTool = params.resolvedModel && !piSubagentsHost
			? createCliPiIntercomAgentTool({
				loadResult: params.resolvedModel.loadResult,
				modelRegistry: params.resolvedModel.modelRegistry,
				model: params.resolvedModel.model,
				cwd: params.piContextCwd,
			})
			: undefined;
		if (piIntercomTool) {
			renderer.appendLog("Agent tool: pi-intercom");
		} else if (piIntercomAvailable && piSubagentsHost) {
			renderer.appendLog("Extension tool: pi-intercom");
		}

		const result = await execute({
			source,
			sourcePath: params.resolvedWorkflowPath,
			processId: params.options.process,
			instanceId: params.instanceId,
			qianjiCommand: params.options.qianji,
			dmnPaths: params.resolvedDmnPaths,
			hostFixturePath: params.resolvedHostFixturePath,
			eventFixturePath: params.resolvedEventFixturePath,
			context: parseContextJson(params.options.contextJson),
			model: piSubagentsHost ? undefined : params.resolvedModel?.model,
			apiKey: piSubagentsHost ? undefined : params.resolvedModel?.apiKey,
			thinkingLevel: params.thinkingLevel,
			agentHost: piSubagentsHost,
			humanTaskHandler: async (request) => {
				if (params.useGraph) {
					updateSubagentGraphDetail(renderer.graphView, request.activityId, "user:awaiting input");
					renderer.refresh();
				}
				renderer.appendLog(`human task ${request.activityId}`);
				const answer = await renderer.requestPlannerReply({
					toolCallId: `human:${request.execution?.tokenId ?? request.activityId}:${Date.now()}`,
					action: "human_task",
					to: "user",
					message: request.config.prompt || `Provide input for ${request.activityId}.`,
					context: {
						activityId: request.activityId,
						description: "BPMN user task",
					},
				});
				if (params.useGraph) {
					updateSubagentGraphDetail(renderer.graphView, request.activityId, "user:answered");
					renderer.refresh();
				}
				return answer;
			},
			hostBackend: piSubagentsHost ? "pi-subagents" : params.resolvedModel ? "pi-ai" : undefined,
			agentTools: piIntercomTool ? [piIntercomTool] : undefined,
			traceFrameDelayMs: params.options.traceFrameMs,
			cwd: params.invocationCwd,
			variables: params.options.var,
			onCliOutput: (output) => {
				for (const line of formatQianjiCliOutputForLog(output)) {
					renderer.appendLog(line);
				}
			},
			onHostWork: (event) => {
				for (const line of formatQianjiHostWorkEventForLog(event)) {
					renderer.appendLog(line);
				}
			},
			onAgentEvent: renderer.onAgentEvent,
			graphView: params.useGraph ? renderer.graphView : undefined,
			onGraphReady: () => renderer.refresh(),
			onGraphUpdate: () => renderer.refresh(),
			onTraceEvent: renderer.onTraceEvent,
			onFlowTake: renderer.onFlowTake,
			onError: renderer.onError,
		});

		if (!result.success) {
			renderer.appendLog(`\nExecution failed: ${result.error}`);
		} else {
			renderer.appendLog("\nWorkflow completed successfully.");
			renderer.printVariables(result.variables);
		}
		return { success: result.success };
	} finally {
		installGlobalPiIntercomBridge(undefined);
	}
}

export function resolveQianjiCommand(explicitCommand: string | undefined): string {
	return explicitCommand ?? process.env.QIANJI_CLI ?? "qianji";
}

export function runQianjiShow(options: {
	command: string;
	instanceId?: string;
	workflowPath?: string;
	dmnPaths: string[];
	cwd: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const args = options.instanceId
		? ["bpmn", "status", "--instance-id", options.instanceId]
		: ["bpmn", "instances"];
	if (options.instanceId) {
		if (options.workflowPath) {
			args.push("--bpmn", options.workflowPath);
		}
		for (const dmnPath of options.dmnPaths) {
			args.push("--dmn", dmnPath);
		}
	}
	const commandLine = [options.command, ...args.map(shellQuote)].join(" ");
	return new Promise((resolvePromise, reject) => {
		const child = spawn(commandLine, {
			cwd: options.cwd,
			shell: true,
			env: process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (exitCode) => {
			resolvePromise({ exitCode, stdout, stderr });
		});
	});
}

export function appendActiveBpmnNodeLabels(output: string, source: string, processId?: string): string {
	const graphSnapshotIndex = output.indexOf("## Graph Snapshot");
	const statusHeader = graphSnapshotIndex === -1 ? output : output.slice(0, graphSnapshotIndex);
	const activeNodeIds = Array.from(statusHeader.matchAll(/\bnode_id=([A-Za-z][A-Za-z0-9_.:-]*)/g))
		.map((match) => match[1])
		.filter((nodeId, index, nodeIds) => nodeIds.indexOf(nodeId) === index);
	if (activeNodeIds.length === 0) return output;

	const labels = buildBpmnNodeLabelMap(source, processId);
	const lines = activeNodeIds.map((nodeId) => {
		const label = labels.get(nodeId);
		return label && label !== nodeId ? `- ${nodeId} | ${label}` : `- ${nodeId}`;
	});
	return `${output.trimEnd()}\n\n## Active BPMN Nodes\n${lines.join("\n")}\n`;
}

function formatGraphIntercomEventForLog(event: PiWendaoGraphIntercomEvent): string[] {
	if (event.type === "intercom_call") return [];
	const target = event.to ? ` -> ${event.to}` : "";
	const message = event.message?.trim();
	switch (event.type) {
		case "intercom_send":
			return [`intercom send${target}`, ...(message ? [`  message: ${compactLogLine(message)}`] : [])];
		case "intercom_reply":
			return [`intercom reply${target}`, ...(message ? [`  message: ${compactLogLine(message)}`] : [])];
		case "intercom_answer":
			return [`intercom answered${target}`, ...(message ? [`  message: ${compactLogLine(message)}`] : [])];
		default:
			return [];
	}
}

function compactLogLine(text: string): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= 160) return compact;
	return `${compact.slice(0, 157)}...`;
}

function parseContextJson(value: string | undefined): Record<string, unknown> | undefined {
	if (!value) return undefined;
	const parsed = JSON.parse(value) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("--context-json must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function createSubagentUpdateAppender(append: (line: string) => void): (line: string) => void {
	let lastLine = "";
	let lastAt = 0;
	return (line: string) => {
		const now = Date.now();
		if (line === lastLine && now - lastAt < 5_000) return;
		if (line !== lastLine && now - lastAt < 500) return;
		lastLine = line;
		lastAt = now;
		append(line);
	};
}

function updateSubagentGraphDetail(
	graphView: Renderer["graphView"],
	activityId: string,
	detail: string,
): void {
	const details = graphView.getNodeDetails(activityId);
	if (detail.startsWith("llm:") && details.some((line) => line.startsWith("tool:"))) return;
	graphView.setNodeDetails(activityId, [
		detail,
		...details.filter((line) => !line.startsWith("llm:") && !line.startsWith("tool:")),
	]);
}

function buildBpmnNodeLabelMap(source: string, processId?: string): Map<string, string> {
	const document = parser.parse(source) as { definitions?: { process?: unknown } };
	const process = findProcess(document.definitions?.process, processId);
	const labels = new Map<string, string>();
	if (!process) return labels;
	for (const elementName of BPMN_NODE_ELEMENTS) {
		for (const node of asArray(process[elementName])) {
			if (!isObject(node)) continue;
			const id = readString(node.id);
			if (!id) continue;
			labels.set(id, readString(node.name) || id);
		}
	}
	return labels;
}

function findProcess(processes: unknown, processId?: string): Record<string, unknown> | undefined {
	for (const process of asArray(processes)) {
		if (!isObject(process)) continue;
		const id = readString(process.id);
		if (!id) continue;
		if (!processId || id === processId) return process;
	}
	return undefined;
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function asArray<T>(value: T | T[] | undefined): T[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
