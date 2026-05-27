import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveFlowhubScenario,
  type FlowhubScenarioRegistryProvider,
} from "../../src/cli/flowhub-scenario.js";

const tempDirs: string[] = [];
const servers: Server[] = [];
let originalRegistryUrl: string | undefined;
let originalQianjiRegistryUrl: string | undefined;
let originalPiWendaoQianjiServerUrl: string | undefined;
let originalQianjiServerUrl: string | undefined;
let originalRegistryTimeoutMs: string | undefined;

function runResolveFlowhubScenario(options: Parameters<typeof resolveFlowhubScenario>[0]) {
  return Effect.runPromise(resolveFlowhubScenario(options));
}

describe("Flowhub scenario resolution", () => {
  beforeEach(() => {
    originalRegistryUrl = process.env.PI_WENDAO_FLOWHUB_REGISTRY_URL;
    originalQianjiRegistryUrl = process.env.QIANJI_FLOWHUB_REGISTRY_URL;
    originalPiWendaoQianjiServerUrl = process.env.PI_WENDAO_QIANJI_SERVER_URL;
    originalQianjiServerUrl = process.env.QIANJI_SERVER_URL;
    originalRegistryTimeoutMs = process.env.PI_WENDAO_FLOWHUB_REGISTRY_TIMEOUT_MS;
    delete process.env.PI_WENDAO_FLOWHUB_REGISTRY_URL;
    delete process.env.QIANJI_FLOWHUB_REGISTRY_URL;
    delete process.env.PI_WENDAO_QIANJI_SERVER_URL;
    delete process.env.QIANJI_SERVER_URL;
    delete process.env.PI_WENDAO_FLOWHUB_REGISTRY_TIMEOUT_MS;
  });

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) reject(error);
              else resolve();
            });
          }),
      ),
    );
    restoreEnv("PI_WENDAO_FLOWHUB_REGISTRY_URL", originalRegistryUrl);
    restoreEnv("QIANJI_FLOWHUB_REGISTRY_URL", originalQianjiRegistryUrl);
    restoreEnv("PI_WENDAO_QIANJI_SERVER_URL", originalPiWendaoQianjiServerUrl);
    restoreEnv("QIANJI_SERVER_URL", originalQianjiServerUrl);
    restoreEnv("PI_WENDAO_FLOWHUB_REGISTRY_TIMEOUT_MS", originalRegistryTimeoutMs);
  });

  it("selects a BPMN source pair from qianji-client scenarios JSON", async () => {
    const root = makeTempDir("pi-wendao-flowhub-");
    const flowhubRoot = join(root, "qianji-flowhub");
    mkdirSync(join(flowhubRoot, "plan"), { recursive: true });
    const command = writeFakeQianjiClient(root, {
      passed: true,
      sourcePairs: [
        {
          scenarioId: "deep_read",
          bpmnProcessId: "paper_deep_read",
          bpmnSource: "plan/deep-read.bpmn",
          orgSource: join(flowhubRoot, "plan", "deep-read.org"),
          bpmnSha256: "a".repeat(64),
          orgSha256: "b".repeat(64),
        },
      ],
    });

    const scenario = await runResolveFlowhubScenario({
      scenarioId: "deep_read",
      cwd: root,
      flowhubRoot,
      qianjiClientCommand: command,
    });

    expect(scenario).toMatchObject({
      scenarioId: "deep_read",
      bpmnProcessId: "paper_deep_read",
      bpmnSource: join(flowhubRoot, "plan", "deep-read.bpmn"),
      orgSource: join(flowhubRoot, "plan", "deep-read.org"),
      bpmnSha256: "a".repeat(64),
      orgSha256: "b".repeat(64),
      flowhubRoot,
    });
  });

  it("reports available scenarios when the requested id is missing", async () => {
    const root = makeTempDir("pi-wendao-flowhub-missing-");
    const command = writeFakeQianjiClient(root, {
      passed: true,
      sourcePairs: [
        {
          scenarioId: "agent-coding",
          bpmnProcessId: "agent_coding",
          bpmnSource: "/tmp/agent-coding.bpmn",
          orgSource: "/tmp/agent-coding.org",
          bpmnSha256: "c".repeat(64),
          orgSha256: "d".repeat(64),
        },
      ],
    });

    await expect(
      runResolveFlowhubScenario({
        scenarioId: "deep_read",
        cwd: root,
        qianjiClientCommand: command,
      }),
    ).rejects.toThrow(/available scenarios: agent-coding/);
  });

  it("uses an injected registry provider as the runtime seam", async () => {
    const root = makeTempDir("pi-wendao-flowhub-provider-");
    const flowhubRoot = join(root, "qianji-flowhub");
    const calls: Array<{ cwd: string; flowhubRoot: string }> = [];
    const provider: FlowhubScenarioRegistryProvider = {
      async loadRegistry(options) {
        calls.push({ cwd: options.cwd, flowhubRoot: options.flowhubRoot });
        return {
          passed: true,
          sourcePairs: [
            {
              scenarioId: "agent-coding",
              bpmnProcessId: "agent_coding",
              bpmnSource: "plan/agent-coding.bpmn",
              orgSource: "plan/agent-coding.org",
              bpmnSha256: "e".repeat(64),
              orgSha256: "f".repeat(64),
            },
          ],
        };
      },
    };

    const scenario = await runResolveFlowhubScenario({
      scenarioId: "agent-coding",
      cwd: root,
      flowhubRoot,
      qianjiClientCommand: "/definitely/not/used",
      registryProvider: provider,
    });

    expect(calls).toEqual([{ cwd: root, flowhubRoot }]);
    expect(scenario).toMatchObject({
      scenarioId: "agent-coding",
      bpmnProcessId: "agent_coding",
      bpmnSource: join(flowhubRoot, "plan", "agent-coding.bpmn"),
      orgSource: join(flowhubRoot, "plan", "agent-coding.org"),
    });
  });

  it("uses a Gateway registry URL when configured", async () => {
    const root = makeTempDir("pi-wendao-flowhub-gateway-");
    const flowhubRoot = join(root, "qianji-flowhub");
    const url = await serveRegistry(
      qianjiServerRegistryPayload(flowhubRoot, {
        scenarioId: "gateway-scenario",
        bpmnProcessId: "gateway_process",
        bpmnSource: "gateway/scenario.bpmn",
        orgSource: "gateway/scenario.org",
        bpmnSha256: "1".repeat(64),
        orgSha256: "2".repeat(64),
      }),
    );
    process.env.PI_WENDAO_FLOWHUB_REGISTRY_URL = url;

    const scenario = await runResolveFlowhubScenario({
      scenarioId: "gateway-scenario",
      cwd: root,
      flowhubRoot,
      qianjiClientCommand: "/definitely/not/used",
    });

    expect(scenario).toMatchObject({
      scenarioId: "gateway-scenario",
      bpmnProcessId: "gateway_process",
      bpmnSource: join(flowhubRoot, "gateway", "scenario.bpmn"),
      orgSource: join(flowhubRoot, "gateway", "scenario.org"),
    });
  });

  it("derives the Flowhub registry route from a qianji-server base URL", async () => {
    const root = makeTempDir("pi-wendao-flowhub-server-url-");
    const flowhubRoot = join(root, "qianji-flowhub");
    const serverUrl = await serveRegistry(
      qianjiServerRegistryPayload(flowhubRoot, {
        scenarioId: "server-url-scenario",
        bpmnProcessId: "server_url_process",
        bpmnSource: "server/scenario.bpmn",
        orgSource: "server/scenario.org",
        bpmnSha256: "3".repeat(64),
        orgSha256: "4".repeat(64),
      }),
    );
    process.env.PI_WENDAO_QIANJI_SERVER_URL = stripFlowhubRegistryPath(serverUrl);

    const scenario = await runResolveFlowhubScenario({
      scenarioId: "server-url-scenario",
      cwd: root,
      flowhubRoot,
      qianjiClientCommand: "/definitely/not/used",
    });

    expect(scenario).toMatchObject({
      scenarioId: "server-url-scenario",
      bpmnProcessId: "server_url_process",
      bpmnSource: join(flowhubRoot, "server", "scenario.bpmn"),
      orgSource: join(flowhubRoot, "server", "scenario.org"),
    });
  });

  it("prefers the exact Gateway registry URL over a qianji-server base URL", async () => {
    const root = makeTempDir("pi-wendao-flowhub-url-precedence-");
    const flowhubRoot = join(root, "qianji-flowhub");
    process.env.PI_WENDAO_FLOWHUB_REGISTRY_URL = await serveRegistry(
      qianjiServerRegistryPayload(flowhubRoot, {
        scenarioId: "exact-url-scenario",
        bpmnProcessId: "exact_url_process",
        bpmnSource: "exact/scenario.bpmn",
        orgSource: "exact/scenario.org",
        bpmnSha256: "5".repeat(64),
        orgSha256: "6".repeat(64),
      }),
    );
    process.env.PI_WENDAO_QIANJI_SERVER_URL = await serveRegistry(
      qianjiServerRegistryPayload(flowhubRoot, {
        scenarioId: "base-url-scenario",
        bpmnProcessId: "base_url_process",
        bpmnSource: "base/scenario.bpmn",
        orgSource: "base/scenario.org",
        bpmnSha256: "7".repeat(64),
        orgSha256: "8".repeat(64),
      }),
    );

    const scenario = await runResolveFlowhubScenario({
      scenarioId: "exact-url-scenario",
      cwd: root,
      flowhubRoot,
      qianjiClientCommand: "/definitely/not/used",
    });

    expect(scenario).toMatchObject({
      scenarioId: "exact-url-scenario",
      bpmnProcessId: "exact_url_process",
      bpmnSource: join(flowhubRoot, "exact", "scenario.bpmn"),
      orgSource: join(flowhubRoot, "exact", "scenario.org"),
    });
  });

  it("surfaces Gateway provider HTTP errors", async () => {
    const root = makeTempDir("pi-wendao-flowhub-gateway-error-");
    process.env.PI_WENDAO_FLOWHUB_REGISTRY_URL = await serveRegistry({ error: "not ready" }, 503);

    await expect(
      runResolveFlowhubScenario({
        scenarioId: "gateway-scenario",
        cwd: root,
        qianjiClientCommand: "/definitely/not/used",
      }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("surfaces qianji-server registry diagnostics on Gateway failures", async () => {
    const root = makeTempDir("pi-wendao-flowhub-gateway-diagnostics-");
    process.env.PI_WENDAO_FLOWHUB_REGISTRY_URL = await serveRegistry(
      {
        action: "scenarios",
        passed: false,
        flowhubRoot: join(root, "missing-flowhub"),
        sourcePairs: [],
        validation: {
          flowhubContractPassed: false,
          diagnostics: [
            `Flowhub root \`${join(root, "missing-flowhub")}\` has no Org+BPMN source pairs`,
          ],
        },
      },
      503,
    );

    await expect(
      runResolveFlowhubScenario({
        scenarioId: "gateway-scenario",
        cwd: root,
        qianjiClientCommand: "/definitely/not/used",
      }),
    ).rejects.toThrow(/Flowhub root .* has no Org\+BPMN source pairs/);
  });

  it("rejects registries that did not pass Flowhub validation", async () => {
    const root = makeTempDir("pi-wendao-flowhub-failed-");
    const command = writeFakeQianjiClient(root, {
      passed: false,
      sourcePairs: [],
    });

    await expect(
      runResolveFlowhubScenario({
        scenarioId: "deep_read",
        cwd: root,
        qianjiClientCommand: command,
      }),
    ).rejects.toThrow(/did not pass validation/);
  });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFakeQianjiClient(root: string, payload: unknown): string {
  const command = join(root, "qianji-client-fake.mjs");
  writeFileSync(
    command,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`,
    "utf-8",
  );
  chmodSync(command, 0o755);
  return command;
}

function serveRegistry(payload: unknown, statusCode = 200): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(statusCode, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test registry server did not bind to a TCP address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/flowhub/scenarios`);
    });
  });
}

function stripFlowhubRegistryPath(url: string): string {
  return url.replace(/\/flowhub\/scenarios$/, "");
}

function qianjiServerRegistryPayload(
  flowhubRoot: string,
  sourcePair: {
    scenarioId: string;
    bpmnProcessId: string;
    bpmnSource: string;
    orgSource: string;
    bpmnSha256: string;
    orgSha256: string;
  },
): unknown {
  return {
    action: "scenarios",
    passed: true,
    flowhubRoot,
    sourcePairs: [sourcePair],
    validation: {
      flowhubContractPassed: true,
      diagnostics: [],
    },
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
