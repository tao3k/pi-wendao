#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import { extname, resolve as resolvePath } from "node:path";
import { program } from "commander";
import type { PiWendaoThinkingLevel } from "../executor/agent-runtime-types.js";
import { validateInstanceId } from "./instance-id.js";
import { compileSkill } from "../compiler/compiler.js";
import { createRenderer } from "../output/renderer.js";
import { resolveModel, resolvePiWendaoPackageRoot } from "./model-resolver.js";
import { launchPiWendaoNativeTui } from "./pi-wendao-native-launcher.js";
import {
	appendActiveBpmnNodeLabels,
	resolveQianjiCommand,
	runQianjiShow,
	runWorkflowInRenderer,
} from "./workflow-runner.js";

const DEFAULT_EXECUTION_MODEL = "anthropic/claude-sonnet-4-20250514";
const DEFAULT_THINKING_LEVEL: PiWendaoThinkingLevel = "medium";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

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
	.option("--tui", "Enable interactive graph TUI visualization (default); without workflow, open native pi chat")
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
				await launchPiWendaoNativeTui({
					modelPattern: resolveExecutionModelPattern(options.model),
					provider: options.provider,
					apiKey: options.apiKey,
					thinkingLevel,
					invocationCwd,
					piContextCwd,
					resolvedExtensionPaths,
					baseWorkflowOptions: {
						process: options.process,
						instanceId,
						qianji: options.qianji,
						contextJson: options.contextJson,
						traceFrameMs: options.traceFrameMs,
						var: options.var,
					},
					resolvedDmnPaths,
					resolvedHostFixturePath,
					resolvedEventFixturePath,
				});
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
			const result = await runWorkflowInRenderer({
				renderer,
				useGraph,
				resolvedWorkflowPath,
				options: {
					process: options.process,
					instanceId,
					qianji: options.qianji,
					contextJson: options.contextJson,
					traceFrameMs: options.traceFrameMs,
					var: options.var,
				},
				instanceId,
				invocationCwd,
				piContextCwd,
				resolvedDmnPaths,
				resolvedHostFixturePath,
				resolvedEventFixturePath,
				resolvedModel,
				thinkingLevel,
			});

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
	void context;
	return { kind: "missing" };
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

program.parse();
