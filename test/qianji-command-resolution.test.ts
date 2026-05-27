import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveDefaultQianjiClientCommand,
  resolveDefaultQianjiCommand,
} from "../src/qianji-command-resolution.js";

const tempDirs: string[] = [];

describe("qianji command resolution", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers explicit QIANJI_CLI over workspace discovery", () => {
    const original = process.env.QIANJI_CLI;
    try {
      process.env.QIANJI_CLI = "/tmp/explicit-qianji";
      expect(resolveDefaultQianjiCommand(makeWorkspaceWithQianji())).toBe("/tmp/explicit-qianji");
    } finally {
      restoreEnv("QIANJI_CLI", original);
    }
  });

  it("discovers a built workspace qianji binary from nested package cwd", () => {
    const cwd = makeWorkspaceWithQianji();

    expect(resolveDefaultQianjiCommand(cwd)).toBe(
      join(workspaceRootFromNestedCwd(cwd), "target", "debug", qianjiBinaryName()),
    );
  });

  it("falls back to PATH command name when no workspace binary is available", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-no-qianji-"));
    tempDirs.push(dir);

    expect(resolveDefaultQianjiCommand(dir)).toBe("qianji");
  });

  it("resolves qianji-client from env, workspace binary, or PATH", () => {
    const original = process.env.QIANJI_CLIENT_CLI;
    try {
      process.env.QIANJI_CLIENT_CLI = "/tmp/explicit-qianji-client";
      expect(
        resolveDefaultQianjiClientCommand(makeWorkspaceWithBinary(qianjiClientBinaryName())),
      ).toBe("/tmp/explicit-qianji-client");
    } finally {
      restoreEnv("QIANJI_CLIENT_CLI", original);
    }

    const cwd = makeWorkspaceWithBinary(qianjiClientBinaryName());
    expect(resolveDefaultQianjiClientCommand(cwd)).toBe(
      join(workspaceRootFromNestedCwd(cwd), "target", "debug", qianjiClientBinaryName()),
    );

    const dir = mkdtempSync(join(tmpdir(), "pi-wendao-no-qianji-client-"));
    tempDirs.push(dir);
    expect(resolveDefaultQianjiClientCommand(dir)).toBe("qianji-client");
  });
});

function makeWorkspaceWithQianji(): string {
  return makeWorkspaceWithBinary(qianjiBinaryName());
}

function makeWorkspaceWithBinary(binaryName: string): string {
  const root = mkdtempSync(join(tmpdir(), "pi-wendao-qianji-root-"));
  tempDirs.push(root);
  const binDir = join(root, "target", "debug");
  mkdirSync(binDir, { recursive: true });
  const binary = join(binDir, binaryName);
  writeFileSync(binary, "#!/usr/bin/env sh\nexit 0\n", "utf-8");
  chmodSync(binary, 0o755);
  const nested = join(root, ".data", "pi-wendao");
  mkdirSync(nested, { recursive: true });
  return nested;
}

function workspaceRootFromNestedCwd(cwd: string): string {
  return join(cwd, "..", "..");
}

function qianjiBinaryName(): string {
  return process.platform === "win32" ? "qianji.exe" : "qianji";
}

function qianjiClientBinaryName(): string {
  return process.platform === "win32" ? "qianji-client.exe" : "qianji-client";
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
