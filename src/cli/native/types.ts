import type { PiWendaoThinkingLevel } from "../../executor/agent-runtime-types.js";
import type { PiWendaoNamedWorkflow } from "../named-workflows.js";
import type { PiWendaoWorkflowOptions } from "../workflow-runner.js";

export interface PiWendaoNativeExtensionOptions {
  modelPattern: string;
  provider?: string;
  apiKey?: string;
  thinkingLevel: PiWendaoThinkingLevel;
  invocationCwd: string;
  piContextCwd: string;
  resolvedExtensionPaths: string[];
  baseWorkflowOptions: PiWendaoWorkflowOptions;
  resolvedDmnPaths: string[];
  resolvedHostFixturePath?: string;
  resolvedEventFixturePath?: string;
}

export interface PiWendaoWorkflowMessageDetails {
  kind: "status" | "event" | "agent" | "prompt" | "show" | "error" | "run";
  id?: string;
  workflowPath?: string;
  lines: string[];
  success?: boolean;
  status?: "running" | "completed" | "failed" | "interrupted";
  eventCount?: number;
  agentCount?: number;
  errorCount?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface NativeRunCommand {
  workflowPath: string;
  namedWorkflow?: PiWendaoNamedWorkflow;
  process?: string;
  instanceId?: string;
  startAtNode?: string;
  qianji?: string;
  dmnPaths: string[];
  hostFixturePath?: string;
  eventFixturePath?: string;
  contextJson?: string;
  traceFrameMs?: number;
  variables: string[];
  graph: boolean;
}

export interface NativeShowCommand {
  instanceId?: string;
  workflowPath?: string;
  dmnPaths: string[];
}
