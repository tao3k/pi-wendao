import { afterEach, describe, expect, it } from "vitest";
import {
	resolveBuiltinPiExtensionPaths,
	resolveModel,
	resolveSkillscPackageRoot,
	resolveSkillscPiExtensionPaths,
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

		const result = await resolveModel("anthropic/claude-sonnet-4-20250514");

		expect(result.model.provider).toBe("anthropic");
		expect(result.model.baseUrl).toBe("https://anthropic.example.test");
		expect(result.apiKey).toBe("test-token");
		await expect(result.modelRegistry.getApiKeyForProvider("anthropic")).resolves.toBe("test-token");
		expect(collectLoadedToolNames(result.loadResult)).toEqual(expect.arrayContaining([
			"Agent",
			"get_subagent_result",
			"intercom",
		]));
	});

	it("accepts Anthropic gateway model ids outside the built-in registry", async () => {
		process.env.ANTHROPIC_BASE_URL = "https://anthropic.example.test";
		process.env.ANTHROPIC_AUTH_TOKEN = "test-token";

		const result = await resolveModel("anthropic/mimo-v2-pro");

		expect(result.model.provider).toBe("anthropic");
		expect(result.model.id).toBe("mimo-v2-pro");
		expect(result.model.baseUrl).toBe("https://anthropic.example.test");
		expect(result.apiKey).toBe("test-token");
		await expect(result.modelRegistry.getApiKeyForProvider("anthropic")).resolves.toBe("test-token");
	});

	it("loads packaged pi-subagents as a built-in extension", () => {
		expect(resolveBuiltinPiExtensionPaths().some((path) => path.includes("@tintinweb/pi-subagents"))).toBe(true);
	});

	it("loads packaged pi-intercom as a built-in extension", () => {
		expect(resolveBuiltinPiExtensionPaths().some((path) => path.includes("pi-intercom"))).toBe(true);
	});

	it("loads pi-wendao project pi extensions before packaged pi-intercom", () => {
		const paths = resolveBuiltinPiExtensionPaths();
		const graphIntercomIndex = paths.findIndex((path) => path.endsWith("pi-wendao-pi-intercom.js"));
		const packagedIntercomIndex = paths.findIndex((path) => path.includes("node_modules/pi-intercom"));

		expect(resolveSkillscPackageRoot()).toContain("skillsc");
		expect(resolveSkillscPiExtensionPaths()).toEqual(expect.arrayContaining([
			expect.stringContaining("pi-wendao-pi-intercom.js"),
			expect.stringContaining("pi-wendao-tool-event-bridge.js"),
		]));
		expect(graphIntercomIndex).toBeGreaterThanOrEqual(0);
		expect(packagedIntercomIndex).toBeGreaterThan(graphIntercomIndex);
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
