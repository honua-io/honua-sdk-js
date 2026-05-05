/**
 * Shareable serialization helpers for map/table/detail interaction state.
 *
 * The encoded query string is intended for URLs and bookmarks. It carries the
 * query projection and selection but leaves state ownership with
 * `ExplorationContext`.
 *
 * @module
 */

import type { LinkedViewQueryProjection } from "../exploration/selectors.js";
import type { FeatureSelectionTarget } from "../exploration/types.js";

export type ShareableInteractionQueryState = Partial<LinkedViewQueryProjection> & {
  readonly selection?: ReadonlyArray<FeatureSelectionTarget>;
};

export interface ShareableInteractionQueryParams {
  readonly filters: string;
  readonly spatialFilter: string;
  readonly extent: string;
  readonly orderBy: string;
  readonly pagination: string;
  readonly outFields: string;
  readonly grouping: string;
  readonly aggregation: string;
  readonly selection: string;
}

const PARAMS: ShareableInteractionQueryParams = {
  filters: "f",
  spatialFilter: "sf",
  extent: "ext",
  orderBy: "sort",
  pagination: "page",
  outFields: "fields",
  grouping: "group",
  aggregation: "agg",
  selection: "sel",
};

/** Encode selection targets as a stable JSON value suitable for a URL param. */
export function serializeSelection(selection: ReadonlyArray<FeatureSelectionTarget>): string {
  return stableStringify(selection);
}

/** Decode a selection value produced by {@link serializeSelection}. */
export function parseSelection(value: string | null | undefined): FeatureSelectionTarget[] {
  if (!value) return [];
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? (parsed.filter(isSelectionTarget) as FeatureSelectionTarget[]) : [];
}

/** Encode query projection state into URL query parameters. */
export function serializeInteractionQueryState(state: ShareableInteractionQueryState): string {
  const params = new URLSearchParams();
  setJsonParam(params, PARAMS.filters, emptyObjectToUndefined(state.filters));
  setJsonParam(params, PARAMS.spatialFilter, state.spatialFilter);
  setJsonParam(params, PARAMS.extent, state.extent);
  setJsonParam(params, PARAMS.orderBy, emptyArrayToUndefined(state.orderBy));
  setJsonParam(params, PARAMS.pagination, emptyObjectToUndefined(state.pagination));
  setJsonParam(params, PARAMS.outFields, emptyArrayToUndefined(state.outFields));
  setJsonParam(params, PARAMS.grouping, emptyArrayToUndefined(state.grouping));
  setJsonParam(params, PARAMS.aggregation, state.aggregation);
  setJsonParam(params, PARAMS.selection, emptyArrayToUndefined(state.selection));
  return params.toString();
}

/** Decode URL query parameters produced by {@link serializeInteractionQueryState}. */
export function parseInteractionQueryState(search: string | URLSearchParams): ShareableInteractionQueryState {
  const params =
    typeof search === "string" ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search) : search;
  return {
    filters: parseRecordParam<LinkedViewQueryProjection["filters"]>(params.get(PARAMS.filters)),
    spatialFilter: parseRecordParam<LinkedViewQueryProjection["spatialFilter"]>(params.get(PARAMS.spatialFilter)),
    extent: parseRecordParam<LinkedViewQueryProjection["extent"]>(params.get(PARAMS.extent)),
    orderBy: parseArrayParam<LinkedViewQueryProjection["orderBy"][number]>(params.get(PARAMS.orderBy)),
    pagination: parseRecordParam<LinkedViewQueryProjection["pagination"]>(params.get(PARAMS.pagination)),
    outFields: parseStringArrayParam(params.get(PARAMS.outFields)),
    grouping: parseStringArrayParam(params.get(PARAMS.grouping)),
    aggregation: parseRecordParam<LinkedViewQueryProjection["aggregation"]>(params.get(PARAMS.aggregation)),
    selection: parseSelection(params.get(PARAMS.selection)),
  };
}

/** Return the query parameter names used by the shareable serializer. */
export function interactionQueryParamNames(): ShareableInteractionQueryParams {
  return { ...PARAMS };
}

function setJsonParam(params: URLSearchParams, name: string, value: unknown): void {
  if (value === undefined) return;
  params.set(name, stableStringify(value));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortJsonValue((value as Record<string, unknown>)[key]);
  }
  return out;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseRecordParam<T extends object | undefined>(value: string | null): T | undefined {
  if (!value) return undefined;
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : undefined;
}

function parseArrayParam<T>(value: string | null): T[] | undefined {
  if (!value) return undefined;
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? (parsed as T[]) : undefined;
}

function parseStringArrayParam(value: string | null): string[] | undefined {
  const parsed = parseArrayParam(value);
  if (!parsed) return undefined;
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function emptyArrayToUndefined<T>(value: ReadonlyArray<T> | undefined): ReadonlyArray<T> | undefined {
  return value && value.length > 0 ? value : undefined;
}

function emptyObjectToUndefined<T extends object>(value: T | undefined): T | undefined {
  return value && Object.keys(value).length > 0 ? value : undefined;
}

function isSelectionTarget(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "number") return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.sourceId === "string" && (typeof record.id === "string" || typeof record.id === "number");
}
