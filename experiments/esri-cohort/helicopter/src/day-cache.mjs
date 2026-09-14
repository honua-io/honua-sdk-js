// These imported snapshots are stable during exploration. Refresh bypasses the
// short-lived session cache; never persist feature data in browser storage.
export function createDayCache({ maxEntries = 3, maxRecords = 100_000, ttlMs = 300_000 } = {}) {
  const entries = new Map();
  return {
    get(key, now = Date.now()) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now - entry.created >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value, records, now = Date.now()) {
      entries.delete(key);
      if (!Number.isSafeInteger(records) || records < 0 || records > maxRecords) return;
      entries.set(key, { value, records, created: now });
      let total = [...entries.values()].reduce((sum, entry) => sum + entry.records, 0);
      while (entries.size > maxEntries || total > maxRecords) {
        const oldest = entries.keys().next().value;
        total -= entries.get(oldest).records;
        entries.delete(oldest);
      }
    },
    delete(key) {
      entries.delete(key);
    },
  };
}
