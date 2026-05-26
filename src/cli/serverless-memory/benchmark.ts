import { writeFileSync } from "node:fs";
import {
  createAgentSessionFromServices,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { resolveModel } from "../model-resolver.js";
import type { PiWendaoThinkingLevel } from "../../executor/agent-runtime-types.js";
import { readServerlessMemoryRecallPacketFile } from "./file.js";
import {
  PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE,
  SERVERLESS_MEMORY_RECALL_PACKET_SCHEMA,
  type ServerlessMemoryRecallPacket,
  type ServerlessMemoryRecallRenderOptions,
} from "./types.js";
import { renderServerlessMemoryRecallContent } from "./session.js";

export const SERVERLESS_MEMORY_RECALL_BENCHMARK_TASK_PROMPT = [
  "Use only the Wendao memory recall already present in this session context.",
  "What reusable memory should guide this turn?",
  "Answer briefly in normal prose.",
  "Preserve provenance when the recall gives a stable memory identifier.",
  "Do not invent facts outside the recall.",
].join("\n");

export type ServerlessMemoryRecallBenchmarkVariant =
  | "section-only"
  | "property-only"
  | "org-elements";

export interface ServerlessMemoryRecallBenchmarkOptions {
  cwd: string;
  packetPath: ServerlessMemoryRecallBenchmarkPacketPath;
  modelPattern: string;
  provider?: string;
  apiKey?: ServerlessMemoryRecallBenchmarkApiKey;
  thinkingLevel?: PiWendaoThinkingLevel;
  prompt?: string;
  evidencePath?: ServerlessMemoryRecallBenchmarkEvidencePath;
  variants?: ServerlessMemoryRecallBenchmarkVariant[];
}

export type ServerlessMemoryRecallBenchmarkPacketPath = string;
export type ServerlessMemoryRecallBenchmarkApiKey = string;
export type ServerlessMemoryRecallBenchmarkEvidencePath = string;

export interface ServerlessMemoryRecallBenchmarkResult {
  schema: "xiuxian_wendao.serverless_memory_recall_benchmark.v1";
  packetSchema: typeof SERVERLESS_MEMORY_RECALL_PACKET_SCHEMA;
  model: string;
  expectedOrgid: string;
  expectedClaim: string;
  expectedSupportTerms: string[];
  expectedRows: ExpectedRecallFacts[];
  variants: ServerlessMemoryRecallBenchmarkVariantResult[];
}

export interface ServerlessMemoryRecallBenchmarkVariantResult {
  variant: ServerlessMemoryRecallBenchmarkVariant;
  passedClaim: boolean;
  passedSupportSummary: boolean;
  orgidHitCount: number;
  claimHitCount: number;
  claimRowCount: number;
  supportSummaryHitCount: number;
  rowResults: ServerlessMemoryRecallBenchmarkRowResult[];
  supportTermHits: string[];
  supportTermThreshold: number;
  contextChars: number;
  elapsedMs: number;
  answerText: string;
  streamedAnswerText: string;
  assistantMessageCount: number;
  sessionMessageRoles: string[];
  lastAssistantStopReason?: string;
  lastAssistantErrorMessage?: string;
  promptErrorMessage?: string;
}

export interface ServerlessMemoryRecallBenchmarkRowResult {
  orgid: string;
  passedOrgid: boolean;
  passedClaim: boolean;
  passedSupportSummary: boolean;
  supportTermHits: string[];
  supportTermThreshold: number;
}

export async function runServerlessMemoryRecallBenchmark(
  options: ServerlessMemoryRecallBenchmarkOptions,
): Promise<ServerlessMemoryRecallBenchmarkResult> {
  const packet = readServerlessMemoryRecallPacketFile(options.packetPath);
  const expected = expectedRecallFacts(packet);
  const resolved = await resolveModel(
    options.modelPattern,
    options.provider,
    options.apiKey,
    [],
  );
  if (!resolved.apiKey && !resolved.headers) {
    throw new Error("serverless memory recall benchmark requires configured model auth");
  }
  if (resolved.apiKey) {
    resolved.services.authStorage.setRuntimeApiKey(
      resolved.model.provider,
      resolved.apiKey,
    );
  }

  const variants = options.variants ?? ["section-only", "property-only", "org-elements"];
  const results = [];
  for (const variant of variants) {
    results.push(
      await runBenchmarkVariant({
        cwd: options.cwd,
        packet,
        variant,
        prompt: options.prompt ?? SERVERLESS_MEMORY_RECALL_BENCHMARK_TASK_PROMPT,
        expected,
        model: resolved.model,
        services: resolved.services,
        thinkingLevel: options.thinkingLevel ?? "minimal",
      }),
    );
  }
  const result: ServerlessMemoryRecallBenchmarkResult = {
    schema: "xiuxian_wendao.serverless_memory_recall_benchmark.v1",
    packetSchema: SERVERLESS_MEMORY_RECALL_PACKET_SCHEMA,
    model: `${resolved.model.provider}/${resolved.model.id}`,
    expectedOrgid: expected[0]?.orgid ?? "",
    expectedClaim: expected[0]?.claim ?? "",
    expectedSupportTerms: expected[0]?.supportTerms ?? [],
    expectedRows: expected,
    variants: results,
  };
  if (options.evidencePath) {
    writeFileSync(options.evidencePath, `${JSON.stringify(redactBenchmark(result), null, 2)}\n`);
  }
  return result;
}

async function runBenchmarkVariant(input: {
  cwd: string;
  packet: ServerlessMemoryRecallPacket;
  variant: ServerlessMemoryRecallBenchmarkVariant;
  prompt: string;
  expected: ExpectedRecallFacts[];
  model: Awaited<ReturnType<typeof resolveModel>>["model"];
  services: Awaited<ReturnType<typeof resolveModel>>["services"];
  thinkingLevel: PiWendaoThinkingLevel;
}): Promise<ServerlessMemoryRecallBenchmarkVariantResult> {
  const startedAt = Date.now();
  const content = renderServerlessMemoryRecallContent(input.packet, {
    render: renderOptionsForVariant(input.variant),
  });
  const sessionManager = SessionManager.inMemory(input.cwd);
  sessionManager.appendCustomMessageEntry(
    PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE,
    content,
    false,
    {
      schema: SERVERLESS_MEMORY_RECALL_PACKET_SCHEMA,
      variant: input.variant,
      rowCount: input.packet.rows.length,
    },
  );
  const { session } = await createAgentSessionFromServices({
    services: input.services,
    sessionManager,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    noTools: "all",
  });
  const capture = collectAssistantEvidence(session);
  try {
    let promptErrorMessage: string | undefined;
    try {
      await session.prompt(input.prompt, {
        expandPromptTemplates: false,
        source: "extension",
      });
    } catch (error) {
      promptErrorMessage = error instanceof Error ? error.message : String(error);
    }
    const assistantSummary = summarizeAssistantMessages(session);
    const streamedAnswerText = capture.getText().trim();
    const answerText = assistantSummary.text || streamedAnswerText;
    return {
      variant: input.variant,
      ...scoreBenchmarkAnswer(answerText, input.expected, Boolean(promptErrorMessage)),
      contextChars: content.length,
      elapsedMs: Date.now() - startedAt,
      answerText,
      streamedAnswerText,
      assistantMessageCount: assistantSummary.count,
      sessionMessageRoles: assistantSummary.roles,
      lastAssistantStopReason: assistantSummary.stopReason,
      lastAssistantErrorMessage: assistantSummary.errorMessage,
      promptErrorMessage,
    };
  } finally {
    capture.unsubscribe();
    session.dispose();
  }
}

function renderOptionsForVariant(
  variant: ServerlessMemoryRecallBenchmarkVariant,
): ServerlessMemoryRecallRenderOptions {
  if (variant === "section-only") {
    return {
      includeMatchedOrgElements: false,
      includeMemoryObjects: false,
    };
  }
  if (variant === "property-only") {
    return {
      includeMatchedOrgElements: false,
      includeMemoryObjects: true,
    };
  }
  return {
    includeMatchedOrgElements: true,
    includeMemoryObjects: true,
  };
}

interface ExpectedRecallFacts {
  orgid: string;
  primaryKind: string;
  claim: string;
  supportTerms: string[];
}

function expectedRecallFacts(packet: ServerlessMemoryRecallPacket): ExpectedRecallFacts[] {
  const rows = packet.rows
    .map((row) => {
      const claim = row.memoryObjects.find((object) => object.kind === "claim")?.value ?? "";
      const primaryObject = primaryExpectedMemoryObject(row.memoryObjects);
      const elementEvidence =
        row.matchedOrgElements.find((element) => element.kind === "paragraph")?.sourceRaw.trim() ??
        "";
      if (!primaryObject || !elementEvidence) return undefined;
      return {
        orgid: row.orgid,
        primaryKind: primaryObject.kind,
        claim: primaryObject.value,
        supportTerms: supportTermsFromElementEvidence(elementEvidence, primaryObject.value),
      };
    })
    .filter((row): row is ExpectedRecallFacts => row !== undefined);
  if (rows.length === 0) {
    throw new Error(
      "serverless memory recall benchmark requires at least one row with claim memory and paragraph org-element",
    );
  }
  return rows;
}

function primaryExpectedMemoryObject(
  objects: ServerlessMemoryRecallPacket["rows"][number]["memoryObjects"],
): { kind: string; value: string } | undefined {
  for (const kind of ["claim", "preference", "failure", "finality", "evidence"]) {
    const object = objects.find((candidate) => candidate.kind === kind);
    if (object?.value.trim()) return { kind: object.kind, value: object.value };
  }
  return undefined;
}

function scoreBenchmarkAnswer(
  answerText: string,
  expectedRows: ExpectedRecallFacts[],
  hasPromptError: boolean,
): Pick<
  ServerlessMemoryRecallBenchmarkVariantResult,
  | "passedClaim"
  | "passedSupportSummary"
  | "orgidHitCount"
  | "claimHitCount"
  | "claimRowCount"
  | "supportSummaryHitCount"
  | "rowResults"
  | "supportTermHits"
  | "supportTermThreshold"
> {
  const rowResults = expectedRows.map((expected) => {
    const supportHits = supportTermHits(answerText, expected.supportTerms);
    const threshold = supportTermThreshold(expected.supportTerms);
    return {
      orgid: expected.orgid,
      passedOrgid: !hasPromptError && answerText.includes(expected.orgid),
      passedClaim:
        !hasPromptError && answerText.includes(expected.orgid) && answerText.includes(expected.claim),
      passedSupportSummary: !hasPromptError && supportHits.length >= threshold,
      supportTermHits: supportHits,
      supportTermThreshold: threshold,
    };
  });
  return {
    passedClaim: rowResults[0]?.passedClaim ?? false,
    passedSupportSummary: rowResults[0]?.passedSupportSummary ?? false,
    orgidHitCount: rowResults.filter((row) => row.passedOrgid).length,
    claimHitCount: rowResults.filter((row) => row.passedClaim).length,
    claimRowCount: expectedRows.length,
    supportSummaryHitCount: rowResults.filter((row) => row.passedSupportSummary).length,
    rowResults,
    supportTermHits: rowResults[0]?.supportTermHits ?? [],
    supportTermThreshold: rowResults[0]?.supportTermThreshold ?? 0,
  };
}

function supportTermsFromElementEvidence(elementEvidence: string, claim: string): string[] {
  const claimWords = new Set(normalizedWords(claim));
  const terms: string[] = [];
  for (const word of normalizedWords(elementEvidence)) {
    if (claimWords.has(word) || SUPPORT_TERM_STOPWORDS.has(word)) continue;
    if (word.length < 5) continue;
    if (!terms.includes(word)) terms.push(word);
    if (terms.length >= 8) break;
  }
  return terms;
}

function supportTermHits(answerText: string, supportTerms: string[]): string[] {
  const answerWords = new Set(normalizedWords(answerText));
  return supportTerms.filter((term) => answerWords.has(term));
}

function supportTermThreshold(supportTerms: string[]): number {
  return Math.min(3, supportTerms.length);
}

function normalizedWords(value: string): string[] {
  return normalizeInlineText(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0);
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const SUPPORT_TERM_STOPWORDS = new Set([
  "about",
  "after",
  "already",
  "before",
  "being",
  "could",
  "from",
  "memory",
  "present",
  "source",
  "their",
  "there",
  "these",
  "through",
  "which",
  "while",
  "would",
]);

function collectAssistantEvidence(session: AgentSession): {
  getText: () => string;
  unsubscribe: () => void;
} {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      text = "";
    }
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      text += event.assistantMessageEvent.delta;
    }
  });
  return {
    getText: () => text,
    unsubscribe,
  };
}

function summarizeAssistantMessages(session: AgentSession): {
  text: string;
  count: number;
  roles: string[];
  stopReason?: string;
  errorMessage?: string;
} {
  const roles: string[] = [];
  let count = 0;
  let lastAssistant: Record<string, unknown> | undefined;
  for (const message of session.messages) {
    if (!isRecord(message)) continue;
    if (typeof message.role === "string") roles.push(message.role);
    if (message.role !== "assistant") continue;
    count += 1;
    lastAssistant = message;
  }
  if (!lastAssistant) {
    return {
      text: "",
      count,
      roles,
    };
  }
  const content = Array.isArray(lastAssistant.content) ? lastAssistant.content : [];
  const text = content
    .filter((block): block is { type: "text"; text: string } =>
      isRecord(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
  return {
    text,
    count,
    roles,
    stopReason:
      typeof lastAssistant.stopReason === "string" ? lastAssistant.stopReason : undefined,
    errorMessage:
      typeof lastAssistant.errorMessage === "string"
        ? lastAssistant.errorMessage
        : undefined,
  };
}

function redactBenchmark(
  result: ServerlessMemoryRecallBenchmarkResult,
): ServerlessMemoryRecallBenchmarkResult {
  return {
    ...result,
    variants: result.variants.map((variant) => ({
      ...variant,
      answerText: variant.answerText.slice(0, 2_000),
      streamedAnswerText: variant.streamedAnswerText.slice(0, 2_000),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
