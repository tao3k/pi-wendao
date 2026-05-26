import { readFileSync } from "node:fs";
import { resolveQianjiCommand } from "./preflight.js";
import {
  appendActiveBpmnNodeLabels,
  runQianjiServerCancel,
  runQianjiServerShow,
  runQianjiShow,
} from "./qianji-show.js";
import { resolveQianjiWorkflowServerUrl } from "./server-url.js";
import type {
  DmnPath,
  InstanceId,
  ProcessId,
  QianjiCommand,
  WorkflowPath,
} from "../../types/domain.js";

export interface QianjiWorkflowControlOptions {
  show?: boolean;
  cancel?: boolean;
  qianji?: QianjiCommand;
  instanceId?: InstanceId;
  workflowPath?: WorkflowPath;
  processId?: ProcessId;
  dmnPaths: DmnPath[];
  cwd: string;
}

export type QianjiWorkflowControlResult =
  | {
      handled: true;
      exitCode: number;
      stdout: string;
      stderr: string;
    }
  | { handled: false };

export async function runQianjiWorkflowControlCommand(
  options: QianjiWorkflowControlOptions,
): Promise<QianjiWorkflowControlResult> {
  if (!options.show && !options.cancel) return { handled: false };
  if (options.show && options.cancel) {
    throw new Error("--show and --cancel cannot be combined");
  }
  return options.cancel
    ? runQianjiWorkflowCancel(options)
    : runQianjiWorkflowShow(options);
}

async function runQianjiWorkflowCancel(
  options: QianjiWorkflowControlOptions,
): Promise<QianjiWorkflowControlResult> {
  if (!options.instanceId) throw new Error("--cancel requires --instance-id");
  const serverUrl = resolveQianjiWorkflowServerUrl(undefined);
  if (!serverUrl) {
    throw new Error("--cancel requires PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL");
  }
  if (!options.workflowPath) {
    throw new Error("--cancel requires a workflow path or --flowhub-scenario");
  }
  const output = await runQianjiServerCancel({
    serverUrl,
    instanceId: options.instanceId,
    workflowPath: options.workflowPath,
    dmnPaths: options.dmnPaths,
  });
  return {
    handled: true,
    exitCode: output.exitCode ?? 1,
    stdout: withActiveNodeLabels(output.stdout, output.exitCode, options),
    stderr: output.stderr,
  };
}

async function runQianjiWorkflowShow(
  options: QianjiWorkflowControlOptions,
): Promise<QianjiWorkflowControlResult> {
  const serverUrl = options.instanceId
    ? resolveQianjiWorkflowServerUrl(undefined)
    : undefined;
  const output = serverUrl && options.instanceId
    ? await runQianjiServerShow({
        serverUrl,
        instanceId: options.instanceId,
      })
    : await runQianjiShow({
        command: resolveQianjiCommand(options.qianji),
        instanceId: options.instanceId,
        workflowPath: options.workflowPath,
        dmnPaths: options.dmnPaths,
        cwd: options.cwd,
      });
  return {
    handled: true,
    exitCode: output.exitCode ?? 1,
    stdout: withActiveNodeLabels(output.stdout, output.exitCode, options),
    stderr: output.stderr,
  };
}

function withActiveNodeLabels(
  stdout: string,
  exitCode: number | null,
  options: QianjiWorkflowControlOptions,
): string {
  if (exitCode !== 0 || !options.instanceId || !options.workflowPath) {
    return stdout;
  }
  return appendActiveBpmnNodeLabels(
    stdout,
    readFileSync(options.workflowPath, "utf-8"),
    options.processId,
  );
}
