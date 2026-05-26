import { writeFileSync } from "node:fs";
import {
  createAgentSessionFromServices,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { resolveModel } from "../model-resolver.js";
import type { PiWendaoThinkingLevel } from "../../executor/agent-runtime-types.js";
import {
  appendServerlessMemoryRecallPacket,
  readServerlessMemoryRecallPacketFile,
} from "./index.js";

export const SERVERLESS_MEMORY_RECALL_LIVE_TASK_PROMPT = [
  "Use only the Wendao memory recall already present in this session context.",
  "What does the recall say about the serverless recall path?",
  "Answer briefly in normal prose and keep the memory provenance visible when available.",
  "Do not invent facts outside the recall.",
].join("\n");

export interface ServerlessMemoryLiveRecallSmokeOptions {
  cwd: string;
  packetPath: ServerlessMemoryLiveRecallPacketPath;
  modelPattern: string;
  provider?: string;
  apiKey?: ServerlessMemoryLiveApiKey;
  thinkingLevel?: PiWendaoThinkingLevel;
  prompt?: string;
  evidencePath?: ServerlessMemoryLiveEvidencePath;
}

export type ServerlessMemoryLiveRecallPacketPath = string;
export type ServerlessMemoryLiveApiKey = string;
export type ServerlessMemoryLiveEvidencePath = string;

export interface ServerlessMemoryLiveRecallSmokeResult {
  passed: boolean;
  model: string;
  elapsedMs: number;
  answerText: string;
  streamedAnswerText: string;
  assistantMessageCount: number;
  sessionMessageRoles: string[];
  lastAssistantStopReason?: string;
  lastAssistantErrorMessage?: string;
  promptErrorMessage?: string;
  authSource?: string;
  authKeyFingerprint?: string;
  authHasHeaders?: boolean;
  recallEntryInjected: boolean;
  expectedOrgid: string;
  expectedClaim: string;
}

export async function runServerlessMemoryLiveRecallSmoke(
  options: ServerlessMemoryLiveRecallSmokeOptions,
): Promise<ServerlessMemoryLiveRecallSmokeResult> {
  const startedAt = Date.now();
  const packet = readServerlessMemoryRecallPacketFile(options.packetPath);
  const expectedRow = packet.rows[0];
  const expectedClaim =
    expectedRow?.memoryObjects.find((object) => object.kind === "claim")?.value ?? "";
  if (!expectedRow || !expectedClaim) {
    throw new Error("serverless memory live recall smoke requires one claim memory object");
  }

  const resolved = await resolveModel(
    options.modelPattern,
    options.provider,
    options.apiKey,
    [],
  );
  if (!resolved.apiKey && !resolved.headers) {
    throw new Error("serverless memory live recall smoke requires configured model auth");
  }
  if (resolved.apiKey) {
    resolved.services.authStorage.setRuntimeApiKey(
      resolved.model.provider,
      resolved.apiKey,
    );
  }

  const sessionManager = SessionManager.inMemory(options.cwd);
  const recallEntry = appendServerlessMemoryRecallPacket({
    sessionManager,
    packet,
  });
  const { session } = await createAgentSessionFromServices({
    services: resolved.services,
    sessionManager,
    model: resolved.model,
    thinkingLevel: options.thinkingLevel ?? "minimal",
    noTools: "all",
  });
  const capture = collectAssistantEvidence(session);
  try {
    let promptErrorMessage: string | undefined;
    try {
      await session.prompt(options.prompt ?? SERVERLESS_MEMORY_RECALL_LIVE_TASK_PROMPT, {
        expandPromptTemplates: false,
        source: "extension",
      });
    } catch (error) {
      promptErrorMessage = error instanceof Error ? error.message : String(error);
    }
    const assistantSummary = summarizeAssistantMessages(session);
    const streamedAnswerText = capture.getText().trim();
    const answerText = assistantSummary.text || streamedAnswerText;
    const result: ServerlessMemoryLiveRecallSmokeResult = {
      passed:
        !promptErrorMessage &&
        answerText.includes(expectedRow.orgid) &&
        answerText.includes(expectedClaim),
      model: `${resolved.model.provider}/${resolved.model.id}`,
      elapsedMs: Date.now() - startedAt,
      answerText,
      streamedAnswerText,
      assistantMessageCount: assistantSummary.count,
      sessionMessageRoles: assistantSummary.roles,
      lastAssistantStopReason: assistantSummary.stopReason,
      lastAssistantErrorMessage: assistantSummary.errorMessage,
      promptErrorMessage,
      authSource: resolved.auth?.source,
      authKeyFingerprint: resolved.auth?.keyFingerprint,
      authHasHeaders: resolved.auth?.hasHeaders,
      recallEntryInjected: Boolean(recallEntry.entryId),
      expectedOrgid: expectedRow.orgid,
      expectedClaim,
    };
    if (options.evidencePath) {
      writeFileSync(options.evidencePath, `${JSON.stringify(redactResult(result), null, 2)}\n`);
    }
    return result;
  } finally {
    capture.unsubscribe();
    session.dispose();
  }
}

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

function redactResult(
  result: ServerlessMemoryLiveRecallSmokeResult,
): ServerlessMemoryLiveRecallSmokeResult {
  return {
    ...result,
    answerText: result.answerText.slice(0, 2_000),
    streamedAnswerText: result.streamedAnswerText.slice(0, 2_000),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
