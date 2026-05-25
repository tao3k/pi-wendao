import { accessSync, constants } from "node:fs";
import { dirname, join, parse } from "node:path";

export function resolveDefaultQianjiCommand(cwd = process.cwd()): string {
  const envCommand = process.env.QIANJI_CLI?.trim();
  if (envCommand) return envCommand;
  const workspaceCommand = findWorkspaceCommand(cwd, qianjiBinaryName());
  if (workspaceCommand) return workspaceCommand;
  return "qianji";
}

export function resolveDefaultQianjiClientCommand(cwd = process.cwd()): string {
  const envCommand = process.env.QIANJI_CLIENT_CLI?.trim();
  if (envCommand) return envCommand;
  const workspaceCommand = findWorkspaceCommand(cwd, qianjiClientBinaryName());
  if (workspaceCommand) return workspaceCommand;
  return "qianji-client";
}

function findWorkspaceCommand(
  cwd: string,
  binaryName: string,
): string | undefined {
  let current = cwd;
  const root = parse(current).root;
  while (true) {
    const candidate = join(current, "target", "debug", binaryName);
    if (isExecutableFile(candidate)) return candidate;
    if (current === root) return undefined;
    current = dirname(current);
  }
}

function qianjiBinaryName(): string {
  return process.platform === "win32" ? "qianji.exe" : "qianji";
}

function qianjiClientBinaryName(): string {
  return process.platform === "win32" ? "qianji-client.exe" : "qianji-client";
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
