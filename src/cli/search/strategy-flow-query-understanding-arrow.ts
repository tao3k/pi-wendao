import { Float64, Int64, Table, Utf8, vectorFromArray } from "apache-arrow";
import { encodeArrowIpcTable } from "../../arrow/ipc.js";
import type { SearchStrategyFlowQueryUnderstandingRow } from "./strategy-flow-types.js";

export function encodeSearchStrategyFlowQueryUnderstandingArrowIpc(
  rows: readonly SearchStrategyFlowQueryUnderstandingRow[],
): Uint8Array {
  return encodeArrowIpcTable(
    new Table({
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

function utf8Column(values: readonly string[]) {
  return vectorFromArray([...values], new Utf8());
}

function float64Column(values: readonly number[]) {
  return vectorFromArray([...values], new Float64());
}

function int64Column(values: readonly number[]) {
  return vectorFromArray(values.map((value) => BigInt(value)), new Int64());
}
