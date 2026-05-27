import type { Effect } from "effect";
import {
  applyControlRunRecovery,
  assertWorkflowServerCapability,
  loadControlRunDiagnostics,
  QIANJI_CONTROL_RECOVERY_APPLY_CAPABILITY,
  type QianjiControlRecoveryApplyRequest,
  type QianjiControlRecoveryApplyResponse,
  type QianjiControlRecoveryResponse,
  type QianjiControlRunSummaryResponse,
  type QianjiServerWorkflowHttpOptions,
} from "./http.js";
import { effectFromPromise, runPiWendaoEffect, type PiWendaoEffectError } from "../../effect.js";

export function loadHostWorkFailureDiagnostics(
  httpOptions: QianjiServerWorkflowHttpOptions,
): Effect.Effect<QianjiControlFailureDiagnostics, PiWendaoEffectError> {
  return effectFromPromise("loadHostWorkFailureDiagnostics", () =>
    loadHostWorkFailureDiagnosticsPromise(httpOptions),
  );
}

async function loadHostWorkFailureDiagnosticsPromise(
  httpOptions: QianjiServerWorkflowHttpOptions,
): Promise<QianjiControlFailureDiagnostics> {
  try {
    const diagnostics = await runPiWendaoEffect(loadControlRunDiagnostics(httpOptions));
    const summary = controlDiagnosticsSummary(diagnostics);
    const recovery = controlDiagnosticsRecovery(diagnostics);
    const report = buildControlFailureReport(summary, recovery);
    return {
      logLines: [renderControlFailureDiagnostics(report)],
      graphDetails: renderControlRecoveryGraphDetails(report),
      targetNodeIds: recoveryActionTargetIds(report.actions),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      logLines: [`qianji server control recovery diagnostics failed: ${message}`],
      graphDetails: [`recovery:diagnostics failed ${message}`],
      targetNodeIds: [],
    };
  }
}

export function applyHostWorkFailureRecovery(
  httpOptions: QianjiServerWorkflowHttpOptions,
  policy: QianjiControlRecoveryApplyPolicy = {},
): Effect.Effect<QianjiControlFailureDiagnostics, PiWendaoEffectError> {
  return effectFromPromise("applyHostWorkFailureRecovery", () =>
    applyHostWorkFailureRecoveryPromise(httpOptions, policy),
  );
}

async function applyHostWorkFailureRecoveryPromise(
  httpOptions: QianjiServerWorkflowHttpOptions,
  policy: QianjiControlRecoveryApplyPolicy = {},
): Promise<QianjiControlFailureDiagnostics> {
  try {
    await runPiWendaoEffect(
      assertWorkflowServerCapability(
        httpOptions,
        QIANJI_CONTROL_RECOVERY_APPLY_CAPABILITY,
        "control recovery apply",
      ),
    );
    const applied = await runPiWendaoEffect(
      applyControlRunRecovery(httpOptions, recoveryApplyRequest(policy)),
    );
    const diagnostics = controlApplyDiagnostics(applied);
    const summary = controlDiagnosticsSummary(diagnostics);
    const recovery = controlDiagnosticsRecovery(diagnostics);
    const report = buildControlFailureReport(summary, recovery);
    return {
      logLines: [renderControlRecoveryApplyReport(report)],
      graphDetails: renderControlRecoveryGraphDetails(report),
      targetNodeIds: recoveryActionTargetIds(report.actions),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostics = await runPiWendaoEffect(loadHostWorkFailureDiagnostics(httpOptions));
    return {
      logLines: [
        `qianji server control recovery apply failed: ${message}`,
        ...diagnostics.logLines,
      ],
      graphDetails: [`recovery-apply:failed ${message}`, ...diagnostics.graphDetails],
      targetNodeIds: diagnostics.targetNodeIds,
    };
  }
}

export interface QianjiControlRecoveryApplyPolicy {
  attempt?: number;
  reason?: string;
  maxAttempts?: number;
  backoffMs?: number;
  requireHumanApproval?: boolean;
  priority?: number;
}

function recoveryApplyRequest(
  policy: QianjiControlRecoveryApplyPolicy,
): QianjiControlRecoveryApplyRequest {
  return {
    occurred_at_ms: Date.now(),
    attempt: policy.attempt ?? 1,
    reason: policy.reason ?? "pi-wendao operator requested bounded recovery",
    max_attempts: policy.maxAttempts ?? 1,
    ...(policy.backoffMs !== undefined ? { backoff_ms: policy.backoffMs } : {}),
    ...(policy.requireHumanApproval !== undefined
      ? { require_human_approval: policy.requireHumanApproval }
      : {}),
    ...(policy.priority !== undefined ? { priority: policy.priority } : {}),
  };
}

interface QianjiControlDiagnosticsResponse {
  run_id?: string;
  diagnostics?: {
    summary?: QianjiControlRunSummaryResponse["summary"];
    recovery?: QianjiControlRecoveryResponse["recovery"];
  };
}

function controlDiagnosticsSummary(
  diagnostics: QianjiControlDiagnosticsResponse,
): QianjiControlRunSummaryResponse {
  return {
    run_id: diagnostics.run_id,
    summary: diagnostics.diagnostics?.summary,
  };
}

function controlDiagnosticsRecovery(
  diagnostics: QianjiControlDiagnosticsResponse,
): QianjiControlRecoveryResponse {
  return {
    run_id: diagnostics.run_id,
    recovery: diagnostics.diagnostics?.recovery,
  };
}

function controlApplyDiagnostics(
  applied: QianjiControlRecoveryApplyResponse,
): QianjiControlDiagnosticsResponse {
  return {
    run_id: applied.run_id,
    diagnostics: applied.diagnostics,
  };
}

export interface QianjiControlFailureDiagnostics {
  logLines: string[];
  graphDetails: string[];
  targetNodeIds: string[];
}

interface QianjiControlFailureReport {
  runId: string;
  eventCount: string;
  activities: {
    total: string;
    failed: string;
    inFlight: string;
  };
  recovery: {
    total: string;
    retry: string;
    review: string;
    terminal: string;
  };
  actions: QianjiControlRecoveryActionDto[];
}

function buildControlFailureReport(
  summary: QianjiControlRunSummaryResponse,
  recovery: QianjiControlRecoveryResponse,
): QianjiControlFailureReport {
  const activity = summary.summary?.activities ?? {};
  const recoverySummary = recovery.recovery?.summary ?? summary.summary?.recovery ?? {};
  const actions = (recovery.recovery?.plan?.actions ?? []).map(normalizeRecoveryAction);
  return {
    runId: summary.run_id ?? recovery.run_id ?? "unknown",
    eventCount: formatCount(summary.summary?.event_count),
    activities: {
      total: formatCount(activity.total),
      failed: formatCount(activity.failed),
      inFlight: formatCount(activity.in_flight),
    },
    recovery: {
      total: formatCount(recoverySummary.total_actions),
      retry: formatCount(recoverySummary.retry_activities),
      review: formatCount(recoverySummary.review_retryable_activities),
      terminal: formatCount(recoverySummary.terminal_activity_escalations),
    },
    actions,
  };
}

function renderControlFailureDiagnostics(report: QianjiControlFailureReport): string {
  return [
    "# BPMN Control Recovery",
    "",
    "Outcome: reported",
    `Run: ${report.runId}`,
    `Events: ${report.eventCount}`,
    `Activities: total ${report.activities.total}, failed ${report.activities.failed}, in-flight ${report.activities.inFlight}`,
    [
      `Recovery actions: total ${report.recovery.total}`,
      `retry ${report.recovery.retry}`,
      `review ${report.recovery.review}`,
      `terminal ${report.recovery.terminal}`,
    ].join(", "),
    ...renderRecoveryActions(report.actions),
  ].join("\n");
}

function renderControlRecoveryApplyReport(report: QianjiControlFailureReport): string {
  return renderControlFailureDiagnostics(report)
    .replace("# BPMN Control Recovery", "# BPMN Control Recovery Apply")
    .replace("Outcome: reported", "Outcome: attempted");
}

function renderControlRecoveryGraphDetails(report: QianjiControlFailureReport): string[] {
  return [
    `recovery:total ${report.recovery.total}, retry ${report.recovery.retry}, review ${report.recovery.review}, terminal ${report.recovery.terminal}`,
    ...renderRecoveryActions(report.actions).map((line) =>
      line.replace(/^Action:\s*/, "recovery-action:"),
    ),
  ];
}

interface QianjiControlRecoveryActionDto {
  action?: string;
  activity_id?: string;
  step_id?: string;
  timer_id?: string;
  lease_id?: string;
  decision_id?: string;
}

function normalizeRecoveryAction(value: unknown): QianjiControlRecoveryActionDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.action === "string" ? { action: record.action } : {}),
    ...(typeof record.activity_id === "string" ? { activity_id: record.activity_id } : {}),
    ...(typeof record.step_id === "string" ? { step_id: record.step_id } : {}),
    ...(typeof record.timer_id === "string" ? { timer_id: record.timer_id } : {}),
    ...(typeof record.lease_id === "string" ? { lease_id: record.lease_id } : {}),
    ...(typeof record.decision_id === "string" ? { decision_id: record.decision_id } : {}),
  };
}

function renderRecoveryActions(actions: QianjiControlRecoveryActionDto[]): string[] {
  if (actions.length === 0) return ["Action: none"];
  return actions.map(
    (action) => `Action: ${action.action ?? "unknown"}${recoveryActionTarget(action)}`,
  );
}

function recoveryActionTarget(action: QianjiControlRecoveryActionDto): string {
  const target =
    action.activity_id ??
    action.step_id ??
    action.timer_id ??
    action.lease_id ??
    action.decision_id;
  return target ? ` ${target}` : "";
}

function recoveryActionTargetIds(actions: QianjiControlRecoveryActionDto[]): string[] {
  return [
    ...new Set(
      actions
        .map(
          (action) =>
            action.activity_id ??
            action.step_id ??
            action.timer_id ??
            action.lease_id ??
            action.decision_id,
        )
        .filter((target): target is string => Boolean(target)),
    ),
  ];
}

function formatCount(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown";
}
