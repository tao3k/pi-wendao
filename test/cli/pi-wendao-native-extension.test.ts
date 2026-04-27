import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import {
  createPiWendaoNativeExtension,
  createFoldedWorkflowEvents,
  foldWorkflowEventLines,
  parseNativeRunCommand,
  parseNativeShowCommand,
  resolveNativeRunModel,
  renderTopGraphWidgetLines,
  requestNativeWorkflowInputReply,
  clearAllNativeWorkflowGraphPanels,
  clearNativeWorkflowGraphPanel,
  setNativeWorkflowGraphPanel,
  renderWorkflowMessage,
  startWorkflowRunMessage,
  workflowEventSummaryLines,
} from "../../src/cli/pi-wendao-native-extension.js";
import { buildPiWendaoNativeArgs } from "../../src/cli/pi-wendao-native-launcher.js";
import { runNativePiAskFlow, runNativeWorkflowPiAskFlow } from "../../src/cli/native/ask.js";
import { withNativeWorkflowUiEscScope } from "../../src/cli/native/esc-scope.js";
import { PiWendaoNativeWorkflowRenderer } from "../../src/cli/native/renderer.js";
import { GraphView } from "../../src/ui/graph-view.js";

describe("pi-wendao native pi extension", () => {
  const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const originalOAuthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

  beforeEach(() => {
    clearAnthropicEnv();
  });

  afterEach(() => {
    clearAllNativeWorkflowGraphPanels();
    restoreEnv("ANTHROPIC_AUTH_TOKEN", originalAuthToken);
    restoreEnv("ANTHROPIC_OAUTH_TOKEN", originalOAuthToken);
    restoreEnv("ANTHROPIC_API_KEY", originalApiKey);
    restoreEnv("ANTHROPIC_BASE_URL", originalBaseUrl);
  });

  it("parses /run workflow arguments with qianji execution options", () => {
    expect(
      parseNativeRunCommand(
        "/tmp/workflow.bpmn --instance-id pi-wendao-complex --start-at-node Task_Question --dmn decision.dmn --var topic=test --no-graph",
      ),
    ).toMatchObject({
      workflowPath: "/tmp/workflow.bpmn",
      instanceId: "pi-wendao-complex",
      startAtNode: "Task_Question",
      dmnPaths: ["decision.dmn"],
      variables: ["topic=test"],
      graph: false,
    });
  });

  it("parses /run brainstorm as a named workflow", () => {
    expect(parseNativeRunCommand("brainstorm")).toMatchObject({
      workflowPath: "brainstorm",
      namedWorkflow: "brainstorm",
      graph: true,
    });
  });

  it("does not accept the brainstrom typo as an alias", () => {
    expect(() => parseNativeRunCommand("brainstrom")).toThrow("Use '/run brainstorm'");
  });

  it("supports quoted /run paths", () => {
    expect(
      parseNativeRunCommand('"fixtures/human approval.bpmn" --trace-frame-ms 5').workflowPath,
    ).toBe("fixtures/human approval.bpmn");
    expect(
      parseNativeRunCommand('"fixtures/human approval.bpmn" --trace-frame-ms 5').traceFrameMs,
    ).toBe(5);
  });

  it("registers pi-native aliases for exit and clear session", async () => {
    const commands = new Map<
      string,
      {
        description?: string;
        handler: (args: string, ctx: unknown) => Promise<void>;
      }
    >();
    createPiWendaoNativeExtension({
      modelPattern: "anthropic/claude-sonnet-4-20250514",
      thinkingLevel: "medium",
      invocationCwd: "/repo",
      piContextCwd: "/repo/.data/qianji",
      resolvedExtensionPaths: [],
      baseWorkflowOptions: {},
      resolvedDmnPaths: [],
    })({
      registerProvider: () => undefined,
      registerMessageRenderer: () => undefined,
      registerCommand: (
        name: string,
        options: {
          description?: string;
          handler: (args: string, ctx: unknown) => Promise<void>;
        },
      ) => {
        commands.set(name, options);
      },
      events: {
        emit: (channel: string) => calls.push(`event:${channel}`),
      },
    } as never);

    const calls: string[] = [];
    const ctx = {
      shutdown: () => calls.push("shutdown"),
      waitForIdle: async () => calls.push("waitForIdle"),
      newSession: async (options?: {
        withSession?: (ctx: {
          ui: {
            notify(message: string, severity: string): void;
            setStatus(key: string, value: string | undefined): void;
          };
        }) => Promise<void>;
      }) => {
        calls.push("newSession");
        await options?.withSession?.({
          ui: {
            notify: (message, severity) => calls.push(`new:${severity}:${message}`),
            setStatus: (key, value) => calls.push(value ? `newStatus:${key}:${value}` : `newClearStatus:${key}`),
            setWidget: (key, value) => calls.push(value ? `newWidget:${key}` : `newClearWidget:${key}`),
          },
        });
        return { cancelled: false };
      },
      ui: {
        notify: (message: string, severity: string) => calls.push(`old:${severity}:${message}`),
        setStatus: (key: string, value: string | undefined) =>
          calls.push(value ? `oldStatus:${key}:${value}` : `oldClearStatus:${key}`),
        setWidget: (key: string, value: unknown) =>
          calls.push(value ? `oldWidget:${key}` : `oldClearWidget:${key}`),
      },
    };

    await commands.get("exit")?.handler("", ctx);
    await commands.get("clear")?.handler("", ctx);

    expect(commands.get("exit")?.description).toContain("/quit");
    expect(commands.get("clear")?.description).toContain("/new");
    expect(calls).toEqual([
      "shutdown",
      "waitForIdle",
      "event:pi-wendao:native-session-surfaces:reset",
      "oldClearWidget:agents",
      "oldClearStatus:pi-wendao",
      "oldClearStatus:subagents",
      "newSession",
      "event:pi-wendao:native-session-surfaces:reset",
      "newClearWidget:agents",
      "newClearStatus:pi-wendao",
      "newClearStatus:subagents",
      "new:info:New session started.",
    ]);
  });

  it("clears native workflow graph overlays before starting a new session", async () => {
    const commands = new Map<
      string,
      {
        handler: (args: string, ctx: unknown) => Promise<void>;
      }
    >();
    createPiWendaoNativeExtension({
      modelPattern: "anthropic/claude-sonnet-4-20250514",
      thinkingLevel: "medium",
      invocationCwd: "/repo",
      piContextCwd: "/repo/.data/qianji",
      resolvedExtensionPaths: [],
      baseWorkflowOptions: {},
      resolvedDmnPaths: [],
    })({
      registerProvider: () => undefined,
      registerMessageRenderer: () => undefined,
      registerCommand: (
        name: string,
        options: {
          handler: (args: string, ctx: unknown) => Promise<void>;
        },
      ) => {
        commands.set(name, options);
      },
      events: {
        emit: (channel: string) => calls.push(`event:${channel}`),
      },
    } as never);

    const calls: string[] = [];
    const ctx = {
      waitForIdle: async () => calls.push("waitForIdle"),
      newSession: async (options?: {
        withSession?: (ctx: {
          ui: {
            notify(message: string, severity: string): void;
            setStatus(key: string, value: string | undefined): void;
          };
        }) => Promise<void>;
      }) => {
        calls.push("newSession");
        await options?.withSession?.({
          ui: {
            notify: (message, severity) => calls.push(`new:${severity}:${message}`),
            setStatus: (key, value) => calls.push(value ? `newStatus:${key}:${value}` : `newClearStatus:${key}`),
            setWidget: (key, value) => calls.push(value ? `newWidget:${key}` : `newClearWidget:${key}`),
          },
        });
        return { cancelled: false };
      },
      ui: {
        notify: (message: string, severity: string) => calls.push(`old:${severity}:${message}`),
        setStatus: (key: string, value: string | undefined) =>
          calls.push(value ? `oldStatus:${key}:${value}` : `oldClearStatus:${key}`),
        setWidget: (key: string, value: unknown) => {
          calls.push(value ? `oldWidget:${key}` : `oldClearWidget:${key}`);
          if (typeof value === "function") {
            value({ requestRender: () => undefined }, {});
          }
        },
        setHeader: (value: unknown) => {
          calls.push(value ? "oldHeader" : "oldClearHeader");
          if (typeof value === "function") {
            value({ requestRender: () => undefined }, {});
          }
        },
      },
    };

    setNativeWorkflowGraphPanel(ctx as never, () => ({
      render: () => [],
      invalidate: () => undefined,
      dispose: () => calls.push("disposeGraph"),
    }));

    await commands.get("clear")?.handler("", ctx);

    expect(calls).toEqual([
      "oldHeader",
      "waitForIdle",
      "event:pi-wendao:native-session-surfaces:reset",
      "oldClearHeader",
      "disposeGraph",
      "oldClearWidget:agents",
      "oldClearStatus:pi-wendao",
      "oldClearStatus:subagents",
      "newSession",
      "event:pi-wendao:native-session-surfaces:reset",
      "newClearWidget:agents",
      "newClearStatus:pi-wendao",
      "newClearStatus:subagents",
      "new:info:New session started.",
    ]);
  });

  it("registers /stop for checkpoint-preserving workflow interruption", async () => {
    const commands = new Map<
      string,
      {
        description?: string;
        handler: (args: string, ctx: unknown) => Promise<void>;
      }
    >();
    createPiWendaoNativeExtension({
      modelPattern: "anthropic/claude-sonnet-4-20250514",
      thinkingLevel: "medium",
      invocationCwd: "/repo",
      piContextCwd: "/repo/.data/qianji",
      resolvedExtensionPaths: [],
      baseWorkflowOptions: {},
      resolvedDmnPaths: [],
    })({
      registerProvider: () => undefined,
      registerMessageRenderer: () => undefined,
      registerCommand: (
        name: string,
        options: {
          description?: string;
          handler: (args: string, ctx: unknown) => Promise<void>;
        },
      ) => {
        commands.set(name, options);
      },
    } as never);
    const notifications: string[] = [];

    await commands.get("stop")?.handler("", {
      ui: {
        notify: (message: string, severity: string) => notifications.push(`${severity}:${message}`),
      },
    });

    expect(commands.get("stop")?.description).toContain("Interrupt");
    expect(notifications).toEqual(["warning:No pi-wendao workflow is running."]);
  });

  it("interrupts an active native /run through /stop", async () => {
    const commands = new Map<
      string,
      {
        description?: string;
        handler: (args: string, ctx: unknown) => Promise<void>;
      }
    >();
    const sent: Array<{
      details?: {
        kind?: string;
        lines?: string[];
        status?: string;
        success?: boolean;
      };
    }> = [];
    createPiWendaoNativeExtension({
      modelPattern: "anthropic/claude-sonnet-4-20250514",
      thinkingLevel: "medium",
      invocationCwd: process.cwd(),
      piContextCwd: process.cwd(),
      resolvedExtensionPaths: [],
      baseWorkflowOptions: {},
      resolvedDmnPaths: [],
    })({
      registerProvider: () => undefined,
      registerMessageRenderer: () => undefined,
      registerCommand: (
        name: string,
        options: {
          description?: string;
          handler: (args: string, ctx: unknown) => Promise<void>;
        },
      ) => {
        commands.set(name, options);
      },
      sendMessage: (message: {
        details?: {
          kind?: string;
          lines?: string[];
          status?: string;
          success?: boolean;
        };
      }) => sent.push(message),
      setSessionName: () => undefined,
      getThinkingLevel: () => "medium",
    } as never);

    let releaseIdle: (() => void) | undefined;
    const idleReleased = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    let idleStarted: (() => void) | undefined;
    const idleStartedPromise = new Promise<void>((resolve) => {
      idleStarted = resolve;
    });
    const notifications: string[] = [];
    let terminalInputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
    const terminalInputEvents: string[] = [];
    const ctx = {
      waitForIdle: async () => {
        idleStarted?.();
        await idleReleased;
      },
      ui: {
        notify: (message: string, severity: string) => notifications.push(`${severity}:${message}`),
        onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
          terminalInputEvents.push("subscribe");
          terminalInputHandler = handler;
          return () => terminalInputEvents.push("unsubscribe");
        },
        setStatus: () => undefined,
      },
    };

    const run = commands
      .get("run")
      ?.handler(
        "test/fixtures/simple-workflow.bpmn --host-fixture test/fixtures/simple-workflow.bpmn --no-graph",
        ctx,
      );
    await idleStartedPromise;
    await expect(
      withNativeWorkflowUiEscScope(async () => terminalInputHandler?.("\x1b")),
    ).resolves.toBeUndefined();
    expect(terminalInputHandler?.("\x1b")).toEqual({ consume: true });
    await commands.get("stop")?.handler("", ctx);
    releaseIdle?.();
    await run;

    expect(notifications).toContain("warning:Stopping pi-wendao workflow...");
    expect(notifications.filter((entry) => entry === "warning:Stopping pi-wendao workflow...")).toHaveLength(1);
    expect(terminalInputEvents).toEqual(["subscribe", "unsubscribe"]);
    expect(
      sent.some((message) =>
        message.details?.lines?.includes(
          "Workflow interrupt requested. Qianji checkpoint state will be preserved.",
        ),
      ),
    ).toBe(true);
    expect(
      sent.some(
        (message) =>
          message.details?.status === "interrupted" ||
          message.details?.lines?.includes(
            "Workflow interrupted. Qianji checkpoint state was preserved.",
          ),
      ),
    ).toBe(true);
    expect(
      sent.some(
        (message) => message.details?.success === false && message.details?.status === "failed",
      ),
    ).toBe(false);
  });

  it("parses /show instance and workflow arguments", () => {
    expect(
      parseNativeShowCommand(
        "pi-wendao-complex test/fixtures/simple-workflow.bpmn --dmn decision.dmn",
      ),
    ).toEqual({
      instanceId: "pi-wendao-complex",
      workflowPath: "test/fixtures/simple-workflow.bpmn",
      dmnPaths: ["decision.dmn"],
    });
  });

  it("renders the workflow graph in a top widget without event log lines", () => {
    const graphView = new GraphView();
    graphView.addNode({ id: "Start_1", label: "Start", type: "start", status: "done" });
    graphView.addNode({ id: "Task_1", label: "Task A", type: "task", status: "active" });
    graphView.addEdge({ source: "Start_1", target: "Task_1", taken: true });

    const lines = renderTopGraphWidgetLines({
      graphView,
      title: "pi-wendao workflow complex.bpmn",
      width: 80,
      terminalRows: 30,
      truncate: (text, width) => text.slice(0, width),
    });

    expect(lines[0]).toBe("pi-wendao workflow complex.bpmn");
    expect(lines.join("\n")).toContain("Task A");
    expect(lines.join("\n")).not.toContain("service task");
    expect(lines.join("\n")).not.toContain("Variables:");
  });

  it("vertically centers a compact workflow graph in the top widget", () => {
    const graphView = new GraphView();
    graphView.addNode({ id: "Task_1", label: "Task A", type: "task", status: "active" });

    const lines = renderTopGraphWidgetLines({
      graphView,
      title: "pi-wendao workflow compact.bpmn",
      width: 80,
      terminalRows: 30,
      truncate: (text, width) => text.slice(0, width),
    });

    const firstGraphLine = lines.findIndex((line) => line.includes("┌") || line.includes("Task A"));
    expect(firstGraphLine).toBeGreaterThan(1);
  });

  it("mounts the workflow graph as a native header surface", () => {
    const calls: string[] = [];
    const ctx = {
      ui: {
        setHeader: (factory: ((...args: never[]) => { dispose?(): void }) | undefined) => {
          calls.push(factory ? "setHeader" : "clearHeader");
          factory?.({ requestRender: () => calls.push("render") }, {});
        },
      },
    };

    const handle = setNativeWorkflowGraphPanel(ctx as never, () => ({
      render: () => [],
      invalidate: () => undefined,
      dispose: () => calls.push("dispose"),
    }));
    clearNativeWorkflowGraphPanel(handle);

    expect(calls).toEqual([
      "setHeader",
      "clearHeader",
      "dispose",
    ]);
  });

  it("collects workflow ask through the pi-ask dependency without registering ask_user", async () => {
    const calls: string[] = [];
    const sent: Array<{
      customType?: string;
      display?: boolean;
      content?: string;
      details?: {
        answer?: string;
        status?: string;
        value?: string;
      };
    }> = [];
    const askCalls: Array<{ params: unknown; ctx: unknown }> = [];

    const pi = {
      sendMessage: (message: {
        customType?: string;
        display?: boolean;
        content?: string;
        details?: {
          answer?: string;
          status?: string;
          value?: string;
        };
      }) => {
        sent.push(message);
      },
    };
    const ctx = {
      hasUI: true,
      ui: {
        setStatus: (_key: string, value: string | undefined) => {
          calls.push(value ? `status:${value}` : "clearStatus");
        },
        onTerminalInput: () => {
          throw new Error("workflow ask must not capture raw terminal input");
        },
        input: () => {
          throw new Error("workflow ask must not open a blocking input dialog");
        },
        custom: () => {
          throw new Error("test pi-ask dependency adapter should own native rendering");
        },
      },
    };
    const askFlow = async (receivedCtx: unknown, params: unknown) => {
      askCalls.push({ params, ctx: receivedCtx });
      return {
        answers: {
          planner_reply: {
            labels: ["Approve"],
            values: ["approved"],
          },
        },
        cancelled: false,
      };
    };

    const answer = await withTimeout(
      requestNativeWorkflowInputReply(
        pi as never,
        ctx as never,
        "/tmp/skillsc-real-llm-complex.bpmn",
        {
          action: "ask",
          interaction: { type: "confirm" },
          message: "Approve this step?",
          to: "planner",
          toolCallId: "tool-1",
        },
        undefined,
        askFlow,
      ),
    );

    expect(answer).toBe("approved");
    expect(askCalls).toHaveLength(1);
    expect(askCalls[0]?.ctx).toBe(ctx);
    expect(askCalls[0]?.params).toMatchObject({
      title: "planner approval · skillsc-real-llm-complex.bpmn",
      questions: [
        {
          id: "planner_reply",
          label: "planner approval",
          options: [
            { label: "Approve", value: "approved" },
            { label: "Reject", value: "rejected" },
          ],
          prompt: "Approve this step?",
          type: "single",
        },
      ],
    });
    expect(calls).toContain("clearStatus");
    expect(calls.some((call) => call.startsWith("status:"))).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      customType: "pi-wendao-workflow-ask",
      display: false,
    });
    expect(sent[0]?.details).toMatchObject({
      answer: "approved",
      status: "answered",
    });
  });

  it("routes pure free-form workflow user input through the direct qianji input prompt", async () => {
    const sent: Array<{ details?: { answer?: string; status?: string } }> = [];
    const askCalls: Array<{ params: unknown }> = [];
    const pi = {
      sendMessage: (message: { details?: { answer?: string; status?: string } }) => {
        sent.push(message);
      },
    };
    const ctx = {
      hasUI: true,
      ui: {
        setStatus: () => undefined,
        custom: async () => "Use BPMN to orchestrate wendao workflows",
      },
    };
    const askFlow = async (_receivedCtx: unknown, params: unknown) => {
      askCalls.push({ params });
      throw new Error(
        "pure input without choices must not send an invalid empty-options payload to pi-ask",
      );
    };

    const answer = await withTimeout(
      requestNativeWorkflowInputReply(
        pi as never,
        ctx as never,
        "/tmp/brainstorm-one-step.bpmn",
        {
          action: "human_task",
          interaction: {
            question: "Which direction should BPMN integration take?",
            type: "input",
          },
          message: "Which direction should BPMN integration take?",
          to: "user",
          toolCallId: "tool-1",
        },
        undefined,
        askFlow,
      ),
    );

    expect(answer).toBe("Use BPMN to orchestrate wendao workflows");
    expect(askCalls).toHaveLength(0);
    expect(sent[0]?.details).toMatchObject({
      answer: "Use BPMN to orchestrate wendao workflows",
      status: "answered",
    });
  });

  it("loads pi-ask as a dependency adapter instead of a session extension", async () => {
    const result = await runNativePiAskFlow(
      {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
          custom: async () => ({
            answers: {
              planner_reply: {
                indices: [0],
                labels: ["Approve"],
                values: ["approved"],
              },
            },
            cancelled: false,
            mode: "submit",
            questions: [],
          }),
        },
      } as never,
      {
        title: "planner approval",
        questions: [
          {
            id: "planner_reply",
            label: "planner approval",
            options: [
              { label: "Approve", value: "approved" },
              { label: "Reject", value: "rejected" },
            ],
            prompt: "Approve this step?",
            type: "single",
          },
        ],
      },
    );

    expect(result.answers?.planner_reply?.values).toEqual(["approved"]);
  });

  it("mounts workflow pi-ask input as a bounded overlay", async () => {
    let capturedOptions:
      | {
          overlay?: boolean;
          overlayOptions?: {
            anchor?: string;
            width?: string;
            minWidth?: number;
            maxHeight?: string;
            margin?: number;
          };
        }
      | undefined;

    const result = await runNativeWorkflowPiAskFlow(
      {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
          custom: async (
            factory: (...args: never[]) => {
              handleInput?(data: string): void;
            },
            options?: typeof capturedOptions,
          ) => {
            capturedOptions = options;
            let doneResult: unknown;
            const component = await factory(
              { requestRender: () => undefined },
              fakeTheme(),
              {},
              (result: unknown) => {
                doneResult = result;
              },
            );
            component.handleInput?.("\x1b");
            return doneResult;
          },
        },
      } as never,
      {
        title: "workflow user input",
        questions: [
          {
            id: "planner_reply",
            label: "workflow user input",
            options: [{ label: "Use default reply", value: "default" }],
            prompt: "Describe the integration direction",
            type: "single",
          },
        ],
      },
    );

    expect(result.cancelled).toBe(true);
    expect(capturedOptions).toMatchObject({
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "80%",
        minWidth: 52,
        maxHeight: "80%",
        margin: 2,
      },
    });
  });

  it("maps ESC in workflow pi-ask input to a cancelled workflow ask result", async () => {
    const result = await runNativeWorkflowPiAskFlow(
      {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
          custom: async (
            factory: (...args: never[]) => {
              handleInput?(data: string): void;
            },
          ) => {
            let doneResult: unknown;
            const component = await factory(
              { requestRender: () => undefined },
              fakeTheme(),
              {},
              (result: unknown) => {
                doneResult = result;
              },
            );
            component.handleInput?.("\x1b");
            return doneResult;
          },
        },
      } as never,
      {
        title: "workflow user input",
        questions: [
          {
            id: "planner_reply",
            label: "workflow user input",
            options: [{ label: "Use default reply", value: "default" }],
            prompt: "Describe the integration direction",
            type: "single",
          },
        ],
      },
    );

    expect(result.cancelled).toBe(true);
  });

  it("treats a dismissed workflow pi-ask surface as cancelled", async () => {
    const result = await runNativeWorkflowPiAskFlow(
      {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
          custom: async () => undefined,
        },
      } as never,
      {
        title: "workflow user input",
        questions: [
          {
            id: "planner_reply",
            label: "workflow user input",
            options: [{ label: "Use default reply", value: "default" }],
            prompt: "Describe the integration direction",
            type: "single",
          },
        ],
      },
    );

    expect(result.cancelled).toBe(true);
  });

  it("keeps workflow progress out of the pi footer status", () => {
    const statusCalls: string[] = [];
    const pi = {
      sendMessage: () => undefined,
    };
    const ctx = {
      ui: {
        setStatus: (_key: string, value: string | undefined) => {
          statusCalls.push(value ? `status:${value}` : "clearStatus");
        },
      },
    };

    const renderer = new PiWendaoNativeWorkflowRenderer(
      pi as never,
      ctx as never,
      "/tmp/skillsc-real-llm-complex.bpmn",
      false,
    );
    renderer.start();
    renderer.refresh();
    renderer.finish(true);

    expect(statusCalls.length).toBeGreaterThan(0);
    expect(statusCalls.every((call) => call === "clearStatus")).toBe(true);
    expect(statusCalls.some((call) => call.startsWith("status:"))).toBe(false);
  });

  it("inherits the active pi session model registry auth for native /run", async () => {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const model = modelRegistry.find("anthropic", "claude-sonnet-4-20250514");
    if (!model) throw new Error("expected built-in Anthropic model");
    authStorage.setRuntimeApiKey("anthropic", "session-api-key");

    const resolved = await resolveNativeRunModel(
      {
        model,
        modelRegistry,
      },
      {
        modelPattern: "anthropic/claude-sonnet-4-20250514",
        piContextCwd: process.cwd(),
        resolvedExtensionPaths: [],
      },
    );

    expect(resolved.modelRegistry).toBe(modelRegistry);
    expect(resolved.model).toBe(model);
    expect(resolved.apiKey).toBe("session-api-key");
    await expect(resolved.modelRegistry.getApiKeyForProvider("anthropic")).resolves.toBe(
      "session-api-key",
    );
  });

  it("lets explicit Anthropic env auth override stale stored auth for native /run", async () => {
    const authStorage = AuthStorage.inMemory({
      anthropic: { type: "api_key", key: "stale-auth-json-key" },
    });
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const model = modelRegistry.find("anthropic", "claude-sonnet-4-20250514");
    if (!model) throw new Error("expected built-in Anthropic model");
    process.env.ANTHROPIC_API_KEY = "fresh-env-api-key";

    const resolved = await resolveNativeRunModel(
      {
        model,
        modelRegistry,
      },
      {
        modelPattern: "anthropic/claude-sonnet-4-20250514",
        piContextCwd: process.cwd(),
        resolvedExtensionPaths: [],
      },
    );

    expect(resolved.apiKey).toBe("fresh-env-api-key");
    await expect(resolved.modelRegistry.getApiKeyForProvider("anthropic")).resolves.toBe(
      "fresh-env-api-key",
    );
  });

  it("does not use ANTHROPIC_AUTH_TOKEN as a native /run x-api-key fallback", async () => {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const model = modelRegistry.find("anthropic", "claude-sonnet-4-20250514");
    if (!model) throw new Error("expected built-in Anthropic model");
    process.env.ANTHROPIC_AUTH_TOKEN = "invalid-x-api-key";
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;

    const resolved = await resolveNativeRunModel(
      {
        model,
        modelRegistry,
      },
      {
        modelPattern: "anthropic/claude-sonnet-4-20250514",
        piContextCwd: process.cwd(),
        resolvedExtensionPaths: [],
      },
    );

    expect(resolved.apiKey).toBeUndefined();
    await expect(resolved.modelRegistry.getApiKeyForProvider("anthropic")).resolves.toBeUndefined();
  });

  it("uses pi-native Anthropic API key env resolution for native /run", async () => {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const model = modelRegistry.find("anthropic", "claude-sonnet-4-20250514");
    if (!model) throw new Error("expected built-in Anthropic model");
    process.env.ANTHROPIC_AUTH_TOKEN = "ignored-auth-token";
    process.env.ANTHROPIC_API_KEY = "env-api-key";
    delete process.env.ANTHROPIC_OAUTH_TOKEN;

    const resolved = await resolveNativeRunModel(
      {
        model,
        modelRegistry,
      },
      {
        modelPattern: "anthropic/claude-sonnet-4-20250514",
        piContextCwd: process.cwd(),
        resolvedExtensionPaths: [],
      },
    );

    expect(resolved.apiKey).toBe("env-api-key");
    expect(resolved.auth?.source).toBe("env:ANTHROPIC_API_KEY");
    await expect(resolved.modelRegistry.getApiKeyForProvider("anthropic")).resolves.toBe(
      "env-api-key",
    );
  });

  it("prefers ANTHROPIC_API_KEY over ANTHROPIC_OAUTH_TOKEN for native /run", async () => {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const model = modelRegistry.find("anthropic", "claude-sonnet-4-20250514");
    if (!model) throw new Error("expected built-in Anthropic model");
    process.env.ANTHROPIC_API_KEY = "env-api-key";
    process.env.ANTHROPIC_OAUTH_TOKEN = "older-oauth-token";

    const resolved = await resolveNativeRunModel(
      {
        model,
        modelRegistry,
      },
      {
        modelPattern: "anthropic/claude-sonnet-4-20250514",
        piContextCwd: process.cwd(),
        resolvedExtensionPaths: [],
      },
    );

    expect(resolved.apiKey).toBe("env-api-key");
    expect(resolved.auth?.source).toBe("env:ANTHROPIC_API_KEY");
    await expect(resolved.modelRegistry.getApiKeyForProvider("anthropic")).resolves.toBe(
      "env-api-key",
    );
  });

  it("folds workflow event lines into one history summary", () => {
    const state = createFoldedWorkflowEvents();
    foldWorkflowEventLines(state, ["service task Task_1 queued", "service task Task_1 executing"]);
    foldWorkflowEventLines(state, ["flow Task_1 -> Task_2", "service task Task_2 completed"]);

    expect(workflowEventSummaryLines(state)).toEqual([
      "Workflow events folded: 4 lines.",
      "sample: service task Task_1 queued",
      "sample: service task Task_1 executing",
      "sample: flow Task_1 -> Task_2",
    ]);
    expect(workflowEventSummaryLines(state)).toEqual([]);
  });

  it("renders a live workflow run message with collapsible stream details", () => {
    const sent: Array<{
      customType?: string;
      display?: boolean;
      details?: {
        kind?: string;
        status?: string;
        lines?: string[];
        eventCount?: number;
        agentCount?: number;
      };
    }> = [];
    const handle = startWorkflowRunMessage(
      {
        sendMessage: (message: {
          customType?: string;
          display?: boolean;
          details?: {
            kind?: string;
            status?: string;
            lines?: string[];
            eventCount?: number;
            agentCount?: number;
          };
        }) => sent.push(message),
      } as never,
      "/tmp/skillsc-real-llm-complex.bpmn",
      1000,
    );

    handle.append("event", ["service task Task_1 executing"]);
    handle.append("agent", ["tool bash command: npm test"]);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      customType: "pi-wendao-workflow",
      display: true,
      details: {
        kind: "run",
        status: "running",
        eventCount: 1,
        agentCount: 1,
      },
    });
    expect(sent[0]?.details?.lines).toContain("event: service task Task_1 executing");
    expect(sent[0]?.details?.lines).toContain("agent: tool bash command: npm test");

    const collapsed = renderWorkflowMessage(handle.details, false, fakeTheme());
    const expanded = renderWorkflowMessage(handle.details, true, fakeTheme());

    expect(collapsed).toContain("workflow run skillsc-real-llm-complex.bpmn running");
    expect(collapsed).toContain("1 event");
    expect(collapsed).toContain("1 agent line");
    expect(collapsed).toContain("⎿ agent: tool bash command: npm test");
    expect(expanded).toContain("⎿ event: service task Task_1 executing");

    handle.complete(true);
    expect(handle.details.status).toBe("completed");
    expect(renderWorkflowMessage(handle.details, false, fakeTheme())).toContain("completed");
  });

  it("keeps the visible workflow run message live as events append", () => {
    const renderers = new Map<
      string,
      (
        message: {
          content?: string;
          details?: unknown;
        },
        options: { expanded: boolean },
        theme: ReturnType<typeof fakeTheme>,
      ) =>
        | {
            render(width: number): string[];
          }
        | undefined
    >();
    createPiWendaoNativeExtension({
      modelPattern: "anthropic/claude-sonnet-4-20250514",
      thinkingLevel: "medium",
      invocationCwd: "/repo",
      piContextCwd: "/repo/.data/qianji",
      resolvedExtensionPaths: [],
      baseWorkflowOptions: {},
      resolvedDmnPaths: [],
    })({
      registerProvider: () => undefined,
      registerCommand: () => undefined,
      registerMessageRenderer: (
        customType: string,
        renderer: (
          message: {
            content?: string;
            details?: unknown;
          },
          options: { expanded: boolean },
          theme: ReturnType<typeof fakeTheme>,
        ) =>
          | {
              render(width: number): string[];
            }
          | undefined,
      ) => {
        renderers.set(customType, renderer);
      },
    } as never);

    const sent: Array<{ content?: string; details?: unknown }> = [];
    const handle = startWorkflowRunMessage(
      {
        sendMessage: (message: { content?: string; details?: unknown }) => sent.push(message),
      } as never,
      "/tmp/skillsc-real-llm-complex.bpmn",
      1000,
    );

    const renderer = renderers.get("pi-wendao-workflow");
    if (!renderer) throw new Error("expected workflow message renderer");
    const component = renderer(sent[0]!, { expanded: false }, fakeTheme());
    if (!component) throw new Error("expected workflow message component");

    expect(component.render(120).join("\n")).toContain("starting workflow");

    handle.append("event", ["service task Task_1 executing"]);
    handle.append("agent", ["tool bash command: npm test"]);

    const updated = component.render(120).join("\n");
    expect(updated).toContain("1 event");
    expect(updated).toContain("1 agent line");
    expect(updated).toContain("event: service task Task_1 executing");
    expect(updated).toContain("agent: tool bash command: npm test");
  });

  it("launches pi native TUI with bundled native extensions and user extensions", () => {
    const args = buildPiWendaoNativeArgs({
      modelPattern: "anthropic/claude-sonnet-4-20250514",
      thinkingLevel: "medium",
      invocationCwd: "/repo",
      piContextCwd: "/repo/.data/qianji",
      resolvedExtensionPaths: ["/tmp/custom-extension.js"],
      baseWorkflowOptions: {},
      resolvedDmnPaths: [],
    });

    expect(args).toContain("--continue");
    expect(args).toContain("--model");
    expect(args).toContain("anthropic/claude-sonnet-4-20250514");
    expect(args).toContain("--thinking");
    expect(args).toContain("medium");
    expect(args).toContain("/tmp/custom-extension.js");
    expect(args.some((arg) => arg.endsWith("src/cli/native/pi-subagents-extension.ts"))).toBe(
      true,
    );
    expect(args.some((arg) => arg.includes("@eko24ive/pi-ask"))).toBe(false);
  });

  it("passes selected Anthropic env auth into the native pi launcher before session startup", () => {
    process.env.ANTHROPIC_OAUTH_TOKEN = "invalid-oauth-token";
    process.env.ANTHROPIC_API_KEY = "fresh-env-api-key";

    const args = buildPiWendaoNativeArgs({
      modelPattern: "anthropic/claude-sonnet-4-20250514",
      thinkingLevel: "medium",
      invocationCwd: "/repo",
      piContextCwd: "/repo/.data/qianji",
      resolvedExtensionPaths: [],
      baseWorkflowOptions: {},
      resolvedDmnPaths: [],
    });

    expect(args.slice(args.indexOf("--api-key"), args.indexOf("--api-key") + 2)).toEqual([
      "--api-key",
      "fresh-env-api-key",
    ]);
  });

  it("registers ANTHROPIC_BASE_URL before native pi model resolution", () => {
    process.env.ANTHROPIC_BASE_URL = "https://anthropic.example.test";
    process.env.ANTHROPIC_API_KEY = "fresh-env-api-key";
    const providers: Array<{ name: string; config: unknown }> = [];

    createPiWendaoNativeExtension({
      modelPattern: "anthropic/claude-sonnet-4-20250514",
      thinkingLevel: "medium",
      invocationCwd: "/repo",
      piContextCwd: "/repo/.data/qianji",
      resolvedExtensionPaths: [],
      baseWorkflowOptions: {},
      resolvedDmnPaths: [],
    })({
      registerProvider: (name: string, config: unknown) => {
        providers.push({ name, config });
      },
      registerMessageRenderer: () => undefined,
      registerCommand: () => undefined,
    } as never);

    expect(providers).toEqual([
      {
        name: "anthropic",
        config: {
          baseUrl: "https://anthropic.example.test",
          apiKey: "fresh-env-api-key",
        },
      },
    ]);
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function clearAnthropicEnv() {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
}

function fakeTheme() {
  return {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  };
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error("workflow ask did not resolve")), 1000);
    }),
  ]);
}
