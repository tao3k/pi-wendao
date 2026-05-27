import { existsSync } from "node:fs";
import { join } from "node:path";
import { runChildProcess } from "./child-process.js";

export async function prebuildQianjiServerBinaryIfMissing(
  qianjiServerRepoRoot: string | undefined,
  timeoutMs: number,
  options: {
    readonly features?: readonly string[];
  } = {},
): Promise<void> {
  if (!qianjiServerRepoRoot) return;
  const binaryPath = qianjiServerBinaryPath(qianjiServerRepoRoot);
  const features = [...(options.features ?? [])];
  if (existsSync(binaryPath) && features.length === 0) return;
  const cargo = resolveCargoInvocation(qianjiServerRepoRoot);
  const args = [
    ...cargo.prefixArgs,
    "build",
    "-p",
    "xiuxian-qianji",
    "--bin",
    "qianji-server",
    "--locked",
  ];
  if (features.length > 0) {
    args.push("--features", features.join(","));
  }
  await runChildProcess({
    command: cargo.command,
    args,
    cwd: qianjiServerRepoRoot,
    timeoutMs,
    label: "qianji-server prebuild",
  });
}

export function qianjiServerBinaryPath(qianjiServerRepoRoot: string): string {
  return join(
    qianjiServerRepoRoot,
    "target",
    "debug",
    process.platform === "win32" ? "qianji-server.exe" : "qianji-server",
  );
}

function resolveCargoInvocation(qianjiServerRepoRoot: string): {
  command: string;
  prefixArgs: string[];
} {
  const profile = process.env.DEVENV_PROFILE;
  if (profile) {
    const cargoPath = join(profile, "bin", process.platform === "win32" ? "cargo.exe" : "cargo");
    if (existsSync(cargoPath)) return { command: cargoPath, prefixArgs: [] };
  }
  return { command: "direnv", prefixArgs: ["exec", qianjiServerRepoRoot, "cargo"] };
}
