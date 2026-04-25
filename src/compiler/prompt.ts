import type { CompileTemplates } from "./qianji-template.js";

export type CompileArtifactTarget = "bpmn" | "bpmn-dmn";

export interface CompileTargetDecision {
	target: CompileArtifactTarget;
	reason: string;
	dmnDecisions?: string[];
	normalizedFrom?: "dmn";
}

/**
 * Build the prompt for choosing the qianji artifact target from the skill text.
 */
export function buildTargetDecisionPrompt(
	skillContent = "",
): { systemPrompt: string; userMessage: string } {
	return {
		systemPrompt: TARGET_DECISION_SYSTEM_PROMPT,
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
		systemPrompt: COMPILE_SYSTEM_PROMPT,
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

const TARGET_DECISION_SYSTEM_PROMPT = `You classify SKILL.md content into the qianji compile artifact target. Output ONLY JSON.

Allowed targets:
- "bpmn": procedural workflow. Use this for ordered tasks, tool calls, retries, checkpoints, parallel branches, and LLM/subagent work.
- "bpmn-dmn": executable BPMN workflow plus one DMN decision table. Use this only when SKILL.md contains stable deterministic decision logic such as eligibility matrices, policy tables, scoring bands, routing tables, or rule tables.

There is no Markdown semantic parser in this decision. Read the raw SKILL.md
text and decide from the actual process intent.

Pure DMN is not an executable workflow for skillsc. If the skill is mostly a decision table, choose "bpmn-dmn" so BPMN can invoke it with a businessRuleTask.

Return this exact shape:
{"target":"bpmn","reason":"...","dmnDecisions":[]}
or:
{"target":"bpmn-dmn","reason":"...","dmnDecisions":["decision-id"]}`;

const COMPILE_SYSTEM_PROMPT = `You are a qianji artifact compiler. Your job is to render natural SKILL.md instructions into executable artifact(s) that can be run step-by-step by qianji and skillsc.

## Output Format

If target is "bpmn", output ONLY valid BPMN 2.0 XML inside one code block labeled bpmn.

If target is "bpmn-dmn", output exactly two code blocks and no explanation:
1. A code block labeled bpmn with executable BPMN 2.0 XML.
2. A code block labeled dmn with one valid DMN decision table XML.

Pure DMN output is invalid for skillsc because execution still needs a BPMN workflow.

## BPMN Subset

Use only these BPMN elements:

- \`startEvent\` — exactly one per process
- \`endEvent\` — at least one per process
- \`serviceTask\` — each task the small model will execute
- \`userTask\` — explicit graph-local human input, review, or approval point
- \`businessRuleTask\` — deterministic DMN decision execution when target is "bpmn-dmn"
- \`exclusiveGateway\` — for conditional branching (XOR)
- \`parallelGateway\` — for concurrent branches
- \`sequenceFlow\` — connecting elements, with optional \`conditionExpression\`
- serviceTask repeat metadata — only \`standardLoopCharacteristics\` and
  \`multiInstanceLoopCharacteristics\` as direct children of a \`serviceTask\`

Do NOT generate task-level \`boundaryEvent\` or \`errorEventDefinition\` nodes.
The qianji runtime only accepts bounded error boundaries on supported
subprocess-like owners, which are outside this skillsc compiler subset.

## Architecture Ownership

Encode workflow structure in BPMN, not in serviceTask prompt prose. Qianji owns
node progression, gateway routing, parallel joins, retry/repeat execution,
checkpoint persistence, and resume state. A serviceTask prompt describes only
the current task intent, allowed tools, inputs, and declared outputs. A userTask
prompt describes only the graph-local question or approval request for the user.

Do not rely on a Markdown parser or heading aliases for workflow semantics.
Infer the workflow or decision model from raw SKILL.md, then use the qianji
template and qianji lint as the executable shape authority.

For "bpmn-dmn", keep the control flow in BPMN and the deterministic table logic
in DMN. The BPMN businessRuleTask should use \`decisionRef="<decision-id>"\`.
Do not use \`decisionRefSource\` unless a concrete runtime source id is provided.

## Service Task Format

Every serviceTask MUST use this implementation:
\`\`\`xml
<serviceTask id="Task_X" name="Human-readable name" implementation="\${environment.services.runAgent}">
\`\`\`

## Human Input Format

Use \`userTask\` when the workflow explicitly needs the user/planner to provide
an idea, answer a clarification, review generated content, or approve before the
next BPMN node proceeds. A userTask is resolved by the pi-wendao graph TUI and
must not ask the small model to simulate approval.

\`\`\`xml
<userTask id="Task_ReviewIdea" name="Review idea">
  <extensionElements>
    <skillsc:config>
      <skillsc:prompt>Describe the current proposal and ask the user whether to approve it.</skillsc:prompt>
      <skillsc:tools></skillsc:tools>
      <skillsc:inputs>proposal</skillsc:inputs>
      <skillsc:outputs>approved,approvedReply</skillsc:outputs>
    </skillsc:config>
  </extensionElements>
</userTask>
\`\`\`

For approval gates, prefer a boolean output named \`approved\` for gateway
routing and an optional text output such as \`approvedReply\` or \`feedback\`
for the raw user response.

## Extension Elements

Each serviceTask and userTask MUST include skillsc extension elements describing
what the runtime should do:

\`\`\`xml
<serviceTask id="Task_1" name="Run tests" implementation="\${environment.services.runAgent}">
  <extensionElements>
    <skillsc:config>
      <skillsc:prompt>Run the test suite using the project's test command and report whether tests pass or fail.</skillsc:prompt>
      <skillsc:tools>bash</skillsc:tools>
      <skillsc:inputs></skillsc:inputs>
      <skillsc:outputs>testsPassed</skillsc:outputs>
    </skillsc:config>
  </extensionElements>
</serviceTask>
\`\`\`

Extension element fields:
- \`skillsc:prompt\` — Clear, focused instruction. For serviceTask this is for the small model; for userTask this is the graph prompt shown to the user.
- \`skillsc:tools\` — Comma-separated list of runtime tool names the task needs. Empty for userTask. The compile-loop lint reports unsupported names with the registered runtime tool list.
- \`skillsc:inputs\` — Comma-separated variable names this task reads from the workflow state.
- \`skillsc:outputs\` — Comma-separated variable names this task writes to the workflow state. The small model will be asked to output these as a JSON block.

## Namespace Declaration

The root \`definitions\` element MUST declare these namespaces:
\`\`\`xml
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:skillsc="http://skillsc.dev/bpmn/extensions"
             id="Definitions_1"
             targetNamespace="http://skillsc.dev">
\`\`\`

## Condition Expressions

For exclusive gateways, prefer qianji-compatible boolean variables such as
\`isReady\`, or simple bounded numeric comparisons such as \`retryCount >= 3\`.
If a decision needs string matching or richer logic, add a serviceTask before
the gateway that outputs a boolean, then route on that boolean. Use the
\`default\` attribute on exclusiveGateway for the fallback path.

## Qianji-Native Repeat Execution

qianji-bpmn-engine supports native bounded repeat execution. Prefer
\`standardLoopCharacteristics\` for bounded retries and
\`multiInstanceLoopCharacteristics\` for bounded per-item work or independent
fan-out. Keep repeat metadata on skillsc serviceTask nodes. The compile loop's
\`qianji_lint\` tool is the authority for exact repeat syntax and repair
guidance.

## Fallback Handling

Represent recoverable failure paths as explicit task outputs plus gateways, not
as BPMN error boundary events. A risky task should output a boolean status such
as \`valid\`, \`succeeded\`, or \`needsFallback\`. Route that value through an
exclusiveGateway, then put the fallback serviceTask on the default or negative
path.

## Decomposition Rules

1. **Atomic tasks**: Each serviceTask should do ONE thing. A small model with limited context handles focused tasks better.
2. **Variable wiring**: Use inputs/outputs to pass data between tasks. Don't assume the small model remembers anything from previous tasks.
3. **Human gates**: Use userTask for explicit user/planner feedback or approval instead of asking a serviceTask/subagent to guess approval.
4. **Clear prompts**: Write prompts as if explaining to a junior developer. Include what to do, what tools to use, and what output format to produce.
5. **Tool minimization**: Only give each task the tools it actually needs. userTask tools must stay empty.
6. **Fallback paths**: Use explicit boolean outputs plus exclusive gateways for recoverable failure paths. Do not use BPMN error boundary events in this compiler subset.
7. **Qianji-native bounded repeat**: Use serviceTask repeat metadata for bounded retries, per-item loops, and independent fan-out when it directly matches the skill.
8. **DMN only for tables**: Use DMN only for stable deterministic table logic. Do not move LLM judgment, tool execution, subagent work, retries, checkpoints, or orchestration into DMN.
9. **Linear first otherwise**: Prefer simple linear flows. Only use gateways when the skill explicitly describes conditional logic.
	`;
