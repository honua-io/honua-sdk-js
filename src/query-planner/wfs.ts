import type { SpatialFilter } from "../core/spatial-filter.js";
import { type FesNode, UNSUPPORTED_FES, compileSpatialFilter, compileWhere, serializeFes } from "../core/wfs-filter.js";
import type { CanonicalQuery, QueryIrSourceIdentity, WfsCompiledQueryV1 } from "./types.js";
import { HonuaQueryPlanningError } from "./types.js";

/** Compile canonical query IR to a deterministic WFS 2.0 GetFeature request. */
export function compileWfsQuery(source: QueryIrSourceIdentity, query: CanonicalQuery): WfsCompiledQueryV1 {
  if (source.protocol !== "wfs") {
    throw new HonuaQueryPlanningError(
      "unsupported-compiler",
      `wfs-2.0-get-feature-v1 does not compile protocol "${source.protocol}"`,
    );
  }
  if (!source.typeName) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `Source "${source.id}" requires locator.typeName for WFS planning`,
    );
  }
  if (query.aggregation) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "WFS 2.0 has no portable remote aggregation; use degraded policy with an explicit bounded-local fallback",
    );
  }
  if (query.spatialFilter && query.outSr !== undefined) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "WFS planning cannot use outSr to label input filter coordinates; stamp the input geometry through the typed WFS escape hatch",
    );
  }

  // Keep this aligned with the current WFS adapter's reviewed default. A
  // vendor-specific geometry property requires the typed WFS escape hatch
  // until discovery carries that binding into both planner and executor.
  const geometryProperty = "the_geom";
  const filters: FesNode[] = [];
  if (query.where) {
    const where = compileWhere(query.where.expression);
    if (where === UNSUPPORTED_FES) {
      throw new HonuaQueryPlanningError("unsupported-query", "The where clause is not expressible as FES 2.0");
    }
    if (where.kind !== "and" || where.operands.length > 0) filters.push(where);
  }
  if (query.spatialFilter) {
    const spatial = compileSpatialFilter(
      {
        geometry: query.spatialFilter.geometry as Record<string, unknown>,
        geometryType: query.spatialFilter.geometryType,
        ...(query.spatialFilter.spatialRel ? { spatialRel: query.spatialFilter.spatialRel } : {}),
      } as SpatialFilter,
      {
        geometryProperty,
      },
    );
    if (spatial === UNSUPPORTED_FES) {
      throw new HonuaQueryPlanningError("unsupported-query", "The spatial predicate is not expressible as FES 2.0");
    }
    filters.push(spatial);
  }

  let propertyName: readonly string[] | undefined;
  if (query.outFields && query.outFields.length > 0) {
    const fields = [...query.outFields];
    if (query.returnGeometry === false && fields.includes(geometryProperty)) {
      throw new HonuaQueryPlanningError(
        "unsupported-query",
        `WFS returnGeometry=false conflicts with outFields containing the geometry property "${geometryProperty}"`,
      );
    }
    if (query.returnGeometry !== false && !fields.includes(geometryProperty)) fields.push(geometryProperty);
    propertyName = fields;
  } else if (query.returnGeometry === false) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "WFS returnGeometry=false requires explicit outFields because propertyName cannot otherwise suppress geometry exactly",
    );
  }

  return {
    compiler: "wfs-2.0-get-feature-v1",
    typeName: source.typeName,
    ...(filters.length > 0 ? { filter: serializeFes(filters, { typeName: source.typeName }) } : {}),
    ...(propertyName ? { propertyName } : {}),
    ...(query.orderBy && query.orderBy.length > 0
      ? { sortBy: query.orderBy.map((sort) => `${sort.field} ${sort.direction === "desc" ? "D" : "A"}`).join(",") }
      : {}),
    ...(query.pagination?.offset !== undefined ? { startIndex: query.pagination.offset } : {}),
    ...(query.pagination?.limit !== undefined ? { count: query.pagination.limit } : {}),
    ...(query.outSr !== undefined ? { srsName: String(query.outSr) } : {}),
  };
}
