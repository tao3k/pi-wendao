import { expect } from "vitest";
import { createExtensionRuntime, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { createCliExtensionContext } from "../../src/cli/pi-subagents.js";
import type { PiRegisteredToolDefinition } from "../../src/executor/pi-subagents-runtime.js";

export function loadResultWithTools(
  tools: Record<string, PiRegisteredToolDefinition>,
): LoadExtensionsResult {
  return {
    extensions: [
      {
        tools: new Map(
          Object.entries(tools).map(([name, definition]) => [
            name,
            {
              definition,
              sourceInfo: {
                path: "fixture.ts",
                resolvedPath: "fixture.ts",
                type: "extension",
              },
            },
          ]),
        ),
      },
    ],
    errors: [],
    runtime: createExtensionRuntime(),
  } as unknown as LoadExtensionsResult;
}

export function tool(
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
