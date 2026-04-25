#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import { extname } from "path";
import { program } from "commander";
import { compileSkill } from "../compiler/compiler.js";
import { resolveModel } from "./model-resolver.js";

program
	.name("skillsc")
	.description("Compile an agent skill into a BPMN 2.0 workflow")
	.argument("<skill>", "Path to SKILL.md file")
	.option("-o, --output <file>", "Output BPMN file path")
	.option("--model <model>", "Model to use (e.g., anthropic/<model-id>)")
	.option("--provider <provider>", "LLM provider")
	.option("--api-key <key>", "API key (overrides env vars)")
	.option("--qianji <command>", "Qianji CLI command for templates and compile lint (default: QIANJI_CLI or qianji on PATH)")
	.option("--lint-retries <count>", "Model repair attempts after qianji lint failure", "2")
	.option("--no-lint", "Disable qianji lint repair loop")
	.option("-e, --extension <path>", "Load an extra pi extension (repeatable)", collect, [])
	.action(async (skillPath: string, options: {
		output?: string;
		model?: string;
		provider?: string;
		apiKey?: string;
		qianji?: string;
		lintRetries?: string;
		lint?: boolean;
		extension?: string[];
	}) => {
		try {
			const skillContent = readFileSync(skillPath, "utf-8");
			const outputPath = options.output ?? skillPath.replace(/\.md$/, ".bpmn");

			if (!options.model) {
				console.error("Error: --model is required");
				process.exit(1);
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
				console.error("Compilation failed:");
				result.errors?.forEach((e) => console.error(`  - ${e}`));
				process.exit(1);
			}

			writeFileSync(outputPath, result.bpmnXml!);
			console.log(`Compiled BPMN to ${outputPath}`);
			if (result.dmnXml) {
				const dmnOutputPath = replaceExtension(outputPath, ".dmn");
				writeFileSync(dmnOutputPath, result.dmnXml);
				console.log(`Compiled DMN to ${dmnOutputPath}`);
			}
			process.exit(0);
		} catch (err) {
			console.error("Error:", err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
	});

function collect(value: string, prev: string[]): string[] {
	return prev.concat([value]);
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

program.parse();
