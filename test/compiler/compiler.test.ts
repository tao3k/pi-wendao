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
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import type { FauxProviderRegistration } from "@mariozechner/pi-ai";
import { compileSkill } from "../../src/compiler/compiler.js";

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
    const xml = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:qianji="https://qianji.dev/bpmn/extensions">
  <process id="P1" isExecutable="true">
    <startEvent id="S1"/>
    <userTask id="Task_1">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Ask for a command.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs></qianji:inputs>
          <qianji:outputs>verificationCommand</qianji:outputs>
        </qianji:config>
      </extensionElements>
    </userTask>
    <serviceTask id="Task_2" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Run the command and return output.</qianji:prompt>
          <qianji:tools>bash</qianji:tools>
          <qianji:inputs>verificationCommand</qianji:inputs>
          <qianji:outputs>verificationOutput,exitCode,failureCount</qianji:outputs>
        </qianji:config>
      </extensionElements>
    </serviceTask>
    <exclusiveGateway id="Gateway_1" default="Flow_4"/>
    <endEvent id="Task_3"/>
    <endEvent id="Task_4"/>
    <sequenceFlow id="Flow_1" sourceRef="S1" targetRef="Task_1"/>
    <sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="Task_2"/>
    <sequenceFlow id="Flow_3" sourceRef="Task_2" targetRef="Gateway_1"/>
    <sequenceFlow id="Flow_4" sourceRef="Gateway_1" targetRef="Task_3">
      <conditionExpression>not verificationPassed</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="Flow_5" sourceRef="Gateway_1" targetRef="Task_4">
      <conditionExpression>verificationPassed</conditionExpression>
    </sequenceFlow>
  </process>
</definitions>`;
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
      expect(result.errors?.[0]).not.toContain("Gateway_1 -> Task_3");
      expect(result.errors?.[0]?.match(/PI_WENDAO_CONDITION_VARIABLE_UNDECLARED/g)).toHaveLength(1);
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
    const unsupportedRuntimeFieldsXml = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:qianji="https://qianji.dev/bpmn/extensions">
  <process id="P1" isExecutable="true">
    <startEvent id="S1"/>
    <serviceTask id="Task_1" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Fetch a remote page and summarize it.</qianji:prompt>
          <qianji:tools>bash,curl</qianji:tools>
          <qianji:inputs>source url</qianji:inputs>
          <qianji:outputs>report summary</qianji:outputs>
        </qianji:config>
      </extensionElements>
    </serviceTask>
    <endEvent id="E1"/>
    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_1"/>
    <sequenceFlow id="F2" sourceRef="Task_1" targetRef="E1"/>
  </process>
</definitions>`;

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
    expect(result.errors?.[0]).toContain("PI_WENDAO_TOOL_UNSUPPORTED");
    expect(result.errors?.[0]).toContain("curl");
    expect(result.errors?.[0]).toContain("PI_WENDAO_VARIABLE_IDENTIFIER");
    expect(result.errors?.[0]).toContain("source url");
    expect(result.errors?.[0]).toContain("report summary");
    expect(result.errors?.[0]).toContain("### Related Construct Cards");
    expect(result.errors?.[0]).toContain("- service-task.agent");
    expect(result.errors?.[0]).not.toContain("LLM Fix Prompt");
  });

  it("reports task-level error boundaries as lint feedback", async () => {
    const taskBoundaryXml = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:qianji="https://qianji.dev/bpmn/extensions">
  <process id="P1" isExecutable="true">
    <startEvent id="S1"/>
    <serviceTask id="Task_Risky" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Run risky work and output success.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs></qianji:inputs>
          <qianji:outputs>success</qianji:outputs>
        </qianji:config>
      </extensionElements>
    </serviceTask>
    <boundaryEvent id="BoundaryError_Risky" attachedToRef="Task_Risky">
      <errorEventDefinition/>
    </boundaryEvent>
    <endEvent id="E1"/>
    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_Risky"/>
    <sequenceFlow id="F2" sourceRef="Task_Risky" targetRef="E1"/>
  </process>
</definitions>`;

    faux.setResponses([fauxAssistantMessage("```xml\n" + taskBoundaryXml + "\n```")]);

    const result = await compileSkill({
      skillContent: "# Skill\nRun risky work with fallback.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: {
        maxRepairAttempts: 0,
        runner: async () => ({ success: true, output: "# Lint Passed" }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain("PI_WENDAO_TASK_ERROR_BOUNDARY_UNSUPPORTED");
    expect(result.errors?.[0]).toContain("BoundaryError_Risky");
    expect(result.errors?.[0]).toContain("exclusiveGateway");
    expect(result.errors?.[0]).toContain("- gateway.exclusive.bounded");
  });

  it("reports invalid qianji user interaction contracts as lint feedback", async () => {
    const invalidInteractionXml = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:qianji="https://qianji.dev/bpmn/extensions">
  <process id="P1" isExecutable="true">
    <startEvent id="S1"/>
    <userTask id="Task_Ask">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Ask the user to choose.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs></qianji:inputs>
          <qianji:outputs>answer</qianji:outputs>
          <qianji:interaction type="choice"/>
        </qianji:config>
      </extensionElements>
    </userTask>
    <endEvent id="E1"/>
    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_Ask"/>
    <sequenceFlow id="F2" sourceRef="Task_Ask" targetRef="E1"/>
  </process>
</definitions>`;

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
    expect(result.errors?.[0]).toContain("- user-task.interaction");
  });

  it("guides invalid qianji choices wrappers without duplicate missing prompt noise", async () => {
    const invalidChoicesWrapperXml = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:qianji="https://qianji.dev/bpmn/extensions">
  <process id="P1" isExecutable="true">
    <startEvent id="S1"/>
    <userTask id="Task_Review">
      <extensionElements>
        <qianji:config>
          <qianji:tools></qianji:tools>
          <qianji:inputs>designSection</qianji:inputs>
          <qianji:outputs>sectionApproved</qianji:outputs>
          <qianji:interaction type="choice_input">
            <qianji:question ref="designSection"/>
            <qianji:choices>
              <qianji:choice value="approve">Approve</qianji:choice>
            </qianji:choices>
            <qianji:result output="sectionApproved"/>
          </qianji:interaction>
        </qianji:config>
      </extensionElements>
    </userTask>
    <endEvent id="E1"/>
    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_Review"/>
    <sequenceFlow id="F2" sourceRef="Task_Review" targetRef="E1"/>
  </process>
</definitions>`;

    faux.setResponses([fauxAssistantMessage("```xml\n" + invalidChoicesWrapperXml + "\n```")]);

    const result = await compileSkill({
      skillContent: "# Skill\nReview a section.",
      model: faux.getModel(),
      template: qianjiTemplate(),
      target: bpmnTarget(),
      lint: {
        maxRepairAttempts: 0,
        runner: async () => ({ success: true, output: "# Lint Passed" }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.errors?.[0]).toContain("PI_WENDAO_CONFIG_FIELD");
    expect(result.errors?.[0]).not.toContain("PI_WENDAO_PROMPT_EMPTY");
    expect(result.errors?.[0]).toContain("The current qianji:choices element has no ref");
    expect(result.errors?.[0]).toContain("Do not use an empty <qianji:choices> wrapper");
  });

  it("accepts dynamic choice refs for a real brainstorming multiple-choice fragment", async () => {
    const dynamicChoicesXml = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:qianji="https://qianji.dev/bpmn/extensions">
  <process id="P1" isExecutable="true">
    <startEvent id="S1"/>
    <serviceTask id="Task_PrepareQuestion" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Ask one clarifying question and prefer multiple choice when possible. Output currentQuestion and currentChoices.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs>idea</qianji:inputs>
          <qianji:outputs>currentQuestion,currentChoices</qianji:outputs>
        </qianji:config>
      </extensionElements>
    </serviceTask>
    <userTask id="Task_Answer">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Collect the user's answer to the generated brainstorming question.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs>currentQuestion,currentChoices</qianji:inputs>
          <qianji:outputs>userAnswer</qianji:outputs>
          <qianji:interaction type="choice_input">
            <qianji:question ref="currentQuestion"/>
            <qianji:choices ref="currentChoices"/>
            <qianji:result output="userAnswer"/>
          </qianji:interaction>
        </qianji:config>
      </extensionElements>
    </userTask>
    <endEvent id="E1"/>
    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_PrepareQuestion"/>
    <sequenceFlow id="F2" sourceRef="Task_PrepareQuestion" targetRef="Task_Answer"/>
    <sequenceFlow id="F3" sourceRef="Task_Answer" targetRef="E1"/>
  </process>
</definitions>`;

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
    expect(result.bpmnXml).toContain('<qianji:choices ref="currentChoices"/>');
    expect(result.bpmnXml).not.toContain("<qianji:choice ");
  });

  it("reports gateway conditions that reference undeclared variables", async () => {
    const undeclaredConditionXml = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:qianji="https://qianji.dev/bpmn/extensions">
  <process id="P1" isExecutable="true">
    <startEvent id="S1"/>
    <userTask id="Task_Approve">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Ask for approval.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs></qianji:inputs>
          <qianji:outputs>designApproved</qianji:outputs>
        </qianji:config>
      </extensionElements>
    </userTask>
    <exclusiveGateway id="Gateway_1" default="F3"/>
    <endEvent id="E1"/>
    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_Approve"/>
    <sequenceFlow id="F2" sourceRef="Task_Approve" targetRef="Gateway_1"/>
    <sequenceFlow id="F3" sourceRef="Gateway_1" targetRef="E1">
      <conditionExpression>designRejected</conditionExpression>
    </sequenceFlow>
  </process>
</definitions>`;

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
    expect(result.errors?.[0]).toContain("qianji:outputs");
    expect(result.errors?.[0]).toContain("JSON boolean 'designRejected'");
    expect(result.errors?.[0]).toContain("- gateway.exclusive.bounded");
    expect(result.errors?.[0]).toContain("- service-task.agent");
  });

  it("reports user feedback loops alongside parseable qianji semantic lint failures", async () => {
    const unreadFeedbackLoopXml = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:qianji="https://qianji.dev/bpmn/extensions">
  <process id="P1" isExecutable="true">
    <startEvent id="S1"/>
    <serviceTask id="Task_Ask" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Produce the next question and whether more clarification is needed.</qianji:prompt>
          <qianji:tools>bash</qianji:tools>
          <qianji:inputs>projectScope</qianji:inputs>
          <qianji:outputs>clarificationsNeeded,currentQuestion</qianji:outputs>
        </qianji:config>
      </extensionElements>
    </serviceTask>
    <userTask id="Task_Answer">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Answer the current question.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs>currentQuestion</qianji:inputs>
          <qianji:outputs>userAnswer</qianji:outputs>
          <qianji:interaction type="input">
            <qianji:question>currentQuestion</qianji:question>
            <qianji:result output="userAnswer"/>
          </qianji:interaction>
        </qianji:config>
      </extensionElements>
    </userTask>
    <exclusiveGateway id="Gateway_More" default="Flow_Done"/>
    <endEvent id="E1"/>
    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_Ask"/>
    <sequenceFlow id="F2" sourceRef="Task_Ask" targetRef="Task_Answer"/>
    <sequenceFlow id="F3" sourceRef="Task_Answer" targetRef="Gateway_More"/>
    <sequenceFlow id="F4" sourceRef="Gateway_More" targetRef="Task_Ask">
      <conditionExpression xsi:type="tFormalExpression">clarificationsNeeded</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="Flow_Done" sourceRef="Gateway_More" targetRef="E1"/>
  </process>
</definitions>`;

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
    expect(result.errors?.[0]).toContain("Set qianji:inputs to include: projectScope, userAnswer");
    expect(result.errors?.[0]).toContain("- user-task.interaction");
    expect(result.errors?.[0]).toContain("- gateway.exclusive.bounded");
  });

  it("reports partial user feedback loop inputs with exact missing variables", async () => {
    const partialFeedbackLoopXml = `<?xml version="1.0"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:qianji="https://qianji.dev/bpmn/extensions">
  <process id="P1" isExecutable="true">
    <startEvent id="S1"/>
    <serviceTask id="Task_Ask" implementation="\${environment.services.runAgent}">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Produce the next question using the prior answer and feedback.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs>projectScope,userAnswer</qianji:inputs>
          <qianji:outputs>needsMore,currentQuestion,currentChoices</qianji:outputs>
        </qianji:config>
      </extensionElements>
    </serviceTask>
    <userTask id="Task_Answer">
      <extensionElements>
        <qianji:config>
          <qianji:prompt>Answer the current question.</qianji:prompt>
          <qianji:tools></qianji:tools>
          <qianji:inputs>currentQuestion,currentChoices</qianji:inputs>
          <qianji:outputs>userAnswer,feedback</qianji:outputs>
          <qianji:interaction type="choice_input">
            <qianji:question ref="currentQuestion"/>
            <qianji:choices ref="currentChoices"/>
            <qianji:freeText name="feedback" optional="true"/>
            <qianji:result output="userAnswer"/>
          </qianji:interaction>
        </qianji:config>
      </extensionElements>
    </userTask>
    <exclusiveGateway id="Gateway_More" default="Flow_Done"/>
    <endEvent id="E1"/>
    <sequenceFlow id="F1" sourceRef="S1" targetRef="Task_Ask"/>
    <sequenceFlow id="F2" sourceRef="Task_Ask" targetRef="Task_Answer"/>
    <sequenceFlow id="F3" sourceRef="Task_Answer" targetRef="Gateway_More"/>
    <sequenceFlow id="F4" sourceRef="Gateway_More" targetRef="Task_Ask">
      <conditionExpression xsi:type="tFormalExpression">needsMore</conditionExpression>
    </sequenceFlow>
    <sequenceFlow id="Flow_Done" sourceRef="Gateway_More" targetRef="E1"/>
  </process>
</definitions>`;

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
    expect(result.errors?.[0]).toContain("missing user output(s) in qianji:inputs: feedback");
    expect(result.errors?.[0]).toContain("User outputs: userAnswer, feedback");
    expect(result.errors?.[0]).toContain("Current service inputs: projectScope, userAnswer");
    expect(result.errors?.[0]).toContain(
      "Set qianji:inputs to include: projectScope, userAnswer, feedback",
    );
  });
});
