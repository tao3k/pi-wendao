import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveDefaultQianjiCommand } from "../../qianji-command-resolution.js";
import type { QianjiTraceLogEvent } from "../../ui/renderer.js";
import { shellQuote } from "../workflow-runner/qianji-show.js";
import { complexHostFixture } from "./fixture.js";
import type { WorkflowSubagentBenchmarkRow } from "./types.js";

export async function runDeterministicComplexBpmn(input: {
  cwd: string;
  fixturePath: string;
  processId: string;
  iteration: number;
}): Promise<WorkflowSubagentBenchmarkRow> {
  const started = performance.now();
  const tempDir = mkdtempSync(join(tmpdir(), "pi-wendao-complex-bpmn-benchmark-"));
  const fixturePath = join(tempDir, "host-fixture.json");
  writeFileSync(fixturePath, `${JSON.stringify(complexHostFixture(), null, 2)}\n`, "utf-8");
  const result = await runCommand({
    cwd: input.cwd,
    command: resolveDefaultQianjiCommand(input.cwd),
    args: [
      "bpmn",
      "run",
      "--bpmn",
      input.fixturePath,
      "--process",
      input.processId,
      "--instance-id",
      `wf_complex_benchmark_${Date.now()}_${input.iteration}`,
      "--context-json",
      "{}",
      "--host-fixture",
      fixturePath,
    ],
  });
  const wallMs = performance.now() - started;
  const parsed = parseQianjiRunOutput(result.stdout);
  const success = result.exitCode === 0 && result.stdout.includes("Outcome: completed");
  return {
    variant: "qianji-complex-fixture",
    iteration: input.iteration,
    status: success ? "passed" : "failed",
    success,
    wallMs,
    workflowPath: input.fixturePath,
    processId: input.processId,
    traceEventCount: parsed.traceEventCount,
    parallelBatchCount: countParallelExecutionBatches(parsed.traceEvents),
    variableKeys: Object.keys(parsed.variables),
    variables: parsed.variables,
    error: success ? undefined : trimError(result.stderr || result.stdout),
  };
}

function runCommand(input: {
  cwd: string;
  command: string;
  args: string[];
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const commandLine = [input.command, ...input.args.map(shellQuote)].join(" ");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandLine, { cwd: input.cwd, shell: true, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
  });
}

function parseQianjiRunOutput(output: string): {
  traceEventCount: number;
  traceEvents: QianjiTraceLogEvent[];
  variables: Record<string, unknown>;
} {
  const trace = parseJsonFenceAfterHeading(output, "## Trace");
  const variables = parseJsonFenceAfterHeading(output, "## Variables");
  const traceEvents = Array.isArray(trace) ? (trace as QianjiTraceLogEvent[]) : [];
  return {
    traceEventCount: traceEvents.length,
    traceEvents,
    variables: isRecord(variables) ? variables : {},
  };
}

function parseJsonFenceAfterHeading(output: string, heading: string): unknown {
  const headingIndex = output.indexOf(heading);
  if (headingIndex === -1) return undefined;
  const rest = output.slice(headingIndex + heading.length);
  const match = rest.match(/```json\n([\s\S]*?)\n```/);
  if (!match) return undefined;
  return JSON.parse(match[1] ?? "null");
}

function countParallelExecutionBatches(events: QianjiTraceLogEvent[]): number {
  let batches = 0;
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    if (
      previous?.kind === "node_status" &&
      current?.kind === "node_status" &&
      previous.status === "executing" &&
      current.status === "executing"
    ) {
      batches += 1;
    }
  }
  return batches;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function trimError(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

export function resolveMaybePath(cwd: string, path: string): string {
  return resolve(cwd, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
