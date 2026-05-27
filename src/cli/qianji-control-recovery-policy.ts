import type { Command } from "commander";
import type { QianjiControlRecoveryApplyPolicy } from "../executor/qianji-server/control-diagnostics.js";
import {
  parseIntegerOption,
  parseNonNegativeInt,
  parsePositiveIntOption,
} from "./number-options.js";

export interface QianjiControlRecoveryCliOptions {
  qianjiControlApplyRecovery?: boolean;
  qianjiControlRecoveryAttempt?: number;
  qianjiControlRecoveryReason?: string;
  qianjiControlRecoveryMaxAttempts?: number;
  qianjiControlRecoveryBackoffMs?: number;
  qianjiControlRecoveryRequireHumanApproval?: boolean;
  qianjiControlRecoveryPriority?: number;
}

export function registerQianjiControlRecoveryPolicyOptions<T extends Command>(command: T): T {
  return command
    .option(
      "--qianji-control-apply-recovery",
      "Explicitly apply the qianji-control recovery plan after qianji-server host failure evidence is recorded",
    )
    .option(
      "--qianji-control-recovery-attempt <n>",
      "Recovery apply attempt number for --qianji-control-apply-recovery",
      (value) => parsePositiveIntOption(value, "--qianji-control-recovery-attempt"),
    )
    .option(
      "--qianji-control-recovery-reason <text>",
      "Operator reason recorded for --qianji-control-apply-recovery",
    )
    .option(
      "--qianji-control-recovery-max-attempts <n>",
      "Maximum bounded recovery attempts for --qianji-control-apply-recovery",
      (value) => parsePositiveIntOption(value, "--qianji-control-recovery-max-attempts"),
    )
    .option(
      "--qianji-control-recovery-backoff-ms <ms>",
      "Backoff milliseconds recorded for --qianji-control-apply-recovery",
      (value) => parseNonNegativeInt(value, "--qianji-control-recovery-backoff-ms"),
    )
    .option(
      "--qianji-control-recovery-require-human-approval",
      "Mark the recovery apply request as requiring human approval",
    )
    .option(
      "--qianji-control-recovery-priority <n>",
      "Priority recorded for --qianji-control-apply-recovery",
      (value) => parseIntegerOption(value, "--qianji-control-recovery-priority"),
    ) as T;
}

export function resolveQianjiControlRecoveryPolicy(
  options: QianjiControlRecoveryCliOptions,
  reject: (message: string) => never,
): QianjiControlRecoveryApplyPolicy | undefined {
  const policy: QianjiControlRecoveryApplyPolicy = {
    ...(options.qianjiControlRecoveryAttempt !== undefined
      ? { attempt: options.qianjiControlRecoveryAttempt }
      : {}),
    ...(options.qianjiControlRecoveryReason !== undefined
      ? { reason: options.qianjiControlRecoveryReason }
      : {}),
    ...(options.qianjiControlRecoveryMaxAttempts !== undefined
      ? { maxAttempts: options.qianjiControlRecoveryMaxAttempts }
      : {}),
    ...(options.qianjiControlRecoveryBackoffMs !== undefined
      ? { backoffMs: options.qianjiControlRecoveryBackoffMs }
      : {}),
    ...(options.qianjiControlRecoveryRequireHumanApproval !== undefined
      ? { requireHumanApproval: options.qianjiControlRecoveryRequireHumanApproval }
      : {}),
    ...(options.qianjiControlRecoveryPriority !== undefined
      ? { priority: options.qianjiControlRecoveryPriority }
      : {}),
  };
  if (Object.keys(policy).length === 0) return undefined;
  if (!options.qianjiControlApplyRecovery) {
    reject("qianji control recovery policy options require --qianji-control-apply-recovery");
  }
  return policy;
}
