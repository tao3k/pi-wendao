/**
 * Stable package facade for pi-wendao native subagent runtime integration.
 *
 * Keep implementation modules under `src/subagents` and `src/executor`; package
 * consumers should import from `pi-wendao/subagents`.
 */
export * from "./subagents/index.js";
export { NativeSubagentManager } from "./subagents/manager.js";
export { textResult } from "./subagents/protocol.js";
export type {
  NativeSubagentGetResultRequest,
  NativeSubagentInvocation,
  NativeSubagentRecord,
  NativeSubagentRunOptions,
  NativeSubagentSpawnRequest,
  NativeSubagentStatus,
  NativeSubagentSteerRequest,
  NativeSubagentToolResult,
  NativeSubagentToolResultDetails,
} from "./subagents/protocol.js";
export { runNativeSubagent } from "./subagents/runner.js";
export type { NativeSubagentRunnerInput, NativeSubagentRunnerResult } from "./subagents/runner.js";
export { buildRunKey, resolveSubagentType } from "./executor/pi-subagents-routing.js";
export {
  createInMemoryPiSubagentsRunStore,
  createJsonFilePiSubagentsRunStore,
  createPiSubagentsClientFromTools,
  createPiSubagentsHost,
} from "./executor/pi-subagents-host.js";
export type {
  PiSubagentsClient,
  PiSubagentsClientCallbacks,
  PiSubagentsGetResultRequest,
  PiSubagentsHostEvent,
  PiSubagentsHostOptions,
  PiSubagentsHostToolEvent,
  PiSubagentsHostUpdateEvent,
  PiSubagentsRunRecord,
  PiSubagentsRunStore,
  PiSubagentsSpawnRequest,
  PiSubagentsSpawnResult,
  PiSubagentsToolSurface,
} from "./executor/pi-subagents-host.js";
export {
  collectPiSubagentsRegisteredTools,
  createPiSubagentsClientFromLoadedExtensions,
  createPiSubagentsClientFromRegisteredTools,
  createPiSubagentsHostFromLoadedExtensions,
  discoverPiSubagentsHost,
  getCurrentPiSubagentsToolExecutionContext,
  tryCreatePiSubagentsHostFromLoadedExtensions,
} from "./executor/pi-subagents-runtime.js";
export type {
  DiscoverPiSubagentsRuntimeHostOptions,
  DiscoverPiSubagentsRuntimeHostResult,
  PiLoadedExtensionLike,
  PiLoadedExtensionsLike,
  PiRegisteredToolDefinition,
  PiRegisteredToolLike,
  PiSubagentsRegisteredToolClientOptions,
  PiSubagentsRegisteredTools,
  PiSubagentsRuntimeHostOptions,
  PiSubagentsToolExecutionContext,
  PiToolResultContent,
  PiToolResultLike,
} from "./executor/pi-subagents-runtime.js";
export { executeBpmnWithPiSubagents } from "./executor/pi-subagents-pi-wendao.js";
export type { ExecuteBpmnWithPiSubagentsOptions } from "./executor/pi-subagents-pi-wendao.js";
