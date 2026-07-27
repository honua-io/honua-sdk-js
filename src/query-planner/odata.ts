import { validateExecutableCrsBinding } from "../contract/schema.js";
import type {
  CanonicalGeometry,
  ExecutableBoundingBox,
  ExecutableCrsBinding,
  ExecutableGeometryValue,
  GeometryFieldSchema,
  GeometryKind,
  JsonValue,
  LogicalField,
  Position,
  SourceSchemaV2,
} from "../contract/schema.js";
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
  odataPropertyPath,
  quotedSemanticString,
  recordSemanticFieldMapping,
  semanticRequestFingerprint,
  sortSemanticFieldMappings,
  verifiedSemanticNativeText,
  verifiedSemanticSourceText,
  verifiedSemanticSourceVersion,
} from "./semantic-literals.js";
import type { QueryFilter, SemanticQuery, SourceSpatiality } from "./semantic-types.js";
import { HonuaQueryPlanningError } from "./types.js";

export type SemanticOdataSpatialFunction = "geo.intersects" | "geo.distance";

/** Static, credential-free OData endpoint evidence used by the semantic compiler. */
export interface SemanticOdataSourceIdentity {
  readonly entitySet: string;
  readonly sourceVersion?: string;
  /** Spatial functions explicitly advertised or certified for this service. */
  readonly supportedSpatialFunctions?: readonly SemanticOdataSpatialFunction[];
}

export interface SemanticOdataCompileOptions<
  TRecord = Record<string, unknown>,
  TSpatiality extends SourceSpatiality = SourceSpatiality,
> {
  readonly query: SemanticQuery<TRecord, "odata", TSpatiality>;
  readonly schema: SourceSchemaV2;
  readonly source: SemanticOdataSourceIdentity;
}

export interface SemanticOdataOutputGeometry {
  readonly field: string;
  readonly propertyPath: string;
  readonly spatialType: "geography" | "geometry";
  readonly crs: ExecutableCrsBinding;
  readonly layout: "xy";
}

/** Canonical pre-image of an OData v4 entity-set request. */
export interface SemanticOdataCompiledQueryV1 {
  readonly compiler: "odata-v4-semantic-query-v1";
  readonly dialect: "odata-4.0";
  readonly schemaFingerprint: SourceSchemaV2["fingerprint"];
  readonly queryFingerprint: `sha256:${string}`;
  readonly requestFingerprint: `sha256:${string}`;
  readonly entitySet: string;
  readonly sourceVersion?: string;
  readonly filter?: string;
  readonly select: readonly string[];
  readonly orderBy?: readonly string[];
  readonly skip?: number;
  readonly top?: number;
  readonly outputGeometry?: SemanticOdataOutputGeometry;
  readonly fieldMappings: readonly SemanticCompilerFieldMapping[];
  readonly usesNativeFilter: boolean;
}

type RuntimeOdataQuery = RuntimeSemanticQuery<"odata">;
type RuntimeOdataFilter = QueryFilter<Record<string, unknown>, "odata", SourceSpatiality>;
type RuntimeOdataSpatialFilter = Extract<RuntimeOdataFilter, { readonly kind: "spatial" }>;

const ODATA_COMPARISON_OPERATOR = {
  eq: "eq",
  ne: "ne",
  lt: "lt",
  lte: "le",
  gt: "gt",
  gte: "ge",
} as const;

interface VerifiedOdataSource extends SemanticOdataSourceIdentity {
  readonly supportedSpatialFunctions: readonly SemanticOdataSpatialFunction[];
}

interface OdataSemanticState {
  readonly schema: SourceSchemaV2;
  readonly source: VerifiedOdataSource;
  readonly fieldMappings: SemanticCompilerFieldMapping[];
  usesNativeFilter: boolean;
}

/** Compile a validated semantic AST to exact OData v4 system query options. */
export function compileSemanticOdataQuery<TRecord, TSpatiality extends SourceSpatiality>(
  options: SemanticOdataCompileOptions<TRecord, TSpatiality>,
): SemanticCompilationResult<SemanticOdataCompiledQueryV1> {
  return runSemanticCompiler(() => {
    const source = verifiedOdataSource(options.source);
    const { query, schema } = prepareSemanticCompilerQuery(options.query, options.schema, "odata");
    const state: OdataSemanticState = { schema, source, fieldMappings: [], usesNativeFilter: false };
    if (query.kind === "aggregate") {
      semanticUnsupported(
        "unsupported-node",
        "$.kind",
        "Portable OData v4 aggregation requires a separate typed $apply semantic model",
      );
    }
    const projection = odataProjection(query, state);
    const filter = query.filter
      ? compileOdataSemanticFilter(query.filter as RuntimeOdataFilter, state, "$.filter")
      : undefined;
    const orderBy = odataOrderBy(query, state);
    const page = odataPage(query);
    const queryFingerprint = hashSemanticQuery(query, { schema, protocol: "odata" });
    const request = {
      entitySet: source.entitySet,
      ...(source.sourceVersion ? { sourceVersion: source.sourceVersion } : {}),
      ...(filter ? { filter } : {}),
      ...projection,
      ...(orderBy ? { orderBy } : {}),
      ...page,
      fieldMappings: sortSemanticFieldMappings(state.fieldMappings),
      usesNativeFilter: state.usesNativeFilter,
    };
    const artifact: SemanticOdataCompiledQueryV1 = {
      compiler: "odata-v4-semantic-query-v1",
      dialect: "odata-4.0",
      schemaFingerprint: schema.fingerprint,
      queryFingerprint,
      requestFingerprint: semanticRequestFingerprint("honua:query-request:odata-4.0:1", {
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

function verifiedOdataSource(value: SemanticOdataSourceIdentity): VerifiedOdataSource {
  if (!value || typeof value !== "object") {
    throw new HonuaQueryPlanningError("invalid-query", "Semantic OData source identity is invalid");
  }
  const entitySet = verifiedSemanticSourceText(value.entitySet, "options.source.entitySet");
  try {
    odataPropertyPath([entitySet], "options.source.entitySet");
  } catch {
    throw new HonuaQueryPlanningError("invalid-query", "options.source.entitySet is invalid");
  }
  const sourceVersion = verifiedSemanticSourceVersion(value.sourceVersion, "options.source.sourceVersion");
  const functions = value.supportedSpatialFunctions ?? [];
  if (!Array.isArray(functions)) {
    throw new HonuaQueryPlanningError("invalid-query", "options.source.supportedSpatialFunctions is invalid");
  }
  const allowed = new Set<SemanticOdataSpatialFunction>(["geo.intersects", "geo.distance"]);
  const seen = new Set<string>();
  for (const name of functions) {
    if (!allowed.has(name) || seen.has(name)) {
      throw new HonuaQueryPlanningError("invalid-query", "options.source.supportedSpatialFunctions is invalid");
    }
    seen.add(name);
  }
  return {
    entitySet,
    ...(sourceVersion ? { sourceVersion } : {}),
    supportedSpatialFunctions: [...functions].sort(),
  };
}

function odataProjection(
  query: Extract<RuntimeOdataQuery, { readonly kind: "features" }>,
  state: OdataSemanticState,
): Pick<SemanticOdataCompiledQueryV1, "select" | "outputGeometry"> {
  const primary = primaryOdataGeometryField(state.schema);
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
      "OData geometry inclusion requires a known primary geometry property",
    );
  }
  const requested = query.select ?? state.schema.fields.map((field) => field.name);
  const select: string[] = [];
  let outputGeometry: SemanticOdataOutputGeometry | undefined;
  requested.forEach((name, index) => {
    const path = query.select ? `$.select[${index}]` : "$.schema.fields";
    const field = semanticSchemaField(state.schema, name as string, path);
    if (field.type.kind !== "geometry") {
      select.push(odataRequestField(field, state, path));
      return;
    }
    if (query.select && field.name !== geometryField) {
      semanticUnsupported(
        "unsupported-projection",
        path,
        "An OData geometry property selected as data must match the geometry projection",
      );
    }
    if (field.name !== geometryField) return;
    outputGeometry = odataOutputGeometry(field, state, path);
    select.push(outputGeometry.propertyPath);
  });
  if (geometryField && !outputGeometry) {
    const field = semanticSchemaField(state.schema, geometryField, "$.geometry");
    outputGeometry = odataOutputGeometry(field, state, "$.geometry");
    if (!select.includes(outputGeometry.propertyPath)) select.push(outputGeometry.propertyPath);
  }
  if (query.outputCrs) {
    if (!outputGeometry) {
      semanticUnsupported(
        "unsupported-projection",
        "$.outputCrs",
        "OData cannot apply an output CRS when geometry is omitted",
      );
    }
    if (!sameCrsDefinition(outputGeometry.crs.definition, query.outputCrs)) {
      semanticUnsupported(
        "crs-transform-required",
        "$.outputCrs",
        "OData v4 has no portable output geometry transform option",
      );
    }
  }
  if (select.length === 0) {
    semanticUnsupported("unsupported-projection", "$.select", "OData requires at least one selected property");
  }
  return { select, ...(outputGeometry ? { outputGeometry } : {}) };
}

function odataOutputGeometry(
  field: LogicalField,
  state: OdataSemanticState,
  path: string,
): SemanticOdataOutputGeometry {
  const propertyPath = odataRequestField(field, state, path);
  const metadata = sourceOdataGeometryField(state.schema, field.name, path);
  const crs = executableOdataCrs(metadata.crs, path);
  if (metadata.layout !== "xy") {
    semanticUnsupported("unsupported-geometry", path, "OData geometry output requires explicit xy layout metadata");
  }
  const spatialType = odataSpatialType(field, metadata, path);
  assertOdataSpatialCategoryCrs(spatialType, crs, path);
  return {
    field: field.name,
    propertyPath,
    spatialType,
    crs,
    layout: "xy",
  };
}

function odataOrderBy(query: RuntimeOdataQuery, state: OdataSemanticState): readonly string[] | undefined {
  if (!query.sort || query.sort.length === 0) return undefined;
  return query.sort.map((sort, index) => {
    if (sort.nulls && sort.nulls !== "native") {
      semanticUnsupported(
        "unsupported-sort",
        `$.sort[${index}].nulls`,
        "OData v4 does not expose portable explicit null ordering",
      );
    }
    const path = `$.sort[${index}].field`;
    const field = semanticSchemaField(state.schema, sort.field as string, path);
    return `${odataRequestField(field, state, path)} ${sort.direction}`;
  });
}

function odataPage(query: RuntimeOdataQuery): Pick<SemanticOdataCompiledQueryV1, "skip" | "top"> {
  if (!query.page) return {};
  if (query.page.limit !== undefined && query.page.limit > 2_147_483_647) {
    semanticUnsupported("unsupported-node", "$.page.limit", "OData $top is int32-bounded");
  }
  if (query.page.kind === "offset" && query.page.offset > 2_147_483_647) {
    semanticUnsupported("unsupported-node", "$.page.offset", "OData $skip is int32-bounded");
  }
  return {
    ...(query.page.kind === "offset" ? { skip: query.page.offset } : {}),
    ...(query.page.limit !== undefined ? { top: query.page.limit } : {}),
  };
}

function compileOdataSemanticFilter(filter: RuntimeOdataFilter, state: OdataSemanticState, path: string): string {
  switch (filter.kind) {
    case "comparison": {
      const field = semanticSchemaField(state.schema, filter.left.name, `${path}.left.name`);
      return `${odataRequestField(field, state, `${path}.left.name`)} ${ODATA_COMPARISON_OPERATOR[filter.operator]} ${odataLiteral(
        filter.right.value,
        field,
        `${path}.right.value`,
      )}`;
    }
    case "list": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      const name = odataRequestField(field, state, `${path}.operand.name`);
      return filter.values
        .map((literal, index) => `(${name} eq ${odataLiteral(literal.value, field, `${path}.values[${index}].value`)})`)
        .join(" or ");
    }
    case "range": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      const name = odataRequestField(field, state, `${path}.operand.name`);
      return `(${name} ge ${odataLiteral(filter.lower.value, field, `${path}.lower.value`)}) and (${name} le ${odataLiteral(
        filter.upper.value,
        field,
        `${path}.upper.value`,
      )})`;
    }
    case "null": {
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      return `${odataRequestField(field, state, `${path}.operand.name`)} ${
        filter.operator === "is-not-null" ? "ne" : "eq"
      } null`;
    }
    case "pattern":
      return compileOdataPattern(filter, state, path);
    case "boolean":
      return filter.args
        .map((entry, index) =>
          odataParenthesized(compileOdataSemanticFilter(entry as RuntimeOdataFilter, state, `${path}.args[${index}]`)),
        )
        .join(filter.operator === "and" ? " and " : " or ");
    case "not":
      return `not ${odataParenthesized(compileOdataSemanticFilter(filter.arg as RuntimeOdataFilter, state, `${path}.arg`))}`;
    case "temporal": {
      if (filter.operator === "during" || filter.operator === "time-intersects") {
        semanticUnsupported(
          "unsupported-node",
          `${path}.operator`,
          `OData v4 cannot represent the OGC ${filter.operator} temporal-topology predicate exactly`,
        );
      }
      const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
      const name = odataRequestField(field, state, `${path}.operand.name`);
      return `${name} ${filter.operator === "before" ? "lt" : "gt"} ${odataLiteral(
        filter.value.value as string,
        field,
        `${path}.value.value`,
      )}`;
    }
    case "spatial":
      return compileOdataSpatial(filter, state, path);
    case "native": {
      if (filter.dialect !== "odata-4.0" || filter.payload.format !== "text") {
        semanticUnsupported("unsupported-native-filter", path, "OData native filters require odata-4.0 text");
      }
      state.usesNativeFilter = true;
      return verifiedSemanticNativeText(filter.payload.text, `${path}.payload.text`, "OData 4.0");
    }
  }
}

function compileOdataPattern(
  filter: Extract<RuntimeOdataFilter, { readonly kind: "pattern" }>,
  state: OdataSemanticState,
  path: string,
): string {
  if (filter.caseSensitive === false) {
    semanticUnsupported(
      "unsupported-node",
      `${path}.caseSensitive`,
      "OData v4 cannot prove case-insensitive pattern semantics across services",
    );
  }
  const field = semanticSchemaField(state.schema, filter.operand.name, `${path}.operand.name`);
  const name = odataRequestField(field, state, `${path}.operand.name`);
  const pattern = filter.pattern;
  if (pattern.includes("_")) {
    semanticUnsupported(
      "unsupported-node",
      `${path}.pattern`,
      "OData string functions cannot represent the LIKE single-character wildcard",
    );
  }
  const percentCount = [...pattern].filter((character) => character === "%").length;
  if (percentCount === 0) return `${name} eq ${quotedSemanticString(pattern, `${path}.pattern`)}`;
  if (pattern === "%") {
    semanticUnsupported("unsupported-node", `${path}.pattern`, "An always-true LIKE pattern is not emitted");
  }
  const starts = pattern.startsWith("%");
  const ends = pattern.endsWith("%");
  if (percentCount !== Number(starts) + Number(ends)) {
    semanticUnsupported(
      "unsupported-node",
      `${path}.pattern`,
      "OData string functions cannot represent an interior LIKE wildcard exactly",
    );
  }
  const value = pattern.slice(starts ? 1 : 0, ends ? -1 : undefined);
  if (value.length === 0 && starts && ends) {
    semanticUnsupported("unsupported-node", `${path}.pattern`, "An always-true LIKE pattern is not emitted");
  }
  const literal = quotedSemanticString(value, `${path}.pattern`);
  if (starts && ends) return `contains(${name},${literal})`;
  if (starts) return `endswith(${name},${literal})`;
  return `startswith(${name},${literal})`;
}

function odataLiteral(value: JsonValue, field: LogicalField, path: string): string {
  switch (field.type.kind) {
    case "boolean":
      return value ? "true" : "false";
    case "integer":
    case "decimal":
      return typeof value === "number" ? finiteDecimalNumber(value, path) : exactDecimalText(value as string, path);
    case "float":
      return finiteDecimalNumber(value as number, path);
    case "string":
      return quotedSemanticString(value as string, path);
    case "uuid":
    case "date":
    case "time":
      return value as string;
    case "timestamp":
      if (/:60(?:[.Z+-]|$)/.test(value as string)) {
        semanticUnsupported("unsupported-field-type", path, "OData Edm.DateTimeOffset does not support leap seconds");
      }
      return value as string;
    case "duration":
      return `duration${quotedSemanticString(value as string, path)}`;
    case "union":
      return odataUnionLiteral(value, field, path);
    default:
      semanticUnsupported(
        "unsupported-field-type",
        path,
        `OData v4 cannot represent ${field.type.kind} literals exactly in $filter`,
      );
  }
}

function odataUnionLiteral(value: JsonValue, field: LogicalField, path: string): string {
  const specialFloat =
    field.type.kind === "union" &&
    field.type.members.length === 2 &&
    field.type.members.some((member) => member.kind === "float") &&
    field.type.members.some((member) => member.kind === "string" && member.encoding === "odata-special-float");
  const nativeFloat = field.native.some(
    (reference) =>
      reference.protocol === "odata" && (reference.name === "Edm.Single" || reference.name === "Edm.Double"),
  );
  if (!specialFloat || !nativeFloat) {
    semanticUnsupported("unsupported-field-type", path, "OData union literal metadata is ambiguous");
  }
  if (typeof value === "number") return finiteDecimalNumber(value, path);
  if (value === "NaN" || value === "INF" || value === "-INF") return value;
  semanticUnsupported("unsupported-field-type", path, "OData special floats require NaN, INF, or -INF");
}

function compileOdataSpatial(filter: RuntimeOdataSpatialFilter, state: OdataSemanticState, path: string): string {
  if (filter.operator === "within-distance" || filter.operator === "beyond-distance") {
    semanticUnsupported(
      "unsupported-distance",
      `${path}.distance`,
      "OData geo.distance cannot preserve semantic planar/geodesic mode and portable units",
    );
  }
  if (filter.operator !== "intersects" && filter.operator !== "bbox-intersects") {
    semanticUnsupported(
      "unsupported-node",
      `${path}.operator`,
      `OData v4 has no portable function for exact ${filter.operator} semantics`,
    );
  }
  if (!state.source.supportedSpatialFunctions.includes("geo.intersects")) {
    semanticUnsupported(
      "unsupported-source",
      `${path}.operator`,
      "OData source evidence does not explicitly advertise geo.intersects",
    );
  }
  const fieldName = filter.property?.name ?? primaryOdataGeometryField(state.schema);
  if (!fieldName) {
    semanticUnsupported("unsupported-geometry", `${path}.property`, "OData requires an explicit geometry property");
  }
  const field = semanticSchemaField(state.schema, fieldName, `${path}.property.name`);
  const propertyPath = odataRequestField(field, state, `${path}.property.name`);
  const metadata = sourceOdataGeometryField(state.schema, fieldName, `${path}.property`);
  const propertySpatial = odataFilterSpatialType(field, metadata, `${path}.property.name`);
  const sourceCrs = executableOdataCrs(metadata.crs, `${path}.property`);
  assertOdataSpatialCategoryCrs(propertySpatial.spatialType, sourceCrs, `${path}.property`);
  if (metadata.layout !== "xy") {
    semanticUnsupported(
      "unsupported-geometry",
      `${path}.property`,
      "OData spatial filtering requires explicit xy geometry-property layout metadata",
    );
  }
  if (filter.operator === "bbox-intersects") {
    if (propertySpatial.geometryKind !== "Point") {
      semanticUnsupported(
        "unsupported-geometry",
        `${path}.property.name`,
        "OData bbox intersection requires an exact Point property for the Point,Polygon signature",
      );
    }
    const literal = odataBboxLiteral(filter.bbox, sourceCrs, propertySpatial.spatialType, path);
    return `geo.intersects(${propertyPath},${literal})`;
  }
  const literalKind = filter.geometry.geometry.type;
  if (propertySpatial.geometryKind === "Point" && literalKind === "Polygon") {
    const literal = odataGeometryLiteral(filter.geometry, sourceCrs, propertySpatial.spatialType, path);
    return `geo.intersects(${propertyPath},${literal})`;
  }
  if (propertySpatial.geometryKind === "Polygon" && literalKind === "Point") {
    const literal = odataGeometryLiteral(filter.geometry, sourceCrs, propertySpatial.spatialType, path);
    return `geo.intersects(${literal},${propertyPath})`;
  }
  semanticUnsupported(
    "unsupported-geometry",
    `${path}.geometry.geometry`,
    `OData geo.intersects requires Point,Polygon operands; property is ${propertySpatial.geometryKind} and literal is ${literalKind}`,
  );
}

function odataGeometryLiteral(
  value: ExecutableGeometryValue,
  sourceCrs: ExecutableCrsBinding,
  spatialType: "geography" | "geometry",
  path: string,
): string {
  if (value.layout !== "xy") {
    semanticUnsupported(
      "unsupported-geometry",
      `${path}.geometry.layout`,
      "OData v4 spatial literals require an xy coordinate layout",
    );
  }
  assertOdataEastNorth(value.crs, `${path}.geometry.crs`);
  if (!sameExecutableCrs(sourceCrs, value.crs)) {
    semanticUnsupported(
      "crs-transform-required",
      `${path}.geometry.crs`,
      "Spatial literal CRS differs from the OData geometry property CRS",
    );
  }
  return odataSpatialLiteral(spatialType, value.crs, odataWkt(value.geometry, path), `${path}.geometry.crs`);
}

function odataBboxLiteral(
  value: ExecutableBoundingBox,
  sourceCrs: ExecutableCrsBinding,
  spatialType: "geography" | "geometry",
  path: string,
): string {
  if (value.box.layout !== "xy") {
    semanticUnsupported(
      "unsupported-geometry",
      `${path}.bbox.box.layout`,
      "OData v4 bounding-box literals require an xy layout",
    );
  }
  assertOdataEastNorth(value.crs, `${path}.bbox.crs`);
  if (!sameExecutableCrs(sourceCrs, value.crs)) {
    semanticUnsupported(
      "crs-transform-required",
      `${path}.bbox.crs`,
      "Bounding-box CRS differs from the OData geometry property CRS",
    );
  }
  const [xmin, ymin, xmax, ymax] = value.box.bounds;
  const wkt = `POLYGON ((${wktPosition([xmin, ymin])}, ${wktPosition([xmax, ymin])}, ${wktPosition([
    xmax,
    ymax,
  ])}, ${wktPosition([xmin, ymax])}, ${wktPosition([xmin, ymin])}))`;
  return odataSpatialLiteral(spatialType, value.crs, wkt, `${path}.bbox.crs`);
}

function odataSpatialLiteral(
  spatialType: "geography" | "geometry",
  crs: ExecutableCrsBinding,
  wkt: string,
  path: string,
): string {
  const srid = odataSrid(crs, path);
  return `${spatialType}'SRID=${srid};${wkt}'`;
}

function odataWkt(geometry: CanonicalGeometry, path: string): string {
  switch (geometry.type) {
    case "Point":
      return `POINT (${wktPosition(geometry.coordinates)})`;
    case "MultiPoint":
      return `MULTIPOINT (${geometry.coordinates.map((position) => `(${wktPosition(position)})`).join(", ")})`;
    case "LineString":
      return `LINESTRING (${wktLine(geometry.coordinates)})`;
    case "MultiLineString":
      return `MULTILINESTRING (${geometry.coordinates.map((line) => `(${wktLine(line)})`).join(", ")})`;
    case "Polygon":
      return `POLYGON (${geometry.coordinates.map((ring) => `(${wktLine(ring)})`).join(", ")})`;
    case "MultiPolygon":
      return `MULTIPOLYGON (${geometry.coordinates
        .map((polygon) => `(${polygon.map((ring) => `(${wktLine(ring)})`).join(", ")})`)
        .join(", ")})`;
    case "GeometryCollection":
      semanticUnsupported(
        "unsupported-geometry",
        `${path}.geometry.geometry`,
        "OData v4 spatial literals do not compile GeometryCollection in this exact slice",
      );
  }
}

function wktLine(positions: readonly Position[]): string {
  return positions.map(wktPosition).join(", ");
}

function wktPosition(position: readonly number[]): string {
  return `${finiteDecimalNumber(position[0] as number, "$.geometry.coordinates")} ${finiteDecimalNumber(
    position[1] as number,
    "$.geometry.coordinates",
  )}`;
}

function executableOdataCrs(value: unknown, path: string): ExecutableCrsBinding {
  let crs: ExecutableCrsBinding;
  try {
    crs = validateExecutableCrsBinding(value, path);
  } catch {
    semanticUnsupported("unsupported-crs", path, "OData requires a resolved executable geometry-property CRS");
  }
  if (crs.coordinateEpoch !== undefined) {
    semanticUnsupported("unsupported-crs", path, "OData spatial literals cannot preserve coordinate epochs");
  }
  assertOdataEastNorth(crs, path);
  odataSrid(crs, path);
  return crs;
}

function odataSrid(value: ExecutableCrsBinding, path: string): number {
  const definition = value.definition;
  if (
    definition.kind === "authority" &&
    definition.authority.toUpperCase() === "EPSG" &&
    /^\d+$/.test(definition.code)
  ) {
    const srid = Number(definition.code);
    if (Number.isSafeInteger(srid) && srid > 0 && srid <= 2_147_483_647) return srid;
  }
  semanticUnsupported("unsupported-crs", path, "OData spatial literals require a positive EPSG SRID");
}

function assertOdataEastNorth(value: ExecutableCrsBinding, path: string): void {
  const [x, y] = value.coordinateOrder.axes;
  if (x?.direction !== "east" || y?.direction !== "north") {
    semanticUnsupported("unsupported-crs", path, "OData spatial literals require east/north x/y payload axes");
  }
}

const ODATA_SPATIAL_NATIVE_TYPES: Readonly<
  Record<string, { readonly spatialType: "geography" | "geometry"; readonly geometryKind?: GeometryKind }>
> = {
  "Edm.Geography": { spatialType: "geography" },
  "Edm.GeographyPoint": { spatialType: "geography", geometryKind: "Point" },
  "Edm.GeographyLineString": { spatialType: "geography", geometryKind: "LineString" },
  "Edm.GeographyPolygon": { spatialType: "geography", geometryKind: "Polygon" },
  "Edm.GeographyMultiPoint": { spatialType: "geography", geometryKind: "MultiPoint" },
  "Edm.GeographyMultiLineString": { spatialType: "geography", geometryKind: "MultiLineString" },
  "Edm.GeographyMultiPolygon": { spatialType: "geography", geometryKind: "MultiPolygon" },
  "Edm.GeographyCollection": { spatialType: "geography", geometryKind: "GeometryCollection" },
  "Edm.Geometry": { spatialType: "geometry" },
  "Edm.GeometryPoint": { spatialType: "geometry", geometryKind: "Point" },
  "Edm.GeometryLineString": { spatialType: "geometry", geometryKind: "LineString" },
  "Edm.GeometryPolygon": { spatialType: "geometry", geometryKind: "Polygon" },
  "Edm.GeometryMultiPoint": { spatialType: "geometry", geometryKind: "MultiPoint" },
  "Edm.GeometryMultiLineString": { spatialType: "geometry", geometryKind: "MultiLineString" },
  "Edm.GeometryMultiPolygon": { spatialType: "geometry", geometryKind: "MultiPolygon" },
  "Edm.GeometryCollection": { spatialType: "geometry", geometryKind: "GeometryCollection" },
};

interface OdataSpatialTypeEvidence {
  readonly spatialType: "geography" | "geometry";
  readonly geometryKind?: GeometryKind;
}

interface OdataFilterSpatialType extends OdataSpatialTypeEvidence {
  readonly geometryKind: "Point" | "Polygon";
}

function odataSpatialType(field: LogicalField, metadata: GeometryFieldSchema, path: string): "geography" | "geometry" {
  return odataSpatialTypeEvidence(field, metadata, path).spatialType;
}

function odataFilterSpatialType(
  field: LogicalField,
  metadata: GeometryFieldSchema,
  path: string,
): OdataFilterSpatialType {
  const evidence = odataSpatialTypeEvidence(field, metadata, path);
  if (evidence.geometryKind !== "Point" && evidence.geometryKind !== "Polygon") {
    semanticUnsupported(
      "unsupported-source",
      path,
      "OData geo.intersects requires an exact Edm Point or Polygon property type",
    );
  }
  if (metadata.geometryTypes.state !== "known" || metadata.geometryTypes.type !== evidence.geometryKind) {
    semanticUnsupported(
      "unsupported-source",
      path,
      "OData geo.intersects requires matching, single-kind SourceSchemaV2 geometry evidence",
    );
  }
  return { spatialType: evidence.spatialType, geometryKind: evidence.geometryKind };
}

function odataSpatialTypeEvidence(
  field: LogicalField,
  metadata: GeometryFieldSchema,
  path: string,
): OdataSpatialTypeEvidence {
  const references = field.native.filter((reference) => reference.protocol === "odata");
  if (references.length !== 1 || !Object.hasOwn(ODATA_SPATIAL_NATIVE_TYPES, references[0]?.name as string)) {
    semanticUnsupported(
      "unsupported-source",
      path,
      "OData geometry properties require one exact OData v4 Edm.Geography or Edm.Geometry primitive type",
    );
  }
  const type = references[0]?.name as string;
  const evidence = ODATA_SPATIAL_NATIVE_TYPES[type];
  if (!evidence) {
    semanticUnsupported("unsupported-source", path, "OData spatial native type evidence is unavailable");
  }
  const geometryKind = evidence.geometryKind;
  if (geometryKind && (metadata.geometryTypes.state !== "known" || metadata.geometryTypes.type !== geometryKind)) {
    semanticUnsupported(
      "unsupported-source",
      path,
      "OData native spatial primitive requires matching, single-kind SourceSchemaV2 geometry evidence",
    );
  }
  return evidence;
}

const ODATA_ANGULAR_AXIS_UNITS = new Set(["degree", "radian"]);
const ODATA_LINEAR_AXIS_UNITS = new Set([
  "metre",
  "meter",
  "kilometre",
  "kilometer",
  "foot",
  "us-survey-foot",
  "mile",
  "nautical-mile",
  "yard",
]);

function assertOdataSpatialCategoryCrs(
  spatialType: "geography" | "geometry",
  crs: ExecutableCrsBinding,
  path: string,
): void {
  const units = crs.coordinateOrder.axes.slice(0, 2).map((axis) => axis.unit?.toLowerCase());
  const category = units.every((unit) => unit !== undefined && ODATA_ANGULAR_AXIS_UNITS.has(unit))
    ? "geography"
    : units.every((unit) => unit !== undefined && ODATA_LINEAR_AXIS_UNITS.has(unit))
      ? "geometry"
      : undefined;
  if (category !== spatialType) {
    semanticUnsupported(
      "unsupported-crs",
      path,
      `OData ${spatialType} requires ${spatialType === "geography" ? "angular" : "linear"} horizontal CRS axes`,
    );
  }
}

function sourceOdataGeometryField(schema: SourceSchemaV2, name: string, path: string) {
  if (schema.geometry.state !== "known") {
    semanticUnsupported("unsupported-source", path, "OData source geometry metadata is unavailable");
  }
  const field = schema.geometry.fields.find((candidate) => candidate.field === name);
  if (!field) semanticUnsupported("unsupported-source", path, "OData geometry-property metadata is unavailable");
  return field;
}

function primaryOdataGeometryField(schema: SourceSchemaV2): string | undefined {
  return schema.geometry.state === "known" && schema.geometry.primaryField.state === "known"
    ? schema.geometry.primaryField.field
    : undefined;
}

function odataRequestField(field: LogicalField, state: OdataSemanticState, path: string): string {
  const requestField = odataPropertyPath(field.path, path);
  recordSemanticFieldMapping(state.fieldMappings, field, requestField);
  return requestField;
}

function odataParenthesized(value: string): string {
  return `(${value})`;
}
