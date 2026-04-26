import { describe, expect, it } from "vitest";
import {
  defaultReplyForRequest,
  questionTextForRequest,
  resolveReplyForRequest,
} from "../../src/ui/renderer/planner-prompt.js";

describe("planner prompt text", () => {
  it("prefers resolved qianji interaction questions over host prompts", () => {
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

  it("renders qianji interaction choices for plain user prompts", () => {
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

  it("resolves plain choice answers by default, index, value, or label", () => {
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

    expect(defaultReplyForRequest(request)).toBe("false");
    expect(resolveReplyForRequest(request, "")).toBe("false");
    expect(resolveReplyForRequest(request, "2")).toBe("true");
    expect(resolveReplyForRequest(request, "No red flags")).toBe("false");
    expect(resolveReplyForRequest(request, "manual override")).toBe("manual override");
  });

  it("keeps confirm defaults aligned with native interaction prompts", () => {
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

    expect(defaultReplyForRequest(request)).toBe("approved");
    expect(resolveReplyForRequest(request, "2")).toBe("rejected");
  });
});
