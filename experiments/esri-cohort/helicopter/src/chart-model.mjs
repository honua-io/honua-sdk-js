// Normalized from chart 1771976572578 in ArcGIS item
// 1b496d1b79fd4344ab548a1f2399c5fa, captured SHA-256
// c9baf813cdd54a9aa5c3b4f887c120806cfacbb1f7e4bde681eb265ee3331ec3.
export const FLIGHT_CHART = Object.freeze({
  field: "start_t",
  intervalMilliseconds: 6 * 60 * 1000,
  alignment: "equalIntervalsFromStartTime",
  trimIncompleteTimeInterval: true,
  nullPolicy: "null",
});

/** Build the source chart's complete intervals from a reconciled, fully loaded
 * aircraft selection. COUNT produces zero for empty intervals (confirmed in the
 * original N945RF chart despite its saved nullPolicy); trimmed records remain
 * selectable in the map and individual-record list. */
export function flightChart(records) {
  const identities = new Set();
  for (const record of records) {
    if (!Number.isSafeInteger(record.timestamp) || !record.id || identities.has(record.id))
      throw new Error("Flight chart records require finite epoch timestamps and unique identities.");
    identities.add(record.id);
  }
  if (!records.length) return { start: null, end: null, bins: [], trimmed: 0 };
  const timestamps = records.map((record) => record.timestamp);
  const start = Math.min(...timestamps);
  const maximum = Math.max(...timestamps);
  const size = FLIGHT_CHART.intervalMilliseconds;
  const length = Math.floor((maximum - start) / size);
  if (length > 10_000) throw new Error("Flight chart exceeds the reviewed interval budget.");
  const bins = Array.from({ length }, (_, index) => ({
    start: start + index * size,
    end: start + (index + 1) * size,
    count: 0,
    ids: [],
  }));
  let trimmed = 0;
  for (const record of records) {
    const index = Math.floor((record.timestamp - start) / size);
    if (index >= bins.length) {
      trimmed++;
      continue;
    }
    bins[index].ids.push(record.id);
    bins[index].count++;
  }
  return { start, end: start + length * size, bins, trimmed };
}
