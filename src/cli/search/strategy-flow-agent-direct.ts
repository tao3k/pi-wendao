import { parseSearchStrategyFlowBranchJudgements } from "./strategy-flow-branch-judgement.js";
import type {
  SearchStrategyFlowAgentTrace,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";

interface AnthropicGatewayModel {
  provider: string;
  id: string;
  baseUrl?: string;
}

export interface DirectSearchStrategyFlowAgentOptions {
  trace: SearchStrategyFlowTrace;
  prompt: string;
  compactTrace: Record<string, unknown>;
  model: AnthropicGatewayModel;
  apiKey?: string;
  headers?: Record<string, string>;
  startedAt: number;
}

export async function runDirectSearchStrategyFlowAgentTrace(
  options: DirectSearchStrategyFlowAgentOptions,
): Promise<SearchStrategyFlowAgentTrace> {
  if (options.model.provider !== "anthropic") {
    return failedDirectTrace(options, "direct fallback only supports Anthropic-compatible models");
  }
  const baseUrl = resolveAnthropicBaseUrl(options.model);
  if (!baseUrl) {
    return failedDirectTrace(options, "direct fallback missing Anthropic-compatible base URL");
  }
  if (!options.apiKey && !hasAuthorizationHeader(options.headers)) {
    return failedDirectTrace(options, "direct fallback missing request auth");
  }

  let text: string;
  try {
    text = await callAnthropicMessages({
      baseUrl,
      apiKey: options.apiKey,
      headers: options.headers,
      modelId: options.model.id,
      prompt: buildDirectPrompt(options.prompt, options.compactTrace),
    });
  } catch (error) {
    return failedDirectTrace(
      options,
      error instanceof Error ? error.message : String(error),
    );
  }

  const output = parseModelJsonObject(text);
  if (!output) {
    return failedDirectTrace(options, "direct fallback response did not contain a JSON object", text);
  }
  const intentUnderstanding = readNonEmptyString(output.intent_understanding);
  const branchDecision = readNonEmptyString(output.branch_decision);
  const judgement = readNonEmptyString(output.judgement);
  const missingOutputs = [
    ["intent_understanding", intentUnderstanding],
    ["branch_decision", branchDecision],
    ["judgement", judgement],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missingOutputs.length > 0) {
    return failedDirectTrace(
      options,
      `direct fallback completed without non-empty output(s): ${missingOutputs.join(", ")}`,
      text,
      output,
    );
  }

  const branchJudgements = parseSearchStrategyFlowBranchJudgements(
    output.branch_judgements,
    options.trace,
  );
  if (branchJudgements.errors.length > 0) {
    return {
      mode: "live-subagent",
      status: "failed",
      model: `${options.model.provider}/${options.model.id}`,
      durationMs: elapsedMs(options.startedAt),
      reason: `direct fallback returned invalid branch_judgements: ${branchJudgements.errors.join("; ")}`,
      events: [directResultEvent(text)],
      output,
      branchJudgementValidation: {
        valid: false,
        acceptedCount: 0,
        errors: branchJudgements.errors,
      },
    };
  }

  return {
    mode: "live-subagent",
    status: "completed",
    model: `${options.model.provider}/${options.model.id}`,
    durationMs: elapsedMs(options.startedAt),
    cached: false,
    events: [directResultEvent(text)],
    output,
    branchJudgements: branchJudgements.rows,
    branchJudgementValidation: {
      valid: true,
      acceptedCount: branchJudgements.rows.length,
      errors: [],
    },
  };
}

async function callAnthropicMessages(options: {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  modelId: string;
  prompt: string;
}): Promise<string> {
  const response = await fetch(`${options.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      ...anthropicGatewayAuthHeaders(options.baseUrl, options.apiKey, options.headers),
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: options.modelId,
      max_tokens: 1600,
      messages: [{ role: "user", content: options.prompt }],
    }),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`direct fallback request failed with status ${response.status}: ${responseText.slice(0, 512)}`);
  }
  const payload = JSON.parse(responseText) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  return payload.content
    ?.map((item) => (item.type === "text" ? item.text ?? "" : ""))
    .join("\n")
    .trim() ?? "";
}

function anthropicGatewayAuthHeaders(
  baseUrl: string,
  apiKey?: string,
  headers?: Record<string, string>,
): Record<string, string> {
  const requestHeaders = { ...(headers ?? {}) };
  if (!apiKey) return requestHeaders;
  if (isOpenRouterBaseUrl(baseUrl)) {
    requestHeaders.Authorization = `Bearer ${apiKey}`;
  } else {
    requestHeaders["x-api-key"] = apiKey;
  }

  return requestHeaders;
}

function buildDirectPrompt(prompt: string, compactTrace: Record<string, unknown>): string {
  return [
    prompt,
    "",
    "Compact trace JSON:",
    JSON.stringify(compactTrace),
    "",
    "Return exactly one JSON object, without Markdown fences, with keys:",
    "intent_understanding, branch_decision, judgement, branch_judgements.",
  ].join("\n");
}

function parseModelJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? extractFirstJsonObject(trimmed);
  if (!candidate) return undefined;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}

function resolveAnthropicBaseUrl(model: AnthropicGatewayModel): string | undefined {
  return (
    model.baseUrl?.trim() ||
    process.env.ANTHROPIC_BASE_URL?.trim() ||
    (model.id.toLowerCase().startsWith("deepseek-")
      ? "https://api.deepseek.com/anthropic"
      : undefined)
  );
}

function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  return Boolean(headers && Object.keys(headers).length > 0);
}

function isOpenRouterBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "openrouter.ai";
  } catch {
    return baseUrl.includes("openrouter.ai");
  }
}

function failedDirectTrace(
  options: DirectSearchStrategyFlowAgentOptions,
  reason: string,
  responseText?: string,
  output?: Record<string, unknown>,
): SearchStrategyFlowAgentTrace {
  return {
    mode: "live-subagent",
    status: "failed",
    model: `${options.model.provider}/${options.model.id}`,
    durationMs: elapsedMs(options.startedAt),
    reason,
    events: responseText ? [directResultEvent(responseText)] : [],
    output,
  };
}

function directResultEvent(resultText: string) {
  return {
    kind: "result" as const,
    activityId: "SearchStrategyFlow_QueryUnderstanding",
    description: "Direct Anthropic-compatible SearchStrategyFlow judgement fallback",
    resultText,
  };
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}
