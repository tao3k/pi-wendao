export function resolveQianjiWorkflowServerUrl(explicit: string | undefined): string | undefined {
  const explicitValue = explicit?.trim();
  if (explicitValue) return stripTrailingSlash(explicitValue);
  const envValue = process.env.PI_WENDAO_QIANJI_WORKFLOW_SERVER_URL?.trim();
  return envValue ? stripTrailingSlash(envValue) : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
