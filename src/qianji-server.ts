/**
 * Stable package facade for qianji-server workflow-control integration.
 *
 * Package consumers should import qianji-server HTTP and external host-loop
 * contracts from `pi-wendao/qianji-server` instead of private executor files.
 */
export * from "./executor/qianji-server/http.js";
export {
  applyHostWorkFailureRecovery,
  loadHostWorkFailureDiagnostics,
} from "./executor/qianji-server/control-diagnostics.js";
export type {
  QianjiControlFailureDiagnostics,
  QianjiControlRecoveryApplyPolicy,
} from "./executor/qianji-server/control-diagnostics.js";
export {
  isQianjiServerWorkflowExecutionError,
  QianjiServerWorkflowExecutionError,
  runQianjiServerExternalHostLoop,
} from "./executor/qianji-server-workflow.js";
export type {
  QianjiServerExternalHostLoopOptions,
  QianjiServerExternalHostLoopOptionsDto,
} from "./executor/qianji-server-workflow.js";
