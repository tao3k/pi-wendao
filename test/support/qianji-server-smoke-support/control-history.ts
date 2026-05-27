import { ensureTrailingSlash } from "./url.js";

export async function loadQianjiServerControlHistory(options: {
  readonly baseUrl: string;
  readonly runId: string;
}): Promise<unknown[]> {
  const response = await fetch(
    new URL(
      `/control/runs/${encodeURIComponent(options.runId)}/history`,
      ensureTrailingSlash(options.baseUrl),
    ),
  );
  if (!response.ok) {
    throw new Error(`qianji-server control history failed with HTTP ${response.status}`);
  }
  const parsed = (await response.json()) as { events?: unknown };
  if (!Array.isArray(parsed.events)) {
    throw new Error("qianji-server control history returned a response without events");
  }
  return parsed.events;
}

export function controlEventKind(record: unknown): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const event = "event" in record ? record.event : undefined;
  if (!event || typeof event !== "object") return undefined;
  const kind = "kind" in event ? event.kind : undefined;
  if (!kind || typeof kind !== "object") return undefined;
  return "event" in kind && typeof kind.event === "string" ? kind.event : undefined;
}

export function controlEventFailureCode(record: unknown): string | undefined {
  const failure = controlEventFailure(record);
  if (!failure || typeof failure !== "object") return undefined;
  const code = "error_code" in failure ? failure.error_code : undefined;
  return typeof code === "string" ? code : undefined;
}

export function controlEventFailureMessage(record: unknown): string | undefined {
  const failure = controlEventFailure(record);
  if (!failure || typeof failure !== "object") return undefined;
  const message = "message" in failure ? failure.message : undefined;
  return typeof message === "string" ? message : undefined;
}

function controlEventFailure(record: unknown): unknown {
  if (!record || typeof record !== "object") return undefined;
  const event = "event" in record ? record.event : undefined;
  if (!event || typeof event !== "object") return undefined;
  const kind = "kind" in event ? event.kind : undefined;
  if (!kind || typeof kind !== "object") return undefined;
  return "failure" in kind ? kind.failure : undefined;
}
