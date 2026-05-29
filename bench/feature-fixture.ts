/**
 * Deterministic synthetic feature dataset used by the stream/pagination
 * performance harness. The fixture is generated in-process so the benchmark
 * runs without a live Honua server and produces stable, repeatable numbers.
 *
 * Features mimic the canonical GeoServices FeatureServer shape
 * ({@link HonuaFeature}): an `attributes` bag plus an Esri point geometry.
 */
import type { HonuaFeature } from "../src/core/types.js";

/** Attribute shape for the synthetic incident features. */
export interface BenchFeatureAttributes {
  OBJECTID: number;
  STATUS: "OPEN" | "CLOSED" | "PENDING";
  CATEGORY: string;
  REPORTED_AT: number;
  PRIORITY: number;
  LABEL: string;
  // GeoServices attribute bags are open records; this index signature keeps the
  // fixture assignable to `HonuaFeature.attributes` (`Record<string, unknown>`).
  [key: string]: unknown;
}

const STATUSES: ReadonlyArray<BenchFeatureAttributes["STATUS"]> = ["OPEN", "CLOSED", "PENDING"];
const CATEGORIES = ["fire", "flood", "outage", "medical", "traffic", "hazmat"] as const;

// Fixed epoch so REPORTED_AT values are deterministic across runs.
const BASE_EPOCH_MS = 1_700_000_000_000;

/**
 * Build `count` deterministic features. The same `count` always yields byte-for-byte
 * identical features, so two harness runs over the same fixture are comparable.
 */
export function buildFeatureFixture(count: number): HonuaFeature[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`buildFeatureFixture: count must be a non-negative integer, got ${count}`);
  }
  const features: HonuaFeature[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const attributes: BenchFeatureAttributes = {
      OBJECTID: i + 1,
      STATUS: STATUSES[i % STATUSES.length],
      CATEGORY: CATEGORIES[i % CATEGORIES.length],
      REPORTED_AT: BASE_EPOCH_MS + i * 1_000,
      PRIORITY: (i % 5) + 1,
      // A modest string payload so each feature carries a realistic byte weight.
      LABEL: `incident-${(i + 1).toString().padStart(7, "0")}`,
    };
    features[i] = {
      attributes,
      geometry: {
        // Spread points across a deterministic lon/lat grid.
        x: -180 + ((i * 0.013) % 360),
        y: -85 + ((i * 0.007) % 170),
      },
    };
  }
  return features;
}
