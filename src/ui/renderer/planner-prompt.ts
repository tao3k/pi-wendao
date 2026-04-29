import { cyan, dim, yellow } from "yoctocolors";
import { WorkflowInterruptedError } from "../../executor/interrupt.js";
import type { QianjiInteraction, QianjiInteractionChoice } from "../../executor/agent-host.js";
import type { LogView } from "../graph-view.js";
import type { PlannerReplyRequest } from "./types.js";
import { compactLinePreservingShape } from "./text.js";

export function appendPlannerPrompt(target: LogView, request: PlannerReplyRequest): void {
  const prompt = replyPromptForRequest(request);
  const label = request.context?.activityId
    ? `${prompt.label} for ${request.context.activityId}`
    : prompt.label;
  target.appendLine(yellow(label));
  target.appendLine(dim(`  ${compactLinePreservingShape(questionTextForRequest(request), 180)}`));
  target.appendLine(cyan(`${prompt.prefix}> `));
}

export function questionTextForRequest(request: PlannerReplyRequest): string {
  const question = request.interaction?.question || request.message || "(empty request)";
  const choices = choicesForRequest(request);
  if (choices.length === 0) return question;
  const lines = [question, ...choices.map(formatChoiceLine)];
  if (allowsFreeText(request.interaction)) {
    lines.push("Type a number, value, or custom text.");
  } else {
    lines.push("Type a number or value.");
  }
  return lines.join("\n");
}

export function replyPromptForRequest(request: PlannerReplyRequest): {
  label: string;
  prefix: string;
} {
  if (request.action === "workflow_path") {
    return { label: "workflow path", prefix: "workflow" };
  }
  if (request.action === "human_task" || request.to === "user") {
    return { label: "user input", prefix: "user" };
  }
  return { label: "planner approval", prefix: "planner" };
}

export function defaultReplyForRequest(request: PlannerReplyRequest): string {
  if (request.action === "workflow_path") return "";
  if (request.action === "human_task" || request.to === "user") {
    return "";
  }
  return "approved";
}

export function resolveReplyForRequest(request: PlannerReplyRequest, answer: string): string {
  const trimmed = answer.trim();
  if (!trimmed) {
    if (isWorkflowHumanInput(request)) {
      throw new WorkflowInterruptedError("Workflow input cancelled; checkpoint preserved.");
    }
    return defaultReplyForRequest(request);
  }
  const choice = choiceReplyForAnswer(request, trimmed);
  if (choice) return choice.value;
  if (isWorkflowHumanInput(request) && !allowsFreeText(request.interaction)) {
    throw new Error(formatInvalidChoiceReplyError(request, trimmed));
  }
  return trimmed;
}

function isWorkflowHumanInput(request: PlannerReplyRequest): boolean {
  return request.action === "human_task" || request.to === "user";
}

function formatInvalidChoiceReplyError(request: PlannerReplyRequest, answer: string): string {
  const activity = request.context?.activityId ?? "<unknown>";
  const choices = choicesForRequest(request).map((choice) => choice.value);
  return [
    "[pi-wendao.runtime.invalid_native_choice_reply]",
    `BPMN human task '${activity}' received an answer that does not match a native choice.`,
    `Answer: ${JSON.stringify(answer)}`,
    `Allowed values: ${JSON.stringify(choices)}`,
    "Contract: native choice/confirm prompts require number, value, or label selection. Use choice_input or input for free-form answers.",
  ].join("\n");
}

function choiceReplyForAnswer(
  request: PlannerReplyRequest,
  answer: string,
): QianjiInteractionChoice | undefined {
  const choices = choicesForRequest(request);
  if (choices.length === 0) return undefined;
  const numeric = Number(answer);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= choices.length) {
    return choices[numeric - 1];
  }
  const normalized = answer.toLowerCase();
  return choices.find(
    (choice) =>
      choice.value.toLowerCase() === normalized || choice.label?.toLowerCase() === normalized,
  );
}

function choicesForRequest(request: PlannerReplyRequest): QianjiInteractionChoice[] {
  const interaction = request.interaction;
  if (interaction?.choices?.length) return interaction.choices;
  if (interaction?.type === "confirm") {
    return [
      { value: "approved", label: "Approve" },
      { value: "rejected", label: "Reject" },
    ];
  }
  return [];
}

function formatChoiceLine(choice: QianjiInteractionChoice, index: number): string {
  const label = choice.label || choice.value;
  const description = choice.description ? ` - ${choice.description}` : "";
  const value = choice.value === label ? "" : ` [${choice.value}]`;
  return `${index + 1}. ${label}${value}${description}`;
}

function allowsFreeText(interaction: QianjiInteraction | undefined): boolean {
  return (
    interaction?.type === "input" ||
    interaction?.type === "choice_input" ||
    Boolean(interaction?.freeText)
  );
}
