export function createDayCache<T>(options?: {
  maxEntries?: number;
  maxRecords?: number;
  ttlMs?: number;
}): {
  get(key: string, now?: number): T | undefined;
  set(key: string, value: T, records: number, now?: number): void;
  delete(key: string): void;
};
