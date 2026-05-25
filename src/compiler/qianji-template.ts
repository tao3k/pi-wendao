import { defaultQianjiCommand, runCommand } from "./qianji-command.js";
import type { CompileArtifactTarget } from "./prompt.js";

export interface CompileTemplates {
  bpmn: string;
  dmn?: string;
  constructIndex?: string;
  constructCards?: string;
}

export interface CompileTemplateOptions {
  /** Qianji CLI command. Defaults to QIANJI_CLI, workspace target/debug/qianji, or qianji on PATH. */
  command?: string;
  /** Test hook or custom qianji template runner. */
  runner?: QianjiTemplateRunner;
  /** Test hook or custom qianji construct-card runner. */
  constructRunner?: QianjiConstructRunner;
  /** Progress callback for template loading status. */
  onMessage?: (message: string) => void;
}

export type QianjiTemplateDomain = "bpmn" | "dmn";

export type QianjiTemplateRunner = (
  domain: QianjiTemplateDomain,
  options: { command?: string; cwd: string },
) => Promise<QianjiTemplateResult>;

export type QianjiConstructRequest = { kind: "index" } | { kind: "show"; id: string };

export type QianjiConstructRunner = (
  request: QianjiConstructRequest,
  options: { command?: string; cwd: string },
) => Promise<QianjiConstructResult>;

export type QianjiTemplateResult =
  | { success: true; template: string; output?: string }
  | { success: false; errors: string[]; output?: string };

export type QianjiConstructResult =
  | { success: true; output: string }
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

export async function loadQianjiConstructIndex(
  options: CompileTemplateOptions & { cwd: string },
): Promise<QianjiConstructResult> {
  const runner = options.constructRunner ?? createQianjiConstructRunner();
  options.onMessage?.("loading qianji construct index");
  const result = await runner({ kind: "index" }, { command: options.command, cwd: options.cwd });
  if (result.success) options.onMessage?.("qianji construct index loaded");
  return result;
}

export async function loadQianjiConstructCards(
  constructIds: string[],
  options: CompileTemplateOptions & { cwd: string },
): Promise<QianjiConstructResult> {
  const runner = options.constructRunner ?? createQianjiConstructRunner();
  const cards: string[] = [];
  for (const id of uniqueConstructIds(constructIds)) {
    options.onMessage?.(`loading qianji construct card: ${id}`);
    const result = await runner(
      { kind: "show", id },
      { command: options.command, cwd: options.cwd },
    );
    if (!result.success) return result;
    cards.push(result.output.trim());
  }
  options.onMessage?.("qianji construct cards loaded");
  return { success: true, output: cards.join("\n\n---\n\n") };
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

export function createQianjiConstructRunner(): QianjiConstructRunner {
  return async (request, options) => {
    const args =
      request.kind === "index" ? ["construct", "index"] : ["construct", "show", request.id];
    const result = await runCommand(options.command ?? defaultQianjiCommand(), args, options.cwd);
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (result.exitCode !== 0) {
      return {
        success: false,
        errors: [output || `qianji ${args.join(" ")} exited with status ${result.exitCode}`],
        output,
      };
    }
    if (!result.stdout.trim()) {
      return {
        success: false,
        errors: [`qianji ${args.join(" ")} returned empty output`],
        output,
      };
    }
    return { success: true, output: result.stdout.trim() };
  };
}

function uniqueConstructIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}
