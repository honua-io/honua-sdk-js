/**
 * Compile canonical query IR to a deterministic, inspectable description of the
 * `honua.v1.FeatureService/QueryFeatures` unary gRPC request — without pulling
 * the `@bufbuild/protobuf` runtime into the planner graph.
 *
 * The compiled object mirrors the generated `QueryFeaturesRequest` message
 * field-for-field (including proto enum *value names* for spatial relationship
 * and statistic type), so it is a faithful, hashable pre-image of the wire
 * request. The live gRPC adapter (`core/grpc-adapter.ts`) turns the same
 * canonical inputs into the protobuf message; this keeps the plan honest about
 * exactly what will be sent.
 *
 * @module
 */

import type { AggregationFn, AggregationSpec } from "../contract/types.js";
import type { EsriSpatialRel } from "../core/types.js";
import type {
  CanonicalQuery,
  GrpcCompiledQueryV1,
  GrpcSpatialRelationship,
  GrpcStatisticType,
  QueryIrSourceIdentity,
} from "./types.js";
import { HonuaQueryPlanningError } from "./types.js";

const SPATIAL_REL_MAP: Record<EsriSpatialRel, GrpcSpatialRelationship> = {
  esriSpatialRelIntersects: "SPATIAL_RELATIONSHIP_INTERSECTS",
  esriSpatialRelContains: "SPATIAL_RELATIONSHIP_CONTAINS",
  esriSpatialRelWithin: "SPATIAL_RELATIONSHIP_WITHIN",
  esriSpatialRelEnvelopeIntersects: "SPATIAL_RELATIONSHIP_ENVELOPE_INTERSECTS",
  esriSpatialRelIndexIntersects: "SPATIAL_RELATIONSHIP_ENVELOPE_INTERSECTS",
  esriSpatialRelCrosses: "SPATIAL_RELATIONSHIP_CROSSES",
  esriSpatialRelTouches: "SPATIAL_RELATIONSHIP_TOUCHES",
  esriSpatialRelOverlaps: "SPATIAL_RELATIONSHIP_OVERLAPS",
  esriSpatialRelDisjoint: "SPATIAL_RELATIONSHIP_DISJOINT",
};

const STATISTIC_TYPE_MAP: Record<AggregationFn, GrpcStatisticType> = {
  count: "STATISTIC_TYPE_COUNT",
  sum: "STATISTIC_TYPE_SUM",
  avg: "STATISTIC_TYPE_AVG",
  min: "STATISTIC_TYPE_MIN",
  max: "STATISTIC_TYPE_MAX",
  stddev: "STATISTIC_TYPE_STDDEV",
  var: "STATISTIC_TYPE_VAR",
};

/** Compile canonical query IR to the Honua gRPC `QueryFeatures` request shape. */
export function compileGrpcQuery(source: QueryIrSourceIdentity, query: CanonicalQuery): GrpcCompiledQueryV1 {
  if (source.protocol !== "grpc") {
    throw new HonuaQueryPlanningError(
      "unsupported-compiler",
      `honua-grpc-query-features-v1 does not compile protocol "${source.protocol}"`,
    );
  }
  if (source.serviceId === undefined || source.layerId === undefined) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `Source "${source.id}" requires locator.serviceId and locator.layerId for gRPC planning`,
    );
  }
  if (query.aggregation?.histogram || query.aggregation?.timeSeries) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "The gRPC compiler supports metrics and groupBy; histogram/timeSeries remain follow-on work",
    );
  }

  const aggregation = query.aggregation ? compileAggregation(query.aggregation) : undefined;
  // Aggregation returns statistic rows, never geometry — mirror the FeatureService
  // and GeoServices contract by forcing returnGeometry=false for statistics.
  const returnGeometry = aggregation ? false : query.returnGeometry;

  return {
    compiler: "honua-grpc-query-features-v1",
    service: "honua.v1.FeatureService",
    method: "QueryFeatures",
    serviceId: source.serviceId,
    layerId: source.layerId,
    ...(query.where ? { where: query.where.expression } : {}),
    ...(query.outFields && query.outFields.length > 0 ? { outFields: query.outFields } : {}),
    ...(returnGeometry !== undefined ? { returnGeometry } : {}),
    ...(query.outSr !== undefined ? { outSr: query.outSr } : {}),
    ...(query.orderBy && query.orderBy.length > 0
      ? {
          orderBy: query.orderBy.map((sort) => `${sort.field}${sort.direction === "desc" ? " DESC" : ""}`).join(","),
        }
      : {}),
    ...(query.spatialFilter
      ? {
          spatialFilter: {
            geometry: query.spatialFilter.geometry,
            geometryType: query.spatialFilter.geometryType,
            spatialRelationship: spatialRelationship(query.spatialFilter.spatialRel),
          },
        }
      : {}),
    ...(query.pagination?.offset !== undefined ? { resultOffset: query.pagination.offset } : {}),
    ...(query.pagination?.limit !== undefined ? { resultRecordCount: query.pagination.limit } : {}),
    ...aggregation,
  };
}

function spatialRelationship(rel: EsriSpatialRel | undefined): GrpcSpatialRelationship {
  if (rel === undefined) return "SPATIAL_RELATIONSHIP_INTERSECTS";
  const mapped = SPATIAL_REL_MAP[rel];
  if (!mapped) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      `gRPC transport does not support spatial relationship "${rel}"`,
    );
  }
  return mapped;
}

function compileAggregation(aggregation: AggregationSpec): Pick<GrpcCompiledQueryV1, "outStatistics" | "groupBy"> {
  return {
    outStatistics: aggregation.metrics.map((metric) => ({
      statisticType: STATISTIC_TYPE_MAP[metric.fn],
      onStatisticField: metric.field,
      outStatisticFieldName: metric.alias ?? `${metric.fn}_${metric.field}`,
    })),
    ...(aggregation.groupBy && aggregation.groupBy.length > 0 ? { groupBy: aggregation.groupBy } : {}),
  };
}
