import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Effect } from "effect";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai";
import type { CompileTargetDecision } from "./prompt.js";
import type { CompileTemplates } from "./qianji-template.js";
import type {
  BpmnLintResult,
  CompileArtifactBundle,
  CompileArtifactLintRunners,
  CompileLintOptions,
  CompileOptions,
  CompileResult,
} from "./types.js";
import {
  extractArtifactBundle,
  extractAssistantText,
  missingArtifactMessage,
  renderArtifactBundleForPrompt,
} from "./artifacts.js";
import { effectFromPromise, type PiWendaoEffectError } from "../effect.js";

export function compileWithLintAgent(
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
): Effect.Effect<CompileResult, PiWendaoEffectError> {
  return effectFromPromise("compileWithLintAgent", () =>
    compileWithLintAgentPromise(options, args),
  );
}

async function compileWithLintAgentPromise(
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
  const trace = await createCompileRepairTrace(lintOptions.traceDir);
  if (trace) {
    lintOptions.onMessage?.(`qianji compile repair trace: ${trace.dir}`);
    await trace.writeText("target-decision.json", `${JSON.stringify(targetDecision, null, 2)}\n`);
  }
  let lastArtifacts: CompileArtifactBundle | undefined;
  let lastLintOutput = "";
  for (let repairAttempt = 0; repairAttempt <= maxRepairAttempts; repairAttempt += 1) {
    const prompt =
      repairAttempt === 0
        ? buildAgentCompilePrompt(args.userMessage, targetDecision)
        : buildLintRepairPrompt(
            args.templates,
            targetDecision,
            lastArtifacts,
            lastLintOutput,
            repairAttempt,
          );

    const userMessage: Message = { role: "user", content: prompt, timestamp: Date.now() };
    messages.push(userMessage);
    const assistant = await requestAssistantMessage(options, systemPrompt, messages);
    messages.push(assistant);
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      return {
        success: false,
        errors: [assistant.errorMessage ?? `Model stopped: ${assistant.stopReason}`],
      };
    }

    const text = extractAssistantText(assistant);
    const artifacts = extractArtifactBundle(text, targetDecision.target);
    if (!artifacts) {
      return {
        success: false,
        targetDecision,
        errors: [missingArtifactMessage(targetDecision.target)],
      };
    }

    lastArtifacts = artifacts;
    await trace?.writeArtifacts(repairAttempt, artifacts);
    const lint = await lintArtifactBundle(artifacts, lintRunners);
    await trace?.writeLint(repairAttempt, lint);
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
        errors: [
          `qianji lint failed after ${maxRepairAttempts} repair attempt(s):\n${lint.output}`,
        ],
      };
    }

    const nextAttempt = repairAttempt + 1;
    lintOptions.onMessage?.(
      `qianji lint failed; requesting model repair ${nextAttempt}/${maxRepairAttempts}`,
    );
    lastLintOutput = lint.output;
  }

  return {
    success: false,
    targetDecision,
    errors: ["qianji lint repair loop ended without valid qianji artifact(s)"],
  };
}

async function requestAssistantMessage(
  options: CompileOptions,
  systemPrompt: string,
  messages: Message[],
): Promise<AssistantMessage> {
  const stream = streamSimple(
    options.model,
    {
      systemPrompt,
      messages,
    },
    {
      apiKey: options.apiKey,
      headers: options.headers,
    },
  );
  return stream.result();
}

function buildLintRepairPrompt(
  templates: CompileTemplates,
  targetDecision: CompileTargetDecision,
  previousArtifacts: CompileArtifactBundle | undefined,
  lintOutput: string,
  attempt: number,
): string {
  return `The generated qianji artifact bundle failed qianji lint.

Repair attempt: ${attempt}

Return corrected artifact XML only. pi-wendao compile will run qianji lint after your
answer and feed any remaining diagnostic output back into this repair loop.

Apply the smallest artifact-local change required by the compact diagnostic.
Keep unrelated XML tags, ids, extension config, and task semantics stable.
Treat related construct cards named by diagnostics as the executable contract;
do not invent hidden rules beyond qianji lint, pi-wendao diagnostics, and the
selected cards.

## Target decision

\`\`\`json
${JSON.stringify(targetDecision, null, 2)}
\`\`\`

## Selected qianji construct cards

\`\`\`markdown
${templates.constructCards ?? ""}
\`\`\`

## Compact diagnostic output

\`\`\`text
${lintOutput}
\`\`\`

## Previous artifacts

${renderArtifactBundleForPrompt(previousArtifacts)}
	`;
}

function buildAgentSystemPrompt(
  systemPrompt: string,
  targetDecision: CompileTargetDecision,
): string {
  return `${systemPrompt}

You are running inside the pi-wendao compile agent loop.

Protocol:
- Draft complete qianji artifact XML for target ${targetDecision.target}.
- pi-wendao compile will run qianji lint after every draft and feed compact
  diagnostic output back to you when repair is needed.
- Final output must contain only the required code block(s), with no explanation.
	`;
}

function buildAgentCompilePrompt(
  userMessage: string,
  targetDecision: CompileTargetDecision,
): string {
  return `${userMessage}

Generate target ${targetDecision.target}. pi-wendao compile will run the qianji lint step
after your response and will ask you to repair any compact diagnostic failure.`;
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
      diagnostics: {
        ...(bpmnLint.diagnostics ?? { qianji: bpmnLint.output }),
        dmn: "No qianji lint runner configured for DMN",
      },
    };
  }
  const dmnLint =
    artifacts.dmnXml && lintRunners.dmn ? await lintRunners.dmn(artifacts.dmnXml) : undefined;

  const outputs = [
    "# BPMN lint",
    bpmnLint.output.trim() || (bpmnLint.success ? "PASS" : "FAIL"),
    dmnLint ? "# DMN lint" : undefined,
    dmnLint ? dmnLint.output.trim() || (dmnLint.success ? "PASS" : "FAIL") : undefined,
  ].filter((line): line is string => Boolean(line));

  return {
    success: bpmnLint.success && (dmnLint?.success ?? true),
    output: outputs.join("\n\n"),
    diagnostics: {
      ...(bpmnLint.diagnostics ?? { qianji: bpmnLint.output }),
      ...(dmnLint ? { dmn: dmnLint.output } : {}),
    },
  };
}

interface CompileRepairTrace {
  dir: string;
  writeText(name: string, content: string): Promise<void>;
  writeArtifacts(attempt: number, artifacts: CompileArtifactBundle): Promise<void>;
  writeLint(attempt: number, lint: BpmnLintResult): Promise<void>;
}

async function createCompileRepairTrace(
  traceDir: string | false | undefined,
): Promise<CompileRepairTrace | undefined> {
  if (!traceDir) return undefined;
  await mkdir(traceDir, { recursive: true });
  const dir = await mkdtemp(join(traceDir, "compile-"));
  const writeText = async (name: string, content: string) => {
    await writeFile(join(dir, name), content, "utf-8");
  };
  return {
    dir,
    writeText,
    async writeArtifacts(attempt, artifacts) {
      await writeText(`attempt-${attempt}.bpmn`, `${artifacts.bpmnXml.trim()}\n`);
      if (artifacts.dmnXml) {
        await writeText(`attempt-${attempt}.dmn`, `${artifacts.dmnXml.trim()}\n`);
      }
    },
    async writeLint(attempt, lint) {
      await writeText(`lint-${attempt}.txt`, `${lint.output.trim()}\n`);
      if (lint.diagnostics?.qianji) {
        await writeText(`qianji-lint-${attempt}.txt`, `${lint.diagnostics.qianji.trim()}\n`);
      }
      if (lint.diagnostics?.contract) {
        await writeText(`contract-${attempt}.txt`, `${lint.diagnostics.contract.trim()}\n`);
      }
      if (lint.diagnostics?.dmn) {
        await writeText(`dmn-lint-${attempt}.txt`, `${lint.diagnostics.dmn.trim()}\n`);
      }
    },
  };
}
