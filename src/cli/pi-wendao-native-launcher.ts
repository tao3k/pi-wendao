import { main, type MainOptions } from "@earendil-works/pi-coding-agent";
import {
  createPiWendaoNativeExtension,
  type PiWendaoNativeExtensionOptions,
} from "./pi-wendao-native-extension.js";
import {
  resolvePiWendaoAnthropicEnvAuth,
  resolvePiWendaoPiSubagentsExtensionPath,
} from "./model-resolver.js";

export type LaunchPiWendaoNativeTuiOptions = PiWendaoNativeExtensionOptions;
export type PiWendaoNativeMain = (
  args: string[],
  options?: MainOptions,
) => Promise<void>;

export async function launchPiWendaoNativeTui(
  options: LaunchPiWendaoNativeTuiOptions,
): Promise<void> {
  await launchPiWendaoNativeTuiWithMain(options, main);
}

export async function launchPiWendaoNativeTuiWithMain(
  options: LaunchPiWendaoNativeTuiOptions,
  runMain: PiWendaoNativeMain,
): Promise<void> {
  process.env.PI_CODING_AGENT = "true";
  await runMain(buildPiWendaoNativeArgs(options), {
    extensionFactories: [createPiWendaoNativeExtension(options)],
  });
}

export function buildPiWendaoNativeArgs(options: LaunchPiWendaoNativeTuiOptions): string[] {
  const args = ["--continue", "--model", options.modelPattern, "--thinking", options.thinkingLevel];
  if (options.provider && !options.modelPattern.includes("/")) {
    args.push("--provider", options.provider);
  }
  const apiKey = options.apiKey ?? resolvePiWendaoNativeEnvApiKey(options);
  if (apiKey) {
    args.push("--api-key", apiKey);
  }
  for (const extensionPath of uniqueStrings([
    ...resolveNativeBuiltinExtensionPaths(),
    ...options.resolvedExtensionPaths,
  ])) {
    args.push("--extension", extensionPath);
  }
  return args;
}

function resolvePiWendaoNativeEnvApiKey(
  options: LaunchPiWendaoNativeTuiOptions,
): string | undefined {
  if (!isAnthropicLaunch(options)) return undefined;
  return resolvePiWendaoAnthropicEnvAuth()?.apiKey;
}

function isAnthropicLaunch(options: LaunchPiWendaoNativeTuiOptions): boolean {
  if (options.provider === "anthropic") return true;
  return options.modelPattern.startsWith("anthropic/");
}

export function resolveNativeBuiltinExtensionPaths(): string[] {
  return [resolvePiWendaoPiSubagentsExtensionPath()];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
