import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { PiWendaoHostWorkKind } from "./agent-host.js";
import { isObject } from "./data.js";
import { WorkflowInterruptedError, throwIfWorkflowInterrupted } from "./interrupt.js";
import { isQianjiTraceEvent } from "./qianji-report.js";
import type { QianjiCliResult, QianjiHostWork, QianjiTraceEvent } from "./qianji-types.js";

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
  return args;
}

export function buildQianjiTaskCompleteArgs(options: {
  sourcePath: string;
  instanceId: string;
  dmnPaths: string[];
  hostFixturePath: string;
  traceStream: boolean;
  externalHost: boolean;
}): string[] {
  const args = [
    "bpmn",
    "tasks",
    "complete",
    "--bpmn",
    options.sourcePath,
    "--instance-id",
    options.instanceId,
    "--host-fixture",
    options.hostFixturePath,
  ];
  for (const dmnPath of options.dmnPaths) {
    args.push("--dmn", dmnPath);
  }
  if (options.traceStream) {
    args.push("--trace-stream");
  }
  if (options.externalHost) {
    args.push("--external-host");
  }
  return args;
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

function isQianjiHostWork(value: unknown): value is QianjiHostWork {
  if (!isObject(value)) return false;
  if (!isPiWendaoHostWorkKind(value.kind)) return false;
  if (typeof value.node_id !== "string" || !value.node_id.trim()) return false;
  if (typeof value.token_id !== "number" || !Number.isFinite(value.token_id)) return false;
  if (value.node_index !== undefined && typeof value.node_index !== "number") return false;
  if (value.variables !== undefined && !isObject(value.variables)) return false;
  return true;
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
