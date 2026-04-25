import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SkillscAgentExecutionMetadata } from "./agent-host.js";

export const DEFAULT_SKILLSC_INTERCOM_ASK_TIMEOUT_MS = 10 * 60 * 1000;

export interface SkillscIntercomSession {
	id: string;
	name?: string;
	cwd?: string;
	model?: string;
}

export interface SkillscIntercomAttachment {
	type: "file" | "snippet" | "context";
	name: string;
	content: string;
	language?: string;
}

export interface SkillscIntercomMessage {
	id: string;
	text: string;
	timestamp: number;
	replyTo?: string;
	expectsReply?: boolean;
	attachments?: SkillscIntercomAttachment[];
}

export interface SkillscIntercomExecutionRef extends SkillscAgentExecutionMetadata {
	activityId?: string;
}

export interface SkillscIntercomContext {
	from: SkillscIntercomSession;
	to?: SkillscIntercomSession;
	message: SkillscIntercomMessage;
	receivedAt: number;
	execution?: SkillscIntercomExecutionRef;
}

export type SkillscIntercomRecordDirection = "inbound" | "outbound";
export type SkillscIntercomRecordStatus = "sent" | "waiting" | "replied" | "expired" | "failed";

export interface SkillscIntercomRecord {
	key: string;
	direction: SkillscIntercomRecordDirection;
	status: SkillscIntercomRecordStatus;
	context: SkillscIntercomContext;
	reply?: SkillscIntercomMessage;
	error?: string;
	createdAt: string;
	updatedAt: string;
}

export interface SkillscIntercomRecordStore {
	get(key: string): Promise<SkillscIntercomRecord | undefined>;
	put(record: SkillscIntercomRecord): Promise<void>;
	list(): Promise<SkillscIntercomRecord[]>;
	delete(key: string): Promise<void>;
}

export interface SkillscIntercomReplyTrackerOptions {
	askTimeoutMs?: number;
	initialPending?: SkillscIntercomContext[];
}

export interface ResolveSkillscIntercomReplyTargetOptions {
	replyTo?: string;
	to?: string;
	now?: number;
}

export interface SkillscIntercomStateOptions {
	self: SkillscIntercomSession;
	askTimeoutMs?: number;
	store?: SkillscIntercomRecordStore;
	now?: () => number;
}

export interface SkillscIntercomSendRequest {
	to: SkillscIntercomSession;
	text: string;
	messageId?: string;
	attachments?: SkillscIntercomAttachment[];
	execution?: SkillscIntercomExecutionRef;
	now?: number;
}

export interface SkillscIntercomReceiveAskRequest {
	from: SkillscIntercomSession;
	text: string;
	messageId?: string;
	attachments?: SkillscIntercomAttachment[];
	execution?: SkillscIntercomExecutionRef;
	now?: number;
}

export interface SkillscIntercomReplyRequest {
	text: string;
	replyTo?: string;
	to?: string;
	messageId?: string;
	attachments?: SkillscIntercomAttachment[];
	execution?: SkillscIntercomExecutionRef;
	now?: number;
}

export class SkillscIntercomReplyTracker {
	private readonly askTimeoutMs: number;
	private readonly pendingAsks = new Map<string, SkillscIntercomContext>();
	private readonly turnQueue: SkillscIntercomContext[] = [];
	private currentTurnContext: SkillscIntercomContext | undefined;

	constructor(options: SkillscIntercomReplyTrackerOptions = {}) {
		this.askTimeoutMs = options.askTimeoutMs ?? DEFAULT_SKILLSC_INTERCOM_ASK_TIMEOUT_MS;
		for (const context of options.initialPending ?? []) {
			this.recordIncomingAsk(context);
		}
	}

	recordIncomingAsk(context: SkillscIntercomContext): SkillscIntercomContext {
		const normalized = normalizeIntercomContext(context);
		this.pendingAsks.set(normalized.message.id, normalized);
		return normalized;
	}

	queueTurnContext(context: SkillscIntercomContext): void {
		const normalized = this.recordIncomingAsk(context);
		this.turnQueue.push(normalized);
	}

	beginTurn(now = Date.now()): SkillscIntercomContext | undefined {
		this.pruneExpired(now);
		this.currentTurnContext = this.turnQueue.shift();
		return this.currentTurnContext;
	}

	endTurn(): void {
		this.currentTurnContext = undefined;
	}

	resolveReplyTarget(
		options: ResolveSkillscIntercomReplyTargetOptions = {},
	): SkillscIntercomContext {
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
			throw new Error(options.to
				? `No pending ask found from ${options.to}`
				: "No pending asks");
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

	listPending(now = Date.now()): SkillscIntercomContext[] {
		this.pruneExpired(now);
		return Array.from(this.pendingAsks.values())
			.sort((a, b) => a.receivedAt - b.receivedAt || a.message.id.localeCompare(b.message.id));
	}

	pruneExpired(now = Date.now()): SkillscIntercomContext[] {
		const expired: SkillscIntercomContext[] = [];
		for (const [messageId, context] of this.pendingAsks.entries()) {
			if (isExpired(context, now, this.askTimeoutMs)) {
				this.pendingAsks.delete(messageId);
				expired.push(context);
			}
		}
		if (
			this.currentTurnContext
			&& !this.pendingAsks.has(this.currentTurnContext.message.id)
		) {
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

export class SkillscIntercomCorrelationState {
	private readonly self: SkillscIntercomSession;
	private readonly store: SkillscIntercomRecordStore | undefined;
	private readonly now: () => number;
	private readonly tracker: SkillscIntercomReplyTracker;

	constructor(options: SkillscIntercomStateOptions) {
		this.self = options.self;
		this.store = options.store;
		this.now = options.now ?? Date.now;
		this.tracker = new SkillscIntercomReplyTracker({
			askTimeoutMs: options.askTimeoutMs,
		});
	}

	async send(request: SkillscIntercomSendRequest): Promise<SkillscIntercomRecord> {
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

	async ask(request: SkillscIntercomSendRequest): Promise<SkillscIntercomRecord> {
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

	async receiveAsk(request: SkillscIntercomReceiveAskRequest): Promise<SkillscIntercomRecord> {
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

	async reply(request: SkillscIntercomReplyRequest): Promise<SkillscIntercomRecord> {
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

	async pending(now = this.now()): Promise<SkillscIntercomContext[]> {
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

	async markRecordReplied(
		key: string,
		reply: SkillscIntercomMessage,
		now = this.now(),
	): Promise<SkillscIntercomRecord | undefined> {
		const previous = this.store ? await this.store.get(key) : undefined;
		if (!previous) return undefined;
		const record: SkillscIntercomRecord = {
			...previous,
			status: "replied",
			reply,
			updatedAt: isoFromMillis(now),
		};
		await this.store?.put(record);
		return record;
	}

	async markRecordFailed(
		key: string,
		error: string,
		now = this.now(),
	): Promise<SkillscIntercomRecord | undefined> {
		const previous = this.store ? await this.store.get(key) : undefined;
		if (!previous) return undefined;
		const record: SkillscIntercomRecord = {
			...previous,
			status: "failed",
			error,
			updatedAt: isoFromMillis(now),
		};
		await this.store?.put(record);
		return record;
	}

	private async writeRecord(options: {
		direction: SkillscIntercomRecordDirection;
		status: SkillscIntercomRecordStatus;
		context: SkillscIntercomContext;
		now: number;
	}): Promise<SkillscIntercomRecord> {
		const record: SkillscIntercomRecord = {
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

export function createInMemorySkillscIntercomRecordStore(
	initialRecords: SkillscIntercomRecord[] = [],
): SkillscIntercomRecordStore {
	const records = new Map(initialRecords.map((record) => [record.key, record]));
	return {
		async get(key) {
			return records.get(key);
		},
		async put(record) {
			records.set(record.key, record);
		},
		async list() {
			return Array.from(records.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		},
		async delete(key) {
			records.delete(key);
		},
	};
}

export function createJsonFileSkillscIntercomRecordStore(path: string): SkillscIntercomRecordStore {
	let queue = Promise.resolve();
	const withLock = async <T>(operation: () => Promise<T>): Promise<T> => {
		const next = queue.then(operation, operation);
		queue = next.then(() => undefined, () => undefined);
		return next;
	};
	return {
		get: (key) => withLock(async () => {
			const records = await readStoreFile(path);
			return records[key];
		}),
		put: (record) => withLock(async () => {
			const records = await readStoreFile(path);
			records[record.key] = record;
			await writeStoreFile(path, records);
		}),
		list: () => withLock(async () => Object.values(await readStoreFile(path))
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt))),
		delete: (key) => withLock(async () => {
			const records = await readStoreFile(path);
			delete records[key];
			await writeStoreFile(path, records);
		}),
	};
}

export function buildSkillscIntercomCorrelationKey(
	execution: SkillscIntercomExecutionRef | undefined,
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
	attachments?: SkillscIntercomAttachment[];
	timestamp: number;
	replyTo?: string;
	expectsReply?: boolean;
}): SkillscIntercomMessage {
	return {
		id: options.messageId ?? randomUUID(),
		text: options.text,
		timestamp: options.timestamp,
		...(options.replyTo ? { replyTo: options.replyTo } : {}),
		...(options.expectsReply === undefined ? {} : { expectsReply: options.expectsReply }),
		...(options.attachments ? { attachments: options.attachments } : {}),
	};
}

function normalizeIntercomContext(context: SkillscIntercomContext): SkillscIntercomContext {
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

function recordKey(context: SkillscIntercomContext): string {
	return buildSkillscIntercomCorrelationKey(context.execution, context.message.id)
		?? context.message.id;
}

function isExpired(
	context: SkillscIntercomContext,
	now: number,
	askTimeoutMs: number,
): boolean {
	return askTimeoutMs >= 0 && now - context.receivedAt > askTimeoutMs;
}

function matchesSession(session: SkillscIntercomSession, target: string): boolean {
	return session.id === target || session.name === target;
}

function isoFromMillis(value: number): string {
	return new Date(value).toISOString();
}

interface SkillscIntercomRecordStoreFile {
	version: 1;
	records: Record<string, SkillscIntercomRecord>;
}

async function readStoreFile(path: string): Promise<Record<string, SkillscIntercomRecord>> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
		if (!isRecordStoreFile(parsed)) return {};
		return parsed.records;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return {};
		throw error;
	}
}

async function writeStoreFile(
	path: string,
	records: Record<string, SkillscIntercomRecord>,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const file: SkillscIntercomRecordStoreFile = { version: 1, records };
	await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
	await rename(tempPath, path);
}

function isRecordStoreFile(value: unknown): value is SkillscIntercomRecordStoreFile {
	return typeof value === "object"
		&& value !== null
		&& !Array.isArray(value)
		&& (value as { version?: unknown }).version === 1
		&& typeof (value as { records?: unknown }).records === "object"
		&& (value as { records?: unknown }).records !== null
		&& !Array.isArray((value as { records?: unknown }).records);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error;
}
