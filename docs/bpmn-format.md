# BPMN Format

The compiled output is valid BPMN 2.0 XML. Extension elements use the `qianji`
namespace and the namespace URI `https://qianji.dev/bpmn/extensions`.

```xml
<serviceTask id="Task_1" name="Run tests"
             implementation="${environment.services.runAgent}">
  <extensionElements>
    <qianji:config>
      <qianji:prompt>Run the test suite and report results.</qianji:prompt>
      <qianji:tools>bash</qianji:tools>
      <qianji:inputs></qianji:inputs>
      <qianji:outputs>testsPassed</qianji:outputs>
      <qianji:agentType>pi-wendao-worker</qianji:agentType>
      <qianji:runInBackground>true</qianji:runInBackground>
      <qianji:maxTurns>8</qianji:maxTurns>
    </qianji:config>
  </extensionElements>
</serviceTask>
```

Human feedback or approval checkpoints use `userTask` with the same
`qianji:config` fields. `qianji:tools` must be empty because the host resolves
the node through human input rather than an LLM tool runner.

```xml
<userTask id="Task_Approve" name="Approve proposal">
  <extensionElements>
    <qianji:config>
      <qianji:prompt>Review the proposal and approve before continuing.</qianji:prompt>
      <qianji:tools></qianji:tools>
      <qianji:inputs>proposal</qianji:inputs>
      <qianji:outputs>approved,approvedReply</qianji:outputs>
      <qianji:interaction type="choice_input">
        <qianji:question>How should the workflow proceed?</qianji:question>
        <qianji:choice value="approved" label="Approve">Continue to the next BPMN checkpoint.</qianji:choice>
        <qianji:choice value="rejected" label="Reject">Stop and revise before continuing.</qianji:choice>
        <qianji:freeText name="approvedReply" optional="true"/>
        <qianji:result output="approvedReply"/>
      </qianji:interaction>
    </qianji:config>
  </extensionElements>
</userTask>
```

`qianji:interaction` is optional and host-neutral. Supported v1 types are
`input`, `confirm`, `choice`, and `choice_input`. The BPMN declares the
interaction intent; each host maps it to its native UI or SDK request shape.
For `choice` and `choice_input`, options may be static `qianji:choice` elements
or a dynamic `<qianji:choices ref="currentChoices"/>` reference. Dynamic
questions should keep the prompt text in `currentQuestion` and structured
choices in `currentChoices`, not embed numbered option text in the question.

Gateway `conditionExpression` values are type-strict. A bare path such as
`approved` must resolve to a JSON boolean. Counts and counters must use numeric
comparisons such as `questionsRemaining > 0`; do not route on a bare
count-like variable name.

The `agentType`, `runInBackground`, `maxTurns`, `agentModel`, `thinking`,
`isolated`, `isolation`, and `inheritContext` fields are optional execution
metadata for subagent-capable host backends. They do not alter BPMN graph
progression; qianji still decides the next node from BPMN state and returned
variables.
