import {
  type QueryFilterContext,
  compileQueryFilterToSql92,
  compileTemporalFilterToGeoServicesTime,
} from "../contract/query-filter.js";
import { validateExecutableCrsBinding } from "../contract/schema.js";
import type {
  CanonicalGeometry,
  CrsDefinition,
  ExecutableBoundingBox,
  ExecutableCrsBinding,
  ExecutableGeometryValue,
  JsonValue,
  LogicalField,
  Position,
  SourceSchemaV2,
} from "../contract/schema.js";
import type { AggregationFn, AggregationSpec } from "../contract/types.js";
import { canonicalFilterParts } from "./canonical-filter.js";
import { hashSemanticQuery } from "./semantic-canonical.js";
import {
  type RuntimeSemanticQuery,
  type SemanticCompilationResult,
  prepareSemanticCompilerQuery,
  runSemanticCompiler,
  sameCrsDefinition,
  sameExecutableCrs,
  semanticSchemaField,
  semanticUnsupported,
} from "./semantic-compiler.js";
import {
  type SemanticCompilerFieldMapping,
  exactDecimalText,
  finiteDecimalNumber,
  quotedSemanticString,
  recordSemanticFieldMapping,
  semanticRequestFingerprint,
  sortSemanticFieldMappings,
  sql92Identifier,
  verifiedSemanticNativeText,
  verifiedSemanticSourceText,
  verifiedSemanticSourceVersion,
} from "./semantic-literals.js";
import type { QueryFilter, SemanticQuery, SourceSpatiality } from "./semantic-types.js";
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
  const ctx: QueryFilterContext = { protocol: source.protocol, sourceId: source.id };
  const parts = canonicalFilterParts(query, ctx);
  const typed = parts.expression ? compileQueryFilterToSql92(parts.expression, ctx) : {};
  if (query.spatialFilter && typed.spatialFilter) {
    throw new HonuaQueryPlanningError(
      "unsupported-query",
      "A GeoServices query request carries one geometry; Query.spatialFilter and a spatial filter node cannot both be sent",
    );
  }
  const spatialFilter = query.spatialFilter ?? typed.spatialFilter;
  const whereParts = [
    ...(query.where ? [query.where.expression] : []),
    ...(typed.where !== undefined ? [typed.where] : []),
  ];
  const where =
    whereParts.length === 0
      ? undefined
      : whereParts.length === 1
        ? whereParts[0]
        : whereParts.map((part) => `(${part})`).join(" AND ");
  return {
    compiler: "geoservices-rest-query-v1",
    serviceId: source.serviceId,
    layerId: source.layerId,
    ...(where !== undefined ? { where } : {}),
    ...(parts.protocolTime ? { time: compileTemporalFilterToGeoServicesTime(parts.protocolTime, ctx) } : {}),
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
    ...(spatialFilter
      ? {
          geometry: spatialFilter.geometry as GeoServicesCompiledQueryV1["geometry"],
          geometryType: spatialFilter.geometryType,
          ...(spatialFilter.spatialRel ? { spatialRel: spatialFilter.spatialRel } : {}),
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

export type SemanticGeoServicesProtocol = "geoservices-feature-service" | "geoservices-map-service";

export type SemanticGeoServicesSpatialRelationship =
  | "esriSpatialRelIntersects"
  | "esriSpatialRelContains"
  | "esriSpatialRelWithin"
  | "esriSpatialRelCrosses"
  | "esriSpatialRelTouches"
  | "esriSpatialRelOverlaps";

/** Static, credential-free layer evidence required by semantic GeoServices compilation. */
export interface SemanticGeoServicesSourceIdentity {
  readonly protocol: SemanticGeoServicesProtocol;
  readonly serviceId: string;
  readonly layerId: number;
  readonly sourceVersion?: string;
  /** Exact relationships advertised by layer metadata. Omission is not treated as support. */
  readonly supportedSpatialRelationships?: readonly SemanticGeoServicesSpatialRelationship[];
  /** Layer-level `supportsAdvancedQueries`; required before emitting orderByFields. */
  readonly supportsAdvancedQueries?: boolean;
  /** `advancedQueryCapabilities.supportsPagination`; required for resultOffset/resultRecordCount. */
  readonly supportsPagination?: boolean;
  /** Layer `supportsStatistics`; required for outStatistics/groupByFieldsForStatistics. */
  readonly supportsStatistics?: boolean;
  /** Explicit layer evidence for resultOffset on statistics requests. */
  readonly supportsPaginationOnAggregatedQueries?: boolean;
}

export interface SemanticGeoServicesCompileOptions<
  TRecord = Record<string, unknown>,
  TSpatiality extends SourceSpatiality = SourceSpatiality,
> {
  readonly query: SemanticQuery<TRecord, SemanticGeoServicesProtocol, TSpatiality>;
  readonly schema: SourceSchemaV2;
  readonly source: SemanticGeoServicesSourceIdentity;
}

export interface SemanticGeoServicesSpatialReference {
  readonly wkid?: number;
  readonly wkt?: string;
}

export type SemanticGeoServicesGeometry =
  | { readonly x: number; readonly y: number; readonly z?: number }
  | { readonly points: readonly (readonly number[])[] }
  | { readonly paths: readonly (readonly (readonly number[])[])[] }
  | { readonly rings: readonly (readonly (readonly number[])[])[] }
  | { readonly xmin: number; readonly ymin: number; readonly xmax: number; readonly ymax: number };

/** Canonical pre-image of a GeoServices layer `query` request. */
export interface SemanticGeoServicesCompiledQueryV1 {
  readonly compiler: "geoservices-sql92-semantic-query-v1";
  readonly dialect: "geoservices-sql92";
  readonly protocol: SemanticGeoServicesProtocol;
  readonly schemaFingerprint: SourceSchemaV2["fingerprint"];
  readonly queryFingerprint: `sha256:${string}`;
  readonly requestFingerprint: `sha256:${string}`;
  readonly serviceId: string;
  readonly layerId: number;
  readonly sourceVersion?: string;
  readonly sqlFormat: "standard";
  readonly where?: string;
  readonly outFields?: readonly string[];
  readonly returnGeometry: boolean;
  readonly returnZ?: boolean;
  readonly returnM?: boolean;
  readonly outSr?: SemanticGeoServicesSpatialReference;
  readonly orderByFields?: string;
  readonly resultOffset?: number;
  readonly resultRecordCount?: number;
  readonly geometry?: SemanticGeoServicesGeometry;
  readonly geometryType?:
    | "esriGeometryPoint"
    | "esriGeometryMultipoint"
    | "esriGeometryPolyline"
    | "esriGeometryPolygon"
    | "esriGeometryEnvelope";
  readonly inSr?: SemanticGeoServicesSpatialReference;
  readonly spatialRel?: SemanticGeoServicesSpatialRelationship;
  readonly outStatistics?: readonly {
    readonly statisticType: "count" | "sum" | "avg" | "min" | "max" | "stddev" | "var";
    readonly onStatisticField: string;
    readonly outStatisticFieldName: string;
  }[];
  readonly groupByFieldsForStatistics?: string;
  readonly fieldMappings: readonly SemanticCompilerFieldMapping[];
  readonly usesNativeFilter: boolean;
}

type RuntimeGeoServicesQuery = RuntimeSemanticQuery<SemanticGeoServicesProtocol>;
type RuntimeGeoServicesFilter = QueryFilter<Record<string, unknown>, SemanticGeoServicesProtocol, SourceSpatiality>;
type RuntimeGeoServicesSpatialFilter = Extract<RuntimeGeoServicesFilter, { readonly kind: "spatial" }>;

interface GeoServicesSemanticState {
  readonly schema: SourceSchemaV2;
  readonly source: VerifiedGeoServicesSource;
  readonly fieldMappings: SemanticCompilerFieldMapping[];
  usesNativeFilter: boolean;
}

interface VerifiedGeoServicesSource extends SemanticGeoServicesSourceIdentity {
  readonly supportedSpatialRelationships: readonly SemanticGeoServicesSpatialRelationship[];
  readonly supportsAdvancedQueries: boolean;
  readonly supportsPagination: boolean;
  readonly supportsStatistics: boolean;
  readonly supportsPaginationOnAggregatedQueries: boolean;
}

interface GeoServicesFilterParts {
  readonly where?: string;
  readonly spatial?: { readonly filter: RuntimeGeoServicesSpatialFilter; readonly path: string };
}

/** Compile a validated semantic AST to an exact GeoServices SQL-92 request. */
export function compileSemanticGeoServicesQuery<TRecord, TSpatiality extends SourceSpatiality>(
  options: SemanticGeoServicesCompileOptions<TRecord, TSpatiality>,
): SemanticCompilationResult<SemanticGeoServicesCompiledQueryV1> {
  return runSemanticCompiler(() => {
    const source = verifiedGeoServicesSource(options.source);
    const { query, schema } = prepareSemanticCompilerQuery(options.query, options.schema, source.protocol);
    const state: GeoServicesSemanticState = { schema, source, fieldMappings: [], usesNativeFilter: false };
    const parts = query.filter
      ? compileGeoServicesFilterParts(query.filter as RuntimeGeoServicesFilter, state, "$.filter")
      : ({} as GeoServicesFilterParts);
    const projection = geoServicesProjection(query, state);
    const spatial = parts.spatial
      ? compileGeoServicesSpatial(parts.spatial.filter, state, parts.spatial.path)
      : undefined;
    const orderByFields = geoServicesOrderBy(query, state);
    const aggregation = query.kind === "aggregate" ? geoServicesSemanticAggregation(query, state) : {};
    const page = geoServicesPage(query, state);
    const outSr = geoServicesOutputCrs(query, projection.returnGeometry, state);
    const queryFingerprint = hashSemanticQuery(query, { schema, protocol: source.protocol });
    const request = {
      protocol: source.protocol,
      serviceId: source.serviceId,
      layerId: source.layerId,
      ...(source.sourceVersion ? { sourceVersion: source.sourceVersion } : {}),
      sqlFormat: "standard" as const,
      ...(parts.where ? { where: parts.where } : {}),
      ...projection,
      ...(outSr ? { outSr } : {}),
      ...(orderByFields ? { orderByFields } : {}),
      ...page,
      ...spatial,
      ...aggregation,
      fieldMappings: sortSemanticFieldMappings(state.fieldMappings),
      usesNativeFilter: state.usesNativeFilter,
    };
    const artifact: SemanticGeoServicesCompiledQueryV1 = {
      compiler: "geoservices-sql92-semantic-query-v1",
      dialect: "geoservices-sql92",
      schemaFingerprint: schema.fingerprint,
      queryFingerprint,
      requestFingerprint: semanticRequestFingerprint("honua:query-request:geoservices-sql92:1", {
        schemaFingerprint: schema.fingerprint,
        queryFingerprint,
        sourceVersion: source.sourceVersion ?? null,
        request,
      }),
      ...request,
    };
    return { artifact };
  });
}

function verifiedGeoServicesSource(value: SemanticGeoServicesSourceIdentity): VerifiedGeoServicesSource {
  if (!value || typeof value !== "object") {
    throw new HonuaQueryPlanningError("invalid-query", "Semantic GeoServices source identity is invalid");
  }
  if (value.protocol !== "geoservices-feature-service" && value.protocol !== "geoservices-map-service") {
    throw new HonuaQueryPlanningError("invalid-query", "options.source.protocol is invalid");
  }
  const serviceId = verifiedSemanticSourceText(value.serviceId, "options.source.serviceId");
  if (!Number.isSafeInteger(value.layerId) || value.layerId < 0 || value.layerId > 2_147_483_647) {
    throw new HonuaQueryPlanningError("invalid-query", "options.source.layerId is invalid");
  }
  const sourceVersion = verifiedSemanticSourceVersion(value.sourceVersion, "options.source.sourceVersion");
  for (const capability of [
    "supportsAdvancedQueries",
    "supportsPagination",
    "supportsStatistics",
    "supportsPaginationOnAggregatedQueries",
  ] as const) {
    if (value[capability] !== undefined && typeof value[capability] !== "boolean") {
      throw new HonuaQueryPlanningError("invalid-query", `options.source.${capability} is invalid`);
    }
  }
  const relationships = value.supportedSpatialRelationships ?? [];
  if (!Array.isArray(relationships)) {
    throw new HonuaQueryPlanningError("invalid-query", "options.source.supportedSpatialRelationships is invalid");
  }
  const allowed = new Set<SemanticGeoServicesSpatialRelationship>([
    "esriSpatialRelIntersects",
    "esriSpatialRelContains",
    "esriSpatialRelWithin",
    "esriSpatialRelCrosses",
    "esriSpatialRelTouches",
    "esriSpatialRelOverlaps",
  ]);
  const seen = new Set<string>();
  for (const relationship of relationships) {
    if (!allowed.has(relationship) || seen.has(relationship)) {
      throw new HonuaQueryPlanningError("invalid-query", "options.source.supportedSpatialRelationships is invalid");
    }
    seen.add(relationship);
  }
  return {
    protocol: value.protocol,
    serviceId,
    layerId: value.layerId,
    ...(sourceVersion ? { sourceVersion } : {}),
    supportedSpatialRelationships: [...relationships].sort(),
    supportsAdvancedQueries: value.supportsAdvancedQueries === true,
    supportsPagination: value.supportsPagination === true,
    supportsStatistics: value.supportsStatistics === true,
    supportsPaginationOnAggregatedQueries: value.supportsPaginationOnAggregatedQueries === true,
  };
}

function geoServicesProjection(
  query: RuntimeGeoServicesQuery,
  state: GeoServicesSemanticState,
): Pick<SemanticGeoServicesCompiledQueryV1, "outFields" | "returnGeometry" | "returnZ" | "returnM"> {
  if (query.kind === "aggregate") return { returnGeometry: false };
  const primary = primaryGeometryField(state.schema);
  const geometryField =
    query.geometry && typeof query.geometry === "object"
      ? query.geometry.field
      : query.geometry === "omit"
        ? undefined
        : primary;
  if (query.geometry === "include" && !primary) {
    semanticUnsupported(
      "unsupported-projection",
      "$.geometry",
      "GeoServices geometry inclusion requires a known primary geometry field",
    );
  }
  if (geometryField && geometryField !== primary) {
    semanticUnsupported(
      "unsupported-projection",
      "$.geometry",
      "A GeoServices layer can return only its primary geometry field",
    );
  }
  const requested = query.select ?? state.schema.fields.map((field) => field.name);
  const outFields: string[] = [];
  requested.forEach((name, index) => {
    const path = query.select ? `$.select[${index}]` : "$.schema.fields";
    const field = semanticSchemaField(state.schema, name as string, path);
    if (field.type.kind === "geometry") {
      if (query.select && field.name !== geometryField) {
        semanticUnsupported(
          "unsupported-projection",
          path,
          "A geometry field cannot be returned as a GeoServices attribute",
        );
      }
      return;
    }
    outFields.push(geoServicesRequestField(field, state, path));
  });
  if (outFields.length === 0) {
    semanticUnsupported(
      "unsupported-projection",
      query.select ? "$.select" : "$.schema.fields",
      "GeoServices cannot prove an exact geometry-only attribute projection",
    );
  }
  if (!geometryField) return { outFields, returnGeometry: false };
  const geometryPath = query.geometry === undefined ? "$.schema.geometry" : "$.geometry";
  const field = semanticSchemaField(state.schema, geometryField, geometryPath);
  geoServicesPhysicalField(field, state, geometryPath);
  const metadata = sourceGeometryField(state.schema, geometryField, geometryPath);
  switch (metadata.layout) {
    case "xy":
      return { outFields, returnGeometry: true, returnZ: false, returnM: false };
    case "xyz":
      return { outFields, returnGeometry: true, returnZ: true, returnM: false };
    case "xym":
      return { outFields, returnGeometry: true, returnZ: false, returnM: true };
    case "xyzm":
      return { outFields, returnGeometry: true, returnZ: true, returnM: true };
    default:
      semanticUnsupported(
        "unsupported-projection",
        geometryPath,
        "GeoServices geometry output requires a known xy, xyz, xym, or xyzm source layout",
      );
  }
}

function geoServicesOutputCrs(
  query: RuntimeGeoServicesQuery,
  returnGeometry: boolean,
  state: GeoServicesSemanticState,
): SemanticGeoServicesSpatialReference | undefined {
  if (!query.outputCrs) return undefined;
  if (!returnGeometry) {
    semanticUnsupported(
      "unsupported-projection",
      "$.outputCrs",
      "GeoServices cannot apply an output CRS when geometry is omitted",
    );
  }
  const primary = primaryGeometryField(state.schema);
  if (!primary) {
    semanticUnsupported(
      "unsupported-source",
      "$.outputCrs",
      "GeoServices output CRS requires a primary geometry field",
    );
  }
  const metadata = sourceGeometryField(state.schema, primary, "$.outputCrs");
  const sourceCrs = executableGeoServicesCrs(metadata.crs, "$.outputCrs");
  if (!sameCrsDefinition(sourceCrs.definition, query.outputCrs)) {
    semanticUnsupported(
      "crs-transform-required",
      "$.outputCrs",
      "GeoServices output reprojection requires explicit datum-transformation evidence",
    );
  }
  return geoServicesSpatialReference(query.outputCrs, "$.outputCrs");
}

function geoServicesOrderBy(query: RuntimeGeoServicesQuery, state: GeoServicesSemanticState): string | undefined {
  if (!query.sort || query.sort.length === 0) return undefined;
  if (!state.source.supportsAdvancedQueries) {
    semanticUnsupported(
      "unsupported-source",
      "$.sort",
      "GeoServices orderByFields requires explicit supportsAdvancedQueries layer evidence",
    );
  }
  if (query.kind === "aggregate") {
    const groups = new Set(query.groupBy as readonly string[]);
    const index = query.sort.findIndex((sort) => !groups.has(sort.field as string));
    if (index >= 0) {
      semanticUnsupported(
        "unsupported-sort",
        `$.sort[${index}].field`,
        "GeoServices statistics can sort only by grouped source fields",
      );
    }
  }
  return query.sort
    .map((sort, index) => {
      if (sort.nulls && sort.nulls !== "native") {
        semanticUnsupported(
          "unsupported-sort",
          `$.sort[${index}].nulls`,
          "GeoServices SQL-92 does not expose a portable explicit null order",
        );
      }
      const path = `$.sort[${index}].field`;
      const field = semanticSchemaField(state.schema, sort.field as string, path);
      const requestField = geoServicesRequestField(field, state, path);
      return `${sql92Identifier(requestField, path)} ${sort.direction === "desc" ? "DESC" : "ASC"}`;
    })
    .join(", ");
}

function geoServicesPage(
  query: RuntimeGeoServicesQuery,
  state: GeoServicesSemanticState,
): Pick<SemanticGeoServicesCompiledQueryV1, "resultOffset" | "resultRecordCount"> {
  if (!query.page) return {};
  if (!state.source.supportsPagination) {
    semanticUnsupported(
      "unsupported-source",
      "$.page",
      "GeoServices pagination requires explicit supportsPagination layer evidence",
    );
  }
  if (query.kind === "aggregate" && !state.source.supportsPaginationOnAggregatedQueries) {
    semanticUnsupported(
      "unsupported-source",
      "$.page",
      "GeoServices aggregate pagination requires explicit layer capability evidence",
    );
  }
  if (query.page.limit !== undefined && query.page.limit > 2_147_483_647) {
    semanticUnsupported("unsupported-node", "$.page.limit", "GeoServices resultRecordCount is int32-bounded");
  }
  if (query.page.kind === "offset" && query.page.offset > 2_147_483_647) {
    semanticUnsupported("unsupported-node", "$.page.offset", "GeoServices resultOffset is int32-bounded");
  }
  return {
    ...(query.page.kind === "offset" ? { resultOffset: query.page.offset } : {}),
    ...(query.page.limit !== undefined ? { resultRecordCount: query.page.limit } : {}),
  };
}

function geoServicesSemanticAggregation(
  query: Extract<RuntimeGeoServicesQuery, { readonly kind: "aggregate" }>,
  state: GeoServicesSemanticState,
): Pick<SemanticGeoServicesCompiledQueryV1, "outStatistics" | "groupByFieldsForStatistics"> {
  if (!state.source.supportsStatistics) {
    semanticUnsupported(
      "unsupported-source",
      "$.metrics",
      "GeoServices outStatistics requires explicit supportsStatistics layer evidence",
    );
  }
  if (query.outputCrs) {
    semanticUnsupported("unsupported-projection", "$.outputCrs", "GeoServices aggregate rows do not carry geometry");
  }
  const groupBy = query.groupBy.map((name, index) =>
    geoServicesRequestField(
      semanticSchemaField(state.schema, name as string, `$.groupBy[${index}]`),
      state,
      `$.groupBy[${index}]`,
    ),
  );
  const names = new Set(groupBy.map((name) => name.toLocaleLowerCase("en-US")));
  const outStatistics = query.metrics.map((metric, index) => {
    if (!metric.field) {
      semanticUnsupported(
        "unsupported-node",
        `$.metrics[${index}].field`,
        "GeoServices statistics require a named physical source field",
      );
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(metric.as)) {
      semanticUnsupported(
        "unsupported-node",
        `$.metrics[${index}].as`,
        "GeoServices statistic aliases require an ASCII identifier",
      );
    }
    const folded = metric.as.toLocaleLowerCase("en-US");
    if (names.has(folded)) {
      semanticUnsupported(
        "unsupported-node",
        `$.metrics[${index}].as`,
        "GeoServices statistic result fields must be unique under case folding",
      );
    }
    names.add(folded);
    const field = semanticSchemaField(state.schema, metric.field as string, `$.metrics[${index}].field`);
    return {
      statisticType: (metric.fn === "variance" ? "var" : metric.fn) as
        | "count"
        | "sum"
        | "avg"
        | "min"
        | "max"
        | "stddev"
        | "var",
      onStatisticField: geoServicesRequestField(field, state, `$.metrics[${index}].field`),
      outStatisticFieldName: metric.as,
    };
  });
  return {
    outStatistics,
    ...(groupBy.length > 0 ? { groupByFieldsForStatistics: groupBy.join(",") } : {}),
  };
}

function compileGeoServicesFilterParts(
  filter: RuntimeGeoServicesFilter,
  state: GeoServicesSemanticState,
  path: string,
): GeoServicesFilterParts {
  if (filter.kind === "spatial") return { spatial: { filter, path } };
  if (filter.kind === "boolean" && filter.operator === "and") {
    const where: string[] = [];
    let spatial: GeoServicesFilterParts["spatial"];
    filter.args.forEach((entry, index) => {
      const child = compileGeoServicesFilterParts(entry as RuntimeGeoServicesFilter, state, `${path}.args[${index}]`);
      if (child.where) where.push(child.where);
      if (child.spatial) {
        if (spatial) {
          semanticUnsupported(
            "unsupported-node",
            child.spatial.path,
            "A GeoServices query request can carry only one spatial predicate",
          );
        }
        spatial = child.spatial;
      }
    });
    return {
      ...(where.length > 0 ? { where: where.map(parenthesized).join(" AND ") } : {}),
      ...(spatial ? { spatial } : {}),
    };
  }
  if (containsSpatialFilter(filter)) {
    semanticUnsupported("unsupported-node", path, "GeoServices cannot preserve a spatial predicate inside OR or NOT");
  }
  return { where: compileGeoServicesAttributeFilter(filter, state, path) };
}

function compileGeoServicesAttributeFilter(
  filter: RuntimeGeoServicesFilter,
  state: GeoServicesSemanticState,
  path: string,
): string {
  switch (filter.kind) {
    case "comparison": {
      const field = semanticSchemaField(state.schema, filter.left.name, `${path}.left.name`);
      const operator = { eq: "=", ne: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" }[filter.operator];
      return `${geoServicesSqlField(field, state, `${path}.left.name`)} ${operator} ${geoServicesLiteral(
        filter.right.value,
        field,
        state,
        `${path}.right.value`,
      )}`;
    }
    case "list": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      const values = filter.values.map((literal, index) =>
        geoServicesLiteral(literal.value, field, state, `${path}.values[${index}].value`),
      );
      return `${geoServicesSqlField(field, state, `${path}.operand.name`)} IN (${values.join(", ")})`;
    }
    case "range": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      return `${geoServicesSqlField(field, state, `${path}.operand.name`)} BETWEEN ${geoServicesLiteral(
        filter.lower.value,
        field,
        state,
        `${path}.lower.value`,
      )} AND ${geoServicesLiteral(filter.upper.value, field, state, `${path}.upper.value`)}`;
    }
    case "null": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      return `${geoServicesSqlField(field, state, `${path}.operand.name`)} IS ${
        filter.operator === "is-not-null" ? "NOT " : ""
      }NULL`;
    }
    case "pattern": {
      if (filter.caseSensitive === false) {
        semanticUnsupported(
          "unsupported-node",
          `${path}.caseSensitive`,
          "GeoServices SQL-92 cannot prove case-insensitive LIKE semantics across data stores",
        );
      }
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      return `${geoServicesSqlField(field, state, `${path}.operand.name`)} LIKE ${quotedSemanticString(
        filter.pattern,
        `${path}.pattern`,
      )}`;
    }
    case "boolean":
      return filter.args
        .map((entry, index) =>
          parenthesized(
            compileGeoServicesAttributeFilter(entry as RuntimeGeoServicesFilter, state, `${path}.args[${index}]`),
          ),
        )
        .join(filter.operator === "and" ? " AND " : " OR ");
    case "not":
      return `NOT ${parenthesized(compileGeoServicesAttributeFilter(filter.arg as RuntimeGeoServicesFilter, state, `${path}.arg`))}`;
    case "temporal": {
      if (filter.operator === "during" || filter.operator === "time-intersects") {
        semanticUnsupported(
          "unsupported-node",
          `${path}.operator`,
          `GeoServices SQL-92 cannot represent the OGC ${filter.operator} temporal-topology predicate exactly`,
        );
      }
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      const name = geoServicesSqlField(field, state, `${path}.operand.name`);
      return `${name} ${filter.operator === "before" ? "<" : ">"} ${geoServicesLiteral(
        filter.value.value as string,
        field,
        state,
        `${path}.value.value`,
      )}`;
    }
    case "native": {
      if (filter.dialect !== "geoservices-sql92" || filter.payload.format !== "text") {
        semanticUnsupported(
          "unsupported-native-filter",
          path,
          "GeoServices native filters require geoservices-sql92 text",
        );
      }
      state.usesNativeFilter = true;
      return verifiedSemanticNativeText(filter.payload.text, `${path}.payload.text`, "GeoServices SQL-92");
    }
    case "spatial":
      semanticUnsupported("unsupported-node", path, "Spatial predicates use GeoServices geometry request parameters");
  }
}

function geoServicesLiteral(
  value: JsonValue,
  field: LogicalField,
  state: GeoServicesSemanticState,
  path: string,
): string {
  switch (field.type.kind) {
    case "integer":
    case "decimal":
      return typeof value === "number" ? finiteDecimalNumber(value, path) : exactDecimalText(value as string, path);
    case "float":
      return finiteDecimalNumber(value as number, path);
    case "string":
    case "uuid":
      return quotedSemanticString(value as string, path);
    case "date": {
      requireGeoServicesNativeTemporalType(field, state.source.protocol, "esriFieldTypeDateOnly", path);
      return `DATE ${quotedSemanticString(value as string, path)}`;
    }
    case "time": {
      requireGeoServicesNativeTemporalType(field, state.source.protocol, "esriFieldTypeTimeOnly", path);
      if ((value as string).includes(".")) {
        semanticUnsupported(
          "unsupported-field-type",
          path,
          "GeoServices Time Only SQL syntax does not preserve fractional seconds",
        );
      }
      return `TIME ${quotedSemanticString(value as string, path)}`;
    }
    case "timestamp": {
      const nativeType = geoServicesNativeTemporalType(field, state.source.protocol, path);
      if (nativeType === "esriFieldTypeDate") {
        if (field.type.timezone !== "utc") {
          semanticUnsupported(
            "unsupported-field-type",
            path,
            "GeoServices Date TIMESTAMP literals require explicit UTC field metadata",
          );
        }
        const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:[0-5]\d)Z$/.exec(value as string);
        if (!match) {
          semanticUnsupported(
            "unsupported-field-type",
            path,
            "GeoServices Date TIMESTAMP syntax cannot preserve fractional seconds or leap seconds",
          );
        }
        return `TIMESTAMP ${quotedSemanticString(`${match[1]} ${match[2]}`, path)}`;
      }
      if (nativeType !== "esriFieldTypeTimestampOffset" || field.type.timezone !== "offset") {
        semanticUnsupported(
          "unsupported-field-type",
          path,
          "GeoServices offset TIMESTAMP literals require matching Timestamp Offset field metadata",
        );
      }
      const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:[0-5]\d(?:\.\d{1,3})?)(Z|[+-]\d{2}:\d{2})$/.exec(
        value as string,
      );
      if (!match) {
        semanticUnsupported(
          "unsupported-field-type",
          path,
          "GeoServices Timestamp Offset SQL syntax supports at most millisecond precision and no leap seconds",
        );
      }
      const normalized = `${match[1]} ${match[2]} ${match[3] === "Z" ? "+00:00" : match[3]}`;
      return `TIMESTAMP ${quotedSemanticString(normalized, path)}`;
    }
    default:
      semanticUnsupported(
        "unsupported-field-type",
        path,
        `GeoServices SQL-92 cannot represent ${field.type.kind} literals exactly`,
      );
  }
}

type GeoServicesNativeTemporalType =
  | "esriFieldTypeDate"
  | "esriFieldTypeDateOnly"
  | "esriFieldTypeTimeOnly"
  | "esriFieldTypeTimestampOffset";

const GEO_SERVICES_TEMPORAL_TYPES = new Set<GeoServicesNativeTemporalType>([
  "esriFieldTypeDate",
  "esriFieldTypeDateOnly",
  "esriFieldTypeTimeOnly",
  "esriFieldTypeTimestampOffset",
]);

function geoServicesNativeTemporalType(
  field: LogicalField,
  protocol: SemanticGeoServicesProtocol,
  path: string,
): GeoServicesNativeTemporalType {
  const references = field.native.filter((reference) => reference.protocol === protocol);
  if (
    references.length !== 1 ||
    !GEO_SERVICES_TEMPORAL_TYPES.has(references[0]?.name as GeoServicesNativeTemporalType)
  ) {
    semanticUnsupported(
      "unsupported-source",
      path,
      "GeoServices temporal literals require one exact native layer field type",
    );
  }
  return references[0]?.name as GeoServicesNativeTemporalType;
}

function requireGeoServicesNativeTemporalType(
  field: LogicalField,
  protocol: SemanticGeoServicesProtocol,
  expected: GeoServicesNativeTemporalType,
  path: string,
): void {
  if (geoServicesNativeTemporalType(field, protocol, path) !== expected) {
    semanticUnsupported(
      "unsupported-field-type",
      path,
      `GeoServices ${field.type.kind} literal requires native ${expected} metadata`,
    );
  }
}

function compileGeoServicesSpatial(
  filter: RuntimeGeoServicesSpatialFilter,
  state: GeoServicesSemanticState,
  path: string,
): Pick<SemanticGeoServicesCompiledQueryV1, "geometry" | "geometryType" | "inSr" | "spatialRel"> {
  if (filter.operator === "within-distance" || filter.operator === "beyond-distance") {
    semanticUnsupported(
      "unsupported-distance",
      `${path}.distance`,
      "GeoServices distance parameters cannot preserve every semantic distance mode and unit",
    );
  }
  const propertyName = filter.property?.name ?? primaryGeometryField(state.schema);
  if (!propertyName) {
    semanticUnsupported("unsupported-geometry", `${path}.property`, "GeoServices requires a primary geometry field");
  }
  const primary = primaryGeometryField(state.schema);
  if (propertyName !== primary) {
    semanticUnsupported(
      "unsupported-geometry",
      `${path}.property`,
      "A GeoServices layer spatial filter can target only its primary geometry field",
    );
  }
  const property = semanticSchemaField(state.schema, propertyName, `${path}.property.name`);
  geoServicesPhysicalField(property, state, `${path}.property.name`);
  const geometryMetadata = sourceGeometryField(state.schema, propertyName, `${path}.property`);
  const sourceCrs = executableGeoServicesCrs(geometryMetadata.crs, `${path}.property`);
  const relationship = geoServicesRelationship(filter.operator, path);
  if (!state.source.supportedSpatialRelationships.includes(relationship)) {
    semanticUnsupported(
      "unsupported-source",
      `${path}.operator`,
      `Layer metadata does not explicitly advertise ${relationship}`,
    );
  }
  if (filter.operator === "bbox-intersects") {
    verifyGeoServicesBbox(filter.bbox, geometryMetadata.layout, sourceCrs, path);
    const [xmin, ymin, xmax, ymax] = filter.bbox.box.bounds;
    return {
      geometry: { xmin, ymin, xmax, ymax },
      geometryType: "esriGeometryEnvelope",
      inSr: geoServicesSpatialReference(filter.bbox.crs.definition, `${path}.bbox.crs`),
      spatialRel: relationship,
    };
  }
  verifyGeoServicesGeometry(filter.geometry, geometryMetadata.layout, sourceCrs, path);
  const compiled = geoServicesGeometry(filter.geometry, path);
  return {
    ...compiled,
    inSr: geoServicesSpatialReference(filter.geometry.crs.definition, `${path}.geometry.crs`),
    spatialRel: relationship,
  };
}

function geoServicesRelationship(
  operator: RuntimeGeoServicesSpatialFilter["operator"],
  path: string,
): SemanticGeoServicesSpatialRelationship {
  switch (operator) {
    case "intersects":
    case "bbox-intersects":
      return "esriSpatialRelIntersects";
    case "within":
      return "esriSpatialRelWithin";
    case "contains":
      return "esriSpatialRelContains";
    case "crosses":
      return "esriSpatialRelCrosses";
    case "touches":
      return "esriSpatialRelTouches";
    case "overlaps":
      return "esriSpatialRelOverlaps";
    default:
      semanticUnsupported(
        "unsupported-node",
        `${path}.operator`,
        `GeoServices cannot prove exact ${operator} relationship semantics`,
      );
  }
}

function verifyGeoServicesGeometry(
  value: ExecutableGeometryValue,
  sourceLayout: string,
  sourceCrs: ExecutableCrsBinding,
  path: string,
): void {
  assertEastNorth(value.crs, `${path}.geometry.crs`);
  if (!sameExecutableCrs(sourceCrs, value.crs)) {
    semanticUnsupported(
      "crs-transform-required",
      `${path}.geometry.crs`,
      "Spatial geometry CRS differs from the GeoServices layer geometry CRS",
    );
  }
  if ((value.layout !== "xy" && value.layout !== "xyz") || sourceLayout !== value.layout) {
    semanticUnsupported(
      "unsupported-geometry",
      `${path}.geometry.layout`,
      "GeoServices spatial filters require a known matching xy or xyz layer layout",
    );
  }
}

function verifyGeoServicesBbox(
  value: ExecutableBoundingBox,
  sourceLayout: string,
  sourceCrs: ExecutableCrsBinding,
  path: string,
): void {
  assertEastNorth(value.crs, `${path}.bbox.crs`);
  if (!sameExecutableCrs(sourceCrs, value.crs)) {
    semanticUnsupported(
      "crs-transform-required",
      `${path}.bbox.crs`,
      "Bounding-box CRS differs from the GeoServices layer geometry CRS",
    );
  }
  if (value.box.layout !== "xy" || sourceLayout !== "xy") {
    semanticUnsupported(
      "unsupported-geometry",
      `${path}.bbox.box.layout`,
      "GeoServices envelope filters require a known xy layer layout",
    );
  }
}

function geoServicesGeometry(
  value: ExecutableGeometryValue,
  path: string,
): Pick<SemanticGeoServicesCompiledQueryV1, "geometry" | "geometryType"> {
  const dimension = value.layout === "xyz" ? 3 : 2;
  switch (value.geometry.type) {
    case "Point":
      return {
        geometry: {
          x: value.geometry.coordinates[0],
          y: value.geometry.coordinates[1],
          ...(dimension === 3 ? { z: value.geometry.coordinates[2] as number } : {}),
        },
        geometryType: "esriGeometryPoint",
      };
    case "MultiPoint":
      return {
        geometry: { points: value.geometry.coordinates.map((position) => coordinate(position, dimension)) },
        geometryType: "esriGeometryMultipoint",
      };
    case "LineString":
      return {
        geometry: { paths: [value.geometry.coordinates.map((position) => coordinate(position, dimension))] },
        geometryType: "esriGeometryPolyline",
      };
    case "MultiLineString":
      return {
        geometry: {
          paths: value.geometry.coordinates.map((line) => line.map((position) => coordinate(position, dimension))),
        },
        geometryType: "esriGeometryPolyline",
      };
    case "Polygon":
      return {
        geometry: {
          rings: value.geometry.coordinates.map((ring, index) => esriRing(ring, index === 0, dimension)),
        },
        geometryType: "esriGeometryPolygon",
      };
    case "MultiPolygon":
      return {
        geometry: {
          rings: value.geometry.coordinates.flatMap((polygon) =>
            polygon.map((ring, index) => esriRing(ring, index === 0, dimension)),
          ),
        },
        geometryType: "esriGeometryPolygon",
      };
    case "GeometryCollection":
      semanticUnsupported(
        "unsupported-geometry",
        `${path}.geometry.geometry`,
        "GeoServices query geometry has no GeometryCollection representation",
      );
  }
}

function esriRing(ring: readonly Position[], exterior: boolean, dimension: 2 | 3): readonly (readonly number[])[] {
  const coordinates = ring.map((position) => coordinate(position, dimension));
  const signedArea = ring.reduce((area, position, index) => {
    const next = ring[(index + 1) % ring.length] as Position;
    return area + position[0] * next[1] - next[0] * position[1];
  }, 0);
  const clockwise = signedArea < 0;
  return clockwise === exterior ? coordinates : [...coordinates].reverse();
}

function coordinate(position: Position, dimension: 2 | 3): readonly number[] {
  return dimension === 3 ? [position[0], position[1], position[2] as number] : [position[0], position[1]];
}

function geoServicesSpatialReference(value: CrsDefinition, path: string): SemanticGeoServicesSpatialReference {
  if (value.kind === "authority" && value.authority.toUpperCase() === "EPSG" && /^\d+$/.test(value.code)) {
    const wkid = Number(value.code);
    if (Number.isSafeInteger(wkid) && wkid > 0 && wkid <= 2_147_483_647) return { wkid };
  }
  if (value.kind === "wkt" && value.validation === "engine") return { wkt: value.wkt };
  semanticUnsupported("unsupported-crs", path, "GeoServices requests require an EPSG code or engine-validated WKT");
}

function executableGeoServicesCrs(value: unknown, path: string): ExecutableCrsBinding {
  try {
    const crs = validateExecutableCrsBinding(value, path);
    if (crs.coordinateEpoch !== undefined) {
      semanticUnsupported("unsupported-crs", path, "GeoServices requests cannot preserve coordinate epochs");
    }
    assertEastNorth(crs, path);
    geoServicesSpatialReference(crs.definition, path);
    return crs;
  } catch (error) {
    if (error instanceof HonuaQueryPlanningError) throw error;
    semanticUnsupported("unsupported-crs", path, "GeoServices requires a resolved executable source CRS");
  }
}

function assertEastNorth(value: ExecutableCrsBinding, path: string): void {
  const [x, y] = value.coordinateOrder.axes;
  if (x?.direction !== "east" || y?.direction !== "north") {
    semanticUnsupported("unsupported-crs", path, "GeoServices geometry requires east/north x/y payload axes");
  }
}

function sourceGeometryField(schema: SourceSchemaV2, name: string, path: string) {
  if (schema.geometry.state !== "known") {
    semanticUnsupported("unsupported-source", path, "Source geometry metadata is unavailable");
  }
  const field = schema.geometry.fields.find((candidate) => candidate.field === name);
  if (!field) semanticUnsupported("unsupported-source", path, "Source geometry field metadata is unavailable");
  return field;
}

function primaryGeometryField(schema: SourceSchemaV2): string | undefined {
  return schema.geometry.state === "known" && schema.geometry.primaryField.state === "known"
    ? schema.geometry.primaryField.field
    : undefined;
}

function geoServicesSqlField(field: LogicalField, state: GeoServicesSemanticState, path: string): string {
  return sql92Identifier(geoServicesPhysicalField(field, state, path), path);
}

function geoServicesRequestField(field: LogicalField, state: GeoServicesSemanticState, path: string): string {
  const requestField = geoServicesPhysicalField(field, state, path);
  if (!GEO_SERVICES_REST_FIELD_NAME.test(requestField)) {
    semanticUnsupported(
      "unsupported-source",
      path,
      "GeoServices raw field parameters require one Unicode identifier without delimiters or whitespace",
    );
  }
  return requestField;
}

const GEO_SERVICES_REST_FIELD_NAME = /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u;

function geoServicesPhysicalField(field: LogicalField, state: GeoServicesSemanticState, path: string): string {
  if (field.path.length !== 1) {
    semanticUnsupported(
      "unsupported-source",
      path,
      "GeoServices fields require exactly one physical layer-field path segment",
    );
  }
  const requestField = field.path[0] as string;
  sql92Identifier(requestField, path);
  recordSemanticFieldMapping(state.fieldMappings, field, requestField);
  return requestField;
}

function containsSpatialFilter(filter: RuntimeGeoServicesFilter): boolean {
  if (filter.kind === "spatial") return true;
  if (filter.kind === "boolean")
    return filter.args.some((entry) => containsSpatialFilter(entry as RuntimeGeoServicesFilter));
  if (filter.kind === "not") return containsSpatialFilter(filter.arg as RuntimeGeoServicesFilter);
  return false;
}

function parenthesized(value: string): string {
  return `(${value})`;
}
