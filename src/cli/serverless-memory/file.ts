import { readFileSync } from "node:fs";
import { parseServerlessMemoryRecallPacket } from "./packet.js";
import type { ServerlessMemoryRecallPacket } from "./types.js";

export function readServerlessMemoryRecallPacketFile(
  path: string,
): ServerlessMemoryRecallPacket {
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid serverless memory recall JSON file ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseServerlessMemoryRecallPacket(readRecallPacketPayload(parsed));
}

function readRecallPacketPayload(input: unknown): unknown {
  if (isRecord(input) && "recallPacket" in input) return input.recallPacket;
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
