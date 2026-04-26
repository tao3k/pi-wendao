import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
};

describe("package bin", () => {
  it("keeps the pi-wendao npx entry executable after build and pack", () => {
    expect(packageJson.bin?.["pi-wendao"]).toBe("./dist/cli/pi-wendao.js");
    expect(packageJson.scripts?.build).toContain("chmod +x dist/cli/pi-wendao.js");
    expect(packageJson.scripts?.prepack).toBe("npm run build");
  });
});
