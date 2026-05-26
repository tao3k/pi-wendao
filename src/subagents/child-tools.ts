import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import registerPiWendaoPiIntercom from "../cli/graph-intercom-extension.js";
import {
  registerSearchStrategyFlowTool,
  WENDAO_SEARCH_STRATEGY_FLOW_TOOL_NAME,
} from "../cli/search/strategy-flow-tool.js";
import {
  registerServerlessMemoryRecallTool,
  WENDAO_MEMORY_RECALL_TOOL_NAME,
} from "../cli/serverless-memory/index.js";
import {
  NATIVE_SUBAGENT_FILE_TOOL_NAMES,
  registerNativeSubagentFileTools,
} from "./file-tools.js";

export const NATIVE_SUBAGENT_INTERCOM_TOOL_NAME = "intercom";
export const NATIVE_SUBAGENT_CHILD_CONTEXT_TOOL_NAMES = [
  ...NATIVE_SUBAGENT_FILE_TOOL_NAMES,
  WENDAO_MEMORY_RECALL_TOOL_NAME,
  WENDAO_SEARCH_STRATEGY_FLOW_TOOL_NAME,
  NATIVE_SUBAGENT_INTERCOM_TOOL_NAME,
] as const;

export interface NativeSubagentChildToolSelection {
  type: string;
  isolated?: boolean;
}

export function selectNativeSubagentChildContextToolNames(
  input: NativeSubagentChildToolSelection,
): string[] {
  if (!shouldExposeChildContextTools(input)) return [];
  return [...NATIVE_SUBAGENT_CHILD_CONTEXT_TOOL_NAMES];
}

export function createNativeSubagentChildContextExtensionFactories(
  input: NativeSubagentChildToolSelection & { cwd: string },
): ExtensionFactory[] {
  if (!shouldExposeChildContextTools(input)) return [];
  return [
    (pi) => {
      registerNativeSubagentFileTools(pi, { cwd: input.cwd });
      registerServerlessMemoryRecallTool(pi, { cwd: input.cwd });
      registerSearchStrategyFlowTool(pi, { cwd: input.cwd });
      registerPiWendaoPiIntercom(pi as Parameters<typeof registerPiWendaoPiIntercom>[0]);
    },
  ];
}

function shouldExposeChildContextTools(input: NativeSubagentChildToolSelection): boolean {
  if (input.isolated) return false;
  return input.type !== "pi-wendao-output-only";
}
