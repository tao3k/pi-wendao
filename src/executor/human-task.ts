import type { PiWendaoConfig, QianjiInteractionChoice } from "./agent-host.js";

export interface HumanTaskResolutionContext {
  activityId?: string;
}

export class HumanTaskContractError extends Error {
  readonly code = "pi-wendao.runtime.invalid_dynamic_choices";

  constructor(details: DynamicChoicesErrorDetails) {
    super(formatDynamicChoicesError(details));
    this.name = "HumanTaskContractError";
  }
}

export function resolveHumanTaskConfig(
  config: PiWendaoConfig,
  variables: Record<string, unknown>,
  context: HumanTaskResolutionContext = {},
): PiWendaoConfig {
  const question = config.interaction?.questionRef
    ? formatHumanTaskValue(variables[config.interaction.questionRef])
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

export function mapHumanTaskReplyToOutputs(
  reply: string,
  outputNames: string[],
): Record<string, unknown> {
  if (outputNames.length === 0) return {};
  const trimmed = reply.trim();
  const result: Record<string, unknown> = {};
  for (const outputName of outputNames) {
    result[outputName] = mapHumanReplyValue(trimmed, outputName);
  }
  return result;
}

function mapHumanReplyValue(reply: string, outputName: string): unknown {
  if (isHumanReplyTextOutput(outputName)) return reply;
  if (isHumanApprovalOutput(outputName)) return parseHumanApprovalReply(reply);
  return parseHumanScalarReply(reply) ?? (reply || "approved");
}

function isHumanReplyTextOutput(outputName: string): boolean {
  const normalized = outputName.toLowerCase();
  return /reply|response|answer|feedback|idea|input|comment|note/.test(normalized);
}

function isHumanApprovalOutput(outputName: string): boolean {
  const normalized = outputName.toLowerCase();
  return (
    normalized === "approved" ||
    normalized === "approval" ||
    normalized === "accepted" ||
    normalized === "confirmed" ||
    normalized === "continue" ||
    normalized === "proceed" ||
    normalized.startsWith("is") ||
    normalized.startsWith("has") ||
    normalized.startsWith("can") ||
    normalized.startsWith("should") ||
    normalized.startsWith("needs") ||
    normalized.startsWith("need") ||
    normalized.startsWith("did") ||
    normalized.startsWith("will") ||
    normalized.endsWith("approved") ||
    normalized.endsWith("accepted") ||
    normalized.endsWith("confirmed")
  );
}

function parseHumanApprovalReply(reply: string): boolean {
  const normalized = reply.trim().toLowerCase();
  if (!normalized) return true;
  if (
    /^(n|no|false|0|reject|rejected|revise|revision|changes?|decline|declined|deny|denied|stop|cancel|cancelled)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /^(y|yes|true|1|approve|approved|accept|accepted|confirm|confirmed|ok|okay|continue|proceed)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  return true;
}

function parseHumanScalarReply(reply: string): boolean | undefined {
  const normalized = reply.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function formatHumanTaskValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
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
  const source = parseChoiceSource(value);
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
  return source.map((choice, index) => parseHumanTaskChoiceObject(ref, choice, index, context, role));
}

function parseChoiceSource(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
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
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type DynamicChoicesErrorRole = "consumer" | "producer";

interface DynamicChoicesErrorDetails {
  ref: string;
  activityId?: string;
  itemIndex?: number;
  problem: string;
  payload: unknown;
  role?: DynamicChoicesErrorRole;
}

function formatDynamicChoicesError(details: DynamicChoicesErrorDetails): string {
  const activityRole = details.role === "producer" ? "Producer activity" : "Consumer activity";
  return [
    "[pi-wendao.runtime.invalid_dynamic_choices] Error: Invalid dynamic qianji:choices payload",
    "",
    `${activityRole}: ${details.activityId ?? "(unknown activity)"}`,
    `Variable: ${details.ref}`,
    ...(details.itemIndex ? [`Item: ${details.itemIndex}`] : []),
    `Problem: ${details.problem}`,
    `Bad payload: ${formatChoicePayload(details.payload)}`,
    "",
    `Help: ${details.ref} must be Array<{ value: string; label?: string; description?: string }>.`,
    'Contract: qianji:outputSchema kind="choice_array" requires each item to be an object with a non-empty value.',
    "",
    "Expected value:",
    "```json",
    JSON.stringify(expectedChoiceArrayValue(details.ref), null, 2),
    "```",
  ].join("\n");
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
