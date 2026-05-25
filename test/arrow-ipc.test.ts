import { tableFromArrays } from "apache-arrow";
import { describe, expect, it } from "vitest";
import {
  assertArrowIpcColumns,
  decodeArrowIpcTable,
  encodeArrowIpcTable,
} from "../src/arrow/ipc.js";
import {
  assertAllowedArrowPayloadEncoding,
  WENDAO_ARROW_FLIGHT_DATA_PLANE,
  WENDAO_FORBIDDEN_ARROW_PAYLOAD_WRAPPERS,
} from "../src/arrow/boundary.js";

describe("Arrow IPC boundary", () => {
  it("round-trips a table through raw IPC bytes for JS Arrow consumers", () => {
    const encoded = encodeArrowIpcTable(
      tableFromArrays({
        request_id: ["flow-1"],
        selected_count: [2],
      }),
    );

    const decoded = decodeArrowIpcTable(encoded);

    assertArrowIpcColumns(decoded, ["request_id", "selected_count"]);
    expect(decoded.numRows).toBe(1);
    expect(decoded.getChild("request_id")?.get(0)).toBe("flow-1");
    expect(decoded.getChild("selected_count")?.get(0)).toBe(2);
  });

  it("rejects Arrow IPC tables that miss required data-plane columns", () => {
    const encoded = encodeArrowIpcTable(tableFromArrays({ request_id: ["flow-1"] }));
    const decoded = decodeArrowIpcTable(encoded);

    expect(() => assertArrowIpcColumns(decoded, ["request_id", "trace_row_kind"])).toThrow(
      "Arrow IPC table is missing required column(s): trace_row_kind",
    );
  });

  it("rejects JSON/base64 Arrow wrappers at the JS boundary", () => {
    const legacyTraceWrapper = ["trace", "Arrow", "Ipc", "Base64"].join("");

    expect(() => assertAllowedArrowPayloadEncoding(legacyTraceWrapper)).toThrow(
      `use ${WENDAO_ARROW_FLIGHT_DATA_PLANE} for table data`,
    );
    expect(() =>
      assertAllowedArrowPayloadEncoding(WENDAO_FORBIDDEN_ARROW_PAYLOAD_WRAPPERS[1]),
    ).toThrow("keep JSON/JSONL as control only");
    expect(() => assertAllowedArrowPayloadEncoding(WENDAO_ARROW_FLIGHT_DATA_PLANE)).not.toThrow();
  });
});
