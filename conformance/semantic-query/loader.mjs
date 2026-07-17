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
    assertQueryFields(entry.query, fields, entry.id);
    assertExpectedRows(entry, fieldByName, corpus.schema.geometry);
  }

  if (!Number.isFinite(Date.parse(corpus.frozenClock))) {
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
  if (schema.geometry.coordinateOrder.length !== arity) {
    throw new SemanticQueryCorpusError("Semantic query geometry coordinate order does not match its layout");
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
  return new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value);
}

function isTimestampValue(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isGeometryValue(value, expectedType, layout) {
  const arity = { xy: 2, xyz: 3, xym: 3, xyzm: 4 }[layout];
  return (
    value !== null &&
    typeof value === "object" &&
    value.type === expectedType &&
    (value.type === "GeometryCollection"
      ? Array.isArray(value.geometries) && value.geometries.every((child) => isGeometryCoordinates(child, arity))
      : Array.isArray(value.coordinates) && isCoordinateTree(value.coordinates, arity))
  );
}

function isGeometryCoordinates(value, arity) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.type === "string" &&
    (value.type === "GeometryCollection"
      ? Array.isArray(value.geometries) && value.geometries.every((child) => isGeometryCoordinates(child, arity))
      : Array.isArray(value.coordinates) && isCoordinateTree(value.coordinates, arity))
  );
}

function isCoordinateTree(value, arity) {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.every((entry) => typeof entry === "number")) {
    return value.length === arity && value.every(Number.isFinite);
  }
  return value.every((entry) => isCoordinateTree(entry, arity));
}

function assertQueryFields(query, fields, caseId) {
  for (const field of query.select ?? []) assertCaseField(fields, field, caseId);
  for (const field of query.groupBy ?? []) assertCaseField(fields, field, caseId);
  for (const sort of query.sort ?? []) assertCaseField(fields, sort.field, caseId);
  const aliases = new Set();
  for (const metric of query.metrics ?? []) {
    if (metric.field !== undefined) assertCaseField(fields, metric.field, caseId);
    if (aliases.has(metric.as) || fields.has(metric.as)) {
      throw new SemanticQueryCorpusError(`Semantic query case ${caseId} has an ambiguous metric alias`);
    }
    aliases.add(metric.as);
  }
  if (query.filter) assertFilterFields(query.filter, fields, caseId);
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

function assertFilterFields(filter, fields, caseId) {
  for (const key of ["left", "operand", "property"]) {
    const property = filter[key];
    if (property?.kind === "property") assertCaseField(fields, property.name, caseId);
  }
  for (const child of filter.args ?? []) assertFilterFields(child, fields, caseId);
  if (filter.arg) assertFilterFields(filter.arg, fields, caseId);
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
