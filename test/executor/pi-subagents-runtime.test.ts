import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSubagentsHost } from "../../src/executor/pi-subagents-host.js";
import {
  collectPiSubagentsRegisteredTools,
  createPiSubagentsClientFromLoadedExtensions,
  createPiSubagentsClientFromRegisteredTools,
  createPiSubagentsHostFromLoadedExtensions,
  discoverPiSubagentsHost,
  getCurrentPiSubagentsToolExecutionContext,
  tryCreatePiSubagentsHostFromLoadedExtensions,
  type PiRegisteredToolDefinition,
} from "../../src/executor/pi-subagents-runtime.js";

const tempDirs: string[] = [];

describe("pi-subagents runtime tool adapter", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adapts registered Agent and get_subagent_result tools into a host client", async () => {
    const calls: Array<{ name: string; params: Record<string, unknown>; ctx: unknown }> = [];
    const ctx = { cwd: "/tmp/project" };
    const tools = {
      Agent: tool("Agent", async (params, receivedCtx) => {
        calls.push({ name: "Agent", params, ctx: receivedCtx });
        return {
          content: [
            {
              type: "text",
              text: "Agent started in background.\nAgent ID: agent-runtime-1\n",
            },
          ],
        };
      }),
      get_subagent_result: tool("get_subagent_result", async (params, receivedCtx) => {
        calls.push({ name: "get_subagent_result", params, ctx: receivedCtx });
        return {
          content: [
            {
              type: "text",
              text: 'Done.\n```json\n{"result":"runtime_done"}\n```',
            },
          ],
        };
      }),
    };
    const host = createPiSubagentsHost({
      client: createPiSubagentsClientFromRegisteredTools(tools, {
        ctx,
        toolCallIdPrefix: "test",
      }),
    });

    const output = await host.run({
      activityId: "Task_Runtime",
      variables: { item: "alpha" },
      config: {
        prompt: "Run ${environment.variables.item}.",
        tools: [],
        inputs: ["item"],
        outputs: ["result"],
        subagent: {
          type: "pi-wendao-worker",
          runInBackground: true,
        },
      },
      execution: {
        instanceId: "instance-runtime",
        tokenId: 7,
      },
    });

    expect(output).toEqual({ result: "runtime_done" });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      name: "Agent",
      ctx,
      params: {
        description: "Run BPMN service task Task_Runtime",
        subagent_type: "pi-wendao-output-only",
        run_in_background: true,
      },
    });
    expect(calls[0]?.params.prompt).toContain('"alpha"');
    expect(calls[1]).toMatchObject({
      name: "get_subagent_result",
      ctx,
      params: {
        agent_id: "agent-runtime-1",
        wait: true,
      },
    });
  });

  it("prefers an agent id from tool result details", async () => {
    let resultAgentId = "";
    const client = createPiSubagentsClientFromRegisteredTools(
      {
        Agent: tool("Agent", async () => ({
          content: [{ type: "text", text: "Agent ID: text-id" }],
          details: { agentId: "details-id" },
        })),
        get_subagent_result: tool("get_subagent_result", async (params) => {
          resultAgentId = String(params.agent_id);
          return { content: [{ type: "text", text: "{}" }] };
        }),
      },
      { ctx: {} },
    );

    await client
      .spawn({
        prompt: "Run",
        description: "Run",
        subagent_type: "general-purpose",
        run_in_background: true,
      })
      .then(async (spawned) => {
        const agentId = typeof spawned === "string" ? spawned : spawned.agent_id;
        await client.getResult({ agent_id: agentId ?? "", wait: true });
      });

    expect(resultAgentId).toBe("details-id");
  });

  it("discovers pi-subagents tools from loaded extensions", () => {
    const agent = tool("Agent", async () => ({ content: [] }));
    const getResult = tool("get_subagent_result", async () => ({ content: [] }));
    const tools = collectPiSubagentsRegisteredTools({
      extensions: [
        {
          tools: new Map([
            ["other", { definition: tool("other", async () => ({ content: [] })) }],
            ["Agent", { definition: agent }],
            ["get_subagent_result", { definition: getResult }],
          ]),
        },
      ],
    });

    expect(tools.Agent).toBe(agent);
    expect(tools.get_subagent_result).toBe(getResult);
  });

  it("creates a client from loaded extensions", async () => {
    const client = createPiSubagentsClientFromLoadedExtensions(
      {
        extensions: [
          {
            tools: new Map([
              [
                "Agent",
                {
                  definition: tool("Agent", async () => ({
                    content: [{ type: "text", text: "Agent ID: loaded-agent" }],
                  })),
                },
              ],
              [
                "get_subagent_result",
                {
                  definition: tool("get_subagent_result", async () => ({
                    content: [{ type: "text", text: "loaded result" }],
                  })),
                },
              ],
            ]),
          },
        ],
      },
      { ctx: {} },
    );

    await expect(
      client.spawn({
        prompt: "Run",
        description: "Run",
        subagent_type: "general-purpose",
        run_in_background: true,
      }),
    ).resolves.toEqual({ agent_id: "loaded-agent" });
    await expect(client.getResult({ agent_id: "loaded-agent", wait: true })).resolves.toBe(
      "loaded result",
    );
  });

  it("creates a checkpoint-aware host from loaded extensions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-runtime-host-"));
    tempDirs.push(dir);
    const storePath = join(dir, "subagents.json");
    const ctx = { cwd: "/tmp/project" };
    const loaded = {
      extensions: [
        {
          tools: new Map([
            [
              "Agent",
              {
                definition: tool("Agent", async () => ({
                  content: [{ type: "text", text: "Agent ID: runtime-host-agent" }],
                })),
              },
            ],
            [
              "get_subagent_result",
              {
                definition: tool("get_subagent_result", async (params, receivedCtx) => {
                  expect(receivedCtx).toBe(ctx);
                  expect(params).toMatchObject({
                    agent_id: "runtime-host-agent",
                    wait: true,
                    verbose: true,
                  });
                  return {
                    content: [
                      {
                        type: "text",
                        text: 'Done.\n```json\n{"result":"runtime_host_done"}\n```',
                      },
                    ],
                  };
                }),
              },
            ],
          ]),
        },
      ],
    };
    const host = createPiSubagentsHostFromLoadedExtensions({
      loadResult: loaded,
      ctx,
      runStorePath: storePath,
      verboseResult: true,
    });
    const request = {
      activityId: "Task_RuntimeHost",
      variables: {},
      config: {
        prompt: "Run runtime host task.",
        tools: [],
        inputs: [],
        outputs: ["result"],
      },
      execution: {
        instanceId: "instance-runtime-host",
        tokenId: 9,
      },
    };

    await expect(host.run(request)).resolves.toEqual({ result: "runtime_host_done" });

    let called = false;
    const cachedHost = createPiSubagentsHostFromLoadedExtensions({
      loadResult: {
        extensions: [
          {
            tools: new Map([
              [
                "Agent",
                {
                  definition: tool("Agent", async () => {
                    called = true;
                    throw new Error("cached runtime host should not spawn");
                  }),
                },
              ],
              [
                "get_subagent_result",
                {
                  definition: tool("get_subagent_result", async () => {
                    called = true;
                    throw new Error("cached runtime host should not fetch result");
                  }),
                },
              ],
            ]),
          },
        ],
      },
      ctx,
      runStorePath: storePath,
    });

    await expect(cachedHost.run(request)).resolves.toEqual({ result: "runtime_host_done" });
    expect(called).toBe(false);
  });

  it("forwards registered tool updates with BPMN activity context", async () => {
    const updates: unknown[] = [];
    const host = createPiSubagentsHostFromLoadedExtensions({
      loadResult: {
        extensions: [
          {
            tools: new Map([
              [
                "Agent",
                {
                  definition: {
                    async execute(
                      _toolCallId: string,
                      _params: Record<string, unknown>,
                      _signal: AbortSignal | undefined,
                      onUpdate: unknown,
                    ) {
                      if (typeof onUpdate === "function") {
                        onUpdate({
                          details: {
                            activity: "running bash",
                            toolUses: 1,
                          },
                        });
                      }
                      return {
                        content: [{ type: "text", text: "Agent ID: update-agent" }],
                      };
                    },
                  },
                },
              ],
              [
                "get_subagent_result",
                {
                  definition: tool("get_subagent_result", async () => ({
                    content: [{ type: "text", text: '```json\n{"result":"updated"}\n```' }],
                  })),
                },
              ],
            ]),
          },
        ],
      },
      ctx: {},
      onUpdate: (event) => updates.push(event),
    });

    await expect(
      host.run({
        activityId: "Task_Update",
        variables: {},
        config: {
          prompt: "Run update task.",
          tools: [],
          inputs: [],
          outputs: ["result"],
        },
      }),
    ).resolves.toEqual({ result: "updated" });

    expect(updates).toEqual([
      {
        type: "update",
        activityId: "Task_Update",
        description: "Run BPMN service task Task_Update",
        update: {
          details: {
            activity: "running bash",
            toolUses: 1,
          },
        },
      },
    ]);
  });

  it("keeps BPMN activity context available during pi-subagents tool execution", async () => {
    const contexts: unknown[] = [];
    const host = createPiSubagentsHostFromLoadedExtensions({
      loadResult: {
        extensions: [
          {
            tools: new Map([
              [
                "Agent",
                {
                  definition: {
                    async execute() {
                      contexts.push(getCurrentPiSubagentsToolExecutionContext());
                      await delay(1);
                      contexts.push(getCurrentPiSubagentsToolExecutionContext());
                      return {
                        content: [{ type: "text", text: "Agent ID: context-agent" }],
                      };
                    },
                  },
                },
              ],
              [
                "get_subagent_result",
                {
                  definition: tool("get_subagent_result", async () => ({
                    content: [{ type: "text", text: '```json\n{"result":"context"}\n```' }],
                  })),
                },
              ],
            ]),
          },
        ],
      },
      ctx: {},
    });

    await expect(
      host.run({
        activityId: "Task_Context",
        variables: {},
        config: {
          prompt: "Run context task.",
          tools: [],
          inputs: [],
          outputs: ["result"],
        },
      }),
    ).resolves.toEqual({ result: "context" });

    expect(contexts).toEqual([
      {
        activityId: "Task_Context",
        description: "Run BPMN service task Task_Context",
      },
      {
        activityId: "Task_Context",
        description: "Run BPMN service task Task_Context",
      },
    ]);
  });

  it("returns undefined when loaded extensions do not provide pi-subagents tools", () => {
    expect(
      tryCreatePiSubagentsHostFromLoadedExtensions({
        loadResult: { extensions: [] },
        ctx: {},
      }),
    ).toBeUndefined();
  });

  it("discovers configured pi extensions and creates a runtime host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-discover-pi-subagents-"));
    tempDirs.push(dir);
    const extensionPath = join(dir, "subagents-fixture.ts");
    writeFileSync(
      extensionPath,
      `
import { Type } from "@sinclair/typebox";

export default function(pi) {
  pi.registerTool({
    name: "Agent",
    label: "Agent",
    description: "Fixture Agent",
    parameters: Type.Object({}),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: "Agent ID: discovered-agent\\n" }],
      details: { agentId: "discovered-agent" },
    }),
  });
  pi.registerTool({
    name: "get_subagent_result",
    label: "Get Agent Result",
    description: "Fixture result lookup",
    parameters: Type.Object({}),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: "Done.\\n\`\`\`json\\n{\\"result\\":\\"" + params.agent_id + "\\"}\\n\`\`\`" }],
    }),
  });
}
`,
      "utf-8",
    );

    const discovered = await discoverPiSubagentsHost({
      extensionPaths: [extensionPath],
      cwd: dir,
      agentDir: join(dir, "agent"),
      ctx: { cwd: dir },
    });

    expect(discovered.errors).toEqual([]);
    expect(discovered.host).toBeDefined();
    await expect(
      discovered.host!.run({
        activityId: "Task_Discovered",
        variables: {},
        config: {
          prompt: "Run discovered extension.",
          tools: [],
          inputs: [],
          outputs: ["result"],
        },
        execution: {
          instanceId: "instance-discovered",
          tokenId: 10,
        },
      }),
    ).resolves.toEqual({ result: "discovered-agent" });
  });
});

function tool(
  name: string,
  execute: (
    params: Record<string, unknown>,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>,
): PiRegisteredToolDefinition {
  return {
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      expect(_toolCallId).toContain(name);
      return execute(params, ctx);
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
