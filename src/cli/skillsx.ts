#!/usr/bin/env node
import { readFileSync } from "fs";
import { program } from "commander";
import { execute } from "../executor/executor.js";
import { GraphView } from "../output/graph-view.js";
import { createRenderer } from "../output/renderer.js";
import { resolveModel } from "./model-resolver.js";

program
	.name("skillsx")
	.description("Execute a compiled BPMN workflow")
	.argument("<workflow>", "Path to .bpmn workflow file")
	.option("--model <model>", "Model to use for execution")
	.option("--provider <provider>", "LLM provider")
	.option("--api-key <key>", "API key (overrides env vars)")
	.option("--var <pairs...>", "Variables as key=value pairs")
	.option("--no-graph", "Disable graph visualization")
	.action(async (workflowPath: string, options: { model?: string; provider?: string; apiKey?: string; var?: string[]; graph?: boolean }) => {
		try {
			const source = readFileSync(workflowPath, "utf-8");

			if (!options.model) {
				console.error("Error: --model is required");
				process.exit(1);
			}

			const { model, apiKey } = await resolveModel(options.model, options.provider, options.apiKey);
			const renderer = createRenderer();
			const graphView = options.graph !== false ? new GraphView() : undefined;

			console.log(`Executing ${workflowPath} using ${model.provider}/${model.id}...\n`);

			const result = await execute({
				source,
				model,
				apiKey,
				cwd: process.cwd(),
				variables: options.var,
				graphView,
				onAgentEvent: renderer.onAgentEvent,
				onActivityStart: renderer.onNodeStart,
				onActivityEnd: renderer.onNodeEnd,
				onFlowTake: renderer.onFlowTake,
				onError: renderer.onError,
			});

			if (!result.success) {
				console.error(`\nExecution failed: ${result.error}`);
				process.exit(1);
			}

			console.log("\nWorkflow completed successfully.");
			renderer.printVariables(result.variables);
		} catch (err) {
			console.error("Error:", err instanceof Error ? err.message : String(err));
			process.exit(1);
		}
	});

program.parse();
