import { bufferEnvelope } from "../core/spatial-filter.js";
import type { HonuaSpatialReference } from "../core/types.js";
import { queryFilter } from "./query-filter.js";
import type { Query, Result, Source, SourceId } from "./types.js";

/** Query-only source accepted by the native search compositions. */
export type SearchSource<T = Record<string, unknown>> = Pick<Source<T>, "descriptor" | "query">;

export interface SourceSearchResult<T = Record<string, unknown>> {
  readonly sourceId: SourceId;
  /** Preserves transfer limits, degradation and source-specific fields. */
  readonly result: Result<T>;
}

export interface SearchOptions<T = Record<string, unknown>> {
  /** Single-page limit per source; defaults to 100. */
  readonly limit?: number;
  readonly query?: Pick<
    Query<T>,
    "filter" | "temporalFilter" | "outFields" | "outSr" | "returnGeometry" | "orderBy" | "signal"
  >;
}

export interface IdentifyOptions<T = Record<string, unknown>> extends SearchOptions<T> {
  readonly x: number;
  readonly y: number;
  /** Half-width of a square envelope in input CRS units, never screen pixels. */
  readonly tolerance: number;
  readonly spatialReference?: HonuaSpatialReference;
}

/** Query caller-selected visible sources within a coordinate-space tolerance envelope. */
export async function identifySources<T>(
  sources: readonly SearchSource<T>[],
  options: IdentifyOptions<T>,
): Promise<readonly SourceSearchResult<T>[]> {
  const spatialFilter = bufferEnvelope(options.x, options.y, options.tolerance, options.spatialReference);
  const query = searchQuery(options);
  return Promise.all(
    sources.map(async (source) => ({
      sourceId: source.descriptor.id,
      result: await source.query({ ...query, spatialFilter }),
    })),
  );
}

export interface FindTarget<T = Record<string, unknown>> {
  readonly source: SearchSource<T>;
  readonly fields: readonly string[];
}

export type FindSearch = { readonly text: string } | { readonly pattern: string; readonly caseSensitive?: boolean };

export interface FindOptions<T = Record<string, unknown>> extends SearchOptions<T> {
  /** Literal equality or explicit SQL LIKE pattern (% and _ wildcards). */
  readonly search: FindSearch;
}

/** Find across explicit fields, using typed filters rather than interpolated SQL. */
export async function findSources<T>(
  targets: readonly FindTarget<T>[],
  options: FindOptions<T>,
): Promise<readonly SourceSearchResult<T>[]> {
  const query = searchQuery(options);
  const requests = targets.map(({ source, fields }) => {
    if (fields.length === 0 || fields.some((field) => field.trim().length === 0)) {
      throw new TypeError("findSources requires non-empty field names for every target.");
    }
    const search = options.search;
    const clauses = fields.map((field) =>
      "text" in search
        ? queryFilter.eq(field, search.text)
        : queryFilter.like(field, search.pattern, { caseSensitive: search.caseSensitive }),
    );
    const match = queryFilter.or(...clauses);
    return { source, filter: query.filter ? queryFilter.and(query.filter, match) : match };
  });
  return Promise.all(
    requests.map(async ({ source, filter }) => ({
      sourceId: source.descriptor.id,
      result: await source.query({ ...query, filter }),
    })),
  );
}

function searchQuery<T>(options: SearchOptions<T>): Query<T> {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("Search limit must be a positive safe integer.");
  }
  options.query?.signal?.throwIfAborted();
  return { ...options.query, pagination: { limit } };
}
