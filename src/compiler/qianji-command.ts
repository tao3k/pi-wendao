import { spawn } from "node:child_process";
import type { Effect } from "effect";
import { resolveDefaultQianjiCommand } from "../qianji-command-resolution.js";
import { effectFromPromise, type PiWendaoEffectError } from "../effect.js";

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Effect.Effect<CommandResult, PiWendaoEffectError> {
  return effectFromPromise("runCommand", () => runCommandPromise(command, args, cwd));
}

function runCommandPromise(command: string, args: string[], cwd: string): Promise<CommandResult> {
  const commandLine = [command, ...args.map(shellQuote)].join(" ");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandLine, {
      cwd,
      shell: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolvePromise({ exitCode, stdout, stderr });
    });
  });
}

export function defaultQianjiCommand(): string {
  return resolveDefaultQianjiCommand();
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
