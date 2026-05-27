import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Branded } from "../../types/domain.js";

export const SERVERLESS_MEMORY_RECALL_PACKET_SCHEMA =
  "xiuxian_wendao.serverless_memory_recall_packet.v1";

export const PI_WENDAO_MEMORY_RECALL_CUSTOM_TYPE = "wendao.memory.recall";

export type ServerlessMemorySourceKind = Branded<string, "ServerlessMemorySourceKind">;
export type ServerlessMemoryObjectKind = Branded<string, "ServerlessMemoryObjectKind">;
export type ServerlessMemoryOrgElementCategory = Branded<
  string,
  "ServerlessMemoryOrgElementCategory"
>;
export type ServerlessMemoryOrgElementType = Branded<string, "ServerlessMemoryOrgElementType">;

export interface ServerlessMemoryLocatorSection {
  kind: "org-section";
  orgid: string;
  title?: string;
  source?: string;
  outline?: string[];
}

export interface ServerlessMemoryLocatorObject {
  kind: "org-property" | "org-reflection-row" | string;
  sourceKind: ServerlessMemorySourceKind;
  sourceKey: string;
  objectIndex: number;
}

export interface ServerlessMemoryLocatorOrgElement {
  kind: "org-element";
  category: ServerlessMemoryOrgElementCategory;
  type: ServerlessMemoryOrgElementType;
  context: string;
  ordinal: number;
  source?: string;
  sourceLine?: number;
  sourceRangeStart?: number;
  sourceRangeEnd?: number;
  query?: {
    engine: string;
    table: string;
    sourcePath: string;
    ordinal: number;
  };
}

export interface ServerlessMemoryLocator {
  schema: "xiuxian_wendao.org_memory_locator.v1";
  section: ServerlessMemoryLocatorSection;
  object?: ServerlessMemoryLocatorObject;
  orgElement?: ServerlessMemoryLocatorOrgElement;
}

export interface ServerlessMemoryMatchedOrgElement {
  locator: ServerlessMemoryLocator;
  ordinal: number;
  category: ServerlessMemoryOrgElementCategory;
  kind: ServerlessMemoryObjectKind;
  affiliatedName?: string;
  context: string;
  summary: unknown;
  language?: string;
  sourceLine: number;
  sourceRangeStart: number;
  sourceRangeEnd: number;
  sourceRaw: string;
}

export interface ServerlessMemoryObject {
  index: number;
  locator: ServerlessMemoryLocator;
  kind: ServerlessMemoryObjectKind;
  facet: string;
  sourceKind: ServerlessMemorySourceKind;
  sourceKey: string;
  question: string;
  value: string;
}

export interface ServerlessMemoryRecallRow {
  locator: ServerlessMemoryLocator;
  orgid: string;
  title: string;
  source: string;
  sourceLine: number;
  sourceRangeStart: number;
  sourceRangeEnd: number;
  matchedOrgElements: ServerlessMemoryMatchedOrgElement[];
  memoryObjects: ServerlessMemoryObject[];
}

export interface ServerlessMemoryRecallPacket {
  schema: typeof SERVERLESS_MEMORY_RECALL_PACKET_SCHEMA;
  transport: string;
  rows: ServerlessMemoryRecallRow[];
}

export interface ServerlessMemoryRecallDetails {
  schema: typeof SERVERLESS_MEMORY_RECALL_PACKET_SCHEMA;
  transport: string;
  rowCount: number;
  memoryObjectCount: number;
  orgids: string[];
  sources: string[];
}

export interface AppendServerlessMemoryRecallOptions {
  sessionManager: SessionManager;
  packet: ServerlessMemoryRecallPacket;
  display?: boolean;
  maxRows?: number;
  maxObjectsPerRow?: number;
  render?: ServerlessMemoryRecallRenderOptions;
}

export interface AppendServerlessMemoryRecallResult {
  entryId: string | undefined;
  content: string;
  details: ServerlessMemoryRecallDetails;
}

export interface ServerlessMemoryRecallRenderOptions {
  includeMatchedOrgElements?: boolean;
  includeMemoryObjects?: boolean;
}
