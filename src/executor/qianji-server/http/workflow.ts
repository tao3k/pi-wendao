import type { Effect } from "effect";
import type { HostCompletionResult } from "../../executor-host-loop.js";
import type { QianjiHostWork } from "../../qianji-types.js";
import { isWorkflowResponse } from "./guards.js";
import { postQianjiServerJson, QianjiServerHttpError } from "./transport.js";
import type { QianjiServerWorkflowHttpOptions, QianjiServerWorkflowResponse } from "./types.js";
import { effectFromPromise, runPiWendaoEffect, type PiWendaoEffectError } from "../../../effect.js";

export function resumeOrStartWorkflow(
  options: QianjiServerWorkflowHttpOptions,
): Effect.Effect<QianjiServerWorkflowResponse, PiWendaoEffectError> {
  return effectFromPromise("resumeOrStartWorkflow", () => resumeOrStartWorkflowPromise(options));
}

async function resumeOrStartWorkflowPromise(
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

export function completeHostWork(
  options: QianjiServerWorkflowHttpOptions,
  completion: HostCompletionResult,
): Effect.Effect<QianjiServerWorkflowResponse, PiWendaoEffectError> {
  return effectFromPromise("completeHostWork", () => completeHostWorkPromise(options, completion));
}

async function completeHostWorkPromise(
  options: QianjiServerWorkflowHttpOptions,
  completion: HostCompletionResult,
): Promise<QianjiServerWorkflowResponse> {
  return postWorkflowJson(
    options,
    `/workflows/${encodeURIComponent(options.instanceId)}/tasks/complete`,
    {
      bpmn_path: options.sourcePath,
      dmn_paths: options.dmnPaths,
      completion: hostCompletionPayload(completion),
    },
  );
}

export function completeHostWorkBatch(
  options: QianjiServerWorkflowHttpOptions,
  completions: HostCompletionResult[],
): Effect.Effect<QianjiServerWorkflowResponse, PiWendaoEffectError> {
  return effectFromPromise("completeHostWorkBatch", () =>
    completeHostWorkBatchPromise(options, completions),
  );
}

async function completeHostWorkBatchPromise(
  options: QianjiServerWorkflowHttpOptions,
  completions: HostCompletionResult[],
): Promise<QianjiServerWorkflowResponse> {
  return postWorkflowJson(
    options,
    `/workflows/${encodeURIComponent(options.instanceId)}/tasks/complete-batch`,
    {
      bpmn_path: options.sourcePath,
      dmn_paths: options.dmnPaths,
      completions: completions.map(hostCompletionPayload),
    },
  );
}

export function failHostWork(
  options: QianjiServerWorkflowHttpOptions,
  work: QianjiHostWork,
  error: unknown,
): Effect.Effect<QianjiServerWorkflowResponse, PiWendaoEffectError> {
  return effectFromPromise("failHostWork", () => failHostWorkPromise(options, work, error));
}

async function failHostWorkPromise(
  options: QianjiServerWorkflowHttpOptions,
  work: QianjiHostWork,
  error: unknown,
): Promise<QianjiServerWorkflowResponse> {
  return postWorkflowJson(
    options,
    `/workflows/${encodeURIComponent(options.instanceId)}/tasks/fail`,
    {
      bpmn_path: options.sourcePath,
      dmn_paths: options.dmnPaths,
      failure: hostWorkFailurePayload(work, error),
    },
  );
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
  return runPiWendaoEffect(
    postQianjiServerJson(options, path, body, isWorkflowResponse, "workflow"),
  );
}

function isCheckpointMissingError(error: unknown): boolean {
  return (
    error instanceof QianjiServerHttpError &&
    error.status === 404 &&
    error.code === "checkpoint_missing"
  );
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

function hostWorkFailurePayload(work: QianjiHostWork, error: unknown): Record<string, unknown> {
  return {
    token_id: work.token_id,
    process_id: work.process_id,
    activity_id: work.activity_id ?? work.node_id,
    kind: work.kind,
    error_code: "native_host_execution_failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
    metadata: {
      source: "pi-wendao",
      ...(error instanceof Error ? { errorName: error.name } : {}),
    },
  };
}
