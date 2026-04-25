import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, Model } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { XMLParser } from "fast-xml-parser";
import { getPiWendaoToolNames } from "../tools/registry.js";
import {
	buildCompilePrompt,
	buildTargetDecisionPrompt,
	type CompileArtifactTarget,
	type CompileTargetDecision,
} from "./prompt.js";
import { loadQianjiTemplates, type CompileTemplateOptions, type CompileTemplates } from "./qianji-template.js";
import { defaultQianjiCommand, runCommand } from "./qianji-command.js";

export interface CompileOptions {
	/** Raw markdown content of the skill file */
	skillContent: string;
	/** Large model to use for compilation */
	model: Model<string>;
	/** API key for the model provider */
	apiKey?: string;
	/** Provider-specific request headers resolved from pi model/auth config */
	headers?: Record<string, string>;
	/** qianji template integration. Defaults to QIANJI_CLI or qianji on PATH. */
	template?: CompileTemplateOptions;
	/** LLM target decision integration. Defaults to automatic BPMN vs BPMN+DMN selection. */
	target?: CompileTargetOptions;
	/** qianji lint integration. Pass false to disable. */
	lint?: false | CompileLintOptions;
	/** Working directory for qianji template and lint. */
	cwd?: string;
}

export interface CompileTargetOptions {
	/** Test hook or custom target decision runner. */
	runner?: CompileTargetRunner;
	/** Progress callback for target selection status. */
	onMessage?: (message: string) => void;
}

export interface CompileTargetRunnerContext {
	model: Model<string>;
	apiKey?: string;
	headers?: Record<string, string>;
}

export type CompileTargetRunner = (
	skillContent: string,
	context: CompileTargetRunnerContext,
) => Promise<CompileTargetDecision>;

export interface CompileArtifact {
	kind: "bpmn" | "dmn";
	content: string;
}

export interface CompileResult {
	success: boolean;
	bpmnXml?: string;
	dmnXml?: string;
	artifacts?: CompileArtifact[];
	targetDecision?: CompileTargetDecision;
	errors?: string[];
}

export interface CompileLintOptions {
	/** Qianji CLI command. Defaults to QIANJI_CLI or qianji on PATH. */
	command?: string;
	/** Number of model repair attempts after the initial lint failure. Defaults to 2. */
	maxRepairAttempts?: number;
	/** Test hook or custom lint runner. */
	runner?: BpmnLintRunner;
	/** Test hook or custom DMN lint runner. Defaults to qianji lint --dmn. */
	dmnRunner?: BpmnLintRunner;
	/** Progress callback for lint/repair status. */
	onMessage?: (message: string) => void;
}

export interface BpmnLintResult {
	success: boolean;
	output: string;
}

export type BpmnLintRunner = (xml: string) => Promise<BpmnLintResult>;

const SERVICE_TASK_IMPLEMENTATION = "${environment.services.runAgent}";
const PI_WENDAO_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const piWendaoContractParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "",
	removeNSPrefix: true,
});

/**
 * Compile a skill markdown file into BPMN 2.0 XML using a large model.
 */
export async function compileSkill(options: CompileOptions): Promise<CompileResult> {
	const lintOptions = options.lint === false ? undefined : options.lint ?? {};

	let targetDecision: CompileTargetDecision;
	try {
		targetDecision = await decideCompileTarget(options, options.skillContent);
	} catch (err) {
		return { success: false, errors: [err instanceof Error ? err.message : String(err)] };
	}
	options.target?.onMessage?.(`compile target: ${targetDecision.target}`);
	const templateResult = await loadQianjiTemplates(targetDecision.target, {
		...(options.template ?? {}),
		command: options.template?.command ?? lintOptions?.command,
		cwd: options.cwd ?? process.cwd(),
	});
	if (!templateResult.success) {
		return { success: false, targetDecision, errors: templateResult.errors };
	}
	const templates = templateResult.templates;
	const { systemPrompt, userMessage } = buildCompilePrompt(targetDecision, options.skillContent, templates);
	if (!lintOptions) {
		return requestArtifacts(options, systemPrompt, userMessage, targetDecision);
	}

	const bpmnLintRunner = createCompileLintRunner(lintOptions.runner ?? createQianjiLintRunner({
		command: lintOptions.command,
		cwd: options.cwd,
		domain: "bpmn",
	}), { cwd: options.cwd ?? process.cwd() });
	const dmnLintRunner = targetDecision.target === "bpmn-dmn"
		? lintOptions.dmnRunner ?? createQianjiLintRunner({
			command: lintOptions.command,
			cwd: options.cwd,
			domain: "dmn",
		})
		: undefined;
	return compileWithLintAgent(options, {
		systemPrompt,
		userMessage,
		skillContent: options.skillContent,
		templates,
		targetDecision,
		lintOptions,
		lintRunners: {
			bpmn: bpmnLintRunner,
			dmn: dmnLintRunner,
		},
	});
}

async function decideCompileTarget(
	options: CompileOptions,
	skillContent: string,
): Promise<CompileTargetDecision> {
	if (options.target?.runner) {
		return normalizeCompileTargetDecision(await options.target.runner(skillContent, {
			model: options.model,
			apiKey: options.apiKey,
			headers: options.headers,
		}));
	}

	options.target?.onMessage?.("choosing BPMN/DMN compile target");
	const { systemPrompt, userMessage } = buildTargetDecisionPrompt(skillContent);
	const stream = streamSimple(options.model, {
		systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text: userMessage }], timestamp: Date.now() }],
	}, {
		apiKey: options.apiKey,
		headers: options.headers,
	});
	const result = await stream.result();
	if (result.stopReason === "error") {
		throw new Error(result.errorMessage ?? "Model returned an error while choosing compile target");
	}
	const text = result.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { type: "text"; text: string }).text)
		.join("");
	return normalizeCompileTargetDecision(parseCompileTargetDecision(text));
}

function parseCompileTargetDecision(text: string): CompileTargetDecision {
	const json = extractJsonObject(text);
	if (!json) {
		throw new Error("No compile target JSON found in model response");
	}
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (err) {
		throw new Error(`Invalid compile target JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!isObject(value)) {
		throw new Error("Compile target JSON must be an object");
	}
	const rawTarget = readString(value.target).toLowerCase();
	const reason = readString(value.reason) || "Model selected artifact target from raw SKILL.md.";
	const dmnDecisions = asArray(value.dmnDecisions)
		.map((item) => typeof item === "string" ? item.trim() : "")
		.filter(Boolean);
	if (rawTarget === "bpmn" || rawTarget === "bpmn-dmn" || rawTarget === "bpmn+dmn") {
		return {
			target: rawTarget === "bpmn" ? "bpmn" : "bpmn-dmn",
			reason,
			dmnDecisions,
		};
	}
	if (rawTarget === "dmn") {
		return {
			target: "bpmn-dmn",
			reason: `${reason} Pure DMN is normalized to BPMN+DMN because pi-wendao executes BPMN workflows.`,
			dmnDecisions,
			normalizedFrom: "dmn",
		};
	}
	throw new Error(`Unsupported compile target '${rawTarget || "(missing)"}'`);
}

function normalizeCompileTargetDecision(decision: CompileTargetDecision): CompileTargetDecision {
	if (decision.target === "bpmn-dmn" || decision.target === "bpmn") {
		return {
			target: decision.target,
			reason: decision.reason || "Model selected artifact target from raw SKILL.md.",
			dmnDecisions: decision.dmnDecisions ?? [],
			...(decision.normalizedFrom ? { normalizedFrom: decision.normalizedFrom } : {}),
		};
	}
	return {
		target: "bpmn-dmn",
		reason: `${decision.reason || "Model selected pure DMN."} Pure DMN is normalized to BPMN+DMN because pi-wendao executes BPMN workflows.`,
		dmnDecisions: decision.dmnDecisions ?? [],
		normalizedFrom: "dmn",
	};
}

function extractJsonObject(text: string): string | undefined {
	const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (codeBlockMatch) return codeBlockMatch[1].trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) return text.slice(start, end + 1);
	return undefined;
}

function createCompileLintRunner(qianjiLintRunner: BpmnLintRunner, options: { cwd: string }): BpmnLintRunner {
	return async (xml: string) => {
		const qianjiLint = await qianjiLintRunner(xml);
		if (!qianjiLint.success) return qianjiLint;

		const piWendaoLint = lintPiWendaoCompileContract(xml, options);
		if (piWendaoLint.success) return qianjiLint;

		const output = [
			qianjiLint.output.trim(),
			piWendaoLint.output.trim(),
		].filter(Boolean).join("\n\n");
		return {
			success: false,
			output,
		};
	};
}

function lintPiWendaoCompileContract(xml: string, options: { cwd: string }): BpmnLintResult {
	let document: { definitions?: { process?: unknown } };
	try {
		document = piWendaoContractParser.parse(xml) as { definitions?: { process?: unknown } };
	} catch (err) {
		return {
			success: false,
			output: renderPiWendaoCompileContractIssues([{
				code: "PI_WENDAO001",
				title: "BPMN XML must be parseable for pi-wendao contract validation",
				summary: err instanceof Error ? err.message : String(err),
				llmFixPrompt: "Repair the XML syntax, preserve the workflow intent, and run qianji_lint again.",
			}]),
		};
	}

	const issues: PiWendaoCompileContractIssue[] = [];
	const supportedToolNames = getPiWendaoToolNames(options.cwd);
	const supportedToolNameSet = new Set(supportedToolNames);
	const hostTaskIds = collectPiWendaoTaskIds(document.definitions?.process);
	for (const boundaryEvent of collectBoundaryEvents(document.definitions?.process)) {
		const boundaryId = readString(boundaryEvent.id) || "(missing boundaryEvent id)";
		const attachedToRef = readString(boundaryEvent.attachedToRef);
		const hasErrorDefinition = asArray(boundaryEvent.errorEventDefinition).length > 0;
		if (attachedToRef && hostTaskIds.has(attachedToRef) && hasErrorDefinition) {
			issues.push({
				code: "PI_WENDAO_TASK_ERROR_BOUNDARY_UNSUPPORTED",
				title: "task-level error boundary is outside the pi-wendao compiler subset",
				summary: `boundaryEvent '${boundaryId}' attaches an errorEventDefinition directly to task '${attachedToRef}'.`,
				llmFixPrompt: `Remove boundaryEvent '${boundaryId}'. Have task '${attachedToRef}' output a boolean status such as success or valid, route it through an exclusiveGateway, and put the fallback serviceTask on the default or negative branch. If BPMN error propagation is required, wrap the risky work in a qianji-supported subprocess shell instead of attaching the error boundary directly to a task.`,
			});
		}
	}
	for (const task of collectPiWendaoTasks(document.definitions?.process)) {
		const taskId = readString(task.id) || `(missing ${task.element} id)`;
		if (task.element === "serviceTask" && readString(task.implementation) !== SERVICE_TASK_IMPLEMENTATION) {
			issues.push({
				code: "PI_WENDAO_SERVICE_IMPLEMENTATION",
				title: "serviceTask must dispatch through pi-wendao runAgent",
				summary: `serviceTask '${taskId}' does not use implementation="${SERVICE_TASK_IMPLEMENTATION}".`,
				llmFixPrompt: `Set serviceTask '${taskId}' implementation to "${SERVICE_TASK_IMPLEMENTATION}" without changing its id or sequence-flow references.`,
			});
		}

		const config = firstObject(firstObject(task.extensionElements)?.config);
		if (!config) {
			issues.push({
				code: "PI_WENDAO_TASK_CONFIG",
				title: `${task.element} must include pi-wendao config`,
				summary: `${task.element} '${taskId}' is missing extensionElements/skillsc:config.`,
				llmFixPrompt: `Add extensionElements with skillsc:config to ${task.element} '${taskId}', including prompt, tools, inputs, and outputs fields.`,
			});
			continue;
		}

		for (const field of ["prompt", "tools", "inputs", "outputs"]) {
			if (!Object.prototype.hasOwnProperty.call(config, field)) {
				issues.push({
					code: "PI_WENDAO_CONFIG_FIELD",
					title: "pi-wendao config must include required fields",
					summary: `${task.element} '${taskId}' skillsc:config is missing '${field}'.`,
					llmFixPrompt: `Add skillsc:${field} to ${task.element} '${taskId}' skillsc:config. Empty tools, inputs, or outputs are allowed when appropriate.`,
				});
			}
		}

		if (!readText(config.prompt).trim()) {
			issues.push({
				code: "PI_WENDAO_PROMPT_EMPTY",
				title: "pi-wendao prompt must not be empty",
				summary: `${task.element} '${taskId}' has an empty skillsc:prompt.`,
				llmFixPrompt: `Write a focused task instruction in skillsc:prompt for ${task.element} '${taskId}'.`,
			});
		}

		if (Object.prototype.hasOwnProperty.call(config, "tools")) {
			const declaredTools = csv(readText(config.tools));
			if (task.element === "userTask" && declaredTools.length > 0) {
				issues.push({
					code: "PI_WENDAO_USER_TASK_TOOLS",
					title: "userTask tools must be empty",
					summary: `userTask '${taskId}' declares tool(s): ${declaredTools.join(", ")}.`,
					llmFixPrompt: `Clear skillsc:tools on userTask '${taskId}'. A userTask is resolved by graph-local human input, not by runtime tools or an LLM agent.`,
				});
				continue;
			}
			const unsupportedTools = declaredTools.filter((tool) => !supportedToolNameSet.has(tool));
			if (unsupportedTools.length > 0) {
				issues.push({
					code: "PI_WENDAO_TOOL_UNSUPPORTED",
					title: "pi-wendao tools must be executable by the runtime",
					summary: `${task.element} '${taskId}' declares unsupported tool(s): ${unsupportedTools.join(", ")}.`,
					llmFixPrompt: `Replace or remove unsupported tool(s) on ${task.element} '${taskId}'. Runtime-registered tools are: ${supportedToolNames.join(", ")}.`,
				});
			}
		}

		for (const field of ["inputs", "outputs"]) {
			if (!Object.prototype.hasOwnProperty.call(config, field)) continue;
			const invalidNames = csv(readText(config[field])).filter((name) => !PI_WENDAO_VARIABLE_NAME_PATTERN.test(name));
			if (invalidNames.length > 0) {
				issues.push({
					code: "PI_WENDAO_VARIABLE_IDENTIFIER",
					title: "pi-wendao variable references must be simple identifiers",
					summary: `serviceTask '${taskId}' skillsc:${field} contains invalid variable name(s): ${invalidNames.join(", ")}.`,
					llmFixPrompt: `Rename skillsc:${field} entries on serviceTask '${taskId}' to comma-separated identifiers matching ${PI_WENDAO_VARIABLE_NAME_PATTERN.source}, and update any downstream references consistently.`,
				});
			}
		}
	}

	if (issues.length === 0) {
		return { success: true, output: "pi-wendao compile contract passed" };
	}

	return {
		success: false,
		output: renderPiWendaoCompileContractIssues(issues),
	};
}

interface CompileArtifactBundle {
	bpmnXml: string;
	dmnXml?: string;
	artifacts: CompileArtifact[];
}

interface CompileArtifactLintRunners {
	bpmn: BpmnLintRunner;
	dmn?: BpmnLintRunner;
}

async function compileWithLintAgent(
	options: CompileOptions,
	args: {
		systemPrompt: string;
		userMessage: string;
		skillContent: string;
		templates: CompileTemplates;
		targetDecision: CompileTargetDecision;
		lintOptions: CompileLintOptions;
		lintRunners: CompileArtifactLintRunners;
	},
): Promise<CompileResult> {
	const { lintOptions, lintRunners, targetDecision } = args;
	const maxRepairAttempts = lintOptions.maxRepairAttempts ?? 2;
	const systemPrompt = buildAgentSystemPrompt(args.systemPrompt, targetDecision);
	const messages: Message[] = [];
	let lastArtifacts: CompileArtifactBundle | undefined;
	let lastLintOutput = "";
	for (let repairAttempt = 0; repairAttempt <= maxRepairAttempts; repairAttempt += 1) {
		const prompt = repairAttempt === 0
			? buildAgentCompilePrompt(args.userMessage, targetDecision)
			: buildLintRepairPrompt(args.skillContent, args.templates, targetDecision, lastArtifacts, lastLintOutput, repairAttempt);

		const userMessage: Message = { role: "user", content: prompt, timestamp: Date.now() };
		messages.push(userMessage);
		const assistant = await requestAssistantMessage(options, systemPrompt, messages);
		messages.push(assistant);
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			return { success: false, errors: [assistant.errorMessage ?? `Model stopped: ${assistant.stopReason}`] };
		}

		const text = extractAssistantText(assistant);
		const artifacts = extractArtifactBundle(text, targetDecision.target);
		if (!artifacts) {
			return { success: false, targetDecision, errors: [missingArtifactMessage(targetDecision.target)] };
		}

		lastArtifacts = artifacts;
		const lint = await lintArtifactBundle(artifacts, lintRunners);
		if (lint.success) {
			lintOptions.onMessage?.("qianji lint passed");
			return {
				success: true,
				bpmnXml: artifacts.bpmnXml,
				dmnXml: artifacts.dmnXml,
				artifacts: artifacts.artifacts,
				targetDecision,
			};
		}

		if (repairAttempt >= maxRepairAttempts) {
			return {
				success: false,
				targetDecision,
				errors: [`qianji lint failed after ${maxRepairAttempts} repair attempt(s):\n${lint.output}`],
			};
		}

		const nextAttempt = repairAttempt + 1;
		lintOptions.onMessage?.(`qianji lint failed; requesting model repair ${nextAttempt}/${maxRepairAttempts}`);
		lastLintOutput = lint.output;
	}

	return { success: false, targetDecision, errors: ["qianji lint repair loop ended without valid qianji artifact(s)"] };
}

async function requestAssistantMessage(
	options: CompileOptions,
	systemPrompt: string,
	messages: Message[],
): Promise<AssistantMessage> {
	const stream = streamSimple(options.model, {
		systemPrompt,
		messages,
	}, {
		apiKey: options.apiKey,
		headers: options.headers,
	});
	return stream.result();
}

async function requestArtifacts(
	options: CompileOptions,
	systemPrompt: string,
	userMessage: string,
	targetDecision: CompileTargetDecision,
): Promise<CompileResult> {
	const stream = streamSimple(options.model, {
		systemPrompt,
		messages: [{ role: "user", content: [{ type: "text", text: userMessage }], timestamp: Date.now() }],
	}, {
		apiKey: options.apiKey,
		headers: options.headers,
	});

	const result = await stream.result();
	const text = result.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { type: "text"; text: string }).text)
		.join("");

	if (result.stopReason === "error") {
		return { success: false, targetDecision, errors: [result.errorMessage ?? "Model returned an error"] };
	}

	const artifacts = extractArtifactBundle(text, targetDecision.target);
	if (!artifacts) {
		return { success: false, targetDecision, errors: [missingArtifactMessage(targetDecision.target)] };
	}

	return {
		success: true,
		bpmnXml: artifacts.bpmnXml,
		dmnXml: artifacts.dmnXml,
		artifacts: artifacts.artifacts,
		targetDecision,
	};
}

function buildLintRepairPrompt(
	skillContent: string,
	templates: CompileTemplates,
	targetDecision: CompileTargetDecision,
	previousArtifacts: CompileArtifactBundle | undefined,
	lintOutput: string,
	attempt: number,
): string {
	return `The qianji artifact bundle you generated for the skill failed qianji lint.

Repair attempt: ${attempt}

Return corrected artifact XML only. pi-wendao compile will run qianji lint after your
answer and feed any remaining lint output back into this repair loop.

Preserve the raw skill intent and pi-wendao extension config, but make the
artifact(s) pass the qianji lint report below. Use the qianji template(s) as the
supported executable skeleton.

## Target decision

\`\`\`json
${JSON.stringify(targetDecision, null, 2)}
\`\`\`

## Qianji BPMN template

\`\`\`bpmn
${templates.bpmn}
\`\`\`

${templates.dmn ? `## Qianji DMN template

\`\`\`dmn
${templates.dmn}
\`\`\`
` : ""}

## Raw SKILL.md

\`\`\`markdown
${skillContent}
\`\`\`

## qianji lint output

\`\`\`text
${lintOutput}
\`\`\`

## Previous artifacts

${renderArtifactBundleForPrompt(previousArtifacts)}
	`;
}

function buildAgentSystemPrompt(systemPrompt: string, targetDecision: CompileTargetDecision): string {
	return `${systemPrompt}

You are running inside the pi-wendao compile agent loop.

Protocol:
- Draft complete qianji artifact XML for target ${targetDecision.target}.
- pi-wendao compile will run qianji lint after every draft and feed structured lint
  output back to you when repair is needed.
- Final output must contain only the required code block(s), with no explanation.
	`;
}

function buildAgentCompilePrompt(userMessage: string, targetDecision: CompileTargetDecision): string {
	return `${userMessage}

Generate target ${targetDecision.target}. pi-wendao compile will run the qianji lint step
after your response and will ask you to repair any structured lint failure.`;
}

interface PiWendaoCompileContractIssue {
	code: string;
	title: string;
	summary: string;
	llmFixPrompt: string;
}

function renderPiWendaoCompileContractIssues(issues: PiWendaoCompileContractIssue[]): string {
	const lines = [
		"# PiWendao Compile Contract Failed",
		"",
		`Issues: ${issues.length}`,
	];
	for (const issue of issues) {
		lines.push(
			"",
			`## [${issue.code}] ${issue.title}`,
			"Severity: error",
			`Summary: ${issue.summary}`,
			"",
			"### LLM Fix Prompt",
			issue.llmFixPrompt,
		);
	}
	return lines.join("\n");
}

function collectBoundaryEvents(processes: unknown): Record<string, unknown>[] {
	const boundaryEvents: Record<string, unknown>[] = [];
	for (const process of asArray(processes)) {
		if (!isObject(process)) continue;
		for (const boundaryEvent of asArray(process.boundaryEvent)) {
			if (isObject(boundaryEvent)) boundaryEvents.push(boundaryEvent);
		}
	}
	return boundaryEvents;
}

type PiWendaoTaskElement = Record<string, unknown> & { element: string };

const PI_WENDAO_CONFIG_TASK_ELEMENTS = ["serviceTask", "userTask"] as const;

function collectPiWendaoTasks(processes: unknown): PiWendaoTaskElement[] {
	const tasks: PiWendaoTaskElement[] = [];
	for (const process of asArray(processes)) {
		if (!isObject(process)) continue;
		for (const element of PI_WENDAO_CONFIG_TASK_ELEMENTS) {
			for (const task of asArray(process[element])) {
				if (isObject(task)) tasks.push({ ...task, element });
			}
		}
	}
	return tasks;
}

function collectPiWendaoTaskIds(processes: unknown): Set<string> {
	return new Set(
		collectPiWendaoTasks(processes)
			.map((task) => readString(task.id))
			.filter(Boolean),
	);
}

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("");
}

function extractArtifactBundle(text: string, target: CompileArtifactTarget): CompileArtifactBundle | undefined {
	if (target === "bpmn") {
		const bpmnXml = extractXml(text);
		return bpmnXml
			? {
				bpmnXml,
				artifacts: [{ kind: "bpmn", content: bpmnXml }],
			}
			: undefined;
	}

	const fencedArtifacts = extractFencedXmlArtifacts(text);
	const bpmnXml = fencedArtifacts.find((artifact) => artifact.kind === "bpmn")?.content;
	const dmnXml = fencedArtifacts.find((artifact) => artifact.kind === "dmn")?.content;
	if (!bpmnXml || !dmnXml) return undefined;
	return {
		bpmnXml,
		dmnXml,
		artifacts: [
			{ kind: "bpmn", content: bpmnXml },
			{ kind: "dmn", content: dmnXml },
		],
	};
}

function extractFencedXmlArtifacts(text: string): CompileArtifact[] {
	const artifacts: CompileArtifact[] = [];
	const codeBlockPattern = /```([^\n`]*)\n?([\s\S]*?)\n?```/g;
	let match: RegExpExecArray | null;
	while ((match = codeBlockPattern.exec(text)) !== null) {
		const info = match[1].toLowerCase();
		const content = match[2].trim();
		if (!content) continue;
		const kind = classifyXmlArtifact(info, content);
		if (kind) artifacts.push({ kind, content });
	}
	return artifacts;
}

function classifyXmlArtifact(info: string, content: string): "bpmn" | "dmn" | undefined {
	if (info.includes("bpmn")) return "bpmn";
	if (info.includes("dmn")) return "dmn";
	if (content.includes("BPMN/20100524/MODEL") || content.includes("<bpmn:definitions") || content.includes("<businessRuleTask") || content.includes("<bpmn:businessRuleTask")) {
		return "bpmn";
	}
	if (content.includes("DMN/") || content.includes("<dmn:definitions") || content.includes("<decision ")) {
		return "dmn";
	}
	return undefined;
}

function missingArtifactMessage(target: CompileArtifactTarget): string {
	if (target === "bpmn") return "No valid XML found in model response";
	return "No valid BPMN+DMN artifact bundle found in model response";
}

async function lintArtifactBundle(
	artifacts: CompileArtifactBundle,
	lintRunners: CompileArtifactLintRunners,
): Promise<BpmnLintResult> {
	const bpmnLint = await lintRunners.bpmn(artifacts.bpmnXml);
	if (artifacts.dmnXml && !lintRunners.dmn) {
		return {
			success: false,
			output: [
				"# BPMN lint",
				bpmnLint.output.trim() || (bpmnLint.success ? "PASS" : "FAIL"),
				"# DMN lint",
				"No qianji lint runner configured for DMN",
			].join("\n\n"),
		};
	}
	const dmnLint = artifacts.dmnXml && lintRunners.dmn
		? await lintRunners.dmn(artifacts.dmnXml)
		: undefined;

	const outputs = [
		"# BPMN lint",
		bpmnLint.output.trim() || (bpmnLint.success ? "PASS" : "FAIL"),
		dmnLint ? "# DMN lint" : undefined,
		dmnLint ? dmnLint.output.trim() || (dmnLint.success ? "PASS" : "FAIL") : undefined,
	].filter((line): line is string => Boolean(line));

	return {
		success: bpmnLint.success && (dmnLint?.success ?? true),
		output: outputs.join("\n\n"),
	};
}

function renderArtifactBundleForPrompt(bundle: CompileArtifactBundle | undefined): string {
	if (!bundle) return "(no previous artifacts)";
	const blocks = [`\`\`\`bpmn\n${bundle.bpmnXml}\n\`\`\``];
	if (bundle.dmnXml) blocks.push(`\`\`\`dmn\n${bundle.dmnXml}\n\`\`\``);
	return blocks.join("\n\n");
}

/**
 * Extract XML content from text that may be wrapped in markdown code fences.
 */
function extractXml(text: string): string | undefined {
	const fenced = extractFencedXmlArtifacts(text).find((artifact) => artifact.kind === "bpmn");
	if (fenced) return fenced.content;

	// Try raw XML
	const trimmed = text.trim();
	if (trimmed.startsWith("<?xml") || trimmed.startsWith("<definitions") || trimmed.startsWith("<bpmn:definitions")) {
		return trimmed;
	}

	return undefined;
}

function firstObject(value: unknown): Record<string, unknown> | undefined {
	return asArray(value).find(isObject);
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

function csv(value: string): string[] {
	if (!value.trim()) return [];
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createQianjiLintRunner(options: {
	command?: string;
	cwd?: string;
	domain?: "bpmn" | "dmn";
}): BpmnLintRunner {
	return async (xml: string) => {
		const domain = options.domain ?? "bpmn";
		const dir = await mkdtemp(join(tmpdir(), "pi-wendao-qianji-lint-"));
		const path = join(dir, domain === "bpmn" ? "workflow.bpmn" : "decision.dmn");
		try {
			await writeFile(path, xml, "utf-8");
			const result = await runCommand(options.command ?? defaultQianjiCommand(), ["lint", `--${domain}`, path], options.cwd ?? process.cwd());
			const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
			return { success: result.exitCode === 0, output };
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	};
}
