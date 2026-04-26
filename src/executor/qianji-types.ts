import type { PiWendaoHostWorkKind } from "./agent-host.js";

export interface QianjiCliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  streamedTrace: boolean;
  hostWork: QianjiHostWork[];
}

export type QianjiTraceEvent = QianjiTraceNodeStatusEvent | QianjiTraceFlowTakeEvent;

export interface QianjiHostWorkEvent {
  activityId: string;
  hostWorkCount: number;
  batchHostWorkCount: number;
  tokenIds: number[];
  hostKinds: PiWendaoHostWorkKind[];
  parallel: boolean;
  repeatKinds: string[];
  repeatSummaries: string[];
}

export type QianjiHostWork = QianjiBaseHostWork;

export interface QianjiBaseHostWork {
  kind: PiWendaoHostWorkKind;
  node_id: string;
  node_index?: number;
  token_id: number;
  variables?: Record<string, unknown>;
  repeat?: unknown;
}

export interface QianjiTraceNodeStatusEvent {
  kind: "node_status";
  node_id: string;
  node_kind?: string | null;
  status: string;
}

export interface QianjiTraceFlowTakeEvent {
  kind: "flow_take";
  source_id: string;
  target_id: string;
}

export interface QianjiGraphSnapshotNode {
  node_id: string;
  status: string;
  node_kind?: string | null;
  node_index?: number;
}
