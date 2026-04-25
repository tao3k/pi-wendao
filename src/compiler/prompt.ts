import type { CompileTemplates } from "./qianji-template.js";
import { readPiWendaoPrompt } from "../pi-resources.js";

export type CompileArtifactTarget = "bpmn" | "bpmn-dmn";

export interface CompileTargetDecision {
	target: CompileArtifactTarget;
	reason: string;
	dmnDecisions?: string[];
	normalizedFrom?: "dmn";
}

const TARGET_DECISION_SYSTEM_PROMPT_FILE = "compile-target-decision-system.md";
const COMPILE_SYSTEM_PROMPT_FILE = "compile-artifact-system.md";

/**
 * Build the prompt for choosing the qianji artifact target from the skill text.
 */
export function buildTargetDecisionPrompt(
	skillContent = "",
): { systemPrompt: string; userMessage: string } {
	return {
		systemPrompt: readPiWendaoPrompt(TARGET_DECISION_SYSTEM_PROMPT_FILE),
		userMessage: `Choose the qianji compile artifact target for this SKILL.md.

Raw SKILL.md:
\`\`\`markdown
${skillContent}
\`\`\``,
	};
}

/**
 * Build the system prompt and user message for compiling a skill into qianji artifacts.
 */
export function buildCompilePrompt(
	targetDecision: CompileTargetDecision = { target: "bpmn", reason: "Default to executable BPMN workflow." },
	skillContent = "",
	templates: CompileTemplates = { bpmn: "" },
): { systemPrompt: string; userMessage: string } {
	return {
		systemPrompt: readPiWendaoPrompt(COMPILE_SYSTEM_PROMPT_FILE),
		userMessage: `Compile the following SKILL.md into qianji executable artifact(s):

Read the raw SKILL.md text directly. Do not infer workflow semantics from a
Markdown parser. Use the qianji template(s) below as the executable skeleton and
fill them with the BPMN/DMN structure implied by the skill. qianji lint will
constrain and repair the generated artifact.

Target decision:
\`\`\`json
${JSON.stringify(targetDecision, null, 2)}
\`\`\`

Qianji BPMN template:
\`\`\`bpmn
${templates.bpmn}
\`\`\`

${templates.dmn ? `Qianji DMN template:
\`\`\`dmn
${templates.dmn}
\`\`\`
` : ""}

Raw SKILL.md:
\`\`\`markdown
${skillContent}
\`\`\``,
	};
}
