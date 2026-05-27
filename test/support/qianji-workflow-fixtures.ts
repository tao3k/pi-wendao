import { nativeDefinitions, nativeServiceTask } from "./native-bpmn.js";

export function singleServiceTaskWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1" name="Start"/>',
      nativeServiceTask({
        id: "Task_Review",
        name: "Review item",
        documentation: "Review ${environment.variables.item}.",
        inputs: ["item"],
        outputs: ["result"],
      }),
      '    <endEvent id="End_1" name="Done"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_Review" />',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_Review" targetRef="End_1" />',
    ].join("\n"),
  );
}
