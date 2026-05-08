import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PiSubagentsRunRecord, PiSubagentsRunStore } from "./pi-subagents-host.js";

export function createInMemoryPiSubagentsRunStore(
  initialRecords: PiSubagentsRunRecord[] = [],
): PiSubagentsRunStore {
  const records = new Map(initialRecords.map((record) => [record.key, record]));
  return {
    async get(key) {
      return records.get(key);
    },
    async put(record) {
      records.set(record.key, record);
    },
  };
}

export function createJsonFilePiSubagentsRunStore(path: string): PiSubagentsRunStore {
  let queue = Promise.resolve();
  const withLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return {
    get: (key) =>
      withLock(async () => {
        const records = await readStoreFile(path);
        return records[key];
      }),
    put: (record) =>
      withLock(async () => {
        const records = await readStoreFile(path);
        records[record.key] = record;
        await writeStoreFile(path, records);
      }),
  };
}
interface PiSubagentsRunStoreFile {
  version: 1;
  records: Record<string, PiSubagentsRunRecord>;
}

async function readStoreFile(path: string): Promise<Record<string, PiSubagentsRunRecord>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    if (!isRunStoreFile(parsed)) return {};
    return parsed.records;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeStoreFile(
  path: string,
  records: Record<string, PiSubagentsRunRecord>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const file: PiSubagentsRunStoreFile = { version: 1, records };
  await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  await rename(tempPath, path);
}

function isRunStoreFile(value: unknown): value is PiSubagentsRunStoreFile {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { version?: unknown }).version === 1 &&
    typeof (value as { records?: unknown }).records === "object" &&
    (value as { records?: unknown }).records !== null &&
    !Array.isArray((value as { records?: unknown }).records)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}