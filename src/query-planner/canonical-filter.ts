/**
 * Shared glue that lowers the canonical typed filter members of a
 * {@link CanonicalQuery} for the deterministic v1 protocol compilers.
 *
 * Every compiler must consume both members: silently ignoring `filter` or
 * `temporalFilter` would return an unfiltered superset, which the contract
 * forbids. Compilers that cannot express a member call
 * {@link refuseCanonicalFilter} so planning fails closed with the construct and
 * protocol named.
 *
 * @module
 */

import {
  type QueryFilterContext,
  type QueryFilterExpression,
  type QueryTemporalFilter,
  andQueryFilters,
  temporalFilterToExpression,
} from "../contract/query-filter.js";
import { type CanonicalQuery, HonuaQueryPlanningError } from "./types.js";

/** Split of the canonical filter members a compiler has to honor. */
export interface CanonicalFilterParts {
  /** Typed filter conjoined with any field-bound temporal predicate. */
  readonly expression?: QueryFilterExpression;
  /**
   * Temporal filter that targets the source's own time dimension. Compilers
   * with a protocol time parameter (GeoServices `time=`, OGC `datetime=`) serve
   * it; every other compiler must refuse it.
   */
  readonly protocolTime?: QueryTemporalFilter;
}

/** Lower the canonical filter members into their compiler-facing parts. */
export function canonicalFilterParts(query: CanonicalQuery, ctx: QueryFilterContext): CanonicalFilterParts {
  if (query.temporalFilter === undefined) {
    return query.filter === undefined ? {} : { expression: query.filter };
  }
  const temporal = temporalFilterToExpression(query.temporalFilter, ctx);
  const expression = andQueryFilters(query.filter, temporal);
  return {
    ...(expression !== undefined ? { expression } : {}),
    ...(temporal === undefined ? { protocolTime: query.temporalFilter } : {}),
  };
}

/** Fail planning closed, naming the construct and the compiler's protocol. */
export function refuseCanonicalFilter(construct: string, protocol: string, detail: string): never {
  throw new HonuaQueryPlanningError("unsupported-query", `${protocol} cannot express ${construct}: ${detail}`);
}
