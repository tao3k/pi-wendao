import { XMLParser } from "fast-xml-parser";
import type { GraphNode, GraphView } from "../ui/graph-view.js";
import type {
  PiWendaoConfig,
  PiWendaoHostWorkKind,
  PiWendaoSubagentConfig,
  QianjiInteraction,
  QianjiInteractionChoice,
  QianjiInteractionFreeText,
  QianjiInteractionResult,
  QianjiInteractionType,
} from "./agent-host.js";
import { asArray, isObject } from "./data.js";

export interface HostCompletionFixture {
  send_tasks?: Record<string, { data: Record<string, unknown> }>;
  service_tasks?: Record<string, { data: Record<string, unknown> }>;
  service_task_tokens?: Record<string, { data: Record<string, unknown> }>;
  user_tasks?: Record<string, { data: Record<string, unknown> }>;
  manual_tasks?: Record<string, { data: Record<string, unknown> }>;
}

type PiWendaoHostTaskElement = Record<string, unknown> & { hostKind: PiWendaoHostWorkKind };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: false,
});
const QIANJI_CONFIG_ELEMENT = "qianji:config";
const QIANJI_INTERACTION_ELEMENT = "qianji:interaction";

const GRAPH_NODE_SPECS: Array<{ element: string; type: GraphNode["type"] }> = [
  { element: "startEvent", type: "start" },
  { element: "endEvent", type: "end" },
  { element: "serviceTask", type: "task" },
  { element: "task", type: "task" },
  { element: "userTask", type: "task" },
  { element: "scriptTask", type: "task" },
  { element: "businessRuleTask", type: "task" },
  { element: "sendTask", type: "task" },
  { element: "receiveTask", type: "task" },
  { element: "manualTask", type: "task" },
  { element: "callActivity", type: "task" },
  { element: "subProcess", type: "task" },
  { element: "exclusiveGateway", type: "gateway" },
  { element: "parallelGateway", type: "gateway" },
  { element: "inclusiveGateway", type: "gateway" },
  { element: "eventBasedGateway", type: "gateway" },
  { element: "complexGateway", type: "gateway" },
  { element: "boundaryEvent", type: "boundary" },
  { element: "intermediateCatchEvent", type: "boundary" },
  { element: "intermediateThrowEvent", type: "boundary" },
];

const PI_WENDAO_HOST_TASK_ELEMENTS: Array<{ element: string; hostKind: PiWendaoHostWorkKind }> = [
  { element: "serviceTask", hostKind: "service" },
  { element: "userTask", hostKind: "user" },
  { element: "manualTask", hostKind: "manual" },
  { element: "sendTask", hostKind: "send" },
];

export function buildDefaultHostFixture(
  source: string,
  context: Record<string, unknown>,
): HostCompletionFixture | undefined {
  const document = parser.parse(source) as { definitions?: { process?: unknown } };
  const tasks = collectPiWendaoHostTasks(document.definitions?.process).filter(
    (task) => task.hostKind === "service" || task.hostKind === "user" || task.hostKind === "manual",
  );
  if (tasks.length === 0) return undefined;

  const fixture: HostCompletionFixture = {};
  for (const task of tasks) {
    const taskId = typeof task.id === "string" ? task.id.trim() : "";
    if (!taskId) continue;
    const data: Record<string, unknown> = {};
    for (const outputName of extractPiWendaoOutputs(task)) {
      data[outputName] = Object.prototype.hasOwnProperty.call(context, outputName)
        ? context[outputName]
        : defaultFixtureValue(outputName);
    }
    addStaticHostFixtureEntry(fixture, task.hostKind, taskId, data);
  }

  return hasHostCompletionResults(fixture) ? fixture : undefined;
}

export function buildPiWendaoConfigMap(
  source: string,
  processId: string,
): Map<string, PiWendaoConfig> {
  const document = parser.parse(source) as { definitions?: { process?: unknown } };
  const process = findProcess(document.definitions?.process, processId);
  const configs = new Map<string, PiWendaoConfig>();
  if (!process) return configs;

  for (const task of collectPiWendaoHostTasks(process)) {
    const id = readString(task.id);
    if (!id) continue;
    const extensionElements = task.extensionElements;
    if (!isObject(extensionElements)) continue;
    const config = readQianjiConfig(extensionElements);
    if (!config) continue;
    configs.set(id, {
      hostKind: task.hostKind,
      prompt: readQianjiText(config, "prompt"),
      tools: csv(readQianjiText(config, "tools")),
      inputs: csv(readQianjiText(config, "inputs")),
      outputs: csv(readQianjiText(config, "outputs")),
      interaction: readQianjiInteraction(config),
      subagent: readPiWendaoSubagentConfig(config),
    });
  }

  return configs;
}

export function populateGraphViewFromBpmn(
  source: string,
  processId: string,
  graphView: GraphView,
): void {
  const document = parser.parse(source) as { definitions?: { process?: unknown } };
  const process = findProcess(document.definitions?.process, processId);
  if (!process) {
    throw new Error(`BPMN source does not declare process ${processId}`);
  }

  graphView.clear();
  for (const spec of GRAPH_NODE_SPECS) {
    for (const element of asArray(process[spec.element])) {
      if (!isObject(element)) continue;
      const id = readString(element.id);
      if (!id) continue;
      graphView.addNode({
        id,
        label: readString(element.name) || id,
        type: spec.type,
        status: "pending",
      });
    }
  }

  for (const flow of asArray(process.sequenceFlow)) {
    if (!isObject(flow)) continue;
    const sourceRef = readString(flow.sourceRef);
    const targetRef = readString(flow.targetRef);
    if (!sourceRef || !targetRef) continue;
    graphView.addEdge({
      source: sourceRef,
      target: targetRef,
      label: readString(flow.name) || undefined,
      taken: false,
    });
  }
}

export function extractFirstProcessId(source: string): string {
  const document = parser.parse(source) as { definitions?: { process?: unknown } };
  const processes = asArray(document.definitions?.process);
  for (const process of processes) {
    if (isObject(process) && typeof process.id === "string" && process.id.trim()) {
      return process.id;
    }
  }
  throw new Error("BPMN source does not declare a process id; pass --process explicitly");
}

export function parseVariablePairs(pairs: string[] | undefined): Record<string, unknown> {
  const variables: Record<string, unknown> = {};
  for (const pair of pairs ?? []) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    variables[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return variables;
}

export function hasHostCompletionResults(fixture: HostCompletionFixture): boolean {
  return Object.values(fixture).some((bucket) => bucket && Object.keys(bucket).length > 0);
}

function addStaticHostFixtureEntry(
  fixture: HostCompletionFixture,
  hostKind: PiWendaoHostWorkKind,
  taskId: string,
  data: Record<string, unknown>,
): void {
  switch (hostKind) {
    case "user":
      fixture.user_tasks ??= {};
      fixture.user_tasks[taskId] = { data };
      return;
    case "manual":
      fixture.manual_tasks ??= {};
      fixture.manual_tasks[taskId] = { data };
      return;
    case "service":
    default:
      fixture.service_tasks ??= {};
      fixture.service_tasks[taskId] = { data };
      return;
  }
}

function readPiWendaoSubagentConfig(
  config: Record<string, unknown>,
): PiWendaoSubagentConfig | undefined {
  const subagent: PiWendaoSubagentConfig = {};
  const type = readQianjiText(config, "agentType").trim();
  const description = readQianjiText(config, "agentDescription").trim();
  const runInBackground = readOptionalBoolean(config["qianji:runInBackground"]);
  const maxTurns = readOptionalNumber(config["qianji:maxTurns"]);
  const isolated = readOptionalBoolean(config["qianji:isolated"]);
  const inheritContext = readOptionalBoolean(config["qianji:inheritContext"]);
  const model = readQianjiText(config, "agentModel").trim();
  const thinking = readQianjiText(config, "thinking").trim();
  const isolation = readQianjiText(config, "isolation").trim();

  if (type) subagent.type = type;
  if (description) subagent.description = description;
  if (runInBackground !== undefined) subagent.runInBackground = runInBackground;
  if (model) subagent.model = model;
  if (thinking) subagent.thinking = thinking;
  if (maxTurns !== undefined) subagent.maxTurns = maxTurns;
  if (isolated !== undefined) subagent.isolated = isolated;
  if (isolation) subagent.isolation = isolation;
  if (inheritContext !== undefined) subagent.inheritContext = inheritContext;

  return Object.keys(subagent).length > 0 ? subagent : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  const text = readText(value).trim().toLowerCase();
  if (!text) return undefined;
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  return undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  const text = readText(value).trim();
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function defaultFixtureValue(outputName: string): unknown {
  const normalized = outputName.toLowerCase();
  if (normalized === "retrycount") return 3;
  if (normalized === "status") return "ready";
  if (normalized === "resulta") return "alpha";
  if (normalized === "resultb") return "beta";
  if (normalized === "merged") return "alpha beta";
  if (normalized === "reason") return "validation failed";
  if (normalized === "filecount" || normalized.endsWith("count")) return 0;
  if (normalized.endsWith("list") || normalized.endsWith("items")) return [];
  if (
    normalized.startsWith("is") ||
    normalized.startsWith("has") ||
    normalized.startsWith("can") ||
    normalized.startsWith("should")
  ) {
    return !normalized.includes("rejected") && !normalized.includes("failed");
  }
  if (normalized === "valid" || normalized === "published" || normalized === "ready") return true;
  if (normalized === "rejected" || normalized === "failed") return false;
  return null;
}

function collectPiWendaoHostTasks(processes: unknown): PiWendaoHostTaskElement[] {
  const tasks: PiWendaoHostTaskElement[] = [];
  for (const process of asArray(processes)) {
    if (!isObject(process)) continue;
    for (const spec of PI_WENDAO_HOST_TASK_ELEMENTS) {
      for (const task of asArray(process[spec.element])) {
        if (isObject(task)) tasks.push({ ...task, hostKind: spec.hostKind });
      }
    }
  }
  return tasks;
}

function extractPiWendaoOutputs(task: Record<string, unknown>): string[] {
  const extensionElements = task.extensionElements;
  if (!isObject(extensionElements)) return [];
  const config = readQianjiConfig(extensionElements);
  if (!config) return [];
  return csv(readQianjiText(config, "outputs"));
}

function readQianjiConfig(
  extensionElements: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return firstObject(extensionElements[QIANJI_CONFIG_ELEMENT]);
}

function readQianjiText(config: Record<string, unknown>, field: string): string {
  return readText(config[`qianji:${field}`]);
}

function readQianjiInteraction(config: Record<string, unknown>): QianjiInteraction | undefined {
  const interaction = firstObject(config[QIANJI_INTERACTION_ELEMENT]);
  if (!interaction) return undefined;
  const type = readInteractionType(readString(interaction.type) || "input");
  if (!type) return undefined;
  const question = readQianjiQuestion(interaction, csv(readQianjiText(config, "inputs")));
  const choices = readQianjiChoices(interaction);
  const choicesRef = readQianjiChoicesRef(interaction);
  const freeText = readQianjiFreeText(interaction);
  const result = readQianjiResult(interaction);
  return {
    type,
    ...(question.text ? { question: question.text } : {}),
    ...(question.ref ? { questionRef: question.ref } : {}),
    ...(choices.length > 0 ? { choices } : {}),
    ...(choicesRef ? { choicesRef } : {}),
    ...(freeText ? { freeText } : {}),
    ...(result ? { result } : {}),
  };
}

function readQianjiQuestion(
  interaction: Record<string, unknown>,
  inputs: string[],
): { text?: string; ref?: string } {
  const questionElement = interaction["qianji:question"];
  const questionObject = firstObject(questionElement);
  const explicitRef = questionObject ? readString(questionObject.ref) : "";
  if (explicitRef) return { ref: explicitRef };

  const text = readText(questionElement).trim();
  if (inputs.includes(text)) return { ref: text };
  return text ? { text } : {};
}

function readInteractionType(value: string): QianjiInteractionType | undefined {
  return value === "input" || value === "confirm" || value === "choice" || value === "choice_input"
    ? value
    : undefined;
}

function readQianjiChoices(interaction: Record<string, unknown>): QianjiInteractionChoice[] {
  return asArray(interaction["qianji:choice"])
    .filter(isObject)
    .map((choice) => ({
      value: readString(choice.value),
      ...(readString(choice.label) ? { label: readString(choice.label) } : {}),
      ...(readText(choice).trim() ? { description: readText(choice).trim() } : {}),
    }))
    .filter((choice) => choice.value.length > 0);
}

function readQianjiChoicesRef(interaction: Record<string, unknown>): string | undefined {
  const choices = firstObject(interaction["qianji:choices"]);
  const ref = choices ? readString(choices.ref) : "";
  return ref || undefined;
}

function readQianjiFreeText(
  interaction: Record<string, unknown>,
): QianjiInteractionFreeText | undefined {
  const freeText = firstObject(interaction["qianji:freeText"]);
  if (!freeText) return undefined;
  const result: QianjiInteractionFreeText = {};
  const name = readString(freeText.name);
  const placeholder = readString(freeText.placeholder);
  const optional = readOptionalBoolean(freeText.optional);
  if (name) result.name = name;
  if (placeholder) result.placeholder = placeholder;
  if (optional !== undefined) result.optional = optional;
  return Object.keys(result).length > 0 ? result : {};
}

function readQianjiResult(
  interaction: Record<string, unknown>,
): QianjiInteractionResult | undefined {
  const resultConfig = firstObject(interaction["qianji:result"]);
  if (!resultConfig) return undefined;
  const output = readString(resultConfig.output);
  return output ? { output } : {};
}

function findProcess(processes: unknown, processId: string): Record<string, unknown> | undefined {
  for (const process of asArray(processes)) {
    if (isObject(process) && readString(process.id) === processId) {
      return process;
    }
  }
  return undefined;
}

function csv(value: string): string[] {
  if (!value.trim()) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstObject(value: unknown): Record<string, unknown> | undefined {
  const first = asArray(value).find(isObject);
  return first;
}

function readText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isObject(value) && typeof value["#text"] === "string") return value["#text"];
  return "";
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
