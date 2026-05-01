import { describe, expect, it } from "vitest";
import {
  defaultReplyForRequest,
  questionTextForRequest,
  resolveReplyForRequest,
} from "../../src/ui/renderer/planner-prompt.js";

describe("planner prompt text", () => {
  it("prefers resolved native interaction questions over host prompts", () => {
    expect(
      questionTextForRequest({
        action: "human_task",
        context: {
          activityId: "Task_AskClarifyingQuestion",
          description: "BPMN user task",
        },
        interaction: {
          question: "Which direction should BPMN integration take?",
          type: "input",
        },
        message: "Ask the user the current clarifying question.",
        to: "user",
        toolCallId: "human:1",
      }),
    ).toBe("Which direction should BPMN integration take?");
  });

  it("renders native interaction choices for plain user prompts", () => {
    expect(
      questionTextForRequest({
        action: "human_task",
        interaction: {
          choices: [
            { value: "single", label: "One path", description: "Keep the workflow linear." },
            { value: "multiple", label: "Many paths" },
          ],
          question: "How should the plan branch?",
          type: "choice",
        },
        message: "Choose scope",
        to: "user",
        toolCallId: "human:2",
      }),
    ).toBe(
      [
        "How should the plan branch?",
        "1. One path [single] - Keep the workflow linear.",
        "2. Many paths [multiple]",
        "Type a number or value.",
      ].join("\n"),
    );
  });

  it("resolves plain choice answers by index, value, or label", () => {
    const request = {
      action: "human_task",
      interaction: {
        choices: [
          { value: "false", label: "No red flags" },
          { value: "true", label: "A red flag is present" },
        ],
        question: "Any red flags?",
        type: "choice" as const,
      },
      message: "Choose red flag state",
      to: "user",
      toolCallId: "human:3",
    };

    expect(defaultReplyForRequest(request)).toBe("");
    expect(() => resolveReplyForRequest(request, "")).toThrow(
      "Workflow input cancelled; checkpoint preserved.",
    );
    expect(resolveReplyForRequest(request, "2")).toBe("true");
    expect(resolveReplyForRequest(request, "No red flags")).toBe("false");
    expect(() => resolveReplyForRequest(request, "manual override")).toThrow(
      "[pi-wendao.runtime.invalid_native_choice_reply]",
    );
  });

  it("keeps confirm prompts explicit for human tasks", () => {
    const request = {
      action: "human_task",
      interaction: {
        question: "Continue?",
        type: "confirm" as const,
      },
      message: "Confirm continuation",
      to: "user",
      toolCallId: "human:4",
    };

    expect(defaultReplyForRequest(request)).toBe("");
    expect(() => resolveReplyForRequest(request, "")).toThrow(
      "Workflow input cancelled; checkpoint preserved.",
    );
    expect(resolveReplyForRequest(request, "2")).toBe("rejected");
    expect(() => resolveReplyForRequest(request, "maybe")).toThrow(
      "[pi-wendao.runtime.invalid_native_choice_reply]",
    );
  });

  it("allows free-form answers only for explicit human free-text interactions", () => {
    const request = {
      action: "human_task",
      interaction: {
        choices: [
          { value: "expand", label: "Explore more" },
          { value: "narrow", label: "Narrow scope" },
        ],
        question: "How should the plan branch?",
        type: "choice_input" as const,
      },
      message: "Choose scope",
      to: "user",
      toolCallId: "human:5",
    };

    expect(resolveReplyForRequest(request, "2")).toBe("narrow");
    expect(resolveReplyForRequest(request, "custom direction")).toBe("custom direction");
  });

  it("keeps planner approval defaults outside BPMN human tasks", () => {
    const request = {
      action: "ask",
      message: "Approve generated plan?",
      to: "planner",
      toolCallId: "planner:1",
    };

    expect(defaultReplyForRequest(request)).toBe("approved");
    expect(resolveReplyForRequest(request, "")).toBe("approved");
  });
});
