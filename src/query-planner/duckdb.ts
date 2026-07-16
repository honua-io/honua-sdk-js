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
import type { GeoParquetGeometryEncoding, GeoParquetGeometryExecution } from "../contract/types.js";
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

  const unsupportedGeometry = geoparquet.geometries?.find(
    (geometry) => geometry.unsupportedReason !== undefined || geometry.geometryExecution === undefined,
  );
  const declaredPrimaries = geoparquet.geometries?.filter((geometry) => geometry.primary) ?? [];
  if (
    geoparquet.geometries &&
    (declaredPrimaries.length !== 1 ||
      declaredPrimaries[0]?.column !== geoparquet.geometryColumn ||
      declaredPrimaries[0]?.geometryEncoding !== geoparquet.geometryEncoding ||
      declaredPrimaries[0]?.geometryExecution !== geoparquet.geometryExecution ||
      declaredPrimaries[0]?.spatialRuntimeAvailable !== geoparquet.geometrySpatialRuntimeAvailable ||
      declaredPrimaries[0]?.bboxColumn !== geoparquet.bboxColumn)
  ) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "GeoParquet metadata does not identify one deterministic primary geometry.",
      { context: { reason: "metadata-invalid" } },
    );
  }
  if (unsupportedGeometry || geoparquet.geometryUnsupportedReason !== undefined) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "GeoParquet geometry is descriptive-only and cannot be planned by the configured runtime.",
      {
        context: {
          reason:
            unsupportedGeometry?.unsupportedReason ?? geoparquet.geometryUnsupportedReason ?? "layout-unsupported",
        },
      },
    );
  }
  const incompatibleGeometry = geoparquet.geometries?.find(
    (geometry) =>
      geometry.geometryExecution !== undefined &&
      !compatibleGeometryExecution(geometry.geometryEncoding, geometry.geometryExecution),
  );
  if (incompatibleGeometry) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "GeoParquet geometry identity does not match the reviewed execution path.",
      { context: { reason: "encoding-unsupported" } },
    );
  }
  if (geoparquet.geometryColumn) {
    if (!geoparquet.geometryEncoding || !geoparquet.geometryExecution) {
      throw new HonuaQueryPlanningError(
        "unsupported-query",
        "GeoParquet planning requires explicit descriptive and executable geometry identities.",
        { context: { reason: "layout-unsupported" } },
      );
    }
    if (!compatibleGeometryExecution(geoparquet.geometryEncoding, geoparquet.geometryExecution)) {
      throw new HonuaQueryPlanningError(
        "unsupported-query",
        "GeoParquet geometry identity does not match the reviewed execution path.",
        { context: { reason: "encoding-unsupported" } },
      );
    }
    const projectsGeometry = query.aggregation === undefined && query.returnGeometry !== false;
    const needsDecodedSpatialPredicate = query.spatialFilter !== undefined && geoparquet.bboxColumn === undefined;
    if (geoparquet.geometrySpatialRuntimeAvailable !== true && (projectsGeometry || needsDecodedSpatialPredicate)) {
      throw new HonuaQueryPlanningError(
        "unsupported-query",
        "GeoParquet query requires spatial SQL functions that are unavailable in the reviewed runtime.",
        { context: { reason: "spatial-runtime-unavailable" } },
      );
    }
  }

  const geometry: GeometryColumnPlan | undefined = geoparquet.geometryColumn
    ? {
        column: geoparquet.geometryColumn,
        encoding: geoparquet.geometryExecution!,
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
      ...(geometry
        ? {
            geometryColumn: geometry.column,
            geometryEncoding: geoparquet.geometryEncoding!,
            geometryExecution: geometry.encoding,
          }
        : {}),
      ...(compiled.bboxApproximated ? { bboxApproximated: true } : {}),
    };
  } catch (error) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      `DuckDB query cannot be compiled deterministically: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function compatibleGeometryExecution(
  identity: GeoParquetGeometryEncoding,
  execution: GeoParquetGeometryExecution,
): boolean {
  if (identity.startsWith("geoparquet-1.1-native-")) return false;
  if (identity === "duckdb-native") return execution === "duckdb-native";
  if (identity === "geojson-compat") return execution === "geojson-compat";
  if (identity === "wkb-compat") return execution === "wkb";
  return execution === "wkb" || execution === "duckdb-native";
}
