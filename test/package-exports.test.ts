import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackageExportEntry {
  types: string;
  import: string;
}

interface PackageJsonShape {
  exports: Record<string, PackageExportEntry>;
}

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const packageJson = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf-8"),
) as PackageJsonShape;

const stableLibraryExports = new Map<string, string>([
  ["./arrow/ipc", "src/arrow/ipc.ts"],
  ["./arrow/schema", "src/arrow/schema.ts"],
  ["./subagents", "src/subagents.ts"],
  ["./subagents/activity", "src/subagents/activity.ts"],
  ["./qianji-server", "src/qianji-server.ts"],
  ["./workflows", "src/workflows.ts"],
  ["./wendao-server", "src/wendao-server.ts"],
  ["./gateway", "src/gateway.ts"],
]);

describe("package library exports", () => {
  it("declares stable subpath exports with declaration and import targets", () => {
    for (const [subpath, sourcePath] of stableLibraryExports) {
      const entry = packageJson.exports[subpath];
      expect(entry, `${subpath} export`).toBeDefined();
      expect(entry.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
      expect(entry.import).toMatch(/^\.\/dist\/.+\.js$/);
      expect(existsSync(join(packageRoot, sourcePath)), `${sourcePath} exists`).toBe(true);
    }
  });

  it("keeps runtime domains behind focused top-level facades", () => {
    expect(packageJson.exports["./subagents"].import).toBe("./dist/subagents.js");
    expect(packageJson.exports["./qianji-server"].import).toBe("./dist/qianji-server.js");
    expect(packageJson.exports["./workflows"].import).toBe("./dist/workflows.js");
    expect(packageJson.exports["./wendao-server"].import).toBe("./dist/wendao-server.js");
    expect(packageJson.exports["./gateway"].import).toBe("./dist/gateway.js");
  });
});
