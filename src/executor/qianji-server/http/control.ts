import type { Effect } from "effect";
import {
  isControlDiagnosticsResponse,
  isControlRecoveryApplyResponse,
  isControlRecoveryResponse,
  isControlRunSummaryResponse,
} from "./guards.js";
import { getQianjiServerJson, postQianjiServerJson } from "./transport.js";
import type {
  QianjiControlDiagnosticsResponse,
  QianjiControlRecoveryApplyRequest,
  QianjiControlRecoveryApplyResponse,
  QianjiControlRecoveryResponse,
  QianjiControlRunSummaryResponse,
  QianjiServerWorkflowHttpOptions,
} from "./types.js";
import { effectFromPromise, runPiWendaoEffect, type PiWendaoEffectError } from "../../../effect.js";

export function loadControlRunSummary(
  options: Pick<QianjiServerWorkflowHttpOptions, "serverUrl" | "instanceId" | "signal">,
): Effect.Effect<QianjiControlRunSummaryResponse, PiWendaoEffectError> {
  return effectFromPromise("loadControlRunSummary", () =>
    runPiWendaoEffect(
      getQianjiServerJson(
        options,
        `/control/runs/${encodeURIComponent(controlRunId(options.instanceId))}/summary`,
        isControlRunSummaryResponse,
        "control summary",
      ),
    ),
  );
}

export function loadControlRunRecovery(
  options: Pick<QianjiServerWorkflowHttpOptions, "serverUrl" | "instanceId" | "signal">,
): Effect.Effect<QianjiControlRecoveryResponse, PiWendaoEffectError> {
  return effectFromPromise("loadControlRunRecovery", () =>
    runPiWendaoEffect(
      getQianjiServerJson(
        options,
        `/control/runs/${encodeURIComponent(controlRunId(options.instanceId))}/recovery`,
        isControlRecoveryResponse,
        "control recovery",
      ),
    ),
  );
}

export function loadControlRunDiagnostics(
  options: Pick<QianjiServerWorkflowHttpOptions, "serverUrl" | "instanceId" | "signal">,
): Effect.Effect<QianjiControlDiagnosticsResponse, PiWendaoEffectError> {
  return effectFromPromise("loadControlRunDiagnostics", () =>
    runPiWendaoEffect(
      getQianjiServerJson(
        options,
        `/control/runs/${encodeURIComponent(controlRunId(options.instanceId))}/diagnostics`,
        isControlDiagnosticsResponse,
        "control diagnostics",
      ),
    ),
  );
}

export function applyControlRunRecovery(
  options: Pick<QianjiServerWorkflowHttpOptions, "serverUrl" | "instanceId" | "signal">,
  request: QianjiControlRecoveryApplyRequest,
): Effect.Effect<QianjiControlRecoveryApplyResponse, PiWendaoEffectError> {
  return effectFromPromise("applyControlRunRecovery", () =>
    runPiWendaoEffect(
      postQianjiServerJson(
        options,
        `/control/runs/${encodeURIComponent(controlRunId(options.instanceId))}/recovery/apply`,
        { ...request },
        isControlRecoveryApplyResponse,
        "control recovery apply",
      ),
    ),
  );
}

function controlRunId(instanceId: string): string {
  return `bpmn.workflow.${instanceId}`;
}
