export interface SkillscConfig {
	hostKind?: SkillscHostWorkKind;
	prompt: string;
	tools: string[];
	inputs: string[];
	outputs: string[];
	subagent?: SkillscSubagentConfig;
}

export type SkillscHostWorkKind =
	| "send"
	| "service"
	| "script"
	| "user"
	| "manual"
	| "business_rule";

export interface SkillscSubagentConfig {
	type?: string;
	description?: string;
	runInBackground?: boolean;
	model?: string;
	thinking?: string;
	maxTurns?: number;
	isolated?: boolean;
	isolation?: string;
	inheritContext?: boolean;
}

export interface SkillscQianjiCheckpointFeedback {
	outcome?: string;
	backend?: string;
	source?: string;
	saved?: string;
	deleted?: string;
	status?: string;
	pendingHostWork?: string;
}

export interface SkillscAgentExecutionMetadata {
	activityId?: string;
	processId?: string;
	instanceId?: string;
	nodeIndex?: number;
	tokenId?: number;
	repeat?: unknown;
	checkpoint?: SkillscQianjiCheckpointFeedback;
}

export interface SkillscAgentRequest {
	activityId: string;
	config: SkillscConfig;
	variables: Record<string, unknown>;
	execution?: SkillscAgentExecutionMetadata;
}

export interface SkillscAgentHost {
	run(request: SkillscAgentRequest): Promise<Record<string, unknown>>;
}

export const EMPTY_SKILLSC_CONFIG: SkillscConfig = {
	prompt: "",
	tools: [],
	inputs: [],
	outputs: [],
};

export function buildSkillscAgentPrompt(
	config: SkillscConfig,
	variables: Record<string, unknown>,
	execution?: SkillscAgentExecutionMetadata,
): string {
	const scopedVars: Record<string, unknown> = {};
	for (const inputName of config.inputs) {
		if (inputName in variables) {
			scopedVars[inputName] = variables[inputName];
		}
	}

	const variableContext = Object.entries(scopedVars)
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join("\n");
	const resolvedPrompt = config.prompt.replace(
		/\$\{environment\.variables\.(\w+)\}/g,
		(_, varName: string) => {
			const val = variables[varName];
			return val !== undefined ? JSON.stringify(val) : "undefined";
		},
	);

	const promptParts = [resolvedPrompt];
	const executionContext = formatExecutionContext(execution);
	if (executionContext) {
		promptParts.push(`\n\nQianji BPMN execution context (scheduler-owned, read-only):\n${executionContext}`);
	}
	if (variableContext) {
		promptParts.push(`\n\nCurrent qianji task inputs (read-only):\n${variableContext}`);
	}
	if (config.outputs.length > 0) {
		promptParts.push(
			`\nAfter completing the task, output the following variables in a JSON code block with exactly these keys:\n${config.outputs.map((o) => `- ${o}`).join("\n")}`,
		);
	}
	promptParts.push(
		"\nQianji owns BPMN scheduling, gateway routing, retries, joins, checkpoint persistence, and resume state. Do not advance the workflow or decide the next BPMN node; only complete this service task and return its declared outputs.",
	);
	return promptParts.join("");
}

function formatExecutionContext(execution: SkillscAgentExecutionMetadata | undefined): string {
	if (!execution) return "";
	const lines: string[] = [];
	appendField(lines, "processId", execution.processId);
	appendField(lines, "instanceId", execution.instanceId);
	appendField(lines, "activityId", execution.activityId);
	appendField(lines, "nodeIndex", execution.nodeIndex);
	appendField(lines, "tokenId", execution.tokenId);
	appendField(lines, "repeat", execution.repeat);
	appendField(lines, "checkpoint.outcome", execution.checkpoint?.outcome);
	appendField(lines, "checkpoint.backend", execution.checkpoint?.backend);
	appendField(lines, "checkpoint.source", execution.checkpoint?.source);
	appendField(lines, "checkpoint.saved", execution.checkpoint?.saved);
	appendField(lines, "checkpoint.deleted", execution.checkpoint?.deleted);
	appendField(lines, "checkpoint.status", execution.checkpoint?.status);
	appendField(lines, "checkpoint.pendingHostWork", execution.checkpoint?.pendingHostWork);
	return lines.map((line) => `- ${line}`).join("\n");
}

function appendField(lines: string[], name: string, value: unknown): void {
	if (value === undefined || value === null || value === "") return;
	lines.push(`${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

export function extractOutputVariablesFromText(
	textContent: string,
	outputNames: string[],
): Record<string, unknown> {
	if (outputNames.length === 0) return {};

	const jsonMatch = textContent.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (jsonMatch) {
		const extracted = pickOutputVariables(jsonMatch[1], outputNames);
		if (extracted) return extracted;
	}

	const parsed = pickOutputVariables(textContent, outputNames);
	return parsed ?? {};
}

function pickOutputVariables(
	rawJson: string,
	outputNames: string[],
): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(rawJson);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return undefined;
		}
		const record = parsed as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const name of outputNames) {
			if (name in record) {
				result[name] = record[name];
			}
		}
		return result;
	} catch {
		return undefined;
	}
}
