import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolvePiWendaoPackageRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, ".."),
    resolve(moduleDir, "../.."),
    resolve(process.cwd()),
  ];
  return candidates.find(isPiWendaoPackageRoot) ?? candidates[0];
}

export function resolvePiWendaoPromptPath(
  name: string,
  packageRoot = resolvePiWendaoPackageRoot(),
): string {
  return join(packageRoot, ".pi", "prompts", name);
}

export function readPiWendaoPrompt(
  name: string,
  packageRoot = resolvePiWendaoPackageRoot(),
): string {
  return readFileSync(resolvePiWendaoPromptPath(name, packageRoot), "utf-8").trim();
}

export function resolvePiWendaoNamedWorkflowSeedPath(
  name: string,
  packageRoot = resolvePiWendaoPackageRoot(),
): string {
  return join(packageRoot, ".pi", "named-workflows", `${name}.bpmn`);
}

function isPiWendaoPackageRoot(path: string): boolean {
  return existsSync(join(path, "package.json")) && existsSync(join(path, ".pi"));
}
