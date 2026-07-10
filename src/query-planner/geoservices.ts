import type { AggregationFn, AggregationSpec } from "../contract/types.js";
import type { CanonicalQuery, GeoServicesCompiledQueryV1, QueryIrSourceIdentity } from "./types.js";
import { HonuaQueryPlanningError } from "./types.js";

/**
 * Compile canonical query IR to the existing FeatureServer `query` request
 * vocabulary without performing network or metadata I/O.
 */
export function compileGeoServicesQuery(
  source: QueryIrSourceIdentity,
  query: CanonicalQuery,
): GeoServicesCompiledQueryV1 {
  if (source.protocol !== "geoservices-feature-service") {
    throw new HonuaQueryPlanningError(
      "unsupported-compiler",
      `geoservices-rest-query-v1 does not compile protocol "${source.protocol}"`,
    );
  }
  if (source.serviceId === undefined || source.layerId === undefined) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `Source "${source.id}" requires locator.serviceId and locator.layerId for GeoServices planning`,
    );
  }
  if (query.aggregation?.histogram || query.aggregation?.timeSeries) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "The first GeoServices planner slice supports metrics and groupBy; histogram/timeSeries compilers remain follow-on work",
    );
  }
  return {
    compiler: "geoservices-rest-query-v1",
    serviceId: source.serviceId,
    layerId: source.layerId,
    ...(query.where ? { where: query.where.expression } : {}),
    ...(query.outFields && query.outFields.length > 0 ? { outFields: query.outFields } : {}),
    ...(query.returnGeometry !== undefined ? { returnGeometry: query.returnGeometry } : {}),
    ...(query.outSr !== undefined ? { outSr: query.outSr } : {}),
    ...(query.orderBy && query.orderBy.length > 0
      ? {
          orderByFields: query.orderBy
            .map((sort) => `${sort.field}${sort.direction === "desc" ? " DESC" : ""}`)
            .join(","),
        }
      : {}),
    ...(query.spatialFilter
      ? {
          geometry: query.spatialFilter.geometry,
          geometryType: query.spatialFilter.geometryType,
          ...(query.spatialFilter.spatialRel ? { spatialRel: query.spatialFilter.spatialRel } : {}),
        }
      : {}),
    ...(query.pagination?.offset !== undefined ? { resultOffset: query.pagination.offset } : {}),
    ...(query.pagination?.limit !== undefined ? { resultRecordCount: query.pagination.limit } : {}),
    ...(query.aggregation ? compileAggregation(query.aggregation) : {}),
  };
}

function compileAggregation(
  aggregation: AggregationSpec,
): Pick<GeoServicesCompiledQueryV1, "groupByFieldsForStatistics" | "outStatistics" | "returnGeometry"> {
  return {
    outStatistics: aggregation.metrics.map((metric) => ({
      statisticType: geoServicesStatistic(metric.fn),
      onStatisticField: metric.field,
      outStatisticFieldName: metric.alias ?? `${metric.fn}_${metric.field}`,
    })),
    ...(aggregation.groupBy && aggregation.groupBy.length > 0
      ? { groupByFieldsForStatistics: aggregation.groupBy.join(",") }
      : {}),
    returnGeometry: false,
  };
}

function geoServicesStatistic(fn: AggregationFn): string {
  return fn === "var" ? "var" : fn;
}
