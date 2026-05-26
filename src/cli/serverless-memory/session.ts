import {
  PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE,
  SERVERLESS_MEMORY_RECALL_PACKET_SCHEMA,
  type AppendServerlessMemoryRecallOptions,
  type AppendServerlessMemoryRecallResult,
  type ServerlessMemoryLocator,
  type ServerlessMemoryObject,
  type ServerlessMemoryRecallDetails,
  type ServerlessMemoryRecallPacket,
  type ServerlessMemoryRecallRenderOptions,
  type ServerlessMemoryRecallRow,
} from "./types.js";

export function appendServerlessMemoryRecallPacket(
  options: AppendServerlessMemoryRecallOptions,
): AppendServerlessMemoryRecallResult {
  const content = renderServerlessMemoryRecallContent(options.packet, {
    maxRows: options.maxRows,
    maxObjectsPerRow: options.maxObjectsPerRow,
    render: options.render,
  });
  const details = serverlessMemoryRecallDetails(options.packet);
  const entryId = content.trim()
    ? options.sessionManager.appendCustomMessageEntry(
        PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE,
        content,
        options.display ?? false,
        details,
      )
    : undefined;
  return { entryId, content, details };
}

export function renderServerlessMemoryRecallContent(
  packet: ServerlessMemoryRecallPacket,
  options: {
    maxRows?: number;
    maxObjectsPerRow?: number;
    render?: ServerlessMemoryRecallRenderOptions;
  } = {},
): string {
  const rows = packet.rows.slice(0, options.maxRows ?? 8);
  const lines = [
    "[wendao memory recall]",
    `schema: ${SERVERLESS_MEMORY_RECALL_PACKET_SCHEMA}`,
    `transport: ${packet.transport}`,
  ];
  for (const row of rows) {
    lines.push(...renderRecallRow(row, options.maxObjectsPerRow ?? 4, options.render));
  }
  return lines.join("\n");
}

export function serverlessMemoryRecallDetails(
  packet: ServerlessMemoryRecallPacket,
): ServerlessMemoryRecallDetails {
  return {
    schema: SERVERLESS_MEMORY_RECALL_PACKET_SCHEMA,
    transport: packet.transport,
    rowCount: packet.rows.length,
    memoryObjectCount: packet.rows.reduce((count, row) => count + row.memoryObjects.length, 0),
    orgids: packet.rows.map((row) => row.orgid),
    sources: Array.from(new Set(packet.rows.map(formatRecallSourceRange))),
  };
}

function renderRecallRow(
  row: ServerlessMemoryRecallRow,
  maxObjects: number,
  render: ServerlessMemoryRecallRenderOptions = {},
): string[] {
  const includeMatchedOrgElements = render.includeMatchedOrgElements ?? true;
  const includeMemoryObjects = render.includeMemoryObjects ?? true;
  const lines = [
    "- memory row",
    `  orgid: ${row.orgid}`,
    `  locator: ${formatSectionLocator(row)}`,
    `  title: ${row.title}`,
    `  source_citation: ${formatRecallSourceCitation(row)}`,
  ];
  for (const element of includeMatchedOrgElements ? row.matchedOrgElements.slice(0, 3) : []) {
    lines.push(renderMatchedOrgElement(element));
  }
  for (const object of includeMemoryObjects ? row.memoryObjects.slice(0, maxObjects) : []) {
    lines.push(renderMemoryObject(object));
  }
  return lines;
}

function renderMatchedOrgElement(
  element: ServerlessMemoryRecallRow["matchedOrgElements"][number],
): string {
  return [
    `  org_element/${element.kind}: ${compactElementSource(element.sourceRaw)}`,
    `    locator: ${formatOrgElementLocator(element.locator)}`,
  ].join("\n");
}

function renderMemoryObject(object: ServerlessMemoryObject): string {
  return [
    `  ${object.kind}/${object.sourceKey}: ${object.value}`,
    `    locator: ${formatMemoryObjectLocator(object)}`,
  ].join("\n");
}

function formatRecallSourceRange(row: ServerlessMemoryRecallRow): string {
  return formatRecallSourceCitation(row);
}

function formatRecallSourceCitation(row: ServerlessMemoryRecallRow): string {
  return `${row.source}:${row.sourceLine}`;
}

function formatSectionLocator(row: ServerlessMemoryRecallRow): string {
  return `org-section orgid=${row.locator.section.orgid}`;
}

function formatMemoryObjectLocator(object: ServerlessMemoryObject): string {
  const locator = object.locator.object;
  if (!locator) return `org-section orgid=${object.locator.section.orgid}`;
  return [
    `org-section orgid=${object.locator.section.orgid}`,
    `object=${locator.kind}`,
    `sourceKind=${locator.sourceKind}`,
    `sourceKey=${locator.sourceKey}`,
    `objectIndex=${locator.objectIndex}`,
  ].join(" ");
}

function formatOrgElementLocator(locator: ServerlessMemoryLocator): string {
  const element = locator.orgElement;
  if (!element) return `org-section orgid=${locator.section.orgid}`;
  return [
    `org-section orgid=${locator.section.orgid}`,
    `orgElement=${element.type}`,
    `category=${element.category}`,
    `ordinal=${element.ordinal}`,
    `sqlTable=${element.query?.table ?? "agent_org_elements"}`,
  ].join(" ");
}

function compactElementSource(source: string): string {
  return source.replace(/\s+/g, " ").trim().slice(0, 240);
}
