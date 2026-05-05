import type { FilterClause } from "@honua/sdk-js/exploration";
import type { HonuaExtent, HonuaFeature, HonuaLayerMetadata } from "@honua/sdk-js/honua";
import type { LinkedViewQueryProjection } from "@honua/sdk-js/interactions";

import type {
  ServiceExplorerChartModel,
  ServiceExplorerFeatureCollection,
  ServiceExplorerFeatureSummary,
  ServiceExplorerFilterOption,
  ServiceExplorerPointFeature,
  ServiceExplorerProjectionResult,
  ServiceExplorerQueryDiagnostics,
} from "./types.js";

const TITLE_FIELDS = ["title", "name", "NAME", "TITLE", "label", "LABEL"] as const;
const SUBTITLE_FIELDS = ["status", "category", "priority", "STATUS", "CATEGORY", "PRIORITY"] as const;
const OBJECT_ID_FIELDS = ["OBJECTID", "objectid", "ObjectId", "FID", "id"] as const;
const PREFERRED_FILTER_FIELDS = ["status", "category", "priority", "district", "type", "STATUS", "CATEGORY"] as const;

export function createServiceExplorerFeatureSummaries(
  features: readonly HonuaFeature[],
  metadata: HonuaLayerMetadata,
): ServiceExplorerFeatureSummary[] {
  return features.map((feature, index) => {
    const attributes = feature.attributes ?? {};
    const id = readString(attributes, OBJECT_ID_FIELDS) ?? String(index + 1);
    const geometry = readPointGeometry(feature);
    const title = readString(attributes, TITLE_FIELDS) ?? `${metadata.name} ${index + 1}`;
    const subtitle = [readString(attributes, SUBTITLE_FIELDS), readString(attributes, ["district", "DISTRICT"])]
      .filter(Boolean)
      .join(" / ");

    return {
      id,
      title,
      subtitle: subtitle.length > 0 ? subtitle : (metadata.geometryType ?? "feature"),
      attributes,
      geometryType: geometry ? "point" : "unsupported",
      coordinate: geometry,
      feature,
    };
  });
}

export function serviceExplorerFeatureCollection(
  summaries: readonly ServiceExplorerFeatureSummary[],
): ServiceExplorerFeatureCollection {
  return {
    type: "FeatureCollection",
    features: summaries.map(toPointFeature).filter(isPointFeature),
  };
}

export function createServiceExplorerFilterOptions(
  summaries: readonly ServiceExplorerFeatureSummary[],
): ServiceExplorerFilterOption[] {
  const valuesByField = new Map<string, Set<string>>();

  for (const summary of summaries) {
    for (const [field, value] of Object.entries(summary.attributes)) {
      if (!isFilterableValue(value)) continue;
      const values = valuesByField.get(field) ?? new Set<string>();
      values.add(String(value));
      valuesByField.set(field, values);
    }
  }

  return [...valuesByField.entries()]
    .filter(([, values]) => values.size > 1 && values.size <= 16)
    .sort(([left], [right]) => fieldRank(left) - fieldRank(right) || left.localeCompare(right))
    .map(([field, values]) => ({
      field,
      values: [...values].sort((left, right) => left.localeCompare(right)),
    }));
}

export function applyServiceExplorerProjection(
  summaries: readonly ServiceExplorerFeatureSummary[],
  projection: LinkedViewQueryProjection,
  options: { readonly sourceId?: string } = {},
): ServiceExplorerProjectionResult {
  const filters = Object.values(projection.filters);
  const matchedRows = summaries.filter(
    (summary) =>
      summaryInExtent(summary, projection.extent) &&
      filters.every((clause) => matchesClause(summary, clause, options.sourceId)),
  );
  const sorted = sortSummaries(matchedRows, projection.orderBy);
  const offset = projection.pagination.offset ?? 0;
  const limit = projection.pagination.limit;
  const rows = limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit);

  return {
    projection,
    matchedRows: sorted,
    rows,
    totalMatched: sorted.length,
    visibleCount: rows.length,
  };
}

export function createServiceExplorerChartModel(
  result: ServiceExplorerProjectionResult,
  projection: LinkedViewQueryProjection,
): ServiceExplorerChartModel {
  const field = projection.grouping[0] ?? "status";
  const selected = new Set(
    projection.selection.map((target) => (typeof target === "object" ? String(target.id) : String(target))),
  );
  const buckets = new Map<string, { count: number; selected: boolean }>();

  for (const row of result.matchedRows) {
    const value = formatAttribute(row.attributes[field] ?? "null");
    const current = buckets.get(value) ?? { count: 0, selected: false };
    current.count += 1;
    current.selected = current.selected || selected.has(row.id);
    buckets.set(value, current);
  }

  return {
    field,
    total: result.totalMatched,
    buckets: [...buckets.entries()]
      .sort(([leftValue, left], [rightValue, right]) => right.count - left.count || leftValue.localeCompare(rightValue))
      .map(([value, bucket]) => ({ field, value, count: bucket.count, selected: bucket.selected })),
  };
}

export function createServiceExplorerMapFilter(
  projection: LinkedViewQueryProjection,
  options: { readonly sourceId?: string } = {},
): unknown[] {
  const filters = Object.values(projection.filters)
    .map((clause) => clauseToMapLibreFilter(clause, options.sourceId))
    .filter(isMapLibreFilter);
  return filters.length === 0 ? ["==", "$type", "Point"] : ["all", ["==", "$type", "Point"], ...filters];
}

export function createServiceExplorerQueryDiagnostics(
  projection: LinkedViewQueryProjection,
): ServiceExplorerQueryDiagnostics {
  return {
    where: formatWhereClause(Object.values(projection.filters)),
    outFields: projection.outFields ?? ["*"],
    orderBy: projection.orderBy.map((sort) => `${sort.field} ${sort.direction ?? "asc"}`),
    resultOffset: projection.pagination.offset,
    resultRecordCount: projection.pagination.limit,
    extent: projection.extent,
    filterIds: Object.keys(projection.filters),
  };
}

export function formatExtent(extent: HonuaExtent | undefined): string {
  if (!extent) return "No map extent";
  return `${formatCoordinate(extent.xmin)}, ${formatCoordinate(extent.ymin)} to ${formatCoordinate(
    extent.xmax,
  )}, ${formatCoordinate(extent.ymax)}`;
}

export function formatTimestamp(value: number | string | undefined): string {
  if (value === undefined) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatAttribute(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function readString(attributes: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function readPointGeometry(feature: HonuaFeature): readonly [number, number] | undefined {
  const geometry = feature.geometry;
  if (!isRecord(geometry)) return undefined;
  const x = geometry.x;
  const y = geometry.y;
  if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
    return [x, y];
  }
  return undefined;
}

function toPointFeature(summary: ServiceExplorerFeatureSummary): ServiceExplorerPointFeature | undefined {
  if (!summary.coordinate) return undefined;
  return {
    type: "Feature",
    id: summary.id,
    properties: summary.attributes,
    geometry: {
      type: "Point",
      coordinates: summary.coordinate,
    },
  };
}

function isPointFeature(value: ServiceExplorerPointFeature | undefined): value is ServiceExplorerPointFeature {
  return value !== undefined;
}

function isFilterableValue(value: unknown): value is string | number | boolean {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}

function fieldRank(field: string): number {
  const index = PREFERRED_FILTER_FIELDS.indexOf(field as (typeof PREFERRED_FILTER_FIELDS)[number]);
  return index >= 0 ? index : PREFERRED_FILTER_FIELDS.length;
}

function summaryInExtent(summary: ServiceExplorerFeatureSummary, extent: HonuaExtent | undefined): boolean {
  if (!extent || !summary.coordinate) return true;
  const [x, y] = summary.coordinate;
  return x >= extent.xmin && x <= extent.xmax && y >= extent.ymin && y <= extent.ymax;
}

function matchesClause(
  summary: ServiceExplorerFeatureSummary,
  clause: FilterClause,
  sourceId: string | undefined,
): boolean {
  if (sourceId && clause.appliesTo && clause.appliesTo.length > 0 && !clause.appliesTo.includes(sourceId)) {
    return true;
  }
  const value = summary.attributes[clause.field];
  switch (clause.operator) {
    case "=":
      return value === clause.value;
    case "!=":
      return value !== clause.value;
    case "in":
      return Array.isArray(clause.value) && clause.value.includes(value);
    case "not-in":
      return Array.isArray(clause.value) && !clause.value.includes(value);
    case "like":
      return typeof value === "string" && typeof clause.value === "string" && value.includes(clause.value);
    case "is-null":
      return value === undefined || value === null;
    case "is-not-null":
      return value !== undefined && value !== null;
    case "<":
      return typeof value === "number" && typeof clause.value === "number" && value < clause.value;
    case "<=":
      return typeof value === "number" && typeof clause.value === "number" && value <= clause.value;
    case ">":
      return typeof value === "number" && typeof clause.value === "number" && value > clause.value;
    case ">=":
      return typeof value === "number" && typeof clause.value === "number" && value >= clause.value;
    case "between":
      return (
        typeof value === "number" &&
        Array.isArray(clause.value) &&
        typeof clause.value[0] === "number" &&
        typeof clause.value[1] === "number" &&
        value >= clause.value[0] &&
        value <= clause.value[1]
      );
  }
}

function sortSummaries(
  summaries: readonly ServiceExplorerFeatureSummary[],
  orderBy: LinkedViewQueryProjection["orderBy"],
): ServiceExplorerFeatureSummary[] {
  if (orderBy.length === 0) return [...summaries];
  return [...summaries].sort((left, right) => {
    for (const sort of orderBy) {
      const direction = sort.direction === "desc" ? -1 : 1;
      const comparison = compareValues(left.attributes[sort.field], right.attributes[sort.field]);
      if (comparison !== 0) return comparison * direction;
    }
    return left.id.localeCompare(right.id);
  });
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return formatAttribute(left).localeCompare(formatAttribute(right));
}

function clauseToMapLibreFilter(clause: FilterClause, sourceId: string | undefined): unknown[] | undefined {
  if (sourceId && clause.appliesTo && clause.appliesTo.length > 0 && !clause.appliesTo.includes(sourceId)) {
    return undefined;
  }
  switch (clause.operator) {
    case "=":
      return ["==", clause.field, clause.value];
    case "!=":
      return ["!=", clause.field, clause.value];
    case "in":
      return Array.isArray(clause.value) ? ["in", clause.field, ...clause.value] : undefined;
    case "not-in":
      return Array.isArray(clause.value) ? ["!in", clause.field, ...clause.value] : undefined;
    case "is-null":
      return ["==", clause.field, null];
    case "is-not-null":
      return ["!=", clause.field, null];
    default:
      return undefined;
  }
}

function isMapLibreFilter(value: unknown[] | undefined): value is unknown[] {
  return Array.isArray(value);
}

function formatWhereClause(filters: readonly FilterClause[]): string {
  if (filters.length === 0) return "1=1";
  return filters.map(formatFilterClause).join(" AND ");
}

function formatFilterClause(clause: FilterClause): string {
  switch (clause.operator) {
    case "is-null":
    case "is-not-null":
      return `${clause.field} ${clause.operator}`;
    case "in":
    case "not-in":
      return `${clause.field} ${clause.operator} (${Array.isArray(clause.value) ? clause.value.join(", ") : ""})`;
    default:
      return `${clause.field} ${clause.operator} ${formatAttribute(clause.value)}`;
  }
}

function formatCoordinate(value: number): string {
  return value.toFixed(4);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
