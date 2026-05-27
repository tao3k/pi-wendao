import type {
  AgentSession,
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { PiWendaoSubagentType } from "../types/domain.js";

export type NativeSubagentStatus = "queued" | "running" | "completed" | "failed" | "stopped";

export interface NativeSubagentInvocation {
  modelName?: string;
  thinking?: string;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  runInBackground?: boolean;
}

export interface NativeSubagentSpawnRequest {
  prompt: string;
  description: string;
  subagent_type: PiWendaoSubagentType;
  run_in_background?: boolean;
  model?: string;
  thinking?: string;
  max_turns?: number;
  isolated?: boolean;
  isolation?: string;
  inherit_context?: boolean;
  resume?: string;
}

export interface NativeSubagentGetResultRequest {
  agent_id: string;
  wait?: boolean;
  verbose?: boolean;
}

export interface NativeSubagentSteerRequest {
  agent_id: string;
  message: string;
}

export interface NativeSubagentToolResultDetails {
  agentId?: string;
  status?: NativeSubagentStatus | "background";
  description?: string;
  subagentType?: PiWendaoSubagentType;
  toolUses?: number;
  turnCount?: number;
  maxTurns?: number;
  modelName?: string;
  durationMs?: number;
  error?: string;
}

export interface NativeSubagentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: NativeSubagentToolResultDetails;
  isError?: boolean;
}

export interface NativeSubagentRecord {
  id: string;
  description: string;
  type: PiWendaoSubagentType;
  prompt: string;
  status: NativeSubagentStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  modelName?: string;
  invocation: NativeSubagentInvocation;
  session?: AgentSession;
  promise?: Promise<string>;
  abortController: AbortController;
}

export interface NativeSubagentRunOptions {
  ctx: ExtensionContext;
  model?: Model<any>;
  modelRegistry: ModelRegistry;
  signal?: AbortSignal;
  onToolActivity?: (activity: { type: "start" | "end"; toolName: string }) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onTurnEnd?: (turnCount: number) => void;
  onSessionCreated?: (session: AgentSession) => void;
}

export function textResult(
  text: string,
  details?: NativeSubagentToolResultDetails,
  isError = false,
): NativeSubagentToolResult {
  return {
    content: [{ type: "text", text }],
    details: details ?? {},
    ...(isError ? { isError: true } : {}),
  };
}
