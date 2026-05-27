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
import {
  WENDAO_ARROW_TABLE_METADATA_KEY,
  arrowSchemaContract,
  float64ArrowColumn,
  int64ArrowColumn,
  int64Column,
  tableFromArrowColumns,
  utf8ArrowColumn,
  utf8Column,
  validateArrowTableSchema,
} from "../src/arrow/schema.js";

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

  it("builds and validates metadata-backed Arrow schema contracts", () => {
    const contract = arrowSchemaContract("search_strategy_flow_query_understanding", [
      utf8ArrowColumn("flow_id"),
      int64ArrowColumn("recommended_loop_budget"),
    ]);

    const table = tableFromArrowColumns(contract, {
      flow_id: utf8Column(["flow-1"]),
      recommended_loop_budget: int64Column([3]),
    });

    expect(table.schema.metadata.get(WENDAO_ARROW_TABLE_METADATA_KEY)).toBe(
      "search_strategy_flow_query_understanding",
    );
    expect(() => validateArrowTableSchema(table, contract)).not.toThrow();
    const decoded = decodeArrowIpcTable(encodeArrowIpcTable(table));
    expect(() => validateArrowTableSchema(decoded, contract)).not.toThrow();
    expect(decoded.getChild("recommended_loop_budget")?.get(0)).toBe(3n);
  });

  it("rejects Arrow tables with schema drift before row decoding", () => {
    const contract = arrowSchemaContract("search_strategy_flow_query_understanding", [
      utf8ArrowColumn("flow_id"),
      int64ArrowColumn("recommended_loop_budget"),
    ]);
    const drifted = tableFromArrowColumns(
      arrowSchemaContract("search_strategy_flow_query_understanding", [
        utf8ArrowColumn("flow_id"),
        float64ArrowColumn("recommended_loop_budget"),
      ]),
      {
        flow_id: utf8Column(["flow-1"]),
        recommended_loop_budget: tableFromArrays({
          value: [3.5],
        }).getChild("value"),
      },
    );

    expect(() => validateArrowTableSchema(drifted, contract)).toThrow(
      "recommended_loop_budget expected Int64",
    );
  });

  it("accepts dictionary-encoded UTF-8 columns as logical text columns", () => {
    const contract = arrowSchemaContract("attachment_fixture", [utf8ArrowColumn("sourcePath")], {
      requireTableMetadata: false,
    });

    const table = tableFromArrays({ sourcePath: ["docs/live.md"] });

    expect(() =>
      validateArrowTableSchema(table, contract, {
        columnMode: "required",
        requireTableMetadata: false,
      }),
    ).not.toThrow();
  });
});
