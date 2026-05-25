import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nativeDefinitions,
  nativeHumanTask,
  nativeServiceTask,
} from "../support/native-bpmn.js";
import { WENDAO_ARROW_FLIGHT_DATA_PLANE } from "../../src/arrow/boundary.js";

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
const rustSearchStrategyAuthorityCandidate =
  "packages/rust/crates/xiuxian-wendao/docs/03_features/210_search_queries_architecture.md#local-corpus-lane-ownership";
const rustSearchStrategyValidationCandidate =
  "packages/rust/crates/xiuxian-qianji/docs/rfcs/2026-04-08-compact-validation-flowchart-alignment-rfc.md#rfc-0004-compact-validation-and-flowchart-alignment";
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
    expect(output).toContain("frontier_branches:");
    expect(output).toContain("role=search_strategy");
    expect(output).toContain("purpose=Normalize intent, strategy loop, and first-layer branch policy.");
    expect(output).toContain("derived_hints{");
    expect(output).toContain("missing_decoded_evidence_anchors");
    expect(output).toContain("probes=compare_provenance:");
    expect(output).toContain("open_adjacent_sections:");
    expect(output).toContain("retrieval_routes:");
    expect(output).toContain(
      `candidate=${searchStrategySectionCandidate} owner=studio-rust materialization=planned`,
    );
    expect(output).toContain("receipt_source=local-plan");
    expect(output).toContain(`primary=${WENDAO_ARROW_FLIGHT_DATA_PLANE}`);
    expect(output).toContain("direct_file_read=no");
    expect(output).toContain("execute_before_answer=yes");
    expect(output).toContain(
      "flight_steps=flight_search_page:/search/repos/main",
    );
    expect(output).toContain(
      "flight_resolve_page_index_tree:/analysis/repo-projected-page-index-tree",
    );
    expect(output).toContain(
      "flight_open_retrieval_context:/analysis/repo-projected-retrieval-context",
    );
    expect(output).toContain("flight_expand_graph_context:/graph/neighbors");
    expect(output).not.toContain("http_fallback_steps=");
    expect(output).not.toContain("/api/docs/retrieval");
    expect(output).not.toContain("/api/repo/projected-page-index-tree-search");
    expect(output).not.toContain("node_id=stage-1-query-understanding");
    expect(output).toContain("llm_interactions:");
    expect(output).toContain("planned action=compare");
    expect(output).toContain("qianji_service_agent_interactions:");
    expect(output).toContain("planned runtime=qianji-local-cli");
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
    expect(output).toContain("candidate_input_source: rust-markdown-headings");
    expect(output).toContain("candidate_input_count: 1");
    expect(output).toContain("requested: auto");
    expect(output).toContain("fallback: none");
    expect(output).toContain("strategy_flow_stages:");
    expect(output).toContain("no_vector_mode: yes");
    expect(output).toContain(`${searchStrategySectionCandidate} action=keep`);
    expect(output).not.toContain(searchStrategyWholeFileAction);
    expect(output).toContain("frontier_branches:");
    expect(output).toContain("role=search_strategy");
    expect(output).toContain("derived_hints{");
    expect(output).toContain("missing_decoded_evidence_anchors");
    expect(output).toContain("probes=open_adjacent_sections:");
    expect(output).toContain("retrieval_routes:");
    expect(output).toContain(
      `candidate=${searchStrategySectionCandidate} owner=studio-rust materialization=planned`,
    );
    expect(output).toContain("receipt_source=rust-bridge");
    expect(output).not.toContain("rows=8");
    expect(output).not.toContain("/analysis/repo-projected-retrieval-context:1");
    expect(output).toContain("direct_file_read=no");
    expect(output).toContain("execute_before_answer=yes");
  }, 20_000);

  it("runs a prebuilt Rust SearchStrategyFlow bridge binary without cargo arguments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-search-rust-bin-"));
    tempDirs.push(dir);
    const graphProject = join(dir, "WendaoGraph.jl");
    const rustWorkspace = join(dir, "xiuxian-artisan-workshop");
    const fakeBridgePath = join(dir, "wendaograph_search_strategy_flow");
    const argsPath = join(dir, "bridge-args.json");
    writeSearchProjectFixture(graphProject, rustWorkspace);
    writeFakeCargoSearch(fakeBridgePath, argsPath);
    chmodSync(fakeBridgePath, 0o755);

    const result = await runPiWendaoCli(
      [
        "--search",
        "find SearchStrategyFlow owner through direct Rust bridge",
        "--wendao-graph",
        graphProject,
        "--search-rust-workspace",
        rustWorkspace,
        "--search-rust-bridge-bin",
        fakeBridgePath,
        "--no-graph",
      ],
      dir,
    );
    const output = [result.stdout, result.stderr].join("\n");
    const bridgeArgs = JSON.parse(readFileSync(argsPath, "utf-8")) as string[];

    expect(result.exitCode).toBe(0);
    expect(output).toContain("backend: rust-wendao-julia");
    expect(output).toContain("mode: direct-binary");
    expect(output).toContain("fallback: none");
    expect(bridgeArgs).toEqual([
      "--intent",
      "find SearchStrategyFlow owner through direct Rust bridge",
    ]);
    expect(bridgeArgs).not.toContain("run");
    expect(bridgeArgs).not.toContain("--bin");
    expect(bridgeArgs).not.toContain("wendaograph_search_strategy_flow");
  }, 20_000);

  it("runs the Rust SearchStrategyFlow bridge through the stdio session protocol", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-search-rust-session-"));
    tempDirs.push(dir);
    const graphProject = join(dir, "WendaoGraph.jl");
    const rustWorkspace = join(dir, "xiuxian-artisan-workshop");
    const fakeBridgePath = join(dir, "wendaograph_search_strategy_flow");
    const argsPath = join(dir, "bridge-args.json");
    writeSearchProjectFixture(graphProject, rustWorkspace);
    writeFakeCargoSearch(fakeBridgePath, argsPath);
    chmodSync(fakeBridgePath, 0o755);

    const result = await runPiWendaoCli(
      [
        "--search",
        "find SearchStrategyFlow owner through Rust bridge session",
        "--wendao-graph",
        graphProject,
        "--search-rust-workspace",
        rustWorkspace,
        "--search-rust-bridge-bin",
        fakeBridgePath,
        "--search-rust-bridge-session",
        "--search-flight-base-url",
        "http://127.0.0.1:50051",
        "--no-graph",
      ],
      dir,
    );
    const output = [result.stdout, result.stderr].join("\n");
    const bridgeArgs = JSON.parse(readFileSync(argsPath, "utf-8")) as string[];

    expect(result.exitCode).toBe(0);
    expect(output).toContain("backend: rust-wendao-julia");
    expect(output).toContain("mode: persistent-stdio");
    expect(output).toContain("fallback: none");
    expect(output).toContain("materialization=executed rows=4");
    expect(bridgeArgs).toEqual([
      "--flight-base-url",
      "http://127.0.0.1:50051",
      "--serve-stdio",
    ]);
  }, 20_000);

  it("runs the Rust SearchStrategyFlow bridge session without Flight config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-search-rust-session-no-flight-"));
    tempDirs.push(dir);
    const graphProject = join(dir, "WendaoGraph.jl");
    const rustWorkspace = join(dir, "xiuxian-artisan-workshop");
    const fakeBridgePath = join(dir, "wendaograph_search_strategy_flow");
    writeSearchProjectFixture(graphProject, rustWorkspace);
    writeFakeCargoSearch(fakeBridgePath);
    chmodSync(fakeBridgePath, 0o755);

    const result = await runPiWendaoCli(
      [
        "--search",
        "find SearchStrategyFlow owner through Rust bridge session",
        "--wendao-graph",
        graphProject,
        "--search-rust-workspace",
        rustWorkspace,
        "--search-rust-bridge-bin",
        fakeBridgePath,
        "--search-rust-bridge-session",
        "--no-graph",
      ],
      dir,
    );
    const output = [result.stdout, result.stderr].join("\n");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("backend: rust-wendao-julia");
    expect(output).toContain("mode: persistent-stdio");
    expect(output).toContain("fallback: none");
    expect(output).toContain("materialization=planned");
  }, 20_000);

  it("requires --search-agent before writing SearchStrategyFlow answer evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-search-agent-evidence-"));
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
        "--search-julia",
        fakeJuliaPath,
        "--search-backend",
        "julia-direct",
        "--search-agent-answer-evidence",
        join(dir, "answer-evidence.tsv"),
        "--no-graph",
      ],
      dir,
    );
    const output = [result.stdout, result.stderr].join("\n");

    expect(result.exitCode).toBe(1);
    expect(output).toContain("--search-agent-answer-evidence requires --search-agent");
  }, 20_000);

  it("writes materialized SearchStrategyFlow answer evidence from a request TSV", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-answer-request-"));
    tempDirs.push(dir);
    const requestPath = join(dir, "answer-request.tsv");
    const evidencePath = join(dir, "answer-evidence.tsv");
    writeFileSync(requestPath, materializedAnswerRequestTsv(), "utf-8");

    const result = await runPiWendaoCli(
      [
        "--search-agent-answer-request",
        requestPath,
        "--search-agent-answer-evidence",
        evidencePath,
        "--no-graph",
      ],
      dir,
    );
    const output = [result.stdout, result.stderr].join("\n");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("SearchStrategyFlow materialized answer evidence: wrote 1 row(s)");
    expect(readFileSync(evidencePath, "utf-8")).toContain(
      "repos/Pkg.jl/README.md#auto-readme-package-purpose\trepo=Pkg.jl; source=README.md",
    );
  }, 20_000);

  it("requires answer evidence output when materialized answer request is provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-answer-request-missing-output-"));
    tempDirs.push(dir);
    const requestPath = join(dir, "answer-request.tsv");
    writeFileSync(requestPath, materializedAnswerRequestTsv(), "utf-8");

    const result = await runPiWendaoCli(
      ["--search-agent-answer-request", requestPath, "--no-graph"],
      dir,
    );
    const output = [result.stdout, result.stderr].join("\n");

    expect(result.exitCode).toBe(1);
    expect(output).toContain("--search-agent-answer-request requires --search-agent-answer-evidence");
  }, 20_000);

  it("requires --search-agent for live materialized answer request mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-live-answer-request-missing-agent-"));
    tempDirs.push(dir);
    const requestPath = join(dir, "answer-request.tsv");
    const evidencePath = join(dir, "answer-evidence.tsv");
    writeFileSync(requestPath, materializedAnswerRequestTsv(), "utf-8");

    const result = await runPiWendaoCli(
      [
        "--search-agent-answer-request",
        requestPath,
        "--search-agent-answer-mode",
        "live",
        "--search-agent-answer-evidence",
        evidencePath,
        "--no-graph",
      ],
      dir,
    );
    const output = [result.stdout, result.stderr].join("\n");

    expect(result.exitCode).toBe(1);
    expect(output).toContain("--search-agent-answer-mode live requires --search-agent");
  }, 20_000);

  it("rejects invalid materialized answer request modes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-answer-request-invalid-mode-"));
    tempDirs.push(dir);
    const requestPath = join(dir, "answer-request.tsv");
    const evidencePath = join(dir, "answer-evidence.tsv");
    writeFileSync(requestPath, materializedAnswerRequestTsv(), "utf-8");

    const result = await runPiWendaoCli(
      [
        "--search-agent-answer-request",
        requestPath,
        "--search-agent-answer-mode",
        "maybe",
        "--search-agent-answer-evidence",
        evidencePath,
        "--no-graph",
      ],
      dir,
    );
    const output = [result.stdout, result.stderr].join("\n");

    expect(result.exitCode).toBe(1);
    expect(output).toContain("--search-agent-answer-mode must be deterministic or live");
  }, 20_000);

  it("resumes a completed live materialized answer evidence prefix without model auth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-live-answer-request-complete-resume-"));
    tempDirs.push(dir);
    const requestPath = join(dir, "answer-request.tsv");
    const evidencePath = join(dir, "answer-evidence.tsv");
    writeFileSync(requestPath, materializedAnswerRequestTsv(), "utf-8");
    writeFileSync(
      evidencePath,
      [
        "candidate_id\tanswer_text",
        "repos/Pkg.jl/README.md#auto-readme-package-purpose\trepo=Pkg.jl; source=README.md; evidence=auto-readme-package-purpose; term=Pkg; term=Pkg is Julia package manager",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runPiWendaoCli(
      [
        "--search-agent",
        "--search-agent-answer-request",
        requestPath,
        "--search-agent-answer-mode",
        "live",
        "--search-agent-answer-resume",
        "--search-agent-answer-evidence",
        evidencePath,
        "--no-graph",
      ],
      dir,
      { env: { DEEPSEEK_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" } },
    );
    const output = [result.stdout, result.stderr].join("\n");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("SearchStrategyFlow live materialized answer evidence: wrote 1 row(s)");
  }, 20_000);

  it("forwards Flight endpoint settings to the Rust SearchStrategyFlow bridge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-search-rust-flight-"));
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
        "find SearchStrategyFlow owner through Rust Flight",
        "--wendao-graph",
        graphProject,
        "--search-rust-workspace",
        rustWorkspace,
        "--search-rust-command",
        fakeCargoPath,
        "--search-flight-base-url",
        "http://127.0.0.1:50051",
        "--search-flight-timeout-seconds",
        "7",
        "--no-graph",
      ],
      dir,
    );
    const output = [result.stdout, result.stderr].join("\n");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("candidate_input_source: rust-code-intelligence-inventory");
    expect(output).toContain("candidate_input_count: 1");
    expect(output).toContain(
      `candidate=${searchStrategySectionCandidate} owner=studio-rust materialization=executed`,
    );
    expect(output).toContain("frontier_branches:");
    expect(output).toContain("role=search_strategy");
    expect(output).toContain("materialization=executed rows=4");
    expect(output).toContain("derived_hints{");
    expect(output).toContain("probes=expand_neighbors:docs-fixture/docs/30_search_strategy/30.01_search_strategy_flow.md");
    expect(output).toContain(
      "evidence=node-context:node:stage-1-query-understanding|graph-node:docs-fixture/docs/30_search_strategy/30.01_search_strategy_flow.md",
    );
    expect(output).toContain("rows=4");
    expect(output).toContain(
      "resolved_graph_node=docs-fixture/docs/30_search_strategy/30.01_search_strategy_flow.md",
    );
    expect(output).toContain("route_rows=/search/repos/main:1");
  }, 20_000);

  it("forwards env Flight endpoint settings to the default Rust SearchStrategyFlow bridge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-cli-search-rust-flight-env-"));
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
        "find SearchStrategyFlow owner through env Rust Flight",
        "--wendao-graph",
        graphProject,
        "--search-rust-workspace",
        rustWorkspace,
        "--search-rust-command",
        fakeCargoPath,
        "--no-graph",
      ],
      dir,
      {
        env: {
          PI_WENDAO_SEARCH_FLIGHT_BASE_URL: "http://127.0.0.1:50051",
        },
      },
    );
    const output = [result.stdout, result.stderr].join("\n");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("backend: rust-wendao-julia");
    expect(output).toContain("requested: auto");
    expect(output).toContain("fallback: none");
    expect(output).toContain("candidate_input_source: rust-code-intelligence-inventory");
    expect(output).toContain(
      `candidate=${searchStrategySectionCandidate} owner=studio-rust materialization=executed`,
    );
    expect(output).toContain("materialization=executed rows=4");
    expect(output).toContain(
      "resolved_graph_node=docs-fixture/docs/30_search_strategy/30.01_search_strategy_flow.md",
    );
    expect(output).toContain("route_rows=/search/repos/main:1");
    expect(output).not.toContain("materialization=planned");
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
    expect(output).toContain("backend: rust-wendao-julia");
    expect(output).toContain("control_plane: rust");
    expect(output).toContain("candidate_input_source: rust-markdown-headings");
    expect(output).toContain("requested: auto");
    expect(output).toContain("fallback: none");
    expect(output).toContain("live status=completed model=anthropic/deepseek-v4-pro");
    expect(output).toContain("live intent_understanding=");
    expect(output).toContain("live branch_decision=");
    expect(output).toContain("live judgement=");
    expect(output).toContain(
      "planned runtime=qianji-local-cli service_task=SearchStrategyFlow_QueryUnderstanding",
    );
    expect(output).toContain(`${rustSearchStrategyAuthorityCandidate} action=keep`);
    expect(output).toContain(`${rustSearchStrategyValidationCandidate} action=expand`);
    expect(output).toContain("receipt_source=rust-bridge");
    expect(output).toContain(`primary=${WENDAO_ARROW_FLIGHT_DATA_PLANE}`);
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
    }, options.timeoutMs ?? 20_000);
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
const evalIndex = process.argv.indexOf("-e");
const juliaArgs = evalIndex >= 0 ? process.argv.slice(evalIndex + 2) : process.argv.slice(2);
console.log(JSON.stringify({
  intent: juliaArgs[0],
  backend: "wendao-graph-julia",
  graphProject: "fake/WendaoGraph.jl",
  searchRoot: juliaArgs[1],
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

function writeFakeCargoSearch(path: string, argsRecordPath?: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env node
const argsRecordPath = ${JSON.stringify(argsRecordPath ?? "")};
if (argsRecordPath) {
  require("node:fs").writeFileSync(argsRecordPath, JSON.stringify(process.argv.slice(2)), "utf-8");
}
const hasFlightBaseUrl = process.argv.includes("--flight-base-url");
const isStdioSession = process.argv.includes("--serve-stdio");
const buildTrace = (intent) => ({
  intent,
  backend: "rust-wendao-julia",
  controlPlane: "rust",
  candidateInputSource: hasFlightBaseUrl ? "rust-code-intelligence-inventory" : "rust-markdown-headings",
  candidateInputCount: 1,
  juliaProject: process.env.WENDAOGRAPH_PACKAGE_DIR,
  graphProject: process.env.WENDAOGRAPH_PACKAGE_DIR,
  searchRoot: process.cwd(),
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
  retrievalRoutes: [
    {
      candidateId: "${searchStrategySectionCandidate}",
      materializationOwner: "studio-rust",
      materializationStatus: hasFlightBaseUrl ? "executed" : "planned",
      receiptSource: "rust-bridge",
      primaryTransport: "${WENDAO_ARROW_FLIGHT_DATA_PLANE}",
      sourcePath: "docs/30_search_strategy/30.01_search_strategy_flow.md",
      headingAnchor: "stage-1-query-understanding",
      directFileReadAllowed: false,
      executeBeforeAnswer: true,
      ...(hasFlightBaseUrl ? {
        materializedRows: 4,
        resolvedPageId: "repo:docs-fixture:projection:reference:doc:repo:docs-fixture:doc:docs/30_search_strategy/30.01_search_strategy_flow.md",
        resolvedNodeId: "node:stage-1-query-understanding",
        resolvedGraphNodeId: "docs-fixture/docs/30_search_strategy/30.01_search_strategy_flow.md",
        decodedPayloadStatus: "decoded",
        routeReceipts: [
          { route: "/search/repos/main", rowCount: 1 },
          { route: "/analysis/repo-projected-page-index-tree", rowCount: 1 },
          { route: "/analysis/repo-projected-retrieval-context", rowCount: 1 },
          { route: "/graph/neighbors", rowCount: 1 }
        ],
        decodedPayloadReceipts: [
          {
            route: "/analysis/repo-projected-retrieval-context",
            rowCount: 1,
            decodedColumns: ["pageId", "nodeId", "centerJson", "nodeContextJson"],
            evidenceAnchor: "node-context:node:stage-1-query-understanding"
          },
          {
            route: "/graph/neighbors",
            rowCount: 1,
            decodedColumns: ["rowType"],
            evidenceAnchor: "graph-node:docs-fixture/docs/30_search_strategy/30.01_search_strategy_flow.md"
          }
        ]
      } : {}),
      flightSteps: [
        {
          step: "flight_search_page",
          transport: "${WENDAO_ARROW_FLIGHT_DATA_PLANE}",
          route: "/search/repos/main",
          metadataTemplates: [
            "x-wendao-repo-search-repo=<repo>",
            "x-wendao-repo-search-query=docs/30_search_strategy/30.01_search_strategy_flow.md#stage-1-query-understanding",
            "x-wendao-repo-search-limit=5",
            "x-wendao-repo-search-path-prefixes=docs/30_search_strategy/30.01_search_strategy_flow.md"
          ],
          requiresResolvedPageId: false,
          requiresResolvedNodeId: false,
          requiresResolvedGraphNodeId: false
        },
        {
          step: "flight_resolve_page_index_tree",
          transport: "${WENDAO_ARROW_FLIGHT_DATA_PLANE}",
          route: "/analysis/repo-projected-page-index-tree",
          metadataTemplates: [
            "x-wendao-repo-projected-page-index-tree-repo=<repo>",
            "x-wendao-repo-projected-page-index-tree-page-id=<resolved-page-id>",
            "candidate-heading-anchor=stage-1-query-understanding"
          ],
          requiresResolvedPageId: true,
          requiresResolvedNodeId: false,
          requiresResolvedGraphNodeId: false
        },
        {
          step: "flight_open_retrieval_context",
          transport: "${WENDAO_ARROW_FLIGHT_DATA_PLANE}",
          route: "/analysis/repo-projected-retrieval-context",
          metadataTemplates: [
            "x-wendao-repo-projected-retrieval-context-repo=<repo>",
            "x-wendao-repo-projected-retrieval-context-page-id=<resolved-page-id>",
            "x-wendao-repo-projected-retrieval-context-node-id=<resolved-node-id>",
            "x-wendao-repo-projected-retrieval-context-related-limit=5"
          ],
          requiresResolvedPageId: true,
          requiresResolvedNodeId: true,
          requiresResolvedGraphNodeId: false
        },
        {
          step: "flight_expand_graph_context",
          transport: "${WENDAO_ARROW_FLIGHT_DATA_PLANE}",
          route: "/graph/neighbors",
          metadataTemplates: [
            "x-wendao-graph-node-id=<resolved-graph-node-id>",
            "x-wendao-graph-direction=both",
            "x-wendao-graph-hops=2",
            "x-wendao-graph-limit=50"
          ],
          requiresResolvedPageId: true,
          requiresResolvedNodeId: true,
          requiresResolvedGraphNodeId: true
        }
      ]
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
});
if (isStdioSession) {
  let body = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    body += chunk;
  });
  process.stdin.on("end", () => {
    for (const line of body.trim().split(/\\r?\\n/).filter(Boolean)) {
      const request = JSON.parse(line);
      console.log(JSON.stringify({
        kind: "xiuxian_wendao.wendaograph.search_strategy_flow.persistent_stdio_response.v1",
        requestId: request.requestId,
        ok: true,
        elapsedMs: 1.5,
        trace: buildTrace(request.intent)
      }));
    }
  });
} else {
  console.log(JSON.stringify(buildTrace(process.argv[process.argv.indexOf("--intent") + 1])));
}
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

function materializedAnswerRequestTsv(): string {
  return [
    "candidate_id\tpacket_id\trepo_id\tsource_relative_path\tevidence_kind\trequired_terms\tcompact_packet\tanswer_contract",
    "repos/Pkg.jl/README.md#auto-readme-package-purpose\tmaterialized-packet-1\tPkg.jl\tREADME.md\tauto-readme-package-purpose\tPkg|Pkg is Julia package manager\trepo=Pkg.jl; source=README.md; evidence=auto-readme-package-purpose; term=Pkg; term=Pkg is Julia package manager\tanswer_text must include repo=Pkg.jl; source=README.md; evidence=auto-readme-package-purpose; term=Pkg; term=Pkg is Julia package manager",
    "",
  ].join("\n");
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
