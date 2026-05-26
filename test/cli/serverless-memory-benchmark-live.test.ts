import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runServerlessMemoryRecallBenchmark } from "../../src/cli/serverless-memory/index.js";

const itLive =
  process.env.RUN_PI_WENDAO_SERVERLESS_MEMORY_BENCHMARK_LIVE === "1" ? it : it.skip;

describe("serverless memory live recall benchmark", () => {
  itLive("compares section, property, and org-elements recall contexts", async () => {
    const evidencePath =
      process.env.PI_WENDAO_SERVERLESS_MEMORY_BENCHMARK_EVIDENCE ??
      join(projectRoot(), ".cache", "pi-wendao-serverless-memory-benchmark.json");
    mkdirSync(dirname(evidencePath), { recursive: true });

    const result = await runServerlessMemoryRecallBenchmark({
      cwd: projectRoot(),
      packetPath:
        process.env.PI_WENDAO_SERVERLESS_MEMORY_BENCHMARK_PACKET ??
        taskListJsonFixturePath(),
      modelPattern:
        process.env.PI_WENDAO_SERVERLESS_MEMORY_BENCHMARK_MODEL ??
        "anthropic/deepseek-v4-pro",
      provider: process.env.PI_WENDAO_SERVERLESS_MEMORY_BENCHMARK_PROVIDER,
      thinkingLevel: "minimal",
      evidencePath,
    });

    expect(result.variants.map((variant) => variant.variant)).toEqual([
      "section-only",
      "property-only",
      "org-elements",
    ]);
    const propertyOnly = result.variants.find((variant) => variant.variant === "property-only");
    const orgElements = result.variants.find((variant) => variant.variant === "org-elements");
    expect(propertyOnly?.orgidHitCount).toBeGreaterThan(0);
    expect(orgElements?.orgidHitCount).toBe(result.expectedRows.length);
    expect(orgElements?.supportSummaryHitCount).toBe(result.expectedRows.length);
  }, 180_000);
});

function taskListJsonFixturePath(): string {
  return fileURLToPath(
    new URL("../fixtures/serverless-memory-task-list.json", import.meta.url),
  );
}

function projectRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}
