import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { main } from "@mariozechner/pi-coding-agent";
import { createPiWendaoNativeExtension, type PiWendaoNativeExtensionOptions } from "./pi-wendao-native-extension.js";

const require = createRequire(import.meta.url);
const NATIVE_BUILTIN_EXTENSION_PACKAGES = ["@tintinweb/pi-subagents"] as const;

export type LaunchPiWendaoNativeTuiOptions = PiWendaoNativeExtensionOptions;

export async function launchPiWendaoNativeTui(options: LaunchPiWendaoNativeTuiOptions): Promise<void> {
	process.env.PI_CODING_AGENT = "true";
	await main(buildPiWendaoNativeArgs(options), {
		extensionFactories: [createPiWendaoNativeExtension(options)],
	});
}

export function buildPiWendaoNativeArgs(options: LaunchPiWendaoNativeTuiOptions): string[] {
	const args = ["--continue", "--model", options.modelPattern, "--thinking", options.thinkingLevel];
	if (options.provider && !options.modelPattern.includes("/")) {
		args.push("--provider", options.provider);
	}
	if (options.apiKey) {
		args.push("--api-key", options.apiKey);
	}
	for (const extensionPath of uniqueStrings([
		...resolveNativeBuiltinExtensionPaths(),
		...options.resolvedExtensionPaths,
	])) {
		args.push("--extension", extensionPath);
	}
	return args;
}

export function resolveNativeBuiltinExtensionPaths(): string[] {
	return NATIVE_BUILTIN_EXTENSION_PACKAGES
		.map((packageName) => resolvePackageRoot(packageName))
		.filter((path): path is string => path !== undefined);
}

function resolvePackageRoot(packageName: string): string | undefined {
	try {
		const packageJsonPath = require.resolve(`${packageName}/package.json`);
		const packageRoot = dirname(packageJsonPath);
		return existsSync(packageRoot) ? packageRoot : undefined;
	} catch {
		return undefined;
	}
}

function uniqueStrings(values: string[]): string[] {
	return [...new Set(values)];
}
