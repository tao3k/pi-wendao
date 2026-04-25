#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "fs";
import { extname, resolve as resolvePath } from "node:path";
import { program } from "commander";
import { XMLParser } from "fast-xml-parser";
import type { PiWendaoThinkingLevel } from "../executor/agent-runtime-types.js";
import { validateInstanceId } from "./instance-id.js";
import { compileSkill } from "../compiler/compiler.js";
import { execute } from "../executor/executor.js";
import {
	createRenderer,
	formatPiSubagentsHostEventForLog,
	formatPiSubagentsHostToolEventForGraphDetail,
	formatPiSubagentsHostToolEventForLog,
	formatPiSubagentsToolUpdateForGraphDetail,
	formatPiSubagentsToolUpdateForLog,
	formatQianjiCliOutputForLog,
	formatQianjiHostWorkEventForLog,
	type Renderer,
} from "../output/renderer.js";
import { resolveModel, resolvePiWendaoPackageRoot, type ResolvedModel } from "./model-resolver.js";
import {
	createCliPiIntercomAgentTool,
	hasLoadedPiIntercomTool,
	installGlobalPiIntercomBridge,
	type PiWendaoGraphIntercomEvent,
} from "./pi-intercom.js";
import { createCliPiSubagentsHost } from "./pi-subagents.js";
import { launchPiWendaoChatTui } from "./pi-wendao-chat-tui.js";

const DEFAULT_EXECUTION_MODEL = "anthropic/claude-sonnet-4-20250514";
const DEFAULT_THINKING_LEVEL: PiWendaoThinkingLevel = "medium";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
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

interface PiWendaoCliOptions {
	process?: string;
	instanceId?: string;
	qianji?: string;
	dmn?: string[];
	hostFixture?: string;
	eventFixture?: string;
	contextJson?: string;
	traceFrameMs?: number;
	model?: string;
	provider?: string;
	apiKey?: string;
	thinking?: string;
	extension?: string[];
	var?: string[];
	show?: boolean;
	graph?: boolean;
	tui?: boolean;
}

interface PiWendaoCompileOptions {
	output?: string;
	model?: string;
	provider?: string;
	apiKey?: string;
	qianji?: string;
	lintRetries?: string;
	lint?: boolean;
	extension?: string[];
}

program
	.command("compile")
	.description("Compile an agent skill into a qianji BPMN workflow")
	.argument("<skill>", "Path to SKILL.md file")
	.option("-o, --output <file>", "Output BPMN file path")
	.option("--model <model>", "Model to use (e.g., anthropic/<model-id>)")
	.option("--provider <provider>", "LLM provider")
	.option("--api-key <key>", "API key override for model resolution")
	.option("--qianji <command>", "Qianji CLI command for templates and compile lint (default: QIANJI_CLI or qianji on PATH)")
	.option("--lint-retries <count>", "Model repair attempts after qianji lint failure", "2")
	.option("--no-lint", "Disable qianji lint repair loop")
	.option("-e, --extension <path>", "Load an extra pi extension (repeatable)", collect, [])
	.action(async (skillPath: string, options: PiWendaoCompileOptions) => {
		try {
			await runCompileCommand(skillPath, options);
			process.exit(0);
		} catch (err) {
			console.error("Error:", err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
	});

program
	.name("pi-wendao")
	.description("Execute a compiled BPMN workflow through the qianji CLI")
	.argument("[workflow]", "Path to .bpmn workflow file")
	.option("--process <id>", "BPMN process id (default: first process in the file)")
	.option("--instance-id <id>", "Qianji workflow instance id")
	.option("--qianji <command>", "Qianji CLI command (default: QIANJI_CLI or qianji on PATH)")
	.option("--dmn <path>", "Pass a DMN source to qianji (repeatable)", collect, [])
	.option("--host-fixture <path>", "Qianji host fixture JSON")
	.option("--event-fixture <path>", "Qianji event fixture JSON")
	.option("--context-json <json>", "Raw JSON context merged after --var pairs")
	.option("--trace-frame-ms <ms>", "Delay between streamed graph trace frames", parseNonNegativeNumber)
	.option("--model <model>", "Model for real host execution")
	.option("--provider <provider>", "Provider for model resolution")
	.option("--api-key <key>", "API key override for model resolution")
	.option("--thinking <level>", "LLM thinking level for real host execution: off, minimal, low, medium, high, xhigh")
	.option("-e, --extension <path>", "Load an extra pi extension; built-in pi-subagents is loaded from package dependencies", collect, [])
	.option("--var <pairs...>", "Variables as key=value pairs")
	.option("--show", "Show qianji BPMN instances, or status for --instance-id, without executing")
	.option("--tui", "Enable interactive graph TUI visualization (default); without workflow, open LLM chat")
	.option("--no-tui", "Disable interactive graph TUI visualization")
	.option("--no-graph", "Disable graph visualization (legacy alias for --no-tui)")
	.action(async (workflowPath: string | undefined, options: PiWendaoCliOptions) => {
		try {
			const invocationCwd = process.cwd();
			const piContextCwd = resolvePiWendaoPackageRoot();
			const resolvedDmnPaths = resolveCliPaths(invocationCwd, options.dmn ?? []);
			const resolvedExtensionPaths = resolveCliPaths(invocationCwd, options.extension ?? []);
			const resolvedHostFixturePath = resolveOptionalCliPath(invocationCwd, options.hostFixture);
			const resolvedEventFixturePath = resolveOptionalCliPath(invocationCwd, options.eventFixture);
			const instanceId = validateInstanceId(options.instanceId);
			const thinkingLevel = resolveExecutionThinkingLevel(options.thinking);
			if (!workflowPath && options.show !== true && options.tui === true && process.stdin.isTTY) {
				const originalCwd = process.cwd();
				process.chdir(piContextCwd);
				try {
					const chatModel = await resolveModel(
						resolveExecutionModelPattern(options.model),
						options.provider,
						options.apiKey,
						resolvedExtensionPaths,
					);
					await launchPiWendaoChatTui({
						resolvedModel: chatModel,
						thinkingLevel,
						invocationCwd,
						showInstances: () => runQianjiShow({
							command: resolveQianjiCommand(options.qianji),
							dmnPaths: [],
							cwd: invocationCwd,
						}),
						showInstanceStatus: (statusInstanceId, statusWorkflowPath) => runQianjiShow({
							command: resolveQianjiCommand(options.qianji),
							instanceId: statusInstanceId,
							workflowPath: statusWorkflowPath,
							dmnPaths: resolvedDmnPaths,
							cwd: invocationCwd,
						}),
						runWorkflow: async (selectedWorkflowPath, renderer) => runWorkflowInRenderer({
							renderer,
							useGraph: true,
							resolvedWorkflowPath: resolveCliPath(invocationCwd, selectedWorkflowPath),
							options,
							instanceId,
							invocationCwd,
							piContextCwd,
							resolvedDmnPaths,
							resolvedHostFixturePath,
							resolvedEventFixturePath,
							resolvedModel: options.hostFixture ? undefined : chatModel,
							thinkingLevel,
						}),
					});
				} finally {
					process.chdir(originalCwd);
				}
				process.exit(0);
			}
			const workflowResolution = await resolveWorkflowArgument(workflowPath, options, {
				invocationCwd,
				piContextCwd,
				resolvedDmnPaths,
				resolvedExtensionPaths,
				thinkingLevel,
			});
			if (workflowResolution.kind === "exit") process.exit(0);
			const resolvedWorkflowPath = resolveOptionalCliPath(invocationCwd, workflowResolution.workflowPath);
			if (options.show) {
				const output = await runQianjiShow({
					command: resolveQianjiCommand(options.qianji),
					instanceId,
					workflowPath: resolvedWorkflowPath,
					dmnPaths: resolvedDmnPaths,
					cwd: invocationCwd,
				});
				const stdout = output.exitCode === 0 && instanceId && resolvedWorkflowPath
					? appendActiveBpmnNodeLabels(output.stdout, readFileSync(resolvedWorkflowPath, "utf-8"), options.process)
					: output.stdout;
				if (stdout.trim()) console.log(stdout.trimEnd());
				if (output.stderr.trim()) console.error(output.stderr.trimEnd());
				process.exitCode = output.exitCode ?? 1;
				return;
			}
			if (!resolvedWorkflowPath) {
				program.error("missing required argument 'workflow' (or run `pi-wendao --tui` from an interactive terminal for chat)");
			}

			process.chdir(piContextCwd);
			const source = readFileSync(resolvedWorkflowPath, "utf-8");
			const useGraph = options.graph !== false && options.tui !== false;
			const renderer = createRenderer(useGraph);
			const resolvedModel = options.hostFixture
				? undefined
				: await resolveModel(
					resolveExecutionModelPattern(options.model),
					options.provider,
					options.apiKey,
					resolvedExtensionPaths,
				);

			console.log(`Executing ${resolvedWorkflowPath} with qianji CLI...`);

			renderer.start();
			const appendSubagentUpdate = createSubagentUpdateAppender((line) => renderer.appendLog(line));
			installGlobalPiIntercomBridge(resolvedModel
				? {
					requestPlannerReply: async (request, signal) => {
						if (useGraph && request.context?.activityId) {
							updateSubagentGraphDetail(renderer.graphView, request.context.activityId, "intercom:awaiting planner");
							renderer.refresh();
						}
						const answer = await renderer.requestPlannerReply(request, signal);
						if (useGraph && request.context?.activityId) {
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
			const piSubagentsHost = resolvedModel
				? createCliPiSubagentsHost({
					loadResult: resolvedModel.loadResult,
					modelRegistry: resolvedModel.modelRegistry,
					model: resolvedModel.model,
					cwd: piContextCwd,
					onUpdate: (event) => {
						const detail = formatPiSubagentsToolUpdateForGraphDetail(event.update);
						if (detail && useGraph) {
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
						if (detail && useGraph) {
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
			const piIntercomAvailable = resolvedModel ? hasLoadedPiIntercomTool(resolvedModel.loadResult) : false;
			const piIntercomTool = resolvedModel && !piSubagentsHost
				? createCliPiIntercomAgentTool({
					loadResult: resolvedModel.loadResult,
					modelRegistry: resolvedModel.modelRegistry,
					model: resolvedModel.model,
					cwd: piContextCwd,
				})
				: undefined;
			if (piIntercomTool) {
				renderer.appendLog("Agent tool: pi-intercom");
			} else if (piIntercomAvailable && piSubagentsHost) {
				renderer.appendLog("Extension tool: pi-intercom");
			}

			const result = await execute({
				source,
				sourcePath: resolvedWorkflowPath,
				processId: options.process,
				instanceId,
				qianjiCommand: options.qianji,
				dmnPaths: resolvedDmnPaths,
				hostFixturePath: resolvedHostFixturePath,
				eventFixturePath: resolvedEventFixturePath,
				context: parseContextJson(options.contextJson),
				model: piSubagentsHost ? undefined : resolvedModel?.model,
				apiKey: piSubagentsHost ? undefined : resolvedModel?.apiKey,
				thinkingLevel,
				agentHost: piSubagentsHost,
				humanTaskHandler: async (request) => {
					if (useGraph) {
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
					if (useGraph) {
						updateSubagentGraphDetail(renderer.graphView, request.activityId, "user:answered");
						renderer.refresh();
					}
					return answer;
				},
				hostBackend: piSubagentsHost ? "pi-subagents" : resolvedModel ? "pi-ai" : undefined,
				agentTools: piIntercomTool ? [piIntercomTool] : undefined,
				traceFrameDelayMs: options.traceFrameMs,
				cwd: invocationCwd,
				variables: options.var,
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
				graphView: useGraph ? renderer.graphView : undefined,
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

			renderer.appendLog("\nPress any key to exit.");
			await renderer.waitForKey();
			renderer.stop();
			process.exit(result.success ? 0 : 1);
			} catch (err) {
				console.error("Error:", err instanceof Error ? err.message : String(err));
				process.exit(1);
		}
	});

function collect(value: string, prev: string[]): string[] {
	return prev.concat([value]);
}

async function runCompileCommand(skillPath: string, options: PiWendaoCompileOptions): Promise<void> {
	const skillContent = readFileSync(skillPath, "utf-8");
	const outputPath = options.output ?? skillPath.replace(/\.md$/, ".bpmn");

	if (!options.model) {
		throw new Error("--model is required");
	}

	const { model, apiKey, headers } = await resolveModel(options.model, options.provider, options.apiKey, options.extension);

	console.log(`Compiling ${skillPath} using ${model.provider}/${model.id}...`);

	const result = await compileSkill({
		skillContent,
		model,
		apiKey,
		headers,
		cwd: process.cwd(),
		template: {
			command: options.qianji,
			onMessage: (message) => console.log(message),
		},
		target: {
			onMessage: (message) => console.log(message),
		},
		lint: options.lint === false
			? false
			: {
				command: options.qianji,
				maxRepairAttempts: parseNonNegativeInt(options.lintRetries, "--lint-retries"),
				onMessage: (message) => console.log(message),
			},
	});

	if (!result.success) {
		const errors = result.errors?.map((error) => `  - ${error}`).join("\n");
		throw new Error(`Compilation failed${errors ? `:\n${errors}` : ""}`);
	}

	writeFileSync(outputPath, result.bpmnXml!);
	console.log(`Compiled BPMN to ${outputPath}`);
	if (result.dmnXml) {
		const dmnOutputPath = replaceExtension(outputPath, ".dmn");
		writeFileSync(dmnOutputPath, result.dmnXml);
		console.log(`Compiled DMN to ${dmnOutputPath}`);
	}
}

function resolveCliPath(cwd: string, path: string): string {
	return resolvePath(cwd, path);
}

function resolveCliPaths(cwd: string, paths: string[]): string[] {
	return paths.map((path) => resolveCliPath(cwd, path));
}

function resolveOptionalCliPath(cwd: string, path: string | undefined): string | undefined {
	return path ? resolveCliPath(cwd, path) : undefined;
}

function parseContextJson(value: string | undefined): Record<string, unknown> | undefined {
	if (!value) return undefined;
	const parsed = JSON.parse(value) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("--context-json must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

async function runWorkflowInRenderer(params: {
	renderer: Renderer;
	useGraph: boolean;
	resolvedWorkflowPath: string;
	options: PiWendaoCliOptions;
	instanceId?: string;
	invocationCwd: string;
	piContextCwd: string;
	resolvedDmnPaths: string[];
	resolvedHostFixturePath?: string;
	resolvedEventFixturePath?: string;
	resolvedModel?: ResolvedModel;
	thinkingLevel: PiWendaoThinkingLevel;
}): Promise<{ success: boolean }> {
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

function parseNonNegativeNumber(value: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error("--trace-frame-ms must be a non-negative number");
	}
	return parsed;
}

function parseNonNegativeInt(value: string | undefined, label: string): number {
	const parsed = Number.parseInt(value ?? "0", 10);
	if (!Number.isInteger(parsed) || parsed < 0) {
		throw new Error(`${label} must be a non-negative integer`);
	}
	return parsed;
}

function replaceExtension(path: string, extension: string): string {
	const currentExtension = extname(path);
	return currentExtension ? `${path.slice(0, -currentExtension.length)}${extension}` : `${path}${extension}`;
}

function resolveQianjiCommand(explicitCommand: string | undefined): string {
	return explicitCommand ?? process.env.QIANJI_CLI ?? "qianji";
}

type WorkflowArgumentResolution =
	| { kind: "workflow"; workflowPath: string }
	| { kind: "missing"; workflowPath?: undefined }
	| { kind: "exit"; workflowPath?: undefined };

async function resolveWorkflowArgument(
	workflowPath: string | undefined,
	options: {
		qianji?: string;
		show?: boolean;
		tui?: boolean;
		model?: string;
		provider?: string;
		apiKey?: string;
	},
	context: {
		invocationCwd: string;
		piContextCwd: string;
		resolvedDmnPaths: string[];
		resolvedExtensionPaths: string[];
		thinkingLevel: PiWendaoThinkingLevel;
	},
): Promise<WorkflowArgumentResolution> {
	if (workflowPath) return { kind: "workflow", workflowPath };
	if (options.show) return { kind: "missing" };
	if (options.tui !== true) return { kind: "missing" };
	if (!process.stdin.isTTY) return { kind: "missing" };

	const originalCwd = process.cwd();
	process.chdir(context.piContextCwd);
	try {
		const resolvedModel = await resolveModel(
			resolveExecutionModelPattern(options.model),
			options.provider,
			options.apiKey,
			context.resolvedExtensionPaths,
		);
		const result = await launchPiWendaoChatTui({
			resolvedModel,
			thinkingLevel: context.thinkingLevel,
			invocationCwd: context.invocationCwd,
			showInstances: () => runQianjiShow({
				command: resolveQianjiCommand(options.qianji),
				dmnPaths: [],
				cwd: context.invocationCwd,
			}),
			showInstanceStatus: (instanceId, workflowPath) => runQianjiShow({
				command: resolveQianjiCommand(options.qianji),
				instanceId,
				workflowPath,
				dmnPaths: context.resolvedDmnPaths,
				cwd: context.invocationCwd,
			}),
		});
		return result.kind === "workflow"
			? { kind: "workflow", workflowPath: result.workflowPath }
			: { kind: "exit" };
	} finally {
		process.chdir(originalCwd);
	}
}

function runQianjiShow(options: {
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

function appendActiveBpmnNodeLabels(output: string, source: string, processId?: string): string {
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

function resolveExecutionModelPattern(explicitModel: string | undefined): string {
	if (explicitModel) return explicitModel;
	const envModel = process.env.PI_WENDAO_MODEL
		?? process.env.ANTHROPIC_MODEL
		?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
		?? process.env.ANTHROPIC_SMALL_FAST_MODEL;
	if (!envModel) return DEFAULT_EXECUTION_MODEL;
	if (envModel.includes("/") || !process.env.ANTHROPIC_BASE_URL?.trim()) return envModel;
	return `anthropic/${envModel}`;
}

function resolveExecutionThinkingLevel(explicitLevel: string | undefined): PiWendaoThinkingLevel {
	const raw = explicitLevel
		?? process.env.PI_WENDAO_THINKING_LEVEL
		?? DEFAULT_THINKING_LEVEL;
	if (!THINKING_LEVELS.has(raw)) {
		throw new Error(`invalid thinking level "${raw}"; expected off, minimal, low, medium, high, or xhigh`);
	}
	return raw as PiWendaoThinkingLevel;
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
	graphView: ReturnType<typeof createRenderer>["graphView"],
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

program.parse();
