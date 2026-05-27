import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultQianjiCommand, runCommand } from "./qianji-command.js";
import { runPiWendaoEffect } from "../effect.js";
import type { BpmnLintRunner, QianjiLintJsonReport } from "./types.js";
import { isObject } from "./json.js";

export function createQianjiLintRunner(options: {
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
      const result = await runPiWendaoEffect(
        runCommand(
          options.command ?? defaultQianjiCommand(),
          ["lint", `--${domain}`, path, "--llm"],
          options.cwd ?? process.cwd(),
        ),
      );
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      let qianji: QianjiLintJsonReport | undefined;
      if (domain === "bpmn") {
        const jsonResult = await runPiWendaoEffect(
          runCommand(
            options.command ?? defaultQianjiCommand(),
            ["lint", `--${domain}`, path, "--json"],
            options.cwd ?? process.cwd(),
          ),
        );
        const jsonOutput = [jsonResult.stdout, jsonResult.stderr].filter(Boolean).join("\n").trim();
        qianji = parseQianjiLintJson(jsonOutput);
      }
      return {
        success: result.exitCode === 0,
        output,
        diagnostics: { qianji: output },
        ...(qianji ? { qianji } : {}),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

function parseQianjiLintJson(output: string): QianjiLintJsonReport | undefined {
  try {
    const parsed: unknown = JSON.parse(output);
    return isObject(parsed) ? (parsed as QianjiLintJsonReport) : undefined;
  } catch {
    return undefined;
  }
}
