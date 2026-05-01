import { XMLParser } from "fast-xml-parser";
import type {
  BpmnLintResult,
  BpmnLintRunner,
  CompileTargetDecision,
  QianjiGatewayCondition,
} from "./types.js";
import { asArray, firstObject, isObject, readString, readText } from "./json.js";

const SERVICE_TASK_IMPLEMENTATION = "${environment.services.runAgent}";
const PI_WENDAO_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INTERACTION_TYPES = new Set(["input", "confirm", "choice", "choice_input"]);
const CHOICE_INTERACTION_TYPES = new Set(["choice", "choice_input"]);
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

const piWendaoContractParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: false,
});

interface ParsedBpmnDocument {
  definitions?: { process?: unknown };
  "bpmn:definitions"?: { process?: unknown; "bpmn:process"?: unknown };
}

export function createCompileLintRunner(
  qianjiLintRunner: BpmnLintRunner,
  options: { cwd: string; targetDecision?: CompileTargetDecision },
): BpmnLintRunner {
  return async (xml: string) => {
    const qianjiLint = await qianjiLintRunner(xml);
    if (!qianjiLint.success && qianjiLint.output.includes("[bpmn.invalid_xml]")) {
      return qianjiLint;
    }

    const contractLint = lintPiWendaoWorkflowContract(xml, {
      ...options,
      gatewayConditions: qianjiLint.qianji?.analysis?.gateway_conditions ?? [],
    });
    if (qianjiLint.success && contractLint.success) {
      return {
        ...qianjiLint,
        diagnostics: {
          ...(qianjiLint.diagnostics ?? { qianji: qianjiLint.output }),
          contract: contractLint.output,
        },
      };
    }

    const output = [qianjiLint.output.trim(), contractLint.success ? undefined : contractLint.output.trim()]
      .filter(Boolean)
      .join("\n\n");
    return {
      success: false,
      output,
      diagnostics: {
        ...(qianjiLint.diagnostics ?? { qianji: qianjiLint.output }),
        contract: contractLint.output,
      },
    };
  };
}

export function lintPiWendaoWorkflowContract(
  xml: string,
  options: {
    cwd: string;
    gatewayConditions?: QianjiGatewayCondition[];
    targetDecision?: CompileTargetDecision;
  },
): BpmnLintResult {
  let document: ParsedBpmnDocument;
  try {
    document = piWendaoContractParser.parse(xml) as ParsedBpmnDocument;
  } catch (err) {
    return failed([
      {
        code: "PI_WENDAO001",
        title: "BPMN XML must be parseable for pi-wendao contract validation",
        summary: err instanceof Error ? err.message : String(err),
        repairPlan: "Repair the XML syntax, preserve the workflow intent, and rerun the BPMN lint.",
      },
    ]);
  }

  const processRoot = document.definitions?.process ?? document["bpmn:definitions"]?.process ?? document["bpmn:definitions"]?.["bpmn:process"];
  const issues: PiWendaoCompileContractIssue[] = [];
  issues.push(...legacyCustomXmlIssues(document));

  const tasks = collectPiWendaoTasks(processRoot);
  const userInteractions = tasks.filter((task) => task.element === "userTask" && readNativeInteraction(task));
  if (requiresUserInteraction(options.targetDecision) && userInteractions.length === 0) {
    issues.push({
      code: "PI_WENDAO_INTERACTIVE_USER_TASK_REQUIRED",
      title: "interactive compile target must contain a native userTask interaction",
      summary: `Target scenario '${options.targetDecision?.scenario}' selected user-task.interaction, but the BPMN has no userTask with native interaction IO.`,
      repairPlan: nativeInteractiveRepairPlan(),
    });
  }

  const declaredVariables = collectNativeDeclaredVariables(tasks);
  const outputProducersByName = groupOutputProducersByName(collectNativeOutputProducers(tasks));
  for (const ref of collectDynamicChoiceRefs(tasks)) {
    const producers = outputProducersByName.get(ref.choicesRef) ?? [];
    if (producers.length === 0) {
      issues.push({
        code: "PI_WENDAO_DYNAMIC_CHOICES_PRODUCER",
        title: "dynamic choices must have a declared producer",
        summary: `userTask '${ref.taskId}' consumes choices source '${ref.choicesRef}', but no native BPMN task declares that output.`,
        repairPlan: `Add an upstream serviceTask that declares dataOutput '${ref.choicesRef}' and maps it with dataOutputAssociation before userTask '${ref.taskId}'.`,
      });
    }
  }

  for (const task of tasks) {
    const taskId = readString(task.id) || `(missing ${task.element} id)`;
    if (task.element === "serviceTask" && readString(task.implementation) !== SERVICE_TASK_IMPLEMENTATION) {
      issues.push({
        code: "PI_WENDAO_SERVICE_IMPLEMENTATION",
        title: "serviceTask must dispatch through pi-wendao runAgent",
        summary: `serviceTask '${taskId}' does not use implementation="${SERVICE_TASK_IMPLEMENTATION}".`,
        repairPlan: `Set serviceTask '${taskId}' implementation to "${SERVICE_TASK_IMPLEMENTATION}" without changing ids or sequence-flow references.`,
      });
    }

    const prompt = readDocumentation(task);
    if ((task.element === "serviceTask" || task.element === "userTask") && !prompt) {
      issues.push({
        code: "PI_WENDAO_PROMPT_EMPTY",
        title: "host tasks must document their prompt",
        summary: `${task.element} '${taskId}' has no native BPMN documentation text.`,
        repairPlan: `Add a bpmn:documentation child to ${task.element} '${taskId}' with the task prompt or user-facing question.`,
      });
    }

    if (task.element === "serviceTask" && serviceTaskAppearsToCollectHumanInput(prompt)) {
      issues.push({
        code: "PI_WENDAO_SERVICE_TASK_HUMAN_INPUT",
        title: "serviceTask must not collect human input directly",
        summary: `serviceTask '${taskId}' appears to ask or collect answers from the user.`,
        repairPlan: nativeInteractiveRepairPlan(),
      });
    }

    for (const variable of [...nativeInputSources(task), ...nativeOutputTargets(task)]) {
      if (!PI_WENDAO_VARIABLE_NAME_PATTERN.test(variable)) {
        issues.push({
          code: "PI_WENDAO_VARIABLE_IDENTIFIER",
          title: "pi-wendao variable references must be simple identifiers",
          summary: `${task.element} '${taskId}' references invalid variable name '${variable}'.`,
          repairPlan: `Rename '${variable}' to a simple identifier matching ${PI_WENDAO_VARIABLE_NAME_PATTERN.source}, and update downstream references consistently.`,
        });
      }
    }

    if (task.element === "userTask" || task.element === "manualTask") {
      issues.push(...lintNativeHumanInteraction(task, taskId));
    }
  }

  issues.push(...lintGatewayConditionVariables(processRoot, tasks, options.gatewayConditions ?? [], declaredVariables));
  issues.push(...lintUserFeedbackLoops(processRoot, tasks));

  if (issues.length === 0) {
    return {
      success: true,
      output: "pi-wendao compile contract passed",
      diagnostics: { contract: "pi-wendao compile contract passed" },
    };
  }
  return failed(issues);
}

interface PiWendaoCompileContractIssue {
  code: string;
  title: string;
  summary: string;
  repairPlan: string;
}

type PiWendaoTaskElement = Record<string, unknown> & { element: string };

interface NativeOutputProducer {
  taskId: string;
  outputNames: string[];
}

interface DynamicChoiceRef {
  taskId: string;
  choicesRef: string;
}

interface NativeInteraction {
  type?: string;
  choicesRef?: string;
  choices?: unknown[];
  resultOutput?: string;
}

function failed(issues: PiWendaoCompileContractIssue[]): BpmnLintResult {
  const output = renderPiWendaoCompileContractIssues(issues);
  return { success: false, output, diagnostics: { contract: output } };
}

function renderPiWendaoCompileContractIssues(issues: PiWendaoCompileContractIssue[]): string {
  const lines = ["# PiWendao Compile Contract Failed", "", `Issues: ${issues.length}`];
  for (const issue of issues) {
    lines.push("", `## [${issue.code}] ${issue.title}`, "Severity: error", `Summary: ${issue.summary}`, "", "### Repair Plan", issue.repairPlan);
  }
  return lines.join("\n");
}

function requiresUserInteraction(targetDecision: CompileTargetDecision | undefined): boolean {
  return (
    targetDecision?.scenario === "interactive" ||
    targetDecision?.scenario === "planning" ||
    (targetDecision?.selectedConstructs ?? []).includes("user-task.interaction")
  );
}

function collectPiWendaoTasks(processes: unknown): PiWendaoTaskElement[] {
  const tasks: PiWendaoTaskElement[] = [];
  for (const process of asArray(processes)) {
    if (!isObject(process)) continue;
    for (const element of ["serviceTask", "userTask", "manualTask"] as const) {
      for (const task of readElements(process, element)) {
        tasks.push({ ...task, element });
      }
    }
  }
  return tasks;
}

function legacyCustomXmlIssues(root: unknown): PiWendaoCompileContractIssue[] {
  const hits = new Set<string>();
  walkObject(root, (key) => {
    if (key.includes(":") && LEGACY_CUSTOM_LOCAL_NAMES.has(key.split(":").at(-1) ?? "")) {
      hits.add(key);
    }
  });
  return [...hits].map((key) => ({
    code: "PI_WENDAO_LEGACY_CUSTOM_INTERACTION_XML",
    title: "legacy custom interaction XML is not supported",
    summary: `BPMN contains legacy custom QName element '${key}'.`,
    repairPlan:
      "Replace custom interaction XML with native BPMN documentation, ioSpecification, dataInputAssociation, and dataOutputAssociation metadata. No compatibility mode is available.",
  }));
}

function walkObject(value: unknown, visitKey: (key: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkObject(item, visitKey);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    visitKey(key);
    walkObject(child, visitKey);
  }
}

function collectNativeDeclaredVariables(tasks: PiWendaoTaskElement[]): Set<string> {
  const variables = new Set<string>();
  for (const task of tasks) {
    for (const variable of nativeInputSources(task)) variables.add(variable);
    for (const variable of nativeOutputTargets(task)) variables.add(variable);
  }
  return variables;
}

function collectNativeOutputProducers(tasks: PiWendaoTaskElement[]): NativeOutputProducer[] {
  return tasks
    .map((task) => ({
      taskId: readString(task.id),
      outputNames: nativeOutputTargets(task),
    }))
    .filter((producer) => producer.taskId && producer.outputNames.length > 0);
}

function groupOutputProducersByName(producers: NativeOutputProducer[]): Map<string, NativeOutputProducer[]> {
  const byName = new Map<string, NativeOutputProducer[]>();
  for (const producer of producers) {
    for (const outputName of producer.outputNames) {
      const bucket = byName.get(outputName) ?? [];
      bucket.push(producer);
      byName.set(outputName, bucket);
    }
  }
  return byName;
}

function collectDynamicChoiceRefs(tasks: PiWendaoTaskElement[]): DynamicChoiceRef[] {
  return tasks
    .filter((task) => task.element === "userTask")
    .map((task) => ({ taskId: readString(task.id), choicesRef: readNativeInteraction(task)?.choicesRef }))
    .filter((ref): ref is DynamicChoiceRef => Boolean(ref.taskId && ref.choicesRef));
}

function lintNativeHumanInteraction(task: PiWendaoTaskElement, taskId: string): PiWendaoCompileContractIssue[] {
  const issues: PiWendaoCompileContractIssue[] = [];
  const interaction = readNativeInteraction(task);
  if (!interaction) return issues;
  if (!interaction.type || !INTERACTION_TYPES.has(interaction.type)) {
    issues.push({
      code: "PI_WENDAO_INTERACTION_TYPE",
      title: "human-task interaction type is unsupported",
      summary: `human task '${taskId}' declares unsupported interactionType '${interaction.type ?? "(missing)"}'.`,
      repairPlan: "Set the interactionType data input assignment literal to one of: input, confirm, choice, choice_input.",
    });
  }
  if (interaction.type && CHOICE_INTERACTION_TYPES.has(interaction.type) && !interaction.choicesRef && !(interaction.choices?.length)) {
    issues.push({
      code: "PI_WENDAO_INTERACTION_CHOICES",
      title: "choice interaction must declare choices",
      summary: `human task '${taskId}' declares interactionType '${interaction.type}' without static choices or a dynamic choices source.`,
      repairPlan: "Map a choices data input from an upstream sourceRef, or assign a JSON array literal to the choices data input.",
    });
  }
  if (!interaction.resultOutput) {
    issues.push({
      code: "PI_WENDAO_USER_TASK_RESULT_OUTPUT",
      title: "human-task interaction must map answer output",
      summary: `human task '${taskId}' has no answer dataOutputAssociation targetRef.`,
      repairPlan: "Declare a dataOutput named answer and map it to the workflow variable that should receive the human reply.",
    });
  }
  return issues;
}

function lintGatewayConditionVariables(
  processes: unknown,
  tasks: PiWendaoTaskElement[],
  conditions: QianjiGatewayCondition[],
  declaredVariables: Set<string>,
): PiWendaoCompileContractIssue[] {
  const issues: PiWendaoCompileContractIssue[] = [];
  for (const condition of conditions) {
    const variable = readGatewayConditionVariable(condition);
    if (!variable || declaredVariables.has(variable)) continue;
    const route = [condition.source_ref, condition.target_ref].filter(Boolean).join(" -> ") || "(unknown route)";
    const producerIds = findDirectUpstreamTaskIds(processes, condition.source_ref, tasks);
    issues.push({
      code: "PI_WENDAO_CONDITION_VARIABLE_UNDECLARED",
      title: "gateway conditions must use declared workflow variables",
      summary: `gateway route '${route}' condition references '${variable}', but no native BPMN task declares it as an input or output.`,
      repairPlan: `Add '${variable}' as a native BPMN data output on the upstream task${producerIds.length ? ` (${producerIds.join(", ")})` : ""}, or change the condition to an already declared variable.`,
    });
  }
  return issues;
}

function readGatewayConditionVariable(condition: QianjiGatewayCondition): string | undefined {
  const parsed = condition.parsed;
  const path =
    parsed?.kind === "boolean_path"
      ? parsed.path
      : parsed?.kind === "numeric_comparison"
        ? parsed.lhs
        : undefined;
  return path?.split(".")[0]?.trim() || undefined;
}

function findDirectUpstreamTaskIds(
  processes: unknown,
  gatewayId: string | undefined,
  tasks: PiWendaoTaskElement[],
): string[] {
  if (!gatewayId) return [];
  const taskIds = new Set(tasks.map((task) => readString(task.id)).filter(Boolean));
  return collectSequenceFlows(processes)
    .filter((flow) => readString(flow.targetRef) === gatewayId)
    .map((flow) => readString(flow.sourceRef))
    .filter((sourceRef) => sourceRef && taskIds.has(sourceRef));
}

function lintUserFeedbackLoops(
  processes: unknown,
  tasks: PiWendaoTaskElement[],
): PiWendaoCompileContractIssue[] {
  const issues: PiWendaoCompileContractIssue[] = [];
  const taskById = new Map(tasks.map((task) => [readString(task.id), task] as const).filter(([id]) => Boolean(id)));
  const flows = collectSequenceFlows(processes);
  for (const serviceToUser of flows) {
    const serviceId = readString(serviceToUser.sourceRef);
    const userId = readString(serviceToUser.targetRef);
    const serviceTask = taskById.get(serviceId);
    const userTask = taskById.get(userId);
    if (serviceTask?.element !== "serviceTask" || userTask?.element !== "userTask") continue;
    for (const userToGateway of flows.filter((flow) => readString(flow.sourceRef) === userId)) {
      const gatewayId = readString(userToGateway.targetRef);
      const loopsBack = flows.some((flow) => readString(flow.sourceRef) === gatewayId && readString(flow.targetRef) === serviceId);
      if (!loopsBack) continue;
      const serviceInputs = nativeInputSources(serviceTask);
      const userOutputs = nativeOutputTargets(userTask);
      const missing = userOutputs.filter((output) => !serviceInputs.includes(output));
      if (userOutputs.length === 0 || missing.length === 0) continue;
      issues.push({
        code: "PI_WENDAO_USER_FEEDBACK_LOOP_UNREAD",
        title: "user feedback loops must feed the user's answer into the next iteration",
        summary: `serviceTask '${serviceId}' loops through userTask '${userId}' but does not consume user output(s): ${missing.join(", ")}.`,
        repairPlan: `Add dataInputAssociation sourceRef values ${missing.join(", ")} to serviceTask '${serviceId}' and update its documentation so the next iteration explicitly uses the prior human reply.`,
      });
    }
  }
  return issues;
}

function collectSequenceFlows(processes: unknown): Record<string, unknown>[] {
  const flows: Record<string, unknown>[] = [];
  for (const process of asArray(processes)) {
    if (!isObject(process)) continue;
    flows.push(...readElements(process, "sequenceFlow"));
  }
  return flows;
}

function readNativeInteraction(task: Record<string, unknown>): NativeInteraction | undefined {
  const type = readInputAssignment(task, "interactionType");
  const choicesRef = readInputSource(task, "choices");
  const choicesLiteral = readInputAssignment(task, "choices");
  const choices = choicesLiteral ? parseJsonArray(choicesLiteral) : undefined;
  const resultOutput = readAnswerTarget(task);
  if (!type && !choicesRef && !choices?.length && !resultOutput) return undefined;
  return { type, choicesRef, choices, resultOutput };
}

function readInputAssignment(task: Record<string, unknown>, inputName: string): string | undefined {
  const inputIds = inputIdsByName(task, inputName);
  const assignment = readElements(task, "dataInputAssociation")
    .map((association) => firstElement(association, "assignment"))
    .filter(isObject)
    .find((candidate) => inputIds.has(readText(firstElementValue(candidate, "to")).trim()));
  const value = assignment ? readText(firstElementValue(assignment, "from")).trim() : "";
  return value || undefined;
}

function readInputSource(task: Record<string, unknown>, inputName: string): string | undefined {
  const inputIds = inputIdsByName(task, inputName);
  const association = readElements(task, "dataInputAssociation").find((candidate) =>
    inputIds.has(readText(firstElementValue(candidate, "targetRef")).trim()),
  );
  const value = association ? readText(firstElementValue(association, "sourceRef")).trim() : "";
  return value || undefined;
}

function readAnswerTarget(task: Record<string, unknown>): string | undefined {
  const outputIds = outputIdsByName(task, "answer");
  const association = readElements(task, "dataOutputAssociation").find((candidate) =>
    outputIds.has(readText(firstElementValue(candidate, "sourceRef")).trim()),
  );
  const value = association ? readText(firstElementValue(association, "targetRef")).trim() : "";
  return value || undefined;
}

function nativeInputSources(task: Record<string, unknown>): string[] {
  return readElements(task, "dataInputAssociation")
    .map((association) => readText(firstElementValue(association, "sourceRef")).trim())
    .filter(Boolean);
}

function nativeOutputTargets(task: Record<string, unknown>): string[] {
  return readElements(task, "dataOutputAssociation")
    .map((association) => readText(firstElementValue(association, "targetRef")).trim())
    .filter(Boolean);
}

function inputIdsByName(task: Record<string, unknown>, name: string): Set<string> {
  const io = firstElement(task, "ioSpecification");
  return new Set(readElements(io ?? {}, "dataInput").filter((input) => readString(input.name) === name).map((input) => readString(input.id)));
}

function outputIdsByName(task: Record<string, unknown>, name: string): Set<string> {
  const io = firstElement(task, "ioSpecification");
  return new Set(readElements(io ?? {}, "dataOutput").filter((output) => readString(output.name) === name).map((output) => readString(output.id)));
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readDocumentation(task: Record<string, unknown>): string {
  return readText(firstElementValue(task, "documentation")).trim();
}

function serviceTaskAppearsToCollectHumanInput(prompt: string): boolean {
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

function nativeInteractiveRepairPlan(): string {
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

function readElements(parent: Record<string, unknown>, localName: string): Record<string, unknown>[] {
  return asArray(firstElementValue(parent, localName)).filter(isObject);
}

function firstElement(parent: Record<string, unknown>, localName: string): Record<string, unknown> | undefined {
  return firstObject(firstElementValue(parent, localName));
}

function firstElementValue(parent: Record<string, unknown>, localName: string): unknown {
  return parent[localName] ?? parent[`bpmn:${localName}`];
}
