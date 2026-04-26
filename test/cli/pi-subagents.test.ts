import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthStorage,
  ModelRegistry,
  createExtensionRuntime,
  type LoadExtensionsResult,
} from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_PI_WENDAO_SUBAGENT_TYPE,
  createCliExtensionContext,
  createCliPiSubagentsHost,
  defaultPiSubagentsRunStorePath,
} from "../../src/cli/pi-subagents.js";
import type { PiRegisteredToolDefinition } from "../../src/executor/pi-subagents-runtime.js";

const tempDirs: string[] = [];

describe("CLI pi-subagents host integration", () => {
  const originalRunStore = process.env.PI_WENDAO_SUBAGENTS_RUN_STORE;
  const originalCacheHome = process.env.PRJ_CACHE_HOME;

  afterEach(() => {
    restoreEnv("PI_WENDAO_SUBAGENTS_RUN_STORE", originalRunStore);
    restoreEnv("PRJ_CACHE_HOME", originalCacheHome);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a real extension context and pi-subagents host from loaded tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-pi-subagents-"));
    tempDirs.push(dir);
    const modelRegistry = ModelRegistry.create(AuthStorage.create());
    const calls: Array<{ name: string; cwd: string; hasUI: boolean; subagentType?: unknown }> = [];
    const loadResult = loadResultWithTools({
      Agent: tool("Agent", async (params, ctx) => {
        calls.push({
          name: "Agent",
          cwd: ctx.cwd,
          hasUI: ctx.hasUI,
          subagentType: params.subagent_type,
        });
        expect(ctx.modelRegistry).toBe(modelRegistry);
        expect(ctx.isIdle()).toBe(true);
        return {
          content: [{ type: "text", text: "Agent ID: cli-subagent\n" }],
          details: { agentId: "cli-subagent" },
        };
      }),
      get_subagent_result: tool("get_subagent_result", async (_params, ctx) => {
        calls.push({ name: "get_subagent_result", cwd: ctx.cwd, hasUI: ctx.hasUI });
        return {
          content: [
            {
              type: "text",
              text: 'Done.\n```json\n{"result":"cli_done"}\n```',
            },
          ],
        };
      }),
    });

    const host = createCliPiSubagentsHost({
      loadResult,
      modelRegistry,
      cwd: dir,
      runStorePath: join(dir, "subagents.json"),
    });

    await expect(
      host?.run({
        activityId: "Task_Cli",
        variables: {},
        config: {
          prompt: "Run CLI task.",
          tools: [],
          inputs: [],
          outputs: ["result"],
        },
        execution: {
          instanceId: "cli-pi-subagents-instance",
          tokenId: 31,
        },
      }),
    ).resolves.toEqual({ result: "cli_done" });
    expect(calls).toEqual([
      { name: "Agent", cwd: dir, hasUI: false, subagentType: DEFAULT_PI_WENDAO_SUBAGENT_TYPE },
      { name: "get_subagent_result", cwd: dir, hasUI: false },
    ]);
  });

  it("returns undefined when loaded extensions do not include pi-subagents tools", () => {
    const modelRegistry = ModelRegistry.create(AuthStorage.create());
    const loadResult = loadResultWithTools({});

    const host = createCliPiSubagentsHost({
      loadResult,
      modelRegistry,
      cwd: "/tmp/project",
    });

    expect(host).toBeUndefined();
  });

  it("provides extension APIs expected by tool contexts", () => {
    const modelRegistry = ModelRegistry.create(AuthStorage.create());
    const loadResult = loadResultWithTools({});

    const ctx = createCliExtensionContext({
      loadResult,
      modelRegistry,
      cwd: "/tmp/project",
    });

    expect(ctx.cwd).toBe("/tmp/project");
    expect(ctx.hasUI).toBe(false);
    expect(ctx.modelRegistry).toBe(modelRegistry);
    expect(ctx.ui).toBeDefined();
    expect(ctx.sessionManager).toBeDefined();
    expect(ctx.getSystemPrompt()).toBe("");
  });

  it("wires extension runtime actions into an AgentSession when available", async () => {
    const modelRegistry = ModelRegistry.create(AuthStorage.create());
    const loadResult = loadResultWithTools({});
    const calls: Array<{ type: string; value: unknown; options?: unknown }> = [];
    const fakeSession = {
      sessionManager: {
        appendCustomEntry: (customType: string, data?: unknown) =>
          calls.push({ type: "entry", value: { customType, data } }),
        appendSessionInfo: (name: string) => calls.push({ type: "name", value: name }),
        appendLabelChange: (entryId: string, label: string | undefined) =>
          calls.push({ type: "label", value: { entryId, label } }),
      },
      sendCustomMessage: async (message: unknown, options?: unknown) =>
        calls.push({ type: "custom", value: message, options }),
      sendUserMessage: async (content: unknown, options?: unknown) =>
        calls.push({ type: "user", value: content, options }),
      getActiveToolNames: () => ["read"],
      getAllTools: () => [],
      setActiveToolsByName: (toolNames: string[]) =>
        calls.push({ type: "tools", value: toolNames }),
      reload: async () => calls.push({ type: "reload", value: true }),
      modelRegistry,
      model: undefined,
      isStreaming: false,
      agent: { signal: undefined },
      pendingMessageCount: 0,
      getContextUsage: () => undefined,
      compact: async () => ({}) as never,
      systemPrompt: "session system prompt",
      sessionName: "session-name",
      thinkingLevel: "high",
      setThinkingLevel: (level: string) => calls.push({ type: "thinking", value: level }),
      setModel: async (model: unknown) => {
        calls.push({ type: "model", value: model });
      },
    };

    const ctx = createCliExtensionContext({
      loadResult,
      modelRegistry,
      cwd: "/tmp/project",
      session: fakeSession as never,
    });

    loadResult.runtime.sendMessage({ customType: "workflow", content: "done", display: false });
    loadResult.runtime.sendUserMessage("follow up");
    loadResult.runtime.appendEntry("subagents:record", { id: "a1" });
    loadResult.runtime.setSessionName("renamed");
    loadResult.runtime.setLabel("entry-1", "checkpoint");
    loadResult.runtime.setActiveTools(["bash"]);
    loadResult.runtime.setThinkingLevel("medium");
    await Promise.resolve();

    expect(ctx.getSystemPrompt()).toBe("session system prompt");
    expect(loadResult.runtime.getSessionName()).toBe("session-name");
    expect(loadResult.runtime.getActiveTools()).toEqual(["read"]);
    expect(calls).toEqual([
      {
        type: "custom",
        value: { customType: "workflow", content: "done", display: false },
        options: undefined,
      },
      { type: "user", value: "follow up", options: undefined },
      { type: "entry", value: { customType: "subagents:record", data: { id: "a1" } } },
      { type: "name", value: "renamed" },
      { type: "label", value: { entryId: "entry-1", label: "checkpoint" } },
      { type: "tools", value: ["bash"] },
      { type: "thinking", value: "medium" },
    ]);
  });

  it("uses the project cache home for the default subagent run store", () => {
    process.env.PRJ_CACHE_HOME = "/tmp/prj-cache";
    delete process.env.PI_WENDAO_SUBAGENTS_RUN_STORE;

    expect(defaultPiSubagentsRunStorePath("/repo")).toBe(
      join("/tmp/prj-cache", "pi-wendao", "pi-subagents-run-store.json"),
    );
  });
});

function loadResultWithTools(
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

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
