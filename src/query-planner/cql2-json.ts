import {
  type ExecutableCrsBinding,
  type JsonValue,
  type LogicalField,
  type SourceProtocol,
  type SourceSchemaV2,
  parseSourceSchemaV2,
  validateExecutableCrsBinding,
} from "../contract/schema.js";
import { canonicalStringify, toJsonValue } from "./canonical.js";
import type {
  Cql2JsonExpression,
  Cql2JsonInterchangeOptions,
  QueryFilter,
  SemanticFilter,
  SourceSpatiality,
  TemporalLiteralNode,
} from "./semantic-types.js";
import { MAX_SEMANTIC_QUERY_DEPTH, parseBoundedSemanticJson, parseSemanticQuery } from "./semantic.js";
import { HonuaQueryPlanningError } from "./types.js";

type RuntimeFilter = QueryFilter<Record<string, unknown>, SourceProtocol, SourceSpatiality>;
type RuntimeSemanticFilter = SemanticFilter<Record<string, unknown>, SourceSpatiality>;
type JsonObject = { readonly [key: string]: JsonValue };

interface Cql2Context {
  readonly schema?: SourceSchemaV2;
  readonly filterCrs?: ExecutableCrsBinding;
  readonly protocol?: SourceProtocol;
}

const COMPARISON_TO_CQL2 = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
} as const;

const CQL2_TO_COMPARISON = {
  "=": "eq",
  "<>": "ne",
  "<": "lt",
  "<=": "lte",
  ">": "gt",
  ">=": "gte",
} as const;

const SPATIAL_TO_CQL2 = {
  equals: "s_equals",
  intersects: "s_intersects",
  within: "s_within",
  contains: "s_contains",
  disjoint: "s_disjoint",
  touches: "s_touches",
  overlaps: "s_overlaps",
  crosses: "s_crosses",
} as const;

const CQL2_TO_SPATIAL = {
  s_equals: "equals",
  s_intersects: "intersects",
  s_within: "within",
  s_contains: "contains",
  s_disjoint: "disjoint",
  s_touches: "touches",
  s_overlaps: "overlaps",
  s_crosses: "crosses",
} as const;

const TEMPORAL_TO_CQL2 = {
  before: "t_before",
  after: "t_after",
  during: "t_during",
  "time-intersects": "t_intersects",
} as const;

const CQL2_TO_TEMPORAL = {
  t_before: "before",
  t_after: "after",
  t_during: "during",
  t_intersects: "time-intersects",
} as const;

// Annex C's normative CQL2 JSON schema declares GeometryCollection
// `geometries` with minItems: 2. Enforce that in both directions even though
// the broader semantic/GeoJSON model also admits a single member.
const MIN_CQL2_GEOMETRY_COLLECTION_ITEMS = 2;
const CQL2_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CQL2_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Export the CQL2-representable semantic-filter subset. CQL2 carries spatial
 * CRS outside the expression, so every spatial export requires `filterCrs`
 * and verifies that each operand uses that exact executable binding.
 */
export function semanticFilterToCql2Json<
  TRecord,
  TProtocol extends SourceProtocol,
  TSpatiality extends SourceSpatiality,
>(filter: QueryFilter<TRecord, TProtocol, TSpatiality>, options: Cql2JsonInterchangeOptions = {}): Cql2JsonExpression {
  const context = cql2Context(options);
  const query = parseSemanticQuery(
    { kind: "features", filter },
    {
      ...(context.schema ? { schema: context.schema } : {}),
      ...(context.protocol !== undefined ? { protocol: context.protocol } : {}),
    },
  );
  if (!query.filter) throw cql2Invalid("$", "requires a filter");
  const encoded = exportFilter(query.filter, context, "$", 0);
  return parseBoundedSemanticJson(encoded) as unknown as Cql2JsonExpression;
}

/**
 * Import the strict CQL2 JSON subset into the same runtime-validated semantic
 * AST used by builders. Unknown functions, property-property comparisons,
 * distance extensions, and other non-representable constructs fail closed.
 */
export function semanticFilterFromCql2Json(
  value: string | unknown,
  options: Cql2JsonInterchangeOptions = {},
): RuntimeFilter {
  const json = parseBoundedSemanticJson(value);
  const context = cql2Context(options);
  const filter = importFilter(json, context, "$", 0);
  const query = parseSemanticQuery(
    { kind: "features", filter },
    {
      ...(context.schema ? { schema: context.schema } : {}),
      ...(context.protocol !== undefined ? { protocol: context.protocol } : {}),
    },
  );
  if (!query.filter) throw cql2Invalid("$", "requires a filter");
  return query.filter;
}

function exportFilter(filter: RuntimeFilter, context: Cql2Context, path: string, depth: number): JsonObject {
  if (depth > MAX_SEMANTIC_QUERY_DEPTH) throw cql2Invalid(path, "exceeds the expression depth bound");
  switch (filter.kind) {
    case "comparison": {
      const field = schemaField(context.schema, filter.left.name);
      return {
        op: COMPARISON_TO_CQL2[filter.operator],
        args: [{ property: filter.left.name }, exportLiteral(filter.right.value, field, `${path}.args[1]`)],
      };
    }
    case "boolean":
      if (filter.args.length < 2) throw cql2Unsupported(path, "CQL2 and/or requires at least two operands");
      return {
        op: filter.operator,
        args: filter.args.map((entry, index) => exportFilter(entry, context, `${path}.args[${index}]`, depth + 1)),
      };
    case "not":
      return { op: "not", args: [exportFilter(filter.arg, context, `${path}.args[0]`, depth + 1)] };
    case "null": {
      const isNull = { op: "isNull", args: [{ property: filter.operand.name }] } as const;
      return filter.operator === "is-null" ? isNull : { op: "not", args: [isNull] };
    }
    case "list": {
      const field = schemaField(context.schema, filter.operand.name);
      return {
        op: "in",
        args: [
          { property: filter.operand.name },
          filter.values.map((entry, index) => exportLiteral(entry.value, field, `${path}.args[1][${index}]`)),
        ],
      };
    }
    case "range": {
      if (typeof filter.lower.value !== "number" || typeof filter.upper.value !== "number") {
        throw cql2Unsupported(path, "CQL2 between represents only numeric bounds in the supported subset");
      }
      return {
        op: "between",
        args: [{ property: filter.operand.name }, filter.lower.value, filter.upper.value],
      };
    }
    case "pattern": {
      const property: JsonValue = { property: filter.operand.name };
      if (filter.caseSensitive === false) {
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
      return exportSpatial(filter, context, path);
    case "temporal":
      return {
        op: TEMPORAL_TO_CQL2[filter.operator],
        args: [{ property: filter.operand.name }, exportTemporalLiteral(filter.value, `${path}.args[1]`)],
      };
    case "native":
      throw cql2Unsupported(path, "native expressions are dialect escape hatches, not semantic CQL2 nodes");
  }
}

function exportSpatial(
  filter: Extract<RuntimeSemanticFilter, { readonly kind: "spatial" }>,
  context: Cql2Context,
  path: string,
): JsonObject {
  const property = filter.property?.name ?? primaryGeometryField(context.schema, path);
  const propertyRef = { property } as const;
  if (filter.operator === "bbox-intersects") {
    assertFilterCrs(filter.bbox.crs, context, path);
    return { op: "s_intersects", args: [propertyRef, { bbox: [...filter.bbox.box.bounds] }] };
  }
  if (filter.operator === "within-distance" || filter.operator === "beyond-distance") {
    throw cql2Unsupported(path, "distance predicates are outside standard CQL2 1.0");
  }
  if (filter.geometry.layout !== "xy" && filter.geometry.layout !== "xyz") {
    throw cql2Unsupported(path, "CQL2 GeoJSON literals cannot preserve measured coordinate layouts");
  }
  assertFilterCrs(filter.geometry.crs, context, path);
  assertCql2GeometryCollectionCardinality(filter.geometry.geometry as unknown as JsonObject, `${path}.args[1]`);
  return {
    op: SPATIAL_TO_CQL2[filter.operator],
    args: [propertyRef, toJsonValue(filter.geometry.geometry)],
  };
}

function exportLiteral(value: JsonValue, field: LogicalField | undefined, path: string): JsonValue {
  if (field?.type.kind === "date") {
    if (typeof value !== "string") throw cql2Unsupported(path, "date values require their string encoding");
    if (!CQL2_DATE.test(value)) throw cql2Unsupported(path, "date values require the CQL2 full-date form");
    return { date: value };
  }
  if (field?.type.kind === "timestamp") {
    if (typeof value !== "string") throw cql2Unsupported(path, "timestamp values require their string encoding");
    if (!CQL2_TIMESTAMP.test(value)) {
      throw cql2Unsupported(path, "timestamp values require the CQL2 UTC Z form");
    }
    return { timestamp: value };
  }
  if (
    (field?.type.kind === "decimal" && field.type.jsonEncoding === "string") ||
    (field?.type.kind === "integer" && field.type.jsonEncoding === "string")
  ) {
    throw cql2Unsupported(path, "CQL2 JSON numbers cannot preserve string-encoded numeric precision");
  }
  if (value === null || Array.isArray(value) || typeof value === "object") {
    throw cql2Unsupported(path, "the supported CQL2 scalar subset accepts only string, number, or boolean literals");
  }
  return value;
}

function exportTemporalLiteral(value: TemporalLiteralNode, path: string): JsonObject {
  if (value.valueType === "interval") {
    return {
      interval: value.value.map((entry, index) => exportTemporalEndpoint(entry, `${path}.interval[${index}]`)),
    };
  }
  if (value.valueType === "date") {
    if (!CQL2_DATE.test(value.value)) throw cql2Unsupported(path, "date values require the CQL2 full-date form");
    return { date: value.value };
  }
  if (!CQL2_TIMESTAMP.test(value.value)) {
    throw cql2Unsupported(path, "timestamp values require the CQL2 UTC Z form");
  }
  return { timestamp: value.value };
}

function exportTemporalEndpoint(value: string, path: string): string {
  if (CQL2_DATE.test(value) || CQL2_TIMESTAMP.test(value)) return value;
  throw cql2Unsupported(path, "requires a CQL2 full-date or UTC Z timestamp");
}

function importFilter(value: JsonValue, context: Cql2Context, path: string, depth: number): RuntimeSemanticFilter {
  if (depth > MAX_SEMANTIC_QUERY_DEPTH) throw cql2Invalid(path, "exceeds the expression depth bound");
  const object = exactObject(value, path, ["op", "args"]);
  const op = text(object.op, `${path}.op`);
  const args = array(object.args, `${path}.args`);

  if (op === "and" || op === "or") {
    if (args.length < 2) throw cql2Invalid(`${path}.args`, "must contain at least two expressions");
    const parsedArgs = [
      importFilter(args[0] as JsonValue, context, `${path}.args[0]`, depth + 1),
      ...args.slice(1).map((entry, index) => importFilter(entry, context, `${path}.args[${index + 1}]`, depth + 1)),
    ] as const;
    return {
      kind: "boolean",
      operator: op,
      args: parsedArgs,
    } as RuntimeSemanticFilter;
  }
  if (op === "not") {
    exactLength(args, 1, `${path}.args`);
    const inner = importFilter(args[0] as JsonValue, context, `${path}.args[0]`, depth + 1);
    if (inner.kind === "null" && inner.operator === "is-null") {
      return { ...inner, operator: "is-not-null" } as RuntimeSemanticFilter;
    }
    return { kind: "not", arg: inner } as RuntimeSemanticFilter;
  }
  if (hasOwn(CQL2_TO_COMPARISON, op)) {
    exactLength(args, 2, `${path}.args`);
    const property = importProperty(args[0] as JsonValue, `${path}.args[0]`);
    const literal = importLiteral(args[1] as JsonValue, schemaField(context.schema, property.name), `${path}.args[1]`);
    return {
      kind: "comparison",
      operator: CQL2_TO_COMPARISON[op],
      left: property,
      right: literal,
    } as RuntimeSemanticFilter;
  }
  if (op === "isNull") {
    exactLength(args, 1, `${path}.args`);
    return {
      kind: "null",
      operator: "is-null",
      operand: importProperty(args[0] as JsonValue, `${path}.args[0]`),
    } as RuntimeSemanticFilter;
  }
  if (op === "in") {
    exactLength(args, 2, `${path}.args`);
    const property = importProperty(args[0] as JsonValue, `${path}.args[0]`);
    const values = array(args[1] as JsonValue, `${path}.args[1]`);
    if (values.length === 0) throw cql2Invalid(`${path}.args[1]`, "must not be empty");
    const field = schemaField(context.schema, property.name);
    const parsedValues = [
      importLiteral(values[0] as JsonValue, field, `${path}.args[1][0]`),
      ...values.slice(1).map((entry, index) => importLiteral(entry, field, `${path}.args[1][${index + 1}]`)),
    ] as const;
    return {
      kind: "list",
      operator: "in",
      operand: property,
      values: parsedValues,
    } as RuntimeSemanticFilter;
  }
  if (op === "between") {
    exactLength(args, 3, `${path}.args`);
    const property = importProperty(args[0] as JsonValue, `${path}.args[0]`);
    if (typeof args[1] !== "number" || typeof args[2] !== "number") {
      throw cql2Unsupported(path, "the supported between form requires numeric literal bounds");
    }
    return {
      kind: "range",
      operator: "between",
      operand: property,
      lower: { kind: "literal", value: args[1] },
      upper: { kind: "literal", value: args[2] },
    } as RuntimeSemanticFilter;
  }
  if (op === "like") return importLike(args, path);
  if (hasOwn(CQL2_TO_SPATIAL, op)) return importSpatial(op, args, context, path);
  if (hasOwn(CQL2_TO_TEMPORAL, op)) return importTemporal(op, args, path);
  throw cql2Unsupported(`${path}.op`, "uses an unsupported CQL2 function or operator");
}

function importLike(args: readonly JsonValue[], path: string): RuntimeSemanticFilter {
  exactLength(args, 2, `${path}.args`);
  const leftCaseInsensitive = isOperation(args[0], "casei");
  const rightCaseInsensitive = isOperation(args[1], "casei");
  if (leftCaseInsensitive !== rightCaseInsensitive) {
    throw cql2Invalid(`${path}.args`, "must apply casei to both operands or neither operand");
  }
  if (leftCaseInsensitive) {
    const left = operationArgs(args[0] as JsonValue, "casei", `${path}.args[0]`);
    const right = operationArgs(args[1] as JsonValue, "casei", `${path}.args[1]`);
    exactLength(left, 1, `${path}.args[0].args`);
    exactLength(right, 1, `${path}.args[1].args`);
    if (typeof right[0] !== "string") throw cql2Invalid(`${path}.args[1]`, "must wrap a string pattern");
    return {
      kind: "pattern",
      operator: "like",
      operand: importProperty(left[0] as JsonValue, `${path}.args[0].args[0]`),
      pattern: right[0],
      caseSensitive: false,
    } as RuntimeSemanticFilter;
  }
  if (typeof args[1] !== "string") throw cql2Invalid(`${path}.args[1]`, "must be a string pattern");
  return {
    kind: "pattern",
    operator: "like",
    operand: importProperty(args[0] as JsonValue, `${path}.args[0]`),
    pattern: args[1],
    caseSensitive: true,
  } as RuntimeSemanticFilter;
}

function importSpatial(
  op: keyof typeof CQL2_TO_SPATIAL,
  args: readonly JsonValue[],
  context: Cql2Context,
  path: string,
): RuntimeSemanticFilter {
  exactLength(args, 2, `${path}.args`);
  const property = importProperty(args[0] as JsonValue, `${path}.args[0]`);
  const crs = requiredFilterCrs(context, path);
  const operand = object(args[1] as JsonValue, `${path}.args[1]`);
  if (Object.hasOwn(operand, "bbox") && !Object.hasOwn(operand, "type")) {
    exactKeys(operand, ["bbox"], `${path}.args[1]`);
    if (op !== "s_intersects") throw cql2Unsupported(path, "only s_intersects maps a CQL2 BBox literal");
    const bounds = array(operand.bbox as JsonValue, `${path}.args[1].bbox`);
    const layout = bounds.length === 4 ? "xy" : bounds.length === 6 ? "xyz" : undefined;
    if (!layout) throw cql2Invalid(`${path}.args[1].bbox`, "must contain four or six ordinates");
    return {
      kind: "spatial",
      operator: "bbox-intersects",
      property,
      bbox: { box: { layout, bounds }, crs },
    } as unknown as RuntimeSemanticFilter;
  }
  const layout = geometryLayout(operand, `${path}.args[1]`);
  return {
    kind: "spatial",
    operator: CQL2_TO_SPATIAL[op],
    property,
    // GeoJSON permits an optional bbox on every geometry object. The
    // protocol-neutral semantic contract intentionally stores canonical
    // geometry only, so validate those extents above and discard them here.
    geometry: { state: "present", geometry: geometryWithoutBboxes(operand), crs, layout },
  } as unknown as RuntimeSemanticFilter;
}

function importTemporal(
  op: keyof typeof CQL2_TO_TEMPORAL,
  args: readonly JsonValue[],
  path: string,
): RuntimeSemanticFilter {
  exactLength(args, 2, `${path}.args`);
  return {
    kind: "temporal",
    operator: CQL2_TO_TEMPORAL[op],
    operand: importProperty(args[0] as JsonValue, `${path}.args[0]`),
    value: importTemporalLiteral(args[1] as JsonValue, `${path}.args[1]`),
  } as RuntimeSemanticFilter;
}

function importLiteral(value: JsonValue, field: LogicalField | undefined, path: string) {
  if (value === null || Array.isArray(value)) {
    throw cql2Unsupported(path, "the supported scalar form accepts string, number, boolean, date, or timestamp");
  }
  if (typeof value !== "object") {
    if (field?.type.kind === "date" || field?.type.kind === "timestamp") {
      throw cql2Unsupported(path, `schema-typed ${field.type.kind} comparisons require the tagged CQL2 literal form`);
    }
    if (
      (field?.type.kind === "decimal" && field.type.jsonEncoding === "string") ||
      (field?.type.kind === "integer" && field.type.jsonEncoding === "string")
    ) {
      throw cql2Unsupported(path, "CQL2 JSON numbers cannot preserve string-encoded numeric precision");
    }
    return { kind: "literal" as const, value };
  }
  const objectValue = value as JsonObject;
  if (Object.hasOwn(objectValue, "date")) {
    exactKeys(objectValue, ["date"], path);
    if (!field) throw cql2Unsupported(path, "tagged date comparison requires schema context");
    if (field.type.kind !== "date") throw cql2Invalid(path, "date literal does not match the schema field type");
    const date = text(objectValue.date, `${path}.date`);
    if (!CQL2_DATE.test(date)) throw cql2Invalid(`${path}.date`, "must use the CQL2 full-date form");
    return { kind: "literal" as const, value: date };
  }
  if (Object.hasOwn(objectValue, "timestamp")) {
    exactKeys(objectValue, ["timestamp"], path);
    if (!field) throw cql2Unsupported(path, "tagged timestamp comparison requires schema context");
    if (field.type.kind !== "timestamp") {
      throw cql2Invalid(path, "timestamp literal does not match the schema field type");
    }
    const timestamp = text(objectValue.timestamp, `${path}.timestamp`);
    if (!CQL2_TIMESTAMP.test(timestamp)) {
      throw cql2Invalid(`${path}.timestamp`, "must use the CQL2 UTC Z form");
    }
    return { kind: "literal" as const, value: timestamp };
  }
  throw cql2Unsupported(path, "uses an unsupported CQL2 scalar expression");
}

function importTemporalLiteral(value: JsonValue, path: string): TemporalLiteralNode {
  const literal = object(value, path);
  if (Object.hasOwn(literal, "date")) {
    exactKeys(literal, ["date"], path);
    const date = text(literal.date, `${path}.date`);
    if (!CQL2_DATE.test(date)) throw cql2Invalid(`${path}.date`, "must use the CQL2 full-date form");
    return { kind: "temporal-literal", valueType: "date", value: date };
  }
  if (Object.hasOwn(literal, "timestamp")) {
    exactKeys(literal, ["timestamp"], path);
    const timestamp = text(literal.timestamp, `${path}.timestamp`);
    if (!CQL2_TIMESTAMP.test(timestamp)) {
      throw cql2Invalid(`${path}.timestamp`, "must use the CQL2 UTC Z form");
    }
    return {
      kind: "temporal-literal",
      valueType: "instant",
      value: timestamp,
    };
  }
  if (Object.hasOwn(literal, "interval")) {
    exactKeys(literal, ["interval"], path);
    const interval = array(literal.interval as JsonValue, `${path}.interval`);
    exactLength(interval, 2, `${path}.interval`);
    const endpoints = [text(interval[0], `${path}.interval[0]`), text(interval[1], `${path}.interval[1]`)] as const;
    endpoints.forEach((entry, index) => {
      if (!CQL2_DATE.test(entry) && !CQL2_TIMESTAMP.test(entry)) {
        throw cql2Invalid(`${path}.interval[${index}]`, "must use a CQL2 full-date or UTC Z timestamp");
      }
    });
    return {
      kind: "temporal-literal",
      valueType: "interval",
      value: endpoints,
    };
  }
  throw cql2Unsupported(path, "uses an unsupported temporal literal");
}

function importProperty(value: JsonValue, path: string): { readonly kind: "property"; readonly name: string } {
  const property = exactObject(value, path, ["property"]);
  const name = text(property.property, `${path}.property`);
  if (name.length === 0) throw cql2Invalid(`${path}.property`, "must not be empty");
  return { kind: "property", name };
}

function geometryLayout(geometry: JsonObject, path: string): "xy" | "xyz" {
  const type = text(geometry.type, `${path}.type`);
  if (type === "GeometryCollection") {
    exactKeys(
      geometry,
      Object.hasOwn(geometry, "bbox") ? ["type", "geometries", "bbox"] : ["type", "geometries"],
      path,
    );
    const geometries = array(geometry.geometries as JsonValue, `${path}.geometries`);
    if (geometries.length < MIN_CQL2_GEOMETRY_COLLECTION_ITEMS) {
      throw cql2Invalid(`${path}.geometries`, "must contain at least two geometries in CQL2 JSON");
    }
    const layouts = geometries.map((entry, index) => {
      const childPath = `${path}.geometries[${index}]`;
      const child = object(entry as JsonValue, childPath);
      if (child.type === "GeometryCollection") {
        throw cql2Invalid(childPath, "must not be a nested GeometryCollection in CQL2 JSON");
      }
      return geometryLayout(child, childPath);
    });
    const layout = layouts[0] as "xy" | "xyz";
    if (layouts.some((candidate) => candidate !== layout)) {
      throw cql2Invalid(`${path}.geometries`, "must use one coordinate layout throughout the collection");
    }
    validateGeometryBbox(geometry, layout, path);
    return layout;
  }
  if (!["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(type)) {
    throw cql2Unsupported(`${path}.type`, "uses an unsupported GeoJSON geometry type");
  }
  exactKeys(
    geometry,
    Object.hasOwn(geometry, "bbox") ? ["type", "coordinates", "bbox"] : ["type", "coordinates"],
    path,
  );
  let position: JsonValue = geometry.coordinates as JsonValue;
  while (Array.isArray(position) && position.length > 0 && Array.isArray(position[0])) {
    position = position[0] as JsonValue;
  }
  if (!Array.isArray(position)) throw cql2Invalid(`${path}.coordinates`, "must contain coordinate positions");
  if (position.length === 2) {
    validateGeometryBbox(geometry, "xy", path);
    return "xy";
  }
  if (position.length === 3) {
    validateGeometryBbox(geometry, "xyz", path);
    return "xyz";
  }
  throw cql2Unsupported(`${path}.coordinates`, "positions must contain two or three ordinates");
}

function validateGeometryBbox(geometry: JsonObject, layout: "xy" | "xyz", path: string): void {
  if (!Object.hasOwn(geometry, "bbox")) return;
  const bbox = array(geometry.bbox, `${path}.bbox`);
  const expectedLength = layout === "xy" ? 4 : 6;
  if (bbox.length !== expectedLength) {
    throw cql2Invalid(`${path}.bbox`, `must contain ${expectedLength} ordinates for ${layout} geometry`);
  }
  bbox.forEach((ordinate, index) => {
    if (typeof ordinate !== "number") throw cql2Invalid(`${path}.bbox[${index}]`, "must be a number");
  });
}

function geometryWithoutBboxes(geometry: JsonObject): JsonObject {
  if (geometry.type === "GeometryCollection") {
    return {
      type: "GeometryCollection",
      geometries: (geometry.geometries as readonly JsonValue[]).map((entry) =>
        geometryWithoutBboxes(entry as JsonObject),
      ),
    };
  }
  return { type: geometry.type as JsonValue, coordinates: geometry.coordinates as JsonValue };
}

function assertCql2GeometryCollectionCardinality(geometry: JsonObject, path: string): void {
  if (geometry.type !== "GeometryCollection") return;
  const geometries = geometry.geometries;
  if (!Array.isArray(geometries) || geometries.length < MIN_CQL2_GEOMETRY_COLLECTION_ITEMS) {
    throw cql2Unsupported(`${path}.geometries`, "must contain at least two geometries in CQL2 JSON");
  }
  geometries.forEach((entry, index) => {
    if (
      entry !== null &&
      !Array.isArray(entry) &&
      typeof entry === "object" &&
      (entry as JsonObject).type === "GeometryCollection"
    ) {
      throw cql2Unsupported(
        `${path}.geometries[${index}]`,
        "nested GeometryCollection literals are outside CQL2 JSON 1.0",
      );
    }
  });
}

function assertFilterCrs(value: ExecutableCrsBinding, context: Cql2Context, path: string): void {
  const expected = requiredFilterCrs(context, path);
  if (canonicalStringify(toJsonValue(value)) !== canonicalStringify(toJsonValue(expected))) {
    throw cql2Unsupported(path, "spatial operand CRS does not match the external filterCrs context");
  }
}

function requiredFilterCrs(context: Cql2Context, path: string): ExecutableCrsBinding {
  if (!context.filterCrs) {
    throw cql2Unsupported(path, "spatial CQL2 interchange requires an explicit filterCrs binding");
  }
  return context.filterCrs;
}

function primaryGeometryField(schema: SourceSchemaV2 | undefined, path: string): string {
  if (schema?.geometry.state === "known" && schema.geometry.primaryField.state === "known") {
    return schema.geometry.primaryField.field;
  }
  throw cql2Unsupported(path, "an implicit semantic geometry property requires schema primary-field context");
}

function schemaField(schema: SourceSchemaV2 | undefined, name: string): LogicalField | undefined {
  return schema?.fields.find((field) => field.name === name);
}

function cql2Context(options: Cql2JsonInterchangeOptions): Cql2Context {
  let schema: SourceSchemaV2 | undefined;
  let filterCrs: ExecutableCrsBinding | undefined;
  try {
    schema = options.schema === undefined ? undefined : parseSourceSchemaV2(options.schema);
  } catch {
    throw cql2Invalid("$", "requires a valid schema context");
  }
  try {
    filterCrs = options.filterCrs === undefined ? undefined : validateExecutableCrsBinding(options.filterCrs);
  } catch {
    throw cql2Invalid("$", "requires a valid executable filterCrs binding");
  }
  return {
    ...(schema ? { schema } : {}),
    ...(filterCrs ? { filterCrs } : {}),
    ...(options.protocol !== undefined ? { protocol: options.protocol } : {}),
  };
}

function isOperation(value: JsonValue, op: string): boolean {
  return value !== null && !Array.isArray(value) && typeof value === "object" && (value as JsonObject).op === op;
}

function operationArgs(value: JsonValue, op: string, path: string): readonly JsonValue[] {
  const operation = exactObject(value, path, ["op", "args"]);
  if (operation.op !== op) throw cql2Invalid(`${path}.op`, `must be ${op}`);
  return array(operation.args, `${path}.args`);
}

function exactObject(value: JsonValue, path: string, keys: readonly string[]): JsonObject {
  const result = object(value, path);
  exactKeys(result, keys, path);
  return result;
}

function object(value: JsonValue, path: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw cql2Invalid(path, "must be an object");
  }
  return value as JsonObject;
}

function array(value: JsonValue | undefined, path: string): readonly JsonValue[] {
  if (!Array.isArray(value)) throw cql2Invalid(path, "must be an array");
  return value;
}

function text(value: JsonValue | undefined, path: string): string {
  if (typeof value !== "string") throw cql2Invalid(path, "must be a string");
  return value;
}

function exactLength(value: readonly JsonValue[], expected: number, path: string): void {
  if (value.length !== expected) throw cql2Invalid(path, `must contain exactly ${expected} entries`);
}

function exactKeys(value: JsonObject, expected: readonly string[], path: string): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw cql2Invalid(path, "contains a member outside the supported CQL2 form");
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw cql2Invalid(`${path}.${key}`, "is required");
  }
}

function hasOwn<T extends object>(value: T, key: string): key is keyof T & string {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function cql2Invalid(path: string, message: string): HonuaQueryPlanningError {
  return new HonuaQueryPlanningError("invalid-query", `CQL2 JSON ${path} ${message}`);
}

function cql2Unsupported(path: string, message: string): HonuaQueryPlanningError {
  return new HonuaQueryPlanningError("unsupported-query", `CQL2 JSON ${path} ${message}`);
}
