import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { QianjiInteractionChoice } from "../../executor/agent-host.js";
import { WorkflowInterruptedError, waitForWorkflowInterrupt } from "../../executor/interrupt.js";
import type { PlannerReplyRequest } from "../../ui/renderer.js";
import { requestQianjiInteractionReply } from "../qianji-interaction-prompt.js";
import {
  runNativeWorkflowPiAskFlow,
  type NativeAskFlow,
  type NativeAskFreeText,
  type NativeAskOption,
  type NativeAskParams,
} from "./ask.js";
import { WORKFLOW_ASK_CONTEXT_MESSAGE_TYPE, WORKFLOW_ASK_STATUS_KEY } from "./constants.js";
import { withNativeWorkflowUiEscScope } from "./esc-scope.js";
import { defaultReply, promptLabel, stripAnsi } from "./text.js";

const PLANNER_REPLY_QUESTION_ID = "planner_reply";

export interface NativeWorkflowInputReplyRequest {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  workflowPath: string;
  request: PlannerReplyRequest;
  signal?: AbortSignal;
  askFlow?: NativeAskFlow;
}

export async function requestNativeWorkflowInputReply({
  pi,
  ctx,
  workflowPath,
  request,
  signal,
  askFlow = runNativeWorkflowPiAskFlow,
}: NativeWorkflowInputReplyRequest): Promise<string> {
  if (!ctx.hasUI) {
    if (isWorkflowHumanInput(request)) {
      throw new WorkflowInterruptedError("Workflow input requires native UI; checkpoint preserved.");
    }
    return Promise.resolve(fallbackReply(request));
  }
  if (signal?.aborted) throw new WorkflowInterruptedError();

  const details: PiWendaoWorkflowAskContextDetails = {
    id: randomUUID(),
    workflowPath,
    label: promptLabel(request),
    question: questionForWorkflowInput(request),
    choices: choicesForWorkflowInput(request),
  };
  ctx.ui.setStatus(WORKFLOW_ASK_STATUS_KEY, undefined);

  try {
    const rawAnswer = await requestPiAskWorkflowInput(askFlow, ctx, details, request, signal);
    const answer = normalizeWorkflowInputAnswer(rawAnswer, request);
    details.answer = answer;
    details.status = "answered";
    ctx.ui.setStatus(WORKFLOW_ASK_STATUS_KEY, undefined);
    sendWorkflowAskContextMessage(pi, details);
    return answer;
  } catch (error) {
    if (error instanceof WorkflowInterruptedError) {
      details.status = "cancelled";
      ctx.ui.setStatus(WORKFLOW_ASK_STATUS_KEY, undefined);
      sendWorkflowAskContextMessage(pi, details);
    }
    throw error;
  }
}

interface PiWendaoWorkflowAskContextDetails {
  id: string;
  workflowPath?: string;
  label: string;
  question: string;
  answer?: string;
  status?: "answered" | "cancelled";
  choices: QianjiInteractionChoice[];
}

function sendWorkflowAskContextMessage(
  pi: ExtensionAPI,
  details: PiWendaoWorkflowAskContextDetails,
): void {
  pi.sendMessage<PiWendaoWorkflowAskContextDetails>({
    customType: WORKFLOW_ASK_CONTEXT_MESSAGE_TYPE,
    content: workflowAskContext(details),
    display: false,
    details,
  });
}

function workflowAskContext(details: PiWendaoWorkflowAskContextDetails): string {
  const workflowPath = details.workflowPath ? `workflowPath: ${details.workflowPath}\n` : "";
  return [
    "[pi-wendao workflow ask]",
    workflowPath.trimEnd(),
    details.status ? `status: ${details.status}` : undefined,
    `label: ${details.label}`,
    `question: ${stripAnsi(details.question)}`,
    details.answer ? `answer: ${stripAnsi(details.answer)}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function questionForWorkflowInput(request: PlannerReplyRequest): string {
  return request.interaction?.question || request.message || "(empty request)";
}

function choicesForWorkflowInput(request: PlannerReplyRequest): QianjiInteractionChoice[] {
  if (request.interaction?.choices?.length) return request.interaction.choices;
  if (request.interaction?.type === "confirm") {
    return [
      { value: "approved", label: "Approve" },
      { value: "rejected", label: "Reject" },
    ];
  }
  return [];
}

function normalizeWorkflowInputAnswer(rawAnswer: string, request: PlannerReplyRequest): string {
  const trimmed = rawAnswer.trim();
  if (trimmed) return trimmed;
  if (isWorkflowHumanInput(request)) {
    throw new WorkflowInterruptedError("Workflow input cancelled; checkpoint preserved.");
  }
  return fallbackReply(request);
}

async function requestPiAskWorkflowInput(
  askFlow: NativeAskFlow,
  ctx: ExtensionCommandContext,
  details: PiWendaoWorkflowAskContextDetails,
  request: PlannerReplyRequest,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new WorkflowInterruptedError();
  if (shouldUseDirectInputPrompt(details, request)) {
    const answer = await withNativeWorkflowUiEscScope(() =>
      Promise.race([
        requestQianjiInteractionReply(ctx, request, signal),
        waitForWorkflowInterrupt(signal),
      ]),
    );
    if (answer === undefined)
      throw new WorkflowInterruptedError("Workflow input cancelled; checkpoint preserved.");
    return answer;
  }
  const result = await Promise.race([
    askFlow(ctx, workflowInputAskParams(details, request)),
    waitForWorkflowInterrupt(signal),
  ]);
  return answerFromAskResult(result, request);
}

function shouldUseDirectInputPrompt(
  details: PiWendaoWorkflowAskContextDetails,
  request: PlannerReplyRequest,
): boolean {
  return details.choices.length === 0 && !defaultReply(request) && allowsFreeText(request);
}

function workflowInputAskParams(
  details: PiWendaoWorkflowAskContextDetails,
  request: PlannerReplyRequest,
): NativeAskParams {
  const options = workflowInputAskOptions(details, request);
  const freeText = workflowInputFreeText(request);
  return {
    title: `${details.label} · ${basename(details.workflowPath ?? "workflow")}`,
    questions: [
      {
        ...(freeText ? { freeText } : {}),
        id: PLANNER_REPLY_QUESTION_ID,
        label: details.label,
        options,
        prompt: details.question,
        required: true,
        type: "single",
      },
    ],
  };
}

function workflowInputFreeText(request: PlannerReplyRequest): NativeAskFreeText | undefined {
  const freeText = request.interaction?.freeText;
  if (!freeText) return undefined;
  return {
    ...(freeText.name ? { name: freeText.name } : {}),
    ...(typeof freeText.optional === "boolean" ? { optional: freeText.optional } : {}),
    ...(freeText.placeholder ? { placeholder: freeText.placeholder } : {}),
  };
}

function workflowInputAskOptions(
  details: PiWendaoWorkflowAskContextDetails,
  request: PlannerReplyRequest,
): NativeAskOption[] {
  if (details.choices.length > 0) {
    return details.choices.map((choice) => ({
      description: choice.description,
      label: choice.label || choice.value,
      value: choice.value,
    }));
  }
  if (isWorkflowHumanInput(request)) {
    throw new Error(formatMissingWorkflowHumanInputOptionsError(request));
  }
  const fallback = defaultReply(request);
  if (fallback) {
    return [{ label: "Use default reply", value: fallback }];
  }
  if (allowsFreeText(request)) return [];
  return [{ label: "Reject", value: "rejected" }];
}

function answerFromAskResult(
  result: Awaited<ReturnType<NativeAskFlow>>,
  request: PlannerReplyRequest,
): string {
  if (result.cancelled)
    throw new WorkflowInterruptedError("Workflow input cancelled; checkpoint preserved.");
  const answer = result.answers?.[PLANNER_REPLY_QUESTION_ID];
  const custom = answer?.customText?.trim();
  if (custom) return custom;
  const value = answer?.values?.[0]?.trim();
  if (value) return value;
  return fallbackReply(request);
}

function fallbackReply(request: PlannerReplyRequest): string {
  if (isWorkflowHumanInput(request)) {
    throw new WorkflowInterruptedError("Workflow input cancelled; checkpoint preserved.");
  }
  return defaultReply(request) || "rejected";
}

function isWorkflowHumanInput(request: PlannerReplyRequest): boolean {
  return request.action === "human_task" || request.to === "user";
}

function formatMissingWorkflowHumanInputOptionsError(request: PlannerReplyRequest): string {
  const activity = request.context?.activityId ?? "<unknown>";
  const type = request.interaction?.type ?? "<missing>";
  return [
    "[pi-wendao.runtime.missing_native_interaction_options]",
    `BPMN human task '${activity}' has no renderable native interaction choices.`,
    `Interaction type: ${type}`,
    "Contract: native host-work form metadata must provide choices for choice/choice_input prompts, or use input/freeText for free-form prompts.",
    "Run BPMN lint/compile so stale artifacts are repaired before pi-wendao renders native pi-ask UI.",
  ].join("\n");
}

function allowsFreeText(request: PlannerReplyRequest): boolean {
  const interaction = request.interaction;
  return (
    interaction?.type === "input" ||
    interaction?.type === "choice_input" ||
    Boolean(interaction?.freeText)
  );
}
