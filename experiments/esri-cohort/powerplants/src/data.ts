import { createHonua } from "@honua/sdk-js";
import { esriGeometryToGeoJSON } from "@honua/sdk-js/honua";
import type { FeatureCollection, Point } from "geojson";
import { mergeFuelCounts, normalizeFuel } from "./model.js";

export interface Plant {
  id: string;
  name: string;
  fuel: string;
  capacity: number | null;
  generation: number | null;
  country: string;
}
export interface PlantData {
  geojson: FeatureCollection<Point, Plant>;
  counts: { fuel: string; count: number }[];
}
export const FUELS = [
  "hydro",
  "solar",
  "wind",
  "gas",
  "oil",
  "coal",
  "biomass",
  "cogeneration",
  "geothermal",
  "nuclear",
  "other",
  "petcoke",
  "storage",
  "waste",
  "waveandtidal",
];
export const COLORS = [
  "#fb9a99",
  "#1f78b4",
  "#e31a1c",
  "#b2df8a",
  "#fdbf6f",
  "#a6cee3",
  "#1f78b4",
  "#33a02c",
  "#e31a1c",
  "#ff7f00",
  "#6a3d9a",
  "#cab2d6",
  "#a6cee3",
  "#33a02c",
  "#b2df8a",
];
export const RENEWABLE = new Set([
  "hydro",
  "solar",
  "wind",
  "biomass",
  "geothermal",
  "waveandtidal",
  "cogeneration",
  "storage",
]);
const finiteOrNull = (value: unknown) =>
  value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

export async function loadPlants(signal: AbortSignal, progress: (message: string) => void): Promise<PlantData> {
  const endpoint = import.meta.env.VITE_POWERPLANTS_URL;
  if (!endpoint) throw new Error("Bind this run's imported powerplants layer URL before starting the dashboard.");
  const honua = createHonua();
  try {
    progress("Discovering power plant data…");
    const connection = await honua.connect(
      { url: new URL(endpoint, location.origin), protocol: "geoservices-feature-service" },
      { signal },
    );
    const source = connection.source();
    const fields = source.descriptor.schema?.fields ?? [];
    const fuelField = fields.find((field) => field.name.toLowerCase() === "fuel1")?.name;
    const primaryKey =
      source.descriptor.schema?.primaryKey ?? fields.find((field) => field.name.toLowerCase() === "objectid")?.name;
    if (!fuelField || !primaryKey) throw new Error("Source schema is missing fuel or feature identity");
    const totals = await source.queryAggregate({
      signal,
      returnGeometry: false,
      aggregation: { groupBy: [fuelField], metrics: [{ fn: "count", field: primaryKey, alias: "plant_count" }] },
    });
    if (totals.exceededTransferLimit || totals.degraded?.length || !totals.aggregateRows)
      throw new Error("Complete server fuel counts are required for reconciliation");
    const counts = mergeFuelCounts(totals.aggregateRows, fuelField);
    const expected = counts.reduce((sum, row) => sum + row.count, 0);
    if (expected > 35_000)
      throw new Error("Source exceeds the reviewed 35,000-plant budget; refresh the cohort profile");
    const geojson: PlantData["geojson"] = { type: "FeatureCollection", features: [] };
    const ids = new Set<string>();
    const actual = new Map<string, number>();
    for await (const page of source.stream({
      signal,
      outFields: ["*"],
      outSr: 4326,
      returnGeometry: true,
      orderBy: [{ field: primaryKey, direction: "asc" }],
      pagination: { limit: 1000 },
    })) {
      if (page.degraded?.length) throw new Error("Degraded page cannot establish complete plant metrics");
      for (const feature of page.features) {
        const attributes = Object.fromEntries(
          Object.entries(feature.attributes).map(([name, value]) => [name.toLowerCase(), value]),
        );
        const rawId = attributes[primaryKey.toLowerCase()];
        if (typeof rawId !== "number" && typeof rawId !== "string") throw new Error("Missing plant identity");
        const id = String(rawId);
        if (ids.has(id)) throw new Error("Repeated plant identity while paging");
        ids.add(id);
        const geometry = esriGeometryToGeoJSON(feature.geometry);
        if (!geometry || geometry.type !== "Point") throw new Error(`Plant ${id} has no point geometry`);
        const [x, y] = geometry.coordinates;
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90)
          throw new Error(`Plant ${id} is not in WGS84`);
        const fuel = normalizeFuel(attributes.fuel1);
        const properties: Plant = {
          id,
          fuel,
          name: String(attributes.name || "Unknown"),
          country: String(attributes.country_long || attributes.country || ""),
          capacity: finiteOrNull(attributes.capacity_mw),
          generation: finiteOrNull(attributes.estimated_generation_gwh),
        };
        geojson.features.push({ type: "Feature", id, properties, geometry: geometry as Point });
        actual.set(fuel, (actual.get(fuel) ?? 0) + 1);
      }
      progress(`Loaded ${geojson.features.length.toLocaleString()} of ${expected.toLocaleString()} power plants…`);
      if (geojson.features.length > expected || geojson.features.length > 35_000)
        throw new Error("Paged rows exceed the independent server count");
    }
    const differences = counts.filter((row) => actual.get(row.fuel) !== row.count);
    if (geojson.features.length !== expected || differences.length)
      throw new Error(
        `Paged plants do not reconcile to server fuel counts: ${differences.map((row) => `${row.fuel}: ${actual.get(row.fuel) ?? 0} loaded, ${row.count} expected`).join("; ")}`,
      );
    return { geojson, counts };
  } finally {
    await honua.dispose();
  }
}
