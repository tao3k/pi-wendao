import { encodeArrowIpcTable } from "../../arrow/ipc.js";
import {
  arrowSchemaContract,
  float64ArrowColumn,
  float64Column,
  int64ArrowColumn,
  int64Column,
  tableFromArrowColumns,
  utf8ArrowColumn,
  utf8Column,
} from "../../arrow/schema.js";
import type { SearchStrategyFlowQueryUnderstandingRow } from "./strategy-flow-types.js";

const SEARCH_STRATEGY_FLOW_QUERY_UNDERSTANDING_TABLE = arrowSchemaContract(
  "search_strategy_flow_query_understanding",
  [
    utf8ArrowColumn("flow_id"),
    utf8ArrowColumn("intent_id"),
    utf8ArrowColumn("signal_id"),
    utf8ArrowColumn("signal_kind"),
    utf8ArrowColumn("signal_value"),
    float64ArrowColumn("confidence"),
    utf8ArrowColumn("route_hint"),
    utf8ArrowColumn("required_evidence"),
    float64ArrowColumn("ambiguity"),
    float64ArrowColumn("weight"),
    int64ArrowColumn("recommended_loop_budget"),
    int64ArrowColumn("recommended_judgement_budget"),
    int64ArrowColumn("recommended_beam_width"),
    utf8ArrowColumn("reason"),
  ],
);

export function encodeSearchStrategyFlowQueryUnderstandingArrowIpc(
  rows: readonly SearchStrategyFlowQueryUnderstandingRow[],
): Uint8Array {
  return encodeArrowIpcTable(
    tableFromArrowColumns(SEARCH_STRATEGY_FLOW_QUERY_UNDERSTANDING_TABLE, {
      flow_id: utf8Column(rows.map((row) => row.flowId)),
      intent_id: utf8Column(rows.map((row) => row.intentId)),
      signal_id: utf8Column(rows.map((row) => row.signalId)),
      signal_kind: utf8Column(rows.map((row) => row.signalKind)),
      signal_value: utf8Column(rows.map((row) => row.signalValue)),
      confidence: float64Column(rows.map((row) => row.confidence)),
      route_hint: utf8Column(rows.map((row) => row.routeHint)),
      required_evidence: utf8Column(rows.map((row) => row.requiredEvidence)),
      ambiguity: float64Column(rows.map((row) => row.ambiguity)),
      weight: float64Column(rows.map((row) => row.weight)),
      recommended_loop_budget: int64Column(rows.map((row) => row.recommendedLoopBudget)),
      recommended_judgement_budget: int64Column(rows.map((row) => row.recommendedJudgementBudget)),
      recommended_beam_width: int64Column(rows.map((row) => row.recommendedBeamWidth)),
      reason: utf8Column(rows.map((row) => row.reason)),
    }),
    "stream",
  );
}
