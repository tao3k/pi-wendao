import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = process.cwd();
const rustWorkspace = join(projectRoot, "..", "..");
const flowhubRoot = join(rustWorkspace, "qianji-flowhub");
const tempDirs: string[] = [];
const servers: ChildProcessWithoutNullStreams[] = [];
const smokeEnabled = process.env.RUN_PI_WENDAO_FLOWHUB_GATEWAY_SMOKE === "1";
const itSmoke = smokeEnabled ? it : it.skip;

describe("Flowhub Gateway smoke", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(stopProcess));
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  itSmoke(
    "runs pi-wendao against a live qianji-server Flowhub registry route",
    async () => {
      const server = await startQianjiServer();
      const tempDir = mkdtempSync(join(tmpdir(), "pi-wendao-flowhub-gateway-smoke-"));
      tempDirs.push(tempDir);
      const qianjiPath = join(tempDir, "qianji");
      writeEchoQianji(qianjiPath);

      const result = await runPiWendaoCli(
        [
          "--flowhub-scenario",
          "agent-coding",
          "--flowhub-root",
          "../../qianji-flowhub",
          "--show",
          "--qianji",
          qianjiPath,
          "--no-graph",
        ],
        {
          PI_WENDAO_QIANJI_SERVER_URL: server.baseUrl,
        },
      );

      const output = [result.stdout, result.stderr].join("\n");
      expect(result.exitCode).toBe(0);
      expect(output).toContain("bpmn instances");
      expect(output).not.toContain("qianji-client flowhub scenarios");
    },
    240_000,
  );
});

async function startQianjiServer(): Promise<{ baseUrl: string }> {
  const cargo = resolveCargoInvocation();
  const child = spawn(
    cargo.command,
    [
      ...cargo.prefixArgs,
      "run",
      "-p",
      "xiuxian-qianji",
      "--bin",
      "qianji-server",
      "--",
      "--bind",
      "127.0.0.1:0",
      "--no-require-valkey-ready",
      "--flowhub-root",
      flowhubRoot,
    ],
    {
      cwd: rustWorkspace,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    },
  );
  servers.push(child);

  let output = "";
  return new Promise((resolve, reject) => {
    let isSettled = false;
    const timeout = setTimeout(() => {
      isSettled = true;
      reject(new Error(`qianji-server did not start before timeout:\n${output}`));
    }, 180_000);

    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf-8");
      const match = output.match(/qianji-server listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (!match) return;
      isSettled = true;
      clearTimeout(timeout);
      resolve({ baseUrl: match[1] });
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeout);
      reject(new Error(`qianji-server exited before readiness with code ${code}:\n${output}`));
    });
  });
}

function resolveCargoInvocation(): { command: string; prefixArgs: string[] } {
  const profile = process.env.DEVENV_PROFILE;
  if (profile) {
    const cargoPath = join(
      profile,
      "bin",
      process.platform === "win32" ? "cargo.exe" : "cargo",
    );
    if (existsSync(cargoPath)) return { command: cargoPath, prefixArgs: [] };
  }
  return { command: "direnv", prefixArgs: ["exec", rustWorkspace, "cargo"] };
}

function runPiWendaoCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const jitiBin = join(
    projectRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "jiti.cmd" : "jiti",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(jitiBin, ["src/cli/pi-wendao.ts", ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("pi-wendao Flowhub Gateway smoke timed out"));
    }, 60_000);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await once(child, "close");
  } finally {
    clearTimeout(killTimer);
  }
}

function writeEchoQianji(path: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env node\nprocess.stdout.write(process.argv.slice(2).join(" "));\n`,
    "utf-8",
  );
  chmodSync(path, 0o755);
}
