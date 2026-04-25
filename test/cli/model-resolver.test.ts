import { afterEach, describe, expect, it } from "vitest";
import {
	resolveBuiltinPiExtensionPaths,
	resolveModel,
	resolvePiWendaoPackageRoot,
	resolvePiWendaoPiExtensionPaths,
} from "../../src/cli/model-resolver.js";

describe("resolveModel", () => {
	const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
	const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;

	afterEach(() => {
		restoreEnv("ANTHROPIC_BASE_URL", originalBaseUrl);
		restoreEnv("ANTHROPIC_AUTH_TOKEN", originalAuthToken);
	});

	it("uses Claude-compatible Anthropic environment overrides", async () => {
		process.env.ANTHROPIC_BASE_URL = "https://anthropic.example.test";
		process.env.ANTHROPIC_AUTH_TOKEN = "test-token";

		const { result, warnings } = await captureWarnings(() => resolveModel("anthropic/claude-sonnet-4-20250514"));

		expect(result.model.provider).toBe("anthropic");
		expect(result.model.baseUrl).toBe("https://anthropic.example.test");
		expect(result.apiKey).toBe("test-token");
		await expect(result.modelRegistry.getApiKeyForProvider("anthropic")).resolves.toBe("test-token");
		expect(collectLoadedToolNames(result.loadResult)).toEqual(expect.arrayContaining([
			"Agent",
			"get_subagent_result",
			"intercom",
		]));
		expect(warnings.join("\n")).not.toContain("Tool \"intercom\" conflicts");
	});

	it("accepts Anthropic gateway model ids outside the built-in registry", async () => {
		process.env.ANTHROPIC_BASE_URL = "https://anthropic.example.test";
		process.env.ANTHROPIC_AUTH_TOKEN = "test-token";

		const { result, warnings } = await captureWarnings(() => resolveModel("anthropic/mimo-v2-pro"));

		expect(result.model.provider).toBe("anthropic");
		expect(result.model.id).toBe("mimo-v2-pro");
		expect(result.model.baseUrl).toBe("https://anthropic.example.test");
		expect(result.apiKey).toBe("test-token");
		await expect(result.modelRegistry.getApiKeyForProvider("anthropic")).resolves.toBe("test-token");
		expect(warnings.join("\n")).not.toContain("Tool \"intercom\" conflicts");
	});

	it("loads packaged pi-subagents as a built-in extension", () => {
		expect(resolveBuiltinPiExtensionPaths().some((path) => path.includes("@tintinweb/pi-subagents"))).toBe(true);
	});

	it("does not load packaged pi-intercom as a second built-in intercom tool", () => {
		expect(resolveBuiltinPiExtensionPaths().some((path) => path.includes("node_modules/pi-intercom"))).toBe(false);
	});

	it("loads pi-wendao project pi extensions as built-in graph tools", () => {
		const paths = resolveBuiltinPiExtensionPaths();
		const graphIntercomIndex = paths.findIndex((path) => path.endsWith("pi-wendao-pi-intercom.js"));

		expect(resolvePiWendaoPackageRoot()).toContain(".data");
		expect(resolvePiWendaoPiExtensionPaths()).toEqual(expect.arrayContaining([
			expect.stringContaining("pi-wendao-pi-intercom.js"),
			expect.stringContaining("pi-wendao-tool-event-bridge.js"),
		]));
		expect(graphIntercomIndex).toBeGreaterThanOrEqual(0);
	});
});

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

function collectLoadedToolNames(loadResult: { extensions?: Array<{ tools?: Map<string, unknown> }> }): string[] {
	return (loadResult.extensions ?? []).flatMap((extension) => Array.from(extension.tools?.keys() ?? []));
}

async function captureWarnings<T>(callback: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
	const originalWarn = console.warn;
	const warnings: string[] = [];
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map((arg) => String(arg)).join(" "));
	};
	try {
		const result = await callback();
		return { result, warnings };
	} finally {
		console.warn = originalWarn;
	}
}
