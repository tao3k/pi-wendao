import { Bool, Float64, Table, Utf8, vectorFromArray } from "apache-arrow";
import { encodeArrowIpcTable } from "../../arrow/ipc.js";
import type { SearchStrategyFlowBranchJudgementRow } from "./strategy-flow-types.js";

export function encodeSearchStrategyFlowBranchJudgementsArrowIpc(
  rows: readonly SearchStrategyFlowBranchJudgementRow[],
): Uint8Array {
  return encodeArrowIpcTable(
    new Table({
      flow_id: utf8Column(rows.map((row) => row.flowId ?? "")),
      candidate_id: utf8Column(rows.map((row) => row.candidateId)),
      branch_role: utf8Column(rows.map((row) => row.branchRole)),
      judgement_score: float64Column(rows.map((row) => row.judgementScore)),
      confidence: float64Column(rows.map((row) => row.confidence)),
      decision: utf8Column(rows.map((row) => row.decision)),
      blocked: boolColumn(rows.map((row) => row.blocked)),
      reason: utf8Column(rows.map((row) => row.reason)),
    }),
    "stream",
  );
}

function utf8Column(values: readonly string[]) {
  return vectorFromArray([...values], new Utf8());
}

function float64Column(values: readonly number[]) {
  return vectorFromArray([...values], new Float64());
}

function boolColumn(values: readonly boolean[]) {
  return vectorFromArray([...values], new Bool());
}
