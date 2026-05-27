import { encodeArrowIpcTable } from "../../arrow/ipc.js";
import {
  arrowSchemaContract,
  boolArrowColumn,
  boolColumn,
  float64ArrowColumn,
  float64Column,
  tableFromArrowColumns,
  utf8ArrowColumn,
  utf8Column,
} from "../../arrow/schema.js";
import type { SearchStrategyFlowBranchJudgementRow } from "./strategy-flow-types.js";

const SEARCH_STRATEGY_FLOW_BRANCH_JUDGEMENT_TABLE = arrowSchemaContract(
  "search_strategy_flow_branch_judgement",
  [
    utf8ArrowColumn("flow_id"),
    utf8ArrowColumn("candidate_id"),
    utf8ArrowColumn("branch_role"),
    float64ArrowColumn("judgement_score"),
    float64ArrowColumn("confidence"),
    utf8ArrowColumn("decision"),
    boolArrowColumn("blocked"),
    utf8ArrowColumn("reason"),
  ],
);

export function encodeSearchStrategyFlowBranchJudgementsArrowIpc(
  rows: readonly SearchStrategyFlowBranchJudgementRow[],
): Uint8Array {
  return encodeArrowIpcTable(
    tableFromArrowColumns(SEARCH_STRATEGY_FLOW_BRANCH_JUDGEMENT_TABLE, {
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
