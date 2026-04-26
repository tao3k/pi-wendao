import { isAbsolute, join, resolve } from "node:path";
import { streamSimple } from "@mariozechner/pi-ai";
import { extractArtifactBundle, missingArtifactMessage } from "./artifacts.js";
import { createCompileLintRunner } from "./contract-lint.js";
import { buildCompilePrompt } from "./prompt.js";
import { createQianjiLintRunner } from "./qianji-lint.js";
import {
  loadQianjiConstructCards,
  loadQianjiConstructIndex,
  loadQianjiTemplates,
} from "./qianji-template.js";
import { compileWithLintAgent } from "./repair-loop.js";
import { decideCompileTarget, selectedConstructIds } from "./target.js";
import type { CompileOptions, CompileResult, CompileTargetDecision } from "./types.js";

export type {
  BpmnLintResult,
  BpmnLintRunner,
  CompileArtifact,
  CompileLintOptions,
  CompileOptions,
  CompileResult,
  CompileTargetOptions,
  CompileTargetRunner,
  CompileTargetRunnerContext,
} from "./types.js";

export function defaultCompileTraceDir(cwd = process.cwd()): string {
  const cacheHome = process.env.PRJ_CACHE_HOME?.trim() || ".cache";
  const root = process.env.PRJ_ROOT?.trim();
  const resolvedCacheHome = isAbsolute(cacheHome) ? cacheHome : resolve(root || cwd, cacheHome);
  return join(resolvedCacheHome, "pi-wendao", "compile-traces");
}

/**
 * Compile a skill markdown file into qianji BPMN/DMN artifacts using a large model.
 */
export async function compileSkill(options: CompileOptions): Promise<CompileResult> {
  const lintOptions = options.lint === false ? undefined : (options.lint ?? {});
  const cwd = options.cwd ?? process.cwd();
  const qianjiCommand = options.template?.command ?? lintOptions?.command;

  const constructIndexResult = await loadQianjiConstructIndex({
    ...(options.template ?? {}),
    command: qianjiCommand,
    cwd,
  });
  if (!constructIndexResult.success) {
    return { success: false, errors: constructIndexResult.errors };
  }

  let targetDecision: CompileTargetDecision;
  try {
    targetDecision = await decideCompileTarget(
      options,
      options.skillContent,
      constructIndexResult.output,
    );
  } catch (err) {
    return { success: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
  options.target?.onMessage?.(`compile target: ${targetDecision.target}`);

  const templateResult = await loadQianjiTemplates(targetDecision.target, {
    ...(options.template ?? {}),
    command: qianjiCommand,
    cwd,
  });
  if (!templateResult.success) {
    return { success: false, targetDecision, errors: templateResult.errors };
  }

  const constructCardsResult = await loadQianjiConstructCards(
    selectedConstructIds(targetDecision),
    {
      ...(options.template ?? {}),
      command: qianjiCommand,
      cwd,
    },
  );
  if (!constructCardsResult.success) {
    return { success: false, targetDecision, errors: constructCardsResult.errors };
  }

  const templates = {
    ...templateResult.templates,
    constructIndex: constructIndexResult.output,
    constructCards: constructCardsResult.output,
  };
  const { systemPrompt, userMessage } = buildCompilePrompt(
    targetDecision,
    options.skillContent,
    templates,
  );
  if (!lintOptions) {
    return requestArtifacts(options, systemPrompt, userMessage, targetDecision);
  }

  const bpmnLintRunner = createCompileLintRunner(
    lintOptions.runner ??
      createQianjiLintRunner({
        command: lintOptions.command,
        cwd: options.cwd,
        domain: "bpmn",
      }),
    { cwd: options.cwd ?? process.cwd() },
  );
  const dmnLintRunner =
    targetDecision.target === "bpmn-dmn"
      ? (lintOptions.dmnRunner ??
        createQianjiLintRunner({
          command: lintOptions.command,
          cwd: options.cwd,
          domain: "dmn",
        }))
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

async function requestArtifacts(
  options: CompileOptions,
  systemPrompt: string,
  userMessage: string,
  targetDecision: CompileTargetDecision,
): Promise<CompileResult> {
  const stream = streamSimple(
    options.model,
    {
      systemPrompt,
      messages: [
        { role: "user", content: [{ type: "text", text: userMessage }], timestamp: Date.now() },
      ],
    },
    {
      apiKey: options.apiKey,
      headers: options.headers,
    },
  );

  const result = await stream.result();
  const text = result.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("");

  if (result.stopReason === "error") {
    return {
      success: false,
      targetDecision,
      errors: [result.errorMessage ?? "Model returned an error"],
    };
  }

  const artifacts = extractArtifactBundle(text, targetDecision.target);
  if (!artifacts) {
    return {
      success: false,
      targetDecision,
      errors: [missingArtifactMessage(targetDecision.target)],
    };
  }

  return {
    success: true,
    bpmnXml: artifacts.bpmnXml,
    dmnXml: artifacts.dmnXml,
    artifacts: artifacts.artifacts,
    targetDecision,
  };
}
