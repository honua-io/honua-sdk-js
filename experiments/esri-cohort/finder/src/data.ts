import { createHonua } from "@honua/sdk-js";
import { esriGeometryToGeoJSON } from "@honua/sdk-js/honua";
import type { Feature, FeatureCollection, Geometry } from "geojson";

export type Attributes = Record<string, unknown>;
export type Venue = Feature<Geometry, Attributes>;
export const COLORS = [
  "#e6194b",
  "#3cb44b",
  "#4363d8",
  "#f58231",
  "#911eb4",
  "#14c9c9",
  "#f032e6",
  "#5e7618",
  "#fabebe",
  "#008080",
];
export const field = (feature: Venue, name: string) => String(feature.properties[name] ?? "");

// Every dependency must be explicitly bound to this run's import receipt.
// There is no implicit ArcGIS operational fallback.
const endpoints = [import.meta.env.VITE_VENUES_URL, import.meta.env.VITE_BUFFER2_URL, import.meta.env.VITE_BUFFER5_URL];
export async function loadData(
  signal: AbortSignal,
  onProgress: (message: string) => void,
): Promise<FeatureCollection<Geometry, Attributes>[]> {
  if (endpoints.some((url) => !url))
    throw new Error("Bind the venue, two-mile and five-mile layer URLs before starting this app.");
  const honua = createHonua();
  try {
    const collections: FeatureCollection<Geometry, Attributes>[] = [];
    for (const [index, endpoint] of endpoints.entries()) {
      const label = ["venues", "two-mile buffer", "five-mile buffer"][index];
      onProgress(`Connecting to ${label}…`);
      const connection = await honua.connect(
        { url: new URL(endpoint, location.origin), protocol: "geoservices-feature-service" },
        { signal },
      );
      const inspection = await connection.inspect({ signal });
      const sourceId = inspection.defaultSourceId ?? inspection.sources[0]?.descriptor.id;
      if (!sourceId) throw new Error("No queryable layer advertised");
      onProgress(`Loading ${label}…`);
      const result = await connection.query(
        { outFields: ["*"], returnGeometry: true, outSr: 4326, pagination: { limit: 100 } },
        { sourceId, signal },
      );
      if (result.exceededTransferLimit || result.degraded?.length)
        throw new Error("Incomplete layer result; reconcile the source profile before increasing the query budget.");
      const features = result.features.map((feature): Venue => {
        const properties = Object.fromEntries(
          Object.entries(feature.attributes).map(([key, value]) => [key.toLowerCase(), value]),
        );
        const geometry = esriGeometryToGeoJSON(feature.geometry);
        if (!geometry) throw new Error("Missing or unconvertible geometry");
        const id = properties.objectid ?? properties.fid ?? properties.id;
        if (typeof id !== "number" && typeof id !== "string") throw new Error("Missing stable feature identity");
        properties.__honua_id = String(id);
        return {
          type: "Feature",
          id: String(id),
          properties,
          geometry: geometry as Geometry,
        };
      });
      if (new Set(features.map((feature) => feature.id)).size !== features.length)
        throw new Error("Duplicate feature identity in layer result");
      collections.push({ type: "FeatureCollection", features });
    }
    return collections;
  } finally {
    await honua.dispose();
  }
}
