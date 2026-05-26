import type { HostCompletionResult } from "../executor-host-loop.js";
import { throwIfWorkflowInterrupted } from "../interrupt.js";
import type { QianjiHostWork } from "../qianji-types.js";
import type {
  DmnPath,
  InstanceId,
  NodeId,
  ProcessId,
  QianjiWorkflowServerUrl,
  WorkflowPath,
} from "../../types/domain.js";

export interface QianjiServerWorkflowHttpOptions {
  serverUrl: QianjiWorkflowServerUrl;
  sourcePath: WorkflowPath;
  processId: ProcessId;
  instanceId: InstanceId;
  context: Record<string, unknown>;
  dmnPaths: DmnPath[];
  startAtNode?: NodeId;
  startMode?: "resume-or-start" | "start";
  signal?: AbortSignal;
}

export interface QianjiServerWorkflowResponse {
  outcome?: unknown;
  resumed_from_checkpoint?: boolean;
  checkpoint_saved?: boolean;
  checkpoint_deleted?: boolean;
  checkpoint_backend?: string | null;
  workflow?: QianjiServerWorkflowSnapshot;
}

interface QianjiServerWorkflowSnapshot {
  variables?: Record<string, unknown> | null;
  pending_host_work_count?: number;
  pending_host_work?: QianjiServerPendingHostWork[];
}

export interface QianjiServerPendingHostWork {
  kind?: string;
  process_id?: string | null;
  activity_id?: string | null;
  node_id?: string | null;
  node_index?: number;
  token_id?: number;
  variables?: Record<string, unknown> | null;
  inputs?: Record<string, unknown> | null;
  repeat?: unknown;
  form?: QianjiHostWork["form"];
  assignment?: QianjiHostWork["assignment"];
  claim?: QianjiHostWork["claim"];
}

class QianjiServerHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly path: string;
  readonly responseText: string;

  constructor(options: {
    status: number;
    code?: string;
    message: string;
    path: string;
    responseText: string;
  }) {
    super(options.message);
    this.name = "QianjiServerHttpError";
    this.status = options.status;
    this.code = options.code;
    this.path = options.path;
    this.responseText = options.responseText;
  }
}

export async function resumeOrStartWorkflow(
  options: QianjiServerWorkflowHttpOptions,
): Promise<QianjiServerWorkflowResponse> {
  if (options.startAtNode || options.startMode === "start") return startWorkflow(options);
  try {
    return await resumeWorkflow(options);
  } catch (error) {
    if (!isCheckpointMissingError(error)) throw error;
    return startWorkflow(options);
  }
}

export async function completeHostWork(
  options: QianjiServerWorkflowHttpOptions,
  completion: HostCompletionResult,
): Promise<QianjiServerWorkflowResponse> {
  return postWorkflowJson(options, `/workflows/${encodeURIComponent(options.instanceId)}/tasks/complete`, {
    bpmn_path: options.sourcePath,
    dmn_paths: options.dmnPaths,
    completion: hostCompletionPayload(completion),
  });
}

export async function completeHostWorkBatch(
  options: QianjiServerWorkflowHttpOptions,
  completions: HostCompletionResult[],
): Promise<QianjiServerWorkflowResponse> {
  return postWorkflowJson(options, `/workflows/${encodeURIComponent(options.instanceId)}/tasks/complete-batch`, {
    bpmn_path: options.sourcePath,
    dmn_paths: options.dmnPaths,
    completions: completions.map(hostCompletionPayload),
  });
}

async function startWorkflow(
  options: QianjiServerWorkflowHttpOptions,
): Promise<QianjiServerWorkflowResponse> {
  return postWorkflowJson(options, "/workflows/start", {
    bpmn_path: options.sourcePath,
    dmn_paths: options.dmnPaths,
    process_id: options.processId,
    instance_id: options.instanceId,
    initial_variables: options.context,
    ...(options.startAtNode ? { start_at_node_id: options.startAtNode } : {}),
  });
}

async function resumeWorkflow(
  options: QianjiServerWorkflowHttpOptions,
): Promise<QianjiServerWorkflowResponse> {
  return postWorkflowJson(options, `/workflows/${encodeURIComponent(options.instanceId)}/resume`, {
    bpmn_path: options.sourcePath,
    dmn_paths: options.dmnPaths,
  });
}

async function postWorkflowJson(
  options: QianjiServerWorkflowHttpOptions,
  path: string,
  body: Record<string, unknown>,
): Promise<QianjiServerWorkflowResponse> {
  throwIfWorkflowInterrupted(options.signal);
  const url = new URL(path, ensureTrailingSlash(options.serverUrl));
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw qianjiServerHttpError(path, response.status, text);
  }
  const parsed = text ? (JSON.parse(text) as unknown) : undefined;
  if (!isWorkflowResponse(parsed)) {
    throw new Error(`qianji server ${path} returned an invalid workflow response`);
  }
  return parsed;
}

function qianjiServerHttpError(
  path: string,
  status: number,
  responseText: string,
): QianjiServerHttpError {
  const body = parseErrorBody(responseText);
  const detail = body?.message ?? responseText;
  const message = `qianji server ${path} failed with HTTP ${status}: ${detail}`;
  return new QianjiServerHttpError({
    status,
    code: body?.code,
    message,
    path,
    responseText,
  });
}

function parseErrorBody(responseText: string): { code?: string; message?: string } | undefined {
  if (!responseText.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const body = parsed as Record<string, unknown>;
  return {
    ...(typeof body.code === "string" ? { code: body.code } : {}),
    ...(typeof body.message === "string" ? { message: body.message } : {}),
  };
}

function isCheckpointMissingError(error: unknown): boolean {
  return (
    error instanceof QianjiServerHttpError &&
    error.status === 404 &&
    error.code === "checkpoint_missing"
  );
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function hostCompletionPayload(completion: HostCompletionResult): Record<string, unknown> {
  return {
    token_id: completion.tokenId,
    process_id: completion.processId,
    activity_id: completion.nodeId,
    kind: completion.kind,
    data: completion.data,
    ...(completion.claimant ? { claimant: completion.claimant } : {}),
  };
}

function isWorkflowResponse(value: unknown): value is QianjiServerWorkflowResponse {
  return !!value && typeof value === "object" && "workflow" in value;
}
