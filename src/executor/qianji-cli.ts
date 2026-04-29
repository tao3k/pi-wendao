import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  PiWendaoHostWorkKind,
  PiWendaoQianjiCheckpointFeedback,
} from "./agent-host.js";
import { isObject } from "./data.js";
import { WorkflowInterruptedError, throwIfWorkflowInterrupted } from "./interrupt.js";
import { isQianjiTraceEvent } from "./qianji-report.js";
import type {
  QianjiCliResult,
  QianjiHostWork,
  QianjiHumanTaskAssignment,
  QianjiHumanTaskChoice,
  QianjiHumanTaskForm,
  QianjiHumanTaskFreeText,
  QianjiHumanTaskResourceRole,
  QianjiTraceEvent,
} from "./qianji-types.js";

export function buildQianjiArgs(options: {
  sourcePath: string;
  processId: string;
  instanceId: string;
  context: Record<string, unknown>;
  dmnPaths: string[];
  hostFixturePath?: string;
  eventFixturePath?: string;
  traceStream: boolean;
  externalHost: boolean;
  continueUntilHumanBoundary?: boolean;
  startAtNode?: string;
}): string[] {
  const args = [
    "bpmn",
    options.startAtNode ? "start-at" : "run",
    "--bpmn",
    options.sourcePath,
    "--process",
    options.processId,
    "--instance-id",
    options.instanceId,
    "--context-json",
    JSON.stringify(options.context),
  ];
  if (options.startAtNode) {
    args.push("--node", options.startAtNode);
  }
  for (const dmnPath of options.dmnPaths) {
    args.push("--dmn", dmnPath);
  }
  if (options.hostFixturePath) {
    args.push("--host-fixture", options.hostFixturePath);
  }
  if (options.eventFixturePath) {
    args.push("--event-fixture", options.eventFixturePath);
  }
  if (options.traceStream) {
    args.push("--trace-stream");
  }
  if (options.externalHost) {
    args.push("--external-host");
  }
  if (options.continueUntilHumanBoundary) {
    args.push("--continue-until-human-boundary");
  }
  return args;
}

export function buildQianjiHostSessionArgs(options: {
  sourcePath: string;
  processId: string;
  instanceId: string;
  context: Record<string, unknown>;
  dmnPaths: string[];
  hostFixturePath?: string;
  eventFixturePath?: string;
  traceStream: boolean;
  startAtNode?: string;
}): string[] {
  const args = [
    "bpmn",
    "host-session",
    "--bpmn",
    options.sourcePath,
    "--process",
    options.processId,
    "--instance-id",
    options.instanceId,
    "--context-json",
    JSON.stringify(options.context),
  ];
  if (options.startAtNode) {
    args.push("--node", options.startAtNode);
  }
  for (const dmnPath of options.dmnPaths) {
    args.push("--dmn", dmnPath);
  }
  if (options.hostFixturePath) {
    args.push("--host-fixture", options.hostFixturePath);
  }
  if (options.eventFixturePath) {
    args.push("--event-fixture", options.eventFixturePath);
  }
  if (options.traceStream) {
    args.push("--trace-stream");
  }
  return args;
}

export function buildQianjiHostSessionTaskCompleteRequest(options: {
  completion: {
    tokenId: number;
    processId: string;
    activityId: string;
    kind: PiWendaoHostWorkKind;
    data: Record<string, unknown>;
    claimant?: string;
  };
  continueUntilHumanBoundary?: boolean;
}): Record<string, unknown> {
  return {
    type: "task_complete",
    token_id: options.completion.tokenId,
    process_id: options.completion.processId,
    activity_id: options.completion.activityId,
    kind: qianjiTaskCompleteKind(options.completion.kind),
    data: options.completion.data,
    ...(options.completion.claimant ? { claimant: options.completion.claimant } : {}),
    continue_until_human_boundary: options.continueUntilHumanBoundary ?? true,
  };
}

function qianjiTaskCompleteKind(kind: PiWendaoHostWorkKind): string {
  if (kind === "business_rule") {
    throw new Error("qianji typed task completion does not support business_rule payloads yet");
  }
  return kind;
}

export function buildQianjiStatusArgs(options: {
  sourcePath: string;
  instanceId: string;
  dmnPaths: string[];
}): string[] {
  const args = [
    "bpmn",
    "status",
    "--instance-id",
    options.instanceId,
    "--bpmn",
    options.sourcePath,
  ];
  for (const dmnPath of options.dmnPaths) {
    args.push("--dmn", dmnPath);
  }
  return args;
}

export function runQianjiCli(
  command: string,
  args: string[],
  cwd: string,
  onTraceEvent: (event: QianjiTraceEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<QianjiCliResult> {
  throwIfWorkflowInterrupted(signal);
  const commandLine = [command, ...args.map(shellQuote)].join(" ");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandLine, {
      cwd,
      shell: true,
      env: process.env,
    });
    let closed = false;
    const abort = () => {
      terminateChild(child, () => closed);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let streamedTrace = false;
    const hostWork: QianjiHostWork[] = [];
    let traceQueue = Promise.resolve();
    let traceError: unknown;
    const enqueueTraceEvent = (event: QianjiTraceEvent): void => {
      traceQueue = traceQueue
        .then(async () => {
          if (traceError) return;
          await onTraceEvent(event);
        })
        .catch((err: unknown) => {
          traceError = err;
        });
    };

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      const consumed = consumeQianjiStdoutChunk(stdoutLineBuffer + chunk, enqueueTraceEvent);
      stdout += consumed.visibleOutput;
      stdoutLineBuffer = consumed.remainder;
      streamedTrace ||= consumed.streamedTrace;
      hostWork.push(...consumed.hostWork);
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(signal?.aborted ? new WorkflowInterruptedError() : error);
    });
    child.on("close", async (exitCode) => {
      closed = true;
      signal?.removeEventListener("abort", abort);
      try {
        if (signal?.aborted) {
          reject(new WorkflowInterruptedError());
          return;
        }
        if (stdoutLineBuffer) {
          const consumed = consumeQianjiStdoutChunk(`${stdoutLineBuffer}\n`, enqueueTraceEvent);
          stdout += consumed.visibleOutput.replace(/\n$/, "");
          streamedTrace ||= consumed.streamedTrace;
          hostWork.push(...consumed.hostWork);
        }
        await traceQueue;
        if (traceError) {
          reject(traceError);
          return;
        }
        resolvePromise({ exitCode, stdout, stderr, streamedTrace, hostWork });
      } catch (err) {
        reject(err);
      }
    });
  });
}

export class QianjiHostSession {
  readonly initial: Promise<QianjiCliResult>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly signal?: AbortSignal;
  private closed = false;
  private closing = false;
  private stdoutLineBuffer = "";
  private currentStdout = "";
  private currentStderr = "";
  private currentStreamedTrace = false;
  private currentHostWork: QianjiHostWork[] = [];
  private readonly waiters: Array<{
    resolve: (result: QianjiCliResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  private traceQueue = Promise.resolve();
  private traceError: unknown;

  constructor(
    command: string,
    args: string[],
    cwd: string,
    private readonly onTraceEvent: (event: QianjiTraceEvent) => void | Promise<void>,
    signal?: AbortSignal,
  ) {
    throwIfWorkflowInterrupted(signal);
    this.signal = signal;
    const commandLine = [command, ...args.map(shellQuote)].join(" ");
    this.child = spawn(commandLine, {
      cwd,
      shell: true,
      env: process.env,
    });
    this.child.stdout.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk: string) => this.consumeStdout(chunk));
    this.child.stderr.setEncoding("utf-8");
    this.child.stderr.on("data", (chunk: string) => {
      this.currentStderr += chunk;
    });
    this.child.stdin.on("error", (error) => {
      if (isBrokenPipeError(error)) {
        if (!this.closing) {
          this.rejectAll(signal?.aborted ? new WorkflowInterruptedError() : error);
        }
        return;
      }
      this.rejectAll(signal?.aborted ? new WorkflowInterruptedError() : error);
    });
    this.child.on("error", (error) => {
      this.rejectAll(signal?.aborted ? new WorkflowInterruptedError() : error);
    });
    this.child.on("close", (exitCode) => {
      this.closed = true;
      signal?.removeEventListener("abort", this.abort);
      if (this.stdoutLineBuffer) {
        this.consumeStdout(`${this.stdoutLineBuffer}\n`);
        this.stdoutLineBuffer = "";
      }
      if (this.waiters.length > 0) {
        const message =
          this.currentStderr.trim() ||
          this.currentStdout.trim() ||
          `qianji host-session exited before result marker with code ${exitCode}`;
        this.rejectAll(signal?.aborted ? new WorkflowInterruptedError() : new Error(message));
      }
    });
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
    this.initial = this.nextResult();
  }

  taskComplete(request: Record<string, unknown>): Promise<QianjiCliResult> {
    throwIfWorkflowInterrupted(this.signal);
    if (this.closed) {
      throw new Error("qianji host-session is already closed");
    }
    const result = this.nextResult();
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
    return result;
  }

  close(): void {
    if (this.closed || this.closing) return;
    this.closing = true;
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ type: "stop" })}\n`, (error) => {
        if (error && !isBrokenPipeError(error)) {
          this.rejectAll(error);
        }
        if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) {
          this.child.stdin.end();
        }
      });
    } catch (error) {
      if (!isBrokenPipeError(error)) {
        this.rejectAll(error);
      }
    }
  }

  terminate(): void {
    terminateChild(this.child, () => this.closed);
  }

  private readonly abort = (): void => {
    this.terminate();
  };

  private nextResult(): Promise<QianjiCliResult> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private consumeStdout(chunk: string): void {
    const lines = (this.stdoutLineBuffer + chunk).split("\n");
    this.stdoutLineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const sessionResult = parseQianjiHostSessionResultLine(line);
      if (sessionResult) {
        void this.resolveSessionResult(sessionResult);
        continue;
      }
      const traceEvent = parseQianjiTraceStreamLine(line);
      if (traceEvent) {
        this.enqueueTraceEvent(traceEvent);
        this.currentStreamedTrace = true;
        continue;
      }
      const work = parseQianjiHostWorkStreamLine(line);
      if (work) {
        this.currentHostWork.push(work);
        continue;
      }
      this.currentStdout += `${line}\n`;
    }
  }

  private enqueueTraceEvent(event: QianjiTraceEvent): void {
    this.traceQueue = this.traceQueue
      .then(async () => {
        if (this.traceError) return;
        await this.onTraceEvent(event);
      })
      .catch((err: unknown) => {
        this.traceError = err;
      });
  }

  private async resolveSessionResult(result: QianjiHostSessionResult): Promise<void> {
    const waiter = this.waiters.shift();
    if (!waiter) return;
    await this.traceQueue;
    if (this.traceError) {
      waiter.reject(this.traceError);
      return;
    }
    const stdout = `${this.currentStdout}${result.stdout}`;
    const stderr = `${this.currentStderr}${result.stderr}`;
    waiter.resolve({
      exitCode: result.exitCode,
      stdout,
      stderr,
      streamedTrace: this.currentStreamedTrace,
      hostWork: this.currentHostWork,
      ...(result.outcome ? { outcome: result.outcome } : {}),
      ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
      ...(result.pendingHostWork !== undefined
        ? { pendingHostWork: result.pendingHostWork }
        : {}),
      ...(result.variables ? { variables: result.variables } : {}),
    });
    this.currentStdout = "";
    this.currentStderr = "";
    this.currentStreamedTrace = false;
    this.currentHostWork = [];
  }

  private rejectAll(error: unknown): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }
}

function terminateChild(child: ChildProcessWithoutNullStreams, isClosed: () => boolean): void {
  if (isClosed()) return;
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (!isClosed()) child.kill("SIGKILL");
  }, 1000);
  killTimer.unref?.();
}

export function defaultQianjiCommand(_cwd: string): string {
  const envCommand = process.env.QIANJI_CLI?.trim();
  if (envCommand) return envCommand;

  return "qianji";
}

function consumeQianjiStdoutChunk(
  chunk: string,
  onTraceEvent: (event: QianjiTraceEvent) => void,
): {
  visibleOutput: string;
  remainder: string;
  streamedTrace: boolean;
  hostWork: QianjiHostWork[];
} {
  const lines = chunk.split("\n");
  const remainder = lines.pop() ?? "";
  let visibleOutput = "";
  let streamedTrace = false;
  const hostWork: QianjiHostWork[] = [];
  for (const line of lines) {
    const traceEvent = parseQianjiTraceStreamLine(line);
    if (traceEvent) {
      onTraceEvent(traceEvent);
      streamedTrace = true;
      continue;
    }
    const work = parseQianjiHostWorkStreamLine(line);
    if (work) {
      hostWork.push(work);
      continue;
    }
    visibleOutput += `${line}\n`;
  }
  return { visibleOutput, remainder, streamedTrace, hostWork };
}

function parseQianjiTraceStreamLine(line: string): QianjiTraceEvent | undefined {
  const prefix = "@@QIANJI_TRACE ";
  if (!line.startsWith(prefix)) return undefined;
  try {
    const parsed = JSON.parse(line.slice(prefix.length)) as unknown;
    return isQianjiTraceEvent(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseQianjiHostWorkStreamLine(line: string): QianjiHostWork | undefined {
  const prefix = "@@QIANJI_HOST_WORK ";
  if (!line.startsWith(prefix)) return undefined;
  try {
    const parsed = JSON.parse(line.slice(prefix.length)) as unknown;
    return isQianjiHostWork(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface QianjiHostSessionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outcome?: string;
  checkpoint?: PiWendaoQianjiCheckpointFeedback;
  pendingHostWork?: number;
  variables?: Record<string, unknown>;
}

function parseQianjiHostSessionResultLine(line: string): QianjiHostSessionResult | undefined {
  const prefix = "@@QIANJI_SESSION_RESULT ";
  if (!line.startsWith(prefix)) return undefined;
  try {
    const parsed = JSON.parse(line.slice(prefix.length)) as unknown;
    if (!isObject(parsed)) return undefined;
    const exitCode = parsed.exitCode;
    if (exitCode !== null && typeof exitCode !== "number") return undefined;
    const pendingHostWork =
      typeof parsed.pendingHostWork === "number" && Number.isFinite(parsed.pendingHostWork)
        ? parsed.pendingHostWork
        : undefined;
    const checkpoint = parseQianjiHostSessionCheckpoint(parsed.checkpoint, pendingHostWork);
    return {
      exitCode,
      stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
      stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
      ...(typeof parsed.outcome === "string" && parsed.outcome
        ? { outcome: parsed.outcome }
        : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(pendingHostWork !== undefined ? { pendingHostWork } : {}),
      ...(isObject(parsed.variables) ? { variables: parsed.variables } : {}),
    };
  } catch {
    return undefined;
  }
}

function parseQianjiHostSessionCheckpoint(
  value: unknown,
  pendingHostWork: number | undefined,
): PiWendaoQianjiCheckpointFeedback | undefined {
  if (!isObject(value)) return undefined;
  const checkpoint: PiWendaoQianjiCheckpointFeedback = {
    ...(readStringField(value, "outcome") ? { outcome: readStringField(value, "outcome") } : {}),
    ...(readStringField(value, "backend") ? { backend: readStringField(value, "backend") } : {}),
    ...(readStringField(value, "source") ? { source: readStringField(value, "source") } : {}),
    ...(readStringField(value, "saved") ? { saved: readStringField(value, "saved") } : {}),
    ...(readStringField(value, "deleted") ? { deleted: readStringField(value, "deleted") } : {}),
    ...(readStringField(value, "status") ? { status: readStringField(value, "status") } : {}),
    ...(readStringField(value, "pendingHostWork")
      ? { pendingHostWork: readStringField(value, "pendingHostWork") }
      : {}),
  };
  if (!checkpoint.pendingHostWork && pendingHostWork !== undefined) {
    checkpoint.pendingHostWork = String(pendingHostWork);
  }
  return Object.keys(checkpoint).length > 0 ? checkpoint : undefined;
}

function readStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function isBrokenPipeError(error: unknown): boolean {
  return isObject(error) && error.code === "EPIPE";
}

function isQianjiHostWork(value: unknown): value is QianjiHostWork {
  if (!isObject(value)) return false;
  if (!isPiWendaoHostWorkKind(value.kind)) return false;
  if (value.process_id !== undefined && typeof value.process_id !== "string") return false;
  if (value.activity_id !== undefined && typeof value.activity_id !== "string") return false;
  if (typeof value.node_id !== "string" || !value.node_id.trim()) return false;
  if (typeof value.token_id !== "number" || !Number.isFinite(value.token_id)) return false;
  if (value.node_index !== undefined && typeof value.node_index !== "number") return false;
  if (value.variables !== undefined && value.variables !== null && !isObject(value.variables)) {
    return false;
  }
  if (value.form !== undefined && value.form !== null && !isQianjiHumanTaskForm(value.form)) {
    return false;
  }
  if (
    value.assignment !== undefined &&
    value.assignment !== null &&
    !isQianjiHumanTaskAssignment(value.assignment)
  ) {
    return false;
  }
  if (value.claim !== undefined && value.claim !== null && !isQianjiHostWorkClaim(value.claim)) {
    return false;
  }
  return true;
}

function isQianjiHumanTaskForm(value: unknown): value is QianjiHumanTaskForm {
  if (!isObject(value)) return false;
  if (typeof value.interaction_type !== "string" || !value.interaction_type.trim()) return false;
  if (!isOptionalString(value.question_ref)) return false;
  if (!isOptionalString(value.question_text)) return false;
  if (!isOptionalString(value.choices_ref)) return false;
  if (!isOptionalString(value.result_output)) return false;
  if (value.choices !== undefined && value.choices !== null) {
    if (!Array.isArray(value.choices)) return false;
    if (!value.choices.every(isQianjiHumanTaskChoice)) return false;
  }
  if (value.free_text_fields !== undefined && value.free_text_fields !== null) {
    if (!Array.isArray(value.free_text_fields)) return false;
    if (!value.free_text_fields.every(isQianjiHumanTaskFreeText)) return false;
  }
  return true;
}

function isQianjiHumanTaskChoice(value: unknown): value is QianjiHumanTaskChoice {
  return (
    isObject(value) &&
    typeof value.value === "string" &&
    value.value.trim().length > 0 &&
    isOptionalString(value.label) &&
    isOptionalString(value.description)
  );
}

function isQianjiHumanTaskFreeText(value: unknown): value is QianjiHumanTaskFreeText {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    typeof value.optional === "boolean"
  );
}

function isQianjiHumanTaskAssignment(value: unknown): value is QianjiHumanTaskAssignment {
  if (!isObject(value)) return false;
  if (value.human_performers !== undefined && value.human_performers !== null) {
    if (!Array.isArray(value.human_performers)) return false;
    if (!value.human_performers.every(isQianjiHumanTaskResourceRole)) return false;
  }
  if (value.potential_owners !== undefined && value.potential_owners !== null) {
    if (!Array.isArray(value.potential_owners)) return false;
    if (!value.potential_owners.every(isQianjiHumanTaskResourceRole)) return false;
  }
  return true;
}

function isQianjiHumanTaskResourceRole(value: unknown): value is QianjiHumanTaskResourceRole {
  if (!isObject(value)) return false;
  if (!isOptionalString(value.name)) return false;
  if (!isOptionalString(value.resource_ref)) return false;
  if (!isOptionalString(value.assignment_expression)) return false;
  return true;
}

function isQianjiHostWorkClaim(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.claimant === "string" &&
    value.claimant.trim().length > 0 &&
    (value.claimed_at_ms === undefined ||
      value.claimed_at_ms === null ||
      (typeof value.claimed_at_ms === "number" && Number.isFinite(value.claimed_at_ms)))
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isPiWendaoHostWorkKind(value: unknown): value is PiWendaoHostWorkKind {
  return typeof value === "string" && PI_WENDAO_HOST_WORK_KINDS.has(value as PiWendaoHostWorkKind);
}

const PI_WENDAO_HOST_WORK_KINDS = new Set<PiWendaoHostWorkKind>([
  "send",
  "service",
  "script",
  "user",
  "manual",
  "business_rule",
]);

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
