import { getEnvApiKey, getModel, getModels, getProviders, registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import type { KnownProvider, Model } from "@mariozechner/pi-ai";

// Ensure built-in providers are registered
registerBuiltInApiProviders();

export interface ResolvedModel {
	model: Model<string>;
	apiKey?: string;
}

/**
 * Resolve a model pattern and provider into a Model object + API key.
 *
 * Supports:
 * - "provider/modelId" format (e.g., "anthropic/claude-sonnet-4-20250514")
 * - Just model ID with --provider flag
 * - Searches all providers if no provider specified
 */
export function resolveModel(modelPattern: string, provider?: string): ResolvedModel {
	let resolvedProvider = provider;
	let modelId = modelPattern;

	// Handle "provider/model" format
	if (modelPattern.includes("/") && !provider) {
		const slashIndex = modelPattern.indexOf("/");
		resolvedProvider = modelPattern.slice(0, slashIndex);
		modelId = modelPattern.slice(slashIndex + 1);
	}

	if (resolvedProvider) {
		// Try exact match first
		try {
			const model = getModel(resolvedProvider as KnownProvider, modelId as never);
			const apiKey = getEnvApiKey(resolvedProvider as KnownProvider) ?? undefined;
			return { model: model as Model<string>, apiKey };
		} catch {
			// Fall through to fuzzy search
		}

		// Fuzzy search within provider
		const models = getModels(resolvedProvider as KnownProvider);
		const match = models.find((m) => m.id.includes(modelId) || m.name.includes(modelId));
		if (match) {
			const apiKey = getEnvApiKey(resolvedProvider as KnownProvider) ?? undefined;
			return { model: match as Model<string>, apiKey };
		}

		throw new Error(`Model "${modelId}" not found for provider "${resolvedProvider}"`);
	}

	// Search all providers
	for (const p of getProviders()) {
		const models = getModels(p);
		const match = models.find((m) => m.id === modelId || m.id.includes(modelId));
		if (match) {
			const apiKey = getEnvApiKey(p) ?? undefined;
			return { model: match as Model<string>, apiKey };
		}
	}

	throw new Error(`Model "${modelPattern}" not found in any provider`);
}
