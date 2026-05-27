export const DEFAULT_LIVE_QIANJI_CONCURRENCY = 3;

export async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) return [];
  const boundedConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = Array.from({ length: items.length }) as U[];
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: boundedConcurrency }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

export function normalizeLiveQianjiConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIVE_QIANJI_CONCURRENCY;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("--live-qianji-concurrency must be a positive integer");
  }
  return value;
}
