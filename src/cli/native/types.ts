import type { PiWendaoThinkingLevel } from "../../executor/agent-runtime-types.js";
import type {
  ApiKey,
  DmnPath,
  EventFixturePath,
  HostFixturePath,
  InstanceId,
  TraceFrameDelayMs,
  WorkflowPath,
} from "../../types/domain.js";
import type { PiWendaoNamedWorkflow } from "../named-workflows.js";
import type { ServerlessMemoryRecallPacket } from "../serverless-memory/index.js";
import type { PiWendaoWorkflowOptions } from "../workflow-runner.js";

export interface PiWendaoNativeExtensionOptions {
  modelPattern: string;
  provider?: string;
  apiKey?: ApiKey;
  thinkingLevel: PiWendaoThinkingLevel;
  invocationCwd: string;
  piContextCwd: string;
  resolvedExtensionPaths: string[];
  baseWorkflowOptions: PiWendaoWorkflowOptions;
  resolvedDmnPaths: DmnPath[];
  resolvedHostFixturePath?: HostFixturePath;
  resolvedEventFixturePath?: EventFixturePath;
  serverlessMemoryRecallPacket?: ServerlessMemoryRecallPacket;
}

export interface PiWendaoWorkflowMessageDetails {
  kind: "status" | "event" | "agent" | "prompt" | "show" | "error" | "run";
  id?: string;
  workflowPath?: string;
  lines: string[];
  success?: boolean;
  status?: "running" | "completed" | "failed" | "interrupted";
  streamDetails?: "visible" | "summary";
  eventCount?: number;
  agentCount?: number;
  errorCount?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface NativeRunCommand {
  workflowPath: WorkflowPath;
  namedWorkflow?: PiWendaoNamedWorkflow;
  process?: string;
  instanceId?: InstanceId;
  startAtNode?: string;
  qianji?: string;
  dmnPaths: DmnPath[];
  hostFixturePath?: HostFixturePath;
  eventFixturePath?: EventFixturePath;
  contextJson?: string;
  traceFrameMs?: TraceFrameDelayMs;
  variables: string[];
  graph: boolean;
}

export interface NativeShowCommand {
  instanceId?: InstanceId;
  workflowPath?: WorkflowPath;
  dmnPaths: DmnPath[];
}
