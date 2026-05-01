import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeDefinitions,
  nativeHumanTask,
  nativeServiceTask,
} from "../support/native-bpmn.js";

const projectRoot = process.cwd();
const tempDirs: string[] = [];

describe("pi-wendao CLI", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports service-produced dynamic choice schema failures through --no-graph", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-no-graph-"));
    tempDirs.push(dir);
    const workflowPath = join(dir, "workflow.bpmn");
    const hostFixturePath = join(dir, "host-fixture.json");
    const qianjiPath = join(dir, "qianji");
    writeFileSync(workflowPath, serviceGeneratedDynamicChoicesWorkflow(), "utf-8");
    writeFileSync(hostFixturePath, invalidDynamicChoicesHostFixture(), "utf-8");
    writeFakeQianji(qianjiPath);
    chmodSync(qianjiPath, 0o755);

    const result = await runPiWendaoCli(
      [workflowPath, "--qianji", qianjiPath, "--host-fixture", hostFixturePath, "--no-graph"],
      dir,
    );
    const output = [result.stdout, result.stderr].join("\n");

    expect(result.exitCode).toBe(1);
    expect(output).toContain("[pi-wendao.runtime.invalid_dynamic_choices]");
    expect(output).toContain("Consumer activity: Task_AskQuestion");
    expect(output).toContain("Variable: currentChoices");
    expect(output).toContain("Problem: ref did not resolve to a JSON array");
    expect(output).toContain('Bad payload: {"kind":"choice_array","value"');
    expect(output).toContain("Expected value:");
    expect(output).not.toContain("human task Task_AskQuestion");
  }, 20_000);
});

function runPiWendaoCli(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const jitiBin = join(
    projectRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "jiti.cmd" : "jiti",
  );
  const cliPath = join(projectRoot, "src", "cli", "pi-wendao.ts");
  return new Promise((resolve, reject) => {
    const child = spawn(jitiBin, [cliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("pi-wendao CLI test timed out"));
    }, 15_000);
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function writeFakeQianji(path: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const fence = String.fromCharCode(96, 96, 96);
if (args[0] === "lint") {
  console.log("[ok] lint passed");
  process.exit(0);
}
if (args[0] === "bpmn" && args[1] === "run") {
  console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
    kind: "service",
    node_id: "Task_PrepareQuestion",
    node_index: 1,
    token_id: 61,
    variables: {},
  }));
  console.log("# BPMN Run\\n\\nOutcome: blocked_on_host\\nCheckpoint backend: duckdb\\nCheckpoint source: fresh\\nCheckpoint saved: yes\\nCheckpoint status: saved\\nPending host work: 1\\n\\n## Variables\\n" + fence + "json\\n{}\\n" + fence + "\\n");
  process.exit(0);
}
if (args[0] === "bpmn" && args[1] === "host-session") {
  const { createInterface } = require("node:readline");
  const hostWork = (work) => console.log("@@QIANJI_HOST_WORK " + JSON.stringify(work));
  const result = (outcome, variables, pendingHostWork) => {
    console.log("@@QIANJI_SESSION_RESULT " + JSON.stringify({
      exitCode: 0,
      stdout: "qianji host-session: " + outcome,
      stderr: "",
      outcome,
      checkpoint: { backend: "duckdb", source: "fresh", saved: "yes", deleted: "no", status: "saved" },
      pendingHostWork,
      variables
    }));
  };
  hostWork({
    kind: "service",
    node_id: "Task_PrepareQuestion",
    node_index: 1,
    token_id: 61,
    variables: {},
  });
  result("blocked_on_host", {}, 1);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const request = JSON.parse(line);
    const variables = { ...request.data };
    hostWork({
      kind: "user",
      node_id: "Task_AskQuestion",
      node_index: 2,
      token_id: 62,
      variables,
      form: {
        interaction_type: "choice_input",
        question_ref: "currentQuestion",
        choices_ref: "currentChoices",
        result_output: "userAnswer",
      },
    });
    result("blocked_on_host", variables, 1);
  });
  return;
}
console.error("unexpected qianji command: " + args.join(" "));
process.exit(64);
`,
    "utf-8",
  );
}

function invalidDynamicChoicesHostFixture(): string {
  return `${JSON.stringify(
    {
      service_tasks: {
        Task_PrepareQuestion: {
          data: {
            currentQuestion: "Which BPMN interaction test should run next?",
            currentChoices: {
              kind: "choice_array",
              value: [
                {
                  value: "test_fixtures",
                  label: "BPMN fixture-based integration tests",
                },
              ],
            },
          },
        },
      },
    },
    null,
    2,
  )}\n`;
}

function serviceGeneratedDynamicChoicesWorkflow(): string {
  return nativeDefinitions(
    "Process_1",
    [
      '    <startEvent id="Start_1"/>',
      nativeServiceTask({
        id: "Task_PrepareQuestion",
        name: "Prepare generated question",
        documentation: "Output currentQuestion and currentChoices.",
        inputs: ["context"],
        outputs: ["currentQuestion", "currentChoices"],
      }),
      nativeHumanTask({
        id: "Task_AskQuestion",
        name: "Answer generated question",
        documentation: "Answer the generated question.",
        inputs: ["currentQuestion", "currentChoices"],
        resultOutput: "userAnswer",
        interactionType: "choice_input",
        questionRef: "currentQuestion",
        choicesRef: "currentChoices",
      }),
      '    <endEvent id="End_1"/>',
      '    <sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_PrepareQuestion"/>',
      '    <sequenceFlow id="Flow_2" sourceRef="Task_PrepareQuestion" targetRef="Task_AskQuestion"/>',
      '    <sequenceFlow id="Flow_3" sourceRef="Task_AskQuestion" targetRef="End_1"/>',
    ].join("\n"),
  );
}
