import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPiWendaoAgentPrompt } from "../../src/executor/agent-host.js";
import { buildPiWendaoConfigMap } from "../../src/executor/bpmn-config.js";
import { resolveHumanTaskConfig, validateOutputSchemas } from "../../src/executor/human-task.js";

const fixturePath = join(process.cwd(), "test/fixtures/pi-ask-interactions.bpmn");

describe("qianji interaction contract parsing", () => {
  it("parses every pi-ask-backed interaction shape from BPMN", () => {
    const configs = buildPiWendaoConfigMap(
      readFileSync(fixturePath, "utf-8"),
      "Process_PiAskInteractions",
    );

    expect(configs.get("Task_Input")?.interaction).toEqual({
      type: "input",
      question: "Describe the next investigation step.",
      freeText: {
        name: "freeformAnswer",
        placeholder: "Write a short answer",
      },
      result: { output: "freeformAnswer" },
    });
    expect(configs.get("Task_Confirm")?.interaction).toEqual({
      type: "confirm",
      question: "Continue with the proposed workflow?",
      result: { output: "approved" },
    });
    expect(configs.get("Task_Choice")?.interaction).toEqual({
      type: "choice",
      question: "Which direction should the workflow emphasize?",
      choices: [
        {
          value: "expand",
          label: "Explore more",
          description: "Gather broader context before narrowing.",
        },
        {
          value: "narrow",
          label: "Narrow scope",
          description: "Pick the smallest useful slice now.",
        },
      ],
      result: { output: "selectedDirection" },
    });
    expect(configs.get("Task_ChoiceInput")?.interaction).toEqual({
      type: "choice_input",
      question: "How should qianji repair this workflow?",
      choices: [
        {
          value: "minimal",
          label: "Minimal fix",
          description: "Only repair the failing contract.",
        },
        {
          value: "broaden",
          label: "Broaden coverage",
          description: "Add schema tests around the failure.",
        },
      ],
      freeText: {
        name: "choiceInputAnswer",
        optional: true,
        placeholder: "Type a custom repair direction",
      },
      result: { output: "choiceInputAnswer" },
    });
    expect(configs.get("Task_DynamicChoiceInput")?.interaction).toEqual({
      type: "choice_input",
      questionRef: "currentQuestion",
      choicesRef: "currentChoices",
      freeText: {
        name: "dynamicAnswer",
        optional: true,
        placeholder: "Type another answer",
      },
      result: { output: "dynamicAnswer" },
    });
  });

  it("resolves dynamic choices only when each choice has a required value", () => {
    const configs = buildPiWendaoConfigMap(
      readFileSync(fixturePath, "utf-8"),
      "Process_PiAskInteractions",
    );
    const config = configs.get("Task_DynamicChoiceInput");
    expect(config).toBeDefined();

    const resolved = resolveHumanTaskConfig(config!, {
      currentQuestion: "Which repair path should the workflow use?",
      currentChoices: [
        {
          value: "minimal",
          label: "Minimal repair",
          description: "Repair only the invalid BPMN contract.",
        },
      ],
    });

    expect(resolved.interaction).toMatchObject({
      question: "Which repair path should the workflow use?",
      choices: [
        {
          value: "minimal",
          label: "Minimal repair",
          description: "Repair only the invalid BPMN contract.",
        },
      ],
    });
  });

  it("rejects dynamic choices whose objects omit the required value", () => {
    const configs = buildPiWendaoConfigMap(
      readFileSync(fixturePath, "utf-8"),
      "Process_PiAskInteractions",
    );
    const config = configs.get("Task_DynamicChoiceInput");
    expect(config).toBeDefined();

    expect(() =>
      resolveHumanTaskConfig(config!, {
        currentQuestion: "Which repair path should the workflow use?",
        currentChoices: [
          {
            label: "Minimal repair",
            description: "Repair only the invalid BPMN contract.",
          },
        ],
      }, {
        activityId: "Task_DynamicChoiceInput",
      }),
    ).toThrow("[pi-wendao.runtime.invalid_dynamic_choices]");
    expect(() =>
      resolveHumanTaskConfig(config!, {
        currentQuestion: "Which repair path should the workflow use?",
        currentChoices: [
          {
            label: "Minimal repair",
            description: "Repair only the invalid BPMN contract.",
          },
        ],
      }, {
        activityId: "Task_DynamicChoiceInput",
      }),
    ).toThrow("Consumer activity: Task_DynamicChoiceInput");
  });

  it("rejects producer choice_array outputs whose items are strings", () => {
    const config = {
      prompt: "Prepare structured choices.",
      tools: [],
      inputs: [],
      outputs: ["currentChoices"],
      outputSchemas: {
        currentChoices: {
          kind: "choice_array",
          value: "required" as const,
          label: "optional" as const,
          description: "optional" as const,
        },
      },
    };

    let error: Error | undefined;
    try {
      validateOutputSchemas(
        config,
        {
          currentChoices: ["Graph visualization (workflow display and node rendering)"],
        },
        { activityId: "Task_PrepareQuestion" },
      );
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }

    expect(error?.message).toMatchSnapshot();
    expect(error?.message).toContain("Producer activity: Task_PrepareQuestion");
    expect(error?.message).toContain("Problem: item is not an object");
  });

  it("parses qianji output schemas and injects them into service task prompts", () => {
    const bpmn = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:qianji="https://qianji.dev/bpmn/extensions">
  <process id="Process_OutputSchema" isExecutable="true">
    <serviceTask id="Task_PrepareQuestion" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Prepare a structured question.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs>context</qianji:inputs>
          <qianji:outputs>currentQuestion,currentChoices</qianji:outputs>
          <qianji:outputSchema name="currentChoices" kind="choice_array" value="required" label="optional" description="optional"/>
        </qianji:config>
      </extensionElements>
    </serviceTask>
  </process>
</definitions>`;

    const configs = buildPiWendaoConfigMap(bpmn, "Process_OutputSchema");
    const config = configs.get("Task_PrepareQuestion");

    expect(config?.outputSchemas).toEqual({
      currentChoices: {
        kind: "choice_array",
        value: "required",
        label: "optional",
        description: "optional",
      },
    });
    const prompt = buildPiWendaoAgentPrompt(config!, {});
    expect(prompt).toContain('"currentChoices": {');
    expect(prompt).toContain('"kind": "choice_array"');
    expect(prompt).toContain('"jsonSchema": {');
    expect(prompt).toContain('"required": [');
    expect(prompt).toContain('"value"');
    expect(prompt).toContain('"example": [');
  });

});
