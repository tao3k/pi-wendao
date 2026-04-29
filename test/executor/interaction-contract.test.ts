import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPiWendaoConfigMap } from "../../src/executor/bpmn-config.js";
import {
  mergeQianjiHostWorkFormConfig,
  resolveHumanTaskConfig,
  validateOutputSchemas,
} from "../../src/executor/human-task.js";
import type { QianjiHostWork } from "../../src/executor/qianji-types.js";

const fixturePath = join(process.cwd(), "test/fixtures/pi-ask-interactions.bpmn");

describe("native BPMN interaction contract parsing", () => {
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
      question: "Ask the generated question with generated options.",
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

  it("rejects dynamic question refs that would otherwise leak raw JSON into pi-ask", () => {
    const configs = buildPiWendaoConfigMap(
      readFileSync(fixturePath, "utf-8"),
      "Process_PiAskInteractions",
    );
    const config = configs.get("Task_DynamicChoiceInput");
    expect(config).toBeDefined();

    let error: Error | undefined;
    try {
      resolveHumanTaskConfig(
        config!,
        {
          currentQuestion: {
            prompt: "Which repair path should the workflow use?",
            choices: ["minimal", "broaden"],
          },
          currentChoices: [
            {
              value: "minimal",
              label: "Minimal repair",
              description: "Repair only the invalid BPMN contract.",
            },
          ],
        },
        {
          activityId: "Task_DynamicChoiceInput",
        },
      );
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }

    expect(error?.message).toMatchSnapshot();
    expect(error?.message).toContain("[pi-wendao.runtime.invalid_dynamic_question]");
    expect(error?.message).toContain("Consumer activity: Task_DynamicChoiceInput");
    expect(error?.message).toContain("Variable: currentQuestion");
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

  it("rejects stringified dynamic choices instead of deserializing legacy payloads", () => {
    const configs = buildPiWendaoConfigMap(
      readFileSync(fixturePath, "utf-8"),
      "Process_PiAskInteractions",
    );
    const config = configs.get("Task_DynamicChoiceInput");
    expect(config).toBeDefined();

    expect(() =>
      resolveHumanTaskConfig(
        config!,
        {
          currentQuestion: "Which repair path should the workflow use?",
          currentChoices: JSON.stringify([
            {
              value: "minimal",
              label: "Minimal repair",
            },
          ]),
        },
        {
          activityId: "Task_DynamicChoiceInput",
        },
      ),
    ).toThrow("Problem: ref did not resolve to a JSON array");
  });

  it("rejects dynamic choices whose value field is not a string", () => {
    const configs = buildPiWendaoConfigMap(
      readFileSync(fixturePath, "utf-8"),
      "Process_PiAskInteractions",
    );
    const config = configs.get("Task_DynamicChoiceInput");
    expect(config).toBeDefined();

    expect(() =>
      resolveHumanTaskConfig(
        config!,
        {
          currentQuestion: "Which repair path should the workflow use?",
          currentChoices: [
            {
              value: 1,
              label: "Numeric value",
            },
          ],
        },
        {
          activityId: "Task_DynamicChoiceInput",
        },
      ),
    ).toThrow("Problem: item is missing required non-empty value");
  });

  it("preserves streamed host-work form choice descriptions for native prompts", () => {
    const work: QianjiHostWork = {
      kind: "user",
      node_id: "Task_StaticChoice",
      token_id: 1,
      form: {
        interaction_type: "choice",
        question_text: "Which path?",
        choices: [
          {
            value: "direct",
            label: "Use direct path",
            description: "Proceed with the shortest implementation path.",
          },
        ],
        result_output: "answer",
      },
    };

    expect(
      mergeQianjiHostWorkFormConfig(
        {
          prompt: "Local XML prompt should not replace host-work form.",
          tools: [],
          inputs: [],
          outputs: [],
        },
        work,
      ).interaction?.choices,
    ).toEqual([
      {
        value: "direct",
        label: "Use direct path",
        description: "Proceed with the shortest implementation path.",
      },
    ]);
  });

  it("rejects streamed human host work without native form metadata before local XML fallback", () => {
    const work: QianjiHostWork = {
      kind: "user",
      node_id: "Task_LocalInteraction",
      token_id: 1,
    };

    expect(() =>
      mergeQianjiHostWorkFormConfig(
        {
          prompt: "Local XML prompt must not be used as a fallback.",
          tools: [],
          inputs: [],
          outputs: ["approved"],
          interaction: {
            type: "confirm",
            question: "Approve from local XML?",
            result: { output: "approved" },
          },
        },
        work,
      ),
    ).toThrow("[pi-wendao.runtime.missing_native_human_task_form]");
    expect(() =>
      mergeQianjiHostWorkFormConfig(
        {
          prompt: "Local XML prompt must not be used as a fallback.",
          tools: [],
          inputs: [],
          outputs: ["approved"],
          interaction: {
            type: "confirm",
            question: "Approve from local XML?",
            result: { output: "approved" },
          },
        },
        work,
      ),
    ).toThrow("no longer infers human-task interaction metadata from local BPMN XML");
  });

  it("rejects streamed human host work without native result output before local output fallback", () => {
    const work: QianjiHostWork = {
      kind: "manual",
      node_id: "Task_LocalOutputs",
      token_id: 2,
      form: {
        interaction_type: "confirm",
        question_text: "Approve from host work?",
      },
    };

    expect(() =>
      mergeQianjiHostWorkFormConfig(
        {
          prompt: "Local XML prompt must not be used as a fallback.",
          tools: [],
          inputs: [],
          outputs: ["approved"],
          interaction: {
            type: "confirm",
            question: "Approve from local XML?",
            result: { output: "approved" },
          },
        },
        work,
      ),
    ).toThrow("[pi-wendao.runtime.missing_native_answer_output]");
    expect(() =>
      mergeQianjiHostWorkFormConfig(
        {
          prompt: "Local XML prompt must not be used as a fallback.",
          tools: [],
          inputs: [],
          outputs: ["approved"],
          interaction: {
            type: "confirm",
            question: "Approve from local XML?",
            result: { output: "approved" },
          },
        },
        work,
      ),
    ).toThrow("pi-wendao does not infer outputs from local XML");
  });

  it("keeps free-text field names out of human-task completion outputs", () => {
    const work: QianjiHostWork = {
      kind: "user",
      node_id: "Task_ChoiceInput",
      token_id: 2,
      form: {
        interaction_type: "choice_input",
        question_text: "Which path?",
        choices: [{ value: "direct", label: "Use direct path" }],
        free_text_fields: [{ name: "customNote", optional: true }],
        result_output: "selectedPath",
      },
    };

    const config = mergeQianjiHostWorkFormConfig(
      {
        prompt: "Local XML prompt should not replace host-work form.",
        tools: [],
        inputs: [],
        outputs: ["customNote"],
      },
      work,
    );

    expect(config.outputs).toEqual(["selectedPath"]);
    expect(config.interaction?.freeText).toEqual({
      name: "customNote",
      optional: true,
    });
    expect(config.interaction?.result).toEqual({ output: "selectedPath" });
  });

  it("rejects multiple streamed free-text fields before rendering", () => {
    const work: QianjiHostWork = {
      kind: "user",
      node_id: "Task_MultiInput",
      token_id: 3,
      form: {
        interaction_type: "input",
        question_text: "Enter both values.",
        free_text_fields: [
          { name: "firstValue", optional: false },
          { name: "secondValue", optional: false },
        ],
        result_output: "submittedValue",
      },
    };

    expect(() =>
      mergeQianjiHostWorkFormConfig(
        {
          prompt: "Local XML prompt should not replace host-work form.",
          tools: [],
          inputs: [],
          outputs: [],
        },
        work,
      ),
    ).toThrow("[pi-wendao.runtime.unsupported_native_free_text_fields]");
    expect(() =>
      mergeQianjiHostWorkFormConfig(
        {
          prompt: "Local XML prompt should not replace host-work form.",
          tools: [],
          inputs: [],
          outputs: [],
        },
        work,
      ),
    ).toThrow("streamed 2 free_text_fields");
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

});
