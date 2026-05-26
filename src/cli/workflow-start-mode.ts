const WORKFLOW_START_MODES = new Set(["resume-or-start", "start"]);

export type QianjiWorkflowStartMode = "resume-or-start" | "start";

export function resolveWorkflowStartMode(
  explicitMode: string | undefined,
): QianjiWorkflowStartMode | undefined {
  if (!explicitMode) return undefined;
  if (!WORKFLOW_START_MODES.has(explicitMode)) {
    throw new Error(
      `invalid workflow start mode "${explicitMode}"; expected resume-or-start or start`,
    );
  }
  return explicitMode as QianjiWorkflowStartMode;
}
