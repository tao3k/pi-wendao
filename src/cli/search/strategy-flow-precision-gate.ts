import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type SearchStrategyFlowPrecisionGateName =
  | "materialized_precision"
  | "real_scenarios"
  | "stratified_live_intents";

export interface SearchStrategyFlowPrecisionGateOptions {
  packageRoot?: string;
  wendaoGraphDir?: string;
  juliaCommand?: string;
  gates?: SearchStrategyFlowPrecisionGateName[];
}

export interface SearchStrategyFlowPrecisionGateCommand {
  gate: SearchStrategyFlowPrecisionGateName;
  command: string;
  args: string[];
  cwd: string;
}

export interface SearchStrategyFlowPrecisionGatePlan {
  wendaoGraphDir: string;
  commands: SearchStrategyFlowPrecisionGateCommand[];
}

const DEFAULT_GATES: SearchStrategyFlowPrecisionGateName[] = [
  "materialized_precision",
  "real_scenarios",
  "stratified_live_intents",
];

const GATE_TEST_PATHS: Record<SearchStrategyFlowPrecisionGateName, string> = {
  materialized_precision: "test/reasoning/search_strategy_flow_materialized_precision.jl",
  real_scenarios: "test/reasoning/search_strategy_flow_real_scenarios.jl",
  stratified_live_intents: "test/reasoning/search_strategy_flow_stratified_live_intents.jl",
};

export function resolveSearchStrategyFlowPrecisionGatePlan(
  options: SearchStrategyFlowPrecisionGateOptions = {},
): SearchStrategyFlowPrecisionGatePlan {
  const packageRoot = resolve(options.packageRoot ?? process.cwd());
  const wendaoGraphDir = resolve(
    options.wendaoGraphDir ??
      process.env.PI_WENDAO_WENDAOGRAPH_DIR ??
      join(packageRoot, "..", "WendaoGraph.jl"),
  );
  const juliaCommand = options.juliaCommand ?? process.env.JULIA ?? "julia";
  const gates = options.gates ?? DEFAULT_GATES;
  return {
    wendaoGraphDir,
    commands: gates.map((gate) => ({
      gate,
      command: juliaCommand,
      args: ["--project=.", GATE_TEST_PATHS[gate]],
      cwd: wendaoGraphDir,
    })),
  };
}

export function runSearchStrategyFlowPrecisionGate(
  options: SearchStrategyFlowPrecisionGateOptions = {},
): void {
  const plan = resolveSearchStrategyFlowPrecisionGatePlan(options);
  assertWendaoGraphProject(plan.wendaoGraphDir);
  for (const command of plan.commands) {
    const result = spawnSync(command.command, command.args, {
      cwd: command.cwd,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `SearchStrategyFlow precision gate ${command.gate} failed with exit code ${result.status ?? "unknown"}.`,
      );
    }
  }
}

function assertWendaoGraphProject(wendaoGraphDir: string): void {
  if (!existsSync(join(wendaoGraphDir, "Project.toml"))) {
    throw new Error(
      `WendaoGraph.jl project not found at ${wendaoGraphDir}; set PI_WENDAO_WENDAOGRAPH_DIR or pass --wendao-graph.`,
    );
  }
}

function printPlan(plan: SearchStrategyFlowPrecisionGatePlan): void {
  console.log(`WendaoGraph.jl: ${plan.wendaoGraphDir}`);
  for (const command of plan.commands) {
    console.log(`${command.gate}: ${command.command} ${command.args.join(" ")}`);
  }
}

function parseCliArgs(argv: string[]): SearchStrategyFlowPrecisionGateOptions & { printPlan: boolean } {
  const options: SearchStrategyFlowPrecisionGateOptions & { printPlan: boolean } = {
    printPlan: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--print-plan") {
      options.printPlan = true;
    } else if (arg === "--wendao-graph") {
      options.wendaoGraphDir = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--julia") {
      options.juliaCommand = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--gate") {
      options.gates = [...(options.gates ?? []), parseGateName(requireValue(argv, index, arg))];
      index += 1;
    } else {
      throw new Error(`unknown SearchStrategyFlow precision gate option: ${arg}`);
    }
  }
  return options;
}

function parseGateName(value: string): SearchStrategyFlowPrecisionGateName {
  if (value in GATE_TEST_PATHS) return value as SearchStrategyFlowPrecisionGateName;
  throw new Error(`unknown SearchStrategyFlow precision gate: ${value}`);
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    const plan = resolveSearchStrategyFlowPrecisionGatePlan(options);
    if (options.printPlan) {
      printPlan(plan);
    } else {
      runSearchStrategyFlowPrecisionGate(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
