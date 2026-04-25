import { defaultQianjiCommand, runCommand } from "./qianji-command.js";
import type { CompileArtifactTarget } from "./prompt.js";

export interface CompileTemplates {
	bpmn: string;
	dmn?: string;
}

export interface CompileTemplateOptions {
	/** Qianji CLI command. Defaults to QIANJI_CLI or qianji on PATH. */
	command?: string;
	/** Test hook or custom qianji template runner. */
	runner?: QianjiTemplateRunner;
	/** Progress callback for template loading status. */
	onMessage?: (message: string) => void;
}

export type QianjiTemplateDomain = "bpmn" | "dmn";

export type QianjiTemplateRunner = (
	domain: QianjiTemplateDomain,
	options: { command?: string; cwd: string },
) => Promise<QianjiTemplateResult>;

export type QianjiTemplateResult =
	| { success: true; template: string; output?: string }
	| { success: false; errors: string[]; output?: string };

export async function loadQianjiTemplates(
	target: CompileArtifactTarget,
	options: CompileTemplateOptions & { cwd: string },
): Promise<{ success: true; templates: CompileTemplates } | { success: false; errors: string[] }> {
	const runner = options.runner ?? createQianjiTemplateRunner();
	options.onMessage?.("loading qianji BPMN template");
	const bpmn = await runner("bpmn", { command: options.command, cwd: options.cwd });
	if (!bpmn.success) return { success: false, errors: bpmn.errors };

	if (target === "bpmn") {
		options.onMessage?.("qianji template loaded");
		return { success: true, templates: { bpmn: bpmn.template } };
	}

	options.onMessage?.("loading qianji DMN template");
	const dmn = await runner("dmn", { command: options.command, cwd: options.cwd });
	if (!dmn.success) return { success: false, errors: dmn.errors };
	options.onMessage?.("qianji templates loaded");
	return { success: true, templates: { bpmn: bpmn.template, dmn: dmn.template } };
}

export function createQianjiTemplateRunner(): QianjiTemplateRunner {
	return async (domain, options) => {
		const result = await runCommand(
			options.command ?? defaultQianjiCommand(),
			["template", `--${domain}`],
			options.cwd,
		);
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		if (result.exitCode !== 0) {
			return {
				success: false,
				errors: [output || `qianji template --${domain} exited with status ${result.exitCode}`],
				output,
			};
		}
		const template = result.stdout.trim();
		if (!template) {
			return {
				success: false,
				errors: [`qianji template --${domain} returned empty output`],
				output,
			};
		}
		return { success: true, template, output };
	};
}
