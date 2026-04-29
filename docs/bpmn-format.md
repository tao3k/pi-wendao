# BPMN Format

The compiled output is standard BPMN 2.0 XML. pi-wendao does not require a
custom moddle descriptor: host-work metadata is carried through
`documentation`, `ioSpecification`, `dataInputAssociation`, and
`dataOutputAssociation`.

## Service Tasks

Service tasks use native IO to declare workflow variables. The prompt is the
task `documentation`; inputs come from `dataInputAssociation/sourceRef`; outputs
are mapped through `dataOutputAssociation/targetRef`.

```xml
<serviceTask id="Task_RunTests" name="Run tests"
             implementation="${environment.services.runAgent}">
  <documentation>Run the test suite and report whether tests pass.</documentation>
  <ioSpecification>
    <dataOutput id="Task_RunTests_output_testsPassed" name="testsPassed" />
    <inputSet id="Task_RunTests_input_set" />
    <outputSet id="Task_RunTests_output_set">
      <dataOutputRefs>Task_RunTests_output_testsPassed</dataOutputRefs>
    </outputSet>
  </ioSpecification>
  <dataOutputAssociation>
    <sourceRef>Task_RunTests_output_testsPassed</sourceRef>
    <targetRef>testsPassed</targetRef>
  </dataOutputAssociation>
</serviceTask>
```

## Human Tasks

Human checkpoints use `userTask` or `manualTask`. `documentation` is the prompt
unless a `dataInput name="question"` is mapped from an upstream variable.

```xml
<userTask id="Task_Approve" name="Approve proposal">
  <documentation>How should the workflow proceed?</documentation>
  <ioSpecification>
    <dataInput id="Task_Approve_input_proposal" name="proposal" />
    <dataInput id="Task_Approve_input_interactionType" name="interactionType" />
    <dataInput id="Task_Approve_input_choices" name="choices" />
    <dataOutput id="Task_Approve_output_answer" name="answer" />
    <inputSet id="Task_Approve_input_set">
      <dataInputRefs>Task_Approve_input_proposal</dataInputRefs>
      <dataInputRefs>Task_Approve_input_interactionType</dataInputRefs>
      <dataInputRefs>Task_Approve_input_choices</dataInputRefs>
    </inputSet>
    <outputSet id="Task_Approve_output_set">
      <dataOutputRefs>Task_Approve_output_answer</dataOutputRefs>
    </outputSet>
  </ioSpecification>
  <dataInputAssociation>
    <sourceRef>proposal</sourceRef>
    <targetRef>Task_Approve_input_proposal</targetRef>
  </dataInputAssociation>
  <dataInputAssociation>
    <assignment>
      <from>choice_input</from>
      <to>Task_Approve_input_interactionType</to>
    </assignment>
  </dataInputAssociation>
  <dataInputAssociation>
    <assignment>
      <from>[{"value":"approved","label":"Approve"},{"value":"rejected","label":"Reject"}]</from>
      <to>Task_Approve_input_choices</to>
    </assignment>
  </dataInputAssociation>
  <dataOutputAssociation>
    <sourceRef>Task_Approve_output_answer</sourceRef>
    <targetRef>approved</targetRef>
  </dataOutputAssociation>
</userTask>
```

Supported `interactionType` literals are `input`, `confirm`, `choice`, and
`choice_input`. Choice prompts must provide either a static JSON array literal
for the `choices` input or a dynamic `sourceRef` to an upstream output such as
`currentChoices`. A dynamic question uses a `question` input source; otherwise
the task `documentation` is used as the visible question.

Free-text metadata is optional and uses a JSON object assignment literal on
`dataInput name="freeText"`, for example
`{"name":"feedback","optional":true,"placeholder":"Feedback"}`. pi-wendao
supports one free-text field per human task; model additional fields as later
tasks or derive structure in a following service task.

## Runtime Ownership

During execution, qianji owns scheduling, gateway evaluation, checkpoint writes,
claim state, assignment state, and host-work tokens. pi-wendao renders native
human prompts from qianji-streamed host-work metadata and returns typed
task-completion payloads. It does not recover missing prompts or output names
from local BPMN after qianji has emitted host work.

Workflow execution runs qianji lint and the pi-wendao native IO contract before
starting. Stale artifacts that still use custom interaction XML fail preflight
instead of falling back to a compatibility parser.

## Gateway Conditions

Gateway `conditionExpression` values are type-strict. A bare path such as
`approved` must resolve to a JSON boolean. Counts and counters must use numeric
comparisons such as `questionsRemaining > 0`; do not route on a bare count-like
variable name.
