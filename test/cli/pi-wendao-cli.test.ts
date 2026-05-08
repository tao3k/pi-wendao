import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const liveWendaoGraphProject = join(projectRoot, "..", "WendaoGraph.jl");
const liveRustWorkspace = join(projectRoot, "..", "..");
const liveSearchStrategyFlowEnabled =
  process.env.RUN_PI_WENDAO_SEARCH_STRATEGY_FLOW_LIVE === "1" &&
  Boolean(process.env.DEEPSEEK_API_KEY?.trim()) &&
  existsSync(join(liveWendaoGraphProject, "Project.toml"));
const rustBridgeSearchStrategyFlowSmokeEnabled =
  process.env.RUN_PI_WENDAO_SEARCH_STRATEGY_FLOW_BRIDGE_SMOKE === "1" &&
  existsSync(join(liveWendaoGraphProject, "Project.toml")) &&
  existsSync(join(liveRustWorkspace, "packages", "rust", "crates", "xiuxian-wendao-julia"));
const itLive = liveSearchStrategyFlowEnabled ? it : it.skip;
const itBridgeSmoke = rustBridgeSearchStrategyFlowSmokeEnabled ? it : it.skip;
const searchStrategySectionCandidate =
  "docs/30_search_strategy/30.01_search_strategy_flow.md#stage-1-query-understanding";
const searchStrategyWholeFileAction =
  "docs/30_search_strategy/30.01_search_strategy_flow.md action=keep";
const pageIndexSectionCandidate =
  "docs/20_page_index/20.01_reasoning_tree_contracts.md#relationship-to-search-strategy";

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

  it("runs SearchStrategyFlow from --search without requiring a workflow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-search-"));
    tempDirs.push(dir);
    const graphProject = join(dir, "WendaoGraph.jl");
    const fakeJuliaPath = join(dir, "julia");
    mkdirSync(graphProject);
    writeFileSync(
      join(graphProject, "Project.toml"),
      'name = "WendaoGraph"\nuuid = "764e742e-c622-4247-bda7-f0fdca413869"\n',
      { encoding: "utf-8", flag: "wx" },
    );
    writeFakeJuliaSearch(fakeJuliaPath);
    chmodSync(fakeJuliaPath, 0o755);

    const result = await runPiWendaoCli(
      [
        "--search",
        "find SearchStrategyFlow owner and validation",
        "--wendao-graph",
        graphProject,
        "--search-root",
        graphProject,
        "--search-julia",
        fakeJuliaPath,
        "--search-backend",
        "julia-direct",
        "--no-graph",
      ],
      dir,
    );
    const output = [result.stdout, result.stderr].join("\n");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("SearchStrategyFlow trace");
    expect(output).toContain("intent: find SearchStrategyFlow owner and validation");
    expect(output).toContain("backend: wendao-graph-julia");
    expect(output).toContain("rust_bridge:");
    expect(output).toContain("requested: julia-direct");
    expect(output).toContain("graph_query_understanding:");
    expect(output).toContain("kind=route_hint");
    expect(output).toContain("strategy_budget:");
    expect(output).toContain("source: query_understanding");
    expect(output).toContain("strategy_flow_stages:");
    expect(output).toContain("stage1 query_understanding");
    expect(output).toContain("stage2 candidate_scoring");
    expect(output).toContain("stage3 transition_inference");
    expect(output).toContain("stage4 frontier_selection");
    expect(output).toContain("stage5 planner_actions");
    expect(output).toContain("no_vector_mode: yes");
    expect(output).toContain("materialized_top_candidate: yes");
    expect(output).toContain(`${searchStrategySectionCandidate} action=keep`);
    expect(output).not.toContain(searchStrategyWholeFileAction);
    expect(output).toContain("planner:");
    expect(output).toContain("retrieval_routes:");
    expect(output).toContain(
      `candidate=${searchStrategySectionCandidate} owner=studio-rust`,
    );
    expect(output).toContain("direct_file_read=no");
    expect(output).toContain(
      "/api/docs/retrieval-hit?repo=<repo>&page_id=docs%2F30_search_strategy%2F30.01_search_strategy_flow.md&node_id=stage-1-query-understanding",
    );
    expect(output).toContain("flight=/search/intent|/search/knowledge|repo_search");
    expect(output).toContain("llm_interactions:");
    expect(output).toContain("planned action=compare");
    expect(output).toContain("subagent_interactions:");
    expect(output).toContain("planned type=pi-wendao-output-only");
  }, 20_000);

  it("prefers the Rust SearchStrategyFlow bridge when a workspace is available", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-search-rust-"));
    tempDirs.push(dir);
    const graphProject = join(dir, "WendaoGraph.jl");
    const rustWorkspace = join(dir, "xiuxian-artisan-workshop");
    const fakeCargoPath = join(dir, "cargo");
    writeSearchProjectFixture(graphProject, rustWorkspace);
    writeFakeCargoSearch(fakeCargoPath);
    chmodSync(fakeCargoPath, 0o755);

    const result = await runPiWendaoCli(
      [
        "--search",
        "find SearchStrategyFlow owner through Rust",
        "--wendao-graph",
        graphProject,
        "--search-root",
        graphProject,
        "--search-rust-workspace",
        rustWorkspace,
        "--search-rust-command",
        fakeCargoPath,
        "--no-graph",
      ],
      dir,
    );
    const output = [result.stdout, result.stderr].join("\n");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("backend: rust-wendao-julia");
    expect(output).toContain("control_plane: rust");
    expect(output).toContain("requested: auto");
    expect(output).toContain("fallback: none");
    expect(output).toContain("strategy_flow_stages:");
    expect(output).toContain("no_vector_mode: yes");
    expect(output).toContain(`${searchStrategySectionCandidate} action=keep`);
    expect(output).not.toContain(searchStrategyWholeFileAction);
    expect(output).toContain("retrieval_routes:");
    expect(output).toContain(
      `candidate=${searchStrategySectionCandidate} owner=studio-rust`,
    );
    expect(output).toContain("direct_file_read=no");
  }, 20_000);

  it("fails auto mode when the Rust SearchStrategyFlow bridge is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-search-rust-failure-"));
    tempDirs.push(dir);
    const graphProject = join(dir, "WendaoGraph.jl");
    const rustWorkspace = join(dir, "xiuxian-artisan-workshop");
    const fakeCargoPath = join(dir, "cargo");
    writeSearchProjectFixture(graphProject, rustWorkspace);
    writeFailingCargoSearch(fakeCargoPath);
    chmodSync(fakeCargoPath, 0o755);

    const result = await runPiWendaoCli(
      [
        "--search",
        "find SearchStrategyFlow owner through Rust",
        "--wendao-graph",
        graphProject,
        "--search-root",
        graphProject,
        "--search-rust-workspace",
        rustWorkspace,
        "--search-rust-command",
        fakeCargoPath,
        "--no-graph",
      ],
      dir,
    );
    const output = [result.stdout, result.stderr].join("\n");

    expect(result.exitCode).toBe(1);
    expect(output).toContain("Error: error: no example target named");
    expect(output).toContain("Rust bridge as the core path");
    expect(output).toContain("--search-backend julia-direct only for pi-local bridge smoke tests");
  }, 20_000);

  itLive("runs live SearchStrategyFlow DeepSeek understanding without first-layer tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-search-live-"));
    tempDirs.push(dir);

    const result = await runPiWendaoCli(
      [
        "--search",
        "find the SearchStrategyFlow ownership boundary and validation path",
        "--wendao-graph",
        liveWendaoGraphProject,
        "--search-root",
        liveWendaoGraphProject,
        "--search-backend",
        "julia-direct",
        "--search-agent",
        "--no-graph",
      ],
      projectRoot,
      {
        env: {
          PI_WENDAO_SUBAGENTS_RUN_STORE: join(dir, "pi-subagents-run-store.json"),
        },
        timeoutMs: 180_000,
      },
    );
    const output = [result.stdout, result.stderr].join("\n");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("SearchStrategyFlow trace");
    expect(output).toContain("backend: wendao-graph-julia");
    expect(output).toContain("requested: julia-direct");
    expect(output).toContain("live status=completed model=anthropic/deepseek-v4-pro");
    expect(output).toContain("live intent_understanding=");
    expect(output).toContain("live branch_decision=");
    expect(output).toContain("live judgement=");
    expect(output).toContain(
      "planned type=pi-wendao-output-only activity=SearchStrategyFlow_QueryUnderstanding",
    );
    expect(output).toContain(`${searchStrategySectionCandidate} action=keep`);
    expect(output).not.toContain(searchStrategyWholeFileAction);
    expect(output).toContain("Tool uses: 0");
    expect(output).not.toContain("tool=read");
    expect(output).not.toContain("tool_call");
  }, 190_000);

  itBridgeSmoke("runs Rust bridge SearchStrategyFlow smoke", async () => {
    const result = await runPiWendaoCli(
      [
        "--search",
        "find the SearchStrategyFlow ownership boundary and validation path",
        "--wendao-graph",
        liveWendaoGraphProject,
        "--search-root",
        liveWendaoGraphProject,
        "--search-rust-workspace",
        liveRustWorkspace,
        "--no-graph",
      ],
      projectRoot,
      { timeoutMs: 180_000 },
    );
    const output = [result.stdout, result.stderr].join("\n");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("SearchStrategyFlow trace");
    expect(output).toContain("backend: rust-wendao-julia");
    expect(output).toContain("fallback: none");
    expect(output).toContain("graph_query_understanding:");
    expect(output).toContain("strategy_flow_stages:");
    expect(output).toContain("stage1 query_understanding");
    expect(output).toContain(`${searchStrategySectionCandidate} action=keep`);
    expect(output).not.toContain(searchStrategyWholeFileAction);
  }, 190_000);
});

function runPiWendaoCli(
  args: string[],
  cwd: string,
  options: {
    env?: Record<string, string>;
    timeoutMs?: number;
  } = {},
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
        ...options.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("pi-wendao CLI test timed out"));
    }, options.timeoutMs ?? 15_000);
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

function writeSearchProjectFixture(graphProject: string, rustWorkspace: string): void {
  mkdirSync(graphProject);
  mkdirSync(join(rustWorkspace, "packages", "rust", "crates", "xiuxian-wendao-julia"), {
    recursive: true,
  });
  writeFileSync(
    join(graphProject, "Project.toml"),
    'name = "WendaoGraph"\nuuid = "764e742e-c622-4247-bda7-f0fdca413869"\n',
    { encoding: "utf-8", flag: "wx" },
  );
  writeFileSync(join(rustWorkspace, "Cargo.toml"), "[workspace]\n", "utf-8");
  writeFileSync(
    join(rustWorkspace, "packages", "rust", "crates", "xiuxian-wendao-julia", "Cargo.toml"),
    '[package]\nname = "xiuxian-wendao-julia"\n',
    "utf-8",
  );
}

function writeFakeJuliaSearch(path: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env node
console.log(JSON.stringify({
  intent: process.argv[process.argv.length - 2],
  backend: "wendao-graph-julia",
  graphProject: "fake/WendaoGraph.jl",
  searchRoot: process.argv[process.argv.length - 1],
  candidates: [
    {
      candidateId: "${searchStrategySectionCandidate}",
      action: "keep",
      reason: "graph_verified_candidate",
      finalScore: 0.91,
      evidenceCoverage: 0.98,
      graphScore: 0.95,
      authorityScore: 0.93,
      semanticScore: 0,
      structuralScore: 0.9,
      contextCost: 1000,
      blocked: false
    }
  ],
  frontier: [
    {
      candidateId: "${searchStrategySectionCandidate}",
      rank: 1,
      selected: true,
      finalScore: 0.91,
      action: "keep",
      contextBudget: 1000,
      judgementKind: "graph_verified_candidate"
    }
  ],
  plannerActions: [
    {
      actionKind: "materialize",
      candidateId: "${searchStrategySectionCandidate}",
      targetCandidateId: "",
      cycleAllowed: false,
      requiresLlmJudgement: false,
      score: 0.91,
      reason: "graph_materialize_candidate"
    },
    {
      actionKind: "compare",
      candidateId: "${searchStrategySectionCandidate}",
      targetCandidateId: "${pageIndexSectionCandidate}",
      cycleAllowed: false,
      requiresLlmJudgement: true,
      score: 0.84,
      reason: "llm_verify_adjacent_branch"
    }
  ],
  queryUnderstanding: [
    {
      flowId: "pi-wendao-search-strategy-flow",
      intentId: "cli-intent-1",
      signalId: "cli-intent-1-signal-1",
      signalKind: "route_hint",
      signalValue: "search_strategy",
      confidence: 0.92,
      routeHint: "search_strategy",
      requiredEvidence: "",
      ambiguity: 0.42,
      weight: 0.9,
      recommendedLoopBudget: 1,
      recommendedJudgementBudget: 1,
      recommendedBeamWidth: 3,
      reason: "route inferred from graph-owned query anchors"
    }
  ],
  strategyBudget: {
    source: "query_understanding",
    loopBudget: 1,
    judgementBudget: 1,
    beamWidth: 3
  },
  summary: {
    candidateCount: 1,
    selectedCount: 1,
    plannerActionCount: 2,
    totalContextCost: 1800,
    selectedContextCost: 1000,
    contextReductionRatio: 0.444
  },
  validation: {
    noVectorMode: true,
    materializedTopCandidate: true,
    blockedEvidencePruned: true,
    selectedContextReduced: true
  }
}));
`,
    "utf-8",
  );
}

function writeFakeCargoSearch(path: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env node
console.log(JSON.stringify({
  intent: process.argv[process.argv.indexOf("--intent") + 1],
  backend: "rust-wendao-julia",
  controlPlane: "rust",
  juliaProject: process.env.WENDAOGRAPH_PACKAGE_DIR,
  graphProject: process.env.WENDAOGRAPH_PACKAGE_DIR,
  searchRoot: process.argv[process.argv.indexOf("--search-root") + 1],
  candidates: [
    {
      candidateId: "${searchStrategySectionCandidate}",
      action: "keep",
      reason: "graph_verified_candidate",
      finalScore: 0.91,
      evidenceCoverage: 0.98,
      graphScore: 0.95,
      authorityScore: 0.93,
      semanticScore: 0,
      structuralScore: 0.9,
      contextCost: 1000,
      blocked: false
    }
  ],
  frontier: [
    {
      candidateId: "${searchStrategySectionCandidate}",
      rank: 1,
      selected: true,
      finalScore: 0.91,
      action: "keep",
      contextBudget: 1000,
      judgementKind: "graph_verified_candidate"
    }
  ],
  plannerActions: [
    {
      actionKind: "materialize",
      candidateId: "${searchStrategySectionCandidate}",
      targetCandidateId: "",
      cycleAllowed: false,
      requiresLlmJudgement: false,
      score: 0.91,
      reason: "graph_materialize_candidate"
    }
  ],
  queryUnderstanding: [
    {
      flowId: "pi-wendao-search-strategy-flow",
      intentId: "cli-intent-1",
      signalId: "cli-intent-1-signal-1",
      signalKind: "route_hint",
      signalValue: "search_strategy",
      confidence: 0.92,
      routeHint: "search_strategy",
      requiredEvidence: "",
      ambiguity: 0.42,
      weight: 0.9,
      recommendedLoopBudget: 1,
      recommendedJudgementBudget: 1,
      recommendedBeamWidth: 3,
      reason: "route inferred from graph-owned query anchors"
    }
  ],
  strategyBudget: {
    source: "query_understanding",
    loopBudget: 1,
    judgementBudget: 1,
    beamWidth: 3
  },
  summary: {
    candidateCount: 1,
    selectedCount: 1,
    plannerActionCount: 1,
    totalContextCost: 1800,
    selectedContextCost: 1000,
    contextReductionRatio: 0.444
  },
  validation: {
    noVectorMode: true,
    materializedTopCandidate: true,
    blockedEvidencePruned: true,
    selectedContextReduced: true
  }
}));
`,
    "utf-8",
  );
}

function writeFailingCargoSearch(path: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env node
console.error("error: no example target named \\u0060wendaograph_search_strategy_flow\\u0060 in \\u0060xiuxian-wendao-julia\\u0060 package");
process.exit(101);
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
