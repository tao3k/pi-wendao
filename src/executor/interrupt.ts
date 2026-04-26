export class WorkflowInterruptedError extends Error {
  constructor(message = "Workflow interrupted; checkpoint preserved.") {
    super(message);
    this.name = "WorkflowInterruptedError";
  }
}

export function isWorkflowInterruptedError(error: unknown): error is WorkflowInterruptedError {
  return (
    error instanceof WorkflowInterruptedError ||
    (error instanceof Error && error.name === "WorkflowInterruptedError")
  );
}

export function throwIfWorkflowInterrupted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WorkflowInterruptedError();
}

export function waitForWorkflowInterrupt(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(new WorkflowInterruptedError());
      return;
    }
    signal.addEventListener("abort", () => reject(new WorkflowInterruptedError()), { once: true });
  });
}
