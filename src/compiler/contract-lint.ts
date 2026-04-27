import { XMLParser } from "fast-xml-parser";
import { getPiWendaoToolNames } from "../tools/registry.js";
import type { BpmnLintResult, BpmnLintRunner, QianjiGatewayCondition } from "./types.js";
import { asArray, csv, firstObject, isObject, readString, readText } from "./json.js";

const SERVICE_TASK_IMPLEMENTATION = "${environment.services.runAgent}";
const PI_WENDAO_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QIANJI_CONFIG_ELEMENT = "qianji:config";
const QIANJI_INTERACTION_ELEMENT = "qianji:interaction";
const QIANJI_INTERACTION_TYPES = new Set(["input", "confirm", "choice", "choice_input"]);

const piWendaoContractParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: false,
});

export function createCompileLintRunner(
  qianjiLintRunner: BpmnLintRunner,
  options: { cwd: string },
): BpmnLintRunner {
  return async (xml: string) => {
    const qianjiLint = await qianjiLintRunner(xml);
    if (!qianjiLint.success && isQianjiXmlSyntaxFailure(qianjiLint.output)) return qianjiLint;

    const piWendaoLint = lintPiWendaoCompileContract(xml, {
      ...options,
      gatewayConditions: qianjiLint.qianji?.analysis?.gateway_conditions ?? [],
    });
    if (qianjiLint.success && piWendaoLint.success) {
      return {
        ...qianjiLint,
        diagnostics: {
          ...(qianjiLint.diagnostics ?? { qianji: qianjiLint.output }),
          contract: piWendaoLint.output,
        },
      };
    }

    const output = [
      qianjiLint.output.trim(),
      piWendaoLint.success ? undefined : piWendaoLint.output.trim(),
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      success: false,
      output,
      diagnostics: {
        ...(qianjiLint.diagnostics ?? { qianji: qianjiLint.output }),
        contract: piWendaoLint.output,
      },
    };
  };
}

function isQianjiXmlSyntaxFailure(output: string): boolean {
  return output.includes("[bpmn.invalid_xml]");
}

function lintPiWendaoCompileContract(
  xml: string,
  options: { cwd: string; gatewayConditions?: QianjiGatewayCondition[] },
): BpmnLintResult {
  let document: { definitions?: { process?: unknown } };
  try {
    document = piWendaoContractParser.parse(xml) as { definitions?: { process?: unknown } };
  } catch (err) {
    return {
      success: false,
      output: renderPiWendaoCompileContractIssues([
        {
          code: "PI_WENDAO001",
          title: "BPMN XML must be parseable for pi-wendao contract validation",
          summary: err instanceof Error ? err.message : String(err),
          repairPlan:
            "Repair the XML syntax, preserve the workflow intent, and run qianji_lint again.",
        },
      ]),
    };
  }

  const issues: PiWendaoCompileContractIssue[] = [];
  const supportedToolNames = getPiWendaoToolNames(options.cwd);
  const supportedToolNameSet = new Set(supportedToolNames);
  const hostTaskIds = collectPiWendaoTaskIds(document.definitions?.process);
  const declaredVariables = collectPiWendaoDeclaredVariables(document.definitions?.process);
  const defaultGatewayRouteKeys = collectDefaultGatewayRouteKeys(document.definitions?.process);
  const outputProducers = collectPiWendaoOutputProducers(document.definitions?.process);
  const outputProducersByName = groupOutputProducersByName(outputProducers);
  for (const ref of collectDynamicChoiceRefs(document.definitions?.process)) {
    const producers = outputProducersByName.get(ref.choicesRef) ?? [];
    if (producers.length === 0) {
      issues.push({
        code: "PI_WENDAO_DYNAMIC_CHOICES_PRODUCER",
        title: "dynamic choices must have a declared producer",
        summary: `userTask '${ref.taskId}' consumes qianji:choices ref '${ref.choicesRef}', but no pi-wendao task declares '${ref.choicesRef}' in qianji:outputs.`,
        repairPlan: [
          `Add an upstream serviceTask before userTask '${ref.taskId}' that outputs '${ref.choicesRef}'.`,
          "Producer qianji:config must contain this XML:",
          dynamicChoicesOutputSchemaXml(ref.choicesRef),
          "Consumer qianji:interaction must contain this XML:",
          dynamicChoicesRefXml(ref.choicesRef),
        ].join("\n"),
      });
      continue;
    }
    if (!producers.some((producer) => producer.outputSchemas.get(ref.choicesRef) === "choice_array")) {
      issues.push({
        code: "PI_WENDAO_DYNAMIC_CHOICES_SCHEMA",
        title: "dynamic choices producer must declare an output schema",
        summary: `userTask '${ref.taskId}' consumes qianji:choices ref '${ref.choicesRef}', but producer task(s) ${producers.map((producer) => quote(producer.taskId)).join(", ")} do not declare kind="choice_array" qianji:outputSchema for '${ref.choicesRef}'.`,
        repairPlan: [
          `Insert this exact XML inside the qianji:config of the task that outputs '${ref.choicesRef}':`,
          dynamicChoicesOutputSchemaXml(ref.choicesRef),
          `Keep '${ref.choicesRef}' in qianji:outputs and keep <qianji:choices ref="${ref.choicesRef}"/> in the consuming userTask.`,
        ].join("\n"),
      });
    }
  }
  for (const boundaryEvent of collectBoundaryEvents(document.definitions?.process)) {
    const boundaryId = readString(boundaryEvent.id) || "(missing boundaryEvent id)";
    const attachedToRef = readString(boundaryEvent.attachedToRef);
    const hasErrorDefinition = asArray(boundaryEvent.errorEventDefinition).length > 0;
    if (attachedToRef && hostTaskIds.has(attachedToRef) && hasErrorDefinition) {
      issues.push({
        code: "PI_WENDAO_TASK_ERROR_BOUNDARY_UNSUPPORTED",
        title: "task-level error boundary is outside the pi-wendao compiler subset",
        summary: `boundaryEvent '${boundaryId}' attaches an errorEventDefinition directly to task '${attachedToRef}'.`,
        repairPlan: `Remove boundaryEvent '${boundaryId}'. Have task '${attachedToRef}' output a boolean status such as success or valid, route it through an exclusiveGateway, and put the fallback serviceTask on the default or negative branch. If BPMN error propagation is required, wrap the risky work in a qianji-supported subprocess shell instead of attaching the error boundary directly to a task.`,
      });
    }
  }
  const missingGatewayVariables = new Map<
    string,
    { condition: QianjiGatewayCondition; variable: string; defaultRoute: boolean }
  >();
  for (const condition of options.gatewayConditions ?? []) {
    for (const variable of readQianjiGatewayConditionVariables(condition)) {
      if (declaredVariables.has(variable)) continue;
      const missingKey = [condition.source_ref ?? "", variable].join("\0");
      const defaultRoute = defaultGatewayRouteKeys.has(
        gatewayRouteKey(condition.source_ref, condition.target_ref),
      );
      const existing = missingGatewayVariables.get(missingKey);
      if (!existing || (existing.defaultRoute && !defaultRoute)) {
        missingGatewayVariables.set(missingKey, { condition, variable, defaultRoute });
      }
    }
  }
  for (const { condition, variable } of missingGatewayVariables.values()) {
    const route =
      [condition.source_ref, condition.target_ref].filter(Boolean).join(" -> ") ||
      "(unknown route)";
    const producerIds = findDirectUpstreamTaskIds(
      document.definitions?.process,
      condition.source_ref,
    );
    const producerSummary =
      producerIds.length > 0
        ? ` Likely producer task(s) immediately before gateway '${condition.source_ref}': ${producerIds.map(quote).join(", ")}.`
        : "";
    issues.push({
      code: "PI_WENDAO_CONDITION_VARIABLE_UNDECLARED",
      title: "gateway conditions must use declared workflow variables",
      summary: `gateway route '${route}' condition references '${variable}', but no pi-wendao task declares it as an input or output.${producerSummary}`,
      repairPlan: gatewayConditionVariableRepairPlan(
        route,
        condition.source_ref,
        variable,
        producerIds,
      ),
    });
  }
  issues.push(...lintUserFeedbackLoops(document.definitions?.process));
  for (const task of collectPiWendaoTasks(document.definitions?.process)) {
    const taskId = readString(task.id) || `(missing ${task.element} id)`;
    if (
      task.element === "serviceTask" &&
      readString(task.implementation) !== SERVICE_TASK_IMPLEMENTATION
    ) {
      issues.push({
        code: "PI_WENDAO_SERVICE_IMPLEMENTATION",
        title: "serviceTask must dispatch through pi-wendao runAgent",
        summary: `serviceTask '${taskId}' does not use implementation="${SERVICE_TASK_IMPLEMENTATION}".`,
        repairPlan: `Set serviceTask '${taskId}' implementation to "${SERVICE_TASK_IMPLEMENTATION}" without changing its id or sequence-flow references.`,
      });
    }

    const config = readQianjiConfig(firstObject(task.extensionElements));
    if (!config) {
      issues.push({
        code: "PI_WENDAO_TASK_CONFIG",
        title: `${task.element} must include pi-wendao config`,
        summary: `${task.element} '${taskId}' is missing extensionElements/qianji:config.`,
        repairPlan: `Add extensionElements with qianji:config to ${task.element} '${taskId}', including prompt, tools, inputs, and outputs fields.`,
      });
      continue;
    }

    for (const field of ["prompt", "tools", "inputs", "outputs"]) {
      if (!hasQianjiField(config, field)) {
        issues.push({
          code: "PI_WENDAO_CONFIG_FIELD",
          title: "pi-wendao config must include required fields",
          summary: `${task.element} '${taskId}' qianji:config is missing '${field}'.`,
          repairPlan: `Add qianji:${field} to ${task.element} '${taskId}' qianji:config. Empty tools, inputs, or outputs are allowed when appropriate.`,
        });
      }
    }

    if (hasQianjiField(config, "prompt") && !readQianjiText(config, "prompt").trim()) {
      issues.push({
        code: "PI_WENDAO_PROMPT_EMPTY",
        title: "pi-wendao prompt must not be empty",
        summary: `${task.element} '${taskId}' has an empty qianji:prompt.`,
        repairPlan: `Write a focused task instruction in qianji:prompt for ${task.element} '${taskId}'.`,
      });
    }

    if (hasQianjiField(config, "tools")) {
      const declaredTools = csv(readQianjiText(config, "tools"));
      if (task.element === "userTask" && declaredTools.length > 0) {
        issues.push({
          code: "PI_WENDAO_USER_TASK_TOOLS",
          title: "userTask tools must be empty",
          summary: `userTask '${taskId}' declares tool(s): ${declaredTools.join(", ")}.`,
          repairPlan: `Clear qianji:tools on userTask '${taskId}'. A userTask is resolved by graph-local human input, not by runtime tools or an LLM agent.`,
        });
        continue;
      }
      const unsupportedTools = declaredTools.filter((tool) => !supportedToolNameSet.has(tool));
      if (unsupportedTools.length > 0) {
        issues.push({
          code: "PI_WENDAO_TOOL_UNSUPPORTED",
          title: "pi-wendao tools must be executable by the runtime",
          summary: `${task.element} '${taskId}' declares unsupported tool(s): ${unsupportedTools.join(", ")}.`,
          repairPlan: `Replace or remove unsupported tool(s) on ${task.element} '${taskId}'. Runtime-registered tools are: ${supportedToolNames.join(", ")}.`,
        });
      }
    }

    if (task.element === "userTask") {
      for (const issue of lintQianjiInteraction(config, taskId)) {
        issues.push(issue);
      }
    }

    for (const field of ["inputs", "outputs"]) {
      if (!hasQianjiField(config, field)) continue;
      const invalidNames = csv(readQianjiText(config, field)).filter(
        (name) => !PI_WENDAO_VARIABLE_NAME_PATTERN.test(name),
      );
      if (invalidNames.length > 0) {
        issues.push({
          code: "PI_WENDAO_VARIABLE_IDENTIFIER",
          title: "pi-wendao variable references must be simple identifiers",
          summary: `serviceTask '${taskId}' qianji:${field} contains invalid variable name(s): ${invalidNames.join(", ")}.`,
          repairPlan: `Rename qianji:${field} entries on serviceTask '${taskId}' to comma-separated identifiers matching ${PI_WENDAO_VARIABLE_NAME_PATTERN.source}, and update any downstream references consistently.`,
        });
      }
    }
  }

  if (issues.length === 0) {
    return {
      success: true,
      output: "pi-wendao compile contract passed",
      diagnostics: { contract: "pi-wendao compile contract passed" },
    };
  }

  return {
    success: false,
    output: renderPiWendaoCompileContractIssues(issues),
    diagnostics: { contract: renderPiWendaoCompileContractIssues(issues) },
  };
}

interface PiWendaoCompileContractIssue {
  code: string;
  title: string;
  summary: string;
  repairPlan: string;
  constructCards?: QianjiConstructCardId[];
}

type QianjiConstructCardId =
  | "service-task.agent"
  | "service-task.multi-instance.parallel"
  | "user-task.interaction"
  | "loop.interactive.progress"
  | "gateway.exclusive.bounded";

const PI_WENDAO_CONSTRUCT_CARDS_BY_CODE: Record<string, readonly QianjiConstructCardId[]> = {
  PI_WENDAO_TASK_ERROR_BOUNDARY_UNSUPPORTED: ["service-task.agent", "gateway.exclusive.bounded"],
  PI_WENDAO_CONDITION_VARIABLE_UNDECLARED: ["gateway.exclusive.bounded", "service-task.agent"],
  PI_WENDAO_SERVICE_IMPLEMENTATION: ["service-task.agent"],
  PI_WENDAO_TASK_CONFIG: ["service-task.agent", "user-task.interaction"],
  PI_WENDAO_CONFIG_FIELD: ["service-task.agent", "user-task.interaction"],
  PI_WENDAO_PROMPT_EMPTY: ["service-task.agent", "user-task.interaction"],
  PI_WENDAO_USER_TASK_TOOLS: ["user-task.interaction"],
  PI_WENDAO_TOOL_UNSUPPORTED: ["service-task.agent"],
  PI_WENDAO_VARIABLE_IDENTIFIER: ["service-task.agent"],
  PI_WENDAO_USER_FEEDBACK_LOOP_UNREAD: [
    "loop.interactive.progress",
    "service-task.agent",
    "user-task.interaction",
    "gateway.exclusive.bounded",
  ],
  PI_WENDAO_INTERACTION_TYPE: ["user-task.interaction"],
  PI_WENDAO_INTERACTION_CHOICES: ["user-task.interaction"],
  PI_WENDAO_DYNAMIC_CHOICES_PRODUCER: ["user-task.interaction", "service-task.agent"],
  PI_WENDAO_DYNAMIC_CHOICES_SCHEMA: ["user-task.interaction", "service-task.agent"],
};

function renderPiWendaoCompileContractIssues(issues: PiWendaoCompileContractIssue[]): string {
  const lines = ["# PiWendao Compile Contract Failed", "", `Issues: ${issues.length}`];
  for (const issue of issues) {
    lines.push(
      "",
      `## [${issue.code}] ${issue.title}`,
      "Severity: error",
      `Summary: ${issue.summary}`,
    );
    const constructCards =
      issue.constructCards ?? PI_WENDAO_CONSTRUCT_CARDS_BY_CODE[issue.code] ?? [];
    if (constructCards.length > 0) {
      lines.push("", "### Related Construct Cards", ...constructCards.map((card) => `- ${card}`));
    }
    lines.push("", "### Repair Plan", issue.repairPlan);
  }
  return lines.join("\n");
}

function collectBoundaryEvents(processes: unknown): Record<string, unknown>[] {
  const boundaryEvents: Record<string, unknown>[] = [];
  for (const process of asArray(processes)) {
    if (!isObject(process)) continue;
    for (const boundaryEvent of asArray(process.boundaryEvent)) {
      if (isObject(boundaryEvent)) boundaryEvents.push(boundaryEvent);
    }
  }
  return boundaryEvents;
}

type PiWendaoTaskElement = Record<string, unknown> & { element: string };

interface PiWendaoOutputProducer {
  taskId: string;
  outputNames: string[];
  outputSchemas: Map<string, string>;
}

interface DynamicChoiceRef {
  taskId: string;
  choicesRef: string;
}

const PI_WENDAO_CONFIG_TASK_ELEMENTS = ["serviceTask", "userTask"] as const;

function collectPiWendaoTasks(processes: unknown): PiWendaoTaskElement[] {
  const tasks: PiWendaoTaskElement[] = [];
  for (const process of asArray(processes)) {
    if (!isObject(process)) continue;
    for (const element of PI_WENDAO_CONFIG_TASK_ELEMENTS) {
      for (const task of asArray(process[element])) {
        if (isObject(task)) tasks.push({ ...task, element });
      }
    }
  }
  return tasks;
}

function collectPiWendaoOutputProducers(processes: unknown): PiWendaoOutputProducer[] {
  const producers: PiWendaoOutputProducer[] = [];
  for (const task of collectPiWendaoTasks(processes)) {
    const taskId = readString(task.id);
    if (!taskId) continue;
    const config = readQianjiConfig(firstObject(task.extensionElements));
    if (!config) continue;
    const outputNames = csv(readQianjiText(config, "outputs"));
    if (outputNames.length === 0) continue;
    producers.push({
      taskId,
      outputNames,
      outputSchemas: readQianjiOutputSchemas(config),
    });
  }
  return producers;
}

function groupOutputProducersByName(
  producers: PiWendaoOutputProducer[],
): Map<string, PiWendaoOutputProducer[]> {
  const byName = new Map<string, PiWendaoOutputProducer[]>();
  for (const producer of producers) {
    for (const outputName of producer.outputNames) {
      const bucket = byName.get(outputName) ?? [];
      bucket.push(producer);
      byName.set(outputName, bucket);
    }
  }
  return byName;
}

function collectDynamicChoiceRefs(processes: unknown): DynamicChoiceRef[] {
  const refs: DynamicChoiceRef[] = [];
  for (const task of collectPiWendaoTasks(processes)) {
    if (task.element !== "userTask") continue;
    const taskId = readString(task.id);
    if (!taskId) continue;
    const config = readQianjiConfig(firstObject(task.extensionElements));
    const interaction = config ? firstObject(config[QIANJI_INTERACTION_ELEMENT]) : undefined;
    if (!interaction) continue;
    const choicesRef = readQianjiChoicesRef(interaction);
    if (choicesRef) refs.push({ taskId, choicesRef });
  }
  return refs;
}

function collectPiWendaoTaskIds(processes: unknown): Set<string> {
  return new Set(
    collectPiWendaoTasks(processes)
      .map((task) => readString(task.id))
      .filter(Boolean),
  );
}

function collectPiWendaoDeclaredVariables(processes: unknown): Set<string> {
  const variables = new Set<string>();
  for (const task of collectPiWendaoTasks(processes)) {
    const config = readQianjiConfig(firstObject(task.extensionElements));
    if (!config) continue;
    for (const field of ["inputs", "outputs"]) {
      for (const variable of csv(readQianjiText(config, field))) {
        variables.add(variable);
      }
    }
  }
  return variables;
}

function collectSequenceFlows(processes: unknown): Record<string, unknown>[] {
  const flows: Record<string, unknown>[] = [];
  for (const process of asArray(processes)) {
    if (!isObject(process)) continue;
    for (const flow of asArray(process.sequenceFlow)) {
      if (isObject(flow)) flows.push(flow);
    }
  }
  return flows;
}

function findDirectUpstreamTaskIds(processes: unknown, gatewayId: string | undefined): string[] {
  if (!gatewayId) return [];
  const taskIds = collectPiWendaoTaskIds(processes);
  const producers: string[] = [];
  for (const flow of collectSequenceFlows(processes)) {
    if (readString(flow.targetRef) !== gatewayId) continue;
    const sourceRef = readString(flow.sourceRef);
    if (sourceRef && taskIds.has(sourceRef) && !producers.includes(sourceRef)) {
      producers.push(sourceRef);
    }
  }
  return producers;
}

function collectDefaultGatewayRouteKeys(processes: unknown): Set<string> {
  const defaultFlowIdsByGateway = new Map<string, string>();
  for (const process of asArray(processes)) {
    if (!isObject(process)) continue;
    for (const element of ["exclusiveGateway", "inclusiveGateway"]) {
      for (const gateway of asArray(process[element])) {
        if (!isObject(gateway)) continue;
        const gatewayId = readString(gateway.id);
        const defaultFlowId = readString(gateway.default);
        if (gatewayId && defaultFlowId) {
          defaultFlowIdsByGateway.set(gatewayId, defaultFlowId);
        }
      }
    }
  }

  const keys = new Set<string>();
  for (const flow of collectSequenceFlows(processes)) {
    const sourceRef = readString(flow.sourceRef);
    const targetRef = readString(flow.targetRef);
    const flowId = readString(flow.id);
    if (!sourceRef || !targetRef || !flowId) continue;
    if (defaultFlowIdsByGateway.get(sourceRef) === flowId) {
      keys.add(gatewayRouteKey(sourceRef, targetRef));
    }
  }
  return keys;
}

function gatewayRouteKey(sourceRef: string | undefined, targetRef: string | undefined): string {
  return [sourceRef ?? "", targetRef ?? ""].join("\0");
}

function gatewayConditionVariableRepairPlan(
  route: string,
  gatewayId: string | undefined,
  variable: string,
  producerIds: string[],
): string {
  const variableShape = `Use a top-level boolean output named '${variable}' and route with '${variable}' or 'not ${variable}'.`;
  if (producerIds.length > 0) {
    const producers = producerIds.map(quote).join(", ");
    return `Route gateway route '${route}' only on a declared qianji output variable. Add '${variable}' to qianji:outputs of upstream task(s) ${producers}, update their qianji:prompt to return JSON boolean '${variable}', then keep the gateway condition as '${variable}' or 'not ${variable}'. ${variableShape} Do not route on undeclared array/object fields unless the producer also emits this top-level boolean.`;
  }
  const gatewayLabel = gatewayId ? ` gateway '${gatewayId}'` : " the gateway";
  return `Route gateway route '${route}' only on a declared qianji output variable. Add '${variable}' to qianji:outputs of the serviceTask or userTask that immediately precedes${gatewayLabel}, update that task's qianji:prompt to return JSON boolean '${variable}', then keep the gateway condition as '${variable}' or 'not ${variable}'. ${variableShape} Do not route on undeclared array/object fields unless the producer also emits this top-level boolean.`;
}

function quote(value: string): string {
  return `'${value}'`;
}

function lintUserFeedbackLoops(processes: unknown): PiWendaoCompileContractIssue[] {
  const issues: PiWendaoCompileContractIssue[] = [];
  for (const process of asArray(processes)) {
    if (!isObject(process)) continue;
    const tasks = collectPiWendaoTasks(process);
    const taskById = new Map(
      tasks.map((task) => [readString(task.id), task] as const).filter(([id]) => Boolean(id)),
    );
    const flows = collectSequenceFlows(process);
    for (const serviceToUser of flows) {
      const serviceId = readString(serviceToUser.sourceRef);
      const userId = readString(serviceToUser.targetRef);
      const serviceTask = taskById.get(serviceId);
      const userTask = taskById.get(userId);
      if (serviceTask?.element !== "serviceTask" || userTask?.element !== "userTask") continue;

      for (const userToGateway of flows.filter((flow) => readString(flow.sourceRef) === userId)) {
        const gatewayId = readString(userToGateway.targetRef);
        const loopsBack = flows.some(
          (flow) =>
            readString(flow.sourceRef) === gatewayId && readString(flow.targetRef) === serviceId,
        );
        if (!loopsBack) continue;

        const serviceInputs = taskVariables(serviceTask, "inputs");
        const userOutputs = taskVariables(userTask, "outputs");
        const missingUserOutputs = userOutputs.filter((output) => !serviceInputs.includes(output));
        if (userOutputs.length === 0 || missingUserOutputs.length === 0) continue;
        const repairedInputs = mergeUnique(serviceInputs, missingUserOutputs);
        issues.push({
          code: "PI_WENDAO_USER_FEEDBACK_LOOP_UNREAD",
          title: "user feedback loops must feed the user's answer into the next iteration",
          summary: `serviceTask '${serviceId}' loops through userTask '${userId}' but is missing user output(s) in qianji:inputs: ${missingUserOutputs.join(", ")}. User outputs: ${userOutputs.join(", ")}. Current service inputs: ${serviceInputs.length > 0 ? serviceInputs.join(", ") : "(none)"}.`,
          repairPlan: `Add every missing user output variable to serviceTask '${serviceId}' qianji:inputs. Set qianji:inputs to include: ${repairedInputs.join(", ")}. Update the qianji:prompt for '${serviceId}' so the next iteration explicitly uses ${userOutputs.join(", ")} before deciding whether the loop should continue. Do not rely on an aggregate variable unless a prior task declares it as an output and updates it from the user reply.`,
        });
      }
    }
  }
  return issues;
}

function taskVariables(task: Record<string, unknown>, field: "inputs" | "outputs"): string[] {
  const config = readQianjiConfig(firstObject(task.extensionElements));
  return config ? csv(readQianjiText(config, field)) : [];
}

function mergeUnique(left: string[], right: string[]): string[] {
  const values: string[] = [];
  for (const value of [...left, ...right]) {
    if (!values.includes(value)) values.push(value);
  }
  return values;
}

function readQianjiGatewayConditionVariables(condition: QianjiGatewayCondition): string[] {
  const parsed = condition.parsed;
  if (!parsed) return [];
  const path =
    parsed.kind === "boolean_path"
      ? parsed.path
      : parsed.kind === "numeric_comparison"
        ? parsed.lhs
        : undefined;
  const rootVariable = path?.split(".")[0]?.trim();
  return rootVariable ? [rootVariable] : [];
}

function readQianjiConfig(
  extensionElements: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!extensionElements) return undefined;
  return firstObject(extensionElements[QIANJI_CONFIG_ELEMENT]);
}

function lintQianjiInteraction(
  config: Record<string, unknown>,
  taskId: string,
): PiWendaoCompileContractIssue[] {
  const interaction = firstObject(config[QIANJI_INTERACTION_ELEMENT]);
  if (!interaction) return [];
  const type = readString(interaction.type) || "input";
  const issues: PiWendaoCompileContractIssue[] = [];
  if (!QIANJI_INTERACTION_TYPES.has(type)) {
    issues.push({
      code: "PI_WENDAO_INTERACTION_TYPE",
      title: "qianji interaction type must be supported",
      summary: `userTask '${taskId}' qianji:interaction declares unsupported type '${type}'.`,
      repairPlan: `Use one of these qianji:interaction types on userTask '${taskId}': input, confirm, choice, choice_input.`,
    });
  }
  if ((type === "choice" || type === "choice_input") && !hasQianjiChoiceContract(interaction)) {
    const choicesElement = firstObject(interaction["qianji:choices"]);
    const invalidChoicesWrapper = choicesElement && !readString(choicesElement.ref);
    const wrapperGuidance = invalidChoicesWrapper
      ? " The current qianji:choices element has no ref; do not wrap static qianji:choice entries inside qianji:choices. Static choices are direct qianji:choice children of qianji:interaction."
      : "";
    issues.push({
      code: "PI_WENDAO_INTERACTION_CHOICES",
      title: "choice interactions must declare choices",
      summary: `userTask '${taskId}' qianji:interaction type '${type}' does not declare static qianji:choice entries or a dynamic qianji:choices ref.${wrapperGuidance}`,
      repairPlan: [
        `Choose one legal choice contract for userTask '${taskId}'.`,
        "Static choice XML:",
        '<qianji:choice value="approved" label="Approve">Continue.</qianji:choice>',
        '<qianji:choice value="revise" label="Revise">Collect changes.</qianji:choice>',
        "Dynamic choice XML:",
        dynamicChoicesRefXml("currentChoices"),
        "Dynamic producer qianji:config must also contain:",
        dynamicChoicesOutputSchemaXml("currentChoices"),
        "Do not use an empty <qianji:choices> wrapper for static choices.",
      ].join("\n"),
    });
  }
  return issues;
}

function hasQianjiChoiceContract(interaction: Record<string, unknown>): boolean {
  return readQianjiChoices(interaction).length > 0 || Boolean(readQianjiChoicesRef(interaction));
}

function readQianjiChoices(interaction: Record<string, unknown>): string[] {
  return asArray(interaction["qianji:choice"])
    .filter(isObject)
    .map((choice) => readString(choice.value))
    .filter(Boolean);
}

function readQianjiChoicesRef(interaction: Record<string, unknown>): string | undefined {
  const choices = firstObject(interaction["qianji:choices"]);
  return choices ? readString(choices.ref) || undefined : undefined;
}

function readQianjiOutputSchemas(config: Record<string, unknown>): Map<string, string> {
  const schemas = new Map<string, string>();
  for (const schema of asArray(config["qianji:outputSchema"]).filter(isObject)) {
    const name = readString(schema.name);
    const kind = readString(schema.kind);
    if (name && kind) schemas.set(name, kind);
  }
  return schemas;
}

function dynamicChoicesOutputSchemaXml(ref: string): string {
  return `<qianji:outputSchema name="${ref}" kind="choice_array" value="required" label="optional" description="optional"/>`;
}

function dynamicChoicesRefXml(ref: string): string {
  return `<qianji:choices ref="${ref}"/>`;
}

function hasQianjiField(config: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(config, `qianji:${field}`);
}

function readQianjiText(config: Record<string, unknown>, field: string): string {
  return readText(config[`qianji:${field}`]);
}
