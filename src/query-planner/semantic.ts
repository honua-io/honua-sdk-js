import {
  type ExecutableCrsBinding,
  type JsonValue,
  type LogicalField,
  type LogicalType,
  type SourceProtocol,
  type SourceSchemaV2,
  compareLogicalDomainValues,
  isLogicalDomainValueCompatible,
  parseSourceSchemaV2,
  validateExecutableCrsBinding,
  validateSourceCrsDefinition,
} from "../contract/schema.js";
import { PROTOCOLS } from "../contract/types.js";
import type {
  AggregateMetric,
  BuiltInNativeDialect,
  ComparisonNode,
  DistanceOperand,
  EqualityOperator,
  FieldName,
  GeometryProjectionFor,
  GroupableFieldName,
  LiteralNode,
  NativeDialectFor,
  NativeFilter,
  NullNode,
  OrderableFieldName,
  OrderedComparisonOperator,
  ParseSemanticQueryOptions,
  PatternNode,
  PropertyNode,
  QueryFilter,
  QueryLiteral,
  RangeNode,
  ScalarFieldName,
  SemanticAggregateQuery,
  SemanticFeatureQuery,
  SemanticFilter,
  SemanticPageRequest,
  SemanticQuery,
  SemanticSort,
  SourceSpatiality,
  SpatialNode,
  StringFieldName,
  TemporalFieldName,
  TemporalLiteralNode,
  TemporalNode,
  TemporalPredicate,
} from "./semantic-types.js";
import { HonuaQueryPlanningError } from "./types.js";

export const MAX_SEMANTIC_QUERY_BYTES = 256 * 1024;
export const MAX_SEMANTIC_QUERY_DEPTH = 64;
export const MAX_SEMANTIC_QUERY_NODES = 20_000;
export const MAX_SEMANTIC_QUERY_COLLECTION_ITEMS = 10_000;
export const MAX_SEMANTIC_QUERY_TEXT_BYTES = 64 * 1024;

const TEXT_ENCODER = new TextEncoder();
const EXTENSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*\.)+[A-Za-z0-9][A-Za-z0-9_-]*$/;
const BUILT_IN_DIALECTS = new Set<BuiltInNativeDialect>([
  "honua-grpc",
  "geoservices-sql92",
  "cql2-json",
  "cql2-text",
  "fes-2.0",
  "odata-4.0",
  "duckdb-sql",
]);
const ORDERED_TYPE_KINDS = new Set(["integer", "float", "decimal", "string", "uuid", "date", "time", "timestamp"]);
const NUMERIC_TYPE_KINDS = new Set(["integer", "float", "decimal"]);
const SCALAR_TYPE_KINDS = new Set([
  "boolean",
  "integer",
  "float",
  "decimal",
  "string",
  "binary",
  "uuid",
  "date",
  "time",
  "timestamp",
  "duration",
]);
const TOPOLOGICAL_OPERATORS = new Set([
  "equals",
  "intersects",
  "within",
  "contains",
  "disjoint",
  "touches",
  "overlaps",
  "crosses",
]);
const DISTANCE_UNITS = new Set([
  "metre",
  "kilometre",
  "foot",
  "us-survey-foot",
  "mile",
  "nautical-mile",
  "degree",
  "radian",
]);
const NATIVE_TEXT_DIALECTS = new Set(["geoservices-sql92", "cql2-text", "odata-4.0", "duckdb-sql"]);
const NATIVE_JSON_DIALECTS = new Set(["honua-grpc", "cql2-json"]);
const RFC3339_DATE_TYPE = { kind: "date" } as const satisfies LogicalType;
const RFC3339_INSTANT_TYPE = {
  kind: "timestamp",
  unit: "nanosecond",
  timezone: "offset",
} as const satisfies LogicalType;

type RuntimeQuery = SemanticQuery<Record<string, unknown>, SourceProtocol, SourceSpatiality>;
type RuntimeFilter = QueryFilter<Record<string, unknown>, SourceProtocol, SourceSpatiality>;
type RuntimeSpatialFilter = SpatialNode<Record<string, unknown>, "primary-geometry" | "ambiguous-geometry">;
type RuntimeTemporalFilter = TemporalNode<Record<string, unknown>>;
type JsonObject = { readonly [key: string]: JsonValue };
interface BoundedJsonState {
  nodes: number;
  bytes: number;
  readonly ancestors: WeakSet<object>;
}

/** @internal Shared bounded JSON boundary for semantic interchange codecs. */
export function parseBoundedSemanticJson(value: string | unknown): JsonValue {
  return deepFreeze(parseBoundedJson(value));
}

/**
 * Parse untrusted JSON or an untyped JavaScript value into a deeply immutable
 * semantic query. Syntax, resource bounds, dialect payload shape, and (when
 * supplied) schema field/type compatibility are all checked before return.
 */
export function parseSemanticQuery(value: string | unknown, options: ParseSemanticQueryOptions = {}): RuntimeQuery {
  try {
    const json = parseBoundedJson(value);
    const query = parseQueryObject(json, "$" as const);
    const schema = options.schema === undefined ? undefined : parseSourceSchemaV2(options.schema);
    const protocol = parseProtocolOption(options.protocol);
    validateParsedQuery(query, schema, protocol);
    return deepFreeze(query);
  } catch (error) {
    if (error instanceof HonuaQueryPlanningError) throw error;
    throw invalid("$", errorMessage(error));
  }
}

/** Validate and freeze a typed query while preserving its generic relationship. */
export function defineSemanticQuery<const TQuery extends { readonly kind: "features" | "aggregate" }>(
  query: TQuery,
  options: ParseSemanticQueryOptions = {},
): TQuery {
  return parseSemanticQuery(query, options) as unknown as TQuery;
}

export interface SemanticQueryBuilder<TRecord, TProtocol extends SourceProtocol, TSpatiality extends SourceSpatiality> {
  property<TKey extends FieldName<TRecord>>(name: TKey): PropertyNode<TKey>;
  literal<const TValue extends JsonValue>(value: TValue): LiteralNode<TValue>;
  comparison<TKey extends ScalarFieldName<TRecord>>(
    operator: EqualityOperator,
    left: PropertyNode<TKey>,
    right: QueryLiteral<TRecord[TKey]> | LiteralNode<QueryLiteral<TRecord[TKey]>>,
  ): ComparisonNode<TRecord>;
  comparison<TKey extends OrderableFieldName<TRecord>>(
    operator: OrderedComparisonOperator,
    left: PropertyNode<TKey>,
    right: QueryLiteral<TRecord[TKey]> | LiteralNode<QueryLiteral<TRecord[TKey]>>,
  ): ComparisonNode<TRecord>;
  inList<TKey extends ScalarFieldName<TRecord>>(
    operand: PropertyNode<TKey>,
    values: readonly [
      QueryLiteral<TRecord[TKey]> | LiteralNode<QueryLiteral<TRecord[TKey]>>,
      ...(QueryLiteral<TRecord[TKey]> | LiteralNode<QueryLiteral<TRecord[TKey]>>)[],
    ],
  ): SemanticFilter<TRecord, TSpatiality>;
  between<TKey extends OrderableFieldName<TRecord>>(
    operand: PropertyNode<TKey>,
    lower: QueryLiteral<TRecord[TKey]> | LiteralNode<QueryLiteral<TRecord[TKey]>>,
    upper: QueryLiteral<TRecord[TKey]> | LiteralNode<QueryLiteral<TRecord[TKey]>>,
  ): RangeNode<TRecord>;
  isNull<TKey extends FieldName<TRecord>>(
    operand: PropertyNode<TKey>,
    operator?: "is-null" | "is-not-null",
  ): NullNode<TKey>;
  like<TKey extends StringFieldName<TRecord>>(
    operand: PropertyNode<TKey>,
    pattern: string,
    options?: { readonly caseSensitive?: boolean },
  ): PatternNode<TKey>;
  and(
    ...args: readonly [SemanticFilter<TRecord, TSpatiality>, ...SemanticFilter<TRecord, TSpatiality>[]]
  ): SemanticFilter<TRecord, TSpatiality>;
  or(
    ...args: readonly [SemanticFilter<TRecord, TSpatiality>, ...SemanticFilter<TRecord, TSpatiality>[]]
  ): SemanticFilter<TRecord, TSpatiality>;
  not(arg: SemanticFilter<TRecord, TSpatiality>): SemanticFilter<TRecord, TSpatiality>;
  temporal<TKey extends TemporalFieldName<TRecord>>(
    operator: TemporalPredicate,
    operand: PropertyNode<TKey>,
    value: TemporalLiteralNode,
  ): TemporalNode<TRecord>;
  native<TDialect extends NativeDialectFor<TProtocol>>(
    dialect: TDialect,
    payload: NativeFilter<TDialect>["payload"],
  ): NativeFilter<TDialect>;
  features<
    const TSelect extends readonly FieldName<TRecord>[] | undefined = undefined,
    const TGeometry extends GeometryProjectionFor<TRecord, TSpatiality> = GeometryProjectionFor<TRecord, TSpatiality>,
  >(
    query?: Omit<SemanticFeatureQuery<TRecord, TProtocol, TSpatiality, TSelect, TGeometry>, "kind">,
  ): SemanticFeatureQuery<TRecord, TProtocol, TSpatiality, TSelect, TGeometry>;
  aggregate<
    const TGroupBy extends readonly GroupableFieldName<TRecord>[],
    const TMetrics extends readonly [AggregateMetric<TRecord>, ...AggregateMetric<TRecord>[]],
  >(
    query: Omit<SemanticAggregateQuery<TRecord, TProtocol, TSpatiality, TGroupBy, TMetrics>, "kind">,
  ): SemanticAggregateQuery<TRecord, TProtocol, TSpatiality, TGroupBy, TMetrics>;
}

/** Create immutable, schema-typed AST nodes without importing a protocol compiler. */
export function createSemanticQueryBuilder<
  TRecord,
  TProtocol extends SourceProtocol,
  TSpatiality extends SourceSpatiality = "ambiguous-geometry",
>(): SemanticQueryBuilder<TRecord, TProtocol, TSpatiality> {
  const property = <TKey extends FieldName<TRecord>>(name: TKey): PropertyNode<TKey> =>
    node({ kind: "property", name });
  const literal = <const TValue extends JsonValue>(value: TValue): LiteralNode<TValue> =>
    node({ kind: "literal", value });
  const asLiteral = (value: JsonValue | LiteralNode): LiteralNode =>
    isLiteralNode(value) ? node(value) : literal(value as JsonValue);

  return {
    property,
    literal,
    comparison(
      operator: EqualityOperator | OrderedComparisonOperator,
      left: PropertyNode,
      right: JsonValue | LiteralNode,
    ) {
      return node({ kind: "comparison", operator, left, right: asLiteral(right as JsonValue | LiteralNode) }) as never;
    },
    inList(operand, values) {
      return node({ kind: "list", operator: "in", operand, values: values.map(asLiteral) }) as never;
    },
    between(operand, lower, upper) {
      return node({
        kind: "range",
        operator: "between",
        operand,
        lower: asLiteral(lower),
        upper: asLiteral(upper),
      }) as never;
    },
    isNull(operand, operator = "is-null") {
      return node({ kind: "null", operator, operand });
    },
    like(operand, pattern, options = {}) {
      return node({
        kind: "pattern",
        operator: "like",
        operand,
        pattern,
        ...(options.caseSensitive === undefined ? {} : { caseSensitive: options.caseSensitive }),
      });
    },
    and(...args) {
      return node({ kind: "boolean", operator: "and", args }) as never;
    },
    or(...args) {
      return node({ kind: "boolean", operator: "or", args }) as never;
    },
    not(arg) {
      return node({ kind: "not", arg }) as never;
    },
    temporal(operator, operand, value) {
      return node({ kind: "temporal", operator, operand, value }) as never;
    },
    native(dialect, payload) {
      return node({ kind: "native", dialect, payload }) as never;
    },
    features(query = {}) {
      return node({ kind: "features", ...query }) as never;
    },
    aggregate(query) {
      return node({ kind: "aggregate", ...query }) as never;
    },
  };
}

/** Build a validated spatial node without weakening its executable operand. */
export function defineSpatialNode<TRecord, TSpatiality extends Exclude<SourceSpatiality, "non-spatial">>(
  value: SpatialNode<TRecord, TSpatiality>,
): SpatialNode<TRecord, TSpatiality> {
  const query = parseSemanticQuery({ kind: "features", filter: value });
  return query.filter as SpatialNode<TRecord, TSpatiality>;
}

export function temporalLiteral(
  valueType: "date" | "instant",
  value: string,
): Extract<TemporalLiteralNode, { readonly valueType: "date" | "instant" }>;
export function temporalLiteral(
  valueType: "interval",
  value: readonly [string, string],
): Extract<TemporalLiteralNode, { readonly valueType: "interval" }>;
export function temporalLiteral(
  valueType: TemporalLiteralNode["valueType"],
  value: string | readonly [string, string],
) {
  return node({ kind: "temporal-literal", valueType, value });
}

function parseQueryObject(value: JsonValue, path: string): RuntimeQuery {
  const object = expectObject(value, path);
  const kind = expectEnum(object.kind, `${path}.kind`, ["features", "aggregate"] as const);
  const baseKeys = ["kind", "filter", "sort", "page", "outputCrs"];
  const filter = object.filter === undefined ? undefined : parseFilter(object.filter, `${path}.filter`, 0);
  const sort = object.sort === undefined ? undefined : parseSort(object.sort, `${path}.sort`);
  const page = object.page === undefined ? undefined : parsePage(object.page, `${path}.page`);
  const outputCrs = object.outputCrs === undefined ? undefined : parseOutputCrs(object.outputCrs, `${path}.outputCrs`);

  if (kind === "features") {
    assertOnlyKeys(object, [...baseKeys, "select", "geometry"], path);
    const select = object.select === undefined ? undefined : parseStringArray(object.select, `${path}.select`, true);
    const geometry =
      object.geometry === undefined ? undefined : parseGeometryProjection(object.geometry, `${path}.geometry`);
    return {
      kind,
      ...(filter ? { filter } : {}),
      ...(sort ? { sort } : {}),
      ...(page ? { page } : {}),
      ...(outputCrs ? { outputCrs } : {}),
      ...(select ? { select } : {}),
      ...(geometry ? { geometry } : {}),
    } as RuntimeQuery;
  }

  assertOnlyKeys(object, [...baseKeys, "groupBy", "metrics"], path);
  const groupBy = parseStringArray(object.groupBy, `${path}.groupBy`, false);
  const metrics = parseMetrics(object.metrics, `${path}.metrics`);
  return {
    kind,
    ...(filter ? { filter } : {}),
    ...(sort ? { sort } : {}),
    ...(page ? { page } : {}),
    ...(outputCrs ? { outputCrs } : {}),
    groupBy,
    metrics,
  } as RuntimeQuery;
}

function parseFilter(value: JsonValue, path: string, depth: number): RuntimeFilter {
  if (depth > MAX_SEMANTIC_QUERY_DEPTH) throw invalid(path, "exceeds the semantic filter depth bound");
  const object = expectObject(value, path);
  const kind = expectString(object.kind, `${path}.kind`);
  switch (kind) {
    case "comparison": {
      assertOnlyKeys(object, ["kind", "operator", "left", "right"], path);
      const operator = expectEnum(object.operator, `${path}.operator`, ["eq", "ne", "lt", "lte", "gt", "gte"] as const);
      return {
        kind,
        operator,
        left: parseProperty(object.left, `${path}.left`),
        right: parseLiteral(object.right, `${path}.right`),
      } as unknown as RuntimeFilter;
    }
    case "list": {
      assertOnlyKeys(object, ["kind", "operator", "operand", "values"], path);
      expectExact(object.operator, "in", `${path}.operator`);
      const values = expectArray(object.values, `${path}.values`);
      if (values.length === 0) throw invalid(`${path}.values`, "must contain at least one literal");
      return {
        kind,
        operator: "in",
        operand: parseProperty(object.operand, `${path}.operand`),
        values: values.map((entry, index) => parseLiteral(entry, `${path}.values[${index}]`)),
      } as unknown as RuntimeFilter;
    }
    case "range": {
      assertOnlyKeys(object, ["kind", "operator", "operand", "lower", "upper"], path);
      expectExact(object.operator, "between", `${path}.operator`);
      return {
        kind,
        operator: "between",
        operand: parseProperty(object.operand, `${path}.operand`),
        lower: parseLiteral(object.lower, `${path}.lower`),
        upper: parseLiteral(object.upper, `${path}.upper`),
      } as unknown as RuntimeFilter;
    }
    case "null": {
      assertOnlyKeys(object, ["kind", "operator", "operand"], path);
      return {
        kind,
        operator: expectEnum(object.operator, `${path}.operator`, ["is-null", "is-not-null"] as const),
        operand: parseProperty(object.operand, `${path}.operand`),
      } as RuntimeFilter;
    }
    case "pattern": {
      assertOnlyKeys(object, ["kind", "operator", "operand", "pattern", "caseSensitive"], path);
      expectExact(object.operator, "like", `${path}.operator`);
      return {
        kind,
        operator: "like",
        operand: parseProperty(object.operand, `${path}.operand`),
        pattern: expectBoundedText(object.pattern, `${path}.pattern`),
        caseSensitive:
          object.caseSensitive === undefined ? true : expectBoolean(object.caseSensitive, `${path}.caseSensitive`),
      } as RuntimeFilter;
    }
    case "boolean": {
      assertOnlyKeys(object, ["kind", "operator", "args"], path);
      const args = expectArray(object.args, `${path}.args`);
      if (args.length === 0) throw invalid(`${path}.args`, "must contain at least one filter");
      return {
        kind,
        operator: expectEnum(object.operator, `${path}.operator`, ["and", "or"] as const),
        args: args.map((entry, index) => parseFilter(entry, `${path}.args[${index}]`, depth + 1)),
      } as unknown as RuntimeFilter;
    }
    case "not":
      assertOnlyKeys(object, ["kind", "arg"], path);
      return { kind, arg: parseFilter(object.arg, `${path}.arg`, depth + 1) } as RuntimeFilter;
    case "spatial":
      return parseSpatialFilter(object, path) as RuntimeFilter;
    case "temporal": {
      assertOnlyKeys(object, ["kind", "operator", "operand", "value"], path);
      return {
        kind,
        operator: expectEnum(object.operator, `${path}.operator`, [
          "before",
          "after",
          "during",
          "time-intersects",
        ] as const),
        operand: parseProperty(object.operand, `${path}.operand`),
        value: parseTemporalLiteral(object.value, `${path}.value`),
      } as RuntimeFilter;
    }
    case "native":
      if (depth !== 0) throw invalid(path, "native filters must be the complete top-level filter");
      return parseNativeFilter(object, path) as RuntimeFilter;
    default:
      throw invalid(`${path}.kind`, `has unsupported value ${JSON.stringify(kind)}`);
  }
}

function parseProperty(value: JsonValue | undefined, path: string): PropertyNode {
  const object = expectObject(value, path);
  assertOnlyKeys(object, ["kind", "name"], path);
  expectExact(object.kind, "property", `${path}.kind`);
  const name = expectNonblankBoundedText(object.name, `${path}.name`);
  return { kind: "property", name };
}

function parseLiteral(value: JsonValue | undefined, path: string): LiteralNode {
  const object = expectObject(value, path);
  assertOnlyKeys(object, ["kind", "value"], path);
  expectExact(object.kind, "literal", `${path}.kind`);
  if (!("value" in object)) throw invalid(`${path}.value`, "is required");
  return { kind: "literal", value: object.value as JsonValue };
}

function parseSpatialFilter(object: JsonObject, path: string): RuntimeFilter {
  const operator = expectBoundedText(object.operator, `${path}.operator`);
  const property = object.property === undefined ? undefined : parseProperty(object.property, `${path}.property`);
  if (operator === "bbox-intersects") {
    assertOnlyKeys(object, ["kind", "operator", "property", "bbox"], path);
    return {
      kind: "spatial",
      operator,
      ...(property ? { property } : {}),
      bbox: parseExecutableBbox(object.bbox, `${path}.bbox`),
    } as unknown as RuntimeFilter;
  }
  if (operator === "within-distance" || operator === "beyond-distance") {
    assertOnlyKeys(object, ["kind", "operator", "property", "geometry", "distance"], path);
    return {
      kind: "spatial",
      operator,
      ...(property ? { property } : {}),
      geometry: parseExecutableGeometry(object.geometry, `${path}.geometry`),
      distance: parseDistance(object.distance, `${path}.distance`),
    } as unknown as RuntimeFilter;
  }
  if (!TOPOLOGICAL_OPERATORS.has(operator)) throw invalid(`${path}.operator`, `has unsupported value ${operator}`);
  assertOnlyKeys(object, ["kind", "operator", "property", "geometry"], path);
  return {
    kind: "spatial",
    operator,
    ...(property ? { property } : {}),
    geometry: parseExecutableGeometry(object.geometry, `${path}.geometry`),
  } as unknown as RuntimeFilter;
}

function parseExecutableGeometry(value: JsonValue | undefined, path: string): JsonObject {
  const object = expectObject(value, path);
  assertOnlyKeys(object, ["state", "geometry", "crs", "layout"], path);
  expectExact(object.state, "present", `${path}.state`);
  const layout = expectEnum(object.layout, `${path}.layout`, ["xy", "xyz", "xym", "xyzm"] as const);
  const crs = parseExecutableCrsBinding(object.crs, `${path}.crs`);
  const geometry = parseCanonicalGeometry(object.geometry, `${path}.geometry`, layout, 0);
  return { state: "present", geometry, crs: crs as unknown as JsonValue, layout };
}

function parseExecutableBbox(value: JsonValue | undefined, path: string): JsonObject {
  const object = expectObject(value, path);
  assertOnlyKeys(object, ["box", "crs"], path);
  const box = expectObject(object.box, `${path}.box`);
  assertOnlyKeys(box, ["layout", "bounds"], `${path}.box`);
  const layout = expectEnum(box.layout, `${path}.box.layout`, ["xy", "xyz"] as const);
  const bounds = expectArray(box.bounds, `${path}.box.bounds`);
  const expectedLength = layout === "xy" ? 4 : 6;
  if (bounds.length !== expectedLength) throw invalid(`${path}.box.bounds`, `must contain ${expectedLength} ordinates`);
  const numbers = bounds.map((entry, index) => expectFiniteNumber(entry, `${path}.box.bounds[${index}]`));
  const dimensions = expectedLength / 2;
  for (let index = 0; index < dimensions; index += 1) {
    if ((numbers[index] as number) > (numbers[index + dimensions] as number)) {
      throw invalid(`${path}.box.bounds`, "minimum ordinates must not exceed maximum ordinates");
    }
  }
  return {
    box: { layout, bounds: numbers },
    crs: parseExecutableCrsBinding(object.crs, `${path}.crs`) as unknown as JsonValue,
  };
}

function parseExecutableCrsBinding(value: JsonValue | undefined, path: string): ExecutableCrsBinding {
  try {
    return validateExecutableCrsBinding(value, path);
  } catch (error) {
    if (error instanceof HonuaQueryPlanningError) throw error;
    throw invalid(path, error instanceof TypeError ? error.message : "must be a valid executable CRS binding");
  }
}

function parseCanonicalGeometry(value: JsonValue | undefined, path: string, layout: string, depth: number): JsonObject {
  if (depth > 8) throw invalid(path, "exceeds the supported geometry collection depth");
  const object = expectObject(value, path);
  const type = expectEnum(object.type, `${path}.type`, [
    "Point",
    "MultiPoint",
    "LineString",
    "MultiLineString",
    "Polygon",
    "MultiPolygon",
    "GeometryCollection",
  ] as const);
  if (type === "GeometryCollection") {
    assertOnlyKeys(object, ["type", "geometries"], path);
    const geometries = expectArray(object.geometries, `${path}.geometries`);
    if (geometries.length === 0) throw invalid(`${path}.geometries`, "must not be empty");
    return {
      type,
      geometries: geometries.map((entry, index) =>
        parseCanonicalGeometry(entry, `${path}.geometries[${index}]`, layout, depth + 1),
      ),
    };
  }
  assertOnlyKeys(object, ["type", "coordinates"], path);
  const coordinateDepth =
    type === "Point"
      ? 1
      : type === "MultiPoint" || type === "LineString"
        ? 2
        : type === "MultiLineString" || type === "Polygon"
          ? 3
          : 4;
  const coordinates = parseCoordinates(object.coordinates, `${path}.coordinates`, coordinateDepth, layout);
  validateGeometryCardinality(type, coordinates, `${path}.coordinates`);
  return { type, coordinates };
}

function validateGeometryCardinality(type: string, coordinates: readonly JsonValue[], path: string): void {
  if (type === "LineString") {
    assertLine(coordinates, path);
    return;
  }
  if (type === "MultiLineString") {
    coordinates.forEach((line, index) => assertLine(line as readonly JsonValue[], `${path}[${index}]`));
    return;
  }
  if (type === "Polygon") {
    coordinates.forEach((ring, index) => assertRing(ring as readonly JsonValue[], `${path}[${index}]`));
    return;
  }
  if (type === "MultiPolygon") {
    coordinates.forEach((polygon, polygonIndex) =>
      (polygon as readonly JsonValue[]).forEach((ring, ringIndex) =>
        assertRing(ring as readonly JsonValue[], `${path}[${polygonIndex}][${ringIndex}]`),
      ),
    );
  }
}

function assertLine(line: readonly JsonValue[], path: string): void {
  if (line.length < 2) throw invalid(path, "must contain at least two positions");
}

function assertRing(ring: readonly JsonValue[], path: string): void {
  if (ring.length < 4) throw invalid(path, "must contain at least four positions");
  if (JSON.stringify(ring[0]) !== JSON.stringify(ring.at(-1))) throw invalid(path, "must be closed");
}

function parseCoordinates(
  value: JsonValue | undefined,
  path: string,
  depth: number,
  layout: string,
): readonly JsonValue[] {
  const array = expectArray(value, path);
  if (array.length === 0) throw invalid(path, "must not be empty");
  if (depth === 1) {
    const expected = layout === "xy" ? 2 : layout === "xyzm" ? 4 : 3;
    if (array.length !== expected) throw invalid(path, `must contain ${expected} ordinates for ${layout}`);
    return array.map((entry, index) => expectFiniteNumber(entry, `${path}[${index}]`));
  }
  return array.map((entry, index) => parseCoordinates(entry, `${path}[${index}]`, depth - 1, layout));
}

function parseDistance(value: JsonValue | undefined, path: string): DistanceOperand {
  const object = expectObject(value, path);
  assertOnlyKeys(object, ["value", "unit", "mode"], path);
  const distance = expectFiniteNumber(object.value, `${path}.value`);
  if (distance <= 0) throw invalid(`${path}.value`, "must be greater than zero");
  const unit = expectBoundedText(object.unit, `${path}.unit`);
  if (!DISTANCE_UNITS.has(unit)) throw invalid(`${path}.unit`, `has unsupported value ${unit}`);
  return {
    value: distance,
    unit: unit as DistanceOperand["unit"],
    mode: expectEnum(object.mode, `${path}.mode`, ["planar", "geodesic"] as const),
  };
}

function parseTemporalLiteral(value: JsonValue | undefined, path: string): TemporalLiteralNode {
  const object = expectObject(value, path);
  assertOnlyKeys(object, ["kind", "valueType", "value"], path);
  expectExact(object.kind, "temporal-literal", `${path}.kind`);
  const valueType = expectEnum(object.valueType, `${path}.valueType`, ["date", "instant", "interval"] as const);
  if (valueType === "interval") {
    const interval = expectArray(object.value, `${path}.value`);
    if (interval.length !== 2) throw invalid(`${path}.value`, "must contain exactly two temporal endpoints");
    const start = expectBoundedText(interval[0], `${path}.value[0]`);
    const end = expectBoundedText(interval[1], `${path}.value[1]`);
    const startKind = temporalEndpointKind(start);
    const endKind = temporalEndpointKind(end);
    if (!startKind) throw invalid(`${path}.value[0]`, "must be an RFC 3339 full-date or instant");
    if (!endKind) throw invalid(`${path}.value[1]`, "must be an RFC 3339 full-date or instant");
    if (startKind !== endKind) throw invalid(`${path}.value`, "endpoints must use the same temporal representation");
    const comparison = compareLogicalDomainValues(
      start,
      end,
      startKind === "date" ? RFC3339_DATE_TYPE : RFC3339_INSTANT_TYPE,
    );
    if (comparison === undefined) throw invalid(`${path}.value`, "endpoints cannot be ordered deterministically");
    if (comparison > 0) throw invalid(`${path}.value`, "start must not be after end");
    return { kind: "temporal-literal", valueType, value: [start, end] };
  }
  const text = expectBoundedText(object.value, `${path}.value`);
  if (valueType === "date") assertIsoDate(text, `${path}.value`);
  else assertIsoInstant(text, `${path}.value`);
  return { kind: "temporal-literal", valueType, value: text };
}

function parseNativeFilter(object: JsonObject, path: string): JsonObject {
  assertOnlyKeys(object, ["kind", "dialect", "payload"], path);
  const dialect = expectNonblankBoundedText(object.dialect, `${path}.dialect`);
  if (!isBuiltInDialect(dialect) && !EXTENSION_ID_PATTERN.test(dialect)) {
    throw invalid(`${path}.dialect`, "must be a built-in or namespaced extension dialect");
  }
  const payload = expectObject(object.payload, `${path}.payload`);
  const format = expectEnum(payload.format, `${path}.payload.format`, ["text", "xml", "json"] as const);
  if (format === "json") {
    assertOnlyKeys(payload, ["format", "value"], `${path}.payload`);
    if (!("value" in payload)) throw invalid(`${path}.payload.value`, "is required");
  } else {
    assertOnlyKeys(payload, ["format", "text"], `${path}.payload`);
    expectNonblankBoundedText(payload.text, `${path}.payload.text`);
  }
  if (NATIVE_JSON_DIALECTS.has(dialect) && format !== "json") {
    throw invalid(`${path}.payload.format`, `${dialect} requires json`);
  }
  if (dialect === "fes-2.0" && format !== "xml") throw invalid(`${path}.payload.format`, "fes-2.0 requires xml");
  if (NATIVE_TEXT_DIALECTS.has(dialect) && format !== "text") {
    throw invalid(`${path}.payload.format`, `${dialect} requires text`);
  }
  return { kind: "native", dialect, payload };
}

function parseSort(value: JsonValue, path: string): readonly SemanticSort<Record<string, unknown>>[] {
  const array = expectArray(value, path);
  return array.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const object = expectObject(entry, itemPath);
    assertOnlyKeys(object, ["field", "direction", "nulls"], itemPath);
    return {
      field: expectNonblankBoundedText(object.field, `${itemPath}.field`) as never,
      direction: expectEnum(object.direction, `${itemPath}.direction`, ["asc", "desc"] as const),
      nulls:
        object.nulls === undefined
          ? "native"
          : expectEnum(object.nulls, `${itemPath}.nulls`, ["first", "last", "native"] as const),
    };
  });
}

function parsePage(value: JsonValue, path: string): SemanticPageRequest {
  const object = expectObject(value, path);
  const kind = expectEnum(object.kind, `${path}.kind`, ["first", "offset"] as const);
  if (kind === "first") {
    assertOnlyKeys(object, ["kind", "limit"], path);
    return {
      kind,
      ...(object.limit === undefined ? {} : { limit: expectPositiveSafeInteger(object.limit, `${path}.limit`) }),
    };
  }
  assertOnlyKeys(object, ["kind", "offset", "limit"], path);
  return {
    kind,
    offset: expectNonnegativeSafeInteger(object.offset, `${path}.offset`),
    ...(object.limit === undefined ? {} : { limit: expectPositiveSafeInteger(object.limit, `${path}.limit`) }),
  };
}

function parseOutputCrs(value: JsonValue | undefined, path: string) {
  let definition: ReturnType<typeof validateSourceCrsDefinition>;
  try {
    definition = validateSourceCrsDefinition(value);
  } catch (error) {
    throw invalid(path, errorMessage(error));
  }
  if (definition.kind === "unknown") throw invalid(path, "must be resolved for execution");
  if (definition.kind === "wkt" && definition.validation !== "engine") {
    throw invalid(path, "WKT must be engine-validated for execution");
  }
  return definition;
}

function parseGeometryProjection(value: JsonValue, path: string): "include" | "omit" | { readonly field: string } {
  if (value === "include" || value === "omit") return value;
  const object = expectObject(value, path);
  assertOnlyKeys(object, ["field"], path);
  return { field: expectNonblankBoundedText(object.field, `${path}.field`) };
}

function parseMetrics(
  value: JsonValue | undefined,
  path: string,
): readonly [AggregateMetric<Record<string, unknown>>, ...AggregateMetric<Record<string, unknown>>[]] {
  const array = expectArray(value, path);
  if (array.length === 0) throw invalid(path, "must contain at least one metric");
  return array.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const object = expectObject(entry, itemPath);
    const fn = expectEnum(object.fn, `${itemPath}.fn`, [
      "count",
      "sum",
      "avg",
      "min",
      "max",
      "stddev",
      "variance",
    ] as const);
    assertOnlyKeys(object, ["fn", "field", "as"], itemPath);
    const alias = expectNonblankBoundedText(object.as, `${itemPath}.as`);
    if (fn === "count") {
      return {
        fn,
        ...(object.field === undefined ? {} : { field: expectNonblankBoundedText(object.field, `${itemPath}.field`) }),
        as: alias,
      };
    }
    return { fn, field: expectNonblankBoundedText(object.field, `${itemPath}.field`), as: alias };
  }) as never;
}

function validateParsedQuery(
  query: RuntimeQuery,
  schema: SourceSchemaV2 | undefined,
  protocol: SourceProtocol | undefined,
): void {
  if (query.filter?.kind === "native") validateNativeDialect(query.filter.dialect, protocol, "$.filter.dialect");
  else if (query.filter && schema) validateFilter(query.filter, schema, "$.filter");

  if (!schema) return;
  const spatiality = schemaSpatiality(schema);
  if (query.sort) {
    assertUnique(
      query.sort.map((sort) => sort.field),
      "$.sort",
      "sort field",
    );
    query.sort.forEach((sort, index) => {
      const field = schemaField(schema, sort.field, `$.sort[${index}].field`);
      assertTypeKind(field, ORDERED_TYPE_KINDS, `$.sort[${index}].field`, "orderable");
    });
  }
  if (query.outputCrs && spatiality === "non-spatial") {
    throw invalid("$.outputCrs", "is not valid for a non-spatial schema");
  }

  if (query.kind === "features") {
    if (query.select) {
      assertUnique(query.select, "$.select", "projection field");
      query.select.forEach((field, index) => schemaField(schema, field, `$.select[${index}]`));
    }
    validateGeometryProjection(query.geometry, query.select, schema, spatiality);
    return;
  }

  assertUnique(query.groupBy as readonly string[], "$.groupBy", "group field");
  query.groupBy.forEach((name, index) => {
    const field = schemaField(schema, name as string, `$.groupBy[${index}]`);
    assertTypeKind(field, SCALAR_TYPE_KINDS, `$.groupBy[${index}]`, "scalar/groupable");
  });
  const aliases = query.metrics.map((metric) => metric.as);
  assertUnique(aliases, "$.metrics", "metric alias");
  const groupNames = new Set(query.groupBy as readonly string[]);
  query.metrics.forEach((metric, index) => {
    if (groupNames.has(metric.as)) throw invalid(`$.metrics[${index}].as`, "must not collide with a group field");
    if (metric.fn === "count" && metric.field === undefined) return;
    const field = schemaField(schema, metric.field as string, `$.metrics[${index}].field`);
    const expected =
      metric.fn === "sum" || metric.fn === "avg" || metric.fn === "stddev" || metric.fn === "variance"
        ? NUMERIC_TYPE_KINDS
        : metric.fn === "count"
          ? undefined
          : ORDERED_TYPE_KINDS;
    if (expected)
      assertTypeKind(
        field,
        expected,
        `$.metrics[${index}].field`,
        metric.fn === "count" ? "field" : `${metric.fn}-compatible`,
      );
  });
}

function parseProtocolOption(value: unknown): SourceProtocol | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid("options.protocol", "must be a string");
  if (TEXT_ENCODER.encode(value).byteLength > MAX_SEMANTIC_QUERY_TEXT_BYTES) {
    throw invalid("options.protocol", "text is too large");
  }
  if (value.trim() === "") throw invalid("options.protocol", "must be a non-empty string");
  if (!PROTOCOLS.includes(value as (typeof PROTOCOLS)[number]) && !EXTENSION_ID_PATTERN.test(value)) {
    throw invalid("options.protocol", "must be a built-in or namespaced extension protocol");
  }
  return value as SourceProtocol;
}

function validateFilter(filter: RuntimeFilter, schema: SourceSchemaV2, path: string): void {
  switch (filter.kind) {
    case "comparison": {
      const field = schemaField(schema, filter.left.name, `${path}.left.name`);
      const allowed = filter.operator === "eq" || filter.operator === "ne" ? SCALAR_TYPE_KINDS : ORDERED_TYPE_KINDS;
      assertTypeKind(
        field,
        allowed,
        `${path}.left.name`,
        filter.operator === "eq" || filter.operator === "ne" ? "scalar" : "orderable",
      );
      validateLiteralForField(filter.right.value, field, `${path}.right.value`);
      return;
    }
    case "list": {
      const field = schemaField(schema, filter.operand.name, `${path}.operand.name`);
      assertTypeKind(field, SCALAR_TYPE_KINDS, `${path}.operand.name`, "scalar");
      filter.values.forEach((literal, index) =>
        validateLiteralForField(literal.value, field, `${path}.values[${index}].value`),
      );
      return;
    }
    case "range": {
      const field = schemaField(schema, filter.operand.name, `${path}.operand.name`);
      assertTypeKind(field, ORDERED_TYPE_KINDS, `${path}.operand.name`, "orderable");
      validateLiteralForField(filter.lower.value, field, `${path}.lower.value`);
      validateLiteralForField(filter.upper.value, field, `${path}.upper.value`);
      const comparison = compareLiteral(filter.lower.value, filter.upper.value, field.type);
      if (comparison === undefined) throw invalid(path, "range bounds cannot be ordered deterministically");
      if (comparison > 0) {
        throw invalid(path, "range lower bound must not exceed its upper bound");
      }
      return;
    }
    case "null":
      schemaField(schema, filter.operand.name, `${path}.operand.name`);
      return;
    case "pattern": {
      const field = schemaField(schema, filter.operand.name, `${path}.operand.name`);
      if (field.type.kind !== "string") throw invalid(`${path}.operand.name`, "must identify a string field");
      return;
    }
    case "boolean":
      filter.args.forEach((arg, index) => validateFilter(arg as never, schema, `${path}.args[${index}]`));
      return;
    case "not":
      validateFilter(filter.arg as never, schema, `${path}.arg`);
      return;
    case "spatial":
      validateSpatialFilter(filter, schema, path);
      return;
    case "temporal":
      validateTemporalFilter(filter, schema, path);
      return;
    case "native":
      return;
  }
}

function validateSpatialFilter(filter: RuntimeSpatialFilter, schema: SourceSchemaV2, path: string): void {
  if (schema.geometry.state === "none") throw invalid(path, "cannot target a non-spatial schema");
  const property = filter.property;
  let fieldName = property?.name;
  if (!fieldName && schema.geometry.state === "known" && schema.geometry.primaryField.state === "known") {
    fieldName = schema.geometry.primaryField.field;
  }
  if (!fieldName) throw invalid(`${path}.property`, "is required when the schema has no known primary geometry");
  const field = schemaField(schema, fieldName, `${path}.property.name`);
  if (field.type.kind !== "geometry") throw invalid(`${path}.property.name`, "must identify a geometry field");
  if (schema.geometry.state === "known" && !schema.geometry.fields.some((candidate) => candidate.field === fieldName)) {
    throw invalid(`${path}.property.name`, "is not declared by the source geometry schema");
  }
}

function validateTemporalFilter(filter: RuntimeTemporalFilter, schema: SourceSchemaV2, path: string): void {
  const operand = filter.operand;
  const field = schemaField(schema, operand.name, `${path}.operand.name`);
  const temporal = schema.temporal;
  const declared =
    temporal.state === "instant"
      ? [temporal.field]
      : temporal.state === "interval"
        ? [temporal.startField, temporal.endField]
        : temporal.state === "mixed"
          ? temporal.fields
          : [];
  const roleEligible = field.roles.some(
    (role) => role === "time-instant" || role === "time-start" || role === "time-end",
  );
  if (!declared.includes(field.name) && !roleEligible) {
    throw invalid(`${path}.operand.name`, "is not a schema-declared temporal field");
  }
  if (field.type.kind !== "date" && field.type.kind !== "timestamp") {
    throw invalid(`${path}.operand.name`, "must identify a date or timestamp field");
  }
  if (field.type.kind === "timestamp" && (field.type.timezone === "local" || field.type.timezone === "unknown")) {
    throw invalid(`${path}.operand.name`, "must have an unambiguous UTC or offset timestamp timezone");
  }
  const value = filter.value;
  if (field.type.kind === "date" && value.valueType === "instant") {
    throw invalid(`${path}.value.valueType`, "instant is incompatible with a date field");
  }
  if (field.type.kind === "timestamp" && value.valueType === "date") {
    throw invalid(`${path}.value.valueType`, "date is incompatible with a timestamp field");
  }
  if (value.valueType === "interval") {
    const endpointKind = temporalEndpointKind(value.value[0]);
    if (field.type.kind === "date" && endpointKind !== "date") {
      throw invalid(`${path}.value.value`, "date fields require full-date interval endpoints");
    }
    if (field.type.kind === "timestamp" && endpointKind !== "instant") {
      throw invalid(`${path}.value.value`, "timestamp fields require instant interval endpoints");
    }
    value.value.forEach((endpoint, index) => validateLiteralForField(endpoint, field, `${path}.value.value[${index}]`));
  } else {
    validateLiteralForField(value.value, field, `${path}.value.value`);
  }
  if ((filter.operator === "during" || filter.operator === "time-intersects") && value.valueType !== "interval") {
    throw invalid(`${path}.value.valueType`, `${filter.operator} requires an interval`);
  }
  if ((filter.operator === "before" || filter.operator === "after") && value.valueType === "interval") {
    throw invalid(`${path}.value.valueType`, `${filter.operator} requires one date or instant`);
  }
}

function validateGeometryProjection(
  geometry: "include" | "omit" | { readonly field: string } | undefined,
  select: readonly string[] | undefined,
  schema: SourceSchemaV2,
  spatiality: SourceSpatiality,
): void {
  if (geometry === undefined) return;
  if (geometry === "omit") return;
  if (geometry === "include") {
    if (spatiality === "non-spatial") throw invalid("$.geometry", "cannot include geometry for a non-spatial schema");
    if (spatiality === "ambiguous-geometry") throw invalid("$.geometry", "must name a geometry field for this schema");
    return;
  }
  const projection = geometry as { readonly field: string };
  const field = schemaField(schema, projection.field, "$.geometry.field");
  if (field.type.kind !== "geometry") throw invalid("$.geometry.field", "must identify a geometry field");
  if (select && !select.includes(projection.field)) throw invalid("$.geometry.field", "must also appear in select");
}

function validateNativeDialect(dialect: string, protocol: SourceProtocol | undefined, path: string): void {
  if (!protocol) return;
  const allowed = dialectsForProtocol(protocol);
  if (allowed === "extension") {
    if (!dialect.startsWith(`${protocol}.`) || !EXTENSION_ID_PATTERN.test(dialect)) {
      throw invalid(path, `does not belong to extension protocol ${protocol}`);
    }
    return;
  }
  if (!allowed.includes(dialect as BuiltInNativeDialect)) {
    throw invalid(path, `dialect ${dialect} is not valid for protocol ${protocol}`);
  }
}

function dialectsForProtocol(protocol: SourceProtocol): readonly BuiltInNativeDialect[] | "extension" {
  switch (protocol) {
    case "grpc":
      return ["honua-grpc"];
    case "geoservices-feature-service":
    case "geoservices-map-service":
    case "geoservices-image-service":
      return ["geoservices-sql92"];
    case "ogc-features":
    case "ogc-records":
    case "stac":
      return ["cql2-json", "cql2-text"];
    case "wfs":
      return ["fes-2.0"];
    case "odata":
      return ["odata-4.0"];
    case "geoparquet":
      return ["duckdb-sql"];
    default:
      return EXTENSION_ID_PATTERN.test(protocol) ? "extension" : [];
  }
}

function schemaSpatiality(schema: SourceSchemaV2): SourceSpatiality {
  if (schema.geometry.state === "none") return "non-spatial";
  if (schema.geometry.state === "known" && schema.geometry.primaryField.state === "known") return "primary-geometry";
  return "ambiguous-geometry";
}

function schemaField(schema: SourceSchemaV2, name: string, path: string): LogicalField {
  const field = schema.fields.find((candidate) => candidate.name === name);
  if (!field) throw invalid(path, `references unknown schema field ${JSON.stringify(name)}`);
  return field;
}

function assertTypeKind(field: LogicalField, allowed: ReadonlySet<string>, path: string, expected: string): void {
  if (!allowed.has(field.type.kind)) throw invalid(path, `field ${field.name} is ${field.type.kind}, not ${expected}`);
}

function validateLiteralForField(value: JsonValue, field: LogicalField, path: string): void {
  const type = field.type;
  if (!literalMatchesType(value, type)) throw invalid(path, `is incompatible with ${field.name}:${type.kind}`);
  if (
    typeof value === "string" &&
    type.kind === "string" &&
    type.maxLength !== undefined &&
    value.length > type.maxLength
  ) {
    throw invalid(path, `exceeds ${field.name}'s maximum length ${type.maxLength}`);
  }
  if (field.domain.state === "coded" && field.domain.openness === "closed") {
    if (!field.domain.values.some((entry) => Object.is(entry.value, value))) {
      throw invalid(path, `is outside ${field.name}'s closed coded domain`);
    }
  }
  if (field.domain.state === "range") {
    if (field.domain.minimum) {
      const comparison = compareLiteral(value, field.domain.minimum.value, type);
      if (comparison === undefined) throw invalid(path, `cannot be ordered against ${field.name}'s declared minimum`);
      if (comparison < (field.domain.minimum.inclusive ? 0 : 1)) {
        throw invalid(path, `is below ${field.name}'s declared minimum`);
      }
    }
    if (field.domain.maximum) {
      const comparison = compareLiteral(value, field.domain.maximum.value, type);
      if (comparison === undefined) throw invalid(path, `cannot be ordered against ${field.name}'s declared maximum`);
      if (comparison > (field.domain.maximum.inclusive ? 0 : -1)) {
        throw invalid(path, `is above ${field.name}'s declared maximum`);
      }
    }
  }
  if (field.constraints.state === "known" || field.constraints.state === "partial") {
    // ECMA-262 patterns are declarative schema metadata, not trusted client
    // code. Semantic admission deliberately leaves them to the adapter/server
    // instead of executing a potentially backtracking expression on caller
    // input. The remaining constraints are deterministic and bounded here.
    for (const constraint of field.constraints.values) {
      if (constraint.kind === "length" && typeof value === "string") {
        if (constraint.minimum !== undefined && value.length < constraint.minimum) {
          throw invalid(path, `is shorter than ${field.name}'s minimum length ${constraint.minimum}`);
        }
        if (constraint.maximum !== undefined && value.length > constraint.maximum) {
          throw invalid(path, `exceeds ${field.name}'s maximum length ${constraint.maximum}`);
        }
      } else if (constraint.kind === "multiple-of") {
        if (!literalMatchesMultipleOf(value, type, constraint.value)) {
          throw invalid(path, `is not a multiple of ${field.name}'s declared step ${constraint.value}`);
        }
      }
    }
  }
}

function literalMatchesType(value: JsonValue, type: LogicalType): boolean {
  return isLogicalDomainValueCompatible(value, type);
}

function literalMatchesMultipleOf(value: JsonValue, type: LogicalType, step: number): boolean {
  if (
    typeof value === "string" &&
    (type.kind === "integer" || type.kind === "decimal") &&
    type.jsonEncoding === "string"
  ) {
    return exactDecimalMultiple(value, step);
  }
  if (typeof value !== "number") return false;
  const quotient = value / step;
  return Math.abs(quotient - Math.round(quotient)) <= Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8;
}

function exactDecimalMultiple(value: string, step: number): boolean {
  const candidate = decimalIntegerRatio(value);
  const divisor = decimalIntegerRatio(String(step));
  if (!candidate || !divisor || divisor.coefficient === 0n) return false;
  if (candidate.coefficient === 0n) return true;
  const scaleDelta = divisor.scale - candidate.scale;
  if (scaleDelta >= 0) {
    return (candidate.coefficient * 10n ** BigInt(scaleDelta)) % divisor.coefficient === 0n;
  }
  return candidate.coefficient % (divisor.coefficient * 10n ** BigInt(-scaleDelta)) === 0n;
}

function decimalIntegerRatio(value: string): { readonly coefficient: bigint; readonly scale: number } | undefined {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match) return undefined;
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent)) return undefined;
  const digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "") || "0";
  let coefficient = BigInt(digits);
  let scale = (match[3]?.length ?? 0) - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function compareLiteral(left: JsonValue, right: JsonValue, type: LogicalType): number | undefined {
  return compareLogicalDomainValues(left, right, type);
}

function parseBoundedJson(value: string | unknown): JsonValue {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (TEXT_ENCODER.encode(value).byteLength > MAX_SEMANTIC_QUERY_BYTES) {
      throw invalid("$", `exceeds the ${MAX_SEMANTIC_QUERY_BYTES}-byte bound`);
    }
    assertUniqueJsonObjectNames(value);
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (error) {
      throw invalid("$", `is not valid JSON: ${errorMessage(error)}`);
    }
  }
  const state: BoundedJsonState = { nodes: 0, bytes: 0, ancestors: new WeakSet<object>() };
  const json = cloneBoundedJson(parsed, "$", 0, state);
  if (TEXT_ENCODER.encode(JSON.stringify(json)).byteLength > MAX_SEMANTIC_QUERY_BYTES) {
    throw invalid("$", `exceeds the ${MAX_SEMANTIC_QUERY_BYTES}-byte bound`);
  }
  return json;
}

function cloneBoundedJson(value: unknown, path: string, depth: number, state: BoundedJsonState): JsonValue {
  state.nodes += 1;
  consumeJsonBytes(state, 1, path);
  if (state.nodes > MAX_SEMANTIC_QUERY_NODES) throw invalid(path, "exceeds the semantic query node bound");
  if (depth > MAX_SEMANTIC_QUERY_DEPTH) throw invalid(path, "exceeds the semantic query depth bound");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const byteLength = TEXT_ENCODER.encode(value).byteLength;
    if (byteLength > MAX_SEMANTIC_QUERY_TEXT_BYTES) throw invalid(path, "text is too large");
    consumeJsonBytes(state, byteLength + 2, path);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid(path, "must be a finite number");
    consumeJsonBytes(state, String(value).length, path);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw invalid(path, `contains unsupported ${typeof value}`);
  if (state.ancestors.has(value)) throw invalid(path, "must not contain cycles");
  state.ancestors.add(value);
  try {
    if (safeIsArray(value, path)) {
      const lengthDescriptor = safeOwnPropertyDescriptor(value, "length", path);
      if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
        throw invalid(path, "must have an ordinary array length");
      }
      const length = lengthDescriptor.value as number;
      if (length > MAX_SEMANTIC_QUERY_COLLECTION_ITEMS) throw invalid(path, "array is too large");
      for (const key of safeOwnKeys(value, path)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !isCanonicalArrayIndex(key, length)) {
          throw invalid(path, "array must not contain symbol, extra, or non-JSON properties");
        }
      }
      const out: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = safeOwnPropertyDescriptor(value, String(index), `${path}[${index}]`);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw invalid(`${path}[${index}]`, "must be an enumerable own data value");
        }
        out.push(cloneBoundedJson(descriptor.value, `${path}[${index}]`, depth + 1, state));
      }
      return out;
    }
    const prototype = safeGetPrototypeOf(value, path);
    if (prototype !== Object.prototype && prototype !== null) throw invalid(path, "must be a plain JSON object");
    const ownKeys = safeOwnKeys(value, path);
    if (ownKeys.some((key) => typeof key === "symbol")) throw invalid(path, "must not contain symbol properties");
    const keys = ownKeys as string[];
    if (keys.length > MAX_SEMANTIC_QUERY_COLLECTION_ITEMS) throw invalid(path, "object has too many properties");
    const out: Record<string, JsonValue> = {};
    for (const key of keys) {
      const keyBytes = TEXT_ENCODER.encode(key).byteLength;
      if (keyBytes > MAX_SEMANTIC_QUERY_TEXT_BYTES) throw invalid(`${path}.${key}`, "property name is too large");
      consumeJsonBytes(state, keyBytes + 3, `${path}.${key}`);
      const descriptor = safeOwnPropertyDescriptor(value, key, `${path}.${key}`);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw invalid(`${path}.${key}`, "must be an enumerable own data value");
      }
      Object.defineProperty(out, key, {
        value: cloneBoundedJson(descriptor.value, `${path}.${key}`, depth + 1, state),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    state.ancestors.delete(value);
  }
}

function safeIsArray(value: object, path: string): boolean {
  try {
    return Array.isArray(value);
  } catch {
    throw invalid(path, "could not be inspected safely as JSON data");
  }
}

function safeGetPrototypeOf(value: object, path: string): object | null {
  try {
    return Object.getPrototypeOf(value) as object | null;
  } catch {
    throw invalid(path, "could not be inspected safely as JSON data");
  }
}

function safeOwnKeys(value: object, path: string): readonly PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw invalid(path, "could not be inspected safely as JSON data");
  }
}

function safeOwnPropertyDescriptor(value: object, key: PropertyKey, path: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw invalid(path, "could not be inspected safely as JSON data");
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (key.length === 0) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

interface JsonNameScanState {
  readonly text: string;
  index: number;
}

/** JSON.parse keeps the last duplicate object member; reject ambiguity first. */
function assertUniqueJsonObjectNames(text: string): void {
  const state: JsonNameScanState = { text, index: 0 };
  scanJsonValue(state, "$", 0);
  skipJsonWhitespace(state);
  if (state.index !== text.length) throw invalid("$", "is not valid JSON");
}

function scanJsonValue(state: JsonNameScanState, path: string, depth: number): void {
  if (depth > MAX_SEMANTIC_QUERY_DEPTH) throw invalid(path, "exceeds the semantic query depth bound");
  skipJsonWhitespace(state);
  const character = state.text[state.index];
  if (character === "{") {
    scanJsonObject(state, path, depth);
    return;
  }
  if (character === "[") {
    scanJsonArray(state, path, depth);
    return;
  }
  if (character === '"') {
    scanJsonString(state);
    return;
  }
  if (character === "t") {
    scanJsonKeyword(state, "true");
    return;
  }
  if (character === "f") {
    scanJsonKeyword(state, "false");
    return;
  }
  if (character === "n") {
    scanJsonKeyword(state, "null");
    return;
  }
  scanJsonNumber(state);
}

function scanJsonObject(state: JsonNameScanState, path: string, depth: number): void {
  state.index += 1;
  skipJsonWhitespace(state);
  if (state.text[state.index] === "}") {
    state.index += 1;
    return;
  }
  const names = new Set<string>();
  while (state.index < state.text.length) {
    skipJsonWhitespace(state);
    if (state.text[state.index] !== '"') throw invalid(path, "is not valid JSON");
    const name = scanJsonString(state);
    if (names.has(name)) throw invalid(path, `contains duplicate object name ${JSON.stringify(name)}`);
    names.add(name);
    skipJsonWhitespace(state);
    if (state.text[state.index] !== ":") throw invalid(path, "is not valid JSON");
    state.index += 1;
    scanJsonValue(state, `${path}.${name}`, depth + 1);
    skipJsonWhitespace(state);
    const delimiter = state.text[state.index];
    if (delimiter === "}") {
      state.index += 1;
      return;
    }
    if (delimiter !== ",") throw invalid(path, "is not valid JSON");
    state.index += 1;
  }
  throw invalid(path, "is not valid JSON");
}

function scanJsonArray(state: JsonNameScanState, path: string, depth: number): void {
  state.index += 1;
  skipJsonWhitespace(state);
  if (state.text[state.index] === "]") {
    state.index += 1;
    return;
  }
  let index = 0;
  while (state.index < state.text.length) {
    scanJsonValue(state, `${path}[${index}]`, depth + 1);
    index += 1;
    skipJsonWhitespace(state);
    const delimiter = state.text[state.index];
    if (delimiter === "]") {
      state.index += 1;
      return;
    }
    if (delimiter !== ",") throw invalid(path, "is not valid JSON");
    state.index += 1;
  }
  throw invalid(path, "is not valid JSON");
}

function scanJsonString(state: JsonNameScanState): string {
  const start = state.index;
  state.index += 1;
  while (state.index < state.text.length) {
    const code = state.text.charCodeAt(state.index);
    if (code <= 0x1f) throw invalid("$", "is not valid JSON");
    const character = state.text[state.index];
    if (character === '"') {
      state.index += 1;
      return JSON.parse(state.text.slice(start, state.index)) as string;
    }
    if (character === "\\") {
      state.index += 1;
      const escapeCode = state.text[state.index];
      if (escapeCode === "u") {
        const digits = state.text.slice(state.index + 1, state.index + 5);
        if (digits.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(digits)) throw invalid("$", "is not valid JSON");
        state.index += 5;
        continue;
      }
      if (escapeCode === undefined || !'"\\/bfnrt'.includes(escapeCode)) throw invalid("$", "is not valid JSON");
    }
    state.index += 1;
  }
  throw invalid("$", "is not valid JSON");
}

function scanJsonKeyword(state: JsonNameScanState, keyword: "true" | "false" | "null"): void {
  if (state.text.slice(state.index, state.index + keyword.length) !== keyword) throw invalid("$", "is not valid JSON");
  state.index += keyword.length;
}

function scanJsonNumber(state: JsonNameScanState): void {
  const start = state.index;
  if (state.text[state.index] === "-") state.index += 1;
  if (state.text[state.index] === "0") {
    state.index += 1;
  } else {
    if (!isJsonDigit(state.text[state.index], false)) throw invalid("$", "is not valid JSON");
    while (isJsonDigit(state.text[state.index], true)) state.index += 1;
  }
  if (state.text[state.index] === ".") {
    state.index += 1;
    if (!isJsonDigit(state.text[state.index], true)) throw invalid("$", "is not valid JSON");
    while (isJsonDigit(state.text[state.index], true)) state.index += 1;
  }
  if (state.text[state.index] === "e" || state.text[state.index] === "E") {
    state.index += 1;
    if (state.text[state.index] === "+" || state.text[state.index] === "-") state.index += 1;
    if (!isJsonDigit(state.text[state.index], true)) throw invalid("$", "is not valid JSON");
    while (isJsonDigit(state.text[state.index], true)) state.index += 1;
  }
  if (state.index === start) throw invalid("$", "is not valid JSON");
}

function isJsonDigit(value: string | undefined, allowZero: boolean): boolean {
  if (value === undefined) return false;
  const code = value.charCodeAt(0);
  return code >= (allowZero ? 0x30 : 0x31) && code <= 0x39;
}

function skipJsonWhitespace(state: JsonNameScanState): void {
  while (state.index < state.text.length) {
    const code = state.text.charCodeAt(state.index);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
    state.index += 1;
  }
}

function consumeJsonBytes(state: BoundedJsonState, amount: number, path: string): void {
  state.bytes += amount;
  if (state.bytes > MAX_SEMANTIC_QUERY_BYTES) {
    throw invalid(path, `exceeds the ${MAX_SEMANTIC_QUERY_BYTES}-byte bound`);
  }
}

function node<T>(value: T): T {
  return deepFreeze(parseBoundedJson(value) as unknown as T);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function expectObject(value: JsonValue | undefined, path: string): JsonObject {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") {
    throw invalid(path, "must be an object");
  }
  return value as JsonObject;
}

function expectArray(value: JsonValue | undefined, path: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw invalid(path, "must be an array");
  if (value.length > MAX_SEMANTIC_QUERY_COLLECTION_ITEMS) throw invalid(path, "array is too large");
  return value;
}

function expectString(value: JsonValue | undefined, path: string): string {
  if (typeof value !== "string") throw invalid(path, "must be a string");
  return value;
}

function expectBoundedText(value: JsonValue | undefined, path: string): string {
  const text = expectString(value, path);
  if (TEXT_ENCODER.encode(text).byteLength > MAX_SEMANTIC_QUERY_TEXT_BYTES) throw invalid(path, "text is too large");
  return text;
}

function expectNonblankBoundedText(value: JsonValue | undefined, path: string): string {
  const text = expectBoundedText(value, path);
  if (text.trim() === "") throw invalid(path, "must be a non-empty string");
  return text;
}

function expectBoolean(value: JsonValue | undefined, path: string): boolean {
  if (typeof value !== "boolean") throw invalid(path, "must be a boolean");
  return value;
}

function expectFiniteNumber(value: JsonValue | undefined, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(path, "must be a finite number");
  return value;
}

function expectPositiveSafeInteger(value: JsonValue | undefined, path: string): number {
  const number = expectFiniteNumber(value, path);
  if (!Number.isSafeInteger(number) || number <= 0) throw invalid(path, "must be a positive safe integer");
  return number;
}

function expectNonnegativeSafeInteger(value: JsonValue | undefined, path: string): number {
  const number = expectFiniteNumber(value, path);
  if (!Number.isSafeInteger(number) || number < 0) throw invalid(path, "must be a nonnegative safe integer");
  return number;
}

function expectEnum<const TValues extends readonly string[]>(
  value: JsonValue | undefined,
  path: string,
  values: TValues,
): TValues[number] {
  const text = expectString(value, path);
  if (!values.includes(text)) throw invalid(path, `must be one of ${values.join(", ")}`);
  return text as TValues[number];
}

function expectExact(value: JsonValue | undefined, expected: string, path: string): void {
  if (value !== expected) throw invalid(path, `must be ${JSON.stringify(expected)}`);
}

function parseStringArray(value: JsonValue | undefined, path: string, requireNonempty: boolean): readonly string[] {
  const array = expectArray(value, path);
  if (requireNonempty && array.length === 0) throw invalid(path, "must contain at least one field");
  return array.map((entry, index) => expectNonblankBoundedText(entry, `${path}[${index}]`));
}

function assertOnlyKeys(object: JsonObject, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(object).find((key) => !allowedSet.has(key));
  if (unexpected) throw invalid(`${path}.${unexpected}`, "is not part of the semantic query contract");
}

function assertUnique(values: readonly string[], path: string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw invalid(path, `contains duplicate ${label} ${JSON.stringify(value)}`);
    seen.add(value);
  }
}

function assertIsoDate(value: string, path: string): void {
  if (!isIsoDate(value)) throw invalid(path, "must be an RFC 3339 full-date");
}

function assertIsoInstant(value: string, path: string): void {
  if (!isIsoInstant(value)) throw invalid(path, "must be an RFC 3339 instant with an explicit offset");
}

function temporalEndpointKind(value: string): "date" | "instant" | undefined {
  if (isIsoDate(value)) return "date";
  if (isIsoInstant(value)) return "instant";
  return undefined;
}

function isIsoDate(value: string): boolean {
  return isLogicalDomainValueCompatible(value, RFC3339_DATE_TYPE);
}

function isIsoInstant(value: string): boolean {
  return isLogicalDomainValueCompatible(value, RFC3339_INSTANT_TYPE);
}

function isBuiltInDialect(value: string): value is BuiltInNativeDialect {
  return BUILT_IN_DIALECTS.has(value as BuiltInNativeDialect);
}

function isLiteralNode(value: JsonValue | LiteralNode): value is LiteralNode {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { readonly kind?: unknown }).kind === "literal" &&
    Object.hasOwn(value, "value")
  );
}

function invalid(path: string, message: string): HonuaQueryPlanningError {
  return new HonuaQueryPlanningError("invalid-query", `${path} ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
