import type { AggregationFn, AggregationMetric, AggregationSpec } from "../contract/types.js";
import type { HonuaTypedFeature } from "../core/types.js";
import type { CanonicalQuery } from "./types.js";

export function aggregateLocally<T>(
  features: readonly HonuaTypedFeature<T>[],
  aggregation: AggregationSpec,
  output: Pick<CanonicalQuery, "orderBy" | "pagination">,
): readonly Record<string, unknown>[] {
  const groupKeys = aggregation.groupBy ?? [];
  const rows =
    groupKeys.length === 0
      ? [computeMetrics(features, aggregation.metrics)]
      : aggregateGroups(features, groupKeys, aggregation.metrics);
  const ordered = output.orderBy && output.orderBy.length > 0 ? [...rows].sort(rowComparator(output.orderBy)) : rows;
  const offset = output.pagination?.offset ?? 0;
  const limit = output.pagination?.limit;
  return limit === undefined ? ordered.slice(offset) : ordered.slice(offset, offset + limit);
}

function aggregateGroups<T>(
  features: readonly HonuaTypedFeature<T>[],
  groupKeys: readonly string[],
  metrics: readonly AggregationMetric[],
): Record<string, unknown>[] {
  const groups = new Map<string, HonuaTypedFeature<T>[]>();
  for (const feature of features) {
    const key = JSON.stringify(groupKeys.map((field) => readField(feature.attributes, field)));
    const bucket = groups.get(key);
    if (bucket) bucket.push(feature);
    else groups.set(key, [feature]);
  }
  return Array.from(groups.values(), (bucket) => {
    const row: Record<string, unknown> = {};
    for (const field of groupKeys) row[field] = readField(bucket[0]?.attributes, field);
    return Object.assign(row, computeMetrics(bucket, metrics));
  });
}

function computeMetrics<T>(
  features: readonly HonuaTypedFeature<T>[],
  metrics: readonly AggregationMetric[],
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const metric of metrics) {
    const alias = metric.alias ?? `${metric.fn}_${metric.field}`;
    const values = features
      .map((feature) => readField(feature.attributes, metric.field))
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    output[alias] = applyAggregation(metric.fn, values, features.length);
  }
  return output;
}

function applyAggregation(fn: AggregationFn, values: readonly number[], totalRows: number): number {
  if (fn === "count") return totalRows;
  if (values.length === 0) return 0;
  switch (fn) {
    case "sum":
      return values.reduce((sum, value) => sum + value, 0);
    case "avg":
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "stddev":
    case "var": {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
      return fn === "var" ? variance : Math.sqrt(variance);
    }
  }
}

function rowComparator(
  orderBy: NonNullable<CanonicalQuery["orderBy"]>,
): (left: Record<string, unknown>, right: Record<string, unknown>) => number {
  return (left, right) => {
    for (const sort of orderBy) {
      const comparison = compareValues(left[sort.field], right[sort.field]);
      if (comparison !== 0) return sort.direction === "desc" ? -comparison : comparison;
    }
    return 0;
  };
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

function readField(attributes: unknown, field: string): unknown {
  if (attributes === null || typeof attributes !== "object") return undefined;
  return (attributes as Record<string, unknown>)[field];
}
