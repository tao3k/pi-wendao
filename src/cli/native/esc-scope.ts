let activeWorkflowUiEscScopes = 0;

export function isNativeWorkflowUiEscScopeActive(): boolean {
  return activeWorkflowUiEscScopes > 0;
}

export async function withNativeWorkflowUiEscScope<T>(run: () => Promise<T>): Promise<T> {
  activeWorkflowUiEscScopes += 1;
  try {
    return await run();
  } finally {
    activeWorkflowUiEscScopes = Math.max(0, activeWorkflowUiEscScopes - 1);
  }
}
