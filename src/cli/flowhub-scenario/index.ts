/**
 * Flowhub scenario runtime boundary.
 *
 * This facade intentionally exposes only scenario-resolution contracts used by
 * the pi-wendao CLI. Provider implementations stay behind this boundary so the
 * current qianji-client registry source can later be replaced by a Gateway
 * provider without changing the command entry point.
 */
export { resolveFlowhubScenario } from "./resolver.js";
export {
  normalizeFlowhubScenarioRegistry,
  parseFlowhubScenarioRegistryJson,
  selectFlowhubScenario,
} from "./registry.js";
export {
  createGatewayFlowhubScenarioRegistryProvider,
  resolveGatewayFlowhubRegistryProviderFromEnv,
} from "./gateway-provider.js";
export { qianjiClientFlowhubScenarioRegistryProvider } from "./qianji-client-provider.js";
export type {
  FlowhubGatewayRegistryProviderOptions,
  FlowhubScenarioPair,
  FlowhubScenarioRegistry,
  FlowhubScenarioRegistryProvider,
  FlowhubScenarioRegistryProviderOptions,
  FlowhubScenarioResolution,
  FlowhubScenarioResolutionOptions,
} from "./types.js";
