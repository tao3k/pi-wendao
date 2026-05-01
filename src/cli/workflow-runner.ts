import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { streamSimple, type Message, type Model } from "@mariozechner/pi-ai";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { PiWendaoThinkingLevel } from "../executor/agent-runtime-types.js";
import { execute } from "../executor/executor.js";
import { extractArtifactBundle, extractAssistantText } from "../compiler/artifacts.js";
import { lintPiWendaoWorkflowContract } from "../compiler/contract-lint.js";
import {
  formatPiSubagentsHostEventForLog,
  formatPiSubagentsHostToolEventForGraphDetail,
  formatPiSubagentsHostToolEventForLog,
  formatPiSubagentsToolUpdateForGraphDetail,
  formatPiSubagentsToolUpdateForLog,
  formatQianjiCliOutputForLog,
  formatQianjiHostWorkEventForLog,
  type Renderer,
} from "../ui/renderer.js";
import type { ResolvedModel } from "./model-resolver.js";
import {
  createCliPiIntercomAgentTool,
  hasLoadedPiIntercomTool,
  installGlobalPiIntercomBridge,
  type PiWendaoGraphIntercomEvent,
} from "./pi-intercom.js";
import { createCliPiSubagentsHost } from "./pi-subagents.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
});
const LINT_CACHE_VERSION = "pi-wendao-qianji-contract-lint-success-v2";
const BPMN_NODE_ELEMENTS = [
  "startEvent",
  "endEvent",
  "serviceTask",
  "task",
  "userTask",
  "scriptTask",
  "businessRuleTask",
  "sendTask",
  "receiveTask",
  "manualTask",
  "callActivity",
  "subProcess",
  "exclusiveGateway",
  "parallelGateway",
  "inclusiveGateway",
  "eventBasedGateway",
  "complexGateway",
  "boundaryEvent",
  "intermediateCatchEvent",
  "intermediateThrowEvent",
];

export interface PiWendaoWorkflowOptions {
  process?: string;
  instanceId?: string;
  startAtNode?: string;
  qianji?: string;
  contextJson?: string;
  traceFrameMs?: number;
  var?: string[];
}

export interface RunWorkflowInRendererParams {
  renderer: Renderer;
  useGraph: boolean;
  resolvedWorkflowPath: string;
  options: PiWendaoWorkflowOptions;
  instanceId?: string;
  invocationCwd: string;
  piContextCwd: string;
  resolvedDmnPaths: string[];
  resolvedHostFixturePath?: string;
  resolvedEventFixturePath?: string;
  resolvedModel?: ResolvedModel;
  thinkingLevel: PiWendaoThinkingLevel;
  agentSession?: AgentSession;
  signal?: AbortSignal;
  preflightLint?: boolean;
  resolveRepairModel?: () => Promise<WorkflowRepairModel | undefined>;
  maxRepairAttempts?: number;
}

export interface WorkflowLintPreflightParams {
  renderer: Pick<Renderer, "appendLog">;
  resolvedWorkflowPath: string;
  resolvedDmnPaths: string[];
  qianjiCommand?: string;
  cwd: string;
  resolveRepairModel?: () => Promise<WorkflowRepairModel | undefined>;
  maxRepairAttempts?: number;
}

export interface WorkflowRepairModel {
  model: Model<string>;
  apiKey?: string;
  headers?: Record<string, string>;
}

export type WorkflowLintPreflightResult =
  | { success: true; workflowPath: string; repaired: boolean }
  | { success: false };

export async function runWorkflowInRenderer(
  params: RunWorkflowInRendererParams,
): Promise<{ success: boolean; interrupted?: boolean }> {
  const renderer = params.renderer;
  let workflowPath = params.resolvedWorkflowPath;
  if (params.preflightLint !== false) {
    const lint = await runWorkflowLintPreflight({
      renderer,
      resolvedWorkflowPath: params.resolvedWorkflowPath,
      resolvedDmnPaths: params.resolvedDmnPaths,
      qianjiCommand: params.options.qianji,
      cwd: params.invocationCwd,
      resolveRepairModel: params.resolveRepairModel,
      maxRepairAttempts: params.maxRepairAttempts,
    });
    if (!lint.success) return { success: false };
    workflowPath = lint.workflowPath;
  }
  const source = readFileSync(workflowPath, "utf-8");
  const appendSubagentUpdate = createSubagentUpdateAppender((line) => renderer.appendLog(line));
  installGlobalPiIntercomBridge(
    params.resolvedModel
      ? {
          requestPlannerReply: async (request, signal) => {
            if (params.useGraph && request.context?.activityId) {
              updateSubagentGraphDetail(
                renderer.graphView,
                request.context.activityId,
                "intercom:awaiting planner",
              );
              renderer.refresh();
            }
            const answer = await renderer.requestPlannerReply(request, signal);
            if (params.useGraph && request.context?.activityId) {
              updateSubagentGraphDetail(
                renderer.graphView,
                request.context.activityId,
                "intercom:planner replied",
              );
              renderer.refresh();
            }
            return answer;
          },
          onEvent: (event) => {
            for (const line of formatGraphIntercomEventForLog(event)) {
              renderer.appendLog(line);
            }
          },
        }
      : undefined,
  );

  try {
    const piSubagentsHost = params.resolvedModel
      ? createCliPiSubagentsHost({
          loadResult: params.resolvedModel.loadResult,
          modelRegistry: params.resolvedModel.modelRegistry,
          model: params.resolvedModel.model,
          session: params.agentSession,
          cwd: params.piContextCwd,
          signal: params.signal,
          onUpdate: (event) => {
            const detail = formatPiSubagentsToolUpdateForGraphDetail(event.update);
            if (detail && params.useGraph) {
              updateSubagentGraphDetail(renderer.graphView, event.activityId, detail);
              renderer.refresh();
            }
            for (const line of formatPiSubagentsToolUpdateForLog(event.update, {
              activityId: event.activityId,
            })) {
              appendSubagentUpdate(line);
            }
          },
          onEvent: (event) => {
            for (const line of formatPiSubagentsHostEventForLog(event)) {
              renderer.appendLog(line);
            }
          },
          onToolEvent: (event) => {
            const detail = formatPiSubagentsHostToolEventForGraphDetail(event);
            if (detail && params.useGraph) {
              updateSubagentGraphDetail(renderer.graphView, event.activityId, detail);
              renderer.refresh();
            }
            for (const line of formatPiSubagentsHostToolEventForLog(event)) {
              renderer.appendLog(line);
            }
          },
        })
      : undefined;
    if (piSubagentsHost) {
      renderer.appendLog("Host backend: pi-subagents");
    }

    const piIntercomAvailable = params.resolvedModel
      ? hasLoadedPiIntercomTool(params.resolvedModel.loadResult)
      : false;
    const piIntercomTool =
      params.resolvedModel && !piSubagentsHost
        ? createCliPiIntercomAgentTool({
            loadResult: params.resolvedModel.loadResult,
            modelRegistry: params.resolvedModel.modelRegistry,
            model: params.resolvedModel.model,
            cwd: params.piContextCwd,
          })
        : undefined;
    if (piIntercomTool) {
      renderer.appendLog("Agent tool: pi-intercom");
    } else if (piIntercomAvailable && piSubagentsHost) {
      renderer.appendLog("Extension tool: pi-intercom");
    }

    const result = await execute({
      source,
      sourcePath: workflowPath,
      processId: params.options.process,
      instanceId: params.instanceId,
      startAtNode: params.options.startAtNode,
      qianjiCommand: params.options.qianji,
      dmnPaths: params.resolvedDmnPaths,
      hostFixturePath: params.resolvedHostFixturePath,
      eventFixturePath: params.resolvedEventFixturePath,
      context: parseContextJson(params.options.contextJson),
      model: piSubagentsHost ? undefined : params.resolvedModel?.model,
      apiKey: piSubagentsHost ? undefined : params.resolvedModel?.apiKey,
      thinkingLevel: params.thinkingLevel,
      agentHost: piSubagentsHost,
      humanTaskHandler: async (request) => {
        if (params.useGraph) {
          updateSubagentGraphDetail(renderer.graphView, request.activityId, "user:awaiting input");
          renderer.refresh();
        }
        renderer.appendLog(`human task ${request.activityId}`);
        const answer = await renderer.requestPlannerReply(
          {
            toolCallId: `human:${request.execution?.tokenId ?? request.activityId}:${Date.now()}`,
            action: "human_task",
            to: "user",
            message: request.config.prompt || `Provide input for ${request.activityId}.`,
            interaction: request.config.interaction,
            context: {
              activityId: request.activityId,
              description: "BPMN user task",
            },
          },
          params.signal,
        );
        if (params.useGraph) {
          updateSubagentGraphDetail(renderer.graphView, request.activityId, "user:answered");
          renderer.refresh();
        }
        return answer;
      },
      hostBackend: piSubagentsHost ? "pi-subagents" : params.resolvedModel ? "pi-ai" : undefined,
      agentTools: piIntercomTool ? [piIntercomTool] : undefined,
      traceFrameDelayMs: params.options.traceFrameMs,
      cwd: params.invocationCwd,
      variables: params.options.var,
      onCliOutput: (output) => {
        for (const line of formatQianjiCliOutputForLog(output)) {
          renderer.appendLog(line);
        }
      },
      onHostWork: (event) => {
        for (const line of formatQianjiHostWorkEventForLog(event)) {
          renderer.appendLog(line);
        }
      },
      onAgentEvent: (event) => renderer.onAgentEvent(event),
      graphView: params.useGraph ? renderer.graphView : undefined,
      onGraphReady: () => renderer.refresh(),
      onGraphUpdate: () => renderer.refresh(),
      onTraceEvent: (event) => renderer.onTraceEvent(event),
      onFlowTake: (flowId) => renderer.onFlowTake(flowId),
      onError: (error) => renderer.onError(error),
      signal: params.signal,
    });

    if (result.interrupted) {
      renderer.appendLog("\nWorkflow interrupted. Qianji checkpoint state was preserved.");
    } else if (!result.success) {
      renderer.appendLog(`\nExecution failed: ${result.error}`);
    } else {
      renderer.appendLog("\nWorkflow completed successfully.");
      renderer.printVariables(result.variables);
    }
    return result.interrupted
      ? { success: result.success, interrupted: true }
      : { success: result.success };
  } finally {
    installGlobalPiIntercomBridge(undefined);
  }
}

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
    workflowPath = await writeRepairedWorkflow(params.cwd, params.resolvedWorkflowPath, repairedXml);
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
        output: [
          `qianji lint preflight failed for ${path}`,
          output,
          "Workflow was not started.",
        ]
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
  return explicitCommand ?? process.env.QIANJI_CLI ?? "qianji";
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

export function runQianjiShow(options: {
  command: string;
  instanceId?: string;
  workflowPath?: string;
  dmnPaths: string[];
  cwd: string;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const args = options.instanceId
    ? ["bpmn", "status", "--instance-id", options.instanceId]
    : ["bpmn", "instances"];
  if (options.instanceId) {
    if (options.workflowPath) {
      args.push("--bpmn", options.workflowPath);
    }
    for (const dmnPath of options.dmnPaths) {
      args.push("--dmn", dmnPath);
    }
  }
  const commandLine = [options.command, ...args.map(shellQuote)].join(" ");
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

export function appendActiveBpmnNodeLabels(
  output: string,
  source: string,
  processId?: string,
): string {
  const graphSnapshotIndex = output.indexOf("## Graph Snapshot");
  const statusHeader = graphSnapshotIndex === -1 ? output : output.slice(0, graphSnapshotIndex);
  const activeNodeIds = Array.from(statusHeader.matchAll(/\bnode_id=([A-Za-z][A-Za-z0-9_.:-]*)/g))
    .map((match) => match[1])
    .filter((nodeId, index, nodeIds) => nodeIds.indexOf(nodeId) === index);
  if (activeNodeIds.length === 0) return output;

  const labels = buildBpmnNodeLabelMap(source, processId);
  const lines = activeNodeIds.map((nodeId) => {
    const label = labels.get(nodeId);
    return label && label !== nodeId ? `- ${nodeId} | ${label}` : `- ${nodeId}`;
  });
  return `${output.trimEnd()}\n\n## Active BPMN Nodes\n${lines.join("\n")}\n`;
}

function formatGraphIntercomEventForLog(event: PiWendaoGraphIntercomEvent): string[] {
  if (event.type === "intercom_call") return [];
  const target = event.to ? ` -> ${event.to}` : "";
  const message = event.message?.trim();
  switch (event.type) {
    case "intercom_send":
      return [
        `intercom send${target}`,
        ...(message ? [`  message: ${compactLogLine(message)}`] : []),
      ];
    case "intercom_reply":
      return [
        `intercom reply${target}`,
        ...(message ? [`  message: ${compactLogLine(message)}`] : []),
      ];
    case "intercom_answer":
      return [
        `intercom answered${target}`,
        ...(message ? [`  message: ${compactLogLine(message)}`] : []),
      ];
    default:
      return [];
  }
}

function compactLogLine(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 160) return compact;
  return `${compact.slice(0, 157)}...`;
}

function parseContextJson(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--context-json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function createSubagentUpdateAppender(append: (line: string) => void): (line: string) => void {
  let lastLine = "";
  let lastAt = 0;
  return (line: string) => {
    const now = Date.now();
    if (line === lastLine && now - lastAt < 5_000) return;
    if (line !== lastLine && now - lastAt < 500) return;
    lastLine = line;
    lastAt = now;
    append(line);
  };
}

function updateSubagentGraphDetail(
  graphView: Renderer["graphView"],
  activityId: string,
  detail: string,
): void {
  const details = graphView.getNodeDetails(activityId);
  if (detail.startsWith("llm:") && details.some((line) => line.startsWith("tool:"))) return;
  graphView.setNodeDetails(activityId, [
    detail,
    ...details.filter((line) => !line.startsWith("llm:") && !line.startsWith("tool:")),
  ]);
}

function buildBpmnNodeLabelMap(source: string, processId?: string): Map<string, string> {
  const document = parser.parse(source) as { definitions?: { process?: unknown } };
  const process = findProcess(document.definitions?.process, processId);
  const labels = new Map<string, string>();
  if (!process) return labels;
  for (const elementName of BPMN_NODE_ELEMENTS) {
    for (const node of asArray(process[elementName])) {
      if (!isObject(node)) continue;
      const id = readString(node.id);
      if (!id) continue;
      labels.set(id, readString(node.name) || id);
    }
  }
  return labels;
}

function findProcess(processes: unknown, processId?: string): Record<string, unknown> | undefined {
  for (const process of asArray(processes)) {
    if (!isObject(process)) continue;
    const id = readString(process.id);
    if (!id) continue;
    if (!processId || id === processId) return process;
  }
  return undefined;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
