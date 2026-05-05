import type { FilterClause } from "@honua/sdk-js/exploration";
import type { HonuaExtent } from "@honua/sdk-js/honua";
import type { LinkedViewQueryProjection } from "@honua/sdk-js/interactions";

import type { QuickstartFeatureSummary } from "./data.js";
import type { QuickstartRenderableGeometryType } from "./esri-geojson.js";

export interface QuickstartFilterOption {
  field: string;
  values: string[];
}

const PREFERRED_FILTER_FIELDS = ["STATUS", "CATEGORY", "status", "category", "TYPE", "type"] as const;

export function createQuickstartFilterOptions(
  summaries: readonly QuickstartFeatureSummary[],
): QuickstartFilterOption[] {
  const valuesByField = new Map<string, Set<string>>();

  for (const summary of summaries) {
    for (const [field, value] of Object.entries(summary.feature.properties)) {
      if (!isFilterableValue(value)) continue;
      const values = valuesByField.get(field) ?? new Set<string>();
      values.add(String(value));
      valuesByField.set(field, values);
    }
  }

  const entries = [...valuesByField.entries()];
  const preferredEntries = entries.filter(([field]) =>
    PREFERRED_FILTER_FIELDS.includes(field as (typeof PREFERRED_FILTER_FIELDS)[number]),
  );

  return (preferredEntries.length > 0 ? preferredEntries : entries)
    .filter(([, values]) => values.size > 1 && values.size <= 12)
    .sort(([left], [right]) => fieldRank(left) - fieldRank(right) || left.localeCompare(right))
    .map(([field, values]) => ({
      field,
      values: [...values].sort((left, right) => left.localeCompare(right)),
    }));
}

export function applyQuickstartProjection(
  summaries: readonly QuickstartFeatureSummary[],
  projection: LinkedViewQueryProjection,
): QuickstartFeatureSummary[] {
  const filters = Object.values(projection.filters);
  return summaries.filter((summary) => {
    if (!summaryInExtent(summary, projection.extent)) return false;
    return filters.every((clause) => matchesClause(summary, clause));
  });
}

export function createMapLibreLayerFilter(
  geometryType: QuickstartRenderableGeometryType,
  projection: LinkedViewQueryProjection,
): unknown[] {
  const clauses = [
    geometryFilter(geometryType),
    ...Object.values(projection.filters).map(clauseToMapLibreFilter).filter(isFilterExpression),
  ];

  return clauses.length === 1 ? clauses[0] : ["all", ...clauses];
}

export function formatProjectionExtent(extent: HonuaExtent | undefined): string {
  if (!extent) return "No viewport";
  return `${formatCoordinate(extent.xmin)}, ${formatCoordinate(extent.ymin)} to ${formatCoordinate(
    extent.xmax,
  )}, ${formatCoordinate(extent.ymax)}`;
}

function fieldRank(field: string): number {
  const preferredIndex = PREFERRED_FILTER_FIELDS.indexOf(field as (typeof PREFERRED_FILTER_FIELDS)[number]);
  return preferredIndex >= 0 ? preferredIndex : PREFERRED_FILTER_FIELDS.length;
}

function isFilterableValue(value: unknown): value is string | number | boolean {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}

function summaryInExtent(summary: QuickstartFeatureSummary, extent: HonuaExtent | undefined): boolean {
  if (!extent || !summary.center) return true;
  const [x, y] = summary.center;
  return x >= extent.xmin && x <= extent.xmax && y >= extent.ymin && y <= extent.ymax;
}

function matchesClause(summary: QuickstartFeatureSummary, clause: FilterClause): boolean {
  const value = summary.feature.properties[clause.field];
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
        clause.value.length >= 2 &&
        typeof clause.value[0] === "number" &&
        typeof clause.value[1] === "number" &&
        value >= clause.value[0] &&
        value <= clause.value[1]
      );
  }
}

function geometryFilter(geometryType: QuickstartRenderableGeometryType): unknown[] {
  if (geometryType === "point") return ["==", "$type", "Point"];
  if (geometryType === "line") return ["==", "$type", "LineString"];
  return ["==", "$type", "Polygon"];
}

function clauseToMapLibreFilter(clause: FilterClause): unknown[] | undefined {
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

function isFilterExpression(value: unknown[] | undefined): value is unknown[] {
  return Array.isArray(value);
}

function formatCoordinate(value: number): string {
  return value.toFixed(4);
}
