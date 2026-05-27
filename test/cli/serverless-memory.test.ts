import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveNativeChatStartup } from "../../src/cli/native/chat-startup.js";
import { launchPiWendaoNativeTuiWithMain } from "../../src/cli/pi-wendao-native-launcher.js";
import {
  PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE,
  SERVERLESS_MEMORY_RECALL_BENCHMARK_TASK_PROMPT,
  SERVERLESS_MEMORY_RECALL_LIVE_TASK_PROMPT,
  WENDAO_MEMORY_RECALL_TOOL_NAME,
  appendServerlessMemoryRecallPacket,
  injectServerlessMemoryRecallMessage,
  parseServerlessMemoryRecallPacket,
  readServerlessMemoryRecallPacketFile,
  registerServerlessMemoryRecallInjection,
  registerServerlessMemoryRecallTool,
  renderServerlessMemoryRecallContent,
  serverlessMemoryRecallDetails,
  type ServerlessMemoryRecallCommandRunnerInput,
} from "../../src/cli/serverless-memory/index.js";

describe("serverless memory recall packet", () => {
  it("parses wendao-client recall packets and filters empty memory rows", () => {
    const packet = parseServerlessMemoryRecallPacket(taskListJsonFixture().recallPacket);

    expect(packet.transport).toBe("local-duckdb-arrow-ready");
    expect(packet.rows).toHaveLength(1);
    expect(packet.rows[0]?.orgid).toBe("accepted-memory-sample");
    expect(packet.rows[0]?.locator.section.orgid).toBe("accepted-memory-sample");
    expect(packet.rows[0]?.sourceRangeStart).toBe(0);
    expect(packet.rows[0]?.sourceRangeEnd).toBeGreaterThan(0);
    expect(packet.rows[0]?.memoryObjects.map((object) => object.kind)).toEqual([
      "finality",
      "claim",
    ]);
    expect(packet.rows[0]?.memoryObjects[1]?.locator.object).toMatchObject({
      kind: "org-property",
      sourceKind: "property",
      sourceKey: "REUSABLE_KNOWLEDGE",
    });
  });

  it("renders compact local context instead of a JSON-heavy dump", () => {
    const packet = parseServerlessMemoryRecallPacket(taskListJsonFixture().recallPacket);
    const content = renderServerlessMemoryRecallContent(packet);

    expect(content).toContain("[wendao memory recall]");
    expect(content).toContain("orgid: accepted-memory-sample");
    expect(content).toContain("locator: org-section orgid=accepted-memory-sample");
    expect(content).toContain("title: Accepted memory sample");
    expect(content).toContain("source_citation: .cache/agent/org/serverless_memory_fixture.org:1");
    expect(content).toContain(
      "locator: org-section orgid=accepted-memory-sample object=org-property sourceKind=property sourceKey=REUSABLE_KNOWLEDGE",
    );
    expect(content).toContain(
      "claim/REUSABLE_KNOWLEDGE: The serverless recall path emits compact session packets.",
    );
    expect(content).not.toContain('"memoryObjects"');
  });

  it("keeps live LLM recall prompts task-shaped instead of schema-shaped", () => {
    for (const prompt of [
      SERVERLESS_MEMORY_RECALL_BENCHMARK_TASK_PROMPT,
      SERVERLESS_MEMORY_RECALL_LIVE_TASK_PROMPT,
    ]) {
      expect(prompt).toContain("normal prose");
      expect(prompt).not.toContain("JSON");
      expect(prompt).not.toMatch(/JSON object/i);
      expect(prompt).not.toContain("Return fields");
      expect(prompt).not.toContain("rows with");
      expect(prompt).not.toContain("orgid=");
      expect(prompt).not.toContain("primary=");
    }
  });

  it("renders benchmark variants with deterministic context boundaries", () => {
    const packet = parseServerlessMemoryRecallPacket(taskListJsonFixture().recallPacket);
    const sectionOnly = renderServerlessMemoryRecallContent(packet, {
      render: {
        includeMatchedOrgElements: false,
        includeMemoryObjects: false,
      },
    });
    const propertyOnly = renderServerlessMemoryRecallContent(packet, {
      render: {
        includeMatchedOrgElements: false,
        includeMemoryObjects: true,
      },
    });
    const orgElements = renderServerlessMemoryRecallContent(packet, {
      render: {
        includeMatchedOrgElements: true,
        includeMemoryObjects: true,
      },
    });

    expect(sectionOnly).toContain("orgid: accepted-memory-sample");
    expect(sectionOnly).not.toContain("claim/REUSABLE_KNOWLEDGE");
    expect(propertyOnly).toContain("claim/REUSABLE_KNOWLEDGE");
    expect(propertyOnly).not.toContain("org_element/");
    expect(orgElements).toContain("claim/REUSABLE_KNOWLEDGE");
  });

  it("renders org-element SQL locators when recall packets include matched elements", () => {
    const rawPacket = taskListJsonFixture().recallPacket as {
      rows: Array<Record<string, unknown>>;
    };
    rawPacket.rows[0] = {
      ...rawPacket.rows[0],
      matchedOrgElements: [
        {
          locator: {
            schema: "xiuxian_wendao.org_memory_locator.v1",
            section: { kind: "org-section", orgid: "accepted-memory-sample" },
            orgElement: {
              kind: "org-element",
              category: "body",
              type: "paragraph",
              context: "body",
              ordinal: 8,
              source: ".cache/agent/org/serverless_memory_fixture.org",
              sourceLine: 14,
              sourceRangeStart: 120,
              sourceRangeEnd: 220,
              query: {
                engine: "duckdb",
                table: "agent_org_elements",
                sourcePath: ".cache/agent/org/serverless_memory_fixture.org",
                ordinal: 8,
              },
            },
          },
          ordinal: 8,
          category: "body",
          kind: "paragraph",
          context: "body",
          summary: { text: "org-elements SQL recall exact paragraph" },
          sourceLine: 14,
          sourceRangeStart: 120,
          sourceRangeEnd: 220,
          sourceRaw: "The exact paragraph is available through org-elements SQL recall.",
        },
      ],
    };

    const packet = parseServerlessMemoryRecallPacket(rawPacket);
    const content = renderServerlessMemoryRecallContent(packet);

    expect(packet.rows[0]?.matchedOrgElements[0]?.locator.orgElement).toMatchObject({
      type: "paragraph",
      ordinal: 8,
      query: { table: "agent_org_elements" },
    });
    expect(content).toContain(
      "org_element/paragraph: The exact paragraph is available through org-elements SQL recall.",
    );
    expect(content).toContain(
      "locator: org-section orgid=accepted-memory-sample orgElement=paragraph category=body ordinal=8 sqlTable=agent_org_elements",
    );
  });

  it("injects compact recall into SessionManager LLM context", () => {
    const packet = parseServerlessMemoryRecallPacket(taskListJsonFixture().recallPacket);
    const sessionManager = SessionManager.inMemory("/tmp/pi-wendao-memory");

    const result = appendServerlessMemoryRecallPacket({ sessionManager, packet });

    expect(result.entryId).toBeDefined();
    expect(result.details).toEqual({
      schema: "xiuxian_wendao.serverless_memory_recall_packet.v1",
      transport: "local-duckdb-arrow-ready",
      rowCount: 1,
      memoryObjectCount: 2,
      orgids: ["accepted-memory-sample"],
      sources: [".cache/agent/org/serverless_memory_fixture.org:1"],
    });
    const entries = sessionManager.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "custom_message",
      customType: PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE,
      display: false,
    });
    const context = sessionManager.buildSessionContext();
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]).toMatchObject({
      role: "custom",
      customType: PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE,
      display: false,
      content: expect.stringContaining("[wendao memory recall]"),
    });
  });

  it("registers a native memory recall tool that returns wendao-client text output", async () => {
    const calls: ServerlessMemoryRecallCommandRunnerInput[] = [];
    const tool = loadMemoryRecallTool({
      runner: async (input) => {
        calls.push(input);
        return {
          stdout: taskListTextFixture(),
          stderr: "",
        };
      },
    });

    const result = await tool.execute("memory-tool-1", {
      query: "compact session",
      limit: 2,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "wendao-client",
      cwd: projectRoot(),
      args: [
        "orgize",
        "task-list",
        "--cached",
        "--include-done",
        "--include-archived",
        "--text",
        "compact session",
        "--limit",
        "2",
      ],
    });
    expect(result.content[0]?.text).toContain("[TASK001] Accepted memory sample");
    expect(result.content[0]?.text).toContain("orgid: accepted-memory-sample");
    expect(result.content[0]?.text).toContain(
      "source: .cache/agent/org/serverless_memory_fixture.org:1",
    );
    expect(result.content[0]?.text).not.toContain('"memoryObjects"');
    expect(result.details).toMatchObject({
      customType: PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE,
      toolCallId: "memory-tool-1",
      query: "compact session",
      cacheMode: "cached",
      command: "wendao-client",
      outputFormat: "text",
    });
  });

  it("rejects unsupported recall packet schemas", () => {
    expect(() =>
      parseServerlessMemoryRecallPacket({
        ...taskListJsonFixture().recallPacket,
        schema: "xiuxian_wendao.other.v1",
      }),
    ).toThrow("unsupported serverless memory recall packet schema");
  });

  it("loads package-owned wendao-client task-list JSON fixtures", () => {
    const packet = readServerlessMemoryRecallPacketFile(taskListJsonFixturePath());

    expect(packet.rows).toHaveLength(1);
    expect(packet.rows[0]?.orgid).toBe("accepted-memory-sample");
    expect(packet.rows[0]?.memoryObjects).toHaveLength(2);
  });

  it("injects native pi session recall once per packet", () => {
    const packet = parseServerlessMemoryRecallPacket(taskListJsonFixture().recallPacket);
    const sent: unknown[] = [];
    const pi = {
      sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
    };
    const ctx = { sessionManager: { getEntries: () => [] } };

    const result = injectServerlessMemoryRecallMessage(pi, ctx, packet);

    expect(result).toEqual({ injected: true, reason: "sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      message: {
        customType: PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE,
        display: false,
        content: expect.stringContaining("[wendao memory recall]"),
      },
      options: { triggerTurn: false },
    });

    const duplicate = injectServerlessMemoryRecallMessage(
      pi,
      {
        sessionManager: {
          getEntries: () => [
            {
              type: "custom_message",
              customType: PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE,
              details: serverlessMemoryRecallDetails(packet),
            },
          ],
        },
      },
      packet,
    );

    expect(duplicate).toEqual({ injected: false, reason: "already-present" });
    expect(sent).toHaveLength(1);
  });

  it("registers native session-start injection for package-owned recall fixtures", () => {
    const packet = readServerlessMemoryRecallPacketFile(taskListJsonFixturePath());
    const sent: unknown[] = [];
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
        handlers.set(event, handler);
      },
      sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
    };

    registerServerlessMemoryRecallInjection(pi as never, packet);
    handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      { sessionManager: { getEntries: () => [] } },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      message: {
        customType: PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE,
        content: expect.stringContaining("Accepted memory sample"),
      },
      options: { triggerTurn: false },
    });
  });

  it("resolves CLI native chat startup with serverless recall packet flags", () => {
    const startup = resolveNativeChatStartup({
      invocationCwd: projectRoot(),
      tui: true,
      stdinIsTTY: true,
      serverlessMemoryRecallJson: "test/fixtures/serverless-memory-task-list.json",
    });

    expect(startup.shouldLaunchNativeChat).toBe(true);
    expect(startup.serverlessMemoryRecallPacket?.rows).toHaveLength(1);
    expect(startup.serverlessMemoryRecallPacket?.rows[0]?.orgid).toBe("accepted-memory-sample");
  });

  it("rejects serverless recall packet flags outside native chat startup", () => {
    expect(() =>
      resolveNativeChatStartup({
        invocationCwd: projectRoot(),
        workflowPath: "workflow.bpmn",
        tui: true,
        stdinIsTTY: true,
        serverlessMemoryRecallJson: "test/fixtures/serverless-memory-task-list.json",
      }),
    ).toThrow("--serverless-memory-recall-json currently applies only to native pi chat startup");
  });

  it("launches native pi with serverless recall extension factory wiring", async () => {
    const packet = readServerlessMemoryRecallPacketFile(taskListJsonFixturePath());
    const sent: unknown[] = [];
    let capturedArgs: string[] = [];
    let capturedOptions: { extensionFactories?: Array<(pi: unknown) => void> } = {};

    await launchPiWendaoNativeTuiWithMain(
      {
        modelPattern: "anthropic/claude-sonnet-4-6",
        thinkingLevel: "medium",
        invocationCwd: projectRoot(),
        piContextCwd: projectRoot(),
        resolvedExtensionPaths: [],
        baseWorkflowOptions: {},
        resolvedDmnPaths: [],
        serverlessMemoryRecallPacket: packet,
      },
      async (args, options) => {
        capturedArgs = args;
        capturedOptions = options as typeof capturedOptions;
      },
    );

    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const registeredTools: string[] = [];
    capturedOptions.extensionFactories?.[0]?.({
      on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
        handlers.set(event, handler);
      },
      registerProvider: () => undefined,
      registerMessageRenderer: () => undefined,
      registerCommand: () => undefined,
      registerTool: (tool: { name: string }) => {
        registeredTools.push(tool.name);
      },
      sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
    });
    handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      { sessionManager: { getEntries: () => [] } },
    );

    expect(process.env.PI_CODING_AGENT).toBe("true");
    expect(capturedArgs).toContain("--continue");
    expect(capturedArgs).toContain("--thinking");
    expect(capturedOptions.extensionFactories).toHaveLength(1);
    expect(registeredTools).toContain(WENDAO_MEMORY_RECALL_TOOL_NAME);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      message: {
        customType: PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE,
        content: expect.stringContaining("Accepted memory sample"),
      },
      options: { triggerTurn: false },
    });
  });
});

function taskListJsonFixture() {
  return JSON.parse(readFileSync(taskListJsonFixturePath(), "utf-8")) as {
    recallPacket: unknown;
  };
}

function taskListTextFixture(): string {
  return [
    "",
    "[TASK001] Accepted memory sample",
    "orgid: accepted-memory-sample",
    "state: DONE",
    "tags: agent:memory",
    "source: .cache/agent/org/serverless_memory_fixture.org:1",
    "closed: [2026-05-25 Mon]",
    "show: wendao-client orgize orgid-show --cached --id accepted-memory-sample",
    "",
  ].join("\n");
}

function loadMemoryRecallTool(options: {
  runner: (input: ServerlessMemoryRecallCommandRunnerInput) => Promise<{
    stdout: string;
    stderr: string;
  }>;
}): {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
  }>;
} {
  let registered:
    | {
        name: string;
        execute(
          toolCallId: string,
          params: Record<string, unknown>,
          signal?: AbortSignal,
        ): Promise<{
          content: Array<{ type: "text"; text: string }>;
          details: Record<string, unknown>;
        }>;
      }
    | undefined;
  registerServerlessMemoryRecallTool(
    {
      registerTool(tool) {
        registered = tool as typeof registered;
      },
    },
    {
      cwd: projectRoot(),
      command: "wendao-client",
      runner: options.runner,
    },
  );
  expect(registered?.name).toBe(WENDAO_MEMORY_RECALL_TOOL_NAME);
  if (!registered) throw new Error("memory recall tool was not registered");
  return registered;
}

function taskListJsonFixturePath(): string {
  return fileURLToPath(new URL("../fixtures/serverless-memory-task-list.json", import.meta.url));
}

function projectRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}
