import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import type { Command } from "commander";
import { compileSkill, defaultCompileTraceDir } from "../compiler/compiler.js";
import { resolveModel } from "./model-resolver.js";
import { parseNonNegativeInt } from "./number-options.js";

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

export function registerCompileCommand(program: Command): void {
  program
    .command("compile")
    .description("Compile an agent skill into a qianji BPMN workflow")
    .argument("<skill>", "Path to SKILL.md file")
    .option("-o, --output <file>", "Output BPMN file path")
    .option("--model <model>", "Model to use (e.g., anthropic/<model-id>)")
    .option("--provider <provider>", "LLM provider")
    .option("--api-key <key>", "API key override for model resolution")
    .option(
      "--qianji <command>",
      "Qianji CLI command for templates and compile lint (default: QIANJI_CLI, workspace target/debug/qianji, or qianji on PATH)",
    )
    .option(
      "--lint-retries <count>",
      "Model repair attempts after qianji lint failure",
      "2",
    )
    .option("--no-lint", "Disable qianji lint repair loop")
    .option(
      "-e, --extension <path>",
      "Load an extra pi extension (repeatable)",
      collect,
      [],
    )
    .action(async (skillPath: string, options: PiWendaoCompileOptions) => {
      try {
        await runCompileCommand(skillPath, options);
        process.exit(0);
      } catch (err) {
        console.error(
          "Error:",
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    });
}

function collect(value: string, prev: string[]): string[] {
  return prev.concat([value]);
}

async function runCompileCommand(
  skillPath: string,
  options: PiWendaoCompileOptions,
): Promise<void> {
  const skillContent = readFileSync(skillPath, "utf-8");
  const outputPath = options.output ?? skillPath.replace(/\.md$/, ".bpmn");

  if (!options.model) {
    throw new Error("--model is required");
  }

  const { model, apiKey, headers } = await resolveModel(
    options.model,
    options.provider,
    options.apiKey,
    options.extension,
  );

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
    lint:
      options.lint === false
        ? false
        : {
            command: options.qianji,
            maxRepairAttempts: parseNonNegativeInt(
              options.lintRetries,
              "--lint-retries",
            ),
            traceDir: defaultCompileTraceDir(process.cwd()),
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

function replaceExtension(path: string, extension: string): string {
  const currentExtension = extname(path);
  return currentExtension
    ? `${path.slice(0, -currentExtension.length)}${extension}`
    : `${path}${extension}`;
}
