import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureNamedWorkflow,
  namedWorkflowCachePath,
  namedWorkflowCacheRoot,
  parseNamedWorkflowName,
} from "../../src/cli/named-workflows.js";

const originalCacheHome = process.env.PRJ_CACHE_HOME;

afterEach(() => {
  if (originalCacheHome === undefined) {
    delete process.env.PRJ_CACHE_HOME;
  } else {
    process.env.PRJ_CACHE_HOME = originalCacheHome;
  }
});

describe("named workflow cache", () => {
  it("resolves the brainstorm named workflow only", () => {
    expect(parseNamedWorkflowName("brainstorm")).toBe("brainstorm");
    expect(parseNamedWorkflowName("brainstrom")).toBeUndefined();
    expect(parseNamedWorkflowName("workflow.bpmn")).toBeUndefined();
  });

  it("uses PRJ_CACHE_HOME for cached named workflows", () => {
    process.env.PRJ_CACHE_HOME = "/tmp/prj-cache";

    expect(namedWorkflowCacheRoot("/repo")).toBe("/tmp/prj-cache/pi-wendao/named-workflows");
    expect(namedWorkflowCachePath("/repo", "brainstorm")).toBe(
      "/tmp/prj-cache/pi-wendao/named-workflows/brainstorm.bpmn",
    );
  });

  it("compiles a missing cache and returns the cached BPMN path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wendao-named-workflow-"));
    process.env.PRJ_CACHE_HOME = join(dir, "cache");
    const sourcePath = join(dir, "SKILL.md");
    await writeFile(sourcePath, "# Skill\nAsk questions.", "utf-8");
    let compileCalls = 0;

    const result = await ensureNamedWorkflow({
      name: "brainstorm",
      cwd: dir,
      sourcePath,
      getCompilerContext: async () => ({ model: {} as Model<string> }),
      compiler: async ({ cwd, skillContent }) => {
        compileCalls += 1;
        expect(cwd).toBe(dir);
        return {
          success: true,
          bpmnXml: `<?xml version="1.0"?><definitions>${skillContent}</definitions>`,
        };
      },
    });

    expect(result.kind).toBe("compiled");
    expect(result.workflowPath).toBe(
      join(dir, "cache", "pi-wendao", "named-workflows", "brainstorm.bpmn"),
    );
    expect(compileCalls).toBe(1);
    await expect(stat(result.workflowPath)).resolves.toBeTruthy();
  });

  it("seeds the brainstorm cache from the canonical BPMN without compiling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wendao-named-workflow-"));
    process.env.PRJ_CACHE_HOME = join(dir, "cache");
    const sourcePath = join(dir, "SKILL.md");
    const seedPath = join(dir, "brainstorm.bpmn");
    await writeFile(sourcePath, "# Brainstorming\nAsk questions.", "utf-8");
    await writeFile(seedPath, '<definitions id="Seed"/>', "utf-8");

    const result = await ensureNamedWorkflow({
      name: "brainstorm",
      cwd: dir,
      sourcePath,
      seedPath,
      getCompilerContext: async () => {
        throw new Error("canonical seed should not resolve compiler context");
      },
    });

    expect(result.kind).toBe("seeded");
    expect(await readFile(result.workflowPath, "utf-8")).toBe('<definitions id="Seed"/>');
  });

  it("uses a fresh cache without compiling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wendao-named-workflow-"));
    process.env.PRJ_CACHE_HOME = join(dir, "cache");
    const sourcePath = join(dir, "SKILL.md");
    const cachePath = namedWorkflowCachePath(dir, "brainstorm");
    await writeFile(sourcePath, "# Skill\nAsk questions.", "utf-8");
    await writeFile(cachePath, "<definitions/>", "utf-8").catch(async () => {
      await ensureNamedWorkflow({
        name: "brainstorm",
        cwd: dir,
        sourcePath,
        getCompilerContext: async () => ({ model: {} as Model<string> }),
        compiler: async () => ({ success: true, bpmnXml: "<definitions/>" }),
      });
    });

    const result = await ensureNamedWorkflow({
      name: "brainstorm",
      cwd: dir,
      sourcePath,
      getCompilerContext: async () => {
        throw new Error("fresh cache should not resolve compiler context");
      },
      compiler: async () => {
        throw new Error("fresh cache should not compile");
      },
    });

    expect(result.kind).toBe("cached");
    expect(result.workflowPath).toBe(cachePath);
  });

  it("recompiles a stale cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-wendao-named-workflow-"));
    process.env.PRJ_CACHE_HOME = join(dir, "cache");
    const sourcePath = join(dir, "SKILL.md");
    await writeFile(sourcePath, "# Skill\nFirst version.", "utf-8");
    let compileCalls = 0;
    const compiler = async () => {
      compileCalls += 1;
      return {
        success: true,
        bpmnXml: `<definitions version="${compileCalls}"/>`,
      };
    };

    await ensureNamedWorkflow({
      name: "brainstorm",
      cwd: dir,
      sourcePath,
      getCompilerContext: async () => ({ model: {} as Model<string> }),
      compiler,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(sourcePath, "# Skill\nSecond version.", "utf-8");

    const result = await ensureNamedWorkflow({
      name: "brainstorm",
      cwd: dir,
      sourcePath,
      getCompilerContext: async () => ({ model: {} as Model<string> }),
      compiler,
    });

    expect(result.kind).toBe("compiled");
    expect(compileCalls).toBe(2);
  });
});
