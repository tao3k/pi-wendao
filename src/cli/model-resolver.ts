import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  type AgentSessionServices,
  type AuthStorage,
  type LoadExtensionsResult,
  type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { resolvePiWendaoPackageRoot as resolvePiWendaoPackageRootFromResources } from "../pi-resources.js";

const require = createRequire(import.meta.url);
const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DYNAMIC_GATEWAY_MODELS = Symbol.for("pi-wendao.dynamicGatewayModels");
const PI_WENDAO_PI_EXTENSION_FILES = [
  "pi-wendao-pi-intercom.js",
  "pi-wendao-tool-event-bridge.js",
] as const;

export interface ResolvedModel {
  model: Model<string>;
  apiKey?: string;
  headers?: Record<string, string>;
  auth?: PiWendaoAuthInfo;
  loadResult: LoadExtensionsResult;
  modelRegistry: ModelRegistry;
  cwd: string;
  agentDir: string;
  services: AgentSessionServices;
  extensionPaths: string[];
}

export interface PiWendaoAuthInfo {
  provider: string;
  source: string;
  keyFingerprint?: string;
  hasHeaders: boolean;
}

/**
 * Resolve a model pattern into a Model object + API key.
 *
 * Loads pi extensions from:
 * - built-in package extensions such as pi-subagents
 * - packaged pi-wendao .pi extension files
 * - ~/.pi/agent/extensions/ and .pi/extensions/ (auto-discovered)
 * - explicit -e paths (pi packages or single files)
 */
export async function resolveModel(
  modelPattern: string,
  provider?: string,
  apiKeyOverride?: string,
  extensionPaths?: string[],
): Promise<ResolvedModel> {
  return resolveModelInternal(modelPattern, provider, apiKeyOverride, extensionPaths);
}

async function resolveModelInternal(
  modelPattern: string,
  provider?: string,
  apiKeyOverride?: string,
  extensionPaths?: string[],
): Promise<ResolvedModel> {
  const cwd = process.cwd();
  const resolvedExtensionPaths = extensionPaths ?? [];
  const services = await createPiWendaoAgentServices({
    cwd,
    extensionPaths: resolvedExtensionPaths,
  });
  const authStorage = services.authStorage;
  const modelRegistry = services.modelRegistry;
  const loadResult = services.resourceLoader.getExtensions();

  if (apiKeyOverride && provider) {
    authStorage.setRuntimeApiKey(provider, apiKeyOverride);
  }

  const loadError = modelRegistry.getError();
  if (loadError) {
    console.warn(`Warning: ${loadError}`);
  }

  let resolvedProvider = provider;
  let modelId = modelPattern;

  if (modelPattern.includes("/") && !resolvedProvider) {
    const slashIndex = modelPattern.indexOf("/");
    resolvedProvider = modelPattern.slice(0, slashIndex);
    modelId = modelPattern.slice(slashIndex + 1);
  }

  if (apiKeyOverride && resolvedProvider) {
    authStorage.setRuntimeApiKey(resolvedProvider, apiKeyOverride);
  }

  let model: Model<Api> | undefined;

  if (resolvedProvider) {
    model = modelRegistry.find(resolvedProvider, modelId);
    if (!model) {
      const all = modelRegistry.getAll();
      model = all.find(
        (m) =>
          m.provider === resolvedProvider && (m.id.includes(modelId) || m.name.includes(modelId)),
      );
    }
    if (
      !model &&
      resolvedProvider === "anthropic" &&
      (process.env.ANTHROPIC_BASE_URL?.trim() || isDeepSeekAnthropicModelId(modelId))
    ) {
      model = createAnthropicGatewayModel(modelRegistry, modelId);
    }
    if (!model) {
      throw new Error(`Model "${modelId}" not found for provider "${resolvedProvider}"`);
    }
  } else {
    model = modelRegistry.getAll().find((m) => m.id === modelId || m.id.includes(modelId));
    if (!model) {
      throw new Error(`Model "${modelPattern}" not found.`);
    }
  }

  model = applyAnthropicEnvOverrides(model);
  let authSource = apiKeyOverride ? "cli:--api-key" : "pi";
  let envAuth: { apiKey: string; source: string } | undefined;
  if (!apiKeyOverride) {
    envAuth = applyPiWendaoEnvAuthOverride(authStorage, model.provider, model.id);
    if (envAuth) authSource = envAuth.source;
  }

  const skipStoredAuth = shouldSkipStoredAuth(model, apiKeyOverride, envAuth);
  const auth = envAuth
    ? ({ ok: true, apiKey: envAuth.apiKey, headers: undefined } as const)
    : skipStoredAuth
      ? ({ ok: false, error: "DeepSeek gateway model requires explicit DeepSeek auth" } as const)
      : await modelRegistry.getApiKeyAndHeaders(model);
  let apiKey: string | undefined;
  let headers: Record<string, string> | undefined;
  if (auth.ok) {
    apiKey = auth.apiKey;
    headers = auth.headers;
  }
  if (!apiKey && apiKeyOverride) {
    apiKey = apiKeyOverride;
  }
  if (apiKey) {
    authStorage.setRuntimeApiKey(model.provider, apiKey);
  }
  if (!skipStoredAuth) {
    installDynamicGatewayModel(modelRegistry, model);
  }

  return {
    model: model as Model<string>,
    apiKey,
    headers,
    auth: describeResolvedAuth(model.provider, authSource, apiKey, headers),
    loadResult,
    modelRegistry,
    cwd,
    agentDir: services.agentDir,
    services,
    extensionPaths: resolvedExtensionPaths,
  };
}

type ModelRegistryWithDynamicModels = ModelRegistry & {
  [DYNAMIC_GATEWAY_MODELS]?: Map<string, Model<Api>>;
};

function installDynamicGatewayModel(modelRegistry: ModelRegistry, model: Model<Api>): void {
  if (!isGatewayModel(model)) return;
  const registry = modelRegistry as ModelRegistryWithDynamicModels;
  let dynamicModels = registry[DYNAMIC_GATEWAY_MODELS];
  if (!dynamicModels) {
    dynamicModels = new Map<string, Model<Api>>();
    Object.defineProperty(registry, DYNAMIC_GATEWAY_MODELS, {
      value: dynamicModels,
      enumerable: false,
    });
    const originalFind = registry.find.bind(registry);
    const originalGetAll = registry.getAll.bind(registry);
    const originalGetAvailable = registry.getAvailable.bind(registry);
    registry.find = ((provider: string, modelId: string) => {
      return dynamicModels!.get(modelKey(provider, modelId)) ?? originalFind(provider, modelId);
    }) as ModelRegistry["find"];
    registry.getAll = (() => appendDynamicModels(originalGetAll(), dynamicModels!)) as ModelRegistry["getAll"];
    registry.getAvailable = (() => {
      const available = originalGetAvailable();
      const configuredDynamicModels = [...dynamicModels!.values()].filter((dynamicModel) =>
        registry.hasConfiguredAuth(dynamicModel),
      );
      return appendDynamicModels(available, new Map(configuredDynamicModels.map((item) => [modelKey(item.provider, item.id), item])));
    }) as ModelRegistry["getAvailable"];
  }
  dynamicModels.set(modelKey(model.provider, model.id), model);
}

function appendDynamicModels(models: Model<Api>[], dynamicModels: Map<string, Model<Api>>): Model<Api>[] {
  const seen = new Set(models.map((model) => modelKey(model.provider, model.id)));
  const appended = [...models];
  for (const [key, model] of dynamicModels) {
    if (seen.has(key)) continue;
    appended.push(model);
  }
  return appended;
}

function isGatewayModel(model: Model<Api>): boolean {
  return Boolean(model.baseUrl) && !isBuiltInAnthropicModelId(model.id);
}

function shouldSkipStoredAuth(
  model: Model<Api>,
  apiKeyOverride: string | undefined,
  envAuth: { apiKey: string; source: string } | undefined,
): boolean {
  return (
    !apiKeyOverride &&
    !envAuth &&
    model.provider === "anthropic" &&
    isDeepSeekAnthropicModelId(model.id) &&
    model.baseUrl === DEEPSEEK_ANTHROPIC_BASE_URL
  );
}

function isBuiltInAnthropicModelId(modelId: string): boolean {
  return modelId.toLowerCase().startsWith("claude-");
}

function modelKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`.toLowerCase();
}

export function applyPiWendaoEnvAuthOverride(
  authStorage: Pick<AuthStorage, "setRuntimeApiKey">,
  provider: string,
  modelId?: string,
): { apiKey: string; source: string } | undefined {
  if (provider === "openrouter") {
    const envAuth = readOpenRouterApiKey();
    if (!envAuth) return undefined;
    authStorage.setRuntimeApiKey(provider, envAuth.apiKey);
    return envAuth;
  }
  if (provider !== "anthropic") return undefined;
  const envAuth = resolvePiWendaoAnthropicEnvAuth({ modelId });
  if (!envAuth) return undefined;
  authStorage.setRuntimeApiKey(provider, envAuth.apiKey);
  return envAuth;
}

export async function createPiWendaoAgentServices(options: {
  cwd: string;
  extensionPaths?: string[];
  systemPrompt?: string;
}): Promise<AgentSessionServices> {
  const services = await createAgentSessionServices({
    cwd: options.cwd,
    resourceLoaderOptions: {
      additionalExtensionPaths: uniqueStrings([
        ...resolveBuiltinPiExtensionPaths(),
        ...(options.extensionPaths ?? []),
      ]),
      systemPrompt: options.systemPrompt,
    },
  });
  const loadResult = services.resourceLoader.getExtensions();

  for (const err of loadResult.errors) {
    console.warn(`Warning: failed to load extension ${err.path}: ${err.error}`);
  }

  for (const diagnostic of services.diagnostics) {
    const prefix =
      diagnostic.type === "error" ? "Error" : diagnostic.type === "warning" ? "Warning" : "Info";
    console.warn(`${prefix}: ${diagnostic.message}`);
  }

  return services;
}

export function resolveBuiltinPiExtensionPaths(): string[] {
  const paths: string[] = [];
  paths.push(resolvePiWendaoPiSubagentsExtensionPath());
  paths.push(...resolvePiWendaoPiExtensionPaths());
  return paths;
}

export function resolvePiWendaoPackageRoot(): string {
  return resolvePiWendaoPackageRootFromResources();
}

export function resolvePiWendaoPiExtensionPaths(
  packageRoot = resolvePiWendaoPackageRoot(),
): string[] {
  return PI_WENDAO_PI_EXTENSION_FILES.map((file) =>
    join(packageRoot, ".pi", "extensions", file),
  ).filter((path) => existsSync(path));
}

export function resolvePiWendaoPiSubagentsExtensionPath(
  packageRoot = resolvePiWendaoPackageRoot(),
): string {
  return join(packageRoot, "src", "cli", "native", "pi-subagents-extension.ts");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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

function applyAnthropicEnvOverrides(model: Model<Api>): Model<Api> {
  if (model.provider !== "anthropic") return model;
  if (isDeepSeekAnthropicModelId(model.id)) {
    return {
      ...model,
      baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
    };
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim() ?? undefined;
  if (!baseUrl) return model;

  return {
    ...model,
    baseUrl,
  };
}

export function resolvePiWendaoAnthropicEnvAuth(options?: {
  modelId?: string;
}): { apiKey: string; source: string } | undefined {
  const deepseekApiKey = readEnv("DEEPSEEK_API_KEY");
  if (
    deepseekApiKey &&
    (isDeepSeekAnthropicGateway() || isDeepSeekAnthropicModelId(options?.modelId ?? ""))
  ) {
    return { apiKey: deepseekApiKey, source: "env:DEEPSEEK_API_KEY" };
  }
  const apiKey = readEnv("ANTHROPIC_API_KEY");
  if (apiKey) return { apiKey, source: "env:ANTHROPIC_API_KEY" };
  if (isOpenRouterAnthropicGateway()) {
    const openRouterApiKey = readOpenRouterApiKey();
    if (openRouterApiKey) return openRouterApiKey;
  }
  const authToken = readEnv("ANTHROPIC_AUTH_TOKEN");
  const oauthToken = readEnv("ANTHROPIC_OAUTH_TOKEN");
  if (oauthToken?.includes("sk-ant-oat"))
    return { apiKey: oauthToken, source: "env:ANTHROPIC_OAUTH_TOKEN" };
  if (authToken && readEnv("ANTHROPIC_BASE_URL")) {
    return { apiKey: authToken, source: "env:ANTHROPIC_AUTH_TOKEN" };
  }
  if (authToken?.includes("sk-ant-oat")) {
    return { apiKey: authToken, source: "env:ANTHROPIC_AUTH_TOKEN" };
  }
  return undefined;
}

function readOpenRouterApiKey(): { apiKey: string; source: string } | undefined {
  for (const name of [
    "OPENROUTER_API_KEY",
    "OPENROUTE_API_KEY",
    "WENDAO_OPENROUTER_API_KEY",
  ]) {
    const apiKey = readEnv(name);
    if (apiKey) return { apiKey, source: `env:${name}` };
  }

  return undefined;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  return stripMatchingQuotes(value);
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function isDeepSeekAnthropicGateway(): boolean {
  const baseUrl = readEnv("ANTHROPIC_BASE_URL");
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === "api.deepseek.com";
  } catch {
    return baseUrl.includes("api.deepseek.com");
  }
}

function isOpenRouterAnthropicGateway(): boolean {
  const baseUrl = readEnv("ANTHROPIC_BASE_URL");
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === "openrouter.ai";
  } catch {
    return baseUrl.includes("openrouter.ai");
  }
}

function isDeepSeekAnthropicModelId(modelId: string): boolean {
  return modelId.toLowerCase().startsWith("deepseek-");
}

export function describeResolvedAuth(
  provider: string,
  source: string,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
): PiWendaoAuthInfo {
  return {
    provider,
    source,
    ...(apiKey ? { keyFingerprint: fingerprintKey(apiKey) } : {}),
    hasHeaders: Boolean(headers && Object.keys(headers).length > 0),
  };
}

function fingerprintKey(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)} len:${value.length}`;
}

function createAnthropicGatewayModel(
  modelRegistry: ModelRegistry,
  modelId: string,
): Model<Api> | undefined {
  const template =
    modelRegistry.find("anthropic", "claude-sonnet-4-6") ??
    modelRegistry.getAll().find((m) => m.provider === "anthropic");
  if (!template) return undefined;

  return {
    ...template,
    id: modelId,
    name: modelId,
  };
}
