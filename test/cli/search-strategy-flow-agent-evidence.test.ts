import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSearchStrategyFlowAgentAnswerEvidenceRows,
  buildSearchStrategyFlowRequestAnswerEvidenceRows,
  loadSearchStrategyFlowAnswerRequestRows,
  parseSearchStrategyFlowLiveAnswerEvidenceTsv,
  parseSearchStrategyFlowPartialLiveAnswerEvidenceTsv,
  renderSearchStrategyFlowAnswerEvidenceTsv,
  writeSearchStrategyFlowAgentAnswerEvidence,
  writeSearchStrategyFlowRequestAnswerEvidence,
} from "../../src/cli/search/strategy-flow-agent-evidence.js";
import { buildLiveRequestAnswerPrompt } from "../../src/cli/search/strategy-flow-live-answer.js";
import type {
  SearchStrategyFlowAgentTrace,
  SearchStrategyFlowTrace,
} from "../../src/cli/search/strategy-flow-types.js";

const tempDirs: string[] = [];

describe("SearchStrategyFlow live answer evidence", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders completed live subagent output as candidate-scoped TSV evidence", () => {
    const rows = buildSearchStrategyFlowAgentAnswerEvidenceRows(
      sampleTrace(),
      completedAgentTrace(),
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      candidateId: "docs/a.md#owner",
      answerText:
        "candidate_id=docs/a.md#owner; frontier_rank=1; frontier_action=keep; judgement_kind=graph_verified_candidate; intent_understanding=Find the owner boundary.; branch_decision=Keep owner and validation branches.; judgement=The selected frontier is sufficient.",
    });
    expect(renderSearchStrategyFlowAnswerEvidenceTsv(rows)).toBe(
      [
        "candidate_id\tanswer_text",
        "docs/a.md#owner\tcandidate_id=docs/a.md#owner; frontier_rank=1; frontier_action=keep; judgement_kind=graph_verified_candidate; intent_understanding=Find the owner boundary.; branch_decision=Keep owner and validation branches.; judgement=The selected frontier is sufficient.",
        "docs/b.md#validation\tcandidate_id=docs/b.md#validation; frontier_rank=2; frontier_action=compare; judgement_kind=subagent_branch_judgement; intent_understanding=Find the owner boundary.; branch_decision=Keep owner and validation branches.; judgement=The selected frontier is sufficient.",
        "",
      ].join("\n"),
    );
  });

  it("writes explicit evidence files only for completed live traces", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-answer-evidence-"));
    tempDirs.push(dir);
    const evidencePath = join(dir, "answer-evidence.tsv");

    const result = writeSearchStrategyFlowAgentAnswerEvidence(
      evidencePath,
      sampleTrace(),
      completedAgentTrace(),
    );

    expect(result).toEqual({ path: evidencePath, rowCount: 2 });
    expect(readFileSync(evidencePath, "utf-8")).toContain(
      "candidate_id\tanswer_text\n",
    );
  });

  it("converts materialized request TSV rows into answer evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-answer-request-"));
    tempDirs.push(dir);
    const requestPath = join(dir, "request.tsv");
    const evidencePath = join(dir, "answer-evidence.tsv");
    writeFileSync(requestPath, materializedAnswerRequestTsv(), "utf-8");

    const requestRows = loadSearchStrategyFlowAnswerRequestRows(requestPath);
    const evidenceRows = buildSearchStrategyFlowRequestAnswerEvidenceRows(requestRows);
    const result = writeSearchStrategyFlowRequestAnswerEvidence(requestPath, evidencePath);

    expect(requestRows).toHaveLength(1);
    expect(requestRows[0]?.requiredTerms).toEqual(["Pkg", "Pkg is Julia package manager"]);
    expect(evidenceRows).toEqual([
      {
        candidateId: "repos/Pkg.jl/README.md#auto-readme-package-purpose",
        answerText:
          "repo=Pkg.jl; source=README.md; evidence=auto-readme-package-purpose; term=Pkg; term=Pkg is Julia package manager",
      },
    ]);
    expect(result).toEqual({ path: evidencePath, rowCount: 1 });
    expect(readFileSync(evidencePath, "utf-8")).toContain(
      "repos/Pkg.jl/README.md#auto-readme-package-purpose\trepo=Pkg.jl; source=README.md",
    );
  });

  it("rejects skipped or incomplete live traces before writing evidence", () => {
    expect(() =>
      buildSearchStrategyFlowAgentAnswerEvidenceRows(sampleTrace(), {
        mode: "live-subagent",
        status: "skipped",
        events: [],
      }),
    ).toThrow("requires completed agent trace");

    expect(() =>
      buildSearchStrategyFlowAgentAnswerEvidenceRows(sampleTrace(), {
        ...completedAgentTrace(),
        output: {
          intent_understanding: "Find the owner boundary.",
          branch_decision: "Keep owner and validation branches.",
        },
      }),
    ).toThrow("missing non-empty judgement");
  });

  it("rejects malformed materialized answer request TSV", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-bad-answer-request-"));
    tempDirs.push(dir);
    const requestPath = join(dir, "bad-request.tsv");
    writeFileSync(requestPath, "candidate_id\tanswer_text\nmissing\tshape\n", "utf-8");

    expect(() => loadSearchStrategyFlowAnswerRequestRows(requestPath)).toThrow(
      "invalid header",
    );
    expect(() => buildSearchStrategyFlowRequestAnswerEvidenceRows([])).toThrow(
      "must contain at least one request row",
    );
  });

  it("validates strict live model TSV against materialized request rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-live-answer-"));
    tempDirs.push(dir);
    const requestPath = join(dir, "request.tsv");
    writeFileSync(requestPath, materializedAnswerRequestTsv(), "utf-8");
    const requestRows = loadSearchStrategyFlowAnswerRequestRows(requestPath);

    const rows = parseSearchStrategyFlowLiveAnswerEvidenceTsv(
      [
        "candidate_id\tanswer_text",
        "repos/Pkg.jl/README.md#auto-readme-package-purpose\trepo=Pkg.jl; source=README.md; evidence=auto-readme-package-purpose; term=Pkg; term=Pkg is Julia package manager",
      ].join("\n"),
      requestRows,
    );

    expect(rows).toEqual([
      {
        candidateId: "repos/Pkg.jl/README.md#auto-readme-package-purpose",
        answerText:
          "repo=Pkg.jl; source=README.md; evidence=auto-readme-package-purpose; term=Pkg; term=Pkg is Julia package manager",
      },
    ]);

    expect(parseSearchStrategyFlowPartialLiveAnswerEvidenceTsv(
      [
        "candidate_id\tanswer_text",
        "repos/Pkg.jl/README.md#auto-readme-package-purpose\trepo=Pkg.jl; source=README.md; evidence=auto-readme-package-purpose; term=Pkg; term=Pkg is Julia package manager",
      ].join("\n"),
      requestRows,
    )).toHaveLength(1);
  });

  it("normalizes model quote escaping before writing live answer evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-live-answer-quote-"));
    tempDirs.push(dir);
    const requestPath = join(dir, "request.tsv");
    writeFileSync(requestPath, materializedQuotedAnswerRequestTsv(), "utf-8");
    const requestRows = loadSearchStrategyFlowAnswerRequestRows(requestPath);

    const rows = parseSearchStrategyFlowLiveAnswerEvidenceTsv(
      [
        "candidate_id\tanswer_text",
        "repos/Quoted.jl/README.md#auto-readme-package-purpose\trepo=Quoted.jl; source=README.md; evidence=auto-readme-package-purpose; term=Quoted; term=The \\\"tutorials\\\" folder",
      ].join("\n"),
      requestRows,
    );

    expect(rows[0]?.answerText).toContain('term=The "tutorials" folder');
  });

  it("instructs live request answers to preserve packet text byte-for-byte", () => {
    const prompt = buildLiveRequestAnswerPrompt(4);

    expect(prompt).toContain("copy that compact_packet byte-for-byte");
    expect(prompt).toContain("Do not rewrite punctuation, quotes, backticks");
    expect(prompt).toContain("Do not JSON-escape, shell-escape, or backslash-escape");
  });

  it("rejects live model TSV with missing, duplicated, or over-budget rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-bad-live-answer-"));
    tempDirs.push(dir);
    const requestPath = join(dir, "request.tsv");
    writeFileSync(requestPath, materializedAnswerRequestTsv(), "utf-8");
    const requestRows = loadSearchStrategyFlowAnswerRequestRows(requestPath);

    expect(() =>
      parseSearchStrategyFlowLiveAnswerEvidenceTsv("candidate_id\tanswer_text\n", requestRows),
    ).toThrow("has 0 row");
    expect(() =>
      parseSearchStrategyFlowLiveAnswerEvidenceTsv(
        [
          "candidate_id\tanswer_text",
          "repos/Other.jl/README.md#auto-readme-package-purpose\trepo=Other.jl",
        ].join("\n"),
        requestRows,
      ),
    ).toThrow("candidate mismatch");
    expect(() =>
      parseSearchStrategyFlowLiveAnswerEvidenceTsv(
        [
          "candidate_id\tanswer_text",
          `repos/Pkg.jl/README.md#auto-readme-package-purpose\t${"x".repeat(513)}`,
        ].join("\n"),
        requestRows,
      ),
    ).toThrow("exceeds the 512 character evidence bound");

    const twoRowRequestPath = join(dir, "two-row-request.tsv");
    writeFileSync(twoRowRequestPath, materializedTwoRowAnswerRequestTsv(), "utf-8");
    const twoRowRequestRows = loadSearchStrategyFlowAnswerRequestRows(twoRowRequestPath);
    expect(() =>
      parseSearchStrategyFlowLiveAnswerEvidenceTsv(
        [
          "candidate_id\tanswer_text",
          "repos/Pkg.jl/README.md#auto-readme-package-purpose\trepo=Pkg.jl",
          "repos/Pkg.jl/README.md#auto-readme-package-purpose\trepo=Pkg.jl",
        ].join("\n"),
        twoRowRequestRows,
      ),
    ).toThrow("duplicates candidate id");
  });
});

function completedAgentTrace(): SearchStrategyFlowAgentTrace {
  return {
    mode: "live-subagent",
    status: "completed",
    model: "anthropic/deepseek-v4-pro",
    durationMs: 100,
    cached: false,
    events: [],
    output: {
      intent_understanding: "Find the owner boundary.",
      branch_decision: "Keep owner and validation branches.",
      judgement: "The selected frontier is sufficient.",
    },
  };
}

function sampleTrace(): SearchStrategyFlowTrace {
  return {
    intent: "find owner boundary",
    backend: "wendao-graph-julia",
    graphProject: "/tmp/WendaoGraph.jl",
    searchRoot: "/tmp/WendaoGraph.jl",
    stageReceipts: [],
    candidates: [],
    frontier: [
      {
        candidateId: "docs/a.md#owner",
        rank: 1,
        selected: true,
        finalScore: 0.9,
        action: "keep",
        contextBudget: 120,
        judgementKind: "graph_verified_candidate",
      },
      {
        candidateId: "docs/b.md#validation",
        rank: 2,
        selected: true,
        finalScore: 0.8,
        action: "compare",
        contextBudget: 120,
        judgementKind: "subagent_branch_judgement",
      },
      {
        candidateId: "docs/c.md#trap",
        rank: 3,
        selected: false,
        finalScore: 0.1,
        action: "prune",
        contextBudget: 120,
        judgementKind: "negative_guard",
      },
    ],
    plannerActions: [],
    summary: {
      candidateCount: 3,
      selectedCount: 2,
      plannerActionCount: 0,
      totalContextCost: 360,
      selectedContextCost: 240,
      contextReductionRatio: 0.33,
    },
    validation: {
      noVectorMode: true,
      materializedTopCandidate: true,
      blockedEvidencePruned: true,
      selectedContextReduced: true,
    },
  };
}

function materializedAnswerRequestTsv(): string {
  return [
    "candidate_id\tpacket_id\trepo_id\tsource_relative_path\tevidence_kind\trequired_terms\tcompact_packet\tanswer_contract",
    "repos/Pkg.jl/README.md#auto-readme-package-purpose\tmaterialized-packet-1\tPkg.jl\tREADME.md\tauto-readme-package-purpose\tPkg|Pkg is Julia package manager\trepo=Pkg.jl; source=README.md; evidence=auto-readme-package-purpose; term=Pkg; term=Pkg is Julia package manager\tanswer_text must include repo=Pkg.jl; source=README.md; evidence=auto-readme-package-purpose; term=Pkg; term=Pkg is Julia package manager",
    "",
  ].join("\n");
}

function materializedTwoRowAnswerRequestTsv(): string {
  return [
    "candidate_id\tpacket_id\trepo_id\tsource_relative_path\tevidence_kind\trequired_terms\tcompact_packet\tanswer_contract",
    "repos/Pkg.jl/README.md#auto-readme-package-purpose\tmaterialized-packet-1\tPkg.jl\tREADME.md\tauto-readme-package-purpose\tPkg|Pkg is Julia package manager\trepo=Pkg.jl; source=README.md; evidence=auto-readme-package-purpose; term=Pkg; term=Pkg is Julia package manager\tanswer_text must include repo=Pkg.jl; source=README.md; evidence=auto-readme-package-purpose; term=Pkg; term=Pkg is Julia package manager",
    "repos/Tables.jl/README.md#auto-readme-package-purpose\tmaterialized-packet-2\tTables.jl\tREADME.md\tauto-readme-package-purpose\tTables|Tables is a table interface\trepo=Tables.jl; source=README.md; evidence=auto-readme-package-purpose; term=Tables; term=Tables is a table interface\tanswer_text must include repo=Tables.jl; source=README.md; evidence=auto-readme-package-purpose; term=Tables; term=Tables is a table interface",
    "",
  ].join("\n");
}

function materializedQuotedAnswerRequestTsv(): string {
  return [
    "candidate_id\tpacket_id\trepo_id\tsource_relative_path\tevidence_kind\trequired_terms\tcompact_packet\tanswer_contract",
    'repos/Quoted.jl/README.md#auto-readme-package-purpose\tmaterialized-packet-1\tQuoted.jl\tREADME.md\tauto-readme-package-purpose\tQuoted|The "tutorials" folder\trepo=Quoted.jl; source=README.md; evidence=auto-readme-package-purpose; term=Quoted; term=The "tutorials" folder\tanswer_text must include repo=Quoted.jl; source=README.md; evidence=auto-readme-package-purpose; term=Quoted; term=The "tutorials" folder',
    "",
  ].join("\n");
}
