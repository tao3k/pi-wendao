import type { Model } from "@mariozechner/pi-ai";
import type { CompileArtifactTarget, CompileTargetDecision } from "./prompt.js";
import type { CompileTemplateOptions } from "./qianji-template.js";

export interface CompileOptions {
  /** Raw markdown content of the skill file */
  skillContent: string;
  /** Large model to use for compilation */
  model: Model<string>;
  /** API key for the model provider */
  apiKey?: string;
  /** Provider-specific request headers resolved from pi model/auth config */
  headers?: Record<string, string>;
  /** qianji template integration. Defaults to QIANJI_CLI or qianji on PATH. */
  template?: CompileTemplateOptions;
  /** LLM target decision integration. Defaults to automatic BPMN vs BPMN+DMN selection. */
  target?: CompileTargetOptions;
  /** qianji lint integration. Pass false to disable. */
  lint?: false | CompileLintOptions;
  /** Working directory for qianji template and lint. */
  cwd?: string;
}

export interface CompileTargetOptions {
  /** Test hook or custom target decision runner. */
  runner?: CompileTargetRunner;
  /** Progress callback for target selection status. */
  onMessage?: (message: string) => void;
}

export interface CompileTargetRunnerContext {
  model: Model<string>;
  apiKey?: string;
  headers?: Record<string, string>;
}

export type CompileTargetRunner = (
  skillContent: string,
  context: CompileTargetRunnerContext,
) => Promise<CompileTargetDecision>;

export interface CompileArtifact {
  kind: "bpmn" | "dmn";
  content: string;
}

export interface CompileResult {
  success: boolean;
  bpmnXml?: string;
  dmnXml?: string;
  artifacts?: CompileArtifact[];
  targetDecision?: CompileTargetDecision;
  errors?: string[];
}

export interface CompileLintOptions {
  /** Qianji CLI command. Defaults to QIANJI_CLI or qianji on PATH. */
  command?: string;
  /** Number of model repair attempts after the initial lint failure. Defaults to 2. */
  maxRepairAttempts?: number;
  /** Test hook or custom lint runner. */
  runner?: BpmnLintRunner;
  /** Test hook or custom DMN lint runner. Defaults to qianji lint --dmn. */
  dmnRunner?: BpmnLintRunner;
  /** Progress callback for lint/repair status. */
  onMessage?: (message: string) => void;
  /** Directory where per-attempt repair traces are written. Disabled when false or omitted. */
  traceDir?: string | false;
}

export interface BpmnLintResult {
  success: boolean;
  output: string;
  qianji?: QianjiLintJsonReport;
  diagnostics?: CompileLintDiagnostics;
}

export type BpmnLintRunner = (xml: string) => Promise<BpmnLintResult>;

export interface CompileLintDiagnostics {
  qianji?: string;
  contract?: string;
  dmn?: string;
}

export interface QianjiLintJsonReport {
  analysis?: {
    gateway_conditions?: QianjiGatewayCondition[];
  };
}

export interface QianjiGatewayCondition {
  source_ref?: string;
  target_ref?: string;
  raw?: string;
  parsed?: QianjiGatewayConditionParsed | null;
}

export type QianjiGatewayConditionParsed =
  | { kind?: "boolean_path"; path?: string }
  | { kind?: "numeric_comparison"; lhs?: string };

export interface CompileArtifactBundle {
  bpmnXml: string;
  dmnXml?: string;
  artifacts: CompileArtifact[];
}

export interface CompileArtifactLintRunners {
  bpmn: BpmnLintRunner;
  dmn?: BpmnLintRunner;
}

export type { CompileArtifactTarget, CompileTargetDecision };
