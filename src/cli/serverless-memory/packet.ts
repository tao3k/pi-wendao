import {
  SERVERLESS_MEMORY_RECALL_PACKET_SCHEMA,
  type ServerlessMemoryLocator,
  type ServerlessMemoryMatchedOrgElement,
  type ServerlessMemoryObject,
  type ServerlessMemoryRecallPacket,
  type ServerlessMemoryRecallRow,
} from "./types.js";

export function parseServerlessMemoryRecallPacket(input: unknown): ServerlessMemoryRecallPacket {
  const record = requireRecord(input, "recall packet");
  const schema = requireString(record.schema, "recall packet schema");
  if (schema !== SERVERLESS_MEMORY_RECALL_PACKET_SCHEMA) {
    throw new Error(`unsupported serverless memory recall packet schema: ${schema}`);
  }
  const transport = requireString(record.transport, "recall packet transport");
  const rows = requireArray(record.rows, "recall packet rows")
    .map((row, index) => parseRecallRow(row, index + 1))
    .filter((row) => row.memoryObjects.length > 0);
  return { schema: SERVERLESS_MEMORY_RECALL_PACKET_SCHEMA, transport, rows };
}

function parseRecallRow(input: unknown, index: number): ServerlessMemoryRecallRow {
  const record = requireRecord(input, `recall packet row ${index}`);
  const orgid = requireString(record.orgid, `recall packet row ${index} orgid`);
  return {
    locator: parseSectionLocator(record.locator, orgid),
    orgid,
    title: requireString(record.title, `recall packet row ${index} title`),
    source: requireString(record.source, `recall packet row ${index} source`),
    sourceLine: requireNumber(record.sourceLine, `recall packet row ${index} sourceLine`),
    sourceRangeStart:
      optionalNumber(record.sourceRangeStart) ??
      requireNumber(record.sourceLine, `recall packet row ${index} sourceLine`),
    sourceRangeEnd:
      optionalNumber(record.sourceRangeEnd) ??
      requireNumber(record.sourceLine, `recall packet row ${index} sourceLine`),
    matchedOrgElements: optionalArray(record.matchedOrgElements)
      .map((element, elementIndex) => parseMatchedOrgElement(element, index, elementIndex + 1, orgid)),
    memoryObjects: requireArray(record.memoryObjects, `recall packet row ${index} memoryObjects`)
      .map((object, objectIndex) => parseMemoryObject(object, index, objectIndex + 1, orgid))
      .filter((object) => object.value.trim().length > 0),
  };
}

function parseMatchedOrgElement(
  input: unknown,
  rowIndex: number,
  elementIndex: number,
  orgid: string,
): ServerlessMemoryMatchedOrgElement {
  const label = `recall packet row ${rowIndex} matched org element ${elementIndex}`;
  const record = requireRecord(input, label);
  const affiliatedName = typeof record.affiliatedName === "string" ? record.affiliatedName : undefined;
  const language = typeof record.language === "string" ? record.language : undefined;
  return {
    locator: parseOrgElementLocator(record.locator, orgid, label),
    ordinal: requireNumber(record.ordinal, `${label} ordinal`),
    category: requireString(record.category, `${label} category`),
    kind: requireString(record.kind, `${label} kind`),
    ...(affiliatedName ? { affiliatedName } : {}),
    context: requireString(record.context, `${label} context`),
    summary: record.summary,
    ...(language ? { language } : {}),
    sourceLine: requireNumber(record.sourceLine, `${label} sourceLine`),
    sourceRangeStart: requireNumber(record.sourceRangeStart, `${label} sourceRangeStart`),
    sourceRangeEnd: requireNumber(record.sourceRangeEnd, `${label} sourceRangeEnd`),
    sourceRaw: requireString(record.sourceRaw, `${label} sourceRaw`),
  };
}

function parseMemoryObject(
  input: unknown,
  rowIndex: number,
  objectIndex: number,
  orgid: string,
): ServerlessMemoryObject {
  const label = `recall packet row ${rowIndex} memory object ${objectIndex}`;
  const record = requireRecord(input, label);
  const sourceKind = requireString(record.sourceKind, `${label} sourceKind`);
  const sourceKey = requireString(record.sourceKey, `${label} sourceKey`);
  return {
    index: requireNumber(record.index, `${label} index`),
    locator: parseMemoryObjectLocator(record.locator, sourceKind, sourceKey, objectIndex, orgid),
    kind: requireString(record.kind, `${label} kind`),
    facet: requireString(record.facet, `${label} facet`),
    sourceKind,
    sourceKey,
    question: requireString(record.question, `${label} question`),
    value: requireString(record.value, `${label} value`),
  };
}

function parseSectionLocator(input: unknown, orgid: string): ServerlessMemoryLocator {
  if (!input) return defaultSectionLocator(orgid);
  const record = requireRecord(input, "recall packet section locator");
  const section = requireRecord(record.section, "recall packet section locator section");
  return {
    schema: requireLocatorSchema(record.schema),
    section: {
      kind: "org-section",
      orgid: requireString(section.orgid, "recall packet section locator orgid"),
      ...(typeof section.title === "string" ? { title: section.title } : {}),
      ...(typeof section.source === "string" ? { source: section.source } : {}),
      ...(Array.isArray(section.outline) && section.outline.every((item) => typeof item === "string")
        ? { outline: section.outline }
        : {}),
    },
  };
}

function parseMemoryObjectLocator(
  input: unknown,
  sourceKind: string,
  sourceKey: string,
  objectIndex: number,
  orgid: string,
): ServerlessMemoryLocator {
  if (!input) {
    return {
      schema: "xiuxian_wendao.org_memory_locator.v1",
      section: { kind: "org-section", orgid },
      object: {
        kind: sourceKind === "reflection" ? "org-reflection-row" : "org-property",
        sourceKind,
        sourceKey,
        objectIndex,
      },
    };
  }
  const record = requireRecord(input, "recall packet memory object locator");
  const section = requireRecord(record.section, "recall packet memory object locator section");
  const object = requireRecord(record.object, "recall packet memory object locator object");
  return {
    schema: requireLocatorSchema(record.schema),
    section: {
      kind: "org-section",
      orgid: requireString(section.orgid, "recall packet memory object locator orgid"),
    },
    object: {
      kind: requireString(object.kind, "recall packet memory object locator object kind"),
      sourceKind: requireString(
        object.sourceKind,
        "recall packet memory object locator object sourceKind",
      ),
      sourceKey: requireString(
        object.sourceKey,
        "recall packet memory object locator object sourceKey",
      ),
      objectIndex: requireNumber(
        object.objectIndex,
        "recall packet memory object locator object objectIndex",
      ),
    },
  };
}

function parseOrgElementLocator(
  input: unknown,
  orgid: string,
  label: string,
): ServerlessMemoryLocator {
  const record = requireRecord(input, `${label} locator`);
  const section = requireRecord(record.section, `${label} locator section`);
  const element = requireRecord(record.orgElement, `${label} locator orgElement`);
  const query = isRecord(element.query) ? element.query : undefined;
  const sourceLine = optionalNumber(element.sourceLine);
  const sourceRangeStart = optionalNumber(element.sourceRangeStart);
  const sourceRangeEnd = optionalNumber(element.sourceRangeEnd);
  return {
    schema: requireLocatorSchema(record.schema),
    section: {
      kind: "org-section",
      orgid: requireString(section.orgid, `${label} locator section orgid`),
    },
    orgElement: {
      kind: "org-element",
      category: requireString(element.category, `${label} locator orgElement category`),
      type: requireString(element.type, `${label} locator orgElement type`),
      context: requireString(element.context, `${label} locator orgElement context`),
      ordinal: requireNumber(element.ordinal, `${label} locator orgElement ordinal`),
      ...(typeof element.source === "string" ? { source: element.source } : {}),
      ...(sourceLine !== undefined ? { sourceLine } : {}),
      ...(sourceRangeStart !== undefined ? { sourceRangeStart } : {}),
      ...(sourceRangeEnd !== undefined ? { sourceRangeEnd } : {}),
      ...(query
        ? {
            query: {
              engine: requireString(query.engine, `${label} locator orgElement query engine`),
              table: requireString(query.table, `${label} locator orgElement query table`),
              sourcePath: requireString(
                query.sourcePath,
                `${label} locator orgElement query sourcePath`,
              ),
              ordinal: requireNumber(query.ordinal, `${label} locator orgElement query ordinal`),
            },
          }
        : {}),
    },
  };
}

function defaultSectionLocator(orgid: string): ServerlessMemoryLocator {
  return {
    schema: "xiuxian_wendao.org_memory_locator.v1",
    section: {
      kind: "org-section",
      orgid,
    },
  };
}

function requireLocatorSchema(input: unknown): "xiuxian_wendao.org_memory_locator.v1" {
  const schema = requireString(input, "recall packet locator schema");
  if (schema !== "xiuxian_wendao.org_memory_locator.v1") {
    throw new Error(`unsupported serverless memory locator schema: ${schema}`);
  }
  return schema;
}

function requireRecord(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function requireArray(input: unknown, label: string): unknown[] {
  if (!Array.isArray(input)) {
    throw new Error(`${label} must be an array`);
  }
  return input;
}

function optionalArray(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [];
}

function requireString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return input;
}

function requireNumber(input: unknown, label: string): number {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    throw new Error(`${label} must be a finite number`);
  }
  return input;
}

function optionalNumber(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
