import { describe, expect, it } from "vitest";
import {
	AuthStorage,
	ModelRegistry,
	createExtensionRuntime,
	type LoadExtensionsResult,
} from "@mariozechner/pi-coding-agent";
import { createCliPiIntercomAgentTool, hasLoadedPiIntercomTool } from "../../src/cli/pi-intercom.js";
import { createCliExtensionContext } from "../../src/cli/pi-subagents.js";
import type { PiRegisteredToolDefinition } from "../../src/executor/pi-subagents-runtime.js";

describe("CLI pi-intercom tool integration", () => {
	it("creates an agent tool from a loaded pi-intercom extension", async () => {
		const modelRegistry = ModelRegistry.create(AuthStorage.create());
		const calls: Array<{ params: Record<string, unknown>; cwd: string; hasUI: boolean }> = [];
		const loadResult = loadResultWithTools({
			intercom: tool("intercom", async (params, ctx) => {
				calls.push({ params, cwd: ctx.cwd, hasUI: ctx.hasUI });
				expect(ctx.modelRegistry).toBe(modelRegistry);
				return {
					content: [{ type: "text", text: "Connected: Yes" }],
				};
			}),
		});

		const intercom = createCliPiIntercomAgentTool({
			loadResult,
			modelRegistry,
			cwd: "/tmp/project",
		});

		await expect(intercom?.execute("tool-1", { action: "status" })).resolves.toEqual({
			content: [{ type: "text", text: "Connected: Yes" }],
			details: undefined,
		});
		expect(calls).toEqual([{
			params: { action: "status" },
			cwd: "/tmp/project",
			hasUI: false,
		}]);
	});

	it("returns undefined when loaded extensions do not include pi-intercom", () => {
		const modelRegistry = ModelRegistry.create(AuthStorage.create());
		const intercom = createCliPiIntercomAgentTool({
			loadResult: loadResultWithTools({}),
			modelRegistry,
			cwd: "/tmp/project",
		});

		expect(intercom).toBeUndefined();
	});

	it("reports whether loaded extensions include pi-intercom", () => {
		expect(hasLoadedPiIntercomTool(loadResultWithTools({
			intercom: tool("intercom", async () => ({ content: [] })),
		}))).toBe(true);
		expect(hasLoadedPiIntercomTool(loadResultWithTools({}))).toBe(false);
	});
});

function loadResultWithTools(tools: Record<string, PiRegisteredToolDefinition>): LoadExtensionsResult {
	return {
		extensions: [{
			tools: new Map(Object.entries(tools).map(([name, definition]) => [
				name,
				{
					definition,
					sourceInfo: {
						path: "fixture.ts",
						resolvedPath: "fixture.ts",
						type: "extension",
					},
				},
			])),
		}],
		errors: [],
		runtime: createExtensionRuntime(),
	} as unknown as LoadExtensionsResult;
}

function tool(
	name: string,
	execute: (
		params: Record<string, unknown>,
		ctx: ReturnType<typeof createCliExtensionContext>,
	) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>,
): PiRegisteredToolDefinition {
	return {
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			expect(toolCallId).toContain(name);
			return execute(params, ctx as ReturnType<typeof createCliExtensionContext>);
		},
	};
}
