#!/usr/bin/env node
import { readFileSync } from "fs";
import { resolve as resolvePath } from "node:path";
import { program } from "commander";
import type { PiWendaoThinkingLevel } from "../executor/agent-runtime-types.js";
import { validateInstanceId } from "./instance-id.js";
import { createRenderer } from "../ui/renderer.js";
import { registerCompileCommand } from "./compile-command.js";
import { resolveFlowhubScenario } from "./flowhub-scenario.js";
import { resolveModel, resolvePiWendaoPackageRoot } from "./model-resolver.js";
import { parseNonNegativeNumber } from "./number-options.js";
import { launchPiWendaoNativeTui } from "./pi-wendao-native-launcher.js";
import { runSearchStrategyFlowCommand } from "./search/strategy-flow-command.js";
import { registerSearchStrategyFlowOptions } from "./search/strategy-flow-options.js";
import {
  appendActiveBpmnNodeLabels,
  resolveQianjiCommand,
  runQianjiShow,
  runWorkflowLintPreflight,
  runWorkflowInRenderer,
} from "./workflow-runner.js";

const DEFAULT_EXECUTION_MODEL = "anthropic/deepseek-v4-pro";
const DEFAULT_THINKING_LEVEL: PiWendaoThinkingLevel = "medium";
const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

program.enablePositionalOptions();

interface PiWendaoCliOptions {
  process?: string;
  instanceId?: string;
  startAtNode?: string;
  qianji?: string;
  qianjiClient?: string;
  flowhubScenario?: string;
  flowhubRoot?: string;
  dmn?: string[];
  hostFixture?: string;
  eventFixture?: string;
  contextJson?: string;
  traceFrameMs?: number;
  model?: string;
  provider?: string;
  apiKey?: string;
  thinking?: string;
  extension?: string[];
  var?: string[];
  show?: boolean;
  graph?: boolean;
  tui?: boolean;
  search?: string;
  wendaoGraph?: string;
  searchJulia?: string;
  searchBackend?: string;
  searchRustWorkspace?: string;
  searchRustCommand?: string;
  searchRustBridgeBin?: string;
  searchRustBridgeSession?: boolean;
  searchFlightBaseUrl?: string;
  searchFlightTimeoutSeconds?: number;
  searchStrategyFlowServiceBaseUrl?: string;
  searchStrategyFlowServiceTimeoutSeconds?: number;
  searchAgent?: boolean;
  searchAgentAnswerRequest?: string;
  searchAgentAnswerMode?: string;
  searchAgentAnswerChunkSize?: number;
  searchAgentAnswerResume?: boolean;
  searchAgentAnswerEvidence?: string;
  searchJson?: boolean;
}

registerCompileCommand(program);

registerSearchStrategyFlowOptions(
  program
    .name("pi-wendao")
    .description("Execute a compiled BPMN workflow through the qianji CLI")
    .argument("[workflow]", "Path to .bpmn workflow file")
    .option(
      "--process <id>",
      "BPMN process id (default: first process in the file)",
    )
    .option("--instance-id <id>", "Qianji workflow instance id")
    .option(
      "--start-at-node <id>",
      "Start a fresh qianji BPMN instance at a specific node",
    )
    .option(
      "--qianji <command>",
      "Qianji CLI command (default: QIANJI_CLI, workspace target/debug/qianji, or qianji on PATH)",
    )
    .option(
      "--qianji-client <command>",
      "qianji-client command for Flowhub scenario registry lookup (default: QIANJI_CLIENT_CLI, workspace target/debug/qianji-client, or qianji-client on PATH)",
    )
    .option(
      "--flowhub-scenario <id>",
      "Run a BPMN workflow selected from qianji-client flowhub scenarios --json",
    )
    .option("--flowhub-root <path>", "Flowhub root used by --flowhub-scenario")
    .option(
      "--dmn <path>",
      "Pass a DMN source to qianji (repeatable)",
      collect,
      [],
    )
    .option(
      "--host-fixture <path>",
      "Host fixture JSON; with native host handling, userTasks still render through pi-wendao UI",
    )
    .option("--event-fixture <path>", "Qianji event fixture JSON")
    .option(
      "--context-json <json>",
      "Raw JSON context merged after --var pairs",
    )
    .option(
      "--trace-frame-ms <ms>",
      "Delay between streamed graph trace frames",
      parseNonNegativeNumber,
    )
    .option("--model <model>", "Model for real host execution")
    .option("--provider <provider>", "Provider for model resolution")
    .option("--api-key <key>", "API key override for model resolution")
    .option(
      "--thinking <level>",
      "LLM thinking level for real host execution: off, minimal, low, medium, high, xhigh",
    )
    .option(
      "-e, --extension <path>",
      "Load an extra pi extension; built-in pi-subagents is loaded from package dependencies",
      collect,
      [],
    )
    .option("--var <pairs...>", "Variables as key=value pairs")
    .option(
      "--show",
      "Show qianji BPMN instances, or status for --instance-id, without executing",
    ),
)
  .option(
    "--tui",
    "Enable interactive graph TUI visualization (default); without workflow, open native pi chat",
  )
  .option("--no-tui", "Disable interactive graph TUI visualization")
  .option(
    "--no-graph",
    "Disable graph visualization (legacy alias for --no-tui)",
  )
  .action(
    async (workflowPath: string | undefined, options: PiWendaoCliOptions) => {
      try {
        const invocationCwd = process.cwd();
        const piContextCwd = resolvePiWendaoPackageRoot();
        const resolvedDmnPaths = resolveCliPaths(
          invocationCwd,
          options.dmn ?? [],
        );
        const resolvedExtensionPaths = resolveCliPaths(
          invocationCwd,
          options.extension ?? [],
        );
        const resolvedHostFixturePath = resolveOptionalCliPath(
          invocationCwd,
          options.hostFixture,
        );
        const resolvedEventFixturePath = resolveOptionalCliPath(
          invocationCwd,
          options.eventFixture,
        );
        const instanceId = validateInstanceId(options.instanceId);
        const thinkingLevel = resolveExecutionThinkingLevel(options.thinking);
        if (
          options.search !== undefined ||
          options.searchAgentAnswerRequest !== undefined
        ) {
          await runSearchStrategyFlowCommand({
            intent:
              options.search ??
              "materialized SearchStrategyFlow answer request",
            cwd: invocationCwd,
            wendaoGraph: options.wendaoGraph,
            searchJulia: options.searchJulia,
            searchBackend: options.searchBackend,
            searchRustWorkspace: options.searchRustWorkspace,
            searchRustCommand: options.searchRustCommand,
            searchRustBridgeBin: options.searchRustBridgeBin,
            searchRustBridgeSession: options.searchRustBridgeSession,
            searchFlightBaseUrl: options.searchFlightBaseUrl,
            searchFlightTimeoutSeconds: options.searchFlightTimeoutSeconds,
            searchStrategyFlowServiceBaseUrl: options.searchStrategyFlowServiceBaseUrl,
            searchStrategyFlowServiceTimeoutSeconds: options.searchStrategyFlowServiceTimeoutSeconds,
            searchAgent: options.searchAgent,
            searchAgentAnswerRequest: options.searchAgentAnswerRequest,
            searchAgentAnswerMode: options.searchAgentAnswerMode,
            searchAgentAnswerChunkSize: options.searchAgentAnswerChunkSize,
            searchAgentAnswerResume: options.searchAgentAnswerResume,
            searchAgentAnswerEvidence: options.searchAgentAnswerEvidence,
            searchJson: options.searchJson,
            qianjiCommand: options.qianji,
            modelPattern: resolveExecutionModelPattern(options.model),
            provider: options.provider,
            apiKey: options.apiKey,
            thinkingLevel,
            extensionPaths: resolvedExtensionPaths,
          });
          process.exit(0);
        }
        if (
          !workflowPath &&
          !options.flowhubScenario &&
          options.show !== true &&
          options.tui === true &&
          process.stdin.isTTY
        ) {
          await launchPiWendaoNativeTui({
            modelPattern: resolveExecutionModelPattern(options.model),
            provider: options.provider,
            apiKey: options.apiKey,
            thinkingLevel,
            invocationCwd,
            piContextCwd,
            resolvedExtensionPaths,
            baseWorkflowOptions: {
              process: options.process,
              instanceId,
              startAtNode: options.startAtNode,
              qianji: options.qianji,
              contextJson: options.contextJson,
              traceFrameMs: options.traceFrameMs,
              var: options.var,
            },
            resolvedDmnPaths,
            resolvedHostFixturePath,
            resolvedEventFixturePath,
          });
          process.exit(0);
        }
        const workflowResolution = await resolveWorkflowArgument(
          workflowPath,
          options,
          {
            invocationCwd,
            piContextCwd,
            resolvedDmnPaths,
            resolvedExtensionPaths,
            thinkingLevel,
          },
        );
        if (workflowResolution.kind === "exit") process.exit(0);
        const resolvedWorkflowPath = resolveOptionalCliPath(
          invocationCwd,
          workflowResolution.workflowPath,
        );
        const resolvedProcessId =
          workflowResolution.kind === "workflow"
            ? (options.process ?? workflowResolution.process)
            : options.process;
        if (options.show) {
          const output = await runQianjiShow({
            command: resolveQianjiCommand(options.qianji),
            instanceId,
            workflowPath: resolvedWorkflowPath,
            dmnPaths: resolvedDmnPaths,
            cwd: invocationCwd,
          });
          const stdout =
            output.exitCode === 0 && instanceId && resolvedWorkflowPath
              ? appendActiveBpmnNodeLabels(
                  output.stdout,
                  readFileSync(resolvedWorkflowPath, "utf-8"),
                  resolvedProcessId,
                )
              : output.stdout;
          if (stdout.trim()) console.log(stdout.trimEnd());
          if (output.stderr.trim()) console.error(output.stderr.trimEnd());
          process.exitCode = output.exitCode ?? 1;
          return;
        }
        if (!resolvedWorkflowPath) {
          program.error(
            "missing required argument 'workflow' (or run `pi-wendao --tui` from an interactive terminal for chat)",
          );
        }

        process.chdir(piContextCwd);
        const useGraph = options.graph !== false && options.tui !== false;
        const renderer = createRenderer(useGraph);

        console.log(`Executing ${resolvedWorkflowPath} with qianji CLI...`);

        renderer.start();
        let result: Awaited<ReturnType<typeof runWorkflowInRenderer>>;
        try {
          let resolvedModel:
            | Awaited<ReturnType<typeof resolveModel>>
            | undefined;
          const resolveRunModel = async () => {
            resolvedModel ??= await resolveModel(
              resolveExecutionModelPattern(options.model),
              options.provider,
              options.apiKey,
              resolvedExtensionPaths,
            );
            return resolvedModel;
          };
          const lint = await runWorkflowLintPreflight({
            renderer,
            resolvedWorkflowPath,
            resolvedDmnPaths,
            qianjiCommand: options.qianji,
            cwd: invocationCwd,
            resolveRepairModel: resolveRunModel,
          });
          if (!lint.success) {
            process.exitCode = 1;
            return;
          }
          const executionModel = resolvedHostFixturePath
            ? undefined
            : await resolveRunModel();

          result = await runWorkflowInRenderer({
            renderer,
            useGraph,
            resolvedWorkflowPath: lint.workflowPath,
            options: {
              process: resolvedProcessId,
              instanceId,
              startAtNode: options.startAtNode,
              qianji: options.qianji,
              contextJson: options.contextJson,
              traceFrameMs: options.traceFrameMs,
              var: options.var,
            },
            instanceId,
            invocationCwd,
            piContextCwd,
            resolvedDmnPaths,
            resolvedHostFixturePath,
            resolvedEventFixturePath,
            resolvedModel: executionModel,
            thinkingLevel,
            preflightLint: false,
          });

          if (useGraph) {
            renderer.appendLog("\nPress any key to exit.");
            await renderer.waitForKey();
          }
        } finally {
          renderer.stop();
        }
        process.exit(result.success ? 0 : 1);
      } catch (err) {
        console.error(
          "Error:",
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    },
  );

function collect(value: string, prev: string[]): string[] {
  return prev.concat([value]);
}

function resolveCliPath(cwd: string, path: string): string {
  return resolvePath(cwd, path);
}

function resolveCliPaths(cwd: string, paths: string[]): string[] {
  return paths.map((path) => resolveCliPath(cwd, path));
}

function resolveOptionalCliPath(
  cwd: string,
  path: string | undefined,
): string | undefined {
  return path ? resolveCliPath(cwd, path) : undefined;
}

type WorkflowArgumentResolution =
  | { kind: "workflow"; workflowPath: string; process?: string }
  | { kind: "missing"; workflowPath?: undefined }
  | { kind: "exit"; workflowPath?: undefined };

async function resolveWorkflowArgument(
  workflowPath: string | undefined,
  options: {
    qianji?: string;
    qianjiClient?: string;
    flowhubScenario?: string;
    flowhubRoot?: string;
    show?: boolean;
    tui?: boolean;
    model?: string;
    provider?: string;
    apiKey?: string;
  },
  context: {
    invocationCwd: string;
    piContextCwd: string;
    resolvedDmnPaths: string[];
    resolvedExtensionPaths: string[];
    thinkingLevel: PiWendaoThinkingLevel;
  },
): Promise<WorkflowArgumentResolution> {
  if (workflowPath && options.flowhubScenario) {
    throw new Error(
      "--flowhub-scenario cannot be combined with a workflow path",
    );
  }
  if (options.flowhubScenario) {
    const scenario = await resolveFlowhubScenario({
      scenarioId: options.flowhubScenario,
      cwd: context.invocationCwd,
      flowhubRoot: options.flowhubRoot,
      qianjiClientCommand: options.qianjiClient,
    });
    return {
      kind: "workflow",
      workflowPath: scenario.bpmnSource,
      process: scenario.bpmnProcessId,
    };
  }
  if (workflowPath) return { kind: "workflow", workflowPath };
  if (options.show) return { kind: "missing" };
  void context;
  return { kind: "missing" };
}

function resolveExecutionModelPattern(
  explicitModel: string | undefined,
): string {
  if (explicitModel) return explicitModel;
  const envModel = process.env.PI_WENDAO_MODEL;
  if (!envModel) return DEFAULT_EXECUTION_MODEL;
  if (envModel.includes("/") || !process.env.ANTHROPIC_BASE_URL?.trim())
    return envModel;
  return `anthropic/${envModel}`;
}

function resolveExecutionThinkingLevel(
  explicitLevel: string | undefined,
): PiWendaoThinkingLevel {
  const raw =
    explicitLevel ??
    process.env.PI_WENDAO_THINKING_LEVEL ??
    DEFAULT_THINKING_LEVEL;
  if (!THINKING_LEVELS.has(raw)) {
    throw new Error(
      `invalid thinking level "${raw}"; expected off, minimal, low, medium, high, or xhigh`,
    );
  }
  return raw as PiWendaoThinkingLevel;
}

program.parse();
