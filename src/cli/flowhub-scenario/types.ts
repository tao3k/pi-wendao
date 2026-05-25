export interface FlowhubScenarioResolutionOptions {
  scenarioId: string;
  cwd: string;
  flowhubRoot?: string;
  qianjiClientCommand?: string;
  registryProvider?: FlowhubScenarioRegistryProvider;
}

export interface FlowhubScenarioResolution {
  scenarioId: string;
  bpmnProcessId: string;
  bpmnSource: string;
  orgSource: string;
  bpmnSha256: string;
  orgSha256: string;
  flowhubRoot: string;
}

export interface FlowhubScenarioRegistryProvider {
  loadRegistry(
    options: FlowhubScenarioRegistryProviderOptions,
  ): Promise<unknown>;
}

export interface FlowhubScenarioRegistryProviderOptions {
  cwd: string;
  flowhubRoot: string;
  qianjiClientCommand?: string;
}

export interface FlowhubGatewayRegistryProviderOptions {
  url: string;
  timeoutMs?: number;
}

export interface FlowhubScenarioRegistry {
  passed: boolean;
  sourcePairs: FlowhubScenarioPair[];
}

export interface FlowhubScenarioPair {
  scenarioId: string;
  bpmnProcessId: string;
  bpmnSource: string;
  orgSource: string;
  bpmnSha256: string;
  orgSha256: string;
}
