import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE,
  type ServerlessMemoryRecallDetails,
  type ServerlessMemoryRecallPacket,
} from "./types.js";
import { renderServerlessMemoryRecallContent, serverlessMemoryRecallDetails } from "./session.js";

export interface ServerlessMemoryRecallInjectionResult {
  injected: boolean;
  reason: "sent" | "already-present" | "empty";
}

export function registerServerlessMemoryRecallInjection(
  pi: ExtensionAPI,
  packet: ServerlessMemoryRecallPacket | undefined,
): void {
  if (!packet) return;
  pi.on("session_start", (_event, ctx) => {
    injectServerlessMemoryRecallMessage(pi, ctx, packet);
  });
}

export function injectServerlessMemoryRecallMessage(
  pi: Pick<ExtensionAPI, "sendMessage">,
  ctx: Pick<ExtensionContext, "sessionManager">,
  packet: ServerlessMemoryRecallPacket,
): ServerlessMemoryRecallInjectionResult {
  const content = renderServerlessMemoryRecallContent(packet);
  if (!content.trim()) return { injected: false, reason: "empty" };
  const details = serverlessMemoryRecallDetails(packet);
  if (hasRecallMessage(ctx.sessionManager.getEntries(), details)) {
    return { injected: false, reason: "already-present" };
  }
  pi.sendMessage(
    {
      customType: PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE,
      content,
      display: false,
      details,
    },
    { triggerTurn: false },
  );
  return { injected: true, reason: "sent" };
}

function hasRecallMessage(
  entries: readonly SessionEntry[],
  details: ServerlessMemoryRecallDetails,
): boolean {
  return entries.some((entry) => {
    if (entry.type !== "custom_message") return false;
    if (entry.customType !== PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE) return false;
    return sameRecallDetails(entry.details, details);
  });
}

function sameRecallDetails(left: unknown, right: ServerlessMemoryRecallDetails): boolean {
  if (!isRecord(left)) return false;
  return (
    left.schema === right.schema &&
    left.transport === right.transport &&
    left.rowCount === right.rowCount &&
    left.memoryObjectCount === right.memoryObjectCount &&
    sameStringArray(left.orgids, right.orgids)
  );
}

function sameStringArray(left: unknown, right: readonly string[]): boolean {
  if (!Array.isArray(left)) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
