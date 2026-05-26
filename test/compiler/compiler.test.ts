import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai";
import { compileSkill } from "../../src/compiler/compiler.js";
import {
  nativeDefinitions,
  nativeHumanTask,
  nativeServiceTask,
} from "../support/native-bpmn.js";

const fixturesDir = join(import.meta.dirname, "../fixtures");

function qianjiTemplate() {
  return {
    constructRunner: async (request: { kind: "index" } | { kind: "show"; id: string }) => ({
      success: true as const,
      output:
        request.kind === "index"
          ? "# Qianji Construct Index\n\n| ID | Domain |\n| --- | --- |\n| `service-task.agent` | bpmn |\n| `user-task.interaction` | bpmn |\n| `gateway.exclusive.bounded` | bpmn |"
          : `# Qianji Construct Card: ${request.id}\n\n## Example\n\n\`\`\`xml\n<definitions/>\n\`\`\``,
    }),
    runner: async (domain: "bpmn" | "dmn") => ({
      success: true as const,
      template:
        domain === "bpmn"
          ? '<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="Process_1" isExecutable="true"/></definitions>'
          : '<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="Definitions_1" namespace="https://qianji.dev/dmn"><decision id="skill-decision"><decisionTable id="table_1" hitPolicy="UNIQUE"><input id="input_1"><inputExpression id="input_expression_1" typeRef="string"><text>input</text></inputExpression></input><output id="output_1" name="decision" typeRef="string"/><rule id="rule_1"><inputEntry id="input_entry_1"><text>-</text></inputEntry><outputEntry id="output_entry_1"><text>"review"</text></outputEntry></rule></decisionTable></decision></definitions>',
    }),
  };
}

function bpmnTarget() {
  return {
    runner: async () => ({
      target: "bpmn" as const,
      reason: "test default",
      dmnDecisions: [],
    }),
  };
}

function interactiveBpmnTarget() {
  return {
    runner: async () => ({
      target: "bpmn" as const,
      reason: "interactive test target",
      dmnDecisions: [],
      scenario: "interactive" as const,
      selectedConstructs: ["service-task.agent", "user-task.interaction"],
    }),
  };
}

describe("compileSkill", () => {
  let faux: FauxProviderRegistration;

  beforeEach(() => {
    faux = registerFauxProvider();
  });

  afterEach(() => {
    faux.unregister();
  });

  it("compiles a skill into BPMN XML", async () => {
    const expectedXml = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");

    faux.setResponses([fauxAssistantMessage("```xml\n" + expectedXml + "\n```")]);

    const result = await compileSkill({
      skillContent: "# Simple Skill\nDo something.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: false,
    });

    expect(result.success).toBe(true);
    expect(result.bpmnXml).toContain("<definitions");
    expect(result.bpmnXml).toContain("serviceTask");
  });

  it("handles raw XML without code fences", async () => {
    const xml =
      '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P1" isExecutable="true"><startEvent id="S1"/></process></definitions>';

    faux.setResponses([fauxAssistantMessage(xml)]);

    const result = await compileSkill({
      skillContent: "# Skill\nDo it.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: false,
    });

    expect(result.success).toBe(true);
    expect(result.bpmnXml).toContain("<definitions");
  });

  it("lets the model choose BPMN+DMN and returns both artifacts", async () => {
    const bpmn =
      '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P1" isExecutable="true"><startEvent id="S1"/><businessRuleTask id="Decision_1" decisionRef="eligibility-decision"/><endEvent id="E1"/></process></definitions>';
    const dmn =
      '<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="Definitions_1" namespace="https://qianji.dev/dmn"><decision id="eligibility-decision" name="Eligibility"><decisionTable id="Table_1" hitPolicy="UNIQUE"><input id="Input_1"><inputExpression id="InputExpression_1" typeRef="string"><text>tier</text></inputExpression></input><output id="Output_1" name="eligible" typeRef="boolean"/><rule id="Rule_1"><inputEntry id="InputEntry_1"><text>"gold"</text></inputEntry><outputEntry id="OutputEntry_1"><text>true</text></outputEntry></rule></decisionTable></decision></definitions>';

    faux.setResponses([
      fauxAssistantMessage(
        '{"target":"bpmn-dmn","reason":"The skill has a stable eligibility table.","dmnDecisions":["eligibility-decision"]}',
      ),
      fauxAssistantMessage("```bpmn\n" + bpmn + "\n```\n```dmn\n" + dmn + "\n```"),
    ]);

    const result = await compileSkill({
      skillContent: "# Skill\nUse an eligibility table.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      lint: false,
    });

    expect(result.success).toBe(true);
    expect(result.targetDecision?.target).toBe("bpmn-dmn");
    expect(result.bpmnXml).toContain("businessRuleTask");
    expect(result.dmnXml).toContain("eligibility-decision");
  });

  it("normalizes pure DMN target decisions into BPMN+DMN", async () => {
    const bpmn =
      '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P1" isExecutable="true"><startEvent id="S1"/><businessRuleTask id="Decision_1" decisionRef="eligibility-decision"/><endEvent id="E1"/></process></definitions>';
    const dmn =
      '<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="Definitions_1" namespace="https://qianji.dev/dmn"><decision id="eligibility-decision" name="Eligibility"><decisionTable id="Table_1" hitPolicy="UNIQUE"><input id="Input_1"><inputExpression id="InputExpression_1" typeRef="string"><text>tier</text></inputExpression></input><output id="Output_1" name="eligible" typeRef="boolean"/><rule id="Rule_1"><inputEntry id="InputEntry_1"><text>-</text></inputEntry><outputEntry id="OutputEntry_1"><text>true</text></outputEntry></rule></decisionTable></decision></definitions>';

    faux.setResponses([
      fauxAssistantMessage(
        '{"target":"dmn","reason":"The skill is mostly a decision table.","dmnDecisions":["eligibility-decision"]}',
      ),
      fauxAssistantMessage("```bpmn\n" + bpmn + "\n```\n```dmn\n" + dmn + "\n```"),
    ]);

    const result = await compileSkill({
      skillContent: "# Skill\nUse an eligibility table.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      lint: false,
    });

    expect(result.success).toBe(true);
    expect(result.targetDecision?.target).toBe("bpmn-dmn");
    expect(result.targetDecision?.normalizedFrom).toBe("dmn");
    expect(result.dmnXml).toContain("eligibility-decision");
  });

  it("returns error when model produces no XML", async () => {
    faux.setResponses([fauxAssistantMessage("I cannot compile this skill.")]);

    const result = await compileSkill({
      skillContent: "# Skill\nDo it.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: false,
    });

    expect(result.success).toBe(false);
    expect(result.errors).toContain("No valid XML found in model response");
  });

  it("returns error when model errors", async () => {
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "Rate limit" }),
    ]);

    const result = await compileSkill({
      skillContent: "# Skill\nDo it.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: false,
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain("Rate limit");
  });

  it("loads qianji template before requesting BPMN from the model", async () => {
    const expectedXml = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
    const requestedTemplates: string[] = [];
    faux.setResponses([fauxAssistantMessage("```xml\n" + expectedXml + "\n```")]);

    const result = await compileSkill({
      skillContent: "# Skill\nDo it.",
      model: faux.getModel(),
      template: {
        constructRunner: async () => ({ success: true, output: "# Qianji Construct Index" }),
        runner: async (domain) => {
          requestedTemplates.push(domain);
          return { success: true, template: `<${domain}/>` };
        },
      },
      target: bpmnTarget(),
      lint: false,
    });

    expect(result.success).toBe(true);
    expect(requestedTemplates).toEqual(["bpmn"]);
  });

  it("loads only selected qianji construct cards plus minimal compiler defaults", async () => {
    const expectedXml = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
    const requestedConstructs: string[] = [];
    faux.setResponses([fauxAssistantMessage("```xml\n" + expectedXml + "\n```")]);

    const result = await compileSkill({
      skillContent: "# Skill\nAsk the user, then run a task.",
      model: faux.getModel(),
      template: {
        constructRunner: async (request) => {
          requestedConstructs.push(request.kind === "show" ? request.id : request.kind);
          return {
            success: true,
            output: request.kind === "index" ? "# Qianji Construct Index" : `# ${request.id}`,
          };
        },
        runner: async (domain) => ({ success: true, template: `<${domain}/>` }),
      },
      target: {
        runner: async () => ({
          target: "bpmn",
          scenario: "interactive",
          selectedConstructs: ["user-task.interaction"],
          reason: "The skill asks the user before execution.",
          dmnDecisions: [],
        }),
      },
      lint: false,
    });

    expect(result.success).toBe(true);
    expect(requestedConstructs).toEqual(["index", "user-task.interaction", "service-task.agent"]);
    expect(requestedConstructs).not.toContain("gateway.exclusive.bounded");
  });

  it("returns template errors before model compilation", async () => {
    const result = await compileSkill({
      skillContent: "---\nname: [oops\n---\n# Skill",
      model: faux.getModel(),
      template: {
        constructRunner: async () => ({ success: true, output: "# Qianji Construct Index" }),
        runner: async () => ({ success: false, errors: ["qianji template failed"] }),
      },
      target: bpmnTarget(),
      lint: false,
    });

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(["qianji template failed"]);
  });

  it("feeds qianji lint failures through the compile repair loop", async () => {
    const invalidXml =
      '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P1" isExecutable="true"><startEvent id="S1"/><exclusiveGateway id="Gateway_1"/><sequenceFlow id="Flow_1" sourceRef="Gateway_1" targetRef="S2"><conditionExpression>status == "ready"</conditionExpression></sequenceFlow><endEvent id="S2"/></process></definitions>';
    const repairedXml = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
    const lintedXml: string[] = [];

    faux.setResponses([
      fauxAssistantMessage("```xml\n" + invalidXml + "\n```"),
      fauxAssistantMessage("```xml\n" + repairedXml + "\n```"),
    ]);

    const result = await compileSkill({
      skillContent: "# Skill\nDo it.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: {
        maxRepairAttempts: 1,
        runner: async (xml) => {
          lintedXml.push(xml);
          if (xml.includes("status ==")) {
            return { success: false, output: "unsupported gateway condition" };
          }
          return { success: true, output: "ok" };
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.bpmnXml).toContain("<definitions");
    expect(lintedXml[0]).toBe(invalidXml);
    expect(lintedXml.at(-1)?.trim()).toBe(repairedXml.trim());
  });

  it("writes per-attempt repair traces when traceDir is configured", async () => {
    const invalidXml =
      '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P1" isExecutable="true"><startEvent id="S1"/><exclusiveGateway id="Gateway_1"/><sequenceFlow id="Flow_1" sourceRef="Gateway_1" targetRef="S2"><conditionExpression>status == "ready"</conditionExpression></sequenceFlow><endEvent id="S2"/></process></definitions>';
    const repairedXml = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
    const traceRoot = mkdtempSync(join(tmpdir(), "pi-wendao-compile-trace-test-"));
    const messages: string[] = [];

    try {
      faux.setResponses([
        fauxAssistantMessage("```xml\n" + invalidXml + "\n```"),
        fauxAssistantMessage("```xml\n" + repairedXml + "\n```"),
      ]);

      const result = await compileSkill({
        skillContent: "# Skill\nDo it.",
        model: faux.getModel(),
        template: qianjiTemplate(),
        target: bpmnTarget(),
        lint: {
          maxRepairAttempts: 1,
          traceDir: traceRoot,
          onMessage: (message) => messages.push(message),
          runner: async (xml) => {
            if (xml.includes("status ==")) {
              return {
                success: false,
                output: "[bpmn.unsupported_gateway_configuration] compact failure",
                diagnostics: { qianji: "[bpmn.unsupported_gateway_configuration] compact failure" },
              };
            }
            return {
              success: true,
              output: "[ok] compact lint passed",
              diagnostics: { qianji: "[ok] compact lint passed" },
            };
          },
        },
      });

      expect(result.success).toBe(true);
      const traceDirs = readdirSync(traceRoot);
      expect(traceDirs).toHaveLength(1);
      const traceDir = join(traceRoot, traceDirs[0]);
      expect(messages.some((message) => message.includes(traceDir))).toBe(true);
      expect(readFileSync(join(traceDir, "attempt-0.bpmn"), "utf-8")).toContain("status ==");
      expect(readFileSync(join(traceDir, "qianji-lint-0.txt"), "utf-8")).toContain(
        "compact failure",
      );
      expect(readFileSync(join(traceDir, "attempt-1.bpmn"), "utf-8")).toContain("Task_1");
      expect(readFileSync(join(traceDir, "qianji-lint-1.txt"), "utf-8")).toContain(
        "compact lint passed",
      );
      expect(readFileSync(join(traceDir, "contract-1.txt"), "utf-8")).toContain(
        "pi-wendao compile contract passed",
      );
      expect(existsSync(join(traceDir, "target-decision.json"))).toBe(true);
    } finally {
      rmSync(traceRoot, { recursive: true, force: true });
    }
  });

  it("uses compact qianji lint output for repair prompts while keeping json analysis internal", async () => {
    const xml = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
    const tempDir = mkdtempSync(join(tmpdir(), "pi-wendao-qianji-lint-command-test-"));
    const commandPath = join(tempDir, "qianji-lint-stub.mjs");
    const argsRecordPath = join(tempDir, "args.jsonl");
    const previousRecord = process.env.QIANJI_ARGS_RECORD;

    writeFileSync(
      commandPath,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.QIANJI_ARGS_RECORD, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ analysis: { gateway_conditions: [] } }));
} else {
  console.log("[ok] compact lint output");
}
`,
    );
    chmodSync(commandPath, 0o755);

    try {
      process.env.QIANJI_ARGS_RECORD = argsRecordPath;
      faux.setResponses([fauxAssistantMessage("```xml\n" + xml + "\n```")]);

      const result = await compileSkill({
        skillContent: "# Skill\nDo it.",
        model: faux.getModel(),
        template: qianjiTemplate(),
        target: bpmnTarget(),
        lint: {
          command: commandPath,
          maxRepairAttempts: 0,
        },
      });

      expect(result.success).toBe(true);
      const calls = readFileSync(argsRecordPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual([
        "lint",
        "--bpmn",
        expect.stringContaining("workflow.bpmn"),
        "--llm",
      ]);
      expect(calls[1]).toEqual([
        "lint",
        "--bpmn",
        expect.stringContaining("workflow.bpmn"),
        "--json",
      ]);
    } finally {
      if (previousRecord === undefined) {
        delete process.env.QIANJI_ARGS_RECORD;
      } else {
        process.env.QIANJI_ARGS_RECORD = previousRecord;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("uses qianji json analysis from failed lint runs for pi-wendao contract checks", async () => {
    const xml = nativeDefinitions(
      "P1",
      [
        '    <startEvent id="S1"/>',
        nativeHumanTask({
          id: "Task_1",
          documentation: "Ask for a command.",
          resultOutput: "verificationCommand",
          interactionType: "input",
          freeText: { name: "verificationCommand" },
        }),
        nativeServiceTask({
          id: "Task_2",
          documentation: "Run the command and return output.",
          inputs: ["verificationCommand"],
          outputs: ["verificationOutput", "exitCode", "failureCount"],
        }),
        '    <exclusiveGateway id="Gateway_1" default="Flow_4"/>',
        '    <endEvent id="Task_3"/>',
        '    <endEvent id="Task_4"/>',
        '    <sequenceFlow id="Flow_1" sourceRef="S1" targetRef="Task_1"/>',
        '    <sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="Task_2"/>',
        '    <sequenceFlow id="Flow_3" sourceRef="Task_2" targetRef="Gateway_1"/>',
        '    <sequenceFlow id="Flow_4" sourceRef="Gateway_1" targetRef="Task_3">',
        "      <conditionExpression>not verificationPassed</conditionExpression>",
        "    </sequenceFlow>",
        '    <sequenceFlow id="Flow_5" sourceRef="Gateway_1" targetRef="Task_4">',
        "      <conditionExpression>verificationPassed</conditionExpression>",
        "    </sequenceFlow>",
      ].join("\n"),
    );
    const tempDir = mkdtempSync(join(tmpdir(), "pi-wendao-qianji-failed-json-test-"));
    const commandPath = join(tempDir, "qianji-lint-failed-json-stub.mjs");
    const argsRecordPath = join(tempDir, "args.jsonl");
    const previousRecord = process.env.QIANJI_ARGS_RECORD;

    writeFileSync(
      commandPath,
      `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.QIANJI_ARGS_RECORD, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({
    analysis: {
      gateway_conditions: [{
        source_ref: "Gateway_1",
        target_ref: "Task_3",
        raw: "not verificationPassed",
        parsed: { kind: "boolean_path", path: "verificationPassed" }
      }, {
        source_ref: "Gateway_1",
        target_ref: "Task_4",
        raw: "verificationPassed",
        parsed: { kind: "boolean_path", path: "verificationPassed" }
      }]
    }
  }));
  process.exit(2);
}
console.log("[lint:error] default branch must stay unconditional");
process.exit(2);
`,
    );
    chmodSync(commandPath, 0o755);

    try {
      process.env.QIANJI_ARGS_RECORD = argsRecordPath;
      faux.setResponses([fauxAssistantMessage("```xml\n" + xml + "\n```")]);

      const result = await compileSkill({
        skillContent: "# Skill\nVerify before completion.",
        model: faux.getModel(),
        template: qianjiTemplate(),
        target: bpmnTarget(),
        lint: {
          command: commandPath,
          maxRepairAttempts: 0,
        },
      });

      expect(result.success).toBe(false);
      expect(result.errors?.[0]).toContain("default branch must stay unconditional");
      expect(result.errors?.[0]).toContain("PI_WENDAO_CONDITION_VARIABLE_UNDECLARED");
      expect(result.errors?.[0]).toContain("verificationPassed");
      expect(result.errors?.[0]).toContain("Gateway_1 -> Task_4");
      expect(result.errors?.[0]).toContain("Gateway_1 -> Task_3");
      expect(result.errors?.[0]?.match(/PI_WENDAO_CONDITION_VARIABLE_UNDECLARED/g)).toHaveLength(2);
      const calls = readFileSync(argsRecordPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual([
        "lint",
        "--bpmn",
        expect.stringContaining("workflow.bpmn"),
        "--llm",
      ]);
      expect(calls[1]).toEqual([
        "lint",
        "--bpmn",
        expect.stringContaining("workflow.bpmn"),
        "--json",
      ]);
    } finally {
      if (previousRecord === undefined) {
        delete process.env.QIANJI_ARGS_RECORD;
      } else {
        process.env.QIANJI_ARGS_RECORD = previousRecord;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("feeds pi-wendao compile contract failures back through the lint repair loop", async () => {
    const missingPiWendaoConfigXml = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
  <process id="P1" isExecutable="true">
    <startEvent id="S1"/>
    <serviceTask id="Task_1"/>
    <endEvent id="E1"/>
    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_1"/>
    <sequenceFlow id="F2" sourceRef="Task_1" targetRef="E1"/>
  </process>
</definitions>`;
    const repairedXml = readFileSync(join(fixturesDir, "simple-workflow.bpmn"), "utf-8");
    const lintedXml: string[] = [];

    faux.setResponses([
      fauxAssistantMessage("```xml\n" + missingPiWendaoConfigXml + "\n```"),
      fauxAssistantMessage("```xml\n" + repairedXml + "\n```"),
    ]);

    const result = await compileSkill({
      skillContent: "# Skill\nList files.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: {
        maxRepairAttempts: 1,
        runner: async (xml) => {
          lintedXml.push(xml);
          return { success: true, output: "# Lint Passed" };
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.bpmnXml?.trim()).toBe(repairedXml.trim());
    expect(lintedXml).toHaveLength(2);
    expect(lintedXml[0]).toBe(missingPiWendaoConfigXml);
  });

  it("lints BPMN and DMN artifacts in the compile loop", async () => {
    const bpmn =
      '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="P1" isExecutable="true"><startEvent id="S1"/><businessRuleTask id="Decision_1" decisionRef="eligibility-decision"/><endEvent id="E1"/></process></definitions>';
    const dmn =
      '<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="Definitions_1" namespace="https://qianji.dev/dmn"><decision id="eligibility-decision" name="Eligibility"><decisionTable id="Table_1" hitPolicy="UNIQUE"><input id="Input_1"><inputExpression id="InputExpression_1" typeRef="string"><text>tier</text></inputExpression></input><output id="Output_1" name="eligible" typeRef="boolean"/><rule id="Rule_1"><inputEntry id="InputEntry_1"><text>-</text></inputEntry><outputEntry id="OutputEntry_1"><text>true</text></outputEntry></rule></decisionTable></decision></definitions>';
    const lintedBpmn: string[] = [];
    const lintedDmn: string[] = [];

    faux.setResponses([
      fauxAssistantMessage("```bpmn\n" + bpmn + "\n```\n```dmn\n" + dmn + "\n```"),
    ]);

    const result = await compileSkill({
      skillContent: "# Skill\nUse an eligibility table.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: {
        runner: async () => ({
          target: "bpmn-dmn",
          reason: "test table target",
          dmnDecisions: ["eligibility-decision"],
        }),
      },
      lint: {
        maxRepairAttempts: 0,
        runner: async (xml) => {
          lintedBpmn.push(xml);
          return { success: true, output: "# BPMN Lint Passed" };
        },
        dmnRunner: async (xml) => {
          lintedDmn.push(xml);
          return { success: true, output: "# DMN Lint Passed" };
        },
      },
    });

    expect(result.success).toBe(true);
    expect(lintedBpmn).toEqual([bpmn]);
    expect(lintedDmn).toEqual([dmn]);
    expect(result.dmnXml).toBe(dmn);
  });

  it("reports unsupported pi-wendao runtime fields as lint feedback", async () => {
    const unsupportedRuntimeFieldsXml = nativeDefinitions(
      "P1",
      [
        '    <startEvent id="S1"/>',
        nativeServiceTask({
          id: "Task_1",
          documentation: "Fetch a remote page and summarize it.",
          inputs: ["source url"],
          outputs: ["report summary"],
        }),
        '    <endEvent id="E1"/>',
        '    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_1"/>',
        '    <sequenceFlow id="F2" sourceRef="Task_1" targetRef="E1"/>',
      ].join("\n"),
    );

    faux.setResponses([fauxAssistantMessage("```xml\n" + unsupportedRuntimeFieldsXml + "\n```")]);

    const result = await compileSkill({
      skillContent: "# Skill\nFetch and summarize.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: {
        maxRepairAttempts: 0,
        runner: async () => ({ success: true, output: "# Lint Passed" }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain("PI_WENDAO_VARIABLE_IDENTIFIER");
    expect(result.errors?.[0]).toContain("source url");
    expect(result.errors?.[0]).toContain("report summary");
    expect(result.errors?.[0]).not.toContain("LLM Fix Prompt");
  });

  it("reports invalid native user interaction contracts as lint feedback", async () => {
    const invalidInteractionXml = nativeDefinitions(
      "P1",
      [
        '    <startEvent id="S1"/>',
        nativeHumanTask({
          id: "Task_Ask",
          documentation: "Ask the user to choose.",
          resultOutput: "answer",
          interactionType: "choice",
        }),
        '    <endEvent id="E1"/>',
        '    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_Ask"/>',
        '    <sequenceFlow id="F2" sourceRef="Task_Ask" targetRef="E1"/>',
      ].join("\n"),
    );

    faux.setResponses([fauxAssistantMessage("```xml\n" + invalidInteractionXml + "\n```")]);

    const result = await compileSkill({
      skillContent: "# Skill\nAsk the user.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: {
        maxRepairAttempts: 0,
        runner: async () => ({ success: true, output: "# Lint Passed" }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain("PI_WENDAO_INTERACTION_CHOICES");
  });

  it("rejects userTask interactions without a native answer output mapping", async () => {
    const missingAnswerXml = nativeDefinitions(
      "P1",
      [
        '    <startEvent id="S1"/>',
        `    <userTask id="Task_Ask">
      <documentation>Ask the user to choose.</documentation>
      <ioSpecification>
        <dataInput id="Task_Ask_input_interactionType" name="interactionType" />
        <dataInput id="Task_Ask_input_choices" name="choices" />
        <inputSet id="Task_Ask_input_set">
          <dataInputRefs>Task_Ask_input_interactionType</dataInputRefs>
          <dataInputRefs>Task_Ask_input_choices</dataInputRefs>
        </inputSet>
      </ioSpecification>
      <dataInputAssociation>
        <assignment><from>choice</from><to>Task_Ask_input_interactionType</to></assignment>
      </dataInputAssociation>
      <dataInputAssociation>
        <assignment><from>[{"value":"approve","label":"Approve"}]</from><to>Task_Ask_input_choices</to></assignment>
      </dataInputAssociation>
    </userTask>`,
        '    <endEvent id="E1"/>',
        '    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_Ask"/>',
        '    <sequenceFlow id="F2" sourceRef="Task_Ask" targetRef="E1"/>',
      ].join("\n"),
    );

    faux.setResponses([fauxAssistantMessage("```xml\n" + missingAnswerXml + "\n```")]);

    const result = await compileSkill({
      skillContent: "# Skill\nAsk the user.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: {
        maxRepairAttempts: 0,
        runner: async () => ({ success: true, output: "# Lint Passed" }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain("PI_WENDAO_USER_TASK_RESULT_OUTPUT");
    expect(result.errors?.[0]).toContain("no answer dataOutputAssociation targetRef");
  });

  it("rejects interactive target output that asks users from service tasks only", async () => {
    const serviceOnlyXml = nativeDefinitions(
      "P1",
      [
        '    <startEvent id="S1"/>',
        nativeServiceTask({
          id: "Task_AskPatient",
          documentation:
            "Ask the patient which appointment type they need and return selectedChoice.",
          outputs: ["selectedChoice"],
        }),
        '    <endEvent id="E1"/>',
        '    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_AskPatient"/>',
        '    <sequenceFlow id="F2" sourceRef="Task_AskPatient" targetRef="E1"/>',
      ].join("\n"),
    );

    faux.setResponses([fauxAssistantMessage("```xml\n" + serviceOnlyXml + "\n```")]);

    const result = await compileSkill({
      skillContent: "# Skill\nAsk one question at a time and prefer multiple choice.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: interactiveBpmnTarget(),
      lint: {
        maxRepairAttempts: 0,
        runner: async () => ({ success: true, output: "# Lint Passed" }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain("PI_WENDAO_INTERACTIVE_USER_TASK_REQUIRED");
    expect(result.errors?.[0]).toContain("PI_WENDAO_SERVICE_TASK_HUMAN_INPUT");
    expect(result.errors?.[0]).toContain("userTask with native interaction IO");
    expect(result.errors?.[0]).toContain('dataInput name="interactionType"');
  });

  it("rejects service tasks that collect human answers even when another userTask exists", async () => {
    const mixedXml = nativeDefinitions(
      "P1",
      [
        '    <startEvent id="S1"/>',
        nativeServiceTask({
          id: "Task_PrepareQuestion",
          documentation: "Prepare one appointment question.",
          outputs: ["currentQuestion", "currentChoices"],
        }),
        nativeHumanTask({
          id: "Task_Answer",
          documentation: "Collect the user's answer.",
          inputs: ["currentQuestion", "currentChoices"],
          resultOutput: "answer",
          interactionType: "choice_input",
          questionRef: "currentQuestion",
          choicesRef: "currentChoices",
        }),
        nativeServiceTask({
          id: "Task_VisitDetails",
          documentation:
            "Ask the user the following one question at a time and collect all answers as structured data.",
          inputs: ["answer"],
          outputs: ["visitReasonCategory", "preferredTimeWindow"],
        }),
        '    <endEvent id="E1"/>',
        '    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_PrepareQuestion"/>',
        '    <sequenceFlow id="F2" sourceRef="Task_PrepareQuestion" targetRef="Task_Answer"/>',
        '    <sequenceFlow id="F3" sourceRef="Task_Answer" targetRef="Task_VisitDetails"/>',
        '    <sequenceFlow id="F4" sourceRef="Task_VisitDetails" targetRef="E1"/>',
      ].join("\n"),
    );

    faux.setResponses([fauxAssistantMessage("```xml\n" + mixedXml + "\n```")]);

    const result = await compileSkill({
      skillContent: "# Skill\nAsk one question at a time and prefer multiple choice.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: interactiveBpmnTarget(),
      lint: {
        maxRepairAttempts: 0,
        runner: async () => ({ success: true, output: "# Lint Passed" }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain("PI_WENDAO_SERVICE_TASK_HUMAN_INPUT");
    expect(result.errors?.[0]).toContain("Task_VisitDetails");
    expect(result.errors?.[0]).not.toContain("PI_WENDAO_INTERACTIVE_USER_TASK_REQUIRED");
  });

  it("accepts dynamic choice refs for a real brainstorming multiple-choice fragment", async () => {
    const dynamicChoicesXml = nativeDefinitions(
      "P1",
      [
        '    <startEvent id="S1"/>',
        nativeServiceTask({
          id: "Task_PrepareQuestion",
          documentation:
            "Ask one clarifying question and prefer multiple choice when possible. Output currentQuestion and currentChoices.",
          inputs: ["idea"],
          outputs: ["currentQuestion", "currentChoices"],
        }),
        nativeHumanTask({
          id: "Task_Answer",
          documentation: "Collect the user's answer to the generated brainstorming question.",
          inputs: ["currentQuestion", "currentChoices"],
          resultOutput: "userAnswer",
          interactionType: "choice_input",
          questionRef: "currentQuestion",
          choicesRef: "currentChoices",
        }),
        '    <endEvent id="E1"/>',
        '    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_PrepareQuestion"/>',
        '    <sequenceFlow id="F2" sourceRef="Task_PrepareQuestion" targetRef="Task_Answer"/>',
        '    <sequenceFlow id="F3" sourceRef="Task_Answer" targetRef="E1"/>',
      ].join("\n"),
    );

    faux.setResponses([fauxAssistantMessage("```xml\n" + dynamicChoicesXml + "\n```")]);

    const result = await compileSkill({
      skillContent: [
        "# Brainstorming Ideas Into Designs",
        "Start by understanding the current project context, then ask questions one at a time to refine the idea.",
        "Prefer multiple choice questions when possible, but open-ended is fine too.",
      ].join("\n"),
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: {
        maxRepairAttempts: 0,
        runner: async () => ({ success: true, output: "# Lint Passed" }),
      },
    });

    expect(result.success).toBe(true);
    expect(result.bpmnXml).toContain("<sourceRef>currentChoices</sourceRef>");
    expect(result.bpmnXml).toContain('dataInput id="Task_Answer_input_choices" name="choices"');
    expect(result.bpmnXml).not.toContain("qianji:");
  });

  it("reports dynamic choice refs whose producer omits the native choices output", async () => {
    const missingDynamicChoicesProducerXml = nativeDefinitions(
      "P1",
      [
        '    <startEvent id="S1"/>',
        nativeServiceTask({
          id: "Task_PrepareQuestion",
          documentation:
            "Ask one clarifying question and prefer multiple choice when possible. Output currentQuestion.",
          inputs: ["idea"],
          outputs: ["currentQuestion"],
        }),
        nativeHumanTask({
          id: "Task_Answer",
          documentation: "Collect the user's answer to the generated brainstorming question.",
          inputs: ["currentQuestion", "currentChoices"],
          resultOutput: "userAnswer",
          interactionType: "choice_input",
          questionRef: "currentQuestion",
          choicesRef: "currentChoices",
        }),
        '    <endEvent id="E1"/>',
        '    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_PrepareQuestion"/>',
        '    <sequenceFlow id="F2" sourceRef="Task_PrepareQuestion" targetRef="Task_Answer"/>',
        '    <sequenceFlow id="F3" sourceRef="Task_Answer" targetRef="E1"/>',
      ].join("\n"),
    );

    faux.setResponses([fauxAssistantMessage("```xml\n" + missingDynamicChoicesProducerXml + "\n```")]);

    const result = await compileSkill({
      skillContent: "# Skill\nAsk the user a structured question.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: {
        maxRepairAttempts: 0,
        runner: async () => ({ success: true, output: "# Lint Passed" }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toMatchSnapshot();
    expect(result.errors?.[0]).toContain("PI_WENDAO_DYNAMIC_CHOICES_PRODUCER");
    expect(result.errors?.[0]).toContain("currentChoices");
    expect(result.errors?.[0]).toContain("native BPMN task declares that output");
  });

  it("reports gateway conditions that reference undeclared variables", async () => {
    const undeclaredConditionXml = nativeDefinitions(
      "P1",
      [
        '    <startEvent id="S1"/>',
        nativeHumanTask({
          id: "Task_Approve",
          documentation: "Ask for approval.",
          resultOutput: "designApproved",
          interactionType: "confirm",
        }),
        '    <exclusiveGateway id="Gateway_1" default="F3"/>',
        '    <endEvent id="E1"/>',
        '    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_Approve"/>',
        '    <sequenceFlow id="F2" sourceRef="Task_Approve" targetRef="Gateway_1"/>',
        '    <sequenceFlow id="F3" sourceRef="Gateway_1" targetRef="E1">',
        "      <conditionExpression>designRejected</conditionExpression>",
        "    </sequenceFlow>",
      ].join("\n"),
    );

    faux.setResponses([fauxAssistantMessage("```xml\n" + undeclaredConditionXml + "\n```")]);

    const result = await compileSkill({
      skillContent: "# Skill\nAsk the user.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: {
        maxRepairAttempts: 0,
        runner: async () => ({
          success: true,
          output: "# Lint Passed",
          qianji: {
            analysis: {
              gateway_conditions: [
                {
                  source_ref: "Gateway_1",
                  target_ref: "E1",
                  raw: "designRejected",
                  parsed: { kind: "boolean_path", path: "designRejected" },
                },
              ],
            },
          },
        }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain("PI_WENDAO_CONDITION_VARIABLE_UNDECLARED");
    expect(result.errors?.[0]).toContain("designRejected");
    expect(result.errors?.[0]).toContain("Task_Approve");
    expect(result.errors?.[0]).toContain("native BPMN data output");
    expect(result.errors?.[0]).toContain("already declared variable");
  });

  it("reports user feedback loops alongside parseable semantic lint failures", async () => {
    const unreadFeedbackLoopXml = nativeDefinitions(
      "P1",
      [
        '    <startEvent id="S1"/>',
        nativeServiceTask({
          id: "Task_Ask",
          documentation: "Produce the next question and whether more clarification is needed.",
          inputs: ["projectScope"],
          outputs: ["clarificationsNeeded", "currentQuestion"],
        }),
        nativeHumanTask({
          id: "Task_Answer",
          documentation: "Answer the current question.",
          inputs: ["currentQuestion"],
          resultOutput: "userAnswer",
          interactionType: "input",
          questionRef: "currentQuestion",
          freeText: { name: "userAnswer" },
        }),
        '    <exclusiveGateway id="Gateway_More" default="Flow_Done"/>',
        '    <endEvent id="E1"/>',
        '    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_Ask"/>',
        '    <sequenceFlow id="F2" sourceRef="Task_Ask" targetRef="Task_Answer"/>',
        '    <sequenceFlow id="F3" sourceRef="Task_Answer" targetRef="Gateway_More"/>',
        '    <sequenceFlow id="F4" sourceRef="Gateway_More" targetRef="Task_Ask">',
        '      <conditionExpression xsi:type="tFormalExpression">clarificationsNeeded</conditionExpression>',
        "    </sequenceFlow>",
        '    <sequenceFlow id="Flow_Done" sourceRef="Gateway_More" targetRef="E1"/>',
      ].join("\n"),
    );

    faux.setResponses([fauxAssistantMessage("```xml\n" + unreadFeedbackLoopXml + "\n```")]);

    const result = await compileSkill({
      skillContent: "# Skill\nAsk clarifying questions.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: {
        maxRepairAttempts: 0,
        runner: async () => ({
          success: false,
          output: "[bpmn.ambiguous_boolean_gateway_condition] compact qianji gateway diagnostic",
        }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain("compact qianji gateway diagnostic");
    expect(result.errors?.[0]).toContain("PI_WENDAO_USER_FEEDBACK_LOOP_UNREAD");
    expect(result.errors?.[0]).toContain("userAnswer");
    expect(result.errors?.[0]).toContain("Add dataInputAssociation sourceRef values userAnswer");
  });

  it("reports partial user feedback loop inputs with exact missing variables", async () => {
    const partialFeedbackLoopXml = nativeDefinitions(
      "P1",
      [
        '    <startEvent id="S1"/>',
        nativeServiceTask({
          id: "Task_Ask",
          documentation: "Produce the next question using the prior feedback.",
          inputs: ["projectScope"],
          outputs: ["needsMore", "currentQuestion", "currentChoices"],
        }),
        nativeHumanTask({
          id: "Task_Answer",
          documentation: "Answer the current question.",
          inputs: ["currentQuestion", "currentChoices"],
          resultOutput: "feedback",
          interactionType: "choice_input",
          questionRef: "currentQuestion",
          choicesRef: "currentChoices",
          freeText: { name: "feedback", optional: true },
        }),
        '    <exclusiveGateway id="Gateway_More" default="Flow_Done"/>',
        '    <endEvent id="E1"/>',
        '    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_Ask"/>',
        '    <sequenceFlow id="F2" sourceRef="Task_Ask" targetRef="Task_Answer"/>',
        '    <sequenceFlow id="F3" sourceRef="Task_Answer" targetRef="Gateway_More"/>',
        '    <sequenceFlow id="F4" sourceRef="Gateway_More" targetRef="Task_Ask">',
        '      <conditionExpression xsi:type="tFormalExpression">needsMore</conditionExpression>',
        "    </sequenceFlow>",
        '    <sequenceFlow id="Flow_Done" sourceRef="Gateway_More" targetRef="E1"/>',
      ].join("\n"),
    );

    faux.setResponses([fauxAssistantMessage("```xml\n" + partialFeedbackLoopXml + "\n```")]);

    const result = await compileSkill({
      skillContent: "# Skill\nAsk clarifying questions.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: {
        maxRepairAttempts: 0,
        runner: async () => ({ success: true, output: "# Lint Passed" }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain("PI_WENDAO_USER_FEEDBACK_LOOP_UNREAD");
    expect(result.errors?.[0]).toContain("does not consume user output(s): feedback");
    expect(result.errors?.[0]).toContain("Add dataInputAssociation sourceRef values feedback");
  });
});
