import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  renderWorkflowSubagentBenchmarkReport,
  runWorkflowSubagentBenchmark,
} from "./workflow-subagent-benchmark/runner.js";
import type { WorkflowSubagentBenchmarkOptions } from "./workflow-subagent-benchmark/types.js";

export {
  renderWorkflowSubagentBenchmarkReport,
  runWorkflowSubagentBenchmark,
  summarizeWorkflowSubagentBenchmarkReport,
} from "./workflow-subagent-benchmark/runner.js";
export type {
  WorkflowSubagentBenchmarkOptions,
  WorkflowSubagentBenchmarkReport,
  WorkflowSubagentBenchmarkRow,
  WorkflowSubagentBenchmarkSummary,
  WorkflowSubagentBenchmarkVariant,
} from "./workflow-subagent-benchmark/types.js";

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  runWorkflowSubagentBenchmarkCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export async function runWorkflowSubagentBenchmarkCli(argv: string[]): Promise<void> {
  const options = parseWorkflowSubagentBenchmarkArgs(argv);
  const report = await runWorkflowSubagentBenchmark(options);
  if (options.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(renderWorkflowSubagentBenchmarkReport(report).trimEnd());
  if (report.summary.failedCount > 0) {
    process.exitCode = 1;
  }
}

export function parseWorkflowSubagentBenchmarkArgs(
  argv: string[],
): WorkflowSubagentBenchmarkOptions {
  const options: WorkflowSubagentBenchmarkOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--live":
        options.live = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--fixture":
        options.fixturePath = readValue(argv, ++index, arg);
        break;
      case "--process":
        options.processId = readValue(argv, ++index, arg);
        break;
      case "--iterations":
        options.iterations = parsePositiveInteger(readValue(argv, ++index, arg), arg);
        break;
      case "--model":
        options.model = readValue(argv, ++index, arg);
        break;
      case "--server-url":
        options.serverUrl = readValue(argv, ++index, arg);
        break;
      case "--output-json":
        options.outputJsonPath = readValue(argv, ++index, arg);
        break;
      default:
        throw new Error(`unsupported workflow subagent benchmark argument: ${arg}`);
    }
  }
  return options;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}
