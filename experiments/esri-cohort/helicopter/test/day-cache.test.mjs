import assert from "node:assert/strict";
import test from "node:test";
import { createDayCache } from "../src/day-cache.mjs";

test("expires snapshots from their load time, even when revisited", () => {
  const cache = createDayCache({ ttlMs: 100 });
  const rows = { features: [1, 2] };
  cache.set("day", rows, 2, 10);
  assert.equal(cache.get("day", 109), rows);
  assert.equal(cache.get("day", 110), undefined);
});

test("evicts least recently used days to respect the total record budget", () => {
  const cache = createDayCache({ maxRecords: 10 });
  cache.set("a", "a", 4);
  cache.set("b", "b", 4);
  assert.equal(cache.get("a"), "a");
  cache.set("c", "c", 4);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "a");
  assert.equal(cache.get("c"), "c");
});

test("bounds day count and rejects oversized or invalid snapshots", () => {
  const cache = createDayCache({ maxEntries: 2, maxRecords: 10 });
  cache.set("a", 1, 1);
  cache.set("b", 2, 1);
  cache.set("c", 3, 1);
  assert.equal(cache.get("a"), undefined);
  for (const records of [11, -1, Number.NaN, 1.5]) {
    cache.set("invalid", 4, records);
    assert.equal(cache.get("invalid"), undefined);
  }
});

test("refresh invalidates a day without discarding other completed days", () => {
  const cache = createDayCache();
  cache.set("a", 1, 1);
  cache.set("b", 2, 1);
  cache.delete("a");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  cache.set("a", 3, 1);
  assert.equal(cache.get("a"), 3);
});
