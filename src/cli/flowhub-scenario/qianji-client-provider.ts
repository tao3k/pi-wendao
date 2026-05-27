import { spawn } from "node:child_process";
import { resolveDefaultQianjiClientCommand } from "../../qianji-command-resolution.js";
import { shellQuote } from "../../executor/qianji-stream.js";
import { parseFlowhubScenarioRegistryJson } from "./registry.js";
import type {
  FlowhubScenarioRegistryProvider,
  FlowhubScenarioRegistryProviderOptions,
} from "./types.js";

export const qianjiClientFlowhubScenarioRegistryProvider: FlowhubScenarioRegistryProvider = {
  async loadRegistry(options) {
    const command = options.qianjiClientCommand ?? resolveDefaultQianjiClientCommand(options.cwd);
    const stdout = await runQianjiClientScenarios(command, options);
    return parseFlowhubScenarioRegistryJson(stdout);
  },
};

function runQianjiClientScenarios(
  command: string,
  options: FlowhubScenarioRegistryProviderOptions,
): Promise<string> {
  const args = ["flowhub", "--flowhub-root", options.flowhubRoot, "scenarios", "--json"];
  const commandLine = [command, ...args.map(shellQuote)].join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn(commandLine, {
      cwd: options.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `qianji-client flowhub scenarios failed with exit code ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}
