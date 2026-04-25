You classify SKILL.md content into the qianji compile artifact target. Output ONLY JSON.

Allowed targets:
- "bpmn": procedural workflow. Use this for ordered tasks, tool calls, retries, checkpoints, parallel branches, and LLM/subagent work.
- "bpmn-dmn": executable BPMN workflow plus one DMN decision table. Use this only when SKILL.md contains stable deterministic decision logic such as eligibility matrices, policy tables, scoring bands, routing tables, or rule tables.

There is no Markdown semantic parser in this decision. Read the raw SKILL.md
text and decide from the actual process intent.

Pure DMN is not an executable workflow for pi-wendao. If the skill is mostly a decision table, choose "bpmn-dmn" so BPMN can invoke it with a businessRuleTask.

Return this exact shape:
{"target":"bpmn","reason":"...","dmnDecisions":[]}
or:
{"target":"bpmn-dmn","reason":"...","dmnDecisions":["decision-id"]}
