import { once } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";

export function runChildProcess(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly label: string;
  readonly acceptsOutput?: (output: string) => boolean;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    });
    let output = "";
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`${options.label} timed out after ${options.timeoutMs} ms:\n${output}`));
        }, options.timeoutMs)
      : undefined;
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      if (exitCode === 0 || options.acceptsOutput?.(output)) {
        resolve();
        return;
      }
      reject(new Error(`${options.label} failed with ${exitCode}:\n${output}`));
    });
  });
}

export async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await once(child, "close");
  } finally {
    clearTimeout(killTimer);
  }
}
