import type { ExecutableCrsBinding, JsonValue, LogicalField, SourceSchemaV2 } from "../contract/schema.js";
import { canonicalStringify, toJsonValue } from "./canonical.js";
import {
  bboxInDefinitionOrder,
  compiledRequestFingerprint,
  compilerEvidenceFingerprint,
  compilerField,
  cql2FieldName,
  cql2Identifier,
  cql2StringLiteral,
  geometryInDefinitionOrder,
  geometryToWkt,
  hasConformanceClass,
  normalizeConformanceUris,
  normalizeIdentifierUris,
  ogcAxisPlan,
  ogcCrsUri,
  ogcNumber,
  sharedFilterCrs,
} from "./ogc-compiler.js";
import { hashSemanticQuery } from "./semantic-canonical.js";
import {
  type RuntimeSemanticQuery,
  type SemanticCompilationResult,
  prepareSemanticCompilerQuery,
  runSemanticCompiler,
  semanticUnsupported,
} from "./semantic-compiler.js";
import type {
  Cql2JsonExpression,
  QueryFilter,
  SemanticQuery,
  SourceSpatiality,
  TemporalLiteralNode,
} from "./semantic-types.js";
import type { CanonicalQuery, OgcApiFeaturesCompiledQueryV1, QueryIrSourceIdentity } from "./types.js";
import { HonuaQueryPlanningError } from "./types.js";

export type Cql2FilterLanguage = "cql2-json" | "cql2-text";

/** Explicit metadata discovered for the concrete OGC API Features source. */
export interface OgcApiFeaturesFilterConformanceEvidence {
  /** Exact `/conformance` response values. No protocol defaults are inferred. */
  readonly conformsTo: readonly string[];
  /** Collection/filter CRS identifiers discovered from Part 2/OpenAPI metadata. */
  readonly supportedFilterCrs?: readonly string[];
  /** Collection response CRS identifiers discovered from Part 2 metadata. */
  readonly supportedOutputCrs?: readonly string[];
}

export interface SemanticOgcApiFeaturesSourceIdentity {
  readonly collectionId: string | number;
}

export interface SemanticOgcApiFeaturesCompileOptions<
  TRecord = Record<string, unknown>,
  TSpatiality extends SourceSpatiality = SourceSpatiality,
> {
  readonly query: SemanticQuery<TRecord, "ogc-features", TSpatiality>;
  readonly schema: SourceSchemaV2;
  readonly source: SemanticOgcApiFeaturesSourceIdentity;
  readonly conformance: OgcApiFeaturesFilterConformanceEvidence;
  /** Deterministic preference used only when both encodings were explicitly discovered. */
  readonly preferredFilterLanguage?: Cql2FilterLanguage;
  /** External CRS context for a native CQL2 escape hatch. Semantic spatial nodes carry their own binding. */
  readonly nativeFilterCrs?: ExecutableCrsBinding;
}

/** Canonical, wire-ready OGC API Features `/items` request semantics. */
export interface SemanticOgcApiFeaturesCompiledQueryV1 {
  readonly compiler: "ogc-api-features-semantic-query-v1";
  readonly dialect?: Cql2FilterLanguage;
  readonly schemaFingerprint: SourceSchemaV2["fingerprint"];
  readonly queryFingerprint: `sha256:${string}`;
  readonly capabilityFingerprint: `sha256:${string}`;
  readonly requestFingerprint: `sha256:${string}`;
  readonly collectionId: string | number;
  /** Text value for the `filter` query parameter; JSON is canonical JSON text. */
  readonly filter?: string;
  readonly filterLang?: Cql2FilterLanguage;
  readonly filterCrs?: string;
  readonly properties?: readonly string[];
  readonly sortby?: string;
  readonly crs?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly usesNativeFilter: boolean;
}

type RuntimeOgcQuery = RuntimeSemanticQuery<"ogc-features">;
type RuntimeOgcFilter = QueryFilter<Record<string, unknown>, "ogc-features", SourceSpatiality>;

interface NormalizedOgcConformance {
  readonly conformsTo: readonly string[];
  readonly supportedFilterCrs: readonly string[];
  readonly supportedOutputCrs: readonly string[];
  readonly fingerprint: `sha256:${string}`;
}

interface Cql2CompilerState {
  readonly schema: SourceSchemaV2;
  readonly conformance: NormalizedOgcConformance;
  readonly language: Cql2FilterLanguage;
  filterCrs?: ExecutableCrsBinding;
  usesNativeFilter: boolean;
}

const OGC_CAPABILITY_FINGERPRINT_DOMAIN = "honua.ogc-features.filter-capabilities.v1";
const OGC_REQUEST_FINGERPRINT_DOMAIN = "honua.ogc-features.semantic-request.v1";
const CQL2_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CQL2_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const EXACT_NUMERIC_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

const COMPARISON_TEXT = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
} as const;

const SPATIAL_TEXT = {
  equals: "S_EQUALS",
  intersects: "S_INTERSECTS",
  within: "S_WITHIN",
  contains: "S_CONTAINS",
  disjoint: "S_DISJOINT",
  touches: "S_TOUCHES",
  overlaps: "S_OVERLAPS",
  crosses: "S_CROSSES",
} as const;

const SPATIAL_JSON = {
  equals: "s_equals",
  intersects: "s_intersects",
  within: "s_within",
  contains: "s_contains",
  disjoint: "s_disjoint",
  touches: "s_touches",
  overlaps: "s_overlaps",
  crosses: "s_crosses",
} as const;

const TEMPORAL_TEXT = {
  before: "T_BEFORE",
  after: "T_AFTER",
  during: "T_DURING",
  "time-intersects": "T_INTERSECTS",
} as const;

const TEMPORAL_JSON = {
  before: "t_before",
  after: "t_after",
  during: "t_during",
  "time-intersects": "t_intersects",
} as const;

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

/** Compile a typed semantic query using only explicitly discovered OGC/CQL2 support. */
export function compileSemanticOgcApiFeaturesQuery<TRecord, TSpatiality extends SourceSpatiality>(
  options: SemanticOgcApiFeaturesCompileOptions<TRecord, TSpatiality>,
): SemanticCompilationResult<SemanticOgcApiFeaturesCompiledQueryV1> {
  return runSemanticCompiler(() => {
    const { query, schema } = prepareSemanticCompilerQuery(options.query, options.schema, "ogc-features");
    const source = verifiedSemanticOgcSource(options.source);
    const conformance = normalizeOgcConformance(options.conformance);
    const language = query.filter
      ? selectCql2Language(query.filter as RuntimeOgcFilter, conformance, options.preferredFilterLanguage)
      : undefined;
    const state: Cql2CompilerState | undefined = language
      ? { schema, conformance, language, usesNativeFilter: false }
      : undefined;
    const filter =
      state && query.filter ? compileCql2Filter(query.filter as RuntimeOgcFilter, state, "$.filter") : undefined;
    const filterCrs = state?.filterCrs
      ? compiledOgcFilterCrs(state.filterCrs, conformance, "$.filter")
      : options.nativeFilterCrs && query.filter?.kind === "native"
        ? compiledOgcFilterCrs(options.nativeFilterCrs, conformance, "options.nativeFilterCrs")
        : undefined;
    const properties = ogcSemanticProjection(query, schema);
    const sortby = ogcSemanticSort(query, schema);
    const page = query.page;
    const crs = query.outputCrs ? compiledOgcOutputCrs(query.outputCrs, conformance, "$.outputCrs") : undefined;
    const queryFingerprint = hashSemanticQuery(query, { schema, protocol: "ogc-features" });
    const preimage = {
      compiler: "ogc-api-features-semantic-query-v1" as const,
      ...(language ? { dialect: language } : {}),
      schemaFingerprint: schema.fingerprint,
      queryFingerprint,
      capabilityFingerprint: conformance.fingerprint,
      collectionId: source.collectionId,
      ...(filter !== undefined ? { filter, filterLang: language } : {}),
      ...(filterCrs ? { filterCrs } : {}),
      ...(properties ? { properties } : {}),
      ...(sortby ? { sortby } : {}),
      ...(crs ? { crs } : {}),
      ...(page?.kind === "offset" ? { offset: page.offset } : {}),
      ...(page?.limit !== undefined ? { limit: page.limit } : {}),
      usesNativeFilter: state?.usesNativeFilter ?? false,
    };
    const artifact: SemanticOgcApiFeaturesCompiledQueryV1 = {
      ...preimage,
      requestFingerprint: compiledRequestFingerprint(OGC_REQUEST_FINGERPRINT_DOMAIN, toJsonValue(preimage)),
    };
    return { artifact };
  });
}

function verifiedSemanticOgcSource(value: SemanticOgcApiFeaturesSourceIdentity): SemanticOgcApiFeaturesSourceIdentity {
  if (!value || typeof value !== "object") {
    throw new HonuaQueryPlanningError("invalid-query", "Semantic OGC source identity is invalid");
  }
  if (
    (typeof value.collectionId !== "string" && typeof value.collectionId !== "number") ||
    (typeof value.collectionId === "string" &&
      (value.collectionId.length === 0 || value.collectionId.length > 1_024 || hasControl(value.collectionId))) ||
    (typeof value.collectionId === "number" && (!Number.isSafeInteger(value.collectionId) || value.collectionId < 0))
  ) {
    throw new HonuaQueryPlanningError("invalid-query", "options.source.collectionId is invalid");
  }
  return { collectionId: value.collectionId };
}

function normalizeOgcConformance(value: OgcApiFeaturesFilterConformanceEvidence): NormalizedOgcConformance {
  if (!value || typeof value !== "object") {
    throw new HonuaQueryPlanningError("invalid-query", "options.conformance is invalid");
  }
  const conformsTo = normalizeConformanceUris(value.conformsTo, "options.conformance.conformsTo");
  const supportedFilterCrs = normalizeIdentifierUris(
    value.supportedFilterCrs,
    "options.conformance.supportedFilterCrs",
  );
  const supportedOutputCrs = normalizeIdentifierUris(
    value.supportedOutputCrs,
    "options.conformance.supportedOutputCrs",
  );
  return {
    conformsTo,
    supportedFilterCrs,
    supportedOutputCrs,
    fingerprint: compilerEvidenceFingerprint(
      OGC_CAPABILITY_FINGERPRINT_DOMAIN,
      toJsonValue({ conformsTo, supportedFilterCrs, supportedOutputCrs }),
    ),
  };
}

function selectCql2Language(
  filter: RuntimeOgcFilter,
  conformance: NormalizedOgcConformance,
  preferred: Cql2FilterLanguage | undefined,
): Cql2FilterLanguage {
  requireCqlConformance(conformance, "ogcapi-features-3/1.0", "features-filter", "$.filter");
  requireCqlConformance(conformance, "cql2/1.0", "basic-cql2", "$.filter");
  const advertised = (["cql2-json", "cql2-text"] as const).filter((language) =>
    hasConformanceClass(conformance.conformsTo, "cql2/1.0", language),
  );
  if (filter.kind === "native") {
    const language = filter.dialect;
    if (language !== "cql2-json" && language !== "cql2-text") {
      semanticUnsupported("unsupported-native-filter", "$.filter.dialect", `unsupported native dialect ${language}`);
    }
    if (!advertised.includes(language)) {
      semanticUnsupported(
        "unsupported-native-filter",
        "$.filter.dialect",
        `native ${language} requires matching discovered conformance`,
      );
    }
    return language;
  }
  if (preferred !== undefined && preferred !== "cql2-json" && preferred !== "cql2-text") {
    throw new HonuaQueryPlanningError("invalid-query", "options.preferredFilterLanguage is invalid");
  }
  if (preferred !== undefined) {
    if (!advertised.includes(preferred)) {
      semanticUnsupported(
        "unsupported-source",
        "options.preferredFilterLanguage",
        `${preferred} was not present in discovered conformance`,
      );
    }
    return preferred;
  }
  const selected = advertised[0];
  if (!selected) {
    semanticUnsupported(
      "unsupported-source",
      "options.conformance.conformsTo",
      "OGC filtering requires explicitly discovered cql2-json or cql2-text conformance",
    );
  }
  return selected;
}

function compileCql2Filter(filter: RuntimeOgcFilter, state: Cql2CompilerState, path: string): string {
  if (filter.kind === "native") {
    state.usesNativeFilter = true;
    if (filter.dialect !== state.language) {
      semanticUnsupported(
        "unsupported-native-filter",
        `${path}.dialect`,
        `native ${filter.dialect} cannot compile as ${state.language}`,
      );
    }
    return filter.payload.format === "json" ? canonicalStringify(filter.payload.value) : filter.payload.text;
  }
  if (state.language === "cql2-json") {
    return canonicalStringify(compileCql2JsonNode(filter, state, path) as JsonValue);
  }
  return compileCql2TextNode(filter, state, path);
}

function compileCql2JsonNode(
  filter: Exclude<RuntimeOgcFilter, { readonly kind: "native" }>,
  state: Cql2CompilerState,
  path: string,
): Cql2JsonExpression {
  switch (filter.kind) {
    case "comparison": {
      const field = compilerField(state.schema, filter.left.name, `${path}.left.name`);
      return {
        op: COMPARISON_TEXT[filter.operator],
        args: [
          { property: cql2FieldName(state.schema, filter.left.name, `${path}.left.name`) },
          cql2JsonLiteral(filter.right.value, field, `${path}.right.value`),
        ],
      };
    }
    case "boolean":
      return {
        op: filter.operator,
        args: filter.args.map((entry, index) =>
          compileCql2JsonNode(entry, state, `${path}.args[${index}]`),
        ) as readonly JsonValue[],
      };
    case "not":
      return { op: "not", args: [compileCql2JsonNode(filter.arg, state, `${path}.arg`)] };
    case "null": {
      const node: Cql2JsonExpression = {
        op: "isNull",
        args: [{ property: cql2FieldName(state.schema, filter.operand.name, `${path}.operand.name`) }],
      };
      return filter.operator === "is-null" ? node : { op: "not", args: [node] };
    }
    case "list": {
      requireCqlConformance(state.conformance, "cql2/1.0", "advanced-comparison-operators", path);
      const field = compilerField(state.schema, filter.operand.name, `${path}.operand.name`);
      return {
        op: "in",
        args: [
          { property: cql2FieldName(state.schema, filter.operand.name, `${path}.operand.name`) },
          filter.values.map((entry, index) => cql2JsonLiteral(entry.value, field, `${path}.values[${index}].value`)),
        ],
      };
    }
    case "range": {
      requireCqlConformance(state.conformance, "cql2/1.0", "advanced-comparison-operators", path);
      const field = compilerField(state.schema, filter.operand.name, `${path}.operand.name`);
      return {
        op: "between",
        args: [
          { property: cql2FieldName(state.schema, filter.operand.name, `${path}.operand.name`) },
          cql2JsonLiteral(filter.lower.value, field, `${path}.lower.value`),
          cql2JsonLiteral(filter.upper.value, field, `${path}.upper.value`),
        ],
      };
    }
    case "pattern": {
      requireCqlConformance(state.conformance, "cql2/1.0", "advanced-comparison-operators", path);
      const property: JsonValue = {
        property: cql2FieldName(state.schema, filter.operand.name, `${path}.operand.name`),
      };
      if (filter.caseSensitive === false) {
        requireCqlConformance(state.conformance, "cql2/1.0", "case-insensitive-comparison", path);
        return {
          op: "like",
          args: [
            { op: "casei", args: [property] },
            { op: "casei", args: [filter.pattern] },
          ],
        };
      }
      return { op: "like", args: [property, filter.pattern] };
    }
    case "spatial":
      return compileCql2JsonSpatial(filter, state, path);
    case "temporal":
      requireCqlConformance(state.conformance, "cql2/1.0", "temporal-functions", path);
      return {
        op: TEMPORAL_JSON[filter.operator],
        args: [
          { property: cql2FieldName(state.schema, filter.operand.name, `${path}.operand.name`) },
          cql2JsonTemporal(filter.value, `${path}.value`),
        ],
      };
  }
}

function compileCql2TextNode(
  filter: Exclude<RuntimeOgcFilter, { readonly kind: "native" }>,
  state: Cql2CompilerState,
  path: string,
): string {
  switch (filter.kind) {
    case "comparison": {
      const field = compilerField(state.schema, filter.left.name, `${path}.left.name`);
      const property = cql2TextProperty(state.schema, filter.left.name, `${path}.left.name`);
      return `${property} ${COMPARISON_TEXT[filter.operator]} ${cql2TextLiteral(filter.right.value, field, `${path}.right.value`)}`;
    }
    case "boolean":
      return `(${filter.args
        .map((entry, index) => compileCql2TextNode(entry, state, `${path}.args[${index}]`))
        .join(` ${filter.operator.toUpperCase()} `)})`;
    case "not":
      return `NOT (${compileCql2TextNode(filter.arg, state, `${path}.arg`)})`;
    case "null": {
      const property = cql2TextProperty(state.schema, filter.operand.name, `${path}.operand.name`);
      return `${property} IS ${filter.operator === "is-not-null" ? "NOT " : ""}NULL`;
    }
    case "list": {
      requireCqlConformance(state.conformance, "cql2/1.0", "advanced-comparison-operators", path);
      const field = compilerField(state.schema, filter.operand.name, `${path}.operand.name`);
      const values = filter.values
        .map((entry, index) => cql2TextLiteral(entry.value, field, `${path}.values[${index}].value`))
        .join(", ");
      return `${cql2TextProperty(state.schema, filter.operand.name, `${path}.operand.name`)} IN (${values})`;
    }
    case "range": {
      requireCqlConformance(state.conformance, "cql2/1.0", "advanced-comparison-operators", path);
      const field = compilerField(state.schema, filter.operand.name, `${path}.operand.name`);
      return `${cql2TextProperty(state.schema, filter.operand.name, `${path}.operand.name`)} BETWEEN ${cql2TextLiteral(
        filter.lower.value,
        field,
        `${path}.lower.value`,
      )} AND ${cql2TextLiteral(filter.upper.value, field, `${path}.upper.value`)}`;
    }
    case "pattern": {
      requireCqlConformance(state.conformance, "cql2/1.0", "advanced-comparison-operators", path);
      const property = cql2TextProperty(state.schema, filter.operand.name, `${path}.operand.name`);
      const pattern = cql2StringLiteral(filter.pattern, `${path}.pattern`);
      if (filter.caseSensitive === false) {
        requireCqlConformance(state.conformance, "cql2/1.0", "case-insensitive-comparison", path);
        return `CASEI(${property}) LIKE CASEI(${pattern})`;
      }
      return `${property} LIKE ${pattern}`;
    }
    case "spatial":
      return compileCql2TextSpatial(filter, state, path);
    case "temporal":
      requireCqlConformance(state.conformance, "cql2/1.0", "temporal-functions", path);
      return `${TEMPORAL_TEXT[filter.operator]}(${cql2TextProperty(
        state.schema,
        filter.operand.name,
        `${path}.operand.name`,
      )}, ${cql2TextTemporal(filter.value, `${path}.value`)})`;
  }
}

function compileCql2JsonSpatial(
  filter: Extract<Exclude<RuntimeOgcFilter, { readonly kind: "native" }>, { readonly kind: "spatial" }>,
  state: Cql2CompilerState,
  path: string,
): Cql2JsonExpression {
  const property = {
    property: cql2FieldName(state.schema, spatialProperty(filter, state.schema, path), `${path}.property.name`),
  };
  if (filter.operator === "within-distance" || filter.operator === "beyond-distance") {
    semanticUnsupported("unsupported-distance", `${path}.operator`, "distance predicates are outside CQL2 1.0");
  }
  if (filter.operator === "bbox-intersects") {
    requireCqlConformance(state.conformance, "cql2/1.0", "basic-spatial-functions", path);
    state.filterCrs = sharedFilterCrs(state.filterCrs, filter.bbox.crs, path);
    return { op: "s_intersects", args: [property, { bbox: bboxInDefinitionOrder(filter.bbox, `${path}.bbox`) }] };
  }
  requireCqlSpatialClass(state.conformance, filter.operator, filter.geometry.geometry.type, path);
  state.filterCrs = sharedFilterCrs(state.filterCrs, filter.geometry.crs, path);
  if (filter.geometry.layout !== "xy" && filter.geometry.layout !== "xyz") {
    semanticUnsupported(
      "unsupported-geometry",
      `${path}.geometry.layout`,
      "CQL2 text cannot preserve measured coordinate layouts",
    );
  }
  const geometry = geometryInDefinitionOrder(filter.geometry, `${path}.geometry`);
  assertCql2JsonGeometry(geometry, `${path}.geometry.geometry`);
  return { op: SPATIAL_JSON[filter.operator], args: [property, toJsonValue(geometry)] };
}

function compileCql2TextSpatial(
  filter: Extract<Exclude<RuntimeOgcFilter, { readonly kind: "native" }>, { readonly kind: "spatial" }>,
  state: Cql2CompilerState,
  path: string,
): string {
  const property = cql2TextProperty(state.schema, spatialProperty(filter, state.schema, path), `${path}.property.name`);
  if (filter.operator === "within-distance" || filter.operator === "beyond-distance") {
    semanticUnsupported("unsupported-distance", `${path}.operator`, "distance predicates are outside CQL2 1.0");
  }
  if (filter.operator === "bbox-intersects") {
    requireCqlConformance(state.conformance, "cql2/1.0", "basic-spatial-functions", path);
    state.filterCrs = sharedFilterCrs(state.filterCrs, filter.bbox.crs, path);
    const bounds = bboxInDefinitionOrder(filter.bbox, `${path}.bbox`)
      .map((entry, index) => ogcNumber(entry, `${path}.bbox.box.bounds[${index}]`))
      .join(", ");
    return `S_INTERSECTS(${property}, BBOX(${bounds}))`;
  }
  requireCqlSpatialClass(state.conformance, filter.operator, filter.geometry.geometry.type, path);
  state.filterCrs = sharedFilterCrs(state.filterCrs, filter.geometry.crs, path);
  if (filter.geometry.layout !== "xy" && filter.geometry.layout !== "xyz") {
    semanticUnsupported(
      "unsupported-geometry",
      `${path}.geometry.layout`,
      "CQL2 text cannot preserve measured coordinate layouts",
    );
  }
  const geometry = geometryInDefinitionOrder(filter.geometry, `${path}.geometry`);
  return `${SPATIAL_TEXT[filter.operator]}(${property}, ${geometryToWkt(
    geometry,
    filter.geometry.layout,
    `${path}.geometry.geometry`,
  )})`;
}

function cql2JsonLiteral(value: JsonValue, field: LogicalField, path: string): JsonValue {
  if (field.type.kind === "date") {
    if (typeof value !== "string" || !CQL2_DATE.test(value)) {
      semanticUnsupported("unsupported-field-type", path, "CQL2 date comparisons require a full-date string");
    }
    return { date: value };
  }
  if (field.type.kind === "timestamp") {
    if (typeof value !== "string" || !CQL2_TIMESTAMP.test(value)) {
      semanticUnsupported("unsupported-field-type", path, "CQL2 timestamp comparisons require a UTC Z instant");
    }
    return { timestamp: value };
  }
  if ((field.type.kind === "integer" || field.type.kind === "decimal") && field.type.jsonEncoding === "string") {
    semanticUnsupported(
      "unsupported-field-type",
      path,
      "CQL2 JSON cannot preserve string-encoded numeric precision; use discovered cql2-text",
    );
  }
  if (value === null || Array.isArray(value) || typeof value === "object") {
    semanticUnsupported("unsupported-field-type", path, "CQL2 scalar literals must be string, number, or boolean");
  }
  return value;
}

function cql2TextLiteral(value: JsonValue, field: LogicalField, path: string): string {
  if (field.type.kind === "date") {
    if (typeof value !== "string" || !CQL2_DATE.test(value)) {
      semanticUnsupported("unsupported-field-type", path, "CQL2 date comparisons require a full-date string");
    }
    return `DATE(${cql2StringLiteral(value, path)})`;
  }
  if (field.type.kind === "timestamp") {
    if (typeof value !== "string" || !CQL2_TIMESTAMP.test(value)) {
      semanticUnsupported("unsupported-field-type", path, "CQL2 timestamp comparisons require a UTC Z instant");
    }
    return `TIMESTAMP(${cql2StringLiteral(value, path)})`;
  }
  if ((field.type.kind === "integer" || field.type.kind === "decimal") && field.type.jsonEncoding === "string") {
    if (typeof value !== "string" || !EXACT_NUMERIC_TEXT.test(value)) {
      semanticUnsupported("unsupported-field-type", path, "CQL2 numeric text is not an exact decimal token");
    }
    return value;
  }
  if (typeof value === "string") return cql2StringLiteral(value, path);
  if (typeof value === "number") return ogcNumber(value, path);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  semanticUnsupported("unsupported-field-type", path, "CQL2 scalar literals must be string, number, or boolean");
}

function cql2JsonTemporal(value: TemporalLiteralNode, path: string): JsonValue {
  if (value.valueType === "date") return { date: value.value };
  if (value.valueType === "instant") return { timestamp: value.value };
  return { interval: [...value.value] };
}

function cql2TextTemporal(value: TemporalLiteralNode, path: string): string {
  if (value.valueType === "date") return `DATE(${cql2StringLiteral(value.value, `${path}.value`)})`;
  if (value.valueType === "instant") return `TIMESTAMP(${cql2StringLiteral(value.value, `${path}.value`)})`;
  return `INTERVAL(${cql2StringLiteral(value.value[0], `${path}.value[0]`)}, ${cql2StringLiteral(
    value.value[1],
    `${path}.value[1]`,
  )})`;
}

function cql2TextProperty(schema: SourceSchemaV2, name: string, path: string): string {
  return cql2Identifier(cql2FieldName(schema, name, path), path);
}

function spatialProperty(
  filter: Extract<Exclude<RuntimeOgcFilter, { readonly kind: "native" }>, { readonly kind: "spatial" }>,
  schema: SourceSchemaV2,
  path: string,
): string {
  if (filter.property) return filter.property.name;
  if (schema.geometry.state === "known" && schema.geometry.primaryField.state === "known") {
    return schema.geometry.primaryField.field;
  }
  semanticUnsupported(
    "unsupported-source",
    `${path}.property`,
    "implicit spatial property requires a known primary geometry field",
  );
}

function requireCqlSpatialClass(
  conformance: NormalizedOgcConformance,
  operator: keyof typeof SPATIAL_TEXT,
  geometryType: string,
  path: string,
): void {
  if (operator !== "intersects") {
    requireCqlConformance(conformance, "cql2/1.0", "spatial-functions", path);
    return;
  }
  requireCqlConformance(
    conformance,
    "cql2/1.0",
    geometryType === "Point" ? "basic-spatial-functions" : "basic-spatial-functions-plus",
    path,
  );
}

function requireCqlConformance(
  conformance: NormalizedOgcConformance,
  standard: string,
  name: string,
  path: string,
): void {
  if (!hasConformanceClass(conformance.conformsTo, standard, name)) {
    semanticUnsupported("unsupported-node", path, `${name} was not present in explicit discovered conformance`);
  }
}

function compiledOgcFilterCrs(
  binding: ExecutableCrsBinding,
  conformance: NormalizedOgcConformance,
  path: string,
): string | undefined {
  const dimensions = binding.coordinateOrder.axes.length >= 3 ? 3 : 2;
  const plan = ogcAxisPlan(binding, dimensions, `${path}.crs`);
  if (isDefaultFilterCrs(plan.srsName, dimensions)) return undefined;
  if (!conformance.supportedFilterCrs.includes(plan.srsName)) {
    semanticUnsupported(
      "unsupported-crs",
      `${path}.crs`,
      `filter CRS ${plan.srsName} was not present in discovered source metadata`,
    );
  }
  return plan.srsName;
}

function compiledOgcOutputCrs(
  definition: Parameters<typeof ogcCrsUri>[0],
  conformance: NormalizedOgcConformance,
  path: string,
): string {
  const uri = ogcCrsUri(definition, path);
  if (!conformance.supportedOutputCrs.includes(uri)) {
    semanticUnsupported("unsupported-crs", path, `output CRS ${uri} was not present in discovered source metadata`);
  }
  return uri;
}

function ogcSemanticProjection(query: RuntimeOgcQuery, schema: SourceSchemaV2): readonly string[] | undefined {
  if (query.kind === "aggregate") {
    semanticUnsupported("unsupported-node", "$.kind", "OGC API Features has no portable remote aggregation");
  }
  if (query.geometry === "omit") {
    semanticUnsupported(
      "unsupported-projection",
      "$.geometry",
      "OGC API Features has no portable geometry-suppression request parameter",
    );
  }
  if (query.geometry && typeof query.geometry === "object") {
    const primary =
      schema.geometry.state === "known" && schema.geometry.primaryField.state === "known"
        ? schema.geometry.primaryField.field
        : undefined;
    if (query.geometry.field !== primary) {
      semanticUnsupported(
        "unsupported-projection",
        "$.geometry.field",
        "OGC API Features can return only the source primary GeoJSON geometry",
      );
    }
  }
  return query.select?.map((name, index) => cql2FieldName(schema, name, `$.select[${index}]`));
}

function ogcSemanticSort(query: RuntimeOgcQuery, schema: SourceSchemaV2): string | undefined {
  if (!query.sort || query.sort.length === 0) return undefined;
  return query.sort
    .map((sort, index) => {
      if (sort.nulls !== undefined && sort.nulls !== "native") {
        semanticUnsupported(
          "unsupported-sort",
          `$.sort[${index}].nulls`,
          "OGC API Features sortby cannot request explicit null placement",
        );
      }
      const field = cql2FieldName(schema, sort.field, `$.sort[${index}].field`);
      if (!SAFE_SORT_FIELD.test(field)) {
        semanticUnsupported(
          "unsupported-sort",
          `$.sort[${index}].field`,
          `sortby cannot safely represent property ${JSON.stringify(field)}`,
        );
      }
      return `${sort.direction === "desc" ? "-" : "+"}${field}`;
    })
    .join(",");
}

function assertCql2JsonGeometry(value: ReturnType<typeof geometryInDefinitionOrder>, path: string): void {
  if (value.type !== "GeometryCollection") return;
  if (value.geometries.length < 2) {
    semanticUnsupported(
      "unsupported-geometry",
      `${path}.geometries`,
      "CQL2 JSON GeometryCollection requires at least two members",
    );
  }
  value.geometries.forEach((entry, index) => {
    if (entry.type === "GeometryCollection") {
      semanticUnsupported(
        "unsupported-geometry",
        `${path}.geometries[${index}]`,
        "CQL2 JSON 1.0 does not permit nested GeometryCollection members",
      );
    }
  });
}

function isDefaultFilterCrs(uri: string, dimensions: number): boolean {
  const normalized = uri.toLowerCase().replace(/\/+$/, "");
  return dimensions === 3
    ? normalized.endsWith("/def/crs/ogc/1.3/crs84h")
    : normalized.endsWith("/def/crs/ogc/1.3/crs84");
}

function hasControl(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: source identifiers cannot contain controls
  return /[\u0000-\u001f\u007f]/.test(value);
}

const SAFE_SORT_FIELD = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

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
  const declaredWkids = [reference.wkid, reference.latestWkid].filter((value) => value !== undefined);
  if (declaredWkids.length > 0 && declaredWkids.every((value) => value === 4326) && reference.wkt === undefined) {
    return;
  }
  throw unsupportedBboxCrs(sourceId);
}

function unsupportedBboxCrs(sourceId: string): HonuaQueryPlanningError {
  return new HonuaQueryPlanningError(
    "unsupported-query",
    `Source "${sourceId}" can only compile an unstamped or EPSG:4326 envelope to the default OGC bbox CRS`,
  );
}
