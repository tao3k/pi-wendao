export const WENDAO_ARROW_FLIGHT_DATA_PLANE = "arrow-flight" as const;
export const WENDAO_NO_DATA_PLANE = "none" as const;
export const WENDAO_JSON_CONTROL_PLANE = "json-control" as const;
export const WENDAO_JSONL_STDIO_CONTROL_PLANE = "jsonl-stdio-control" as const;
export const WENDAO_PROCESS_ARGS_CONTROL_PLANE = "process-args-control" as const;

export const WENDAO_FORBIDDEN_ARROW_PAYLOAD_WRAPPERS = [
  "base64-arrow-ipc",
  "json-base64-arrow-ipc",
  "jsonl-base64-arrow-ipc",
] as const;

export type WendaoTraceDataPlane =
  | typeof WENDAO_ARROW_FLIGHT_DATA_PLANE
  | typeof WENDAO_NO_DATA_PLANE;

export type WendaoArrowFlightDataPlane = typeof WENDAO_ARROW_FLIGHT_DATA_PLANE;

export type WendaoTraceControlPlane =
  | typeof WENDAO_JSON_CONTROL_PLANE
  | typeof WENDAO_JSONL_STDIO_CONTROL_PLANE
  | typeof WENDAO_PROCESS_ARGS_CONTROL_PLANE;

export function assertAllowedArrowPayloadEncoding(token: string): void {
  const normalized = token.trim().toLowerCase();
  const forbidden = WENDAO_FORBIDDEN_ARROW_PAYLOAD_WRAPPERS.some(
    (candidate) => candidate === normalized,
  );
  if (forbidden || (normalized.includes("arrow") && normalized.includes("base64"))) {
    throw new Error(
      `${token} is not a Wendao payload boundary; use ${WENDAO_ARROW_FLIGHT_DATA_PLANE} for table data and keep JSON/JSONL as control only`,
    );
  }
}
