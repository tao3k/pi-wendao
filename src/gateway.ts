/**
 * Stable package facade for Gateway-backed pi-wendao registry integration.
 *
 * The current Gateway surface is the Flowhub scenario registry provider used
 * by pi-wendao. Consumers should import it from `pi-wendao/gateway`.
 */
export {
  createGatewayFlowhubScenarioRegistryProvider,
  normalizeFlowhubScenarioRegistry,
  parseFlowhubScenarioRegistryJson,
  qianjiClientFlowhubScenarioRegistryProvider,
  resolveFlowhubScenario,
  resolveGatewayFlowhubRegistryProviderFromEnv,
  selectFlowhubScenario,
} from "./cli/flowhub-scenario/index.js";
export type {
  FlowhubGatewayRegistryProviderOptions,
  FlowhubScenarioPair,
  FlowhubScenarioRegistry,
  FlowhubScenarioRegistryProvider,
  FlowhubScenarioRegistryProviderOptions,
  FlowhubScenarioResolution,
  FlowhubScenarioResolutionOptions,
} from "./cli/flowhub-scenario/index.js";
