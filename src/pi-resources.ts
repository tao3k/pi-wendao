import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function resolvePiWendaoPackageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolvePiWendaoPromptPath(name: string, packageRoot = resolvePiWendaoPackageRoot()): string {
	return join(packageRoot, ".pi", "prompts", name);
}

export function readPiWendaoPrompt(name: string, packageRoot = resolvePiWendaoPackageRoot()): string {
	return readFileSync(resolvePiWendaoPromptPath(name, packageRoot), "utf-8").trim();
}
