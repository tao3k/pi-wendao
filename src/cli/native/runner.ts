import { readFileSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { ensureNamedWorkflow } from "../named-workflows.js";
import {
  appendActiveBpmnNodeLabels,
  resolveQianjiCommand,
  runQianjiShow,
  runWorkflowInRenderer,
  type PiWendaoWorkflowOptions,
} from "../workflow-runner.js";
import { resolveNativeRunModel, type ResolvedModel } from "./model.js";
import { PiWendaoNativeWorkflowRenderer } from "./renderer.js";
import { sendWorkflowMessage } from "./messages.js";
import type {
  NativeRunCommand,
  NativeShowCommand,
  PiWendaoNativeExtensionOptions,
} from "./types.js";
import { normalizeThinkingLevel } from "./text.js";

export async function runNativeWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  options: PiWendaoNativeExtensionOptions,
  command: NativeRunCommand,
  signal?: AbortSignal,
): Promise<void> {
  let resolvedModel: ResolvedModel | undefined;
  const resolveRunModel = async (): Promise<ResolvedModel> => {
    resolvedModel ??= await resolveNativeRunModel(ctx, options);
    return resolvedModel;
  };
  const namedWorkflow = command.namedWorkflow
    ? await ensureNamedWorkflow({
        name: command.namedWorkflow,
        cwd: options.invocationCwd,
        qianjiCommand: command.qianji ?? options.baseWorkflowOptions.qianji,
        getCompilerContext: async () => {
          const model = await resolveRunModel();
          return {
            model: model.model,
            apiKey: model.apiKey,
            headers: model.headers,
          };
        },
        onMessage: (message) =>
          sendWorkflowMessage(pi, {
            kind: "status",
            lines: [message],
          }),
      })
    : undefined;
  const resolvedWorkflowPath =
    namedWorkflow?.workflowPath ?? resolvePath(options.invocationCwd, command.workflowPath);
  const resolvedDmnPaths = [
    ...options.resolvedDmnPaths,
    ...(namedWorkflow?.dmnPath ? [namedWorkflow.dmnPath] : []),
    ...command.dmnPaths.map((path) => resolvePath(options.invocationCwd, path)),
  ];
  const resolvedHostFixturePath = command.hostFixturePath
    ? resolvePath(options.invocationCwd, command.hostFixturePath)
    : options.resolvedHostFixturePath;
  const resolvedEventFixturePath = command.eventFixturePath
    ? resolvePath(options.invocationCwd, command.eventFixturePath)
    : options.resolvedEventFixturePath;
  const workflowOptions: PiWendaoWorkflowOptions = {
    process: command.process ?? options.baseWorkflowOptions.process,
    instanceId: command.instanceId ?? options.baseWorkflowOptions.instanceId,
    startAtNode: command.startAtNode ?? options.baseWorkflowOptions.startAtNode,
    qianji: command.qianji ?? options.baseWorkflowOptions.qianji,
    contextJson: command.contextJson ?? options.baseWorkflowOptions.contextJson,
    traceFrameMs: command.traceFrameMs ?? options.baseWorkflowOptions.traceFrameMs,
    var: [...(options.baseWorkflowOptions.var ?? []), ...command.variables],
  };
  const executionModel = resolvedHostFixturePath ? undefined : await resolveRunModel();
  const renderer = new PiWendaoNativeWorkflowRenderer(pi, ctx, resolvedWorkflowPath, command.graph);
  pi.setSessionName(`pi-wendao ${basename(resolvedWorkflowPath)}`);
  renderer.start();
  let result: Awaited<ReturnType<typeof runWorkflowInRenderer>>;
  try {
    result = await runWorkflowInRenderer({
      renderer,
      useGraph: command.graph,
      resolvedWorkflowPath,
      options: workflowOptions,
      instanceId: workflowOptions.instanceId,
      invocationCwd: options.invocationCwd,
      piContextCwd: options.piContextCwd,
      resolvedDmnPaths,
      resolvedHostFixturePath,
      resolvedEventFixturePath,
      resolvedModel: executionModel,
      thinkingLevel: normalizeThinkingLevel(pi.getThinkingLevel(), options.thinkingLevel),
      signal,
    });
  } catch (error) {
    renderer.finish(false);
    throw error;
  }
  renderer.finish(result.interrupted ? "interrupted" : result.success);
  sendWorkflowMessage(pi, {
    kind: "status",
    workflowPath: resolvedWorkflowPath,
    lines: [
      result.interrupted
        ? "Workflow interrupted. Qianji checkpoint state was preserved."
        : result.success
          ? "Workflow completed successfully."
          : "Workflow failed.",
    ],
    ...(result.interrupted ? {} : { success: result.success }),
  });
}

export async function showNativeWorkflowStatus(
  pi: ExtensionAPI,
  options: PiWendaoNativeExtensionOptions,
  command: NativeShowCommand,
): Promise<void> {
  const workflowPath = command.workflowPath
    ? resolvePath(options.invocationCwd, command.workflowPath)
    : undefined;
  const dmnPaths = [
    ...options.resolvedDmnPaths,
    ...command.dmnPaths.map((path) => resolvePath(options.invocationCwd, path)),
  ];
  const output = await runQianjiShow({
    command: resolveQianjiCommand(options.baseWorkflowOptions.qianji),
    instanceId: command.instanceId,
    workflowPath,
    dmnPaths,
    cwd: options.invocationCwd,
  });
  let stdout = output.stdout;
  if (output.exitCode === 0 && command.instanceId && workflowPath) {
    stdout = appendActiveBpmnNodeLabels(
      stdout,
      readFileSync(workflowPath, "utf-8"),
      options.baseWorkflowOptions.process,
    );
  }
  const lines = [
    ...stdout.trimEnd().split(/\r?\n/).filter(Boolean),
    ...output.stderr
      .trimEnd()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => `stderr: ${line}`),
  ];
  sendWorkflowMessage(pi, {
    kind: output.exitCode === 0 ? "show" : "error",
    workflowPath,
    lines: lines.length > 0 ? lines : ["No qianji instance output."],
    success: output.exitCode === 0,
  });
}
