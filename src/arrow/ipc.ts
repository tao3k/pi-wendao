import { tableFromIPC, tableToIPC, type Table } from "apache-arrow";
import { assertAllowedArrowPayloadEncoding } from "./boundary.js";
export { validateArrowTableSchema } from "./schema.js";
export type { ArrowSchemaContract, ArrowSchemaValidationOptions } from "./schema.js";

declare const arrowIpcColumnNameBrand: unique symbol;

export type ArrowIpcColumnName = string & {
  readonly [arrowIpcColumnNameBrand]: "ArrowIpcColumnName";
};

export type ArrowIpcEncoding = "stream" | "file";

/**
 * Decode raw Arrow IPC bytes returned by backend-owned Arrow routes.
 *
 * JSON/base64 envelopes are intentionally not supported here; SearchStrategyFlow
 * control channels may coordinate a request, but table payloads stay Arrow
 * bytes from the Flight/IPC data plane.
 */
export function decodeArrowIpcTable(payload: Uint8Array): Table {
  return tableFromIPC(payload);
}

export function encodeArrowIpcTable(
  table: Table,
  encoding: ArrowIpcEncoding = "stream",
): Uint8Array {
  assertAllowedArrowPayloadEncoding(encoding);
  return tableToIPC(table, encoding);
}

export function assertArrowIpcColumns(
  table: Pick<Table, "schema">,
  requiredColumns: readonly (ArrowIpcColumnName | string)[],
): void {
  const availableColumns = new Set(table.schema.fields.map((field) => field.name));
  const missingColumns = requiredColumns.filter((column) => !availableColumns.has(column));
  if (missingColumns.length > 0) {
    throw new Error(`Arrow IPC table is missing required column(s): ${missingColumns.join(", ")}`);
  }
}
