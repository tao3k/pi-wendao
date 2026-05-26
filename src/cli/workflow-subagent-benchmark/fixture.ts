export const DEFAULT_FIXTURE_PATH = "test/fixtures/complex-workflow.bpmn";
export const DEFAULT_PROCESS_ID = "Process_1";
export const DEFAULT_MODEL = "anthropic/deepseek-v4-pro";

export function complexHostFixture(): Record<string, unknown> {
  return {
    service_tasks: {
      Task_Init: { data: complexTaskOutput("Task_Init") },
      Task_Retry: { data: complexTaskOutput("Task_Retry") },
      Task_FetchA: { data: complexTaskOutput("Task_FetchA") },
      Task_FetchB: { data: complexTaskOutput("Task_FetchB") },
      Task_Merge: { data: complexTaskOutput("Task_Merge") },
      Task_Validate: { data: complexTaskOutput("Task_Validate") },
      Task_Fallback: { data: complexTaskOutput("Task_Fallback") },
      Task_Publish: { data: complexTaskOutput("Task_Publish") },
      Task_Reject: { data: complexTaskOutput("Task_Reject") },
    },
  };
}

export function complexTaskOutput(activityId: string): Record<string, unknown> {
  switch (activityId) {
    case "Task_Init":
    case "Task_Retry":
      return { status: "ready", isReady: true };
    case "Task_FetchA":
      return { resultA: "alpha" };
    case "Task_FetchB":
      return { resultB: "beta" };
    case "Task_Merge":
      return { merged: "alpha,beta" };
    case "Task_Validate":
      return { valid: true };
    case "Task_Fallback":
      return { valid: false, reason: "validation failed" };
    case "Task_Publish":
      return { published: true };
    case "Task_Reject":
      return { rejected: true };
    default:
      return { error: `unsupported activity ${activityId}` };
  }
}

export function hasExpectedComplexVariables(variables: Record<string, unknown>): boolean {
  return (
    variables.status === "ready" &&
    variables.isReady === true &&
    variables.resultA === "alpha" &&
    variables.resultB === "beta" &&
    variables.merged === "alpha,beta" &&
    variables.valid === true &&
    variables.published === true
  );
}

export function parseActivityIdFromPrompt(prompt: string): string {
  const match = prompt.match(/activityId:\s*([A-Za-z0-9_:-]+)/);
  return match?.[1] ?? "Task_Unknown";
}
