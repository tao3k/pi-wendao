import { readFileSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  DmnPath,
  EventFixturePath,
  HostFixturePath,
  InstanceId,
  TraceFrameDelayMs,
  WorkflowPath,
} from "../types/domain.js";
import type { PiWendaoThinkingLevel } from "../executor/agent-runtime-types.js";
import { execute } from "../executor/executor.js";
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
import { runWorkflowLintPreflight } from "./workflow-runner/preflight.js";
import { resolveQianjiWorkflowServerUrl } from "./workflow-runner/server-url.js";

export interface PiWendaoWorkflowOptions {
  process?: string;
  instanceId?: InstanceId;
  startAtNode?: string;
  qianji?: string;
  qianjiWorkflowServerUrl?: string;
  qianjiWorkflowStartMode?: "resume-or-start" | "start";
  contextJson?: string;
  traceFrameMs?: TraceFrameDelayMs;
  var?: string[];
}

export interface RunWorkflowInRendererParams {
  renderer: Renderer;
  useGraph: boolean;
  resolvedWorkflowPath: WorkflowPath;
  options: PiWendaoWorkflowOptions;
  instanceId?: InstanceId;
  invocationCwd: string;
  piContextCwd: string;
  resolvedDmnPaths: DmnPath[];
  resolvedHostFixturePath?: HostFixturePath;
  resolvedEventFixturePath?: EventFixturePath;
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
  return runWorkflowInRendererInternal(params);
}

async function runWorkflowInRendererInternal(
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
      qianjiWorkflowServerUrl: resolveQianjiWorkflowServerUrl(
        params.options.qianjiWorkflowServerUrl,
      ),
      qianjiWorkflowStartMode: params.options.qianjiWorkflowStartMode,
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

export { runWorkflowLintPreflight, resolveQianjiCommand } from "./workflow-runner/preflight.js";
export { runQianjiWorkflowControlCommand } from "./workflow-runner/control.js";
export {
  appendActiveBpmnNodeLabels,
  runQianjiServerCancel,
  runQianjiServerShow,
  runQianjiShow,
} from "./workflow-runner/qianji-show.js";
export { resolveQianjiWorkflowServerUrl } from "./workflow-runner/server-url.js";

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
