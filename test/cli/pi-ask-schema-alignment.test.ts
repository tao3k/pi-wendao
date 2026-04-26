import { describe, expect, it } from "vitest";
import { requestNativeWorkflowInputReply } from "../../src/cli/native/input.js";
import {
  runNativeWorkflowPiAskFlow,
  type NativeAskFlow,
  type NativeAskParams,
} from "../../src/cli/native/ask.js";
import type { PlannerReplyRequest } from "../../src/ui/renderer.js";

describe("native qianji interaction to pi-ask schema alignment", () => {
  it("emits pi-ask-valid schemas for confirm, choice, and choice_input interactions", async () => {
    const cases: Array<{
      expectedAnswer: string;
      expectedOptions: Array<{ label: string; value: string; description?: string }>;
      expectedPrompt: string;
      request: PlannerReplyRequest;
      result: Awaited<ReturnType<NativeAskFlow>>;
    }> = [
      {
        expectedAnswer: "approved",
        expectedOptions: [
          { label: "Approve", value: "approved" },
          { label: "Reject", value: "rejected" },
        ],
        expectedPrompt: "Continue with the generated workflow?",
        request: workflowRequest({
          interaction: {
            type: "confirm",
            question: "Continue with the generated workflow?",
          },
        }),
        result: {
          answers: {
            planner_reply: {
              labels: ["Approve"],
              values: ["approved"],
            },
          },
          cancelled: false,
        },
      },
      {
        expectedAnswer: "narrow",
        expectedOptions: [
          {
            label: "Explore more",
            value: "expand",
            description: "Gather broader context.",
          },
          {
            label: "Narrow scope",
            value: "narrow",
            description: "Pick the smallest useful slice.",
          },
        ],
        expectedPrompt: "Which direction should the workflow emphasize?",
        request: workflowRequest({
          interaction: {
            type: "choice",
            question: "Which direction should the workflow emphasize?",
            choices: [
              {
                value: "expand",
                label: "Explore more",
                description: "Gather broader context.",
              },
              {
                value: "narrow",
                label: "Narrow scope",
                description: "Pick the smallest useful slice.",
              },
            ],
          },
        }),
        result: {
          answers: {
            planner_reply: {
              labels: ["Narrow scope"],
              values: ["narrow"],
            },
          },
          cancelled: false,
        },
      },
      {
        expectedAnswer: "write a custom repair",
        expectedOptions: [
          {
            label: "Minimal fix",
            value: "minimal",
            description: "Only repair the failing contract.",
          },
          {
            label: "Broaden coverage",
            value: "broaden",
            description: "Add schema tests around the failure.",
          },
        ],
        expectedPrompt: "How should qianji repair this workflow?",
        request: workflowRequest({
          interaction: {
            type: "choice_input",
            question: "How should qianji repair this workflow?",
            choices: [
              {
                value: "minimal",
                label: "Minimal fix",
                description: "Only repair the failing contract.",
              },
              {
                value: "broaden",
                label: "Broaden coverage",
                description: "Add schema tests around the failure.",
              },
            ],
            freeText: {
              name: "choiceInputAnswer",
              optional: true,
              placeholder: "Type a custom repair direction",
            },
          },
        }),
        result: {
          answers: {
            planner_reply: {
              customText: "write a custom repair",
              labels: ["Minimal fix"],
              values: ["minimal"],
            },
          },
          cancelled: false,
        },
      },
    ];

    for (const testCase of cases) {
      let capturedParams: NativeAskParams | undefined;
      const askFlow: NativeAskFlow = async (_ctx, params) => {
        capturedParams = params;
        await expectPiAskSchemaAccepts(params);
        return testCase.result;
      };

      const answer = await withTimeout(
        requestNativeWorkflowInputReply(
          fakePi() as never,
          fakeWorkflowContext() as never,
          "/tmp/pi-ask-interactions.bpmn",
          testCase.request,
          undefined,
          askFlow,
        ),
      );

      expect(answer).toBe(testCase.expectedAnswer);
      expect(capturedParams?.questions[0]).toMatchObject({
        id: "planner_reply",
        label: "workflow user input",
        options: testCase.expectedOptions,
        prompt: testCase.expectedPrompt,
        required: true,
        type: "single",
      });
    }
  });

  it("routes pure qianji input through the direct prompt because pi-ask requires options", async () => {
    await expect(
      expectPiAskSchemaAccepts({
        title: "invalid pure input",
        questions: [
          {
            id: "planner_reply",
            label: "workflow user input",
            options: [],
            prompt: "Describe the next investigation step.",
            required: true,
            type: "single",
          },
        ],
      }),
    ).rejects.toThrow("Question 1: at least one option is required");

    const askFlow: NativeAskFlow = async () => {
      throw new Error("pure input must not call pi-ask with an empty option list");
    };

    const answer = await withTimeout(
      requestNativeWorkflowInputReply(
        fakePi() as never,
        fakeWorkflowContext("write the next investigation step") as never,
        "/tmp/pi-ask-interactions.bpmn",
        workflowRequest({
          interaction: {
            type: "input",
            question: "Describe the next investigation step.",
            freeText: {
              name: "freeformAnswer",
              placeholder: "Write a short answer",
            },
          },
        }),
        undefined,
        askFlow,
      ),
    );

    expect(answer).toBe("write the next investigation step");
  });
});

function workflowRequest(options: Pick<PlannerReplyRequest, "interaction">): PlannerReplyRequest {
  return {
    action: "human_task",
    interaction: options.interaction,
    message: "Host prompt should not replace the qianji interaction question.",
    to: "user",
    toolCallId: "human:1",
  };
}

function fakePi() {
  return {
    sendMessage: () => undefined,
  };
}

function fakeWorkflowContext(customAnswer?: string) {
  return {
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      custom: async () => customAnswer,
      setStatus: () => undefined,
    },
  };
}

async function expectPiAskSchemaAccepts(params: NativeAskParams): Promise<void> {
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
    params,
  );
  expect(result.cancelled).toBe(true);
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
