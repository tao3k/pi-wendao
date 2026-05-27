import type { Effect } from "effect";
import { throwIfWorkflowInterrupted } from "../../interrupt.js";
import { isCapabilitiesResponse } from "./guards.js";
import { getQianjiServerJson } from "./transport.js";
import type { QianjiServerWorkflowHttpOptions } from "./types.js";
import { REQUIRED_WORKFLOW_CAPABILITIES } from "./types.js";
import { effectFromPromise, runPiWendaoEffect, type PiWendaoEffectError } from "../../../effect.js";

export function assertWorkflowServerCapabilities(
  options: Pick<QianjiServerWorkflowHttpOptions, "serverUrl" | "signal">,
): Effect.Effect<void, PiWendaoEffectError> {
  return effectFromPromise("assertWorkflowServerCapabilities", () =>
    assertWorkflowServerCapabilitiesPromise(options),
  );
}

async function assertWorkflowServerCapabilitiesPromise(
  options: Pick<QianjiServerWorkflowHttpOptions, "serverUrl" | "signal">,
): Promise<void> {
  throwIfWorkflowInterrupted(options.signal);
  const capabilities = await getWorkflowServerCapabilities(options);
  const missing = REQUIRED_WORKFLOW_CAPABILITIES.filter(
    (capability) => !capabilities.has(capability),
  );
  if (missing.length > 0) {
    throw new Error(
      [
        "qianji server does not expose the workflow-control capabilities required by pi-wendao",
        `server: ${options.serverUrl}`,
        `missing: ${missing.join(", ")}`,
        "This usually means the running qianji-server process is stale; restart it before running the workflow benchmark or smoke.",
      ].join("\n"),
    );
  }
}

export function assertWorkflowServerCapability(
  options: Pick<QianjiServerWorkflowHttpOptions, "serverUrl" | "signal">,
  capability: string,
  label: string,
): Effect.Effect<void, PiWendaoEffectError> {
  return effectFromPromise("assertWorkflowServerCapability", () =>
    assertWorkflowServerCapabilityPromise(options, capability, label),
  );
}

async function assertWorkflowServerCapabilityPromise(
  options: Pick<QianjiServerWorkflowHttpOptions, "serverUrl" | "signal">,
  capability: string,
  label: string,
): Promise<void> {
  throwIfWorkflowInterrupted(options.signal);
  const capabilities = await getWorkflowServerCapabilities(options);
  if (capabilities.has(capability)) return;
  throw new Error(
    [
      `qianji server does not expose the ${label} capability required by this explicit operator action`,
      `server: ${options.serverUrl}`,
      `missing: ${capability}`,
      "This action is opt-in; restart or rebuild qianji-server with the matching capability before applying recovery.",
    ].join("\n"),
  );
}

async function getWorkflowServerCapabilities(
  options: Pick<QianjiServerWorkflowHttpOptions, "serverUrl" | "signal">,
): Promise<Set<string>> {
  const parsed = await runPiWendaoEffect(
    getQianjiServerJson(options, "/capabilities", isCapabilitiesResponse, "capabilities"),
  );
  return new Set(parsed.capabilities);
}
