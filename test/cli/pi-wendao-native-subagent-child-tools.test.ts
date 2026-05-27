import { describe, expect, it } from "vitest";
import {
  createNativeSubagentChildContextExtensionFactories,
  registerNativeSubagentFileTools,
  selectNativeSubagentActiveToolNames,
  selectNativeSubagentChildContextToolNames,
} from "../../src/subagents/index.js";

describe("pi-wendao native subagent child context tools", () => {
  it("inherits core tools while fd and rg override file discovery and grep", () => {
    expect(
      selectNativeSubagentActiveToolNames({
        type: "pi-wendao-readonly",
        isolated: false,
      }),
    ).toEqual([
      "read",
      "fd",
      "rg",
      "wendao_memory_recall",
      "wendao_search_strategy_flow",
      "intercom",
    ]);

    expect(
      selectNativeSubagentActiveToolNames({
        type: "pi-wendao-output-writer",
        isolated: false,
      }),
    ).toEqual([
      "read",
      "write",
      "fd",
      "rg",
      "wendao_memory_recall",
      "wendao_search_strategy_flow",
      "intercom",
    ]);

    expect(
      selectNativeSubagentActiveToolNames({
        type: "general-purpose",
        isolated: false,
      }),
    ).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "fd",
      "rg",
      "wendao_memory_recall",
      "wendao_search_strategy_flow",
      "intercom",
    ]);

    for (const toolName of ["find", "ls", "grep"]) {
      expect(
        selectNativeSubagentActiveToolNames({
          type: "general-purpose",
          isolated: false,
        }),
      ).not.toContain(toolName);
    }
  });

  it("keeps isolated and output-only child sessions tool-free", () => {
    expect(
      selectNativeSubagentActiveToolNames({
        type: "general-purpose",
        isolated: true,
      }),
    ).toEqual([]);

    expect(
      selectNativeSubagentActiveToolNames({
        type: "pi-wendao-output-only",
        isolated: false,
      }),
    ).toEqual([]);

    expect(
      selectNativeSubagentChildContextToolNames({
        type: "pi-wendao-output-only",
        isolated: false,
      }),
    ).toEqual([]);
  });

  it("registers child context tools through inline factories without nested Agent tools", async () => {
    const toolNames: string[] = [];
    const factories = createNativeSubagentChildContextExtensionFactories({
      cwd: process.cwd(),
      type: "pi-wendao-readonly",
      isolated: false,
    });

    for (const factory of factories) {
      await factory({
        registerTool: (tool: { name: string }) => {
          toolNames.push(tool.name);
        },
      } as never);
    }

    expect(toolNames).toEqual([
      "fd",
      "rg",
      "wendao_memory_recall",
      "wendao_search_strategy_flow",
      "intercom",
    ]);
    expect(toolNames).not.toContain("Agent");
    expect(toolNames).not.toContain("get_subagent_result");
  });

  it("executes fd and rg through pi-wendao-owned wrapper tools", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const tools = new Map<
      string,
      { execute: (id: string, params: Record<string, unknown>) => Promise<any> }
    >();

    registerNativeSubagentFileTools(
      {
        registerTool: (tool: {
          name: string;
          execute: (id: string, params: Record<string, unknown>) => Promise<any>;
        }) => {
          tools.set(tool.name, tool);
        },
      },
      {
        cwd: process.cwd(),
        runner: async (input) => {
          calls.push({ command: input.command, args: input.args });
          return {
            stdout:
              input.command === "fd"
                ? "src/subagents/runner.ts\n"
                : "src/subagents/runner.ts:1:match\n",
            stderr: "",
          };
        },
      },
    );

    await expect(
      tools.get("fd")?.execute("fd-1", { pattern: "runner", limit: 5 }),
    ).resolves.toMatchObject({
      content: [{ text: "src/subagents/runner.ts" }],
      details: { customType: "fd", rowCount: 1 },
    });
    await expect(
      tools.get("rg")?.execute("rg-1", { query: "match", path: "src", limit: 5 }),
    ).resolves.toMatchObject({
      content: [{ text: "src/subagents/runner.ts:1:match" }],
      details: { customType: "rg", rowCount: 1 },
    });
    expect(calls[0]).toMatchObject({ command: "fd" });
    expect(calls[0]?.args).toContain("--strip-cwd-prefix");
    expect(calls[1]).toMatchObject({ command: "rg" });
    expect(calls[1]?.args).toContain("--line-number");
  });
});
