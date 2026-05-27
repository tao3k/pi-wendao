import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Effect } from "effect";
import {
  buildPiWendaoConfigMap,
  hasHostCompletionResults,
  type HostCompletionFixture,
} from "./bpmn-config.js";
import {
  humanTaskReplyOutputNames,
  mapHumanTaskReplyToOutputs,
  mergeQianjiHostWorkFormConfig,
  resolveHumanTaskConfig,
  validateOutputSchemas,
} from "./human-task.js";
import { throwIfWorkflowInterrupted } from "./interrupt.js";
import { createPiAiHost } from "./node-runner.js";
import {
  buildQianjiHostSessionArgs,
  buildQianjiHostSessionTaskCompleteRequest,
  QianjiHostSession,
} from "./qianji-cli.js";
import type { QianjiCliResult, QianjiHostWork, QianjiTraceEvent } from "./qianji-types.js";
import type { ActivityId, ProcessId, TokenId } from "../types/domain.js";
import { WorkflowStallGuard } from "./stall-guard.js";
import type { ExecuteOptions, HumanTaskPromptRequest } from "./executor.js";
import type {
  PiWendaoAgentExecutionMetadata,
  PiWendaoAgentHost,
  PiWendaoConfig,
  PiWendaoHostWorkKind,
  PiWendaoQianjiCheckpointFeedback,
} from "./agent-host.js";
import {
  appendCliResult,
  applyQianjiHostWorkGraph,
  createMissingAgentHost,
  emitQianjiHostWorkEvents,
  hostWorkActivityId,
  hostWorkProcessId,
  isHumanHostWorkKind,
  resultCheckpointFeedback,
  resultOutcome,
  resultVariables,
  updatePendingActivities,
} from "./executor-runtime-state.js";
import { effectFromPromise, runPiWendaoEffect, type PiWendaoEffectError } from "../effect.js";

export interface HostCompletionResult {
  kind: PiWendaoHostWorkKind;
  processId: ProcessId;
  nodeId: ActivityId;
  tokenId: TokenId;
  claimant?: string;
  data: Record<string, unknown>;
}

export function runQianjiExternalHostLoop(options: {
  command: string;
  sourcePath: string;
  processId: string;
  instanceId: string;
  context: Record<string, unknown>;
  dmnPaths: string[];
  eventFixturePath?: string;
  cwd: string;
  source: string;
  startAtNode?: string;
  options: ExecuteOptions;
  qianjiEnvironment?: NodeJS.ProcessEnv;
  completionFixture?: HostCompletionFixture;
  onTraceEvent: (event: QianjiTraceEvent) => void | Promise<void>;
  tempDirs: string[];
}): Effect.Effect<QianjiCliResult, PiWendaoEffectError> {
  return effectFromPromise("runQianjiExternalHostLoop", () =>
    runQianjiExternalHostLoopInternal(options),
  );
}

async function runQianjiExternalHostLoopInternal(options: {
  command: string;
  sourcePath: string;
  processId: string;
  instanceId: string;
  context: Record<string, unknown>;
  dmnPaths: string[];
  eventFixturePath?: string;
  cwd: string;
  source: string;
  startAtNode?: string;
  options: ExecuteOptions;
  qianjiEnvironment?: NodeJS.ProcessEnv;
  completionFixture?: HostCompletionFixture;
  onTraceEvent: (event: QianjiTraceEvent) => void | Promise<void>;
  tempDirs: string[];
}): Promise<QianjiCliResult> {
  const piWendaoConfigs = buildPiWendaoConfigMap(options.source, options.processId);
  const agentHost =
    options.options.agentHost ??
    (options.options.model
      ? createPiAiHost({
          model: options.options.model,
          apiKey: options.options.apiKey,
          cwd: options.cwd,
          extraTools: options.options.agentTools,
          onEvent: options.options.onAgentEvent,
          thinkingLevel: options.options.thinkingLevel,
          signal: options.options.signal,
        })
      : createMissingAgentHost());
  const pendingActivities = new Set<string>();
  const aggregate: QianjiCliResult = {
    exitCode: 0,
    stdout: "",
    stderr: "",
    streamedTrace: false,
    hostWork: [],
  };
  const continuationFixture = buildNonHumanCompletionFixture(
    options.completionFixture,
    piWendaoConfigs,
  );
  const continuationFixturePath = continuationFixture
    ? await writeHostCompletionFixture(continuationFixture).then((fixture) => {
        options.tempDirs.push(fixture.dir);
        return fixture.path;
      })
    : undefined;
  const stallGuard = new WorkflowStallGuard();
  const onTraceEvent = async (event: QianjiTraceEvent) => {
    updatePendingActivities(pendingActivities, event);
    await options.onTraceEvent(event);
  };

  let session: QianjiHostSession | undefined;
  try {
    session = new QianjiHostSession(
      options.command,
      buildQianjiHostSessionArgs({
        sourcePath: options.sourcePath,
        processId: options.processId,
        instanceId: options.instanceId,
        context: options.context,
        dmnPaths: options.dmnPaths,
        hostFixturePath: continuationFixturePath,
        eventFixturePath: options.eventFixturePath,
        traceStream: true,
        startAtNode: options.startAtNode,
      }),
      options.cwd,
      onTraceEvent,
      options.options.signal,
      options.qianjiEnvironment,
    );
    let latest = await session.initial;
    appendCliResult(aggregate, latest);

    let guard = 0;
    while (latest.exitCode === 0 && resultOutcome(latest) === "blocked_on_host") {
      throwIfWorkflowInterrupted(options.options.signal);
      guard += 1;
      if (guard > 100) {
        throw new Error("qianji external host loop exceeded 100 host-boundary iterations");
      }
      const checkpoint = resultCheckpointFeedback(latest, latest.hostWork.length);
      stallGuard.inspectPendingHostWork({
        hostWork: latest.hostWork,
        piWendaoConfigs,
        variables: options.context,
      });
      emitQianjiHostWorkEvents(latest.hostWork, options.options);
      applyQianjiHostWorkGraph({
        hostWork: latest.hostWork,
        piWendaoConfigs,
        checkpoint,
        options: options.options,
      });
      const hostCompletions = await runPiWendaoEffect(
        runPendingHostWork({
          agentHost,
          humanTaskHandler: options.options.humanTaskHandler,
          piWendaoConfigs,
          pendingHostWork: latest.hostWork,
          variables: options.context,
          processId: options.processId,
          instanceId: options.instanceId,
          checkpoint,
          completionFixture: options.completionFixture,
          signal: options.options.signal,
        }),
      );
      if (!hostCompletions || hostCompletions.length === 0) {
        throw new Error("qianji stopped on host work but did not stream an active BPMN activity");
      }
      for (const [completionIndex, completion] of hostCompletions.entries()) {
        const completionPayload = {
          tokenId: completion.tokenId,
          processId: completion.processId,
          activityId: completion.nodeId,
          kind: completion.kind,
          data: completion.data,
          ...(completion.claimant ? { claimant: completion.claimant } : {}),
        };
        const continueUntilHumanBoundary = completionIndex === hostCompletions.length - 1;
        latest = await runPiWendaoEffect(
          session.taskComplete(
            buildQianjiHostSessionTaskCompleteRequest({
              completion: completionPayload,
              continueUntilHumanBoundary,
            }),
          ),
        );
        const variables = resultVariables(latest);
        Object.assign(options.context, variables);
        appendCliResult(aggregate, latest);
        if (latest.exitCode !== 0) break;
      }
    }

    aggregate.exitCode = latest.exitCode;
    return aggregate;
  } finally {
    session?.close();
  }
}

export function runPendingHostWork(options: {
  agentHost: PiWendaoAgentHost;
  humanTaskHandler?: (request: HumanTaskPromptRequest) => Promise<string>;
  piWendaoConfigs: Map<string, PiWendaoConfig>;
  pendingHostWork: QianjiHostWork[];
  variables: Record<string, unknown>;
  processId: string;
  instanceId: string;
  checkpoint?: PiWendaoQianjiCheckpointFeedback;
  completionFixture?: HostCompletionFixture;
  signal?: AbortSignal;
}): Effect.Effect<HostCompletionResult[] | undefined, PiWendaoEffectError> {
  return effectFromPromise("runPendingHostWork", () => runPendingHostWorkPromise(options));
}

async function runPendingHostWorkPromise(options: {
  agentHost: PiWendaoAgentHost;
  humanTaskHandler?: (request: HumanTaskPromptRequest) => Promise<string>;
  piWendaoConfigs: Map<string, PiWendaoConfig>;
  pendingHostWork: QianjiHostWork[];
  variables: Record<string, unknown>;
  processId: string;
  instanceId: string;
  checkpoint?: PiWendaoQianjiCheckpointFeedback;
  completionFixture?: HostCompletionFixture;
  signal?: AbortSignal;
}): Promise<HostCompletionResult[] | undefined> {
  throwIfWorkflowInterrupted(options.signal);
  const tokenResults = await Promise.all(
    options.pendingHostWork.map(async (work) => {
      throwIfWorkflowInterrupted(options.signal);
      const tokenVariables = { ...options.variables, ...work.variables };
      const activityId = hostWorkActivityId(work);
      const processId = hostWorkProcessId(work, options.processId);
      const data = await runPiWendaoActivity({
        agentHost: options.agentHost,
        humanTaskHandler: options.humanTaskHandler,
        piWendaoConfigs: options.piWendaoConfigs,
        activityId,
        hostWork: work,
        hostKind: work.kind,
        variables: tokenVariables,
        execution: {
          processId,
          instanceId: options.instanceId,
          nodeIndex: work.node_index,
          tokenId: work.token_id,
          repeat: work.repeat,
          checkpoint: options.checkpoint,
        },
        completionFixture: options.completionFixture,
        signal: options.signal,
      });
      return {
        kind: work.kind,
        processId,
        nodeId: activityId,
        tokenId: work.token_id,
        ...(work.claim?.claimant ? { claimant: work.claim.claimant } : {}),
        data,
      };
    }),
  );
  for (const result of tokenResults) {
    Object.assign(options.variables, result.data);
  }
  return tokenResults.length > 0 ? tokenResults : undefined;
}

async function writeHostCompletionFixture(
  fixture: HostCompletionFixture,
): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-wendao-qianji-host-"));
  const path = join(dir, "host-fixture.json");
  await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`, "utf-8");
  return { dir, path };
}

function buildNonHumanCompletionFixture(
  fixture: HostCompletionFixture | undefined,
  piWendaoConfigs: Map<string, PiWendaoConfig>,
): HostCompletionFixture | undefined {
  if (!fixture) return undefined;
  const nonHumanFixture: HostCompletionFixture = {};
  if (fixture.send_tasks) {
    nonHumanFixture.send_tasks = validateStaticFixtureBucket(fixture.send_tasks, piWendaoConfigs);
  }
  if (fixture.service_tasks) {
    nonHumanFixture.service_tasks = validateStaticFixtureBucket(
      fixture.service_tasks,
      piWendaoConfigs,
    );
  }
  if (fixture.service_task_tokens)
    nonHumanFixture.service_task_tokens = fixture.service_task_tokens;
  if (fixture.business_rule_tasks)
    nonHumanFixture.business_rule_tasks = fixture.business_rule_tasks;
  return hasHostCompletionResults(nonHumanFixture) ? nonHumanFixture : undefined;
}

function validateStaticFixtureBucket(
  bucket: Record<string, { data: Record<string, unknown> }>,
  piWendaoConfigs: Map<string, PiWendaoConfig>,
): Record<string, { data: Record<string, unknown> }> {
  const validated: Record<string, { data: Record<string, unknown> }> = {};
  for (const [activityId, entry] of Object.entries(bucket)) {
    const config = piWendaoConfigs.get(activityId);
    validated[activityId] = {
      data: config ? validateOutputSchemas(config, entry.data, { activityId }) : entry.data,
    };
  }
  return validated;
}

async function runPiWendaoActivity(options: {
  agentHost: PiWendaoAgentHost;
  humanTaskHandler?: (request: HumanTaskPromptRequest) => Promise<string>;
  piWendaoConfigs: Map<string, PiWendaoConfig>;
  activityId: string;
  hostWork?: QianjiHostWork;
  hostKind?: PiWendaoHostWorkKind;
  variables: Record<string, unknown>;
  execution: PiWendaoAgentExecutionMetadata;
  completionFixture?: HostCompletionFixture;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  throwIfWorkflowInterrupted(options.signal);
  const config = options.piWendaoConfigs.get(options.activityId) ?? {
    prompt: "",
    tools: [],
    inputs: [],
    outputs: [],
  };
  const effectiveConfig = options.hostWork
    ? mergeQianjiHostWorkFormConfig(config, options.hostWork)
    : config;
  const hostKind = options.hostKind ?? config.hostKind;
  if (isHumanHostWorkKind(hostKind)) {
    if (!options.humanTaskHandler) {
      const element = hostKind === "manual" ? "manualTask" : "userTask";
      throw new Error(`BPMN ${element} '${options.activityId}' requires a human task handler`);
    }
    const resolvedConfig = resolveHumanTaskConfig(effectiveConfig, options.variables, {
      activityId: options.activityId,
    });
    const reply = await options.humanTaskHandler({
      activityId: options.activityId,
      config: resolvedConfig,
      variables: options.variables,
      ...(options.hostWork?.assignment ? { assignment: options.hostWork.assignment } : {}),
      ...(options.hostWork?.claim ? { claim: options.hostWork.claim } : {}),
      execution: {
        ...options.execution,
        activityId: options.activityId,
      },
    });
    throwIfWorkflowInterrupted(options.signal);
    const output = mapHumanTaskReplyToOutputs(
      reply,
      humanTaskReplyOutputNames(effectiveConfig, { activityId: options.activityId }),
    );
    Object.assign(options.variables, output);
    return output;
  }
  const fixtureOutput = resolveFixtureCompletion({
    fixture: options.completionFixture,
    hostKind: options.hostKind ?? config.hostKind ?? "service",
    activityId: options.activityId,
    tokenId: options.execution.tokenId,
  });
  if (fixtureOutput) {
    const validatedOutput = validateOutputSchemas(config, fixtureOutput, {
      activityId: options.activityId,
    });
    Object.assign(options.variables, validatedOutput);
    return validatedOutput;
  }
  const output = await options.agentHost.run({
    activityId: options.activityId,
    config: effectiveConfig,
    variables: options.variables,
    signal: options.signal,
    execution: {
      ...options.execution,
      activityId: options.activityId,
    },
  });
  throwIfWorkflowInterrupted(options.signal);
  const validatedOutput = validateOutputSchemas(effectiveConfig, output, {
    activityId: options.activityId,
  });
  Object.assign(options.variables, validatedOutput);
  return validatedOutput;
}

function resolveFixtureCompletion(options: {
  fixture?: HostCompletionFixture;
  hostKind: PiWendaoHostWorkKind;
  activityId: string;
  tokenId?: number;
}): Record<string, unknown> | undefined {
  if (!options.fixture || isHumanHostWorkKind(options.hostKind)) return undefined;
  const tokenData =
    options.tokenId !== undefined
      ? options.fixture.service_task_tokens?.[String(options.tokenId)]?.data
      : undefined;
  if (tokenData) return tokenData;
  switch (options.hostKind) {
    case "send":
      return options.fixture.send_tasks?.[options.activityId]?.data;
    case "script":
    case "business_rule":
    case "service":
      return options.fixture.service_tasks?.[options.activityId]?.data;
  }
}
