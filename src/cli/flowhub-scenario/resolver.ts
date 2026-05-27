import { statSync } from "node:fs";
import { dirname, join, parse, resolve as resolvePath } from "node:path";
import { Effect } from "effect";
import { resolveGatewayFlowhubRegistryProviderFromEnv } from "./gateway-provider.js";
import { qianjiClientFlowhubScenarioRegistryProvider } from "./qianji-client-provider.js";
import { normalizeFlowhubScenarioRegistry, selectFlowhubScenario } from "./registry.js";
import type { FlowhubScenarioResolution, FlowhubScenarioResolutionOptions } from "./types.js";

export function resolveFlowhubScenario(
  options: FlowhubScenarioResolutionOptions,
): Effect.Effect<FlowhubScenarioResolution, Error> {
  return Effect.tryPromise({
    try: () => resolveFlowhubScenarioPromise(options),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });
}

async function resolveFlowhubScenarioPromise(
  options: FlowhubScenarioResolutionOptions,
): Promise<FlowhubScenarioResolution> {
  const scenarioId = options.scenarioId.trim();
  if (!scenarioId) throw new Error("--flowhub-scenario requires a non-empty scenario id");

  const flowhubRoot = resolveFlowhubRoot(options.cwd, options.flowhubRoot);
  const provider =
    options.registryProvider ??
    resolveGatewayFlowhubRegistryProviderFromEnv() ??
    qianjiClientFlowhubScenarioRegistryProvider;
  const rawRegistry = await provider.loadRegistry({
    cwd: options.cwd,
    flowhubRoot,
    qianjiClientCommand: options.qianjiClientCommand,
  });
  const registry = normalizeFlowhubScenarioRegistry(rawRegistry);
  return selectFlowhubScenario(registry, scenarioId, flowhubRoot);
}

function resolveFlowhubRoot(cwd: string, explicitRoot: string | undefined): string {
  if (explicitRoot?.trim()) return resolvePath(cwd, explicitRoot);
  const envRoot = process.env.QIANJI_FLOWHUB_ROOT?.trim();
  if (envRoot) return resolvePath(cwd, envRoot);
  const projectRoot = process.env.PRJ_ROOT?.trim();
  if (projectRoot) return join(projectRoot, "qianji-flowhub");
  return discoverFlowhubRoot(cwd) ?? resolvePath(cwd, "qianji-flowhub");
}

function discoverFlowhubRoot(cwd: string): string | undefined {
  let current = cwd;
  const root = parse(current).root;
  while (true) {
    const candidate = join(current, "qianji-flowhub");
    if (isDirectory(candidate)) return candidate;
    if (current === root) return undefined;
    current = dirname(current);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
