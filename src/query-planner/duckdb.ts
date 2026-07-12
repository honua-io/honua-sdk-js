/**
 * Compile canonical query IR to deterministic DuckDB SQL over
 * `read_parquet(...)` for the GeoParquet columnar `Source`, without performing
 * any network, filesystem, or DuckDB metadata I/O.
 *
 * The heavy lifting — identifier/literal escaping, spatial predicate pushdown,
 * GeoJSON projection, and GROUP BY aggregation — is delegated to the
 * dependency-free {@link module:core/geoparquet-sql} SQL builder that the live
 * GeoParquet `Source` already uses, so the planner and the adapter emit the
 * exact same SQL for the same inputs.
 *
 * @module
 */

import type { AggregationSpec } from "../contract/types.js";
import {
  type CompileOptions,
  type GeometryColumnPlan,
  compileAggregate,
  compileQuery,
} from "../core/geoparquet-sql.js";
import { queryFromCanonical } from "./ir.js";
import type { CanonicalQuery, DuckDbCompiledQueryV1, QueryIrSourceIdentity } from "./types.js";
import { HonuaQueryPlanningError } from "./types.js";

/**
 * Compile canonical query IR to a deterministic DuckDB `SELECT`. Reuses the
 * GeoParquet `Source` SQL builder, so the compiled SQL is byte-identical to
 * what the live adapter runs for the same descriptor + query.
 */
export function compileDuckDbQuery(source: QueryIrSourceIdentity, query: CanonicalQuery): DuckDbCompiledQueryV1 {
  if (source.protocol !== "geoparquet") {
    throw new HonuaQueryPlanningError(
      "unsupported-compiler",
      `duckdb-sql-v1 does not compile protocol "${source.protocol}"`,
    );
  }
  const geoparquet = source.geoparquet;
  if (!geoparquet || geoparquet.sources.length === 0) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `Source "${source.id}" requires locator.url (a parquet file or hive glob) for DuckDB planning`,
    );
  }
  if (query.outSr !== undefined) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "DuckDB/GeoParquet has no portable output-CRS query option; omit outSr and reproject downstream",
    );
  }
  if (query.spatialFilter && !geoparquet.geometryColumn) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      `Source "${source.id}" has a spatialFilter but no geometry column; set locator.geoparquet.geometryColumn or a geometry schema field`,
    );
  }

  const geometry: GeometryColumnPlan | undefined = geoparquet.geometryColumn
    ? {
        column: geoparquet.geometryColumn,
        encoding: geoparquet.geometryEncoding ?? "wkb",
        ...(geoparquet.bboxColumn ? { bboxColumn: geoparquet.bboxColumn } : {}),
      }
    : undefined;

  const options: CompileOptions = {
    sources: geoparquet.sources,
    geometryAlias: "geometry",
    ...(geometry ? { geometry } : {}),
  };

  const request = queryFromCanonical(query);
  try {
    const compiled = query.aggregation
      ? compileAggregate({ ...request, aggregation: query.aggregation as AggregationSpec }, options)
      : compileQuery(request, options);
    return {
      compiler: "duckdb-sql-v1",
      sql: compiled.sql,
      sources: geoparquet.sources,
      ...(geometry ? { geometryColumn: geometry.column, geometryEncoding: geometry.encoding } : {}),
      ...(compiled.bboxApproximated ? { bboxApproximated: true } : {}),
    };
  } catch (error) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      `DuckDB query cannot be compiled deterministically: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
