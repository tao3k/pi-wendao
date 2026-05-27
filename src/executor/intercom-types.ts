import type { PiWendaoAgentExecutionMetadata } from "./agent-host.js";

export interface PiWendaoIntercomSession {
  id: string;
  name?: string;
  cwd?: string;
  model?: string;
}

export interface PiWendaoIntercomAttachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export interface PiWendaoIntercomMessage {
  id: string;
  text: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  attachments?: PiWendaoIntercomAttachment[];
}

export interface PiWendaoIntercomExecutionRef extends PiWendaoAgentExecutionMetadata {
  activityId?: string;
}

export interface PiWendaoIntercomContext {
  from: PiWendaoIntercomSession;
  to?: PiWendaoIntercomSession;
  message: PiWendaoIntercomMessage;
  receivedAt: number;
  execution?: PiWendaoIntercomExecutionRef;
}

export type PiWendaoIntercomRecordDirection = "inbound" | "outbound";
export type PiWendaoIntercomRecordStatus = "sent" | "waiting" | "replied" | "expired" | "failed";

export interface PiWendaoIntercomRecord {
  key: string;
  direction: PiWendaoIntercomRecordDirection;
  status: PiWendaoIntercomRecordStatus;
  context: PiWendaoIntercomContext;
  reply?: PiWendaoIntercomMessage;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PiWendaoIntercomRecordStore {
  get(key: string): Promise<PiWendaoIntercomRecord | undefined>;
  put(record: PiWendaoIntercomRecord): Promise<void>;
  list(): Promise<PiWendaoIntercomRecord[]>;
  delete(key: string): Promise<void>;
}

export interface PiWendaoIntercomReplyTrackerOptions {
  askTimeoutMs?: number;
  initialPending?: PiWendaoIntercomContext[];
}

export interface ResolvePiWendaoIntercomReplyTargetOptions {
  replyTo?: string;
  to?: string;
  now?: number;
}

export interface PiWendaoIntercomStateOptions {
  self: PiWendaoIntercomSession;
  askTimeoutMs?: number;
  store?: PiWendaoIntercomRecordStore;
  now?: () => number;
}

export interface PiWendaoIntercomSendRequest {
  to: PiWendaoIntercomSession;
  text: string;
  messageId?: string;
  attachments?: PiWendaoIntercomAttachment[];
  execution?: PiWendaoIntercomExecutionRef;
  now?: number;
}

export interface PiWendaoIntercomReceiveAskRequest {
  from: PiWendaoIntercomSession;
  text: string;
  messageId?: string;
  attachments?: PiWendaoIntercomAttachment[];
  execution?: PiWendaoIntercomExecutionRef;
  now?: number;
}

export interface PiWendaoIntercomReplyRequest {
  text: string;
  replyTo?: string;
  to?: string;
  messageId?: string;
  attachments?: PiWendaoIntercomAttachment[];
  execution?: PiWendaoIntercomExecutionRef;
  now?: number;
}
