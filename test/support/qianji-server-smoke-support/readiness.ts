import { existsSync } from "node:fs";
import {
  DEFAULT_QIANJI_SERVER_URL,
  delay,
  ensureTrailingSlash,
  readPositiveIntEnv,
  stripTrailingSlash,
} from "./url.js";
import { prebuildQianjiServerBinaryIfMissing } from "./binary.js";
import { runChildProcess } from "./child-process.js";

export function resolveQianjiWorkflowServerSmokeUrl(): string {
  return stripTrailingSlash(
    process.env.PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL?.trim() ||
      process.env.PI_WENDAO_QIANJI_SERVER_URL?.trim() ||
      process.env.QIANJI_SERVER_URL?.trim() ||
      DEFAULT_QIANJI_SERVER_URL,
  );
}

export async function assertQianjiServerReady(
  baseUrl: string,
  timeoutMs = readPositiveIntEnv("PI_WENDAO_QIANJI_SERVER_READY_TIMEOUT_MS", 60_000),
  options: { readonly qianjiServerRepoRoot?: string; readonly buildTimeoutMs?: number } = {},
): Promise<void> {
  const quick = await checkQianjiServerReady(baseUrl);
  if (quick.ok) return;
  if (canAutoStartProcessCompose(baseUrl)) {
    await prebuildQianjiServerBinaryIfMissing(
      options.qianjiServerRepoRoot,
      options.buildTimeoutMs ?? timeoutMs,
    );
    await startQianjiServerProcess();
  }
  const ready = await waitForQianjiServerReady(baseUrl, timeoutMs);
  if (ready.ok) return;
  throw readinessError(baseUrl, ready.lastError);
}

async function waitForQianjiServerReady(
  baseUrl: string,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; lastError: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not checked";
  while (Date.now() <= deadline) {
    const ready = await checkQianjiServerReady(baseUrl);
    if (ready.ok) return ready;
    lastError = ready.lastError;
    await delay(500);
  }
  return { ok: false, lastError };
}

async function checkQianjiServerReady(
  baseUrl: string,
): Promise<{ ok: true } | { ok: false; lastError: string }> {
  try {
    const response = await fetch(new URL("/readyz", ensureTrailingSlash(baseUrl)));
    if (response.ok) return { ok: true };
    return { ok: false, lastError: `HTTP ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

function canAutoStartProcessCompose(baseUrl: string): boolean {
  const socketPath = process.env.PC_SOCKET_PATH?.trim();
  return (
    stripTrailingSlash(baseUrl) === DEFAULT_QIANJI_SERVER_URL &&
    Boolean(socketPath) &&
    existsSync(socketPath)
  );
}

async function startQianjiServerProcess(): Promise<void> {
  const socketPath = process.env.PC_SOCKET_PATH?.trim();
  if (!socketPath) return;
  await runProcessCompose([
    "--use-uds",
    "--unix-socket",
    socketPath,
    "process",
    "start",
    "qianji-server",
  ]);
}

function runProcessCompose(args: string[]): Promise<void> {
  return runChildProcess({
    command: "process-compose",
    args,
    label: "process-compose qianji-server start",
    acceptsOutput: (output) => output.includes("process qianji-server is already running"),
  });
}

function readinessError(baseUrl: string, lastError: string): Error {
  return new Error(
    [
      `qianji-server readiness failed before timeout: ${baseUrl}`,
      `last error: ${lastError}`,
      "Start the workspace process with:",
      "  direnv exec . devenv --no-tui processes up -d qianji-server",
    ].join("\n"),
  );
}
