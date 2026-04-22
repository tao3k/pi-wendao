#!/usr/bin/env node
import { readFileSync, writeFileSync } from "fs";
import { program } from "commander";
import { compileSkill } from "../compiler/compiler.js";
import { resolveModel } from "./model-resolver.js";

program
	.name("skillsc")
	.description("Compile an agent skill into a BPMN 2.0 workflow")
	.argument("<skill>", "Path to SKILL.md file")
	.option("-o, --output <file>", "Output BPMN file path")
	.option("--model <model>", "Model to use (e.g., anthropic/claude-sonnet-4-20250514)")
	.option("--provider <provider>", "LLM provider")
	.option("--api-key <key>", "API key (overrides env vars)")
	.action(async (skillPath: string, options: { output?: string; model?: string; provider?: string; apiKey?: string }) => {
		try {
			const skillContent = readFileSync(skillPath, "utf-8");
			const outputPath = options.output ?? skillPath.replace(/\.md$/, ".bpmn");

			if (!options.model) {
				console.error("Error: --model is required");
				process.exit(1);
			}

			const { model, apiKey } = await resolveModel(options.model, options.provider, options.apiKey);

			console.log(`Compiling ${skillPath} using ${model.provider}/${model.id}...`);

			const result = await compileSkill({
				skillContent,
				model,
				apiKey,
			});

			if (!result.success) {
				console.error("Compilation failed:");
				result.errors?.forEach((e) => console.error(`  - ${e}`));
				process.exit(1);
			}

			writeFileSync(outputPath, result.bpmnXml!);
			console.log(`Compiled to ${outputPath}`);
		} catch (err) {
			console.error("Error:", err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
	});

program.parse();
