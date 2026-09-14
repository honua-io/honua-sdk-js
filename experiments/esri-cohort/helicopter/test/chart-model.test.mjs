import assert from "node:assert/strict";
import test from "node:test";
import { flightChart } from "../src/chart-model.mjs";

test("aligns to the first source timestamp, counts empty intervals as zero, and trims the incomplete tail", () => {
  const start = Date.parse("2025-01-11T00:02:30Z");
  const records = [0, 1, 12, 19].map((minute, index) => ({ id: String(index), timestamp: start + minute * 60_000 }));
  const chart = flightChart(records);
  assert.equal(chart.start, start);
  assert.equal(chart.end, start + 18 * 60_000);
  assert.deepEqual(
    chart.bins.map((bin) => bin.count),
    [2, 0, 1],
  );
  assert.deepEqual(
    chart.bins.map((bin) => bin.ids),
    [["0", "1"], [], ["2"]],
  );
  assert.equal(chart.trimmed, 1);
  assert.equal(chart.bins.flatMap((bin) => bin.ids).length + chart.trimmed, records.length);
});

test("timestamps at a six-minute boundary enter the following interval", () => {
  const chart = flightChart([0, 6, 12, 13].map((minute) => ({ id: String(minute), timestamp: minute * 60_000 })));
  assert.deepEqual(
    chart.bins.map((bin) => bin.ids),
    [["0"], ["6"]],
  );
  assert.equal(chart.trimmed, 2);
});

test("a selection shorter than one complete interval keeps no misleading partial count", () => {
  assert.deepEqual(flightChart([{ id: "one", timestamp: 1000 }]), { start: 1000, end: 1000, bins: [], trimmed: 1 });
  assert.deepEqual(flightChart([]), { start: null, end: null, bins: [], trimmed: 0 });
});

test("rejects invalid timestamps, duplicate identities, and excessive spans", () => {
  assert.throws(() => flightChart([{ id: "bad", timestamp: Number.NaN }]));
  assert.throws(() =>
    flightChart([
      { id: "same", timestamp: 0 },
      { id: "same", timestamp: 1 },
    ]),
  );
  assert.throws(() =>
    flightChart([
      { id: "first", timestamp: 0 },
      { id: "last", timestamp: 400_000_000_000 },
    ]),
  );
});
