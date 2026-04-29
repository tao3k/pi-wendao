import {
  EMPTY_PI_WENDAO_CONFIG,
  type PiWendaoConfig,
  type QianjiInteractionChoice,
} from "./agent-host.js";
import { mergeQianjiHostWorkFormConfig, resolveHumanTaskConfig } from "./human-task.js";
import type { QianjiHostWork } from "./qianji-types.js";

export class WorkflowStallGuard {
  private readonly seenUserPrompts = new Map<string, UserPromptOccurrence>();

  inspectPendingHostWork(options: {
    hostWork: QianjiHostWork[];
    piWendaoConfigs: Map<string, PiWendaoConfig>;
    variables: Record<string, unknown>;
  }): void {
    const prompts = options.hostWork
      .filter((work) => work.kind === "user")
      .map((work) => buildUserPromptOccurrence(work, options.piWendaoConfigs, options.variables));

    for (const prompt of prompts) {
      const previous = this.seenUserPrompts.get(prompt.fingerprint);
      if (previous) {
        throw new Error(formatStallMessage(prompt, previous));
      }
    }

    for (const prompt of prompts) {
      this.seenUserPrompts.set(prompt.fingerprint, prompt);
    }
  }
}

interface UserPromptOccurrence {
  fingerprint: string;
  activityId: string;
  question: string;
  choices: QianjiInteractionChoice[];
  inputNames: string[];
  outputNames: string[];
  inputValues: Record<string, unknown>;
  occurrenceTokenId: number;
}

function buildUserPromptOccurrence(
  work: QianjiHostWork,
  configs: Map<string, PiWendaoConfig>,
  variables: Record<string, unknown>,
): UserPromptOccurrence {
  const activityId = work.activity_id?.trim() || work.node_id;
  const config = mergeQianjiHostWorkFormConfig(
    configs.get(activityId) ?? EMPTY_PI_WENDAO_CONFIG,
    work,
  );
  const scopedVariables = { ...variables, ...(work.variables ?? {}) };
  const resolvedConfig = resolveHumanTaskConfig(config, scopedVariables, {
    activityId,
  });
  const question = resolvedConfig.interaction?.question || resolvedConfig.prompt || "";
  const choices = resolvedConfig.interaction?.choices ?? [];
  const inputValues = Object.fromEntries(
    config.inputs.map((name) => [name, canonicalize(scopedVariables[name])]),
  );
  const fingerprint = stableStringify({
    activityId,
    interactionType: resolvedConfig.interaction?.type,
    question,
    choices: choices.map((choice) => ({
      value: choice.value,
      label: choice.label,
      description: choice.description,
    })),
    inputValues,
  });
  return {
    fingerprint,
    activityId,
    question,
    choices,
    inputNames: config.inputs,
    outputNames: config.outputs,
    inputValues,
    occurrenceTokenId: work.token_id,
  };
}

function formatStallMessage(
  current: UserPromptOccurrence,
  previous: UserPromptOccurrence,
): string {
  const choices = current.choices.map((choice) => choice.value).join(", ") || "(none)";
  const inputs = formatInputValues(current);
  const outputs = current.outputNames.join(", ") || "(none)";
  const question = current.question.trim() || "(empty question)";
  return [
    "[pi-wendao.runtime.user_prompt_stall]",
    "Workflow user input stall detected.",
    "",
    `Activity: ${current.activityId}`,
    `Previous token: ${previous.occurrenceTokenId}`,
    `Current token: ${current.occurrenceTokenId}`,
    `Question: ${question}`,
    `Choices: ${choices}`,
    `UserTask outputs: ${outputs}`,
    "",
    "Unchanged native inputs:",
    inputs,
    "",
    "Fix:",
    "- Feed the userTask output into the serviceTask that generates the next question, choices, or route state.",
    "- Emit a changed declared native input, such as currentQuestion, currentChoices, attempt, or remaining count, before routing back to the same userTask.",
    "- If the repeat is intentional, model progress explicitly with native BPMN IO so the next prompt fingerprint changes.",
  ].join("\n");
}

function formatInputValues(prompt: UserPromptOccurrence): string {
  if (prompt.inputNames.length === 0) return "- (none)";
  return prompt.inputNames
    .map((name) => `- ${name}: ${JSON.stringify(prompt.inputValues[name])}`)
    .join("\n");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}
