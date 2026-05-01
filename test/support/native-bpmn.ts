export interface NativeChoice {
  value: string;
  label?: string;
  description?: string;
}

export interface NativeServiceTaskOptions {
  id: string;
  name?: string;
  documentation: string;
  inputs?: string[];
  outputs?: string[];
  implementation?: string;
}

export interface NativeHumanTaskOptions {
  id: string;
  kind?: "userTask" | "manualTask";
  name?: string;
  documentation: string;
  inputs?: string[];
  resultOutput: string;
  interactionType?: "input" | "confirm" | "choice" | "choice_input";
  questionRef?: string;
  choices?: NativeChoice[];
  choicesRef?: string;
  freeText?: Record<string, unknown>;
}

const SERVICE_IMPLEMENTATION = "${environment.services.runAgent}";

export function nativeDefinitions(processId: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             id="Definitions_1"
             targetNamespace="https://qianji.dev/test">
  <process id="${escapeXmlAttr(processId)}" isExecutable="true">
${body}
  </process>
</definitions>`;
}

export function nativeServiceTask(options: NativeServiceTaskOptions): string {
  const inputs = unique(options.inputs ?? []);
  const outputs = unique(options.outputs ?? []);
  const inputRefs = inputs
    .map((name) => `      <dataInputRefs>${dataInputId(options.id, name)}</dataInputRefs>`)
    .join("\n");
  const outputRefs = outputs
    .map((name) => `      <dataOutputRefs>${dataOutputId(options.id, name)}</dataOutputRefs>`)
    .join("\n");
  const associations = [
    ...inputs.map(
      (name) => `    <dataInputAssociation>
      <sourceRef>${escapeXmlText(name)}</sourceRef>
      <targetRef>${dataInputId(options.id, name)}</targetRef>
    </dataInputAssociation>`,
    ),
    ...outputs.map(
      (name) => `    <dataOutputAssociation>
      <sourceRef>${dataOutputId(options.id, name)}</sourceRef>
      <targetRef>${escapeXmlText(name)}</targetRef>
    </dataOutputAssociation>`,
    ),
  ].join("\n");
  return `    <serviceTask id="${escapeXmlAttr(options.id)}"${nameAttr(options.name)} implementation="${escapeXmlAttr(options.implementation ?? SERVICE_IMPLEMENTATION)}">
      <documentation>${escapeXmlText(options.documentation)}</documentation>
      <ioSpecification>
${inputs.map((name) => `        <dataInput id="${dataInputId(options.id, name)}" name="${escapeXmlAttr(name)}" />`).join("\n")}
${outputs.map((name) => `        <dataOutput id="${dataOutputId(options.id, name)}" name="${escapeXmlAttr(name)}" />`).join("\n")}
        <inputSet id="${escapeXmlAttr(options.id)}_input_set"${inputRefs ? "" : " /"}>${inputRefs ? `\n${inputRefs}\n        </inputSet>` : ""}
        <outputSet id="${escapeXmlAttr(options.id)}_output_set"${outputRefs ? "" : " /"}>${outputRefs ? `\n${outputRefs}\n        </outputSet>` : ""}
      </ioSpecification>
${associations}
    </serviceTask>`;
}

export function nativeHumanTask(options: NativeHumanTaskOptions): string {
  const id = options.id;
  const kind = options.kind ?? "userTask";
  const regularInputs = unique(options.inputs ?? []);
  const specialInputs = [
    "interactionType",
    ...(options.questionRef ? ["question"] : []),
    ...(options.choices || options.choicesRef ? ["choices"] : []),
    ...(options.freeText ? ["freeText"] : []),
  ];
  const inputs = [...regularInputs, ...specialInputs];
  const inputRefs = inputs
    .map((name) => `      <dataInputRefs>${dataInputId(id, name)}</dataInputRefs>`)
    .join("\n");
  const outputId = dataOutputId(id, "answer");
  const associations: string[] = [
    ...regularInputs.map(
      (name) => `    <dataInputAssociation>
      <sourceRef>${escapeXmlText(name)}</sourceRef>
      <targetRef>${dataInputId(id, name)}</targetRef>
    </dataInputAssociation>`,
    ),
    assignmentAssociation(id, "interactionType", options.interactionType ?? "input"),
  ];
  if (options.questionRef) {
    associations.push(sourceAssociation(id, "question", options.questionRef));
  }
  if (options.choicesRef) {
    associations.push(sourceAssociation(id, "choices", options.choicesRef));
  } else if (options.choices) {
    associations.push(assignmentAssociation(id, "choices", JSON.stringify(options.choices)));
  }
  if (options.freeText) {
    associations.push(assignmentAssociation(id, "freeText", JSON.stringify(options.freeText)));
  }
  associations.push(`    <dataOutputAssociation>
      <sourceRef>${outputId}</sourceRef>
      <targetRef>${escapeXmlText(options.resultOutput)}</targetRef>
    </dataOutputAssociation>`);

  return `    <${kind} id="${escapeXmlAttr(id)}"${nameAttr(options.name)}>
      <documentation>${escapeXmlText(options.documentation)}</documentation>
      <ioSpecification>
${inputs.map((name) => `        <dataInput id="${dataInputId(id, name)}" name="${escapeXmlAttr(name)}" />`).join("\n")}
        <dataOutput id="${outputId}" name="answer" />
        <inputSet id="${escapeXmlAttr(id)}_input_set">
${inputRefs}
        </inputSet>
        <outputSet id="${escapeXmlAttr(id)}_output_set">
          <dataOutputRefs>${outputId}</dataOutputRefs>
        </outputSet>
      </ioSpecification>
${associations.join("\n")}
    </${kind}>`;
}

function sourceAssociation(taskId: string, inputName: string, sourceRef: string): string {
  return `    <dataInputAssociation>
      <sourceRef>${escapeXmlText(sourceRef)}</sourceRef>
      <targetRef>${dataInputId(taskId, inputName)}</targetRef>
    </dataInputAssociation>`;
}

function assignmentAssociation(taskId: string, inputName: string, value: string): string {
  return `    <dataInputAssociation>
      <assignment>
        <from>${escapeXmlText(value)}</from>
        <to>${dataInputId(taskId, inputName)}</to>
      </assignment>
    </dataInputAssociation>`;
}

function dataInputId(taskId: string, name: string): string {
  return `${escapeXmlAttr(taskId)}_input_${escapeXmlAttr(name)}`;
}

function dataOutputId(taskId: string, name: string): string {
  return `${escapeXmlAttr(taskId)}_output_${escapeXmlAttr(name)}`;
}

function nameAttr(name: string | undefined): string {
  return name ? ` name="${escapeXmlAttr(name)}"` : "";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()).map((value) => value.trim()))];
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
