import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolvePiWendaoPackageRoot } from "../pi-resources.js";
import { qianjiWorkflowCatalogTable, type QianjiWorkflowCatalogRowDto } from "./schema.js";
import type { FlowhubScenarioRegistry } from "../cli/flowhub-scenario/types.js";

export interface FixtureQianjiWorkflowCatalogOptions {
  readonly refresh?: boolean;
}

export interface FlowhubQianjiWorkflowCatalogOptions {
  readonly flowhubRoot?: string;
  readonly readSource?: (path: string) => string | undefined;
}

interface FixtureWorkflowDefinition {
  readonly workflowId: string;
  readonly sourceFile: string;
  readonly description: string;
  readonly category: string;
}

const FIXTURE_WORKFLOWS: readonly FixtureWorkflowDefinition[] = [
  {
    workflowId: "simple-workflow",
    sourceFile: "simple-workflow.bpmn",
    description: "Single service-task smoke workflow for qianji-server admission.",
    category: "smoke",
  },
  {
    workflowId: "simple-skill",
    sourceFile: "simple-skill.bpmn",
    description: "Small subagent workflow that finds and reports TypeScript files.",
    category: "subagent",
  },
  {
    workflowId: "branching-workflow",
    sourceFile: "branching-workflow.bpmn",
    description: "Branching workflow fixture for qianji condition and gateway paths.",
    category: "control-flow",
  },
  {
    workflowId: "complex-skill",
    sourceFile: "complex-skill.bpmn",
    description: "Multi-step subagent skill workflow for richer qianji host-boundary runs.",
    category: "subagent",
  },
  {
    workflowId: "complex-workflow",
    sourceFile: "complex-workflow.bpmn",
    description: "Complex BPMN workflow covering gateways and multiple execution branches.",
    category: "control-flow",
  },
  {
    workflowId: "error-workflow",
    sourceFile: "error-workflow.bpmn",
    description: "Workflow fixture for error and recovery-path validation.",
    category: "recovery",
  },
  {
    workflowId: "human-approval",
    sourceFile: "human-approval.bpmn",
    description: "Human approval workflow fixture for user-task handoff validation.",
    category: "human-task",
  },
  {
    workflowId: "pi-ask-interactions",
    sourceFile: "pi-ask-interactions.bpmn",
    description: "Interaction workflow fixture covering pi-ask choices and prompts.",
    category: "interaction",
  },
];

let cachedFixtureCatalogRows: QianjiWorkflowCatalogRowDto[] | undefined;

export function listFixtureQianjiWorkflowCatalog(
  options: FixtureQianjiWorkflowCatalogOptions = {},
): QianjiWorkflowCatalogRowDto[] {
  if (!options.refresh && cachedFixtureCatalogRows) {
    return [...cachedFixtureCatalogRows];
  }
  cachedFixtureCatalogRows = FIXTURE_WORKFLOWS.map(buildCatalogRow);
  return [...cachedFixtureCatalogRows];
}

export function fixtureQianjiWorkflowCatalogArrowTable(
  options: FixtureQianjiWorkflowCatalogOptions = {},
) {
  return qianjiWorkflowCatalogTable(listFixtureQianjiWorkflowCatalog(options));
}

export function findFixtureQianjiWorkflow(
  workflowId: string,
  options: FixtureQianjiWorkflowCatalogOptions = {},
): QianjiWorkflowCatalogRowDto | undefined {
  return listFixtureQianjiWorkflowCatalog(options).find((row) => row.workflowId === workflowId);
}

export function qianjiWorkflowCatalogRowsFromFlowhubRegistry(
  registry: FlowhubScenarioRegistry,
  options: FlowhubQianjiWorkflowCatalogOptions = {},
): QianjiWorkflowCatalogRowDto[] {
  return registry.sourcePairs.map((pair) => {
    const bpmnPath = resolveFlowhubPath(options.flowhubRoot, pair.bpmnSource);
    const orgPath = resolveFlowhubPath(options.flowhubRoot, pair.orgSource);
    const source = options.readSource?.(bpmnPath);
    const hasBpmndi = source ? /<(?:\w+:)?BPMNDiagram\b/u.test(source) : false;
    return {
      workflowId: pair.scenarioId,
      label: titleFromWorkflowId(pair.scenarioId),
      description: `FlowHub scenario ${pair.scenarioId}`,
      catalogSource: "flowhub",
      sourcePath: bpmnPath,
      orgSourcePath: orgPath,
      processId: pair.bpmnProcessId,
      category: "flowhub",
      qianjiLintRequired: true,
      hasBpmndi,
      bpmnJsRenderable: hasBpmndi,
      taskCount: source ? countMatches(source, /<(?:serviceTask|userTask|manualTask)\b/gu) : 0,
      sourceSha256: pair.bpmnSha256,
      orgSha256: pair.orgSha256,
    };
  });
}

function buildCatalogRow(definition: FixtureWorkflowDefinition): QianjiWorkflowCatalogRowDto {
  const sourcePath = join(packageRoot(), "test", "fixtures", definition.sourceFile);
  const source = readFileSync(sourcePath, "utf-8");
  const processId = firstMatch(source, /<process\b[^>]*\bid="([^"]+)"/u) ?? "Process_1";
  const label =
    firstMatch(source, /<process\b[^>]*\bname="([^"]+)"/u) ??
    titleFromWorkflowId(definition.workflowId);
  const hasBpmndi = /<(?:\w+:)?BPMNDiagram\b/u.test(source);
  return {
    workflowId: definition.workflowId,
    label,
    description: definition.description,
    catalogSource: "fixture",
    sourcePath,
    orgSourcePath: "",
    processId,
    category: definition.category,
    qianjiLintRequired: true,
    hasBpmndi,
    bpmnJsRenderable: hasBpmndi,
    taskCount: countMatches(source, /<(?:serviceTask|userTask|manualTask)\b/gu),
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    orgSha256: "",
  };
}

function resolveFlowhubPath(flowhubRoot: string | undefined, path: string): string {
  if (path.startsWith("/")) return path;
  return flowhubRoot ? resolve(flowhubRoot, path) : path;
}

function packageRoot(): string {
  return resolvePiWendaoPackageRoot();
}

function firstMatch(source: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(source);
  return match?.[1];
}

function countMatches(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function titleFromWorkflowId(workflowId: string): string {
  return workflowId
    .split("-")
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}
