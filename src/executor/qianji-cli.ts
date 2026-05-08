import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  PiWendaoHostWorkKind,
  PiWendaoQianjiCheckpointFeedback,
} from "./agent-host.js";
import { WorkflowInterruptedError, throwIfWorkflowInterrupted } from "./interrupt.js";
import type {
  QianjiCliResult,
  QianjiHostWork,
  QianjiTraceEvent,
} from "./qianji-types.js";
import {
  consumeQianjiStdoutChunk,
  isBrokenPipeError,
  parseQianjiHostSessionResultLine,
  parseQianjiHostWorkStreamLine,
  parseQianjiTraceStreamLine,
  shellQuote,
  type QianjiHostSessionResult,
} from "./qianji-stream.js";

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

