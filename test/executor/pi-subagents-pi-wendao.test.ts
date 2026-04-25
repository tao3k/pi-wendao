import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeBpmnWithPiSubagents } from "../../src/executor/pi-subagents-pi-wendao.js";
import type {
	PiLoadedExtensionsLike,
	PiRegisteredToolDefinition,
} from "../../src/executor/pi-subagents-runtime.js";

const tempDirs: string[] = [];

describe("pi-subagents pi-wendao runtime bridge", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("executes qianji host work through loaded pi-subagents tools and reuses cached results", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-wendao-pi-bridge-"));
		tempDirs.push(dir);
		const workflowPath = join(dir, "workflow.bpmn");
		const storePath = join(dir, "subagents.json");
		writeFileSync(workflowPath, tokenScopedServiceTaskWorkflow(), "utf-8");

		const starts: Record<string, number> = {};
		const agentCalls: string[] = [];
		const getResultCalls: string[] = [];
		const ctx = { cwd: dir };
		const loadResult = loadedExtensions({
			Agent: async (params, receivedCtx) => {
				expect(receivedCtx).toBe(ctx);
				const prompt = String(params.prompt);
				const item = prompt.includes('item: "alpha"') ? "alpha" : "beta";
				starts[item] = performance.now();
				agentCalls.push(item);
				await delay(80);
				return {
					content: [{ type: "text", text: `Agent ID: agent-${item}\n` }],
					details: { agentId: `agent-${item}` },
				};
			},
			get_subagent_result: async (params, receivedCtx) => {
				expect(receivedCtx).toBe(ctx);
				const agentId = String(params.agent_id);
				getResultCalls.push(agentId);
				const item = agentId.endsWith("alpha") ? "alpha" : "beta";
				return {
					content: [{
						type: "text",
						text: `Done.\n\`\`\`json\n{"result":"${item}_done"}\n\`\`\``,
					}],
				};
			},
		});

		const result = await executeBpmnWithPiSubagents({
			workflowPath,
			loadResult,
			ctx,
			qianjiCommand: makeFakeExternalHostQianjiCommand(),
			instanceId: "pi-wendao-pi-bridge-instance",
			processId: "Process_1",
			context: { items: ["alpha", "beta"] },
			runStorePath: storePath,
			toolCallIdPrefix: "bridge-test",
		});

		expect(result.success).toBe(true);
		expect(result.rawOutput).not.toContain("@@QIANJI_HOST_WORK");
		expect(Math.abs(starts.beta - starts.alpha)).toBeLessThan(60);
		expect(agentCalls).toEqual(["alpha", "beta"]);
		expect(getResultCalls).toEqual(["agent-alpha", "agent-beta"]);
		expect(result.variables).toMatchObject({
			results: ["alpha_done", "beta_done"],
			fixtureServiceTaskTokens: ["11", "12"],
		});

		const cachedResult = await executeBpmnWithPiSubagents({
			workflowPath,
			loadResult: throwingLoadedExtensions(),
			ctx,
			qianjiCommand: makeFakeExternalHostQianjiCommand(),
			instanceId: "pi-wendao-pi-bridge-instance",
			processId: "Process_1",
			context: { items: ["alpha", "beta"] },
			runStorePath: storePath,
		});

		expect(cachedResult.success).toBe(true);
		expect(cachedResult.variables).toMatchObject({
			results: ["alpha_done", "beta_done"],
			fixtureServiceTaskTokens: ["11", "12"],
		});
		expect(agentCalls).toHaveLength(2);
		expect(getResultCalls).toHaveLength(2);
	});
});

function loadedExtensions(tools: {
	Agent: ToolExecute;
	get_subagent_result: ToolExecute;
}): PiLoadedExtensionsLike {
	return {
		extensions: [{
			tools: new Map([
				["Agent", { definition: tool("Agent", tools.Agent) }],
				["get_subagent_result", {
					definition: tool("get_subagent_result", tools.get_subagent_result),
				}],
			]),
		}],
	};
}

function throwingLoadedExtensions(): PiLoadedExtensionsLike {
	return loadedExtensions({
		Agent: async () => {
			throw new Error("cached bridge run should not spawn another subagent");
		},
		get_subagent_result: async () => {
			throw new Error("cached bridge run should not fetch another subagent result");
		},
	});
}

type ToolExecute = (
	params: Record<string, unknown>,
	ctx: unknown,
) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;

function tool(name: string, execute: ToolExecute): PiRegisteredToolDefinition {
	return {
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			expect(toolCallId).toContain(name);
			return execute(params, ctx);
		},
	};
}

function makeFakeExternalHostQianjiCommand(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-pi-bridge-"));
	tempDirs.push(dir);
	const scriptPath = join(dir, "fake-qianji-external-host.cjs");
	writeFakeExternalHostQianjiScript(scriptPath);
	return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function writeFakeExternalHostQianjiScript(scriptPath: string): void {
	writeFileSync(scriptPath, `
const { readFileSync } = require("fs");
const args = process.argv.slice(2);
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const fence = String.fromCharCode(96, 96, 96);
const printVariables = (title, outcome, variables) => {
  console.log("# " + title + "\\n\\nOutcome: " + outcome + "\\n\\n## Variables\\n" + fence + "json\\n" + JSON.stringify(variables, null, 2) + "\\n" + fence + "\\n");
};

if (args[0] !== "bpmn") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}

if (args[1] === "run") {
  const processId = get("--process") || "Process_1";
  const context = JSON.parse(get("--context-json") || "{}");
  console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", process_id: processId, node_id: "Task_Review", node_kind: "service_task", status: "executing" }));
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: "Task_Review",
    node_index: 2,
    token_id: 11,
    variables: { item: "alpha" },
    repeat: { item: "alpha", index: 0 }
  }));
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: "Task_Review",
    node_index: 2,
    token_id: 12,
    variables: { item: "beta" },
    repeat: { item: "beta", index: 1 }
  }));
  printVariables("BPMN Run", "blocked_on_host", { items: context.items || [] });
  process.exit(0);
}

if (args[1] === "tasks" && args[2] === "complete") {
  const hostFixture = JSON.parse(readFileSync(get("--host-fixture"), "utf-8"));
  const tokens = hostFixture.service_task_tokens || {};
  const tokenIds = Object.keys(tokens).sort((a, b) => Number(a) - Number(b));
  console.log("@@QIANJI_TRACE " + JSON.stringify({ kind: "node_status", node_id: "Task_Review", node_kind: "service_task", status: "completed" }));
  printVariables("BPMN Task Complete", "completed", {
    results: tokenIds.map((id) => tokens[id].data.result),
    fixtureServiceTaskTokens: tokenIds
  });
  process.exit(0);
}

console.error("unexpected qianji args: " + args.join(" "));
process.exit(64);
`, "utf-8");
}

function tokenScopedServiceTaskWorkflow(): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:skillsc="https://xiuxian.dev/skillsc"
             targetNamespace="https://xiuxian.dev/skillsc/test">
  <process id="Process_1" isExecutable="true">
    <startEvent id="Start_1" name="Start">
      <outgoing>Flow_1</outgoing>
    </startEvent>
    <serviceTask id="Task_Review" name="Review item" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <skillsc:config>
          <skillsc:prompt>Review \${environment.variables.item}.</skillsc:prompt>
          <skillsc:tools>bash, read</skillsc:tools>
          <skillsc:inputs>item</skillsc:inputs>
          <skillsc:outputs>result</skillsc:outputs>
          <skillsc:agentType>pi-wendao-worker</skillsc:agentType>
          <skillsc:agentDescription>Review one parallel item</skillsc:agentDescription>
          <skillsc:runInBackground>true</skillsc:runInBackground>
          <skillsc:maxTurns>4</skillsc:maxTurns>
        </skillsc:config>
      </extensionElements>
      <incoming>Flow_1</incoming>
      <outgoing>Flow_2</outgoing>
    </serviceTask>
    <endEvent id="End_1" name="Done">
      <incoming>Flow_2</incoming>
    </endEvent>
    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Review" />
    <sequenceFlow id="Flow_2" sourceRef="Task_Review" targetRef="End_1" />
  </process>
</definitions>`;
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
