import type { ChildProcessWithoutNullStreams } from "node:child_process";

export function collectProcessOutput(
  child: ChildProcessWithoutNullStreams,
  resolveOutput: (stdout: string) => void,
  reject: (error: Error) => void,
  label: string,
): void {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", reject);
  child.on("close", (exitCode) => {
    if (exitCode === 0) {
      resolveOutput(stdout);
      return;
    }
    reject(
      new Error(
        `${label} failed with exit code ${exitCode ?? "unknown"}${
          stderr.trim() ? `:\n${stderr.trimEnd()}` : ""
        }`,
      ),
    );
  });
}
