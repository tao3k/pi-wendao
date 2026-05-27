import type {
  QianjiControlDiagnosticsResponse,
  QianjiControlRecoveryApplyResponse,
  QianjiControlRecoveryResponse,
  QianjiControlRunSummaryResponse,
  QianjiServerCapabilitiesResponse,
  QianjiServerWorkflowResponse,
} from "./types.js";

export function isWorkflowResponse(value: unknown): value is QianjiServerWorkflowResponse {
  return !!value && typeof value === "object" && "workflow" in value;
}

export function isCapabilitiesResponse(value: unknown): value is QianjiServerCapabilitiesResponse {
  if (!isRecord(value)) return false;
  return (
    value.service === "qianji-server" &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) => typeof capability === "string")
  );
}

export function isControlRunSummaryResponse(
  value: unknown,
): value is QianjiControlRunSummaryResponse {
  if (!isRecord(value)) return false;
  return typeof value.run_id === "string" && isRecord(value.summary);
}

export function isControlRecoveryResponse(value: unknown): value is QianjiControlRecoveryResponse {
  if (!isRecord(value)) return false;
  return typeof value.run_id === "string" && isRecord(value.recovery);
}

export function isControlDiagnosticsResponse(
  value: unknown,
): value is QianjiControlDiagnosticsResponse {
  if (!isRecord(value)) return false;
  return typeof value.run_id === "string" && isRecord(value.diagnostics);
}

export function isControlRecoveryApplyResponse(
  value: unknown,
): value is QianjiControlRecoveryApplyResponse {
  if (!isRecord(value)) return false;
  return (
    typeof value.run_id === "string" && isRecord(value.application) && isRecord(value.diagnostics)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
