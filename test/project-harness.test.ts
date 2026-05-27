import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTypeScriptProjectHarnessEmbeddedClean } from "typescript-lang-project-harness";
import { describe, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("TypeScript project harness", () => {
  it("passes blocking policy and emits compact agent advice", () => {
    assertTypeScriptProjectHarnessEmbeddedClean(projectRoot);
  });
});
