import type { Effect } from "effect";
import { throwIfWorkflowInterrupted } from "../../interrupt.js";
import type { QianjiServerWorkflowHttpOptions } from "./types.js";
import { effectFromPromise, type PiWendaoEffectError } from "../../../effect.js";

export class QianjiServerHttpError extends Error {
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

export function getQianjiServerJson<T>(
  options: Pick<QianjiServerWorkflowHttpOptions, "serverUrl" | "signal">,
  path: string,
  guard: (value: unknown) => value is T,
  label: string,
): Effect.Effect<T, PiWendaoEffectError> {
  return effectFromPromise("getQianjiServerJson", () =>
    getQianjiServerJsonPromise(options, path, guard, label),
  );
}

async function getQianjiServerJsonPromise<T>(
  options: Pick<QianjiServerWorkflowHttpOptions, "serverUrl" | "signal">,
  path: string,
  guard: (value: unknown) => value is T,
  label: string,
): Promise<T> {
  throwIfWorkflowInterrupted(options.signal);
  const response = await fetch(new URL(path, ensureTrailingSlash(options.serverUrl)), {
    method: "GET",
    signal: options.signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw qianjiServerHttpError(path, response.status, text);
  }
  const parsed = text ? (JSON.parse(text) as unknown) : undefined;
  if (!guard(parsed)) {
    throw new Error(`qianji server ${path} returned an invalid ${label} response`);
  }
  return parsed;
}

export function postQianjiServerJson<T>(
  options: Pick<QianjiServerWorkflowHttpOptions, "serverUrl" | "signal">,
  path: string,
  body: Record<string, unknown>,
  guard: (value: unknown) => value is T,
  label: string,
): Effect.Effect<T, PiWendaoEffectError> {
  return effectFromPromise("postQianjiServerJson", () =>
    postQianjiServerJsonPromise(options, path, body, guard, label),
  );
}

async function postQianjiServerJsonPromise<T>(
  options: Pick<QianjiServerWorkflowHttpOptions, "serverUrl" | "signal">,
  path: string,
  body: Record<string, unknown>,
  guard: (value: unknown) => value is T,
  label: string,
): Promise<T> {
  throwIfWorkflowInterrupted(options.signal);
  const response = await fetch(new URL(path, ensureTrailingSlash(options.serverUrl)), {
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
  if (!guard(parsed)) {
    throw new Error(`qianji server ${path} returned an invalid ${label} response`);
  }
  return parsed;
}

export function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
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
