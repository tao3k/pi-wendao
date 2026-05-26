import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  applyPiWendaoEnvAuthOverride,
  createPiWendaoAgentServices,
  describeResolvedAuth,
  resolveModel,
  resolvePiWendaoAnthropicEnvAuth,
  type ResolvedModel,
} from "../model-resolver.js";
import type { PiWendaoNativeExtensionOptions } from "./types.js";

export type { ResolvedModel } from "../model-resolver.js";

export function registerAnthropicEnvProvider(pi: ExtensionAPI): void {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!baseUrl) return;
  const envAuth = resolvePiWendaoAnthropicEnvAuth();
  pi.registerProvider("anthropic", {
    baseUrl,
    ...(envAuth ? { apiKey: envAuth.apiKey } : {}),
  });
}

export async function resolveNativeRunModel(
  ctx: Pick<ExtensionCommandContext, "model" | "modelRegistry">,
  options: Pick<
    PiWendaoNativeExtensionOptions,
    "modelPattern" | "provider" | "apiKey" | "piContextCwd" | "resolvedExtensionPaths"
  >,
): Promise<ResolvedModel> {
  if (!ctx.model) {
    return resolveModel(
      options.modelPattern,
      options.provider,
      options.apiKey,
      options.resolvedExtensionPaths,
    );
  }

  const services = await createPiWendaoAgentServices({
    cwd: options.piContextCwd,
    extensionPaths: options.resolvedExtensionPaths,
  });
  const model = ctx.model;
  let authSource = options.apiKey ? "cli:--api-key" : "pi";
  if (options.apiKey) {
    ctx.modelRegistry.authStorage.setRuntimeApiKey(model.provider, options.apiKey);
  } else {
    const envAuth = applyPiWendaoEnvAuthOverride(ctx.modelRegistry.authStorage, model.provider);
    if (envAuth) authSource = envAuth.source;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  let apiKey = auth.ok ? auth.apiKey : undefined;
  const headers = auth.ok ? auth.headers : undefined;
  if (!apiKey && options.apiKey) {
    apiKey = options.apiKey;
  }
  if (apiKey) {
    ctx.modelRegistry.authStorage.setRuntimeApiKey(model.provider, apiKey);
  }

  return {
    model,
    apiKey,
    headers,
    auth: describeResolvedAuth(model.provider, authSource, apiKey, headers),
    loadResult: services.resourceLoader.getExtensions(),
    modelRegistry: ctx.modelRegistry,
    cwd: options.piContextCwd,
    agentDir: services.agentDir,
    services,
    extensionPaths: options.resolvedExtensionPaths,
  };
}
