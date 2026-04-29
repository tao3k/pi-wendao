import type { PiWendaoHostWorkKind, PiWendaoQianjiCheckpointFeedback } from "./agent-host.js";

export interface QianjiCliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  streamedTrace: boolean;
  hostWork: QianjiHostWork[];
  outcome?: string;
  checkpoint?: PiWendaoQianjiCheckpointFeedback;
  pendingHostWork?: number;
  variables?: Record<string, unknown>;
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
  assignmentSummaries?: string[];
}

export type QianjiHostWork = QianjiBaseHostWork;

export interface QianjiBaseHostWork {
  kind: PiWendaoHostWorkKind;
  process_id?: string;
  activity_id?: string;
  node_id: string;
  node_index?: number;
  token_id: number;
  variables?: Record<string, unknown> | null;
  repeat?: unknown;
  form?: QianjiHumanTaskForm | null;
  assignment?: QianjiHumanTaskAssignment | null;
  claim?: QianjiHostWorkClaim | null;
}

export interface QianjiHumanTaskForm {
  interaction_type: string;
  question_ref?: string | null;
  question_text?: string | null;
  choices_ref?: string | null;
  choices?: QianjiHumanTaskChoice[] | null;
  free_text_fields?: QianjiHumanTaskFreeText[] | null;
  result_output?: string | null;
}

export interface QianjiHumanTaskChoice {
  value: string;
  label?: string | null;
  description?: string | null;
}

export interface QianjiHumanTaskFreeText {
  name: string;
  optional: boolean;
}

export interface QianjiHumanTaskAssignment {
  human_performers?: QianjiHumanTaskResourceRole[] | null;
  potential_owners?: QianjiHumanTaskResourceRole[] | null;
}

export interface QianjiHumanTaskResourceRole {
  name?: string | null;
  resource_ref?: string | null;
  assignment_expression?: string | null;
}

export interface QianjiHostWorkClaim {
  claimant: string;
  claimed_at_ms?: number;
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
