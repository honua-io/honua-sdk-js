import type { FeatureQueryResult } from "@honua/sdk-js";

type FirstMapFeature = FeatureQueryResult<Record<string, unknown>>["features"][number];
type FilterValue = string | number | boolean;

export interface FirstMapBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface FirstMapFeatureSummary {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly geometryKind: "point" | "line" | "polygon" | "attribute-only";
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly center?: readonly [number, number];
  readonly bounds?: FirstMapBounds;
}

export interface FirstMapFilterChoice {
  readonly id: string;
  readonly field: string;
  readonly fieldLabel: string;
  readonly value: FilterValue;
  readonly label: string;
}

export interface FirstMapTimingObservation {
  readonly elapsedMs: number;
  readonly budgetMs: number;
  readonly varianceMs: number;
  readonly withinBudget: boolean;
}

export const FIRST_MAP_TIMING_BUDGETS_MS = Object.freeze({
  fixtureWorkflowReady: 10_000,
  interaction: 100,
  cleanup: 1_000,
});

const TITLE_FIELDS = ["NAMELSAD", "NAME", "TITLE", "name", "title", "LABEL", "label", "TMK", "tmk_txt"];
const SUBTITLE_FIELDS = ["STATUS", "CATEGORY", "status", "category", "TYPE", "type", "ZONE", "zone"];
const ID_FIELDS = ["OBJECTID", "objectid", "FID", "fid", "ID", "id"];
const FILTER_FIELD_PRIORITY = ["NAMELSAD", "STATUS", "CATEGORY", "TYPE", "ZONE", "status", "category", "type", "zone"];
const TECHNICAL_FILTER_FIELDS = new Set([...ID_FIELDS, "GEOID", "geoid", "ALAND", "AWATER"]);
const FILTER_FIELD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  NAMELSAD: "Census tract",
  STATUS: "Status",
  CATEGORY: "Category",
  TYPE: "Type",
  ZONE: "Zone",
});
const MAX_FILTER_FIELDS = 3;
const MAX_FILTER_VALUES_PER_FIELD = 50;
const MAX_FILTER_CHOICES = 60;

export function summarizeFirstMapFeatures(features: readonly FirstMapFeature[]): FirstMapFeatureSummary[] {
  return features.map((feature, index) => {
    const attributes = asRecord(feature.attributes);
    const bounds = geometryBounds(feature.geometry);
    return {
      id: readIdentifier(attributes, index),
      title: readDisplayValue(attributes, TITLE_FIELDS) ?? `Feature ${index + 1}`,
      subtitle: featureSubtitle(attributes) ?? describeGeometry(feature.geometry),
      geometryKind: geometryKind(feature.geometry),
      attributes,
      ...(bounds
        ? {
            bounds,
            center: [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2] as const,
          }
        : {}),
    };
  });
}

export function collectFirstMapBounds(summaries: readonly FirstMapFeatureSummary[]): FirstMapBounds | undefined {
  let result: FirstMapBounds | undefined;
  for (const summary of summaries) {
    const bounds = summary.bounds;
    if (!bounds) continue;
    result = result
      ? {
          minX: Math.min(result.minX, bounds.minX),
          minY: Math.min(result.minY, bounds.minY),
          maxX: Math.max(result.maxX, bounds.maxX),
          maxY: Math.max(result.maxY, bounds.maxY),
        }
      : bounds;
  }
  return result;
}

export function createFirstMapFilterChoices(summaries: readonly FirstMapFeatureSummary[]): FirstMapFilterChoice[] {
  const fields = new Map<string, Map<string, FilterValue>>();
  for (const { attributes } of summaries) {
    for (const [field, candidate] of Object.entries(attributes)) {
      if (!isFilterValue(candidate)) continue;
      const values = fields.get(field) ?? new Map<string, FilterValue>();
      values.set(`${typeof candidate}:${String(candidate)}`, candidate);
      fields.set(field, values);
    }
  }

  const choices: FirstMapFilterChoice[] = [];
  const selectableFields = [...fields]
    .filter(
      ([field, values]) =>
        !TECHNICAL_FILTER_FIELDS.has(field) &&
        values.size > 0 &&
        values.size <= MAX_FILTER_VALUES_PER_FIELD &&
        (FILTER_FIELD_PRIORITY.includes(field) || values.size <= 12),
    )
    .sort(([left, leftValues], [right, rightValues]) => {
      const leftPriority = FILTER_FIELD_PRIORITY.indexOf(left);
      const rightPriority = FILTER_FIELD_PRIORITY.indexOf(right);
      if (leftPriority >= 0 || rightPriority >= 0) {
        if (leftPriority < 0) return 1;
        if (rightPriority < 0) return -1;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      }
      return leftValues.size - rightValues.size || left.localeCompare(right);
    })
    .slice(0, MAX_FILTER_FIELDS);
  for (const [field, values] of selectableFields) {
    const sortedValues = [...values.values()].sort((left, right) => String(left).localeCompare(String(right)));
    if (choices.length > 0 && choices.length + sortedValues.length > MAX_FILTER_CHOICES) continue;
    const fieldLabel = FILTER_FIELD_LABELS[field] ?? humanizeField(field);
    for (const value of sortedValues) {
      choices.push({ id: String(choices.length), field, fieldLabel, value, label: String(value) });
    }
  }
  return choices;
}

function featureSubtitle(attributes: Readonly<Record<string, unknown>>): string | undefined {
  const geoid = readDisplayValue(attributes, ["GEOID", "geoid"]);
  return geoid ? `GEOID ${geoid}` : readDisplayValue(attributes, SUBTITLE_FIELDS);
}

function humanizeField(field: string): string {
  return field
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/^./, (letter) => letter.toUpperCase());
}

export function filterFirstMapFeatures(
  summaries: readonly FirstMapFeatureSummary[],
  choice: FirstMapFilterChoice | undefined,
): FirstMapFeatureSummary[] {
  if (!choice) return [...summaries];
  return summaries.filter(({ attributes }) => attributes[choice.field] === choice.value);
}

export function combineFirstMapLayerFilter(baseFilter: unknown, choice: FirstMapFilterChoice | undefined): unknown {
  if (!choice) return baseFilter ?? null;
  const attributeFilter = ["==", ["get", choice.field], choice.value] as const;
  return baseFilter === undefined || baseFilter === null
    ? attributeFilter
    : (["all", baseFilter, attributeFilter] as const);
}

export function findFirstMapFeature(
  summaries: readonly FirstMapFeatureSummary[],
  renderedId: string | number | undefined,
  renderedProperties: Readonly<Record<string, unknown>> | undefined,
): FirstMapFeatureSummary | undefined {
  if (renderedId !== undefined) {
    const byId = summaries.find(({ id }) => id === String(renderedId));
    if (byId) return byId;
  }
  if (!renderedProperties) return undefined;
  for (const field of ID_FIELDS) {
    const value = renderedProperties[field];
    if (value === undefined) continue;
    const byProperty = summaries.find(({ attributes }) => String(attributes[field]) === String(value));
    if (byProperty) return byProperty;
  }
  return summaries.find(({ title }) => title === readDisplayValue(renderedProperties, TITLE_FIELDS));
}

export function observeFirstMapTiming(elapsedMs: number, budgetMs: number): FirstMapTimingObservation {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0)
    throw new RangeError("First Map elapsed time must be non-negative.");
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new RangeError("First Map timing budget must be positive.");
  const roundedElapsed = Math.round(elapsedMs);
  const roundedBudget = Math.round(budgetMs);
  return {
    elapsedMs: roundedElapsed,
    budgetMs: roundedBudget,
    varianceMs: Math.round(budgetMs - elapsedMs) || 0,
    withinBudget: elapsedMs <= budgetMs,
  };
}

export function createFirstMapCode(options: {
  readonly endpoint: string;
  readonly mode: "fixture" | "public-live";
  readonly protocol: "auto" | "geoservices-feature-service" | "ogc-features";
  readonly maxFeatures: number;
}): string {
  return `import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { resolveFirstMapConfig } from "./first-map-config";
import { runFirstMapWorkflow } from "./workflow";

maplibregl.setWorkerUrl(maplibreWorkerUrl);
const map = new maplibregl.Map({
  container: "map",
  style: { version: 8, sources: {}, layers: [] },
});
const config = resolveFirstMapConfig(${JSON.stringify(options, null, 2)});
const result = await runFirstMapWorkflow(config, {
  map,
  maplibre: maplibregl,
  rendererOptions: { sourceId: "first-map-features", layerId: "first-map-feature" },
});

if (result.state !== "ready") throw new Error(\`First Map stopped: \${result.state}\`);`;
}

export function createIdempotentAsyncDispose(action: () => void | Promise<void>): () => Promise<void> {
  let result: Promise<void> | undefined;
  return () => {
    result ??= Promise.resolve().then(action);
    return result;
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" ? (value as Readonly<Record<string, unknown>>) : {};
}

function readIdentifier(attributes: Readonly<Record<string, unknown>>, index: number): string {
  for (const field of ID_FIELDS) {
    const value = attributes[field];
    if ((typeof value === "string" && value.trim()) || (typeof value === "number" && Number.isFinite(value))) {
      return String(value);
    }
  }
  return `feature-${index + 1}`;
}

function readDisplayValue(
  attributes: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = attributes[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function isFilterValue(value: unknown): value is FilterValue {
  return (
    typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
  );
}

function geometryKind(geometry: unknown): FirstMapFeatureSummary["geometryKind"] {
  const record = asRecord(geometry);
  if (record.type === "Point" || record.type === "MultiPoint" || "x" in record || "points" in record) return "point";
  if (record.type === "LineString" || record.type === "MultiLineString" || "paths" in record) return "line";
  if (
    record.type === "Polygon" ||
    record.type === "MultiPolygon" ||
    "rings" in record ||
    ("xmin" in record && "ymin" in record && "xmax" in record && "ymax" in record)
  )
    return "polygon";
  return "attribute-only";
}

function describeGeometry(geometry: unknown): string {
  const kind = geometryKind(geometry);
  return kind === "attribute-only" ? "No renderable geometry" : `${kind[0]?.toUpperCase()}${kind.slice(1)} feature`;
}

function geometryBounds(geometry: unknown): FirstMapBounds | undefined {
  const record = asRecord(geometry);
  if (
    isFiniteNumber(record.xmin) &&
    isFiniteNumber(record.ymin) &&
    isFiniteNumber(record.xmax) &&
    isFiniteNumber(record.ymax)
  ) {
    return { minX: record.xmin, minY: record.ymin, maxX: record.xmax, maxY: record.ymax };
  }
  if (isFiniteNumber(record.x) && isFiniteNumber(record.y)) {
    return { minX: record.x, minY: record.y, maxX: record.x, maxY: record.y };
  }
  const coordinates = record.coordinates ?? record.points ?? record.paths ?? record.rings;
  return scanCoordinates(coordinates);
}

function scanCoordinates(value: unknown, current?: FirstMapBounds): FirstMapBounds | undefined {
  if (!Array.isArray(value)) return current;
  if (isFiniteNumber(value[0]) && isFiniteNumber(value[1])) {
    return current
      ? {
          minX: Math.min(current.minX, value[0]),
          minY: Math.min(current.minY, value[1]),
          maxX: Math.max(current.maxX, value[0]),
          maxY: Math.max(current.maxY, value[1]),
        }
      : { minX: value[0], minY: value[1], maxX: value[0], maxY: value[1] };
  }
  let result = current;
  for (const child of value) result = scanCoordinates(child, result);
  return result;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
