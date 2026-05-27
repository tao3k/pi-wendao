import { performance } from "node:perf_hooks";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveModel } from "../model-resolver.js";
import { runWorkflowInRenderer } from "../workflow-runner.js";
import { runDeterministicComplexBpmnSubagent } from "./deterministic-subagent.js";
import {
  DEFAULT_FIXTURE_PATH,
  DEFAULT_MODEL,
  DEFAULT_PROCESS_ID,
  hasExpectedComplexVariables,
} from "./fixture.js";
import { runDeterministicComplexBpmn, writeJson } from "./qianji.js";
import {
  renderWorkflowSubagentBenchmarkReport,
  summarizeWorkflowSubagentBenchmarkReport,
} from "./report.js";
import {
  BenchmarkRenderer,
  countLiveWorkflowTraceLogs,
  countParallelHostWorkBatches,
} from "./renderer.js";
import type {
  WorkflowSubagentBenchmarkOptions,
  WorkflowSubagentBenchmarkReport,
  WorkflowSubagentBenchmarkRow,
} from "./types.js";

export async function runWorkflowSubagentBenchmark(
  options: WorkflowSubagentBenchmarkOptions = {},
): Promise<WorkflowSubagentBenchmarkReport> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const fixturePath = resolve(cwd, options.fixturePath ?? DEFAULT_FIXTURE_PATH);
  const processId = options.processId ?? DEFAULT_PROCESS_ID;
  const iterations = normalizeIterations(options.iterations);
  const serverUrl = options.serverUrl ?? process.env.PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL;
  const rows: WorkflowSubagentBenchmarkRow[] = [];
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    rows.push(await runDeterministicComplexBpmn({ cwd, fixturePath, processId, iteration }));
    rows.push(
      await runDeterministicComplexBpmnSubagent({
        cwd,
        fixturePath,
        processId,
        iteration,
      }),
    );
    if (serverUrl?.trim()) {
      rows.push(
        await runDeterministicComplexBpmnSubagent({
          cwd,
          fixturePath,
          processId,
          iteration,
          serverUrl,
        }),
      );
      rows.push(
        await runDeterministicComplexBpmnSubagent({
          cwd,
          fixturePath,
          processId,
          iteration,
          serverUrl,
          serverStartMode: "start",
        }),
      );
    }
    if (options.live === true) {
      rows.push(
        await runLiveComplexBpmnSubagent({
          cwd,
          fixturePath,
          processId,
          iteration,
          model:
            options.model ??
            process.env.PI_WENDAO_WORKFLOW_SUBAGENT_BPMN_LIVE_MODEL ??
            DEFAULT_MODEL,
        }),
      );
    }
  }
  const report: WorkflowSubagentBenchmarkReport = {
    benchmark: "workflow-subagent-bpmn",
    fixturePath,
    processId,
    iterations,
    live: options.live === true,
    startedAt: new Date().toISOString(),
    rows,
    summary: summarizeWorkflowSubagentBenchmarkReport(rows),
  };
  if (options.outputJsonPath) {
    writeJson(resolve(cwd, options.outputJsonPath), report);
  }
  return report;
}

async function runLiveComplexBpmnSubagent(input: {
  cwd: string;
  fixturePath: string;
  processId: string;
  iteration: number;
  model: string;
}): Promise<WorkflowSubagentBenchmarkRow> {
  const started = performance.now();
  const renderer = new BenchmarkRenderer();
  const originalStore = process.env.PI_WENDAO_SUBAGENTS_RUN_STORE;
  process.env.PI_WENDAO_SUBAGENTS_RUN_STORE ??= join(
    mkdtempSync(join(tmpdir(), "pi-wendao-complex-bpmn-live-")),
    "subagents.json",
  );
  try {
    const resolvedModel = await resolveModel(input.model);
    const result = await runWorkflowInRenderer({
      renderer,
      useGraph: false,
      resolvedWorkflowPath: input.fixturePath,
      options: {
        process: input.processId,
        contextJson: "{}",
        traceFrameMs: 0,
      },
      instanceId: `wf_complex_live_benchmark_${Date.now()}_${input.iteration}`,
      invocationCwd: input.cwd,
      piContextCwd: input.cwd,
      resolvedDmnPaths: [],
      thinkingLevel: "medium",
      resolvedModel,
    });
    const success = result.success && hasExpectedComplexVariables(renderer.variables);
    const traceEventCount = countLiveWorkflowTraceLogs(renderer.logs, renderer.traceEvents.length);
    return {
      variant: "pi-wendao-live-complex-subagent",
      iteration: input.iteration,
      status: success ? "passed" : "failed",
      success,
      wallMs: performance.now() - started,
      workflowPath: input.fixturePath,
      processId: input.processId,
      model: input.model,
      traceEventCount,
      parallelBatchCount: countParallelHostWorkBatches(renderer.logs),
      variableKeys: Object.keys(renderer.variables),
      variables: renderer.variables,
      error: success ? undefined : renderer.errors.map((error) => error.message).join("; "),
    };
  } catch (error) {
    const traceEventCount = countLiveWorkflowTraceLogs(renderer.logs, renderer.traceEvents.length);
    return {
      variant: "pi-wendao-live-complex-subagent",
      iteration: input.iteration,
      status: "failed",
      success: false,
      wallMs: performance.now() - started,
      workflowPath: input.fixturePath,
      processId: input.processId,
      model: input.model,
      traceEventCount,
      parallelBatchCount: countParallelHostWorkBatches(renderer.logs),
      variableKeys: Object.keys(renderer.variables),
      variables: renderer.variables,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (originalStore === undefined) {
      delete process.env.PI_WENDAO_SUBAGENTS_RUN_STORE;
    } else {
      process.env.PI_WENDAO_SUBAGENTS_RUN_STORE = originalStore;
    }
  }
}

function normalizeIterations(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--iterations must be a positive integer");
  }
  return value;
}

export { renderWorkflowSubagentBenchmarkReport, summarizeWorkflowSubagentBenchmarkReport };
