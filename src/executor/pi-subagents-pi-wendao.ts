import { readFile } from "node:fs/promises";
import type {
  DmnPath,
  EventFixturePath,
  InstanceId,
  ProcessId,
  QianjiCommand,
  RunStorePath,
  WorkflowPath,
} from "../types/domain.js";
import type { PiSubagentsHostUpdateEvent, PiSubagentsRunStore } from "./pi-subagents-host.js";
import {
  createPiSubagentsHostFromLoadedExtensions,
  type PiLoadedExtensionsLike,
} from "./pi-subagents-runtime.js";
import { execute, type ExecuteOptions, type ExecuteResult } from "./executor.js";

export interface ExecuteBpmnWithPiSubagentsOptions {
  /** BPMN source path passed to qianji. */
  workflowPath: WorkflowPath;
  /** Optional already-loaded BPMN source. When omitted, workflowPath is read. */
  source?: string;
  /** Loaded pi extensions containing pi-subagents Agent and get_subagent_result tools. */
  loadResult: PiLoadedExtensionsLike;
  /** Active pi ExtensionContext passed to registered pi-subagents tools. */
  ctx: unknown;
  processId?: ProcessId;
  instanceId?: InstanceId;
  qianjiCommand?: QianjiCommand;
  dmnPaths?: DmnPath[];
  eventFixturePath?: EventFixturePath;
  context?: Record<string, unknown>;
  variables?: string[];
  cwd?: string;
  runStore?: PiSubagentsRunStore;
  runStorePath?: RunStorePath;
  defaultSubagentType?: string;
  defaultRunInBackground?: boolean;
  verboseResult?: boolean;
  toolCallIdPrefix?: string;
  signal?: AbortSignal;
  onUpdate?: (event: PiSubagentsHostUpdateEvent) => void;
  onCliOutput?: ExecuteOptions["onCliOutput"];
  onActivityStart?: ExecuteOptions["onActivityStart"];
  onActivityEnd?: ExecuteOptions["onActivityEnd"];
  onFlowTake?: ExecuteOptions["onFlowTake"];
  onError?: ExecuteOptions["onError"];
  graphView?: ExecuteOptions["graphView"];
  onGraphReady?: ExecuteOptions["onGraphReady"];
  onGraphUpdate?: ExecuteOptions["onGraphUpdate"];
  onTraceEvent?: ExecuteOptions["onTraceEvent"];
  traceFrameDelayMs?: ExecuteOptions["traceFrameDelayMs"];
}

export async function executeBpmnWithPiSubagents(
  options: ExecuteBpmnWithPiSubagentsOptions,
): Promise<ExecuteResult> {
  return executeBpmnWithPiSubagentsInternal(options);
}

async function executeBpmnWithPiSubagentsInternal(
  options: ExecuteBpmnWithPiSubagentsOptions,
): Promise<ExecuteResult> {
  const cwd = options.cwd ?? inferCwdFromCtx(options.ctx);
  const source = options.source ?? (await readFile(options.workflowPath, "utf-8"));
  const agentHost = createPiSubagentsHostFromLoadedExtensions({
    loadResult: options.loadResult,
    ctx: options.ctx,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.toolCallIdPrefix ? { toolCallIdPrefix: options.toolCallIdPrefix } : {}),
    ...(options.onUpdate === undefined ? {} : { onUpdate: options.onUpdate }),
    ...(options.runStore ? { runStore: options.runStore } : {}),
    ...(options.runStorePath ? { runStorePath: options.runStorePath } : {}),
    ...(options.defaultSubagentType ? { defaultSubagentType: options.defaultSubagentType } : {}),
    ...(options.defaultRunInBackground === undefined
      ? {}
      : { defaultRunInBackground: options.defaultRunInBackground }),
    ...(options.verboseResult === undefined ? {} : { verboseResult: options.verboseResult }),
  });

  return execute({
    source,
    sourcePath: options.workflowPath,
    ...(options.processId ? { processId: options.processId } : {}),
    ...(options.instanceId ? { instanceId: options.instanceId } : {}),
    ...(options.qianjiCommand ? { qianjiCommand: options.qianjiCommand } : {}),
    ...(options.dmnPaths ? { dmnPaths: options.dmnPaths } : {}),
    ...(options.eventFixturePath ? { eventFixturePath: options.eventFixturePath } : {}),
    ...(options.context ? { context: options.context } : {}),
    ...(options.variables ? { variables: options.variables } : {}),
    ...(cwd ? { cwd } : {}),
    agentHost,
    ...(options.onCliOutput ? { onCliOutput: options.onCliOutput } : {}),
    ...(options.onActivityStart ? { onActivityStart: options.onActivityStart } : {}),
    ...(options.onActivityEnd ? { onActivityEnd: options.onActivityEnd } : {}),
    ...(options.onFlowTake ? { onFlowTake: options.onFlowTake } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.graphView ? { graphView: options.graphView } : {}),
    ...(options.onGraphReady ? { onGraphReady: options.onGraphReady } : {}),
    ...(options.onGraphUpdate ? { onGraphUpdate: options.onGraphUpdate } : {}),
    ...(options.onTraceEvent ? { onTraceEvent: options.onTraceEvent } : {}),
    ...(options.traceFrameDelayMs === undefined
      ? {}
      : { traceFrameDelayMs: options.traceFrameDelayMs }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

function inferCwdFromCtx(ctx: unknown): string | undefined {
  if (typeof ctx !== "object" || ctx === null) return undefined;
  const cwd = (ctx as { cwd?: unknown }).cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
}
