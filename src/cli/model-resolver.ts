import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
  createAgentSessionServices,
  type AgentSessionServices,
  type AuthStorage,
  type LoadExtensionsResult,
  type ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { resolvePiWendaoPackageRoot as resolvePiWendaoPackageRootFromResources } from "../pi-resources.js";

const require = createRequire(import.meta.url);
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
    if (!model && resolvedProvider === "anthropic" && process.env.ANTHROPIC_BASE_URL?.trim()) {
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
  if (!apiKeyOverride) {
    const envAuth = applyPiWendaoEnvAuthOverride(authStorage, model.provider);
    if (envAuth) authSource = envAuth.source;
  }

  const auth = await modelRegistry.getApiKeyAndHeaders(model);
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

export function applyPiWendaoEnvAuthOverride(
  authStorage: Pick<AuthStorage, "setRuntimeApiKey">,
  provider: string,
): { apiKey: string; source: string } | undefined {
  if (provider !== "anthropic") return undefined;
  const envAuth = resolvePiWendaoAnthropicEnvAuth();
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

  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim();
  if (!baseUrl) return model;

  return {
    ...model,
    baseUrl,
  };
}

export function resolvePiWendaoAnthropicEnvAuth(): { apiKey: string; source: string } | undefined {
  const apiKey = readEnv("ANTHROPIC_API_KEY");
  if (apiKey) return { apiKey, source: "env:ANTHROPIC_API_KEY" };
  const oauthToken = readEnv("ANTHROPIC_OAUTH_TOKEN");
  if (oauthToken?.includes("sk-ant-oat"))
    return { apiKey: oauthToken, source: "env:ANTHROPIC_OAUTH_TOKEN" };
  const authToken = readEnv("ANTHROPIC_AUTH_TOKEN");
  if (authToken?.includes("sk-ant-oat")) {
    return { apiKey: authToken, source: "env:ANTHROPIC_AUTH_TOKEN" };
  }
  return undefined;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
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
    modelRegistry.find("anthropic", "claude-sonnet-4-20250514") ??
    modelRegistry.getAll().find((m) => m.provider === "anthropic");
  if (!template) return undefined;

  return {
    ...template,
    id: modelId,
    name: modelId,
  };
}
