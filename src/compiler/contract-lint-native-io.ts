import { asArray, firstObject, isObject, readString, readText } from "./json.js";

export const INTERACTION_TYPES = new Set(["input", "confirm", "choice", "choice_input"]);
export const CHOICE_INTERACTION_TYPES = new Set(["choice", "choice_input"]);

export interface NativeInteraction {
  type?: string;
  choicesRef?: string;
  choices?: unknown[];
  resultOutput?: string;
}

export function readNativeInteraction(task: Record<string, unknown>): NativeInteraction | undefined {
  const type = readInputAssignment(task, "interactionType");
  const choicesRef = readInputSource(task, "choices");
  const choicesLiteral = readInputAssignment(task, "choices");
  const choices = choicesLiteral ? parseJsonArray(choicesLiteral) : undefined;
  const resultOutput = readAnswerTarget(task);
  if (!type && !choicesRef && !choices?.length && !resultOutput) return undefined;
  return { type, choicesRef, choices, resultOutput };
}

export function readInputAssignment(task: Record<string, unknown>, inputName: string): string | undefined {
  const inputIds = inputIdsByName(task, inputName);
  const assignment = readElements(task, "dataInputAssociation")
    .map((association) => firstElement(association, "assignment"))
    .filter(isObject)
    .find((candidate) => inputIds.has(readText(firstElementValue(candidate, "to")).trim()));
  const value = assignment ? readText(firstElementValue(assignment, "from")).trim() : "";
  return value || undefined;
}

export function readInputSource(task: Record<string, unknown>, inputName: string): string | undefined {
  const inputIds = inputIdsByName(task, inputName);
  const association = readElements(task, "dataInputAssociation").find((candidate) =>
    inputIds.has(readText(firstElementValue(candidate, "targetRef")).trim()),
  );
  const value = association ? readText(firstElementValue(association, "sourceRef")).trim() : "";
  return value || undefined;
}

export function readAnswerTarget(task: Record<string, unknown>): string | undefined {
  const outputIds = outputIdsByName(task, "answer");
  const association = readElements(task, "dataOutputAssociation").find((candidate) =>
    outputIds.has(readText(firstElementValue(candidate, "sourceRef")).trim()),
  );
  const value = association ? readText(firstElementValue(association, "targetRef")).trim() : "";
  return value || undefined;
}

export function nativeInputSources(task: Record<string, unknown>): string[] {
  return readElements(task, "dataInputAssociation")
    .map((association) => readText(firstElementValue(association, "sourceRef")).trim())
    .filter(Boolean);
}

export function nativeOutputTargets(task: Record<string, unknown>): string[] {
  return readElements(task, "dataOutputAssociation")
    .map((association) => readText(firstElementValue(association, "targetRef")).trim())
    .filter(Boolean);
}

export function inputIdsByName(task: Record<string, unknown>, name: string): Set<string> {
  const io = firstElement(task, "ioSpecification");
  return new Set(readElements(io ?? {}, "dataInput").filter((input) => readString(input.name) === name).map((input) => readString(input.id)));
}

export function outputIdsByName(task: Record<string, unknown>, name: string): Set<string> {
  const io = firstElement(task, "ioSpecification");
  return new Set(readElements(io ?? {}, "dataOutput").filter((output) => readString(output.name) === name).map((output) => readString(output.id)));
}

export function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function readDocumentation(task: Record<string, unknown>): string {
  return readText(firstElementValue(task, "documentation")).trim();
}

export function serviceTaskAppearsToCollectHumanInput(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return [
    "ask the user",
    "ask user",
    "ask the patient",
    "ask patient",
    "ask the human",
    "one question at a time",
    "collect both answers",
    "collect all answers",
    "free-form answer",
  ].some((needle) => normalized.includes(needle));
}

export function nativeInteractiveRepairPlan(): string {
  return [
    "Use a serviceTask producer for dynamic question data when needed, then a userTask with native IO metadata.",
    '<serviceTask id="Task_PrepareQuestion" implementation="${environment.services.runAgent}">',
    "  <documentation>Return currentQuestion and currentChoices.</documentation>",
    "  <ioSpecification>... dataOutput name=\"currentQuestion\" and dataOutput name=\"currentChoices\" ...</ioSpecification>",
    "</serviceTask>",
    '<userTask id="Task_AnswerQuestion">',
    "  <documentation>Answer the generated question.</documentation>",
    "  <ioSpecification>... dataInput name=\"interactionType\", dataInput name=\"question\", dataInput name=\"choices\", dataOutput name=\"answer\" ...</ioSpecification>",
    "  <dataInputAssociation><assignment><from>choice_input</from><to>Task_AnswerQuestion_input_interactionType</to></assignment></dataInputAssociation>",
    "  <dataInputAssociation><sourceRef>currentQuestion</sourceRef><targetRef>Task_AnswerQuestion_input_question</targetRef></dataInputAssociation>",
    "  <dataInputAssociation><sourceRef>currentChoices</sourceRef><targetRef>Task_AnswerQuestion_input_choices</targetRef></dataInputAssociation>",
    "  <dataOutputAssociation><sourceRef>Task_AnswerQuestion_output_answer</sourceRef><targetRef>answer</targetRef></dataOutputAssociation>",
    "</userTask>",
  ].join("\n");
}

export function readElements(parent: Record<string, unknown>, localName: string): Record<string, unknown>[] {
  return asArray(firstElementValue(parent, localName)).filter(isObject);
}

export function firstElement(parent: Record<string, unknown>, localName: string): Record<string, unknown> | undefined {
  return firstObject(firstElementValue(parent, localName));
}

export function firstElementValue(parent: Record<string, unknown>, localName: string): unknown {
  return parent[localName] ?? parent[`bpmn:${localName}`];
}
