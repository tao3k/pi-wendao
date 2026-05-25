import { isAbsolute, resolve as resolvePath } from "node:path";
import { isObject } from "../../executor/data.js";
import type {
  FlowhubScenarioPair,
  FlowhubScenarioRegistry,
  FlowhubScenarioResolution,
} from "./types.js";

export function parseFlowhubScenarioRegistryJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Flowhub scenario registry did not return valid JSON: ${detail}`,
    );
  }
}

export function normalizeFlowhubScenarioRegistry(
  value: unknown,
): FlowhubScenarioRegistry {
  if (!isObject(value))
    throw new Error("Flowhub scenario registry returned a non-object");
  if (value.passed !== true) {
    throw new Error(
      "Flowhub scenario registry did not pass validation",
    );
  }
  if (!Array.isArray(value.sourcePairs)) {
    throw new Error(
      "qianji-client flowhub scenario registry is missing sourcePairs",
    );
  }
  return {
    passed: true,
    sourcePairs: value.sourcePairs.map(parseFlowhubScenarioPair),
  };
}

export function selectFlowhubScenario(
  registry: FlowhubScenarioRegistry,
  scenarioId: string,
  flowhubRoot: string,
): FlowhubScenarioResolution {
  const selected = registry.sourcePairs.find(
    (pair) => pair.scenarioId === scenarioId,
  );
  if (!selected) {
    const available = registry.sourcePairs
      .map((pair) => pair.scenarioId)
      .sort()
      .join(", ");
    throw new Error(
      `Flowhub scenario "${scenarioId}" was not found${available ? `; available scenarios: ${available}` : ""}`,
    );
  }

  return {
    scenarioId: selected.scenarioId,
    bpmnProcessId: selected.bpmnProcessId,
    bpmnSource: resolveRegistryPath(flowhubRoot, selected.bpmnSource),
    orgSource: resolveRegistryPath(flowhubRoot, selected.orgSource),
    bpmnSha256: selected.bpmnSha256,
    orgSha256: selected.orgSha256,
    flowhubRoot,
  };
}

function parseFlowhubScenarioPair(value: unknown): FlowhubScenarioPair {
  if (!isObject(value))
    throw new Error("Flowhub sourcePairs must contain objects");
  return {
    scenarioId: readString(value, "scenarioId"),
    bpmnProcessId: readString(value, "bpmnProcessId"),
    bpmnSource: readString(value, "bpmnSource"),
    orgSource: readString(value, "orgSource"),
    bpmnSha256: readSha256(value, "bpmnSha256"),
    orgSha256: readSha256(value, "orgSha256"),
  };
}

function resolveRegistryPath(flowhubRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolvePath(flowhubRoot, path);
}

function readString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field === "string" && field.trim().length > 0) return field;
  throw new Error(`Flowhub source pair is missing ${key}`);
}

function readSha256(value: Record<string, unknown>, key: string): string {
  const field = readString(value, key);
  if (/^[a-f0-9]{64}$/.test(field)) return field;
  throw new Error(`Flowhub source pair has invalid ${key}`);
}
