import { XMLParser } from "fast-xml-parser";
import type { GraphNode, GraphView } from "../ui/graph-view.js";
import type {
  PiWendaoConfig,
  PiWendaoHostWorkKind,
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
  business_rule_tasks?: Record<
    string,
    { output: Record<string, unknown>; matched_rule_ids?: string[] }
  >;
}

type PiWendaoHostTaskElement = Record<string, unknown> & { hostKind: PiWendaoHostWorkKind };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: false,
});

const LEGACY_CUSTOM_LOCAL_NAMES = new Set([
  "config",
  "interaction",
  "choice",
  "choices",
  "freeText",
  "inputs",
  "outputSchema",
  "outputs",
  "prompt",
  "question",
  "result",
  "tools",
  "toolScope",
]);

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
    assertNoLegacyCustomInteractionXml(task, id);
    configs.set(id, readNativeTaskConfig(task));
  }

  return configs;
}

export function populateGraphViewFromBpmn(
  source: string,
  processId: string,
  graphView: GraphView,
): void {
  populateGraphViewFromBpmnInternal(source, processId, graphView);
}

function populateGraphViewFromBpmnInternal(
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

function readNativeTaskConfig(task: PiWendaoHostTaskElement): PiWendaoConfig {
  const nativeIo = readNativeIo(task);
  const prompt = readNativeDocumentation(task);
  const outputs = nativeIo.outputAssociations
    .map((association) => association.targetRef)
    .filter((value): value is string => Boolean(value));
  const inputs = nativeIo.inputAssociations
    .map((association) => association.sourceRef)
    .filter((value): value is string => Boolean(value));
  const interaction = isHumanHostTask(task.hostKind)
    ? readNativeInteraction(task, nativeIo, prompt)
    : undefined;
  return {
    hostKind: task.hostKind,
    prompt,
    tools: [],
    inputs: [...new Set(inputs)],
    outputs: [...new Set(outputs.length > 0 ? outputs : nativeIo.dataOutputNames)],
    ...(interaction ? { interaction } : {}),
  };
}

function isHumanHostTask(kind: PiWendaoHostWorkKind): boolean {
  return kind === "user" || kind === "manual";
}

function readInteractionType(value: string): QianjiInteractionType | undefined {
  return value === "input" || value === "confirm" || value === "choice" || value === "choice_input"
    ? value
    : undefined;
}

interface NativeIoModel {
  dataInputById: Map<string, string>;
  dataOutputById: Map<string, string>;
  dataOutputNames: string[];
  inputAssociations: NativeInputAssociation[];
  outputAssociations: NativeOutputAssociation[];
}

interface NativeInputAssociation {
  sourceRef?: string;
  targetRef?: string;
  assignmentFrom?: string;
  assignmentTo?: string;
}

interface NativeOutputAssociation {
  sourceRef?: string;
  targetRef?: string;
}

function readNativeIo(task: Record<string, unknown>): NativeIoModel {
  const io = firstElement(task, "ioSpecification");
  const dataInputById = new Map<string, string>();
  const dataOutputById = new Map<string, string>();
  const dataOutputNames: string[] = [];
  if (io) {
    for (const input of readElements(io, "dataInput")) {
      const id = readString(input.id);
      const name = readString(input.name);
      if (id && name) dataInputById.set(id, name);
    }
    for (const output of readElements(io, "dataOutput")) {
      const id = readString(output.id);
      const name = readString(output.name);
      if (id && name) {
        dataOutputById.set(id, name);
        dataOutputNames.push(name);
      }
    }
  }
  return {
    dataInputById,
    dataOutputById,
    dataOutputNames,
    inputAssociations: readElements(task, "dataInputAssociation").map(readNativeInputAssociation),
    outputAssociations: readElements(task, "dataOutputAssociation").map(readNativeOutputAssociation),
  };
}

function readNativeInputAssociation(association: Record<string, unknown>): NativeInputAssociation {
  const assignment = firstElement(association, "assignment");
  return {
    sourceRef: readText(firstElementValue(association, "sourceRef")).trim() || undefined,
    targetRef: readText(firstElementValue(association, "targetRef")).trim() || undefined,
    assignmentFrom: assignment
      ? readText(firstElementValue(assignment, "from")).trim() || undefined
      : undefined,
    assignmentTo: assignment
      ? readText(firstElementValue(assignment, "to")).trim() || undefined
      : undefined,
  };
}

function readNativeOutputAssociation(
  association: Record<string, unknown>,
): NativeOutputAssociation {
  return {
    sourceRef: readText(firstElementValue(association, "sourceRef")).trim() || undefined,
    targetRef: readText(firstElementValue(association, "targetRef")).trim() || undefined,
  };
}

function readNativeInteraction(
  task: PiWendaoHostTaskElement,
  nativeIo: NativeIoModel,
  documentation: string,
): QianjiInteraction | undefined {
  const type = readInteractionType(readNativeInputLiteral(nativeIo, "interactionType") || "input");
  if (!type) return undefined;
  const questionRef = readNativeInputSource(nativeIo, "question");
  const choicesRef = readNativeInputSource(nativeIo, "choices");
  const choices = readNativeChoicesLiteral(readNativeInputLiteral(nativeIo, "choices"));
  const freeText = readNativeFreeTextLiteral(readNativeInputLiteral(nativeIo, "freeText"));
  const result = readNativeAnswerResult(nativeIo);
  return {
    type,
    ...(documentation ? { question: documentation } : {}),
    ...(questionRef ? { questionRef } : {}),
    ...(choices.length > 0 ? { choices } : {}),
    ...(choicesRef ? { choicesRef } : {}),
    ...(freeText ? { freeText } : {}),
    ...(result ? { result } : {}),
  };
}

function readNativeInputLiteral(nativeIo: NativeIoModel, inputName: string): string {
  return (
    nativeIo.inputAssociations
      .find((association) => nativeInputName(nativeIo, association) === inputName)
      ?.assignmentFrom?.trim() ?? ""
  );
}

function readNativeInputSource(nativeIo: NativeIoModel, inputName: string): string | undefined {
  return nativeIo.inputAssociations
    .find((association) => nativeInputName(nativeIo, association) === inputName)
    ?.sourceRef?.trim();
}

function nativeInputName(
  nativeIo: NativeIoModel,
  association: NativeInputAssociation,
): string | undefined {
  const target = association.targetRef ?? association.assignmentTo;
  return target ? nativeIo.dataInputById.get(target.trim()) : undefined;
}

function readNativeAnswerResult(nativeIo: NativeIoModel): QianjiInteractionResult | undefined {
  const association = nativeIo.outputAssociations.find((candidate) => {
    const source = candidate.sourceRef?.trim();
    return source ? nativeIo.dataOutputById.get(source) === "answer" : false;
  });
  const output = association?.targetRef?.trim();
  return output ? { output } : undefined;
}

function readNativeChoicesLiteral(value: string): QianjiInteractionChoice[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  return asArray(parsed)
    .map((choice) => {
      if (typeof choice === "string") return { value: choice };
      if (!isObject(choice)) return undefined;
      const result = {
        value: readString(choice.value),
        ...(readString(choice.label) ? { label: readString(choice.label) } : {}),
        ...(readString(choice.description) ? { description: readString(choice.description) } : {}),
      };
      return result.value ? result : undefined;
    })
    .filter((choice): choice is QianjiInteractionChoice => Boolean(choice));
}

function readNativeFreeTextLiteral(value: string): QianjiInteractionFreeText | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = value;
  }
  if (typeof parsed === "string") return parsed ? { name: parsed } : undefined;
  if (!isObject(parsed)) return undefined;
  const result: QianjiInteractionFreeText = {};
  const name = readString(parsed.name);
  const placeholder = readString(parsed.placeholder);
  const optional = readOptionalBoolean(parsed.optional);
  if (name) result.name = name;
  if (placeholder) result.placeholder = placeholder;
  if (optional !== undefined) result.optional = optional;
  return Object.keys(result).length > 0 ? result : undefined;
}

function readNativeDocumentation(task: Record<string, unknown>): string {
  return readText(firstElementValue(task, "documentation")).trim();
}

function assertNoLegacyCustomInteractionXml(task: Record<string, unknown>, taskId: string): void {
  const extensionElements = firstObject(task.extensionElements);
  if (!extensionElements) return;
  for (const key of Object.keys(extensionElements)) {
    if (key.includes(":") && LEGACY_CUSTOM_LOCAL_NAMES.has(key.split(":").at(-1) ?? "")) {
      throw new Error(
        [
          "[pi-wendao.runtime.legacy_custom_interaction_xml]",
          `BPMN task '${taskId}' uses legacy custom QName interaction XML.`,
          "Use native BPMN documentation, ioSpecification, dataInputAssociation, and dataOutputAssociation metadata.",
        ].join("\n"),
      );
    }
  }
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

function readElements(parent: Record<string, unknown>, localName: string): Record<string, unknown>[] {
  return asArray(firstElementValue(parent, localName)).filter(isObject);
}

function firstElement(parent: Record<string, unknown>, localName: string): Record<string, unknown> | undefined {
  return firstObject(firstElementValue(parent, localName));
}

function firstElementValue(parent: Record<string, unknown>, localName: string): unknown {
  return parent[localName] ?? parent[`bpmn:${localName}`];
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
