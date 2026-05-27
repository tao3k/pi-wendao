import type { PiWendaoHostWorkKind, PiWendaoQianjiCheckpointFeedback } from "./agent-host.js";
import type {
  ActivityId,
  NodeId,
  NodeIndex,
  ProcessId,
  QianjiNodeKind,
  QianjiNodeStatus,
  TokenId,
} from "../types/domain.js";

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
  process_id?: ProcessId;
  activity_id?: ActivityId;
  node_id: NodeId;
  node_index?: NodeIndex;
  token_id: TokenId;
  variables?: Record<string, unknown> | null;
  repeat?: unknown;
  form?: QianjiHumanTaskForm | null;
  assignment?: QianjiHumanTaskAssignment | null;
  claim?: QianjiHostWorkClaim | null;
}

export interface QianjiHumanTaskForm {
  interaction_type: import("./agent-host.js").QianjiInteractionType;
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
  node_id: NodeId;
  node_kind?: QianjiNodeKind | null;
  status: QianjiNodeStatus;
}

export interface QianjiTraceFlowTakeEvent {
  kind: "flow_take";
  source_id: string;
  target_id: string;
}

export interface QianjiGraphSnapshotNode {
  node_id: NodeId;
  status: QianjiNodeStatus;
  node_kind?: QianjiNodeKind | null;
  node_index?: number;
}
