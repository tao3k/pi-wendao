import type { PiWendaoHostWorkKind, PiWendaoQianjiCheckpointFeedback } from "./agent-host.js";
import { isObject } from "./data.js";
import { isQianjiTraceEvent } from "./qianji-report.js";
import type {
  QianjiHostWork,
  QianjiHumanTaskAssignment,
  QianjiHumanTaskChoice,
  QianjiHumanTaskForm,
  QianjiHumanTaskFreeText,
  QianjiHumanTaskResourceRole,
  QianjiTraceEvent,
} from "./qianji-types.js";

export function consumeQianjiStdoutChunk(
  chunk: string,
  onTraceEvent: (event: QianjiTraceEvent) => void,
): {
  visibleOutput: string;
  remainder: string;
  streamedTrace: boolean;
  hostWork: QianjiHostWork[];
} {
  const lines = chunk.split("\n");
  const remainder = lines.pop() ?? "";
  let visibleOutput = "";
  let streamedTrace = false;
  const hostWork: QianjiHostWork[] = [];
  for (const line of lines) {
    const traceEvent = parseQianjiTraceStreamLine(line);
    if (traceEvent) {
      onTraceEvent(traceEvent);
      streamedTrace = true;
      continue;
    }
    const work = parseQianjiHostWorkStreamLine(line);
    if (work) {
      hostWork.push(work);
      continue;
    }
    visibleOutput += `${line}\n`;
  }
  return { visibleOutput, remainder, streamedTrace, hostWork };
}

export function parseQianjiTraceStreamLine(line: string): QianjiTraceEvent | undefined {
  const prefix = "@@QIANJI_TRACE ";
  if (!line.startsWith(prefix)) return undefined;
  try {
    const parsed = JSON.parse(line.slice(prefix.length)) as unknown;
    return isQianjiTraceEvent(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function parseQianjiHostWorkStreamLine(line: string): QianjiHostWork | undefined {
  const prefix = "@@QIANJI_HOST_WORK ";
  if (!line.startsWith(prefix)) return undefined;
  try {
    const parsed = JSON.parse(line.slice(prefix.length)) as unknown;
    return isQianjiHostWork(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface QianjiHostSessionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outcome?: string;
  checkpoint?: PiWendaoQianjiCheckpointFeedback;
  pendingHostWork?: number;
  variables?: Record<string, unknown>;
}

export function parseQianjiHostSessionResultLine(
  line: string,
): QianjiHostSessionResult | undefined {
  const prefix = "@@QIANJI_SESSION_RESULT ";
  if (!line.startsWith(prefix)) return undefined;
  try {
    const parsed = JSON.parse(line.slice(prefix.length)) as unknown;
    if (!isObject(parsed)) return undefined;
    const exitCode = parsed.exitCode;
    if (exitCode !== null && typeof exitCode !== "number") return undefined;
    const pendingHostWork =
      typeof parsed.pendingHostWork === "number" && Number.isFinite(parsed.pendingHostWork)
        ? parsed.pendingHostWork
        : undefined;
    const checkpoint = parseQianjiHostSessionCheckpoint(parsed.checkpoint, pendingHostWork);
    return {
      exitCode,
      stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
      stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
      ...(typeof parsed.outcome === "string" && parsed.outcome ? { outcome: parsed.outcome } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(pendingHostWork !== undefined ? { pendingHostWork } : {}),
      ...(isObject(parsed.variables) ? { variables: parsed.variables } : {}),
    };
  } catch {
    return undefined;
  }
}

export function parseQianjiHostSessionCheckpoint(
  value: unknown,
  pendingHostWork: number | undefined,
): PiWendaoQianjiCheckpointFeedback | undefined {
  if (!isObject(value)) return undefined;
  const checkpoint: PiWendaoQianjiCheckpointFeedback = {
    ...(readStringField(value, "outcome") ? { outcome: readStringField(value, "outcome") } : {}),
    ...(readStringField(value, "backend") ? { backend: readStringField(value, "backend") } : {}),
    ...(readStringField(value, "source") ? { source: readStringField(value, "source") } : {}),
    ...(readStringField(value, "saved") ? { saved: readStringField(value, "saved") } : {}),
    ...(readStringField(value, "deleted") ? { deleted: readStringField(value, "deleted") } : {}),
    ...(readStringField(value, "status") ? { status: readStringField(value, "status") } : {}),
    ...(readStringField(value, "pendingHostWork")
      ? { pendingHostWork: readStringField(value, "pendingHostWork") }
      : {}),
  };
  if (!checkpoint.pendingHostWork && pendingHostWork !== undefined) {
    checkpoint.pendingHostWork = String(pendingHostWork);
  }
  return Object.keys(checkpoint).length > 0 ? checkpoint : undefined;
}

export function readStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

export function isBrokenPipeError(error: unknown): boolean {
  return isObject(error) && error.code === "EPIPE";
}

export function isQianjiHostWork(value: unknown): value is QianjiHostWork {
  if (!isObject(value)) return false;
  if (!isPiWendaoHostWorkKind(value.kind)) return false;
  if (value.process_id !== undefined && typeof value.process_id !== "string") return false;
  if (value.activity_id !== undefined && typeof value.activity_id !== "string") return false;
  if (typeof value.node_id !== "string" || !value.node_id.trim()) return false;
  if (typeof value.token_id !== "number" || !Number.isFinite(value.token_id)) return false;
  if (value.node_index !== undefined && typeof value.node_index !== "number") return false;
  if (value.variables !== undefined && value.variables !== null && !isObject(value.variables)) {
    return false;
  }
  if (value.form !== undefined && value.form !== null && !isQianjiHumanTaskForm(value.form)) {
    return false;
  }
  if (
    value.assignment !== undefined &&
    value.assignment !== null &&
    !isQianjiHumanTaskAssignment(value.assignment)
  ) {
    return false;
  }
  if (value.claim !== undefined && value.claim !== null && !isQianjiHostWorkClaim(value.claim)) {
    return false;
  }
  return true;
}

export function isQianjiHumanTaskForm(value: unknown): value is QianjiHumanTaskForm {
  return isQianjiHumanTaskFormInternal(value);
}

function isQianjiHumanTaskFormInternal(value: unknown): value is QianjiHumanTaskForm {
  if (!isObject(value)) return false;
  if (typeof value.interaction_type !== "string" || !value.interaction_type.trim()) return false;
  if (!isOptionalString(value.question_ref)) return false;
  if (!isOptionalString(value.question_text)) return false;
  if (!isOptionalString(value.choices_ref)) return false;
  if (!isOptionalString(value.result_output)) return false;
  if (value.choices !== undefined && value.choices !== null) {
    if (!Array.isArray(value.choices)) return false;
    if (!value.choices.every(isQianjiHumanTaskChoice)) return false;
  }
  if (value.free_text_fields !== undefined && value.free_text_fields !== null) {
    if (!Array.isArray(value.free_text_fields)) return false;
    if (!value.free_text_fields.every(isQianjiHumanTaskFreeText)) return false;
  }
  return true;
}

export function isQianjiHumanTaskChoice(value: unknown): value is QianjiHumanTaskChoice {
  return (
    isObject(value) &&
    typeof value.value === "string" &&
    value.value.trim().length > 0 &&
    isOptionalString(value.label) &&
    isOptionalString(value.description)
  );
}

export function isQianjiHumanTaskFreeText(value: unknown): value is QianjiHumanTaskFreeText {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    typeof value.optional === "boolean"
  );
}

export function isQianjiHumanTaskAssignment(value: unknown): value is QianjiHumanTaskAssignment {
  if (!isObject(value)) return false;
  if (value.human_performers !== undefined && value.human_performers !== null) {
    if (!Array.isArray(value.human_performers)) return false;
    if (!value.human_performers.every(isQianjiHumanTaskResourceRole)) return false;
  }
  if (value.potential_owners !== undefined && value.potential_owners !== null) {
    if (!Array.isArray(value.potential_owners)) return false;
    if (!value.potential_owners.every(isQianjiHumanTaskResourceRole)) return false;
  }
  return true;
}

export function isQianjiHumanTaskResourceRole(
  value: unknown,
): value is QianjiHumanTaskResourceRole {
  if (!isObject(value)) return false;
  if (!isOptionalString(value.name)) return false;
  if (!isOptionalString(value.resource_ref)) return false;
  if (!isOptionalString(value.assignment_expression)) return false;
  return true;
}

export function isQianjiHostWorkClaim(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.claimant === "string" &&
    value.claimant.trim().length > 0 &&
    (value.claimed_at_ms === undefined ||
      value.claimed_at_ms === null ||
      (typeof value.claimed_at_ms === "number" && Number.isFinite(value.claimed_at_ms)))
  );
}

export function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

export function isPiWendaoHostWorkKind(value: unknown): value is PiWendaoHostWorkKind {
  return typeof value === "string" && PI_WENDAO_HOST_WORK_KINDS.has(value as PiWendaoHostWorkKind);
}

const PI_WENDAO_HOST_WORK_KINDS = new Set<PiWendaoHostWorkKind>([
  "send",
  "service",
  "script",
  "user",
  "manual",
  "business_rule",
]);

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
