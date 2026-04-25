import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
	createAgentSessionServices,
	type AgentSessionServices,
	type LoadExtensionsResult,
	type ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { resolvePiWendaoPackageRoot as resolvePiWendaoPackageRootFromResources } from "../pi-resources.js";

const require = createRequire(import.meta.url);
const BUILTIN_PI_EXTENSION_PACKAGES = ["@tintinweb/pi-subagents"] as const;
const PI_WENDAO_PI_EXTENSION_FILES = [
	"pi-wendao-pi-intercom.js",
	"pi-wendao-tool-event-bridge.js",
] as const;

export interface ResolvedModel {
	model: Model<string>;
	apiKey?: string;
	headers?: Record<string, string>;
	loadResult: LoadExtensionsResult;
	modelRegistry: ModelRegistry;
	cwd: string;
	agentDir: string;
	services: AgentSessionServices;
	extensionPaths: string[];
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
			model = all.find((m) => m.provider === resolvedProvider && (m.id.includes(modelId) || m.name.includes(modelId)));
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

	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	let apiKey: string | undefined;
	let headers: Record<string, string> | undefined;
	if (auth.ok) {
		apiKey = auth.apiKey;
		headers = auth.headers;
	}
	if (!apiKey && model.provider === "anthropic") {
		apiKey = process.env.ANTHROPIC_AUTH_TOKEN
			?? process.env.ANTHROPIC_OAUTH_TOKEN
			?? process.env.ANTHROPIC_API_KEY;
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
		loadResult,
		modelRegistry,
		cwd,
		agentDir: services.agentDir,
		services,
		extensionPaths: resolvedExtensionPaths,
	};
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
		const prefix = diagnostic.type === "error" ? "Error" : diagnostic.type === "warning" ? "Warning" : "Info";
		console.warn(`${prefix}: ${diagnostic.message}`);
	}

	return services;
}

export function resolveBuiltinPiExtensionPaths(): string[] {
	const paths: string[] = [];
	for (const packageName of BUILTIN_PI_EXTENSION_PACKAGES) {
		const packageRoot = resolvePackageRoot(packageName);
		if (packageRoot) paths.push(packageRoot);
	}
	paths.push(...resolvePiWendaoPiExtensionPaths());
	return paths;
}

export function resolvePiWendaoPackageRoot(): string {
	return resolvePiWendaoPackageRootFromResources();
}

export function resolvePiWendaoPiExtensionPaths(packageRoot = resolvePiWendaoPackageRoot()): string[] {
	return PI_WENDAO_PI_EXTENSION_FILES
		.map((file) => join(packageRoot, ".pi", "extensions", file))
		.filter((path) => existsSync(path));
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

function createAnthropicGatewayModel(modelRegistry: ModelRegistry, modelId: string): Model<Api> | undefined {
	const template = modelRegistry.find("anthropic", "claude-sonnet-4-20250514")
		?? modelRegistry.getAll().find((m) => m.provider === "anthropic");
	if (!template) return undefined;

	return {
		...template,
		id: modelId,
		name: modelId,
	};
}
