import type {
  PiWendaoConfig,
  QianjiInteractionChoice,
  QianjiInteractionType,
} from "./agent-host.js";
import type { QianjiHostWork, QianjiHumanTaskForm } from "./qianji-types.js";

export interface HumanTaskResolutionContext {
  activityId?: string;
}

export class HumanTaskContractError extends Error {
  readonly code:
    | "pi-wendao.runtime.invalid_dynamic_choices"
    | "pi-wendao.runtime.invalid_dynamic_question";

  constructor(details: DynamicChoicesErrorDetails | DynamicQuestionErrorDetails) {
    super(
      details.kind === "question"
        ? formatDynamicQuestionError(details)
        : formatDynamicChoicesError(details),
    );
    this.name = "HumanTaskContractError";
    this.code =
      details.kind === "question"
        ? "pi-wendao.runtime.invalid_dynamic_question"
        : "pi-wendao.runtime.invalid_dynamic_choices";
  }
}

export function resolveHumanTaskConfig(
  config: PiWendaoConfig,
  variables: Record<string, unknown>,
  context: HumanTaskResolutionContext = {},
): PiWendaoConfig {
  const question = config.interaction?.questionRef
    ? resolveHumanTaskQuestionRef(
        config.interaction.questionRef,
        variables[config.interaction.questionRef],
        context,
      )
    : config.interaction?.question;
  const dynamicChoices = config.interaction?.choicesRef
    ? resolveHumanTaskChoicesRef(
        config.interaction.choicesRef,
        variables[config.interaction.choicesRef],
        context,
      )
    : undefined;
  const choices = dynamicChoices?.length ? dynamicChoices : config.interaction?.choices;
  return {
    ...config,
    ...(config.interaction
      ? {
          interaction: {
            ...config.interaction,
            ...(question ? { question } : {}),
            ...(choices?.length ? { choices } : {}),
          },
        }
      : {}),
  };
}

export function mergeQianjiHostWorkFormConfig(
  config: PiWendaoConfig,
  work: QianjiHostWork,
): PiWendaoConfig {
  const form = work.form;
  if (!isHumanHostWorkKind(work.kind)) {
    return {
      ...config,
      hostKind: work.kind,
    };
  }
  if (!form) {
    throw new Error(formatMissingQianjiHumanTaskFormError(work));
  }
  assertQianjiHumanTaskResultOutput(work, form);
  assertQianjiHumanTaskFreeTextCardinality(work, form);
  const interaction = qianjiInteractionFromHostWorkForm(form);
  const inputs = qianjiInputsFromHostWorkForm(form);
  const outputs = qianjiOutputsFromHostWorkForm(form);
  return {
    hostKind: work.kind,
    prompt: form.question_text?.trim() || "",
    tools: [],
    inputs,
    outputs,
    ...(interaction ? { interaction } : {}),
  };
}

export function validateOutputSchemas(
  config: PiWendaoConfig,
  output: Record<string, unknown>,
  context: HumanTaskResolutionContext = {},
): Record<string, unknown> {
  for (const [name, schema] of Object.entries(config.outputSchemas ?? {})) {
    if (schema.kind !== "choice_array") continue;
    if (!Object.prototype.hasOwnProperty.call(output, name)) {
      throw new HumanTaskContractError({
        ref: name,
        activityId: context.activityId,
        problem: "required choice_array output is missing",
        payload: output,
        role: "producer",
      });
    }
    validateChoiceArray(name, output[name], context, "producer");
  }
  return output;
}

function qianjiInteractionFromHostWorkForm(
  form: QianjiHumanTaskForm,
): PiWendaoConfig["interaction"] {
  const type = qianjiInteractionTypeFromHostWorkForm(form.interaction_type);
  if (!type) return undefined;
  const choices = (form.choices ?? [])
    .map((choice) => ({
      value: choice.value.trim(),
      ...(choice.label?.trim() ? { label: choice.label.trim() } : {}),
      ...(choice.description?.trim() ? { description: choice.description.trim() } : {}),
    }))
    .filter((choice) => choice.value.length > 0);
  const freeText = form.free_text_fields?.[0];
  return {
    type,
    ...(form.question_text?.trim() ? { question: form.question_text.trim() } : {}),
    ...(form.question_ref?.trim() ? { questionRef: form.question_ref.trim() } : {}),
    ...(choices.length > 0 ? { choices } : {}),
    ...(form.choices_ref?.trim() ? { choicesRef: form.choices_ref.trim() } : {}),
    ...(freeText
      ? {
          freeText: {
            name: freeText.name,
            optional: freeText.optional,
          },
        }
      : {}),
    ...(form.result_output?.trim() ? { result: { output: form.result_output.trim() } } : {}),
  };
}

function qianjiInteractionTypeFromHostWorkForm(value: string): QianjiInteractionType | undefined {
  return value === "input" || value === "confirm" || value === "choice" || value === "choice_input"
    ? value
    : undefined;
}

function qianjiOutputsFromHostWorkForm(form: QianjiHumanTaskForm): string[] {
  const resultOutput = form.result_output?.trim();
  return resultOutput ? [resultOutput] : [];
}

function qianjiInputsFromHostWorkForm(form: QianjiHumanTaskForm): string[] {
  const inputs = [form.question_ref?.trim(), form.choices_ref?.trim()].filter(
    (input): input is string => Boolean(input),
  );
  return [...new Set(inputs)];
}

function isHumanHostWorkKind(kind: QianjiHostWork["kind"]): boolean {
  return kind === "user" || kind === "manual";
}

function formatMissingQianjiHumanTaskFormError(work: QianjiHostWork): string {
  const activityId = work.activity_id?.trim() || work.node_id;
  return [
    "[pi-wendao.runtime.missing_native_human_task_form]",
    `BPMN ${work.kind}Task '${activityId}' did not include native host-work form metadata.`,
    "pi-wendao no longer infers human-task interaction metadata from local BPMN XML.",
    "Run the BPMN lint/compile path so native interaction form metadata is streamed on @@QIANJI_HOST_WORK.",
  ].join("\n");
}

export function mapHumanTaskReplyToOutputs(
  reply: string,
  outputNames: string[],
): Record<string, unknown> {
  if (outputNames.length !== 1) {
    throw new Error(formatInvalidHumanTaskResultOutputNamesError(outputNames));
  }
  return { [outputNames[0]]: reply.trim() };
}

export function humanTaskReplyOutputNames(
  config: PiWendaoConfig,
  context: HumanTaskResolutionContext = {},
): string[] {
  const resultOutput = config.interaction?.result?.output?.trim();
  if (!resultOutput) {
    throw new Error(formatMissingHumanTaskResultOutputError(context));
  }
  return [resultOutput];
}

function assertQianjiHumanTaskResultOutput(work: QianjiHostWork, form: QianjiHumanTaskForm): void {
  if (form.result_output?.trim()) return;
  throw new Error(
    formatMissingHumanTaskResultOutputError({
      activityId: work.activity_id?.trim() || work.node_id,
    }),
  );
}

function assertQianjiHumanTaskFreeTextCardinality(
  work: QianjiHostWork,
  form: QianjiHumanTaskForm,
): void {
  const freeTextFieldCount = form.free_text_fields?.length ?? 0;
  if (freeTextFieldCount <= 1) return;
  throw new Error(
    formatUnsupportedHumanTaskFreeTextFieldsError({
      activityId: work.activity_id?.trim() || work.node_id,
      freeTextFieldCount,
    }),
  );
}

function formatMissingHumanTaskResultOutputError(context: HumanTaskResolutionContext): string {
  const activity = context.activityId?.trim() || "<unknown>";
  return [
    "[pi-wendao.runtime.missing_native_answer_output]",
    `BPMN human task '${activity}' did not include native form result_output.`,
    "Contract: bpmn.native_human_task_io.v1 requires the Rust engine to stream result_output on @@QIANJI_HOST_WORK.",
    'Run BPMN lint/compile so the task declares dataOutput name="answer" with a dataOutputAssociation targetRef; pi-wendao does not infer outputs from local XML.',
  ].join("\n");
}

function formatUnsupportedHumanTaskFreeTextFieldsError(options: {
  activityId: string;
  freeTextFieldCount: number;
}): string {
  return [
    "[pi-wendao.runtime.unsupported_native_free_text_fields]",
    `BPMN human task '${options.activityId}' streamed ${options.freeTextFieldCount} free_text_fields.`,
    "pi-wendao supports at most one free-text field for the single result_output completion contract.",
    "Model additional user-entered fields as separate user/manual tasks or derive them in a following serviceTask.",
  ].join("\n");
}

function formatInvalidHumanTaskResultOutputNamesError(outputNames: string[]): string {
  return [
    "[pi-wendao.runtime.invalid_native_answer_output]",
    "Human task completion must map to exactly one native answer output.",
    `Received outputs: ${JSON.stringify(outputNames)}`,
    "Contract: bpmn.native_human_task_io.v1 returns the selected/free-form reply as a plain string under result_output.",
  ].join("\n");
}

function resolveHumanTaskQuestionRef(
  ref: string,
  value: unknown,
  context: HumanTaskResolutionContext,
): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new HumanTaskContractError({
    kind: "question",
    ref,
    activityId: context.activityId,
    problem: "ref did not resolve to a non-empty string",
    payload: value,
  });
}

function resolveHumanTaskChoicesRef(
  ref: string,
  value: unknown,
  context: HumanTaskResolutionContext,
): QianjiInteractionChoice[] {
  return validateChoiceArray(ref, value, context, "consumer");
}

function validateChoiceArray(
  ref: string,
  value: unknown,
  context: HumanTaskResolutionContext,
  role: DynamicChoicesErrorRole,
): QianjiInteractionChoice[] {
  const source = value;
  if (!Array.isArray(source)) {
    throw new HumanTaskContractError({
      ref,
      activityId: context.activityId,
      problem: "ref did not resolve to a JSON array",
      payload: source,
      role,
    });
  }
  if (source.length === 0) {
    throw new HumanTaskContractError({
      ref,
      activityId: context.activityId,
      problem: "ref resolved to an empty array",
      payload: source,
      role,
    });
  }
  return source.map((choice, index) =>
    parseHumanTaskChoiceObject(ref, choice, index, context, role),
  );
}

function parseHumanTaskChoiceObject(
  ref: string,
  value: unknown,
  index: number,
  context: HumanTaskResolutionContext,
  role: DynamicChoicesErrorRole,
): QianjiInteractionChoice {
  if (!isRecord(value)) {
    throw new HumanTaskContractError({
      ref,
      activityId: context.activityId,
      itemIndex: index + 1,
      problem: "item is not an object",
      payload: value,
      role,
    });
  }
  const choiceValue = readChoiceString(value.value);
  if (!choiceValue) {
    throw new HumanTaskContractError({
      ref,
      activityId: context.activityId,
      itemIndex: index + 1,
      problem: "item is missing required non-empty value",
      payload: value,
      role,
    });
  }
  const label = readChoiceString(value.label);
  const description = readChoiceString(value.description);
  return {
    value: choiceValue,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
  };
}

function readChoiceString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type DynamicChoicesErrorRole = "consumer" | "producer";

interface DynamicChoicesErrorDetails {
  kind?: "choices";
  ref: string;
  activityId?: string;
  itemIndex?: number;
  problem: string;
  payload: unknown;
  role?: DynamicChoicesErrorRole;
}

interface DynamicQuestionErrorDetails {
  kind: "question";
  ref: string;
  activityId?: string;
  problem: string;
  payload: unknown;
}

function formatDynamicChoicesError(details: DynamicChoicesErrorDetails): string {
  const activityRole = details.role === "producer" ? "Producer activity" : "Consumer activity";
  return [
    "[pi-wendao.runtime.invalid_dynamic_choices] Error: Invalid dynamic choices payload",
    "",
    `${activityRole}: ${details.activityId ?? "(unknown activity)"}`,
    `Variable: ${details.ref}`,
    ...(details.itemIndex ? [`Item: ${details.itemIndex}`] : []),
    `Problem: ${details.problem}`,
    `Bad payload: ${formatChoicePayload(details.payload)}`,
    "",
    `Help: ${details.ref} must be a native Array<{ value: string; label?: string; description?: string }>; do not wrap the array in a JSON string.`,
    "Contract: native choices data must be a JSON array whose items have a non-empty string value.",
    "",
    "Expected value:",
    "```json",
    JSON.stringify(expectedChoiceArrayValue(details.ref), null, 2),
    "```",
  ].join("\n");
}

function formatDynamicQuestionError(details: DynamicQuestionErrorDetails): string {
  return [
    "[pi-wendao.runtime.invalid_dynamic_question] Error: Invalid dynamic question payload",
    "",
    `Consumer activity: ${details.activityId ?? "(unknown activity)"}`,
    `Variable: ${details.ref}`,
    `Problem: ${details.problem}`,
    `Bad payload: ${formatChoicePayload(details.payload)}`,
    "",
    `Help: ${details.ref} must be a non-empty string used as the user-facing prompt.`,
    "Contract: bpmn.native_human_task_io.v1 requires question source values to be prompt text, not JSON objects.",
    "",
    "Expected value:",
    "```json",
    JSON.stringify(expectedQuestionValue(details.ref), null, 2),
    "```",
  ].join("\n");
}

function expectedQuestionValue(ref: string): Record<string, string> {
  return {
    [ref]: "Which repair path should the workflow use?",
  };
}

function expectedChoiceArrayValue(ref: string): Record<string, QianjiInteractionChoice[]> {
  return {
    [ref]: [
      {
        value: "minimal",
        label: "Minimal repair",
        description: "Repair only the failing contract.",
      },
    ],
  };
}

function formatChoicePayload(value: unknown): string {
  try {
    const formatted = JSON.stringify(value);
    if (!formatted) return String(value);
    return formatted.length <= 240 ? formatted : `${formatted.slice(0, 237)}...`;
  } catch {
    return String(value);
  }
}
