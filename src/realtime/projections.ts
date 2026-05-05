/**
 * Projection helpers for map, table, and detail views that consume realtime
 * feature state.
 *
 * @module
 */

import type { FeatureId, SourceId } from "../contract/types.js";
import { realtimeFeatureKey } from "./reducer.js";
import type { RealtimeFeatureRecord, RealtimeFeatureState, RealtimeFeatureTombstone } from "./types.js";

export interface RealtimeFeatureRecordSelectorOptions<TFeature = unknown> {
  readonly sourceId?: SourceId;
  readonly sort?: (left: RealtimeFeatureRecord<TFeature>, right: RealtimeFeatureRecord<TFeature>) => number;
}

export interface RealtimeFeatureReference {
  readonly id: FeatureId;
  readonly sourceId?: SourceId;
}

export interface RealtimeDetailSelectorOptions {
  readonly sourceId?: SourceId;
}

export interface RealtimeDetailState<TFeature = unknown> {
  readonly status: "present" | "deleted" | "missing";
  readonly record?: RealtimeFeatureRecord<TFeature>;
  readonly tombstone?: RealtimeFeatureTombstone;
}

export function selectRealtimeFeatureRecords<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  options: RealtimeFeatureRecordSelectorOptions<TFeature> = {},
): RealtimeFeatureRecord<TFeature>[] {
  const records = Object.values(state.records).filter((record) => matchesSource(record, options.sourceId));
  return options.sort ? [...records].sort(options.sort) : records;
}

export function selectRealtimeFeatures<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  options: RealtimeFeatureRecordSelectorOptions<TFeature> = {},
): TFeature[] {
  return selectRealtimeFeatureRecords(state, options).map((record) => record.feature);
}

export function selectRealtimeFeatureRecordMap<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  options: RealtimeFeatureRecordSelectorOptions<TFeature> = {},
): Readonly<Record<string, RealtimeFeatureRecord<TFeature>>> {
  const records: Record<string, RealtimeFeatureRecord<TFeature>> = {};
  for (const record of selectRealtimeFeatureRecords(state, options)) {
    records[record.key] = record;
  }
  return records;
}

export function selectRealtimeFeatureTombstones(
  state: RealtimeFeatureState<unknown>,
  options: RealtimeDetailSelectorOptions = {},
): RealtimeFeatureTombstone[] {
  return Object.values(state.tombstones).filter((tombstone) => matchesSource(tombstone, options.sourceId));
}

export function selectRealtimeDetail<TFeature>(
  state: RealtimeFeatureState<TFeature>,
  target: FeatureId | RealtimeFeatureReference,
  options: RealtimeDetailSelectorOptions = {},
): RealtimeDetailState<TFeature> {
  const key = realtimeReferenceKey(target, options.sourceId);
  const record = state.records[key];
  if (record) {
    return {
      status: "present",
      record,
    };
  }
  const tombstone = state.tombstones[key];
  if (tombstone) {
    return {
      status: "deleted",
      tombstone,
    };
  }
  return { status: "missing" };
}

function matchesSource(
  record: Pick<RealtimeFeatureRecord<unknown>, "sourceId"> | Pick<RealtimeFeatureTombstone, "sourceId">,
  sourceId: SourceId | undefined,
): boolean {
  return sourceId === undefined || record.sourceId === sourceId;
}

function realtimeReferenceKey(target: FeatureId | RealtimeFeatureReference, sourceId: SourceId | undefined): string {
  if (typeof target === "object" && target !== null) {
    return realtimeFeatureKey(target.sourceId ?? sourceId, target.id);
  }
  return realtimeFeatureKey(sourceId, target);
}
