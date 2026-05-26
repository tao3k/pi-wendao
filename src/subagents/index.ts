/**
 * Native subagent package facade.
 *
 * This boundary exposes the pi extension registration entrypoint plus the
 * deterministic child-session tool selection helpers used by tests and host
 * adapters. Implementation stays split across registration, runtime, and
 * child-context tool modules; child-context tools include fd/rg, memory recall,
 * SearchStrategyFlow, and graph intercom.
 */
export {
  createNativeSubagentChildContextExtensionFactories,
  NATIVE_SUBAGENT_CHILD_CONTEXT_TOOL_NAMES,
  NATIVE_SUBAGENT_INTERCOM_TOOL_NAME,
  selectNativeSubagentChildContextToolNames,
} from "./child-tools.js";
export {
  NATIVE_SUBAGENT_FD_TOOL_NAME,
  NATIVE_SUBAGENT_FILE_TOOL_NAMES,
  NATIVE_SUBAGENT_RG_TOOL_NAME,
  registerNativeSubagentFileTools,
} from "./file-tools.js";
export { registerPiWendaoNativeSubagents } from "./register.js";
export { selectNativeSubagentActiveToolNames } from "./runner.js";
