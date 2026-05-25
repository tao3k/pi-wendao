import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WENDAO_ARROW_FLIGHT_DATA_PLANE,
  WENDAO_JSON_CONTROL_PLANE,
  WENDAO_JSONL_STDIO_CONTROL_PLANE,
  WENDAO_PROCESS_ARGS_CONTROL_PLANE,
} from "../src/arrow/boundary.js";

const SCAN_ROOTS = ["src", "test"] as const;
const BOUNDARY_FILE = "src/arrow/boundary.ts";
const THIS_TEST_FILE = "test/arrow-boundary-literals.test.ts";
const CANONICAL_TOKEN_LITERALS = [
  WENDAO_ARROW_FLIGHT_DATA_PLANE,
  WENDAO_JSONL_STDIO_CONTROL_PLANE,
  WENDAO_PROCESS_ARGS_CONTROL_PLANE,
  WENDAO_JSON_CONTROL_PLANE,
] as const;
const ALLOWED_LITERAL_FILES = [
  BOUNDARY_FILE,
  THIS_TEST_FILE,
] as const;

describe("Arrow boundary token literals", () => {
  it("keeps canonical transport tokens isolated to the JS boundary module", () => {
    const offenders: string[] = [];
    for (const sourceFile of SCAN_ROOTS.flatMap((root) => collectSourceFiles(root))) {
      const normalized = sourceFile.replaceAll("\\", "/");
      if (ALLOWED_LITERAL_FILES.includes(normalized as (typeof ALLOWED_LITERAL_FILES)[number])) {
        continue;
      }
      const source = readFileSync(sourceFile, "utf-8");
      for (const token of CANONICAL_TOKEN_LITERALS) {
        const quotedToken = JSON.stringify(token);
        if (source.includes(quotedToken)) {
          offenders.push(`${normalized}: ${quotedToken}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (path.endsWith(".ts")) {
      files.push(relative(process.cwd(), path));
    }
  }
  return files.sort();
}
