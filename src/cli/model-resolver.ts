import type { Api, Model } from "@mariozechner/pi-ai";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

export interface ResolvedModel {
	model: Model<string>;
	apiKey?: string;
}

/**
 * Resolve a model pattern into a Model object + API key.
 *
 * Uses pi-coding-agent's ModelRegistry which loads:
 * - All built-in providers (Anthropic, OpenAI, Google, etc.)
 * - Custom providers from ~/.pi/agent/models.json (Ollama, vLLM, etc.)
 * - OAuth credentials from ~/.pi/agent/auth.json
 * - Environment variable API keys
 */
export async function resolveModel(modelPattern: string, provider?: string, apiKeyOverride?: string): Promise<ResolvedModel> {
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);

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

	// Handle "provider/model" format
	if (modelPattern.includes("/") && !resolvedProvider) {
		const slashIndex = modelPattern.indexOf("/");
		resolvedProvider = modelPattern.slice(0, slashIndex);
		modelId = modelPattern.slice(slashIndex + 1);
	}

	// Apply api-key override now that we know the provider
	if (apiKeyOverride && resolvedProvider) {
		authStorage.setRuntimeApiKey(resolvedProvider, apiKeyOverride);
	}

	let model: Model<Api> | undefined;

	if (resolvedProvider) {
		// Try exact match
		model = modelRegistry.find(resolvedProvider, modelId);

		// Fuzzy match within provider
		if (!model) {
			const all = modelRegistry.getAll();
			model = all.find((m) => m.provider === resolvedProvider && (m.id.includes(modelId) || m.name.includes(modelId)));
		}

		if (!model) {
			throw new Error(`Model "${modelId}" not found for provider "${resolvedProvider}"`);
		}
	} else {
		// Search all providers
		model = modelRegistry.getAll().find((m) => m.id === modelId || m.id.includes(modelId));
		if (!model) {
			throw new Error(`Model "${modelPattern}" not found. Check ~/.pi/agent/models.json for custom providers.`);
		}
	}

	// Resolve API key
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	let apiKey: string | undefined;
	if (auth.ok) {
		apiKey = auth.apiKey;
	}

	// Fall back to override
	if (!apiKey && apiKeyOverride) {
		apiKey = apiKeyOverride;
	}

	return { model: model as Model<string>, apiKey };
}
