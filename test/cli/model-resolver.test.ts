import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "@mariozechner/pi-coding-agent";
import {
  applyPiWendaoEnvAuthOverride,
  resolvePiWendaoAnthropicEnvAuth,
  resolveBuiltinPiExtensionPaths,
  resolveModel,
  resolvePiWendaoPackageRoot,
  resolvePiWendaoPiExtensionPaths,
} from "../../src/cli/model-resolver.js";

describe("resolveModel", () => {
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const originalOAuthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    restoreEnv("ANTHROPIC_BASE_URL", originalBaseUrl);
    restoreEnv("ANTHROPIC_AUTH_TOKEN", originalAuthToken);
    restoreEnv("ANTHROPIC_OAUTH_TOKEN", originalOAuthToken);
    restoreEnv("ANTHROPIC_API_KEY", originalApiKey);
  });

  it("uses Claude-compatible Anthropic environment overrides", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://anthropic.example.test";
    process.env.ANTHROPIC_AUTH_TOKEN = "ignored-auth-token";
    process.env.ANTHROPIC_API_KEY = "test-api-key";
    delete process.env.ANTHROPIC_OAUTH_TOKEN;

    const { result, warnings } = await captureWarnings(() =>
      resolveModel("anthropic/claude-sonnet-4-20250514"),
    );

    expect(result.model.provider).toBe("anthropic");
    expect(result.model.baseUrl).toBe("https://anthropic.example.test");
    expect(result.apiKey).toBe("test-api-key");
    await expect(result.modelRegistry.getApiKeyForProvider("anthropic")).resolves.toBe(
      "test-api-key",
    );
    expect(collectLoadedToolNames(result.loadResult)).toEqual(
      expect.arrayContaining(["Agent", "get_subagent_result", "intercom"]),
    );
    expect(collectLoadedToolNames(result.loadResult)).not.toContain("ask_user");
    expect(warnings.join("\n")).not.toContain('Tool "intercom" conflicts');
  });

  it("lets explicit Anthropic environment auth override stale stored auth", async () => {
    const authStorage = AuthStorage.inMemory({
      anthropic: { type: "api_key", key: "stale-auth-json-key" },
    });
    process.env.ANTHROPIC_API_KEY = "fresh-env-api-key";
    delete process.env.ANTHROPIC_OAUTH_TOKEN;

    expect(applyPiWendaoEnvAuthOverride(authStorage, "anthropic")).toEqual({
      apiKey: "fresh-env-api-key",
      source: "env:ANTHROPIC_API_KEY",
    });
    await expect(authStorage.getApiKey("anthropic")).resolves.toBe("fresh-env-api-key");
  });

  it("prefers ANTHROPIC_API_KEY over ANTHROPIC_OAUTH_TOKEN for pi-wendao workflows", async () => {
    const authStorage = AuthStorage.inMemory();
    process.env.ANTHROPIC_API_KEY = "fresh-env-api-key";
    process.env.ANTHROPIC_OAUTH_TOKEN = "older-oauth-token";

    expect(applyPiWendaoEnvAuthOverride(authStorage, "anthropic")).toEqual({
      apiKey: "fresh-env-api-key",
      source: "env:ANTHROPIC_API_KEY",
    });
    await expect(authStorage.getApiKey("anthropic")).resolves.toBe("fresh-env-api-key");
  });

  it("ignores non-oauth ANTHROPIC_OAUTH_TOKEN values when no API key is present", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_OAUTH_TOKEN = "invalid-oauth-token";
    delete process.env.ANTHROPIC_AUTH_TOKEN;

    expect(resolvePiWendaoAnthropicEnvAuth()).toBeUndefined();
  });

  it("accepts Anthropic gateway model ids outside the built-in registry", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://anthropic.example.test";
    process.env.ANTHROPIC_AUTH_TOKEN = "ignored-auth-token";
    process.env.ANTHROPIC_OAUTH_TOKEN = "sk-ant-oat-test-token";
    delete process.env.ANTHROPIC_API_KEY;

    const { result, warnings } = await captureWarnings(() => resolveModel("anthropic/mimo-v2-pro"));

    expect(result.model.provider).toBe("anthropic");
    expect(result.model.id).toBe("mimo-v2-pro");
    expect(result.model.baseUrl).toBe("https://anthropic.example.test");
    expect(result.apiKey).toBe("sk-ant-oat-test-token");
    await expect(result.modelRegistry.getApiKeyForProvider("anthropic")).resolves.toBe(
      "sk-ant-oat-test-token",
    );
    expect(warnings.join("\n")).not.toContain('Tool "intercom" conflicts');
  });

  it("loads the local pi-subagents wrapper as a built-in extension", () => {
    expect(
      resolveBuiltinPiExtensionPaths().some((path) =>
        path.endsWith("src/cli/native/pi-subagents-extension.ts"),
      ),
    ).toBe(true);
  });

  it("does not load packaged pi-ask as a built-in extension", () => {
    expect(resolveBuiltinPiExtensionPaths().some((path) => path.includes("@eko24ive/pi-ask"))).toBe(
      false,
    );
  });

  it("does not load packaged pi-intercom as a second built-in intercom tool", () => {
    expect(
      resolveBuiltinPiExtensionPaths().some((path) => path.includes("node_modules/pi-intercom")),
    ).toBe(false);
  });

  it("loads pi-wendao project pi extensions as built-in graph tools", () => {
    const paths = resolveBuiltinPiExtensionPaths();
    const graphIntercomIndex = paths.findIndex((path) => path.endsWith("pi-wendao-pi-intercom.js"));

    expect(resolvePiWendaoPackageRoot()).toContain(".data");
    expect(resolvePiWendaoPiExtensionPaths()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("pi-wendao-pi-intercom.js"),
        expect.stringContaining("pi-wendao-tool-event-bridge.js"),
      ]),
    );
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

function collectLoadedToolNames(loadResult: {
  extensions?: Array<{ tools?: Map<string, unknown> }>;
}): string[] {
  return (loadResult.extensions ?? []).flatMap((extension) =>
    Array.from(extension.tools?.keys() ?? []),
  );
}

async function captureWarnings<T>(
  callback: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
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
