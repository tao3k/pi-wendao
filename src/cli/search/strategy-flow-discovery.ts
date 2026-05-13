import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  SearchStrategyFlowOptions,
  SearchStrategyFlowRustBridgeMode,
} from "./strategy-flow-types.js";

export function resolveWendaoGraphProject(options: SearchStrategyFlowOptions): string {
  const explicit = options.wendaoGraphPath ?? process.env.WENDAO_GRAPH_JL_PATH;
  if (explicit) return requireWendaoGraphProject(resolve(explicit));

  const discovered = findUp(options.cwd, (dir) => {
    const dataPath = join(dir, ".data", "WendaoGraph.jl");
    if (isWendaoGraphProject(dataPath)) return dataPath;
    if (isWendaoGraphProject(dir)) return dir;
    return undefined;
  });
  if (discovered) return discovered;

  throw new Error(
    "could not find WendaoGraph.jl; pass --wendao-graph <path> or set WENDAO_GRAPH_JL_PATH",
  );
}

export function resolveWendaoRustWorkspace(options: SearchStrategyFlowOptions): string | undefined {
  const explicit = options.rustWorkspace ?? process.env.XIUXIAN_ARTISAN_WORKSHOP_ROOT;
  if (explicit) return requireWendaoRustWorkspace(resolve(explicit));

  return findUp(options.cwd, (dir) => {
    if (isWendaoRustWorkspace(dir)) return dir;
    return undefined;
  });
}

export function resolveRustBridgeCommand(
  rustWorkspace: string,
  cargoCommand: string | undefined,
  bridgeBinaryPath: string | undefined,
): { command: string; prefixArgs: string[]; mode: SearchStrategyFlowRustBridgeMode } {
  if (bridgeBinaryPath) {
    return {
      command: requireRustBridgeBinary(resolve(bridgeBinaryPath)),
      prefixArgs: [],
      mode: "direct-binary",
    };
  }
  if (cargoCommand) return { command: cargoCommand, prefixArgs: [], mode: "cargo" };
  if (existsSync(join(rustWorkspace, ".envrc"))) {
    return { command: "direnv", prefixArgs: ["exec", rustWorkspace, "cargo"], mode: "cargo" };
  }
  return { command: "cargo", prefixArgs: [], mode: "cargo" };
}

function requireWendaoGraphProject(path: string): string {
  if (isWendaoGraphProject(path)) return path;
  throw new Error(`not a WendaoGraph.jl project: ${path}`);
}

function isWendaoGraphProject(path: string): boolean {
  const projectPath = join(path, "Project.toml");
  if (!existsSync(projectPath)) return false;
  return readFileSync(projectPath, "utf-8").includes('name = "WendaoGraph"');
}

function requireWendaoRustWorkspace(path: string): string {
  if (isWendaoRustWorkspace(path)) return path;
  throw new Error(`not a xiuxian Rust workspace: ${path}`);
}

function requireRustBridgeBinary(path: string): string {
  try {
    if (statSync(path).isFile()) return path;
  } catch {
    // Fall through to the explicit bridge error below.
  }
  throw new Error(`not a SearchStrategyFlow Rust bridge binary: ${path}`);
}

function isWendaoRustWorkspace(path: string): boolean {
  return (
    existsSync(join(path, "Cargo.toml")) &&
    existsSync(join(path, "packages", "rust", "crates", "xiuxian-wendao-julia", "Cargo.toml"))
  );
}

function findUp(
  start: string,
  resolveCandidate: (dir: string) => string | undefined,
): string | undefined {
  let current = resolve(start);
  for (;;) {
    const found = resolveCandidate(current);
    if (found) return found;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
