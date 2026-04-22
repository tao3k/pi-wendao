import type { Api, Model } from "@mariozechner/pi-ai";
import {
	AuthStorage,
	ModelRegistry,
	discoverAndLoadExtensions,
} from "@mariozechner/pi-coding-agent";

export interface ResolvedModel {
	model: Model<string>;
	apiKey?: string;
}

/**
 * Resolve a model pattern into a Model object + API key.
 *
 * Loads pi extensions from:
 * - ~/.pi/agent/extensions/ and .pi/extensions/ (auto-discovered)
 * - Explicit -e paths (pi packages or single files)
 */
export async function resolveModel(
	modelPattern: string,
	provider?: string,
	apiKeyOverride?: string,
	extensionPaths?: string[],
): Promise<ResolvedModel> {
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);

	// Load pi extensions and apply provider registrations
	const result = await discoverAndLoadExtensions(extensionPaths ?? [], process.cwd());

	for (const err of result.errors) {
		console.warn(`Warning: failed to load extension ${err.path}: ${err.error}`);
	}

	for (const reg of result.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(reg.name, reg.config as Parameters<typeof modelRegistry.registerProvider>[1]);
	}

	// Apply CLI api-key override
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
		if (!model) {
			throw new Error(`Model "${modelId}" not found for provider "${resolvedProvider}"`);
		}
	} else {
		model = modelRegistry.getAll().find((m) => m.id === modelId || m.id.includes(modelId));
		if (!model) {
			throw new Error(`Model "${modelPattern}" not found.`);
		}
	}

	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	let apiKey: string | undefined;
	if (auth.ok) {
		apiKey = auth.apiKey;
	}
	if (!apiKey && apiKeyOverride) {
		apiKey = apiKeyOverride;
	}

	return { model: model as Model<string>, apiKey };
}
