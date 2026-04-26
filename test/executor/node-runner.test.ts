import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import type { FauxProviderRegistration } from "@mariozechner/pi-ai";
import type {
  PiWendaoAgentEvent,
  PiWendaoAgentTool,
} from "../../src/executor/agent-runtime-types.js";
import { createPiAiHost, createRunAgentService } from "../../src/executor/node-runner.js";

describe("createRunAgentService", () => {
  let faux: FauxProviderRegistration;

  beforeEach(() => {
    faux = registerFauxProvider({
      models: [
        {
          id: "faux-model",
          reasoning: true,
        },
      ],
    });
  });

  afterEach(() => {
    faux.unregister();
  });

  it("runs an agent and calls callback on success", async () => {
    faux.setResponses([fauxAssistantMessage('Done.\n```json\n{"greeting": "hello"}\n```')]);

    const events: string[] = [];
    const service = createRunAgentService({
      model: faux.getModel(),
      apiKey: "test-key",
      cwd: process.cwd(),
      onEvent: (event: PiWendaoAgentEvent) => {
        events.push(event.type);
      },
      getConfig: (id) =>
        id === "Task_1"
          ? { prompt: "Say hello", tools: [], inputs: [], outputs: ["greeting"] }
          : undefined,
    });

    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      service(
        {
          content: { id: "Task_1" },
          environment: { variables: {}, output: {} },
        },
        (err, res) => {
          if (err) reject(err);
          else resolve(res ?? {});
        },
      );
    });

    expect(result).toHaveProperty("greeting", "hello");
    expect(events).toContain("agent_start");
    expect(events).toContain("agent_end");
  });

  it("passes scoped input variables to the agent", async () => {
    let capturedPrompt = "";
    faux.setResponses([
      (context) => {
        capturedPrompt = context.systemPrompt;
        return fauxAssistantMessage("Done.");
      },
    ]);

    const service = createRunAgentService({
      model: faux.getModel(),
      apiKey: "test-key",
      cwd: process.cwd(),
      getConfig: (id) =>
        id === "Task_1"
          ? { prompt: "Use the input", tools: [], inputs: ["myVar"], outputs: [] }
          : undefined,
    });

    await new Promise<void>((resolve, reject) => {
      service(
        {
          content: { id: "Task_1" },
          environment: {
            variables: { myVar: "someValue", otherVar: "hidden" },
            output: {},
          },
        },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });

    expect(capturedPrompt).toContain("myVar");
    expect(capturedPrompt).toContain("someValue");
    expect(capturedPrompt).not.toContain("otherVar");
    expect(capturedPrompt).not.toContain("hidden");
  });

  it("enables medium thinking by default for real agent execution", async () => {
    let capturedReasoning: unknown;
    faux.setResponses([
      (_context, options) => {
        capturedReasoning = (options as { reasoning?: unknown } | undefined)?.reasoning;
        return fauxAssistantMessage("Done.");
      },
    ]);

    const service = createRunAgentService({
      model: faux.getModel(),
      apiKey: "test-key",
      cwd: process.cwd(),
      getConfig: (id) =>
        id === "Task_1"
          ? { prompt: "Use thinking", tools: [], inputs: [], outputs: [] }
          : undefined,
    });

    await new Promise<void>((resolve, reject) => {
      service(
        {
          content: { id: "Task_1" },
          environment: { variables: {}, output: {} },
        },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });

    expect(capturedReasoning).toBe("medium");
  });

  it("exposes injected extension tools to the default agent host", async () => {
    const toolCalls: unknown[] = [];
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("intercom", { action: "status" }, { id: "tool-intercom-1" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage('Done.\n```json\n{"result":"intercom_available"}\n```'),
    ]);
    const intercomTool: PiWendaoAgentTool<any> = {
      name: "intercom",
      label: "Intercom",
      description: "Fixture intercom tool",
      parameters: {
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string" },
        },
      } as any,
      async execute(_toolCallId, params) {
        toolCalls.push(params);
        return {
          content: [{ type: "text", text: "Connected: Yes" }],
          details: { delivered: true },
        };
      },
    };
    const host = createPiAiHost({
      model: faux.getModel(),
      apiKey: "test-key",
      cwd: process.cwd(),
      extraTools: [intercomTool],
    });

    await expect(
      host.run({
        activityId: "Task_Intercom",
        variables: {},
        config: {
          prompt: "Check intercom status.",
          tools: ["intercom"],
          inputs: [],
          outputs: ["result"],
        },
      }),
    ).resolves.toEqual({ result: "intercom_available" });
    expect(toolCalls).toEqual([{ action: "status" }]);
  });
});
