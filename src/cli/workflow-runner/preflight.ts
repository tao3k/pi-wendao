import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { streamSimple, type Message } from "@earendil-works/pi-ai";
import { extractArtifactBundle, extractAssistantText } from "../../compiler/artifacts.js";
import { lintPiWendaoWorkflowContract } from "../../compiler/contract-lint.js";
import { resolveDefaultQianjiCommand } from "../../qianji-command-resolution.js";
import type { Renderer } from "../../ui/renderer.js";
import { shellQuote } from "./qianji-show.js";
import type {
  WorkflowLintPreflightParams,
  WorkflowLintPreflightResult,
  WorkflowRepairModel,
} from "../workflow-runner.js";

const LINT_CACHE_VERSION = "pi-wendao-qianji-contract-lint-success-v2";

export async function runWorkflowLintPreflight(
  params: WorkflowLintPreflightParams,
): Promise<WorkflowLintPreflightResult> {
  const command = resolveQianjiCommand(params.qianjiCommand);
  const maxRepairAttempts = params.maxRepairAttempts ?? 2;
  let workflowPath = params.resolvedWorkflowPath;
  let repaired = false;

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
    const lintCache = buildLintPreflightCache({
      command,
      workflowPath,
      dmnPaths: params.resolvedDmnPaths,
      cwd: params.cwd,
    });
    if (lintCache && existsSync(lintCache.path)) {
      params.renderer.appendLog(
        repaired
          ? `qianji lint preflight cache hit after repair: ${workflowPath}`
          : "qianji lint preflight cache hit",
      );
      return { success: true, workflowPath, repaired };
    }

    const lint = await runBpmnPreflightLint({
      command,
      workflowPath,
      cwd: params.cwd,
    });
    if (lint.success) {
      const dmnLint = await lintDmnPreflight(command, params.resolvedDmnPaths, params.cwd);
      if (!dmnLint.success) {
        params.renderer.appendLog(dmnLint.output);
        return { success: false };
      }
      await writeLintPreflightCache(lintCache);
      params.renderer.appendLog(
        repaired
          ? `qianji lint preflight passed after repair: ${workflowPath}`
          : "qianji lint preflight passed",
      );
      return { success: true, workflowPath, repaired };
    }

    if (attempt >= maxRepairAttempts || !params.resolveRepairModel) {
      appendPreflightFailure(params.renderer, workflowPath, lint.output);
      return { success: false };
    }

    const repairAttempt = attempt + 1;
    params.renderer.appendLog(
      `qianji lint preflight failed; requesting BPMN repair ${repairAttempt}/${maxRepairAttempts}`,
    );
    const repairModel = await params.resolveRepairModel();
    if (!repairModel) {
      appendPreflightFailure(params.renderer, workflowPath, lint.output);
      return { success: false };
    }
    const repairedXml = await requestWorkflowRepair({
      repairModel,
      workflowPath,
      diagnostic: lint.output,
    });
    if (!repairedXml) {
      params.renderer.appendLog(
        [
          `qianji lint preflight repair ${repairAttempt}/${maxRepairAttempts} did not return BPMN XML.`,
          lint.output,
          "Workflow was not started.",
        ].join("\n"),
      );
      return { success: false };
    }
    workflowPath = await writeRepairedWorkflow(
      params.cwd,
      params.resolvedWorkflowPath,
      repairedXml,
    );
    repaired = true;
    params.renderer.appendLog(`qianji lint preflight wrote repaired BPMN: ${workflowPath}`);
  }

  return { success: false };
}

interface LintPreflightCache {
  path: string;
  fingerprint: string;
}

function buildLintPreflightCache(options: {
  command: string;
  workflowPath: string;
  dmnPaths: string[];
  cwd: string;
}): LintPreflightCache | undefined {
  if (process.env.PI_WENDAO_DISABLE_LINT_CACHE === "1") return undefined;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        version: LINT_CACHE_VERSION,
        command: options.command,
        commandFiles: commandFileIdentities(options.command, options.cwd),
        files: [options.workflowPath, ...options.dmnPaths].map((path) =>
          fileContentIdentity(path, options.cwd),
        ),
      }),
    )
    .digest("hex");
  return {
    fingerprint,
    path: join(resolvePiWendaoCacheHome(options.cwd), "lint-cache", `${fingerprint}.json`),
  };
}

async function writeLintPreflightCache(cache: LintPreflightCache | undefined): Promise<void> {
  if (!cache) return;
  try {
    await mkdir(dirname(cache.path), { recursive: true });
    await writeFile(
      cache.path,
      `${JSON.stringify(
        {
          version: LINT_CACHE_VERSION,
          fingerprint: cache.fingerprint,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  } catch {
    // Lint cache is an optimization; preflight success must not depend on it.
  }
}

function resolvePiWendaoCacheHome(cwd: string): string {
  const root = process.env.PRJ_CACHE_HOME?.trim();
  const cacheRoot = root ? resolvePath(cwd, root) : resolvePath(cwd, ".cache");
  return join(cacheRoot, "pi-wendao");
}

function fileContentIdentity(path: string, cwd: string): Record<string, unknown> {
  const resolved = resolvePath(cwd, path);
  const content = readFileSync(resolved);
  const stat = statSync(resolved);
  return {
    path: resolved,
    size: stat.size,
    hash: createHash("sha256").update(content).digest("hex"),
  };
}

function commandFileIdentities(command: string, cwd: string): Array<Record<string, unknown>> {
  const words = splitShellWords(command);
  const identities: Array<Record<string, unknown>> = [];
  for (const [index, word] of words.entries()) {
    const resolved = resolveCommandWordPath(word, cwd, index === 0);
    if (!resolved || !existsSync(resolved)) continue;
    const stat = statSync(resolved);
    if (!stat.isFile()) continue;
    identities.push({
      path: resolved,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
  return identities;
}

function resolveCommandWordPath(
  word: string,
  cwd: string,
  searchPath: boolean,
): string | undefined {
  if (!word) return undefined;
  if (word.includes("/")) return resolvePath(cwd, word);
  if (!searchPath) return undefined;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = resolvePath(dir, word);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function splitShellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;
  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

async function runBpmnPreflightLint(options: {
  command: string;
  workflowPath: string;
  cwd: string;
}): Promise<{ success: true } | { success: false; output: string }> {
  const qianji = await runQianjiLint({
    command: options.command,
    args: ["lint", "--bpmn", options.workflowPath, "--llm"],
    cwd: options.cwd,
  });
  const qianjiOutput = [qianji.stdout, qianji.stderr].filter(Boolean).join("\n").trim();
  if (qianji.exitCode !== 0) {
    return { success: false, output: qianjiOutput };
  }

  const contract = lintPiWendaoWorkflowContract(readFileSync(options.workflowPath, "utf-8"), {
    cwd: options.cwd,
  });
  if (contract.success) return { success: true };

  const output = [
    qianjiOutput ? `qianji lint --llm:\n${qianjiOutput}` : "qianji lint --llm passed.",
    "pi-wendao BPMN contract:",
    contract.output,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { success: false, output };
}

async function lintDmnPreflight(
  command: string,
  dmnPaths: string[],
  cwd: string,
): Promise<{ success: true } | { success: false; output: string }> {
  for (const path of dmnPaths) {
    const result = await runQianjiLint({
      command,
      args: ["lint", "--dmn", path, "--llm"],
      cwd,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (result.exitCode !== 0) {
      return {
        success: false,
        output: [`qianji lint preflight failed for ${path}`, output, "Workflow was not started."]
          .filter(Boolean)
          .join("\n"),
      };
    }
  }
  return { success: true };
}

function appendPreflightFailure(
  renderer: Pick<Renderer, "appendLog">,
  workflowPath: string,
  output: string,
): void {
  renderer.appendLog(
    [`qianji lint preflight failed for ${workflowPath}`, output, "Workflow was not started."]
      .filter(Boolean)
      .join("\n"),
  );
}

async function requestWorkflowRepair(options: {
  repairModel: WorkflowRepairModel;
  workflowPath: string;
  diagnostic: string;
}): Promise<string | undefined> {
  const currentXml = readFileSync(options.workflowPath, "utf-8");
  const messages: Message[] = [
    {
      role: "user",
      timestamp: Date.now(),
      content: buildWorkflowRepairPrompt(options.workflowPath, currentXml, options.diagnostic),
    },
  ];
  const stream = streamSimple(
    options.repairModel.model,
    {
      systemPrompt: WORKFLOW_REPAIR_SYSTEM_PROMPT,
      messages,
    },
    {
      apiKey: options.repairModel.apiKey,
      headers: options.repairModel.headers,
    },
  );
  const assistant = await stream.result();
  if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
    throw new Error(assistant.errorMessage ?? `BPMN repair model stopped: ${assistant.stopReason}`);
  }
  return extractArtifactBundle(extractAssistantText(assistant), "bpmn")?.bpmnXml;
}

const WORKFLOW_REPAIR_SYSTEM_PROMPT = `You are the pi-wendao BPMN preflight repair agent.

qianji lint is the authority. Apply the smallest BPMN-local change required by
the compact diagnostic. Preserve workflow ids, task semantics, qianji namespace
contracts, and unrelated XML.

Return the complete corrected BPMN XML only. Do not return a diff or prose.`;

function buildWorkflowRepairPrompt(
  workflowPath: string,
  currentXml: string,
  diagnostic: string,
): string {
  return `The BPMN workflow failed qianji lint before execution.

The diagnostic may include a proposed patch or "Return unified diff only" text
for external repair loops. For pi-wendao preflight repair, apply the diagnostic
yourself and return the full corrected BPMN XML only.

Workflow path:
${workflowPath}

Compact qianji lint diagnostic:
\`\`\`text
${diagnostic}
\`\`\`

Current BPMN XML:
\`\`\`bpmn
${currentXml}
\`\`\``;
}

async function writeRepairedWorkflow(
  cwd: string,
  originalWorkflowPath: string,
  xml: string,
): Promise<string> {
  const root = process.env.PRJ_CACHE_HOME
    ? resolvePath(cwd, process.env.PRJ_CACHE_HOME)
    : resolvePath(cwd, ".cache");
  const dir = join(root, "pi-wendao", "repaired-workflows");
  await mkdir(dir, { recursive: true });
  const hash = createHash("sha256")
    .update(originalWorkflowPath)
    .update("\0")
    .update(xml)
    .digest("hex")
    .slice(0, 12);
  const name = basename(originalWorkflowPath).replace(/\.bpmn$/i, "");
  const path = join(dir, `${name}-${hash}.bpmn`);
  await writeFile(path, xml.endsWith("\n") ? xml : `${xml}\n`, "utf-8");
  return path;
}

export function resolveQianjiCommand(explicitCommand: string | undefined): string {
  return explicitCommand ?? resolveDefaultQianjiCommand(process.cwd());
}

function runQianjiLint(options: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const commandLine = [options.command, ...options.args.map(shellQuote)].join(" ");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandLine, {
      cwd: options.cwd,
      shell: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolvePromise({ exitCode, stdout, stderr });
    });
  });
}
