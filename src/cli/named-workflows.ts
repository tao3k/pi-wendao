import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Model } from "@mariozechner/pi-ai";
import { compileSkill, defaultCompileTraceDir, type CompileResult } from "../compiler/compiler.js";
import { resolvePiWendaoNamedWorkflowSeedPath } from "../pi-resources.js";
import type { DmnPath, SourcePath, WorkflowPath } from "../types/domain.js";

export type PiWendaoNamedWorkflow = "brainstorm";

export interface ResolvedNamedWorkflow {
  kind: "cached" | "compiled" | "seeded";
  name: PiWendaoNamedWorkflow;
  sourcePath: SourcePath;
  workflowPath: WorkflowPath;
  dmnPath?: DmnPath;
}

export interface NamedWorkflowCompilerContext {
  apiKey?: string;
  headers?: Record<string, string>;
  model: Model<string>;
}

export type NamedWorkflowCompiler = (options: {
  context: NamedWorkflowCompilerContext;
  cwd: string;
  qianjiCommand?: string;
  skillContent: string;
  sourcePath: string;
}) => Promise<CompileResult>;

export interface EnsureNamedWorkflowOptions {
  compiler?: NamedWorkflowCompiler;
  cwd: string;
  getCompilerContext: () => Promise<NamedWorkflowCompilerContext>;
  name: PiWendaoNamedWorkflow;
  onMessage?: (message: string) => void;
  qianjiCommand?: string;
  seedPath?: string;
  sourcePath?: string;
}

const NAMED_WORKFLOW_SOURCES: Record<PiWendaoNamedWorkflow, string> = {
  brainstorm: join(homedir(), ".agents", "skills", "brainstorming", "SKILL.md"),
};

export function parseNamedWorkflowName(value: string): PiWendaoNamedWorkflow | undefined {
  return value === "brainstorm" ? "brainstorm" : undefined;
}

export function isBrainstormTypo(value: string): boolean {
  return value === "brainstrom";
}

export function namedWorkflowCachePath(cwd: string, name: PiWendaoNamedWorkflow): string {
  return join(namedWorkflowCacheRoot(cwd), `${name}.bpmn`);
}

export function namedWorkflowCacheRoot(cwd: string): string {
  const cacheHome = process.env.PRJ_CACHE_HOME?.trim();
  return join(cacheHome || join(cwd, ".cache"), "pi-wendao", "named-workflows");
}

export function namedWorkflowSourcePath(name: PiWendaoNamedWorkflow): string {
  return NAMED_WORKFLOW_SOURCES[name];
}

export function namedWorkflowSeedPath(name: PiWendaoNamedWorkflow): string {
  return resolvePiWendaoNamedWorkflowSeedPath(name);
}

export async function ensureNamedWorkflow(
  options: EnsureNamedWorkflowOptions,
): Promise<ResolvedNamedWorkflow> {
  return ensureNamedWorkflowInternal(options);
}

async function ensureNamedWorkflowInternal(
  options: EnsureNamedWorkflowOptions,
): Promise<ResolvedNamedWorkflow> {
  const sourcePath = options.sourcePath ?? namedWorkflowSourcePath(options.name);
  const seedPath = options.seedPath ?? namedWorkflowSeedPath(options.name);
  const workflowPath = namedWorkflowCachePath(options.cwd, options.name);
  const dmnPath = replaceExtension(workflowPath, ".dmn");
  const sourceStat = await stat(sourcePath).catch(() => undefined);
  if (!sourceStat) {
    throw new Error(`Named workflow '${options.name}' source is missing: ${sourcePath}`);
  }
  const seedStat = await stat(seedPath).catch(() => undefined);

  const cacheStat = await stat(workflowPath).catch(() => undefined);
  const freshnessMtimeMs = Math.max(sourceStat.mtimeMs, seedStat?.mtimeMs ?? 0);
  if (cacheStat && cacheStat.mtimeMs >= freshnessMtimeMs) {
    options.onMessage?.(`named workflow cache hit: ${workflowPath}`);
    return { kind: "cached", name: options.name, sourcePath, workflowPath };
  }

  if (!options.compiler && seedStat) {
    options.onMessage?.(
      `refreshing named workflow '${options.name}' from canonical seed ${seedPath}`,
    );
    const seedContent = await readFile(seedPath, "utf-8");
    await mkdir(dirname(workflowPath), { recursive: true });
    await writeFile(workflowPath, seedContent, "utf-8");
    options.onMessage?.(`seeded named workflow '${options.name}' to ${workflowPath}`);
    return {
      kind: "seeded",
      name: options.name,
      sourcePath,
      workflowPath,
    };
  }

  options.onMessage?.(`compiling named workflow '${options.name}' from ${sourcePath}`);
  const skillContent = await readFile(sourcePath, "utf-8");
  const context = await options.getCompilerContext();
  const compiler = options.compiler ?? compileNamedWorkflow;
  const result = await compiler({
    context,
    cwd: options.cwd,
    qianjiCommand: options.qianjiCommand,
    skillContent,
    sourcePath,
  });
  if (!result.success || !result.bpmnXml) {
    const errors = result.errors?.map((error) => `  - ${error}`).join("\n");
    throw new Error(
      `Named workflow '${options.name}' compilation failed${errors ? `:\n${errors}` : ""}`,
    );
  }

  await mkdir(dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, result.bpmnXml, "utf-8");
  if (result.dmnXml) {
    await writeFile(dmnPath, result.dmnXml, "utf-8");
  }
  options.onMessage?.(`compiled named workflow '${options.name}' to ${workflowPath}`);
  return {
    kind: "compiled",
    name: options.name,
    sourcePath,
    workflowPath,
    ...(result.dmnXml ? { dmnPath } : {}),
  };
}

async function compileNamedWorkflow(options: {
  context: NamedWorkflowCompilerContext;
  cwd: string;
  qianjiCommand?: string;
  skillContent: string;
}): Promise<CompileResult> {
  return compileSkill({
    skillContent: options.skillContent,
    model: options.context.model,
    apiKey: options.context.apiKey,
    headers: options.context.headers,
    cwd: options.cwd,
    template: {
      command: options.qianjiCommand,
    },
    target: {},
    lint: {
      command: options.qianjiCommand,
      maxRepairAttempts: 2,
      traceDir: defaultCompileTraceDir(options.cwd),
    },
  });
}

function replaceExtension(path: string, extension: string): string {
  const index = path.lastIndexOf(".");
  return index > -1 ? `${path.slice(0, index)}${extension}` : `${path}${extension}`;
}
