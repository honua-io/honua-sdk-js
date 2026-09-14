import { buffer, geoJsonToEsri } from "@honua/geometry";
import type { GeoJsonGeometry } from "@honua/geometry";
import { HonuaClient, createHonua, polygon, queryFilter } from "@honua/sdk-js";
import type { Query, Source } from "@honua/sdk-js/contract";
import { esriGeometryToGeoJSON } from "@honua/sdk-js/honua";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { complaintDistanceRequest, matchingDistanceIds } from "./complaint-distance.mjs";
import type { ComplaintDistanceQuery, ComplaintRequester } from "./complaint-distance.mjs";

export type Attributes = Record<string, unknown>;
export type MapFeature = Feature<Geometry | null, Attributes>;
export type Collection = FeatureCollection<Geometry | null, Attributes>;
export type LayerName = "flights" | "complaints" | "census" | "summary";
export const EMPTY: FeatureCollection<Geometry, Attributes> = { type: "FeatureCollection", features: [] };
// Keep geometry-less rows in counts, selections and tables; only the renderer
// requires features with geometry.
export function renderable(collection: Collection): FeatureCollection<Geometry, Attributes> {
  return {
    type: "FeatureCollection",
    features: collection.features.filter(
      (feature): feature is Feature<Geometry, Attributes> => feature.geometry !== null,
    ),
  };
}
export const value = (row: Attributes, key: string): unknown =>
  Object.entries(row).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
export const label = (row: Attributes, key: string): string => String(value(row, key) ?? "");

export function field(source: Source, key: string): string {
  const name = source.descriptor.schema?.fields?.find(
    (candidate) => candidate.name.toLowerCase() === key.toLowerCase(),
  )?.name;
  if (!name) throw new Error(`The ${source.descriptor.id} layer is missing ${key}.`);
  return name;
}

export function nextDay(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("Choose a calendar date.");
  const instant = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== day)
    throw new Error("Invalid calendar date.");
  return new Date(instant.getTime() + 86_400_000).toISOString().slice(0, 10);
}

export function dayQuery(source: Source, key: string, day: string): Query {
  const name = field(source, key);
  return {
    filter: queryFilter.and(
      queryFilter.gte(name, key === "DateOfFlight" ? day : `${day}T00:00:00Z`),
      queryFilter.lt(name, key === "DateOfFlight" ? nextDay(day) : `${nextDay(day)}T00:00:00Z`),
    ),
  };
}

export interface Cohort {
  sources: Record<LayerName, Source>;
  queryComplaints: ComplaintRequester;
  dispose(): Promise<void>;
}

export async function connectCohort(signal: AbortSignal): Promise<Cohort> {
  const urls: Record<LayerName, string | undefined> = {
    flights: import.meta.env.VITE_FLIGHTS_URL,
    complaints: import.meta.env.VITE_COMPLAINTS_URL,
    census: import.meta.env.VITE_CENSUS_URL,
    summary: import.meta.env.VITE_SUMMARY_URL,
  };
  const honua = createHonua();
  try {
    const entries = await Promise.all(
      Object.entries(urls).map(async ([name, binding]) => {
        if (!binding) throw new Error(`Bind the imported ${name} layer before opening this app.`);
        const url = new URL(binding, location.origin);
        if (
          url.origin !== location.origin ||
          !/^\/rest\/services\/onboarding-heli-[a-z0-9-]+\/FeatureServer\/\d+$/.test(url.pathname) ||
          url.search ||
          url.hash
        )
          throw new Error("Helicopter data must use the reviewed local import bindings.");
        const dataset = await honua.connect({ url, protocol: "geoservices-feature-service" }, { signal });
        return [name, dataset.source()] as const;
      }),
    );
    const complaintPath = new URL(urls.complaints ?? "", location.origin).pathname.split("/");
    const client = new HonuaClient({ baseUrl: location.origin });
    return {
      sources: Object.fromEntries(entries) as Record<LayerName, Source>,
      queryComplaints: (request) =>
        client.queryFeatures({
          ...request,
          serviceId: complaintPath[3],
          layerId: Number(complaintPath[5]),
        }),
      dispose: () => honua.dispose(),
    };
  } catch (error) {
    await honua.dispose();
    throw error;
  }
}

export async function aggregate(
  source: Source,
  query: Query,
  groupBy: string[],
  signal: AbortSignal,
): Promise<Attributes[]> {
  const result = await source.queryAggregate({
    ...query,
    signal,
    returnGeometry: false,
    aggregation: {
      groupBy,
      metrics: [{ fn: "count", field: field(source, "objectid"), alias: "record_count" }],
    },
  });
  if (result.exceededTransferLimit || result.degraded?.length || !result.aggregateRows)
    throw new Error("The server did not return complete aggregate counts.");
  return [...result.aggregateRows];
}

export async function loadFeatures(
  source: Source,
  query: Query,
  signal: AbortSignal,
  limit = 50_000,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Collection> {
  const counts = await aggregate(source, query, [], signal);
  const expected = Number(value(counts[0] ?? {}, "record_count"));
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > limit)
    throw new Error(
      `The selection exceeds the reviewed ${limit.toLocaleString()}-record budget or has no reliable count.`,
    );
  const features: MapFeature[] = [];
  signal.throwIfAborted();
  onProgress?.(0, expected);
  const ids = new Set<string>();
  const primaryKey = field(source, "objectid");
  for await (const page of source.stream({
    ...query,
    signal,
    outFields: ["*"],
    returnGeometry: true,
    outSr: 4326,
    orderBy: [{ field: primaryKey, direction: "asc" }],
    pagination: { limit: 1000 },
  })) {
    if (page.degraded?.length) throw new Error("The server returned a degraded feature page.");
    for (const item of page.features) {
      const rawId = value(item.attributes, primaryKey);
      if (typeof rawId !== "number" && typeof rawId !== "string") throw new Error("A feature has no stable identity.");
      const id = String(rawId);
      if (ids.has(id)) throw new Error("Repeated feature identity while paging.");
      ids.add(id);
      const geometry = item.geometry == null ? null : esriGeometryToGeoJSON(item.geometry);
      if (item.geometry != null && !geometry) throw new Error(`Geometry conversion failed for feature ${id}.`);
      features.push({ type: "Feature", id, properties: item.attributes, geometry: geometry as Geometry | null });
      if (features.length > limit) throw new Error("The layer exceeded its reviewed query budget while paging.");
    }
    signal.throwIfAborted();
    onProgress?.(features.length, expected);
  }
  if (features.length !== expected)
    throw new Error(`Selected ${expected} records but received ${features.length}; refresh before using these counts.`);
  return { type: "FeatureCollection", features };
}

export function halfMileAround(geometry: Geometry): {
  collection: Collection;
  spatialFilter: NonNullable<Query["spatialFilter"]>;
} {
  const buffered = buffer(geometry as GeoJsonGeometry, 0.5, "miles");
  if (!buffered) throw new Error("Unable to construct the half-mile search area.");
  return searchArea(buffered as Geometry);
}

function searchArea(buffered: Geometry): ReturnType<typeof halfMileAround> {
  const esri = geoJsonToEsri(buffered as GeoJsonGeometry);
  if (!esri || !("rings" in esri)) throw new Error("The search area must be polygonal.");
  return {
    collection: {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: buffered as Geometry }],
    },
    spatialFilter: polygon(esri.rings, { wkid: 4326 }),
  };
}

export async function neighborhoodStats(cohort: Cohort, day: string, geometry: Geometry, signal: AbortSignal) {
  const area = halfMileAround(geometry);
  const census = cohort.sources.census;
  const [demographics, complaints] = await Promise.all([
    census.queryAggregate({
      signal,
      spatialFilter: area.spatialFilter,
      returnGeometry: false,
      aggregation: {
        metrics: [
          { fn: "sum", field: field(census, "TOTPOP_CY"), alias: "population" },
          { fn: "avg", field: field(census, "AVGHINC_CY"), alias: "income" },
        ],
      },
    }),
    aggregate(
      cohort.sources.complaints,
      { ...dayQuery(cohort.sources.complaints, "Created_Date", day), spatialFilter: area.spatialFilter },
      [],
      signal,
    ),
  ]);
  if (demographics.exceededTransferLimit || demographics.degraded?.length || !demographics.aggregateRows)
    throw new Error("Complete neighborhood statistics are unavailable.");
  return {
    area: area.collection,
    population: value(demographics.aggregateRows[0] ?? {}, "population"),
    income: value(demographics.aggregateRows[0] ?? {}, "income"),
    complaints: value(complaints[0] ?? {}, "record_count"),
  };
}

export function complaintHighlightQuery(
  source: Source,
  day: string,
  geometry: Geometry,
  selected: MapFeature[],
): ComplaintDistanceQuery {
  const esri = geoJsonToEsri(geometry as GeoJsonGeometry);
  if (!esri || (!("paths" in esri) && !("x" in esri)))
    throw new Error("Complaint highlighting requires a point or flight tracks.");
  return complaintDistanceRequest({
    day,
    dateField: field(source, "Created_Date"),
    geometry: { ...esri, spatialReference: { wkid: 4326 } },
    geometryType: "paths" in esri ? "esriGeometryPolyline" : "esriGeometryPoint",
    startTimes: selected.map((feature) => value(feature.properties, "start_t")),
  });
}

export function matchingIds(cohort: Cohort, query: ComplaintDistanceQuery, signal: AbortSignal): Promise<string[]> {
  return matchingDistanceIds(cohort.queryComplaints, query, signal);
}
