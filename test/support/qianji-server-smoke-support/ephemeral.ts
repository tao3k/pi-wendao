import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { prebuildQianjiServerBinaryIfMissing, qianjiServerBinaryPath } from "./binary.js";
import { stopProcess } from "./child-process.js";
import { delay } from "./url.js";

export interface EphemeralQianjiWorkflowServerOptions {
  readonly qianjiServerRepoRoot: string;
  readonly flowhubRoot: string;
  readonly runtimeDir: string;
  readonly controlLedgerPath?: string;
  readonly qianjiServerFeatures?: readonly string[];
  readonly startupTimeoutMs?: number;
}

export interface EphemeralQianjiWorkflowServer {
  readonly baseUrl: string;
  readonly valkeyUrl: string;
  stop(): Promise<void>;
}

export async function startEphemeralQianjiWorkflowServer(
  options: EphemeralQianjiWorkflowServerOptions,
): Promise<EphemeralQianjiWorkflowServer> {
  mkdirSync(options.runtimeDir, { recursive: true });
  const valkey = await startEphemeralValkey(options.runtimeDir);
  try {
    const server = await startEphemeralQianjiServer(options, valkey.url);
    return {
      baseUrl: server.baseUrl,
      valkeyUrl: valkey.url,
      async stop() {
        await Promise.all([stopProcess(server.child), stopProcess(valkey.child)]);
      },
    };
  } catch (error) {
    await stopProcess(valkey.child);
    throw error;
  }
}

async function startEphemeralValkey(
  runtimeDir: string,
): Promise<{ url: string; child: ChildProcessWithoutNullStreams }> {
  const port = await reserveTcpPort();
  const dataDir = join(runtimeDir, "valkey");
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(
    "valkey-server",
    [
      "--bind",
      "127.0.0.1",
      "--port",
      String(port),
      "--save",
      "",
      "--appendonly",
      "no",
      "--dir",
      dataDir,
    ],
    {
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    },
  );
  await waitForValkeyReady(port, 30_000, child);
  return { url: `redis://127.0.0.1:${port}/0`, child };
}

async function startEphemeralQianjiServer(
  options: EphemeralQianjiWorkflowServerOptions,
  valkeyUrl: string,
): Promise<{ baseUrl: string; child: ChildProcessWithoutNullStreams }> {
  await prebuildQianjiServerBinaryIfMissing(
    options.qianjiServerRepoRoot,
    options.startupTimeoutMs ?? 600_000,
    { features: options.qianjiServerFeatures },
  );
  const binaryPath = qianjiServerBinaryPath(options.qianjiServerRepoRoot);
  const args = [
    "--bind",
    "127.0.0.1:0",
    "--valkey-url",
    valkeyUrl,
    "--flowhub-root",
    options.flowhubRoot,
    "--require-valkey-ready",
  ];
  if (options.controlLedgerPath) {
    args.push("--control-ledger", options.controlLedgerPath);
  }
  const child = spawn(binaryPath, args, {
    cwd: options.qianjiServerRepoRoot,
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
  });
  const baseUrl = await waitForQianjiServerListenUrl(child, options.startupTimeoutMs ?? 600_000);
  return { baseUrl, child };
}

function waitForQianjiServerListenUrl(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<string> {
  let output = "";
  return new Promise((resolve, reject) => {
    let isSettled = false;
    const timeout = setTimeout(() => {
      isSettled = true;
      reject(new Error(`qianji-server did not start before timeout:\n${output}`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      const match = output.match(/qianji-server listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (!match) return;
      isSettled = true;
      clearTimeout(timeout);
      resolve(match[1]);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeout);
      reject(new Error(`qianji-server exited before readiness with ${exitCode}:\n${output}`));
    });
  });
}

async function waitForValkeyReady(
  port: number,
  timeoutMs: number,
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not checked";
  while (Date.now() <= deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`valkey-server exited before readiness with ${child.exitCode}`);
    }
    const result = await runValkeyCli(port);
    if (result.ok) return;
    lastError = result.error;
    await delay(250);
  }
  throw new Error(`valkey-server readiness failed on port ${port}: ${lastError}`);
}

function runValkeyCli(port: number): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn("valkey-cli", ["-h", "127.0.0.1", "-p", String(port), "PING"], {
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
    child.on("error", (error) => {
      resolve({ ok: false, error: error.message });
    });
    child.on("close", (exitCode) => {
      if (exitCode === 0 && output.includes("PONG")) {
        resolve({ ok: true });
        return;
      }
      resolve({ ok: false, error: output || `exit ${exitCode}` });
    });
  });
}

function reserveTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to reserve TCP port")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}
