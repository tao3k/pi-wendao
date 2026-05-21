import type { ActivityId, InstanceId, NodeIndex, ProcessId, TokenId } from "../types/domain.js";

export interface PiWendaoConfig {
  hostKind?: PiWendaoHostWorkKind;
  prompt: string;
  tools: string[];
  toolScopes?: PiWendaoToolScope[];
  inputs: string[];
  outputs: string[];
  outputSchemas?: Record<string, QianjiOutputSchema>;
  interaction?: QianjiInteraction;
  subagent?: PiWendaoSubagentConfig;
}

export type QianjiInteractionType = "input" | "confirm" | "choice" | "choice_input";
export type QianjiOutputSchemaRequirement = "required" | "optional";

export interface QianjiOutputSchema {
  kind: string;
  value?: QianjiOutputSchemaRequirement;
  label?: QianjiOutputSchemaRequirement;
  description?: QianjiOutputSchemaRequirement;
}

export interface PiWendaoToolScope {
  tool: string;
  command?: string;
  path?: string;
  cwd?: string;
  timeoutSeconds?: number;
  writes?: boolean;
  network?: boolean;
}

type QianjiPromptOutputSchema =
  | QianjiOutputSchema
  | {
      type: "array";
      items: unknown;
      example: unknown;
    };

export interface QianjiInteraction {
  type: QianjiInteractionType;
  question?: string;
  questionRef?: string;
  choices?: QianjiInteractionChoice[];
  choicesRef?: string;
  freeText?: QianjiInteractionFreeText;
  result?: QianjiInteractionResult;
}

export interface QianjiInteractionChoice {
  value: string;
  label?: string;
  description?: string;
}

export interface QianjiInteractionFreeText {
  name?: string;
  optional?: boolean;
  placeholder?: string;
}

export interface QianjiInteractionResult {
  output?: string;
}

export type PiWendaoHostWorkKind =
  | "send"
  | "service"
  | "script"
  | "user"
  | "manual"
  | "business_rule";

export interface PiWendaoSubagentConfig {
  type?: string;
  description?: string;
  runInBackground?: boolean;
  model?: string;
  thinking?: string;
  maxTurns?: number;
  isolated?: boolean;
  isolation?: string;
  inheritContext?: boolean;
}

export interface PiWendaoQianjiCheckpointFeedback {
  outcome?: string;
  backend?: string;
  source?: string;
  saved?: string;
  deleted?: string;
  status?: string;
  pendingHostWork?: string;
}

export interface PiWendaoAgentExecutionMetadata {
  activityId?: ActivityId;
  processId?: ProcessId;
  instanceId?: InstanceId;
  nodeIndex?: NodeIndex;
  tokenId?: TokenId;
  repeat?: unknown;
  checkpoint?: PiWendaoQianjiCheckpointFeedback;
}

export interface PiWendaoAgentRequest {
  activityId: string;
  config: PiWendaoConfig;
  variables: Record<string, unknown>;
  execution?: PiWendaoAgentExecutionMetadata;
  signal?: AbortSignal;
}

export interface PiWendaoAgentHost {
  run(request: PiWendaoAgentRequest): Promise<Record<string, unknown>>;
}

export const EMPTY_PI_WENDAO_CONFIG: PiWendaoConfig = {
  prompt: "",
  tools: [],
  inputs: [],
  outputs: [],
};

export function buildPiWendaoAgentPrompt(
  config: PiWendaoConfig,
  variables: Record<string, unknown>,
  execution?: PiWendaoAgentExecutionMetadata,
): string {
  const scopedVars: Record<string, unknown> = {};
  for (const inputName of config.inputs) {
    if (inputName in variables) {
      scopedVars[inputName] = variables[inputName];
    }
  }

  const variableContext = Object.entries(scopedVars)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n");
  const resolvedPrompt = config.prompt.replace(
    /\$\{environment\.variables\.(\w+)\}/g,
    (_, varName: string) => {
      const val = variables[varName];
      return val !== undefined ? JSON.stringify(val) : "undefined";
    },
  );

  const promptParts = [resolvedPrompt];
  if (variableContext) {
    promptParts.push(`\n\nCurrent qianji task inputs (read-only):\n${variableContext}`);
  }
  const taskIdentityContext = formatTaskIdentityContext(execution);
  if (taskIdentityContext) {
    promptParts.push(
      `\n\nQianji BPMN task identity (not task input; do not use as business output):\n${taskIdentityContext}`,
    );
  }
  if (config.outputs.length > 0) {
    promptParts.push(
      `\nAfter completing the task, output the following variables in a JSON code block with exactly these keys:\n${config.outputs.map((o) => `- ${o}`).join("\n")}`,
    );
  }
  const outputSchemaContext = formatOutputSchemas(config);
  if (outputSchemaContext) {
    promptParts.push(`\n\nqianji_output_schema:\n\`\`\`json\n${outputSchemaContext}\n\`\`\``);
  }
  promptParts.push(
    "\nQianji owns BPMN scheduling, gateway routing, retries, joins, checkpoint persistence, and resume state. Do not advance the workflow or decide the next BPMN node; only complete this service task and return its declared outputs.",
  );
  const toolScopeContext = formatToolScopes(config);
  if (toolScopeContext) {
    promptParts.push(`\n\nqianji_tool_scope:\n\`\`\`json\n${toolScopeContext}\n\`\`\``);
  }
  return promptParts.join("");
}

function formatToolScopes(config: PiWendaoConfig): string {
  const scopes = (config.toolScopes ?? []).filter((scope) =>
    config.tools.includes(scope.tool),
  );
  return scopes.length > 0 ? JSON.stringify(scopes, null, 2) : "";
}

function formatOutputSchemas(config: PiWendaoConfig): string {
  const schemas = config.outputSchemas ?? {};
  const declaredSchemas = Object.fromEntries(
    config.outputs
      .map((name) => {
        const schema = schemas[name];
        return [name, schema ? formatOutputSchema(schema) : undefined] as const;
      })
      .filter((entry): entry is readonly [string, QianjiPromptOutputSchema] =>
        Boolean(entry[1]),
      ),
  );
  return Object.keys(declaredSchemas).length > 0
    ? JSON.stringify(declaredSchemas, null, 2)
    : "";
}

function formatOutputSchema(schema: QianjiOutputSchema): QianjiPromptOutputSchema {
  if (schema.kind !== "choice_array") return schema;
  const items = {
    type: "object",
    required: ["value"],
    properties: {
      value: { type: "string", minLength: 1 },
      label: { type: "string" },
      description: { type: "string" },
    },
    additionalProperties: false,
  };
  return {
    type: "array",
    items,
    example: [
      {
        value: "minimal",
        label: "Minimal repair",
        description: "Repair only the failing contract.",
      },
    ],
  };
}

function formatTaskIdentityContext(execution: PiWendaoAgentExecutionMetadata | undefined): string {
  if (!execution) return "";
  const lines: string[] = [];
  appendField(lines, "processId", execution.processId);
  appendField(lines, "activityId", execution.activityId);
  appendField(lines, "nodeIndex", execution.nodeIndex);
  appendField(lines, "tokenId", execution.tokenId);
  return lines.map((line) => `- ${line}`).join("\n");
}

function appendField(lines: string[], name: string, value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  lines.push(`${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

export function extractOutputVariablesFromText(
  textContent: string,
  outputNames: string[],
): Record<string, unknown> {
  if (outputNames.length === 0) return {};

  const jsonMatch = textContent.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonMatch) {
    const extracted = pickOutputVariables(jsonMatch[1], outputNames);
    if (extracted) return extracted;
  }

  const parsed = pickOutputVariables(textContent, outputNames);
  if (parsed) return parsed;

  const embedded = pickEmbeddedOutputVariables(textContent, outputNames);
  return embedded ?? {};
}

function pickOutputVariables(
  rawJson: string,
  outputNames: string[],
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(rawJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const name of outputNames) {
      if (name in record) {
        result[name] = record[name];
      }
    }
    return result;
  } catch {
    return undefined;
  }
}

function pickEmbeddedOutputVariables(
  textContent: string,
  outputNames: string[],
): Record<string, unknown> | undefined {
  let best: Record<string, unknown> | undefined;
  let bestCount = 0;
  for (const candidate of extractJsonObjectCandidates(textContent)) {
    const extracted = pickOutputVariables(candidate, outputNames);
    if (!extracted) continue;
    const count = Object.keys(extracted).length;
    if (count > bestCount) {
      best = extracted;
      bestCount = count;
      if (count === outputNames.length) return best;
    }
  }
  return best;
}

function extractJsonObjectCandidates(textContent: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < textContent.length; index += 1) {
    const char = textContent[index];
    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        candidates.push(textContent.slice(start, index + 1));
        start = -1;
        inString = false;
      }
    }
  }

  return candidates;
}
