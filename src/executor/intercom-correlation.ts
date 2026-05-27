import { randomUUID } from "node:crypto";
import type { Effect } from "effect";
import { effectFromPromise, type PiWendaoEffectError } from "../effect.js";
import type {
  PiWendaoIntercomAttachment,
  PiWendaoIntercomContext,
  PiWendaoIntercomExecutionRef,
  PiWendaoIntercomMessage,
  PiWendaoIntercomReceiveAskRequest,
  PiWendaoIntercomRecord,
  PiWendaoIntercomRecordDirection,
  PiWendaoIntercomRecordStatus,
  PiWendaoIntercomRecordStore,
  PiWendaoIntercomReplyRequest,
  PiWendaoIntercomReplyTrackerOptions,
  PiWendaoIntercomSendRequest,
  PiWendaoIntercomSession,
  PiWendaoIntercomStateOptions,
  ResolvePiWendaoIntercomReplyTargetOptions,
} from "./intercom-types.js";

export const DEFAULT_PI_WENDAO_INTERCOM_ASK_TIMEOUT_MS = 10 * 60 * 1000;

export class PiWendaoIntercomReplyTracker {
  private readonly askTimeoutMs: number;
  private readonly pendingAsks = new Map<string, PiWendaoIntercomContext>();
  private readonly turnQueue: PiWendaoIntercomContext[] = [];
  private currentTurnContext: PiWendaoIntercomContext | undefined;

  constructor(options: PiWendaoIntercomReplyTrackerOptions = {}) {
    this.askTimeoutMs = options.askTimeoutMs ?? DEFAULT_PI_WENDAO_INTERCOM_ASK_TIMEOUT_MS;
    for (const context of options.initialPending ?? []) {
      this.recordIncomingAsk(context);
    }
  }

  recordIncomingAsk(context: PiWendaoIntercomContext): PiWendaoIntercomContext {
    const normalized = normalizeIntercomContext(context);
    this.pendingAsks.set(normalized.message.id, normalized);
    return normalized;
  }

  queueTurnContext(context: PiWendaoIntercomContext): void {
    const normalized = this.recordIncomingAsk(context);
    this.turnQueue.push(normalized);
  }

  beginTurn(now = Date.now()): PiWendaoIntercomContext | undefined {
    this.pruneExpired(now);
    this.currentTurnContext = this.turnQueue.shift();
    return this.currentTurnContext;
  }

  endTurn(): void {
    this.currentTurnContext = undefined;
  }

  resolveReplyTarget(
    options: ResolvePiWendaoIntercomReplyTargetOptions = {},
  ): PiWendaoIntercomContext {
    const now = options.now ?? Date.now();
    this.pruneExpired(now);

    if (options.replyTo) {
      const explicit = this.pendingAsks.get(options.replyTo);
      if (!explicit) {
        throw new Error(`No pending ask found for replyTo ${options.replyTo}`);
      }
      if (options.to && !matchesSession(explicit.from, options.to)) {
        throw new Error(`Pending ask ${options.replyTo} does not match ${options.to}`);
      }
      return explicit;
    }

    if (this.currentTurnContext && this.pendingAsks.has(this.currentTurnContext.message.id)) {
      if (!options.to || matchesSession(this.currentTurnContext.from, options.to)) {
        return this.currentTurnContext;
      }
    }

    const pending = this.listPending(now);
    const candidates = options.to
      ? pending.filter((context) => matchesSession(context.from, options.to!))
      : pending;

    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length === 0) {
      throw new Error(options.to ? `No pending ask found from ${options.to}` : "No pending asks");
    }
    throw new Error("Multiple pending asks; specify replyTo or to");
  }

  markReplied(replyTo: string): boolean {
    const deleted = this.pendingAsks.delete(replyTo);
    if (this.currentTurnContext?.message.id === replyTo) {
      this.currentTurnContext = undefined;
    }
    return deleted;
  }

  listPending(now = Date.now()): PiWendaoIntercomContext[] {
    this.pruneExpired(now);
    return Array.from(this.pendingAsks.values()).sort(
      (a, b) => a.receivedAt - b.receivedAt || a.message.id.localeCompare(b.message.id),
    );
  }

  pruneExpired(now = Date.now()): PiWendaoIntercomContext[] {
    const expired: PiWendaoIntercomContext[] = [];
    for (const [messageId, context] of this.pendingAsks.entries()) {
      if (isExpired(context, now, this.askTimeoutMs)) {
        this.pendingAsks.delete(messageId);
        expired.push(context);
      }
    }
    if (this.currentTurnContext && !this.pendingAsks.has(this.currentTurnContext.message.id)) {
      this.currentTurnContext = undefined;
    }
    return expired;
  }

  reset(): void {
    this.pendingAsks.clear();
    this.turnQueue.splice(0);
    this.currentTurnContext = undefined;
  }
}

export class PiWendaoIntercomCorrelationState {
  private readonly self: PiWendaoIntercomSession;
  private readonly store: PiWendaoIntercomRecordStore | undefined;
  private readonly now: () => number;
  private readonly tracker: PiWendaoIntercomReplyTracker;

  constructor(options: PiWendaoIntercomStateOptions) {
    this.self = options.self;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.tracker = new PiWendaoIntercomReplyTracker({
      askTimeoutMs: options.askTimeoutMs,
    });
  }

  send(
    request: PiWendaoIntercomSendRequest,
  ): Effect.Effect<PiWendaoIntercomRecord, PiWendaoEffectError> {
    return effectFromPromise("PiWendaoIntercomCorrelationState.send", () =>
      this.sendPromise(request),
    );
  }

  private async sendPromise(request: PiWendaoIntercomSendRequest): Promise<PiWendaoIntercomRecord> {
    const now = request.now ?? this.now();
    return this.writeRecord({
      direction: "outbound",
      status: "sent",
      context: {
        from: this.self,
        to: request.to,
        message: createMessage({
          text: request.text,
          messageId: request.messageId,
          attachments: request.attachments,
          timestamp: now,
        }),
        receivedAt: now,
        execution: request.execution,
      },
      now,
    });
  }

  ask(
    request: PiWendaoIntercomSendRequest,
  ): Effect.Effect<PiWendaoIntercomRecord, PiWendaoEffectError> {
    return effectFromPromise("PiWendaoIntercomCorrelationState.ask", () =>
      this.askPromise(request),
    );
  }

  private async askPromise(request: PiWendaoIntercomSendRequest): Promise<PiWendaoIntercomRecord> {
    const now = request.now ?? this.now();
    return this.writeRecord({
      direction: "outbound",
      status: "waiting",
      context: {
        from: this.self,
        to: request.to,
        message: createMessage({
          text: request.text,
          messageId: request.messageId,
          attachments: request.attachments,
          timestamp: now,
          expectsReply: true,
        }),
        receivedAt: now,
        execution: request.execution,
      },
      now,
    });
  }

  receiveAsk(
    request: PiWendaoIntercomReceiveAskRequest,
  ): Effect.Effect<PiWendaoIntercomRecord, PiWendaoEffectError> {
    return effectFromPromise("PiWendaoIntercomCorrelationState.receiveAsk", () =>
      this.receiveAskPromise(request),
    );
  }

  private async receiveAskPromise(
    request: PiWendaoIntercomReceiveAskRequest,
  ): Promise<PiWendaoIntercomRecord> {
    const now = request.now ?? this.now();
    const context = this.tracker.recordIncomingAsk({
      from: request.from,
      to: this.self,
      message: createMessage({
        text: request.text,
        messageId: request.messageId,
        attachments: request.attachments,
        timestamp: now,
        expectsReply: true,
      }),
      receivedAt: now,
      execution: request.execution,
    });
    return this.writeRecord({
      direction: "inbound",
      status: "waiting",
      context,
      now,
    });
  }

  reply(
    request: PiWendaoIntercomReplyRequest,
  ): Effect.Effect<PiWendaoIntercomRecord, PiWendaoEffectError> {
    return effectFromPromise("PiWendaoIntercomCorrelationState.reply", () =>
      this.replyPromise(request),
    );
  }

  private async replyPromise(
    request: PiWendaoIntercomReplyRequest,
  ): Promise<PiWendaoIntercomRecord> {
    const now = request.now ?? this.now();
    const target = this.tracker.resolveReplyTarget({
      replyTo: request.replyTo,
      to: request.to,
      now,
    });
    const reply = createMessage({
      text: request.text,
      messageId: request.messageId,
      attachments: request.attachments,
      timestamp: now,
      replyTo: target.message.id,
    });
    this.tracker.markReplied(target.message.id);

    const targetKey = recordKey(target);
    const previous = this.store ? await this.store.get(targetKey) : undefined;
    if (this.store) {
      await this.store.put({
        ...previous,
        key: targetKey,
        direction: previous?.direction ?? "inbound",
        status: "replied",
        context: previous?.context ?? target,
        reply,
        createdAt: previous?.createdAt ?? isoFromMillis(target.receivedAt),
        updatedAt: isoFromMillis(now),
      });
    }

    return this.writeRecord({
      direction: "outbound",
      status: "sent",
      context: {
        from: this.self,
        to: target.from,
        message: reply,
        receivedAt: now,
        execution: request.execution ?? target.execution,
      },
      now,
    });
  }

  pending(now = this.now()): Effect.Effect<PiWendaoIntercomContext[], PiWendaoEffectError> {
    return effectFromPromise("PiWendaoIntercomCorrelationState.pending", () =>
      this.pendingPromise(now),
    );
  }

  private async pendingPromise(now = this.now()): Promise<PiWendaoIntercomContext[]> {
    const expired = this.tracker.pruneExpired(now);
    if (this.store) {
      for (const context of expired) {
        const key = recordKey(context);
        const previous = await this.store.get(key);
        if (previous) {
          await this.store.put({
            ...previous,
            status: "expired",
            updatedAt: isoFromMillis(now),
          });
        }
      }
    }
    return this.tracker.listPending(now);
  }

  markRecordReplied(
    key: string,
    reply: PiWendaoIntercomMessage,
    now = this.now(),
  ): Effect.Effect<PiWendaoIntercomRecord | undefined, PiWendaoEffectError> {
    return effectFromPromise("PiWendaoIntercomCorrelationState.markRecordReplied", () =>
      this.markRecordRepliedPromise(key, reply, now),
    );
  }

  private async markRecordRepliedPromise(
    key: string,
    reply: PiWendaoIntercomMessage,
    now = this.now(),
  ): Promise<PiWendaoIntercomRecord | undefined> {
    const previous = this.store ? await this.store.get(key) : undefined;
    if (!previous) return undefined;
    const record: PiWendaoIntercomRecord = {
      ...previous,
      status: "replied",
      reply,
      updatedAt: isoFromMillis(now),
    };
    await this.store?.put(record);
    return record;
  }

  markRecordFailed(
    key: string,
    error: string,
    now = this.now(),
  ): Effect.Effect<PiWendaoIntercomRecord | undefined, PiWendaoEffectError> {
    return effectFromPromise("PiWendaoIntercomCorrelationState.markRecordFailed", () =>
      this.markRecordFailedPromise(key, error, now),
    );
  }

  private async markRecordFailedPromise(
    key: string,
    error: string,
    now = this.now(),
  ): Promise<PiWendaoIntercomRecord | undefined> {
    const previous = this.store ? await this.store.get(key) : undefined;
    if (!previous) return undefined;
    const record: PiWendaoIntercomRecord = {
      ...previous,
      status: "failed",
      error,
      updatedAt: isoFromMillis(now),
    };
    await this.store?.put(record);
    return record;
  }

  private async writeRecord(options: {
    direction: PiWendaoIntercomRecordDirection;
    status: PiWendaoIntercomRecordStatus;
    context: PiWendaoIntercomContext;
    now: number;
  }): Promise<PiWendaoIntercomRecord> {
    const record: PiWendaoIntercomRecord = {
      key: recordKey(options.context),
      direction: options.direction,
      status: options.status,
      context: options.context,
      createdAt: isoFromMillis(options.now),
      updatedAt: isoFromMillis(options.now),
    };
    await this.store?.put(record);
    return record;
  }
}

export {
  createInMemoryPiWendaoIntercomRecordStore,
  createJsonFilePiWendaoIntercomRecordStore,
} from "./intercom-record-store.js";
export type {
  PiWendaoIntercomAttachment,
  PiWendaoIntercomContext,
  PiWendaoIntercomExecutionRef,
  PiWendaoIntercomMessage,
  PiWendaoIntercomReceiveAskRequest,
  PiWendaoIntercomRecord,
  PiWendaoIntercomRecordDirection,
  PiWendaoIntercomRecordStatus,
  PiWendaoIntercomRecordStore,
  PiWendaoIntercomReplyRequest,
  PiWendaoIntercomReplyTrackerOptions,
  PiWendaoIntercomSendRequest,
  PiWendaoIntercomSession,
  PiWendaoIntercomStateOptions,
  ResolvePiWendaoIntercomReplyTargetOptions,
} from "./intercom-types.js";

export function buildPiWendaoIntercomCorrelationKey(
  execution: PiWendaoIntercomExecutionRef | undefined,
  messageId: string,
): string | undefined {
  const instanceId = execution?.instanceId;
  if (!instanceId || !messageId) return undefined;
  return JSON.stringify({
    instanceId,
    processId: execution.processId ?? null,
    activityId: execution.activityId ?? null,
    tokenId: execution.tokenId ?? null,
    messageId,
  });
}

function createMessage(options: {
  text: string;
  messageId?: string;
  attachments?: PiWendaoIntercomAttachment[];
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
}): PiWendaoIntercomMessage {
  return {
    id: options.messageId ?? randomUUID(),
    text: options.text,
    timestamp: options.timestamp,
    ...(options.replyTo ? { replyTo: options.replyTo } : {}),
    ...(options.expectsReply === undefined ? {} : { expectsReply: options.expectsReply }),
    ...(options.attachments ? { attachments: options.attachments } : {}),
  };
}

function normalizeIntercomContext(context: PiWendaoIntercomContext): PiWendaoIntercomContext {
  const receivedAt = context.receivedAt;
  return {
    ...context,
    message: {
      ...context.message,
      timestamp: context.message.timestamp || receivedAt,
      expectsReply: context.message.expectsReply ?? true,
    },
  };
}

function recordKey(context: PiWendaoIntercomContext): string {
  return (
    buildPiWendaoIntercomCorrelationKey(context.execution, context.message.id) ?? context.message.id
  );
}

function isExpired(context: PiWendaoIntercomContext, now: number, askTimeoutMs: number): boolean {
  return askTimeoutMs >= 0 && now - context.receivedAt > askTimeoutMs;
}

function matchesSession(session: PiWendaoIntercomSession, target: string): boolean {
  return session.id === target || session.name === target;
}

function isoFromMillis(value: number): string {
  return new Date(value).toISOString();
}
