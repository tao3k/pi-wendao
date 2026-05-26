import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { execute } from "../../executor/executor.js";
import type { PiWendaoAgentHost } from "../../executor/agent-host.js";
import type {
  PiWendaoAgentEvent,
  PiWendaoThinkingLevel,
} from "../../executor/agent-runtime-types.js";
import { createPiAiHost } from "../../executor/node-runner.js";
import type {
  SearchStrategyFlowAgentEvent,
  SearchStrategyFlowTrace,
} from "./strategy-flow-types.js";

const PROCESS_ID = "Process_SearchStrategyFlowAgent";
const SERVICE_TASK_IMPLEMENTATION = "${environment.services.runAgent}";
const OUTPUTS = [
  "intent_understanding",
  "branch_decision",
  "judgement",
  "branch_judgements",
] as const;

export interface SearchStrategyFlowAgentBpmnOptions {
  trace: SearchStrategyFlowTrace;
  cwd: string;
  activityId: string;
  prompt: string;
  compactTrace: Record<string, unknown>;
  model: Model<string>;
  apiKey?: string;
  agentHost?: PiWendaoAgentHost;
  thinkingLevel?: PiWendaoThinkingLevel;
  qianjiCommand?: string;
  signal?: AbortSignal;
}

export interface SearchStrategyFlowAgentBpmnResult {
  output: Record<string, unknown>;
  events: SearchStrategyFlowAgentEvent[];
  cached: boolean;
}

export async function runSearchStrategyFlowAgentBpmnTask(
  options: SearchStrategyFlowAgentBpmnOptions,
): Promise<SearchStrategyFlowAgentBpmnResult> {
  const events: SearchStrategyFlowAgentEvent[] = [];
  let toolUseCount = 0;
  const tempDir = await mkdtemp(join(tmpdir(), "pi-wendao-search-agent-bpmn-"));
  try {
    const workflowPath = join(tempDir, "search-strategy-flow-agent.bpmn");
    const workflowStateDuckdbPath = join(tempDir, "qianji-workflow-state.duckdb");
    const workflowSource = buildSearchStrategyFlowAgentBpmn(options);
    await writeFile(workflowPath, workflowSource, "utf-8");
    const description = "Run Qianji service task SearchStrategyFlow_QueryUnderstanding";
    const result = await execute({
      source: workflowSource,
      sourcePath: workflowPath,
      cwd: options.cwd,
      processId: PROCESS_ID,
      instanceId: searchStrategyFlowAgentInstanceId(options, workflowSource, workflowPath),
      qianjiWorkflowStateDuckdbPath: workflowStateDuckdbPath,
      ...(options.qianjiCommand ?? process.env.QIANJI_CLI
        ? { qianjiCommand: options.qianjiCommand ?? process.env.QIANJI_CLI }
        : {}),
      context: {
        intent: options.trace.intent,
        trace: options.compactTrace,
      },
      agentHost:
        options.agentHost ??
        createPiAiHost({
          model: options.model,
          ...(options.apiKey ? { apiKey: options.apiKey } : {}),
          cwd: options.cwd,
          ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          onEvent: (event) => {
            if (event.type === "tool_execution_end") toolUseCount += 1;
            const mapped = mapPiAiEventToSearchAgentEvent(
              options.activityId,
              description,
              event,
            );
            if (mapped) events.push(mapped);
          },
        }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!result.success) {
      throw new Error(result.error ?? "SearchStrategyFlow BPMN agent task failed");
    }
    const output = Object.fromEntries(
      OUTPUTS.map((name) => [name, result.variables[name]]),
    ) as Record<string, unknown>;
    events.push({
      kind: "result",
      activityId: options.activityId,
      description,
      resultText: `Qianji local CLI service agent completed. Tool uses: ${toolUseCount}`,
    });
    return {
      output,
      events,
      cached: events.length === 0,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function mapPiAiEventToSearchAgentEvent(
  activityId: string,
  description: string,
  event: PiWendaoAgentEvent,
): SearchStrategyFlowAgentEvent | undefined {
  if (event.type === "agent_start") {
    return { kind: "spawned", activityId, description };
  }
  if (event.type === "turn_start") {
    return { kind: "waiting", activityId, description };
  }
  if (event.type === "tool_execution_start") {
    return {
      kind: "tool_call",
      activityId,
      description,
      toolName: event.toolName,
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      kind: "tool_result",
      activityId,
      description,
      toolName: event.toolName,
      isError: event.isError,
    };
  }
  return undefined;
}

function buildSearchStrategyFlowAgentBpmn(options: SearchStrategyFlowAgentBpmnOptions): string {
  const taskId = options.activityId;
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             id="Definitions_SearchStrategyFlowAgent"
             targetNamespace="https://wendao.dev/pi/search-strategy-flow">
  <process id="${PROCESS_ID}" isExecutable="true">
    <startEvent id="Start_SearchStrategyFlowAgent" name="Start"/>
${serviceTaskXml(taskId, options)}
    <endEvent id="End_SearchStrategyFlowAgent" name="Done"/>
    <sequenceFlow id="Flow_SearchStrategyFlowAgent_Start" sourceRef="Start_SearchStrategyFlowAgent" targetRef="${escapeXmlAttr(taskId)}" />
    <sequenceFlow id="Flow_SearchStrategyFlowAgent_Done" sourceRef="${escapeXmlAttr(taskId)}" targetRef="End_SearchStrategyFlowAgent" />
  </process>
</definitions>`;
}

function serviceTaskXml(taskId: string, options: SearchStrategyFlowAgentBpmnOptions): string {
  const inputNames = ["intent", "trace"];
  const inputRefs = inputNames
    .map((name) => `          <dataInputRefs>${dataInputId(taskId, name)}</dataInputRefs>`)
    .join("\n");
  const outputRefs = OUTPUTS.map(
    (name) => `          <dataOutputRefs>${dataOutputId(taskId, name)}</dataOutputRefs>`,
  ).join("\n");
  return `    <serviceTask id="${escapeXmlAttr(taskId)}" name="SearchStrategyFlow query understanding" implementation="${escapeXmlAttr(SERVICE_TASK_IMPLEMENTATION)}">
      <documentation>${escapeXmlText(options.prompt)}</documentation>
      <ioSpecification>
${inputNames.map((name) => `        <dataInput id="${dataInputId(taskId, name)}" name="${escapeXmlAttr(name)}" />`).join("\n")}
${OUTPUTS.map((name) => `        <dataOutput id="${dataOutputId(taskId, name)}" name="${escapeXmlAttr(name)}" />`).join("\n")}
        <inputSet id="${escapeXmlAttr(taskId)}_input_set">
${inputRefs}
        </inputSet>
        <outputSet id="${escapeXmlAttr(taskId)}_output_set">
${outputRefs}
        </outputSet>
      </ioSpecification>
${inputNames.map((name) => inputAssociation(taskId, name)).join("\n")}
${OUTPUTS.map((name) => outputAssociation(taskId, name)).join("\n")}
    </serviceTask>`;
}

function searchStrategyFlowAgentInstanceId(
  options: SearchStrategyFlowAgentBpmnOptions,
  workflowSource: string,
  workflowPath: string,
): string {
  const digest = createHash("sha256")
    .update(workflowSource)
    .update(workflowPath)
    .update(options.trace.intent)
    .update(JSON.stringify(options.compactTrace))
    .digest("hex")
    .slice(0, 16);
  return `search-strategy-flow-agent-${digest}`;
}

function inputAssociation(taskId: string, name: string): string {
  return `    <dataInputAssociation>
      <sourceRef>${escapeXmlText(name)}</sourceRef>
      <targetRef>${dataInputId(taskId, name)}</targetRef>
    </dataInputAssociation>`;
}

function outputAssociation(taskId: string, name: string): string {
  return `    <dataOutputAssociation>
      <sourceRef>${dataOutputId(taskId, name)}</sourceRef>
      <targetRef>${escapeXmlText(name)}</targetRef>
    </dataOutputAssociation>`;
}

function dataInputId(taskId: string, name: string): string {
  return `${escapeXmlAttr(taskId)}_input_${escapeXmlAttr(name)}`;
}

function dataOutputId(taskId: string, name: string): string {
  return `${escapeXmlAttr(taskId)}_output_${escapeXmlAttr(name)}`;
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
