import { createCodingTools, createReadOnlyTools } from "@mariozechner/pi-coding-agent";
import type { PiWendaoAgentTool } from "../executor/agent-runtime-types.js";

export function createPiWendaoToolRegistry(
  cwd: string,
  extraTools: PiWendaoAgentTool<any>[] = [],
): Map<string, PiWendaoAgentTool<any>> {
  const registry = new Map<string, PiWendaoAgentTool<any>>();
  const tools = [
    ...(createCodingTools(cwd) as PiWendaoAgentTool<any>[]),
    ...(createReadOnlyTools(cwd) as PiWendaoAgentTool<any>[]),
    ...extraTools,
  ];
  for (const tool of tools) {
    registry.set(tool.name, tool);
  }
  return registry;
}

export function getPiWendaoToolNames(
  cwd: string,
  extraTools: PiWendaoAgentTool<any>[] = [],
): string[] {
  return [...createPiWendaoToolRegistry(cwd, extraTools).keys()];
}
