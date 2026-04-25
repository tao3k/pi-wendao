import { createCodingTools, createReadOnlyTools } from "@mariozechner/pi-coding-agent";
import type { SkillscAgentTool } from "../executor/agent-runtime-types.js";

export function createSkillscToolRegistry(
	cwd: string,
	extraTools: SkillscAgentTool<any>[] = [],
): Map<string, SkillscAgentTool<any>> {
	const registry = new Map<string, SkillscAgentTool<any>>();
	const tools = [
		...(createCodingTools(cwd) as SkillscAgentTool<any>[]),
		...(createReadOnlyTools(cwd) as SkillscAgentTool<any>[]),
		...extraTools,
	];
	for (const tool of tools) {
		registry.set(tool.name, tool);
	}
	return registry;
}

export function getSkillscToolNames(cwd: string, extraTools: SkillscAgentTool<any>[] = []): string[] {
	return [...createSkillscToolRegistry(cwd, extraTools).keys()];
}
