import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";

const DEFAULT_SCHEMA_URL = new URL("./v1/schema.json", import.meta.url);
const DEFAULT_CORPUS_URL = new URL("./v1/corpus.json", import.meta.url);
const MAX_SCHEMA_BYTES = 512 * 1024;
const MAX_CORPUS_BYTES = 2 * 1024 * 1024;
const REQUIRED_COVERAGE = new Set([
  "comparison",
  "null",
  "list",
  "range",
  "pattern",
  "spatial",
  "temporal",
  "projection",
  "sort",
  "pagination",
  "grouping",
  "statistics",
  "injection",
  "unicode",
  "axis-order",
  "boundary",
  "approximate",
]);
const SCALAR_FIELD_TYPES = new Set(["boolean", "integer", "float", "decimal", "string", "date", "timestamp"]);
const ORDERABLE_FIELD_TYPES = new Set(["integer", "float", "decimal", "string", "date", "timestamp"]);
const NUMERIC_FIELD_TYPES = new Set(["integer", "float", "decimal"]);

const CREDENTIAL_TEXT =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bBasic\s+[A-Za-z0-9+/=]{8,}|\bAKIA[0-9A-Z]{16}\b|[?&;](?:access[-_]?token|id[-_]?token|refresh[-_]?token|x-amz-signature|signature|sig|api[-_]?key|password|secret)=[^\s&#;]*|[a-z][a-z0-9+.-]*:\/\/[^/\s"'<>]*@|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/i;
const CREDENTIAL_KEYS = new Set([
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "xapikey",
  "credential",
  "credentials",
  "signature",
]);

export class SemanticQueryCorpusError extends Error {
  constructor(message) {
    super(message);
    this.name = "SemanticQueryCorpusError";
  }
}

export async function loadSemanticQueryCorpus(options = {}) {
  const schemaUrl = options.schemaUrl ?? DEFAULT_SCHEMA_URL;
  const corpusUrl = options.corpusUrl ?? DEFAULT_CORPUS_URL;
  const [schemaText, corpusText] = await Promise.all([
    readBoundedUtf8(schemaUrl, MAX_SCHEMA_BYTES, "schema"),
    readBoundedUtf8(corpusUrl, MAX_CORPUS_BYTES, "corpus"),
  ]);
  return validateSemanticQueryCorpus(parseJson(schemaText, "schema"), parseJson(corpusText, "corpus"));
}

export function validateSemanticQueryCorpus(schema, corpus) {
  let schemaSnapshot;
  let corpusSnapshot;
  try {
    schemaSnapshot = structuredClone(schema);
    corpusSnapshot = structuredClone(corpus);
  } catch {
    throw new SemanticQueryCorpusError("Semantic query corpus input is not detachable JSON data");
  }
  let validate;
  try {
    const ajv = new Ajv2020({
      allErrors: true,
      allowUnionTypes: true,
      strict: true,
      strictRequired: false,
      validateFormats: false,
    });
    validate = ajv.compile(schemaSnapshot);
  } catch {
    throw new SemanticQueryCorpusError("Semantic query corpus schema is invalid");
  }
  if (!validate(corpusSnapshot)) {
    const details = (validate.errors ?? [])
      .slice(0, 8)
      .map((error) => `${error.instancePath || "$"}:${error.keyword}`)
      .join(", ");
    throw new SemanticQueryCorpusError(`Semantic query corpus does not match schema (${details || "invalid"})`);
  }

  assertSemanticInvariants(corpusSnapshot);
  assertCredentialFree(corpusSnapshot);
  return deepFreeze(corpusSnapshot);
}

async function readBoundedUtf8(url, maxBytes, label) {
  let bytes;
  try {
    bytes = await readFile(url);
  } catch {
    throw new SemanticQueryCorpusError(`Semantic query ${label} could not be read`);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new SemanticQueryCorpusError(`Semantic query ${label} exceeds its bounded input contract`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SemanticQueryCorpusError(`Semantic query ${label} is not valid UTF-8`);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new SemanticQueryCorpusError(`Semantic query ${label} is not valid JSON`);
  }
}

function assertSemanticInvariants(corpus) {
  const fieldNames = corpus.schema.fields.map((field) => field.name);
  assertUnique(fieldNames, "schema field names");
  const fields = new Set(fieldNames);
  for (const key of corpus.schema.key) assertField(fields, key, "schema key");
  assertField(fields, corpus.schema.geometry.field, "geometry field");
  assertField(fields, corpus.schema.temporal.field, "temporal field");

  const fieldByName = new Map(corpus.schema.fields.map((field) => [field.name, field]));
  assertLogicalSchemaConsistency(corpus.schema, fieldByName);
  for (const [index, row] of corpus.rows.entries()) {
    const keys = Object.keys(row).sort();
    const expected = [...fieldNames].sort();
    if (keys.length !== expected.length || keys.some((key, keyIndex) => key !== expected[keyIndex])) {
      throw new SemanticQueryCorpusError(
        `Semantic query source row ${index} does not exactly match the declared schema`,
      );
    }
    for (const [name, value] of Object.entries(row)) {
      assertTypedValue(fieldByName.get(name), value, `source row ${index}`, corpus.schema.geometry);
    }
  }

  assertUnique(
    corpus.cases.map((entry) => entry.id),
    "case ids",
  );
  const coverage = new Set(corpus.cases.flatMap((entry) => entry.covers));
  for (const required of REQUIRED_COVERAGE) {
    if (!coverage.has(required)) {
      throw new SemanticQueryCorpusError(`Semantic query corpus is missing required coverage ${required}`);
    }
  }
  const protocolKeys = [...corpus.protocols].sort();
  for (const entry of corpus.cases) {
    const projectionKeys = Object.keys(entry.projections).sort();
    if (
      projectionKeys.length !== protocolKeys.length ||
      projectionKeys.some((key, index) => key !== protocolKeys[index])
    ) {
      throw new SemanticQueryCorpusError(`Semantic query case ${entry.id} does not project every declared protocol`);
    }
    assertQuerySemantics(entry.query, fieldByName, corpus.schema.geometry, entry.id);
    assertExpectedRows(entry, fieldByName, corpus.schema.geometry);
  }

  if (!isTimestampValue(corpus.frozenClock)) {
    throw new SemanticQueryCorpusError("Semantic query corpus frozen clock is invalid");
  }
}

function assertLogicalSchemaConsistency(schema, fieldByName) {
  const keyFields = schema.key.map((name) => fieldByName.get(name));
  if (keyFields.some((field) => field?.nullable)) {
    throw new SemanticQueryCorpusError("Semantic query schema keys must be non-nullable");
  }
  const geometryField = fieldByName.get(schema.geometry.field);
  if (geometryField?.type !== "geometry") {
    throw new SemanticQueryCorpusError("Semantic query geometry field must have geometry type");
  }
  const temporalField = fieldByName.get(schema.temporal.field);
  const temporalType = schema.temporal.kind === "instant" ? "timestamp" : "date";
  if (temporalField?.type !== temporalType) {
    throw new SemanticQueryCorpusError(`Semantic query temporal field must have ${temporalType} type`);
  }
  assertUnique(schema.geometry.definitionAxisOrder, "geometry definition axes");
  assertUnique(schema.geometry.coordinateOrder, "geometry coordinate axes");
  const arity = { xy: 2, xyz: 3, xym: 3, xyzm: 4 }[schema.geometry.layout];
  if (
    schema.geometry.definitionAxisOrder.length !== arity ||
    schema.geometry.coordinateOrder.length !== arity ||
    !sameStringSet(schema.geometry.definitionAxisOrder, schema.geometry.coordinateOrder)
  ) {
    throw new SemanticQueryCorpusError("Semantic query geometry axes do not match its layout");
  }
}

function assertTypedValue(field, value, label, geometrySchema) {
  if (value === null) {
    if (field?.nullable) return;
    throw new SemanticQueryCorpusError(`Semantic query ${label} violates field nullability`);
  }
  if (!isTypedValue(field, value, geometrySchema)) {
    throw new SemanticQueryCorpusError(`Semantic query ${label} violates its field type`);
  }
}

function isTypedValue(field, value, geometrySchema) {
  return (
    (field?.type === "boolean" && typeof value === "boolean") ||
    (field?.type === "integer" && Number.isSafeInteger(value)) ||
    ((field?.type === "float" || field?.type === "decimal") && typeof value === "number" && Number.isFinite(value)) ||
    (field?.type === "string" && typeof value === "string") ||
    (field?.type === "date" && isDateValue(value)) ||
    (field?.type === "timestamp" && isTimestampValue(value)) ||
    (field?.type === "geometry" && isGeometryValue(value, geometrySchema.type, geometrySchema.layout))
  );
}

function isDateValue(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().startsWith(value);
}

function isTimestampValue(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  const [year, month, day, hour, minute, second] = parts;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return false;
  const parsed = new Date(instant);
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() + 1 === month &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second
  );
}

function isGeometryValue(value, expectedType, layout) {
  const arity = { xy: 2, xyz: 3, xym: 3, xyzm: 4 }[layout];
  return isGeoJsonGeometry(value, arity, expectedType);
}

function isGeoJsonGeometry(value, arity, expectedType) {
  if (value === null || typeof value !== "object" || (expectedType !== undefined && value.type !== expectedType)) {
    return false;
  }
  switch (value.type) {
    case "Point":
      return hasExactKeys(value, ["type", "coordinates"]) && isPosition(value.coordinates, arity);
    case "MultiPoint":
    case "LineString":
      return (
        hasExactKeys(value, ["type", "coordinates"]) &&
        isPositionArray(value.coordinates, arity, value.type === "LineString" ? 2 : 1)
      );
    case "MultiLineString":
      return (
        hasExactKeys(value, ["type", "coordinates"]) &&
        Array.isArray(value.coordinates) &&
        value.coordinates.every((line) => isPositionArray(line, arity, 2))
      );
    case "Polygon":
      return hasExactKeys(value, ["type", "coordinates"]) && isPolygonCoordinates(value.coordinates, arity);
    case "MultiPolygon":
      return (
        hasExactKeys(value, ["type", "coordinates"]) &&
        Array.isArray(value.coordinates) &&
        value.coordinates.every((polygon) => isPolygonCoordinates(polygon, arity))
      );
    case "GeometryCollection":
      return (
        hasExactKeys(value, ["type", "geometries"]) &&
        Array.isArray(value.geometries) &&
        value.geometries.every((child) => isGeoJsonGeometry(child, arity))
      );
    default:
      return false;
  }
}

function isPosition(value, arity) {
  return Array.isArray(value) && value.length === arity && value.every((entry) => Number.isFinite(entry));
}

function isPositionArray(value, arity, minimum) {
  return Array.isArray(value) && value.length >= minimum && value.every((position) => isPosition(position, arity));
}

function isPolygonCoordinates(value, arity) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (ring) =>
        isPositionArray(ring, arity, 4) &&
        ring[0].every((coordinate, index) => coordinate === ring[ring.length - 1][index]),
    )
  );
}

function assertQuerySemantics(query, fieldByName, geometrySchema, caseId) {
  const fields = new Set(fieldByName.keys());
  for (const field of query.select ?? []) assertCaseField(fields, field, caseId);
  for (const field of query.groupBy ?? []) {
    const resolved = assertCaseFieldType(fieldByName, field, caseId);
    if (!SCALAR_FIELD_TYPES.has(resolved.type)) {
      throw new SemanticQueryCorpusError(`Semantic query case ${caseId} group field is not scalar`);
    }
  }
  const sortFields = (query.sort ?? []).map((sort) => sort.field);
  assertUnique(sortFields, `case ${caseId} sort fields`);
  for (const field of sortFields) {
    const resolved = assertCaseFieldType(fieldByName, field, caseId);
    if (!ORDERABLE_FIELD_TYPES.has(resolved.type)) {
      throw new SemanticQueryCorpusError(`Semantic query case ${caseId} sort field is not orderable`);
    }
  }
  const aliases = new Set();
  for (const metric of query.metrics ?? []) {
    const field = metric.field === undefined ? undefined : assertCaseFieldType(fieldByName, metric.field, caseId);
    if (aliases.has(metric.as) || fields.has(metric.as)) {
      throw new SemanticQueryCorpusError(`Semantic query case ${caseId} has an ambiguous metric alias`);
    }
    aliases.add(metric.as);
    if (metric.fn !== "count" && !field) {
      throw new SemanticQueryCorpusError(`Semantic query case ${caseId} metric requires a field`);
    }
    if (["sum", "avg", "stddev", "variance"].includes(metric.fn) && !NUMERIC_FIELD_TYPES.has(field?.type)) {
      throw new SemanticQueryCorpusError(`Semantic query case ${caseId} metric field is not numeric`);
    }
    if (["min", "max"].includes(metric.fn) && !ORDERABLE_FIELD_TYPES.has(field?.type)) {
      throw new SemanticQueryCorpusError(`Semantic query case ${caseId} metric field is not orderable`);
    }
  }
  if (query.filter) assertFilterSemantics(query.filter, fieldByName, geometrySchema, caseId);
}

function assertFilterSemantics(filter, fieldByName, geometrySchema, caseId) {
  switch (filter.kind) {
    case "comparison": {
      const field = assertPropertyField(filter.left, fieldByName, caseId);
      const allowed = filter.operator === "eq" || filter.operator === "ne" ? SCALAR_FIELD_TYPES : ORDERABLE_FIELD_TYPES;
      assertFieldCategory(field, allowed, caseId, "comparison");
      assertLiteralForField(field, filter.right.value, caseId);
      return;
    }
    case "list": {
      const field = assertPropertyField(filter.operand, fieldByName, caseId);
      assertFieldCategory(field, SCALAR_FIELD_TYPES, caseId, "list");
      for (const literal of filter.values) assertLiteralForField(field, literal.value, caseId);
      return;
    }
    case "range": {
      const field = assertPropertyField(filter.operand, fieldByName, caseId);
      assertFieldCategory(field, ORDERABLE_FIELD_TYPES, caseId, "range");
      assertLiteralForField(field, filter.lower.value, caseId);
      assertLiteralForField(field, filter.upper.value, caseId);
      if (compareLogicalValues(filter.lower.value, filter.upper.value) > 0) {
        throw new SemanticQueryCorpusError(`Semantic query case ${caseId} range lower bound exceeds upper bound`);
      }
      return;
    }
    case "null":
      assertPropertyField(filter.operand, fieldByName, caseId);
      return;
    case "pattern": {
      const field = assertPropertyField(filter.operand, fieldByName, caseId);
      assertFieldCategory(field, new Set(["string"]), caseId, "pattern");
      return;
    }
    case "boolean":
      for (const child of filter.args) assertFilterSemantics(child, fieldByName, geometrySchema, caseId);
      return;
    case "not":
      assertFilterSemantics(filter.arg, fieldByName, geometrySchema, caseId);
      return;
    case "temporal":
      assertTemporalFilter(filter, fieldByName, caseId);
      return;
    case "spatial":
      assertSpatialFilter(filter, fieldByName, geometrySchema, caseId);
      return;
    default:
      throw new SemanticQueryCorpusError(`Semantic query case ${caseId} has an unknown filter kind`);
  }
}

function assertTemporalFilter(filter, fieldByName, caseId) {
  const field = assertPropertyField(filter.operand, fieldByName, caseId);
  if (field.type !== "date" && field.type !== "timestamp") {
    throw new SemanticQueryCorpusError(`Semantic query case ${caseId} temporal operand is not temporal`);
  }
  const temporal = filter.value;
  const requiresInterval = filter.operator === "during" || filter.operator === "time-intersects";
  if (requiresInterval !== (temporal.valueType === "interval")) {
    throw new SemanticQueryCorpusError(`Semantic query case ${caseId} temporal operator and literal disagree`);
  }
  if (field.type === "date" && temporal.valueType === "instant") {
    throw new SemanticQueryCorpusError(`Semantic query case ${caseId} date field cannot use an instant`);
  }
  if (field.type === "timestamp" && temporal.valueType === "date") {
    throw new SemanticQueryCorpusError(`Semantic query case ${caseId} timestamp field cannot use a date`);
  }
  const values = Array.isArray(temporal.value) ? temporal.value : [temporal.value];
  const validator = field.type === "date" ? isDateValue : isTimestampValue;
  if (!values.every(validator) || (values.length === 2 && values[0] > values[1])) {
    throw new SemanticQueryCorpusError(`Semantic query case ${caseId} temporal literal is invalid`);
  }
}

function assertSpatialFilter(filter, fieldByName, geometrySchema, caseId) {
  const field = assertPropertyField(filter.property, fieldByName, caseId);
  if (field.type !== "geometry" || field.name !== geometrySchema.field) {
    throw new SemanticQueryCorpusError(`Semantic query case ${caseId} spatial property is not the declared geometry`);
  }
  const arity = { xy: 2, xyz: 3, xym: 3, xyzm: 4 }[geometrySchema.layout];
  if (filter.operator === "bbox-intersects") {
    const bounds = filter.bbox?.box?.bounds;
    if (
      !hasExactKeys(filter.bbox, ["box", "crs"]) ||
      !hasExactKeys(filter.bbox?.box, ["layout", "bounds"]) ||
      filter.bbox?.box?.layout !== geometrySchema.layout ||
      !Array.isArray(bounds) ||
      bounds.length !== arity * 2 ||
      !bounds.every(Number.isFinite)
    ) {
      throw new SemanticQueryCorpusError(`Semantic query case ${caseId} bounding box is invalid`);
    }
    for (let axis = 0; axis < arity; axis += 1) {
      if (bounds[axis] > bounds[axis + arity]) {
        throw new SemanticQueryCorpusError(`Semantic query case ${caseId} bounding box bounds are reversed`);
      }
    }
    assertCrsAxes(filter.bbox.crs, geometrySchema, caseId);
    return;
  }
  const operand = filter.geometry;
  if (
    !hasExactKeys(operand, ["state", "geometry", "crs", "layout"]) ||
    operand?.state !== "present" ||
    operand.layout !== geometrySchema.layout ||
    !isGeoJsonGeometry(operand.geometry, arity)
  ) {
    throw new SemanticQueryCorpusError(`Semantic query case ${caseId} spatial geometry is invalid`);
  }
  assertCrsAxes(operand.crs, geometrySchema, caseId);
}

function assertCrsAxes(crs, geometrySchema, caseId) {
  const definition = crs?.definition;
  const definitionOrder = definition?.definitionAxisOrder;
  const coordinateOrder = crs?.coordinateOrder;
  const [authority, code] = geometrySchema.crs.split(":");
  if (
    !hasExactKeys(crs, ["definition", "coordinateOrder", "provenance"]) ||
    !hasExactKeys(definition, ["kind", "authority", "code", "definitionAxisOrder"]) ||
    definition?.kind !== "authority" ||
    definition.authority !== authority ||
    definition.code !== code ||
    !hasExactKeys(crs?.provenance, ["method"]) ||
    crs.provenance.method !== "declared" ||
    !isKnownAxisOrder(definitionOrder, "crs-definition") ||
    !isKnownAxisOrder(coordinateOrder, "encoding")
  ) {
    throw new SemanticQueryCorpusError(`Semantic query case ${caseId} CRS binding is invalid`);
  }
  const definitionAxes = definitionOrder.axes.map((axis) => axis.name);
  const coordinateAxes = coordinateOrder.axes.map((axis) => axis.name);
  if (
    !sameStringArray(definitionAxes, geometrySchema.definitionAxisOrder) ||
    !sameStringArray(coordinateAxes, geometrySchema.coordinateOrder) ||
    !coordinateOrder.axes.every((axis) => {
      const defined = definitionOrder.axes.find((candidate) => candidate.name === axis.name);
      return defined?.direction === axis.direction && defined.unit === axis.unit;
    })
  ) {
    throw new SemanticQueryCorpusError(`Semantic query case ${caseId} CRS axis evidence is invalid`);
  }
}

function isKnownAxisOrder(value, source) {
  return (
    hasExactKeys(value, ["state", "source", "axes"]) &&
    value.state === "known" &&
    value.source === source &&
    Array.isArray(value.axes) &&
    value.axes.length >= 2 &&
    value.axes.every(
      (axis) =>
        hasExactKeys(axis, ["name", "direction", "unit"]) &&
        typeof axis.name === "string" &&
        typeof axis.direction === "string" &&
        typeof axis.unit === "string" &&
        axis.name.length > 0 &&
        axis.direction.length > 0 &&
        axis.unit.length > 0,
    )
  );
}

function sameStringArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function hasExactKeys(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return sameStringArray(actual, expected);
}

function assertPropertyField(property, fieldByName, caseId) {
  if (property?.kind !== "property") {
    throw new SemanticQueryCorpusError(`Semantic query case ${caseId} property node is invalid`);
  }
  return assertCaseFieldType(fieldByName, property.name, caseId);
}

function assertCaseFieldType(fieldByName, name, caseId) {
  const field = fieldByName.get(name);
  if (!field) throw new SemanticQueryCorpusError(`Semantic query case ${caseId} references an unknown field`);
  return field;
}

function assertFieldCategory(field, allowed, caseId, operation) {
  if (!allowed.has(field.type)) {
    throw new SemanticQueryCorpusError(`Semantic query case ${caseId} ${operation} field has an incompatible type`);
  }
}

function assertLiteralForField(field, value, caseId) {
  assertTypedValue(field, value, `case ${caseId} literal`, { type: "Point", layout: "xy" });
}

function compareLogicalValues(left, right) {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

function assertExpectedRows(entry, fieldByName, geometrySchema) {
  const query = entry.query;
  const expectedFields =
    query.kind === "aggregate"
      ? [...query.groupBy, ...query.metrics.map((metric) => metric.as)]
      : (query.select ?? [...fieldByName.keys()]).filter(
          (name) => query.geometry !== "omit" || name !== geometrySchema.field,
        );
  const expectedKeys = [...expectedFields].sort();
  for (const [rowIndex, row] of entry.expected.rows.entries()) {
    const keys = Object.keys(row).sort();
    if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
      throw new SemanticQueryCorpusError(`Semantic query case ${entry.id} expected row ${rowIndex} has invalid fields`);
    }
    for (const [name, value] of Object.entries(row)) {
      const metric = query.metrics?.find((candidate) => candidate.as === name);
      if (!metric) {
        assertTypedValue(fieldByName.get(name), value, `case ${entry.id} expected row ${rowIndex}`, geometrySchema);
        continue;
      }
      const validMetric =
        (metric.fn === "count" && Number.isSafeInteger(value) && value >= 0) ||
        (["sum", "avg", "stddev", "variance"].includes(metric.fn) &&
          typeof value === "number" &&
          Number.isFinite(value)) ||
        (["min", "max"].includes(metric.fn) &&
          metric.field !== undefined &&
          isTypedValue(fieldByName.get(metric.field), value, geometrySchema));
      if (!validMetric) {
        throw new SemanticQueryCorpusError(
          `Semantic query case ${entry.id} expected row ${rowIndex} violates metric type`,
        );
      }
    }
  }
}

function assertCaseField(fields, field, caseId) {
  if (!fields.has(field))
    throw new SemanticQueryCorpusError(`Semantic query case ${caseId} references an unknown field`);
}

function assertField(fields, name, label) {
  if (!fields.has(name)) throw new SemanticQueryCorpusError(`Semantic query ${label} references an unknown field`);
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new SemanticQueryCorpusError(`Semantic query corpus contains duplicate ${label}`);
  }
}

function assertCredentialFree(value) {
  if (typeof value === "string") {
    if (CREDENTIAL_TEXT.test(value)) {
      throw new SemanticQueryCorpusError("Semantic query corpus contains forbidden credential material");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) assertCredentialFree(child);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (CREDENTIAL_KEYS.has(normalized)) {
      throw new SemanticQueryCorpusError("Semantic query corpus contains forbidden credential material");
    }
    assertCredentialFree(child);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
