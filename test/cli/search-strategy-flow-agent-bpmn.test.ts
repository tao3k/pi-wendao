import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSearchStrategyFlowAgentBpmnTask } from "../../src/cli/search/strategy-flow-agent-bpmn.js";
import type { SearchStrategyFlowTrace } from "../../src/cli/search/strategy-flow-types.js";
import type { PiWendaoAgentRequest } from "../../src/executor/agent-host.js";

const tempDirs: string[] = [];

describe("SearchStrategyFlow BPMN agent task", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("executes judgement through qianji BPMN host work instead of direct prompt fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-search-agent-bpmn-"));
    tempDirs.push(dir);
    const qianjiCommand = makeFakeSearchAgentQianjiCommand();
    let agentRequest: PiWendaoAgentRequest | undefined;
    const agentOutput = {
      intent_understanding: "Find the configured Markdown authority evidence.",
      branch_decision: "Keep the selected authority branch.",
      judgement: "The selected frontier is sufficient.",
      branch_judgements: [
        {
          candidate_id: "docs/a.md#owner",
          branch_role: "authority",
          judgement_score: 0.9,
          confidence: 0.8,
          decision: "keep",
          blocked: false,
          reason: "Selected authority evidence.",
        },
      ],
    };

    const result = await runSearchStrategyFlowAgentBpmnTask({
      trace: minimalTrace(),
      cwd: dir,
      activityId: "SearchStrategyFlow_QueryUnderstanding",
      prompt: "Return declared BPMN outputs.",
      compactTrace: { frontier_branches: [] },
      model: {
        provider: "anthropic",
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
      } as never,
      agentHost: {
        async run(request) {
          agentRequest = request;
          expect(String(request.variables.workflow_state_path)).toContain(
            "qianji-workflow-state.duckdb",
          );
          expect(String(request.variables.qianji_config_path)).toContain("qianji.toml");
          expect(request.activityId).toBe("SearchStrategyFlow_QueryUnderstanding");
          expect(request.config.prompt).toContain("Return declared BPMN outputs.");
          expect(request.config.inputs).toEqual(["intent", "trace"]);
          expect(request.config.outputs).toEqual([
            "intent_understanding",
            "branch_decision",
            "judgement",
            "branch_judgements",
          ]);
          expect(String(request.variables.intent)).toBe("Find the Markdown evidence.");
          return agentOutput;
        },
      },
      qianjiCommand,
    });

    expect(result.output).toMatchObject({
      intent_understanding: "Find the configured Markdown authority evidence.",
      branch_decision: "Keep the selected authority branch.",
      judgement: "The selected frontier is sufficient.",
    });
    expect(agentRequest).toBeDefined();
    expect(result.events).toEqual([
      {
        kind: "result",
        activityId: "SearchStrategyFlow_QueryUnderstanding",
        description: "Run Qianji service task SearchStrategyFlow_QueryUnderstanding",
        resultText: "Qianji local CLI service agent completed. Tool uses: 0",
      },
    ]);
  });

  it("interrupts qianji BPMN host work through the live agent signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-search-agent-bpmn-"));
    tempDirs.push(dir);
    const qianjiCommand = makeFakeSearchAgentQianjiCommand();
    const controller = new AbortController();
    const run = runSearchStrategyFlowAgentBpmnTask({
      trace: minimalTrace(),
      cwd: dir,
      activityId: "SearchStrategyFlow_QueryUnderstanding",
      prompt: "Wait for abort.",
      compactTrace: { frontier_branches: [] },
      model: {
        provider: "anthropic",
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
      } as never,
      agentHost: {
        async run(request) {
          return new Promise<Record<string, unknown>>((_, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => reject(new Error("search agent aborted by test")),
              { once: true },
            );
          });
        },
      },
      qianjiCommand,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 10);

    await expect(run).rejects.toThrow("Workflow interrupted; checkpoint preserved.");
  });
});

function makeFakeSearchAgentQianjiCommand(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wendao-fake-qianji-search-agent-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "fake-qianji-search-agent.cjs");
  writeFakeSearchAgentQianjiScript(scriptPath);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function writeFakeSearchAgentQianjiScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `
const args = process.argv.slice(2);
const get = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const printSessionResult = (outcome, variables, pendingHostWork) => {
  console.log("@@QIANJI_SESSION_RESULT " + JSON.stringify({
    exitCode: 0,
    stdout: "qianji host-session: " + outcome + " (checkpoint=duckdb, source=resumed, saved=yes, deleted=no, pending_host=" + pendingHostWork + ")",
    stderr: "",
    outcome,
    checkpoint: {
      backend: "duckdb",
      source: "resumed",
      saved: "yes",
      deleted: "no",
      status: "saved"
    },
    pendingHostWork,
    variables
  }));
};
if (args[0] !== "bpmn" || args[1] !== "host-session") {
  console.error("unexpected qianji command: " + args.join(" "));
  process.exit(64);
}
const context = JSON.parse(get("--context-json") || "{}");
console.log("@@QIANJI_HOST_WORK " + JSON.stringify({
  kind: "service",
  node_id: "SearchStrategyFlow_QueryUnderstanding",
  node_index: 0,
  token_id: 1,
  variables: {
    intent: context.intent,
    trace: context.trace,
    workflow_state_path: process.env.QIANJI_WORKFLOW_STATE_DUCKDB_PATH,
    qianji_config_path: process.env.QIANJI_CONFIG_PATH
  }
}));
printSessionResult("blocked_on_host", { intent: context.intent }, 1);
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "stop") {
    process.exit(0);
  }
  if (request.type !== "task_complete") {
    printSessionResult("failed", { error: "unexpected request" }, 0);
    return;
  }
  printSessionResult("completed", request.data || {}, 0);
});
`,
    "utf-8",
  );
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function minimalTrace(): SearchStrategyFlowTrace {
  return {
    intent: "Find the Markdown evidence.",
    backend: "rust-wendao-julia",
    graphProject: "/tmp/WendaoGraph.jl",
    juliaProject: "/tmp/WendaoGraph.jl",
    searchRoot: "/tmp/repo",
    queryUnderstanding: [],
    candidates: [],
    frontier: [
      {
        candidateId: "docs/a.md#owner",
        rank: 1,
        selected: true,
        finalScore: 0.9,
        action: "keep",
        contextBudget: 8,
        judgementKind: "graph_verified_candidate",
      },
    ],
    plannerActions: [],
    stageReceipts: [],
    summary: {
      candidateCount: 0,
      plannerActionCount: 0,
      selectedCount: 0,
      selectedContextCost: 0,
      totalContextCost: 0,
      contextReductionRatio: 0,
    },
    validation: {
      requiredEvidenceCovered: true,
      selectedRequiredEvidence: [],
      missingRequiredEvidence: [],
      selectedContextReduced: true,
      materializedTopCandidate: false,
      blockedEvidencePruned: false,
      noVectorMode: true,
    },
  } as SearchStrategyFlowTrace;
}
