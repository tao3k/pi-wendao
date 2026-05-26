import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runServerlessMemoryLiveRecallSmoke } from "../../src/cli/serverless-memory/index.js";

const itLive =
  process.env.RUN_PI_WENDAO_SERVERLESS_MEMORY_LIVE === "1" ? it : it.skip;

describe("serverless memory live recall", () => {
  itLive("answers from injected recall context with a real model", async () => {
    const evidencePath =
      process.env.PI_WENDAO_SERVERLESS_MEMORY_LIVE_EVIDENCE ??
      join(projectRoot(), ".cache", "pi-wendao-serverless-memory-live.json");
    mkdirSync(dirname(evidencePath), { recursive: true });

    const result = await runServerlessMemoryLiveRecallSmoke({
      cwd: projectRoot(),
      packetPath:
        process.env.PI_WENDAO_SERVERLESS_MEMORY_LIVE_PACKET ??
        taskListJsonFixturePath(),
      modelPattern:
        process.env.PI_WENDAO_SERVERLESS_MEMORY_LIVE_MODEL ??
        "anthropic/deepseek-v4-pro",
      provider: process.env.PI_WENDAO_SERVERLESS_MEMORY_LIVE_PROVIDER,
      thinkingLevel: "minimal",
      evidencePath,
    });

    expect(result.recallEntryInjected).toBe(true);
    expect(result.answerText).toContain(result.expectedOrgid);
    expect(result.answerText).toContain(result.expectedClaim);
    expect(result.passed).toBe(true);
  }, 120_000);
});

function taskListJsonFixturePath(): string {
  return fileURLToPath(
    new URL("../fixtures/serverless-memory-task-list.json", import.meta.url),
  );
}

function projectRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}
