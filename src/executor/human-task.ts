import type { PiWendaoConfig, QianjiInteractionChoice } from "./agent-host.js";

export function resolveHumanTaskConfig(
  config: PiWendaoConfig,
  variables: Record<string, unknown>,
): PiWendaoConfig {
  const question = config.interaction?.questionRef
    ? formatHumanTaskValue(variables[config.interaction.questionRef])
    : config.interaction?.question;
  const dynamicChoices = config.interaction?.choicesRef
    ? resolveHumanTaskChoicesRef(
        config.interaction.choicesRef,
        variables[config.interaction.choicesRef],
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

function resolveHumanTaskChoicesRef(ref: string, value: unknown): QianjiInteractionChoice[] {
  const source = parseChoiceSource(value);
  if (!Array.isArray(source)) {
    throw new Error(
      `qianji:choices ref '${ref}' must resolve to a JSON array of choice objects with required non-empty value fields.`,
    );
  }
  if (source.length === 0) {
    throw new Error(`qianji:choices ref '${ref}' must resolve to at least one choice object.`);
  }
  return source.map((choice, index) => parseHumanTaskChoiceObject(ref, choice, index));
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
): QianjiInteractionChoice {
  if (!isRecord(value)) {
    throw new Error(
      `qianji:choices ref '${ref}' item ${index + 1} must be an object with required non-empty value and optional label/description fields.`,
    );
  }
  const choiceValue = readChoiceString(value.value);
  if (!choiceValue) {
    throw new Error(
      `qianji:choices ref '${ref}' item ${index + 1} is missing required non-empty value; value is the reply returned to the userTask output mapping.`,
    );
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
