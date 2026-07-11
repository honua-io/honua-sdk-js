import type { CanonicalQuery, OgcApiFeaturesCompiledQueryV1, QueryIrSourceIdentity } from "./types.js";
import { HonuaQueryPlanningError } from "./types.js";

/**
 * Compile canonical query IR to an OGC API Features `/items` request. The
 * compiler is side-effect free and deliberately supports only semantics the
 * first-party OGC adapter can preserve exactly.
 */
export function compileOgcApiFeaturesQuery(
  source: QueryIrSourceIdentity,
  query: CanonicalQuery,
): OgcApiFeaturesCompiledQueryV1 {
  if (source.protocol !== "ogc-features") {
    throw new HonuaQueryPlanningError(
      "unsupported-compiler",
      `ogc-api-features-query-v1 does not compile protocol "${source.protocol}"`,
    );
  }
  if (source.collectionId === undefined || source.collectionId === "") {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `Source "${source.id}" requires locator.collectionId for OGC API Features planning`,
    );
  }
  if (query.aggregation) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "OGC API Features does not provide remote aggregation; use degraded policy with an explicit bounded-local fallback",
    );
  }
  if (query.returnGeometry === false) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "OGC API Features /items has no portable geometry-suppression parameter; omit returnGeometry or select another protocol",
    );
  }

  return {
    compiler: "ogc-api-features-query-v1",
    collectionId: source.collectionId,
    ...(query.where ? { filter: query.where.expression, filterLang: "cql2-text" as const } : {}),
    ...(query.outFields && query.outFields.length > 0 ? { properties: query.outFields } : {}),
    ...(query.orderBy && query.orderBy.length > 0
      ? { sortby: query.orderBy.map((sort) => `${sort.direction === "desc" ? "-" : ""}${sort.field}`).join(",") }
      : {}),
    ...(query.spatialFilter ? { bbox: compileBbox(query.spatialFilter, source.id) } : {}),
    ...(query.outSr !== undefined ? { crs: String(query.outSr) } : {}),
    ...(query.pagination?.offset !== undefined ? { offset: query.pagination.offset } : {}),
    ...(query.pagination?.limit !== undefined ? { limit: query.pagination.limit } : {}),
  };
}

function compileBbox(spatialFilter: NonNullable<CanonicalQuery["spatialFilter"]>, sourceId: string): string {
  if (spatialFilter.geometryType !== "esriGeometryEnvelope") {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      `Source "${sourceId}" cannot compile spatial geometry "${spatialFilter.geometryType}" to OGC bbox`,
    );
  }
  if (
    spatialFilter.spatialRel !== undefined &&
    spatialFilter.spatialRel !== "esriSpatialRelIntersects" &&
    spatialFilter.spatialRel !== "esriSpatialRelEnvelopeIntersects"
  ) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      `Source "${sourceId}" cannot weaken spatial relationship "${spatialFilter.spatialRel}" to OGC envelope-intersects`,
    );
  }

  const geometry = spatialFilter.geometry;
  assertDefaultBboxCrs(geometry.spatialReference, sourceId);
  const coordinates = [geometry.xmin, geometry.ymin, geometry.xmax, geometry.ymax];
  if (!coordinates.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `Source "${sourceId}" requires finite xmin, ymin, xmax, and ymax values for OGC bbox`,
    );
  }
  const [xmin, ymin, xmax, ymax] = coordinates as [number, number, number, number];
  if (xmin > xmax || ymin > ymax) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `Source "${sourceId}" requires an ordered OGC bbox where xmin <= xmax and ymin <= ymax`,
    );
  }
  return `${xmin},${ymin},${xmax},${ymax}`;
}

function assertDefaultBboxCrs(spatialReference: unknown, sourceId: string): void {
  if (spatialReference === undefined) return;
  if (spatialReference === null || Array.isArray(spatialReference) || typeof spatialReference !== "object") {
    throw unsupportedBboxCrs(sourceId);
  }
  const reference = spatialReference as Record<string, unknown>;
  const wkid = reference.latestWkid ?? reference.wkid;
  if (wkid === 4326 && reference.wkt === undefined) return;
  throw unsupportedBboxCrs(sourceId);
}

function unsupportedBboxCrs(sourceId: string): HonuaQueryPlanningError {
  return new HonuaQueryPlanningError(
    "unsupported-query",
    `Source "${sourceId}" can only compile an unstamped or EPSG:4326 envelope to the default OGC bbox CRS`,
  );
}
