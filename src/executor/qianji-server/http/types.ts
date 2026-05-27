import type { HostCompletionResult } from "../../executor-host-loop.js";
import type { QianjiHostWork } from "../../qianji-types.js";
import type {
  DmnPath,
  InstanceId,
  NodeId,
  ProcessId,
  TokenId,
  QianjiWorkflowServerUrl,
  WorkflowPath,
} from "../../../types/domain.js";
import type { PiWendaoHostWorkKind } from "../../agent-host.js";

export interface QianjiServerWorkflowHttpOptions {
  serverUrl: QianjiWorkflowServerUrl;
  sourcePath: WorkflowPath;
  processId: ProcessId;
  instanceId: InstanceId;
  context: Record<string, unknown>;
  dmnPaths: DmnPath[];
  startAtNode?: NodeId;
  startMode?: "resume-or-start" | "start";
  signal?: AbortSignal;
}

export const REQUIRED_WORKFLOW_CAPABILITIES = [
  "bpmn.workflow.start",
  "bpmn.workflow.task.complete",
  "bpmn.workflow.task.complete-batch",
  "bpmn.workflow.task.fail",
  "qianji.control.diagnostics",
] as const;

export const QIANJI_CONTROL_RECOVERY_APPLY_CAPABILITY = "qianji.control.recovery.apply";

export interface QianjiServerWorkflowResponse {
  outcome?: unknown;
  resumed_from_checkpoint?: boolean;
  checkpoint_saved?: boolean;
  checkpoint_deleted?: boolean;
  checkpoint_backend?: string | null;
  workflow?: QianjiServerWorkflowSnapshot;
}

export interface QianjiServerWorkflowSnapshot {
  variables?: Record<string, unknown> | null;
  pending_host_work_count?: number;
  pending_host_work?: QianjiServerPendingHostWork[];
}

export interface QianjiServerPendingHostWork {
  kind?: PiWendaoHostWorkKind;
  process_id?: ProcessId | null;
  activity_id?: import("../../../types/domain.js").ActivityId | null;
  node_id?: NodeId | null;
  node_index?: number;
  token_id?: TokenId;
  variables?: Record<string, unknown> | null;
  inputs?: Record<string, unknown> | null;
  repeat?: unknown;
  form?: QianjiHostWork["form"];
  assignment?: QianjiHostWork["assignment"];
  claim?: QianjiHostWork["claim"];
}

export interface QianjiServerCapabilitiesResponse {
  service?: string;
  capabilities?: string[];
}

export interface QianjiControlRunSummaryResponse {
  run_id?: string;
  summary?: QianjiControlRunSummary;
}

export interface QianjiControlRunSummary {
  event_count?: number;
  activities?: {
    total?: number;
    scheduled?: number;
    in_flight?: number;
    completed?: number;
    failed?: number;
  };
  recovery?: {
    total_actions?: number;
    retry_activities?: number;
    review_retryable_activities?: number;
    terminal_activity_escalations?: number;
    fireable_timers?: number;
    reclaim_expired_leases?: number;
  };
}

export interface QianjiControlRecoveryResponse {
  run_id?: string;
  recovery?: {
    summary?: QianjiControlRunSummary["recovery"];
    plan?: {
      actions?: unknown[];
    };
  };
}

export interface QianjiControlDiagnosticsResponse {
  run_id?: string;
  diagnostics?: {
    summary?: QianjiControlRunSummary;
    recovery?: QianjiControlRecoveryResponse["recovery"];
  };
}

export interface QianjiControlRecoveryApplyRequest {
  occurred_at_ms: number;
  attempt: number;
  reason: string;
  max_attempts: number;
  backoff_ms?: number;
  require_human_approval?: boolean;
  priority?: number;
}

export interface QianjiControlRecoveryApplyResponse {
  run_id?: string;
  application?: {
    action_results?: unknown[];
  };
  diagnostics?: QianjiControlDiagnosticsResponse["diagnostics"];
}

export type QianjiServerHostCompletion = HostCompletionResult;
