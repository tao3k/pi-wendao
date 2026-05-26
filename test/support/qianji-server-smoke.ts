import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const DEFAULT_QIANJI_SERVER_URL = "http://127.0.0.1:38130";

export function resolveQianjiWorkflowServerSmokeUrl(): string {
  return stripTrailingSlash(
    process.env.PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL?.trim() ||
      process.env.PI_WENDAO_QIANJI_SERVER_URL?.trim() ||
      process.env.QIANJI_SERVER_URL?.trim() ||
      DEFAULT_QIANJI_SERVER_URL,
  );
}

export async function assertQianjiServerReady(baseUrl: string): Promise<void> {
  const timeoutMs = readPositiveIntEnv(
    "PI_WENDAO_QIANJI_SERVER_READY_TIMEOUT_MS",
    60_000,
  );
  const quick = await checkQianjiServerReady(baseUrl);
  if (quick.ok) return;
  if (canAutoStartProcessCompose(baseUrl)) {
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
  return stripTrailingSlash(baseUrl) === DEFAULT_QIANJI_SERVER_URL &&
    Boolean(socketPath) &&
    existsSync(socketPath);
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
  return new Promise((resolve, reject) => {
    const child = spawn("process-compose", args, {
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    });
    let output = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0 || output.includes("process qianji-server is already running")) {
        resolve();
        return;
      }
      reject(
        new Error(`process-compose qianji-server start failed with ${exitCode}:\n${output}`),
      );
    });
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

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
