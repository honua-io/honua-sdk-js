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

import { validateExecutableCrsBinding } from "../contract/schema.js";
import type {
  CanonicalGeometry,
  CrsDefinition,
  ExecutableCrsBinding,
  ExecutableGeometryValue,
  JsonPrimitive,
  JsonValue,
  LogicalField,
  Position,
  SourceSchemaV2,
} from "../contract/schema.js";
import type { AggregationFn, AggregationSpec } from "../contract/types.js";
import type { EsriSpatialRel } from "../core/types.js";
import { hashSemanticQuery } from "./semantic-canonical.js";
import {
  type RuntimeSemanticQuery,
  type SemanticCompilationResult,
  prepareSemanticCompilerQuery,
  runSemanticCompiler,
  sameExecutableCrs,
  semanticSchemaField,
  semanticUnsupported,
} from "./semantic-compiler.js";
import type { QueryFilter, SemanticQuery, SourceSpatiality } from "./semantic-types.js";
import type {
  CanonicalQuery,
  GrpcCompiledQueryV1,
  GrpcSpatialRelationship,
  GrpcStatisticType,
  QueryIrSourceIdentity,
} from "./types.js";
import { HonuaQueryPlanningError } from "./types.js";

/** Credential-free source locator fields needed by QueryFeatures. */
export interface SemanticGrpcSourceIdentity {
  readonly serviceId: string;
  readonly layerId: number;
}

export interface SemanticGrpcCompileOptions<
  TRecord = Record<string, unknown>,
  TSpatiality extends SourceSpatiality = SourceSpatiality,
> {
  readonly query: SemanticQuery<TRecord, "grpc", TSpatiality>;
  readonly schema: SourceSchemaV2;
  readonly source: SemanticGrpcSourceIdentity;
}

export interface SemanticGrpcSpatialReference {
  readonly wkid?: number;
  readonly wkt?: string;
}

export interface SemanticGrpcCoordinate {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
}

export interface SemanticGrpcCoordinateSequence {
  readonly coords: readonly SemanticGrpcCoordinate[];
}

/** Protobuf-free JSON pre-image of honua.v1.Geometry. */
export type SemanticGrpcGeometry =
  | { readonly point: SemanticGrpcCoordinate }
  | { readonly multiPoint: { readonly points: readonly SemanticGrpcCoordinate[] } }
  | { readonly polyline: { readonly paths: readonly SemanticGrpcCoordinateSequence[] } }
  | { readonly polygon: { readonly rings: readonly SemanticGrpcCoordinateSequence[] } }
  | {
      readonly multiPolygon: {
        readonly polygons: readonly { readonly rings: readonly SemanticGrpcCoordinateSequence[] }[];
      };
    };

export type SemanticGrpcSpatialRelationship = GrpcSpatialRelationship | "SPATIAL_RELATIONSHIP_EQUALS";

/** Canonical, protobuf-runtime-free QueryFeatures request artifact. */
export interface SemanticGrpcCompiledQueryV1 {
  readonly compiler: "honua-grpc-semantic-query-v1";
  readonly dialect: "honua-grpc";
  readonly schemaFingerprint: SourceSchemaV2["fingerprint"];
  readonly queryFingerprint: `sha256:${string}`;
  readonly service: "honua.v1.FeatureService";
  readonly method: "QueryFeatures";
  readonly serviceId: string;
  readonly layerId: number;
  readonly where?: string;
  readonly outFields?: readonly string[];
  readonly returnGeometry: boolean;
  readonly outSr?: SemanticGrpcSpatialReference;
  readonly orderBy?: string;
  readonly resultOffset?: number;
  readonly resultRecordCount?: number;
  readonly spatialFilter?: {
    readonly geometry: SemanticGrpcGeometry;
    readonly spatialRelationship: SemanticGrpcSpatialRelationship;
    readonly spatialReference: SemanticGrpcSpatialReference;
    /** Full executable binding retained beside the protobuf spatial reference. */
    readonly crs: ExecutableCrsBinding;
  };
  readonly outStatistics?: readonly {
    readonly statisticType: GrpcStatisticType;
    readonly onStatisticField: string;
    readonly outStatisticFieldName: string;
  }[];
  readonly groupBy?: readonly string[];
  readonly usesNativeFilter: boolean;
}

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

type RuntimeGrpcQuery = RuntimeSemanticQuery<"grpc">;
type RuntimeGrpcFilter = QueryFilter<Record<string, unknown>, "grpc", SourceSpatiality>;
type RuntimeGrpcSpatialFilter = Extract<RuntimeGrpcFilter, { readonly kind: "spatial" }>;

interface GrpcSemanticState {
  readonly schema: SourceSchemaV2;
  usesNativeFilter: boolean;
}

interface GrpcFilterParts {
  readonly where?: string;
  readonly spatial?: { readonly filter: RuntimeGrpcSpatialFilter; readonly path: string };
}

/** Compile a typed semantic query to the canonical QueryFeatures request shape. */
export function compileSemanticGrpcQuery<TRecord, TSpatiality extends SourceSpatiality>(
  options: SemanticGrpcCompileOptions<TRecord, TSpatiality>,
): SemanticCompilationResult<SemanticGrpcCompiledQueryV1> {
  return runSemanticCompiler(() => {
    const { query, schema } = prepareSemanticCompilerQuery(options.query, options.schema, "grpc");
    const source = verifiedGrpcSource(options.source);
    const state: GrpcSemanticState = { schema, usesNativeFilter: false };
    const parts = query.filter
      ? compileGrpcFilterParts(query.filter as RuntimeGrpcFilter, state, "$.filter")
      : ({} as GrpcFilterParts);
    const projection = grpcProjection(query, state);
    const spatialFilter = parts.spatial
      ? compileGrpcSpatial(parts.spatial.filter, state, parts.spatial.path)
      : undefined;
    const orderBy = grpcOrderBy(query, state);
    const aggregation = query.kind === "aggregate" ? grpcSemanticAggregation(query, state) : {};
    const page = query.page;
    verifyGrpcPage(page);
    const outSr = query.outputCrs ? grpcSpatialReference(query.outputCrs, "$.outputCrs") : undefined;
    if (outSr && query.kind === "features" && !projection.returnGeometry) {
      semanticUnsupported(
        "unsupported-projection",
        "$.outputCrs",
        "Honua gRPC cannot apply an output CRS when geometry is omitted",
      );
    }
    if (outSr && query.kind === "aggregate") {
      semanticUnsupported(
        "unsupported-projection",
        "$.outputCrs",
        "Honua gRPC aggregate rows do not carry output geometry",
      );
    }

    const artifact: SemanticGrpcCompiledQueryV1 = {
      compiler: "honua-grpc-semantic-query-v1",
      dialect: "honua-grpc",
      schemaFingerprint: schema.fingerprint,
      queryFingerprint: hashSemanticQuery(query, { schema, protocol: "grpc" }),
      service: "honua.v1.FeatureService",
      method: "QueryFeatures",
      serviceId: source.serviceId,
      layerId: source.layerId,
      ...(parts.where ? { where: parts.where } : {}),
      ...(projection.outFields ? { outFields: projection.outFields } : {}),
      returnGeometry: query.kind === "aggregate" ? false : projection.returnGeometry,
      ...(outSr ? { outSr } : {}),
      ...(orderBy ? { orderBy } : {}),
      ...(page?.kind === "offset" ? { resultOffset: page.offset } : {}),
      ...(page?.limit !== undefined ? { resultRecordCount: page.limit } : {}),
      ...(spatialFilter ? { spatialFilter } : {}),
      ...aggregation,
      usesNativeFilter: state.usesNativeFilter,
    };
    return { artifact };
  });
}

function verifiedGrpcSource(value: SemanticGrpcSourceIdentity): SemanticGrpcSourceIdentity {
  if (!value || typeof value !== "object") {
    throw new HonuaQueryPlanningError("invalid-query", "Semantic gRPC source identity is invalid");
  }
  if (
    typeof value.serviceId !== "string" ||
    value.serviceId.trim().length === 0 ||
    value.serviceId.length > 256 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: source identifiers cannot contain control bytes
    /[\u0000-\u001f\u007f]/.test(value.serviceId)
  ) {
    throw new HonuaQueryPlanningError("invalid-query", "options.source.serviceId is invalid");
  }
  if (!Number.isSafeInteger(value.layerId) || value.layerId < 0 || value.layerId > 2_147_483_647) {
    throw new HonuaQueryPlanningError("invalid-query", "options.source.layerId is invalid");
  }
  return { serviceId: value.serviceId, layerId: value.layerId };
}

function verifyGrpcPage(page: RuntimeGrpcQuery["page"]): void {
  if (!page) return;
  if (page.limit !== undefined && page.limit > 2_147_483_647) {
    semanticUnsupported("unsupported-node", "$.page.limit", "QueryFeatures result_record_count is int32-bounded");
  }
  if (page.kind === "offset" && page.offset > 2_147_483_647) {
    semanticUnsupported("unsupported-node", "$.page.offset", "QueryFeatures result_offset is int32-bounded");
  }
}

function grpcProjection(
  query: RuntimeGrpcQuery,
  state: GrpcSemanticState,
): { readonly outFields?: readonly string[]; readonly returnGeometry: boolean } {
  if (query.kind === "aggregate") return { returnGeometry: false };
  const primary = primaryGeometryField(state.schema);
  let geometryField: string | undefined;
  if (query.geometry && typeof query.geometry === "object") {
    geometryField = query.geometry.field;
  } else if (query.geometry !== "omit") {
    geometryField = primary;
  }
  if (query.geometry === "include" && !primary) {
    semanticUnsupported(
      "unsupported-projection",
      "$.geometry",
      "Honua gRPC geometry inclusion requires a known primary geometry field",
    );
  }
  if (geometryField && geometryField !== primary) {
    semanticUnsupported(
      "unsupported-projection",
      "$.geometry",
      "QueryFeatures can return only the source primary geometry field",
    );
  }
  if (!query.select) return { returnGeometry: geometryField !== undefined };
  const outFields: string[] = [];
  query.select.forEach((name, index) => {
    const field = semanticSchemaField(state.schema, name as string, `$.select[${index}]`);
    if (field.type.kind === "geometry") {
      if (field.name !== geometryField) {
        semanticUnsupported(
          "unsupported-projection",
          `$.select[${index}]`,
          "QueryFeatures cannot return a geometry field as an ordinary attribute",
        );
      }
      return;
    }
    outFields.push(grpcFieldPath(field, `$.select[${index}]`));
  });
  if (outFields.length === 0) {
    semanticUnsupported(
      "unsupported-projection",
      "$.select",
      "QueryFeatures cannot represent an explicit geometry-only projection",
    );
  }
  return { outFields, returnGeometry: geometryField !== undefined };
}

function grpcOrderBy(query: RuntimeGrpcQuery, state: GrpcSemanticState): string | undefined {
  if (!query.sort || query.sort.length === 0) return undefined;
  if (query.kind === "aggregate") {
    const groups = new Set(query.groupBy as readonly string[]);
    const unsupportedIndex = query.sort.findIndex((sort) => !groups.has(sort.field as string));
    if (unsupportedIndex >= 0) {
      semanticUnsupported(
        "unsupported-sort",
        `$.sort[${unsupportedIndex}].field`,
        "Honua gRPC aggregate queries may sort only by a grouped source field",
      );
    }
  }
  return query.sort
    .map((sort, index) => {
      if (sort.nulls && sort.nulls !== "native") {
        semanticUnsupported(
          "unsupported-sort",
          `$.sort[${index}].nulls`,
          "QueryFeatures does not carry an explicit null ordering",
        );
      }
      const field = semanticSchemaField(state.schema, sort.field as string, `$.sort[${index}].field`);
      return `${grpcSqlIdentifier(field, `$.sort[${index}].field`)}${sort.direction === "desc" ? " DESC" : " ASC"}`;
    })
    .join(", ");
}

function grpcSemanticAggregation(
  query: Extract<RuntimeGrpcQuery, { readonly kind: "aggregate" }>,
  state: GrpcSemanticState,
): Pick<SemanticGrpcCompiledQueryV1, "outStatistics" | "groupBy"> {
  return {
    outStatistics: query.metrics.map((metric, index) => {
      const field = metric.field
        ? semanticSchemaField(state.schema, metric.field as string, `$.metrics[${index}].field`)
        : undefined;
      const statisticType = {
        count: "STATISTIC_TYPE_COUNT",
        sum: "STATISTIC_TYPE_SUM",
        avg: "STATISTIC_TYPE_AVG",
        min: "STATISTIC_TYPE_MIN",
        max: "STATISTIC_TYPE_MAX",
        stddev: "STATISTIC_TYPE_STDDEV",
        variance: "STATISTIC_TYPE_VAR",
      }[metric.fn] as GrpcStatisticType;
      return {
        statisticType,
        onStatisticField: field ? grpcFieldPath(field, `$.metrics[${index}].field`) : "*",
        outStatisticFieldName: metric.as,
      };
    }),
    ...(query.groupBy.length > 0
      ? {
          groupBy: query.groupBy.map((name, index) =>
            grpcFieldPath(
              semanticSchemaField(state.schema, name as string, `$.groupBy[${index}]`),
              `$.groupBy[${index}]`,
            ),
          ),
        }
      : {}),
  };
}

function compileGrpcFilterParts(filter: RuntimeGrpcFilter, state: GrpcSemanticState, path: string): GrpcFilterParts {
  if (filter.kind === "spatial") return { spatial: { filter, path } };
  if (filter.kind === "boolean" && filter.operator === "and") {
    const where: string[] = [];
    let spatial: GrpcFilterParts["spatial"];
    filter.args.forEach((entry, index) => {
      const part = compileGrpcFilterParts(entry as RuntimeGrpcFilter, state, `${path}.args[${index}]`);
      if (part.where) where.push(part.where);
      if (part.spatial) {
        if (spatial) {
          semanticUnsupported("unsupported-node", part.spatial.path, "QueryFeatures carries only one spatial filter");
        }
        spatial = part.spatial;
      }
    });
    return {
      ...(where.length > 0 ? { where: where.length === 1 ? where[0] : `(${where.join(" AND ")})` } : {}),
      ...(spatial ? { spatial } : {}),
    };
  }
  if (containsGrpcSpatial(filter)) {
    semanticUnsupported("unsupported-node", path, "QueryFeatures cannot preserve spatial predicates inside OR or NOT");
  }
  return { where: compileGrpcAttributeFilter(filter, state, path) };
}

function containsGrpcSpatial(filter: RuntimeGrpcFilter): boolean {
  if (filter.kind === "spatial") return true;
  if (filter.kind === "boolean") return filter.args.some((entry) => containsGrpcSpatial(entry as RuntimeGrpcFilter));
  if (filter.kind === "not") return containsGrpcSpatial(filter.arg as RuntimeGrpcFilter);
  return false;
}

function compileGrpcAttributeFilter(filter: RuntimeGrpcFilter, state: GrpcSemanticState, path: string): string {
  switch (filter.kind) {
    case "comparison": {
      const field = semanticSchemaField(state.schema, filter.left.name, `${path}.left.name`);
      const operator = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" }[filter.operator];
      return `${grpcSqlIdentifier(field, `${path}.left.name`)} ${operator} ${grpcSqlLiteral(
        filter.right.value,
        field,
        `${path}.right.value`,
      )}`;
    }
    case "list": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      return `${grpcSqlIdentifier(field, `${path}.operand.name`)} IN (${filter.values
        .map((literal, index) => grpcSqlLiteral(literal.value, field, `${path}.values[${index}].value`))
        .join(", ")})`;
    }
    case "range": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      return `${grpcSqlIdentifier(field, `${path}.operand.name`)} BETWEEN ${grpcSqlLiteral(
        filter.lower.value,
        field,
        `${path}.lower.value`,
      )} AND ${grpcSqlLiteral(filter.upper.value, field, `${path}.upper.value`)}`;
    }
    case "null": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      return `${grpcSqlIdentifier(field, `${path}.operand.name`)} IS ${filter.operator === "is-not-null" ? "NOT " : ""}NULL`;
    }
    case "pattern": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      const value = grpcQuotedString(filter.pattern);
      if (filter.caseSensitive === false) {
        return `LOWER(${grpcSqlIdentifier(field, `${path}.operand.name`)}) LIKE LOWER(${value})`;
      }
      return `${grpcSqlIdentifier(field, `${path}.operand.name`)} LIKE ${value}`;
    }
    case "boolean":
      return `(${filter.args
        .map((entry, index) => compileGrpcAttributeFilter(entry as RuntimeGrpcFilter, state, `${path}.args[${index}]`))
        .join(` ${filter.operator.toUpperCase()} `)})`;
    case "not":
      return `NOT (${compileGrpcAttributeFilter(filter.arg as RuntimeGrpcFilter, state, `${path}.arg`)})`;
    case "temporal": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      if (filter.operator === "before" || filter.operator === "after") {
        return `${grpcSqlIdentifier(field, `${path}.operand.name`)} ${filter.operator === "before" ? "<" : ">"} ${grpcSqlLiteral(
          filter.value.value as string,
          field,
          `${path}.value.value`,
        )}`;
      }
      const interval = filter.value.value as readonly [string, string];
      return `${grpcSqlIdentifier(field, `${path}.operand.name`)} BETWEEN ${grpcSqlLiteral(
        interval[0],
        field,
        `${path}.value.value[0]`,
      )} AND ${grpcSqlLiteral(interval[1], field, `${path}.value.value[1]`)}`;
    }
    case "native":
      state.usesNativeFilter = true;
      return grpcNativeWhere(filter.payload.value, path);
    case "spatial":
      semanticUnsupported("unsupported-node", path, "Spatial filters require the QueryFeatures spatial_filter field");
  }
}

function grpcNativeWhere(value: JsonValue, path: string): string {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    semanticUnsupported(
      "unsupported-native-filter",
      path,
      "honua-grpc native filter payload must be an object containing only where",
    );
  }
  const keys = Object.keys(value);
  const where = (value as { readonly where?: JsonValue }).where;
  if (keys.length !== 1 || keys[0] !== "where" || typeof where !== "string" || where.trim().length === 0) {
    semanticUnsupported(
      "unsupported-native-filter",
      path,
      "honua-grpc native filter payload must be an object containing one non-empty where string",
    );
  }
  return where;
}

function compileGrpcSpatial(
  filter: RuntimeGrpcSpatialFilter,
  state: GrpcSemanticState,
  path: string,
): NonNullable<SemanticGrpcCompiledQueryV1["spatialFilter"]> {
  if (filter.operator === "bbox-intersects") {
    semanticUnsupported(
      "unsupported-geometry",
      path,
      "QueryFeatures has no envelope geometry message; bbox is not fabricated as a polygon",
    );
  }
  if (filter.operator === "within-distance" || filter.operator === "beyond-distance") {
    semanticUnsupported(
      "unsupported-distance",
      `${path}.distance`,
      "QueryFeatures does not encode the semantic planar/geodesic distance mode",
    );
  }
  const fieldName = filter.property?.name ?? primaryGeometryField(state.schema);
  if (!fieldName) {
    semanticUnsupported("unsupported-geometry", `${path}.property`, "QueryFeatures requires a primary geometry field");
  }
  const primary = primaryGeometryField(state.schema);
  if (fieldName !== primary) {
    semanticUnsupported(
      "unsupported-geometry",
      `${path}.property`,
      "QueryFeatures cannot target a secondary geometry field",
    );
  }
  const sourceGeometry = sourceGrpcGeometryField(state.schema, fieldName, path);
  const sourceCrs = executableGrpcCrs(sourceGeometry.crs, `${path}.property`);
  const literalCrs = filter.geometry.crs;
  grpcSpatialReferenceFromBinding(sourceCrs, `${path}.property`);
  const literalReference = grpcSpatialReferenceFromBinding(literalCrs, `${path}.geometry.crs`);
  if (!sameExecutableCrs(sourceCrs, literalCrs)) {
    semanticUnsupported(
      "crs-transform-required",
      `${path}.geometry.crs`,
      "Spatial geometry CRS differs from the QueryFeatures source field",
    );
  }
  const relationship = {
    equals: "SPATIAL_RELATIONSHIP_EQUALS",
    intersects: "SPATIAL_RELATIONSHIP_INTERSECTS",
    within: "SPATIAL_RELATIONSHIP_WITHIN",
    contains: "SPATIAL_RELATIONSHIP_CONTAINS",
    disjoint: "SPATIAL_RELATIONSHIP_DISJOINT",
    touches: "SPATIAL_RELATIONSHIP_TOUCHES",
    overlaps: "SPATIAL_RELATIONSHIP_OVERLAPS",
    crosses: "SPATIAL_RELATIONSHIP_CROSSES",
  }[filter.operator] as SemanticGrpcSpatialRelationship;
  return {
    geometry: grpcGeometry(filter.geometry, path),
    spatialRelationship: relationship,
    spatialReference: literalReference,
    crs: literalCrs,
  };
}

function grpcGeometry(value: ExecutableGeometryValue, path: string): SemanticGrpcGeometry {
  assertGrpcCoordinateOrder(value.crs, `${path}.geometry.crs`);
  if (value.layout !== "xy" && value.layout !== "xyz") {
    semanticUnsupported(
      "unsupported-geometry",
      `${path}.geometry.layout`,
      "QueryFeatures geometry cannot preserve measured coordinate layouts",
    );
  }
  return grpcCanonicalGeometry(value.geometry, value.layout, path);
}

function grpcCanonicalGeometry(geometry: CanonicalGeometry, layout: "xy" | "xyz", path: string): SemanticGrpcGeometry {
  switch (geometry.type) {
    case "Point":
      return { point: grpcCoordinate(geometry.coordinates, layout) };
    case "MultiPoint":
      return { multiPoint: { points: geometry.coordinates.map((position) => grpcCoordinate(position, layout)) } };
    case "LineString":
      return {
        polyline: { paths: [{ coords: geometry.coordinates.map((position) => grpcCoordinate(position, layout)) }] },
      };
    case "MultiLineString":
      return {
        polyline: {
          paths: geometry.coordinates.map((line) => ({
            coords: line.map((position) => grpcCoordinate(position, layout)),
          })),
        },
      };
    case "Polygon":
      return {
        polygon: {
          rings: geometry.coordinates.map((ring) => ({
            coords: ring.map((position) => grpcCoordinate(position, layout)),
          })),
        },
      };
    case "MultiPolygon":
      return {
        multiPolygon: {
          polygons: geometry.coordinates.map((polygon) => ({
            rings: polygon.map((ring) => ({
              coords: ring.map((position) => grpcCoordinate(position, layout)),
            })),
          })),
        },
      };
    case "GeometryCollection":
      semanticUnsupported(
        "unsupported-geometry",
        `${path}.geometry.geometry`,
        "honua.v1.Geometry has no GeometryCollection payload",
      );
  }
}

function grpcCoordinate(position: Position, layout: "xy" | "xyz"): SemanticGrpcCoordinate {
  return {
    x: position[0],
    y: position[1],
    ...(layout === "xyz" ? { z: position[2] as number } : {}),
  };
}

function executableGrpcCrs(value: unknown, path: string): ExecutableCrsBinding {
  try {
    return validateExecutableCrsBinding(value, path);
  } catch {
    semanticUnsupported("unsupported-crs", path, "QueryFeatures requires a resolved source CRS and payload order");
  }
}

function grpcSpatialReferenceFromBinding(value: ExecutableCrsBinding, path: string): SemanticGrpcSpatialReference {
  if (value.coordinateEpoch !== undefined) {
    semanticUnsupported("unsupported-crs", path, "QueryFeatures spatial references cannot preserve coordinate epochs");
  }
  assertGrpcCoordinateOrder(value, path);
  return grpcSpatialReference(value.definition, path);
}

function grpcSpatialReference(value: CrsDefinition, path: string): SemanticGrpcSpatialReference {
  if (value.kind === "authority" && value.authority.toUpperCase() === "EPSG" && /^\d+$/.test(value.code)) {
    const wkid = Number(value.code);
    if (Number.isSafeInteger(wkid) && wkid > 0 && wkid <= 2_147_483_647) return { wkid };
  }
  if (value.kind === "wkt" && value.validation === "engine") return { wkt: value.wkt };
  semanticUnsupported(
    "unsupported-crs",
    path,
    "QueryFeatures spatial references require an EPSG code or engine-validated WKT",
  );
}

function assertGrpcCoordinateOrder(value: ExecutableCrsBinding, path: string): void {
  const [x, y] = value.coordinateOrder.axes;
  const xDirection = x?.direction;
  const yDirection = y?.direction;
  if (xDirection !== "east" || yDirection !== "north") {
    semanticUnsupported("unsupported-crs", path, "QueryFeatures geometry requires east/north x/y payload axes");
  }
}

function sourceGrpcGeometryField(schema: SourceSchemaV2, fieldName: string, path: string) {
  if (schema.geometry.state !== "known") {
    semanticUnsupported("unsupported-source", path, "Source geometry metadata is unavailable");
  }
  const field = schema.geometry.fields.find((candidate) => candidate.field === fieldName);
  if (!field) semanticUnsupported("unsupported-source", path, "Source primary geometry metadata is unavailable");
  return field;
}

function primaryGeometryField(schema: SourceSchemaV2): string | undefined {
  return schema.geometry.state === "known" && schema.geometry.primaryField.state === "known"
    ? schema.geometry.primaryField.field
    : undefined;
}

function grpcSqlLiteral(value: JsonValue, field: LogicalField, path: string): string {
  if (value === null || Array.isArray(value) || typeof value === "object") {
    semanticUnsupported(
      "unsupported-field-type",
      path,
      `Honua gRPC does not encode ${field.type.kind} as a scalar where literal`,
    );
  }
  switch (field.type.kind) {
    case "boolean":
      if (typeof value !== "boolean") break;
      return value ? "TRUE" : "FALSE";
    case "integer":
      if (typeof value === "number") return String(value);
      if (typeof value === "string" && /^[+-]?\d+$/.test(value)) return value;
      break;
    case "float":
      if (typeof value === "number") return String(value);
      break;
    case "decimal":
      if (typeof value === "number") return String(value);
      if (typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return value;
      break;
    case "string":
    case "uuid":
    case "date":
    case "time":
    case "timestamp":
      if (typeof value === "string") return grpcQuotedString(value);
      break;
    case "duration":
    case "binary":
    case "json":
    case "geometry":
    case "list":
    case "struct":
    case "union":
    case "unknown":
      semanticUnsupported(
        "unsupported-field-type",
        path,
        `Honua gRPC semantic filtering does not support logical type ${field.type.kind}`,
      );
  }
  semanticUnsupported(
    "unsupported-field-type",
    path,
    `Honua gRPC literal is incompatible with logical type ${field.type.kind}`,
  );
}

function grpcQuotedString(value: string): string {
  if (value.includes("\u0000")) {
    throw new HonuaQueryPlanningError("invalid-query", "Semantic gRPC literal contains a NUL byte");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function grpcSqlIdentifier(field: LogicalField, path: string): string {
  return field.path
    .map((segment) => {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: SQL identifiers cannot contain control bytes
      if (/[\u0000-\u001f\u007f]/.test(segment)) {
        semanticUnsupported("unsupported-source", path, "QueryFeatures cannot represent the physical field identifier");
      }
      return `"${segment.replace(/"/g, '""')}"`;
    })
    .join(".");
}

function grpcFieldPath(field: LogicalField, path: string): string {
  for (const segment of field.path) {
    // QueryFeatures carries physical projection paths as one dot-delimited
    // string, so a literal dot or control byte in a segment is not losslessly
    // representable even though the SQL where grammar can quote that segment.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: protobuf field paths cannot contain control bytes
    if (segment.includes(".") || /[\u0000-\u001f\u007f]/.test(segment)) {
      semanticUnsupported("unsupported-source", path, "QueryFeatures cannot represent the physical field path");
    }
  }
  return field.path.join(".");
}
