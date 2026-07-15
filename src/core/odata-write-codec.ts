/**
 * Metadata-driven OData write encoding primitives.
 *
 * This module deliberately has no transport dependencies. Callers supply the
 * already-cached CSDL projection and decide how to attach the encoded body,
 * content type, and key to an HTTP request.
 */

import {
  type HonuaOdataFieldInfo,
  type HonuaOdataMetadata,
  getOdataSourceSchemaProjectionDetails,
  getOdataSourceSchemaProjectionSafety,
} from "./odata.js";

const DEFAULT_MAX_DEPTH = 32;
const MAX_CONFIGURED_DEPTH = 32;
const MAX_ERROR_PATH_SEGMENT_CODE_POINTS = 64;
const MAX_DECIMAL_LEXEME_CHARACTERS = 1_024;

const GUID_LEXEME = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const JSON_NUMBER_LEXEME = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const INTEGER_LEXEME = /^-?(?:0|[1-9]\d*)$/;
const DATE_LEXEME = /^\d{4}-\d{2}-\d{2}$/;
const TIME_OF_DAY_LEXEME = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,12})?$/;
const DATE_TIME_OFFSET_LEXEME =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,12})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const DURATION_LEXEME = /^-?P(?=\d|T\d)(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;
const BINARY_LEXEME = /^[A-Za-z0-9_-]*={0,2}$/;
const QUALIFIED_IDENTIFIER =
  /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Cf}]*(?:\.[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Cf}]*)*$/u;
const SIMPLE_IDENTIFIER = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Cf}]*$/u;

const INTEGER_BOUNDS: Readonly<Record<string, { readonly minimum: bigint; readonly maximum: bigint }>> = Object.freeze({
  "Edm.Byte": { minimum: 0n, maximum: 255n },
  "Edm.SByte": { minimum: -128n, maximum: 127n },
  "Edm.Int16": { minimum: -32_768n, maximum: 32_767n },
  "Edm.Int32": { minimum: -2_147_483_648n, maximum: 2_147_483_647n },
  "Edm.Int64": { minimum: -(1n << 63n), maximum: (1n << 63n) - 1n },
});

/** Stable failure categories for local, pre-transport encoding errors. */
export type HonuaOdataEdmEncodingErrorCode =
  | "cyclic-value"
  | "invalid-metadata"
  | "invalid-options"
  | "invalid-value"
  | "max-depth-exceeded"
  | "missing-key"
  | "unknown-entity-set"
  | "unsupported-type";

/**
 * A redacted local encoding failure.
 *
 * Messages contain a fixed explanation and a bounded, escaped property path.
 * The rejected value and request body are intentionally never retained.
 */
export class HonuaOdataEdmEncodingError extends TypeError {
  public readonly code: HonuaOdataEdmEncodingErrorCode;
  public readonly path: string;

  public constructor(code: HonuaOdataEdmEncodingErrorCode, path: string) {
    super(`OData EDM encoding failed at ${path}: ${encodingErrorReason(code)}`);
    this.name = "HonuaOdataEdmEncodingError";
    this.code = code;
    this.path = path;
  }
}

/** Controls the hard recursion bound for complex, collection, and untyped values. */
export interface HonuaOdataEdmEncodingOptions {
  /** Maximum nested container depth. Defaults to and cannot exceed 32. */
  readonly maxDepth?: number;
}

/** Body projection consumed by a later HTTP/edit integration layer. */
export interface HonuaOdataEncodedWriteBody {
  /** JSON-compatible body with metadata-declared values encoded losslessly. */
  readonly body: Record<string, unknown>;
  /** Whether the body requires `IEEE754Compatible=true` on its media type. */
  readonly requiresIeee754Compatible: boolean;
}

/** Key projection consumed by direct and batch URL builders. */
export interface HonuaOdataEncodedEntityKey {
  /** OData key predicate content, without surrounding parentheses. */
  readonly literal: string;
  /** The same predicate encoded as one RFC 3986-safe URL path segment. */
  readonly pathSegment: string;
}

interface OdataCodecModel {
  readonly entityType: string;
  readonly fields: readonly HonuaOdataFieldInfo[];
  readonly keys: readonly string[];
  readonly complexTypes: Readonly<Record<string, readonly HonuaOdataFieldInfo[]>>;
  readonly enumTypes: NonNullable<HonuaOdataMetadata["enumTypes"]>;
  readonly unsafeTypeNames: ReadonlySet<string>;
}

interface EncodingContext {
  readonly maxDepth: number;
  readonly ancestors: WeakSet<object>;
  requiresIeee754Compatible: boolean;
}

/**
 * Encode one entity body using the entity and complex property declarations in
 * an existing OData metadata snapshot.
 */
export function encodeOdataWriteBody(
  metadata: HonuaOdataMetadata,
  entitySet: string,
  body: Readonly<Record<string, unknown>>,
  options: HonuaOdataEdmEncodingOptions = {},
): HonuaOdataEncodedWriteBody {
  const context = encodingContext(options);
  const model = codecModel(metadata, entitySet);
  const encoded = encodeStructuredValue(body, model.fields, model, [], 0, context);
  return { body: encoded, requiresIeee754Compatible: context.requiresIeee754Compatible };
}

/**
 * Encode a single or composite primary key in metadata declaration order.
 *
 * A single key accepts either its scalar value or an object carrying the key
 * property. Composite keys require an object so component names cannot be
 * confused or reordered by the caller.
 */
export function encodeOdataEntityKey(
  metadata: HonuaOdataMetadata,
  entitySet: string,
  key: unknown,
  options: HonuaOdataEdmEncodingOptions = {},
): HonuaOdataEncodedEntityKey {
  const context = encodingContext(options);
  const model = codecModel(metadata, entitySet);
  if (model.keys.length === 0) throw encodingError("invalid-metadata", ["key"]);
  if (new Set(model.keys).size !== model.keys.length) throw encodingError("invalid-metadata", ["key"]);

  const fields = new Map(model.fields.map((field) => [field.name, field]));
  const keyFields = model.keys.map((name) => {
    if (!simpleIdentifier(name)) throw encodingError("invalid-metadata", ["key"]);
    const field = fields.get(name);
    if (!field) throw encodingError("invalid-metadata", ["key", name]);
    return field;
  });

  let literal: string;
  if (keyFields.length === 1) {
    const field = keyFields[0]!;
    const value = isRecord(key) ? ownDataProperty(key, field.name, ["key", field.name]) : key;
    if (value === undefined || value === null) throw encodingError("missing-key", ["key", field.name]);
    literal = encodeKeyPrimitive(value, field, model, ["key", field.name]);
  } else {
    if (!isRecord(key)) throw encodingError("missing-key", ["key"]);
    literal = keyFields
      .map((field) => {
        const value = ownDataProperty(key, field.name, ["key", field.name]);
        if (value === undefined || value === null) throw encodingError("missing-key", ["key", field.name]);
        return `${field.name}=${encodeKeyPrimitive(value, field, model, ["key", field.name])}`;
      })
      .join(",");
  }

  return { literal, pathSegment: encodePathSegment(literal, ["key"]) };
}

function codecModel(metadata: HonuaOdataMetadata, requestedEntitySet: string): OdataCodecModel {
  const suffix = requestedEntitySet.slice(requestedEntitySet.lastIndexOf("/") + 1);
  const entitySet = Object.hasOwn(metadata.entitySets, requestedEntitySet) ? requestedEntitySet : suffix;
  const entityType = ownLookup(metadata.entitySets, entitySet);
  if (typeof entityType !== "string" || entityType.length === 0) throw encodingError("unknown-entity-set", []);
  const details = getOdataSourceSchemaProjectionDetails(metadata);
  const safety = getOdataSourceSchemaProjectionSafety(metadata);
  if (safety?.csdlVersion !== undefined && safety.csdlVersion !== "4.0" && safety.csdlVersion !== "4.01") {
    throw encodingError("invalid-metadata", []);
  }
  const unsafeTypeNames = new Set([
    ...(safety?.ambiguousTypeNames ?? []),
    ...(safety?.inheritedTypeNames ?? []),
    ...(safety?.openComplexTypeNames ?? []),
    ...(safety?.unqualifiedTypeNames ?? []),
  ]);
  if (unsafeTypeNames.has(entityType)) throw encodingError("invalid-metadata", []);
  const fields = ownLookup(details?.fields ?? metadata.fields, entityType);
  if (!fields) throw encodingError("invalid-metadata", []);
  return {
    entityType,
    fields,
    keys: ownLookup(metadata.keys, entityType) ?? [],
    complexTypes: details?.complexTypes ?? metadata.complexTypes ?? Object.freeze({}),
    enumTypes: details?.enumTypes ?? metadata.enumTypes ?? Object.freeze({}),
    unsafeTypeNames,
  };
}

function encodingContext(options: HonuaOdataEdmEncodingOptions): EncodingContext {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_CONFIGURED_DEPTH) {
    throw encodingError("invalid-options", ["options", "maxDepth"]);
  }
  return { maxDepth, ancestors: new WeakSet(), requiresIeee754Compatible: false };
}

function encodeStructuredValue(
  value: unknown,
  fields: readonly HonuaOdataFieldInfo[],
  model: OdataCodecModel,
  path: readonly (string | number)[],
  depth: number,
  context: EncodingContext,
): Record<string, unknown> {
  if (!isRecord(value)) throw encodingError("invalid-value", path);
  enterContainer(value, path, depth, context);
  try {
    const declared = new Map(fields.map((field) => [field.name, field]));
    const output: Record<string, unknown> = {};
    for (const name of Object.keys(value)) {
      const childPath = [...path, name];
      const input = ownDataProperty(value, name, childPath);
      const field = declared.get(name);
      const encoded = field
        ? encodeTypedValue(input, field, model, childPath, depth, context, field.nullable !== false)
        : encodeUntypedValue(input, childPath, depth, context);
      defineEnumerableValue(output, name, encoded);
    }
    return output;
  } finally {
    context.ancestors.delete(value);
  }
}

function encodeTypedValue(
  value: unknown,
  field: HonuaOdataFieldInfo,
  model: OdataCodecModel,
  path: readonly (string | number)[],
  depth: number,
  context: EncodingContext,
  nullable: boolean,
): unknown {
  if (value === null) {
    if (!nullable) throw encodingError("invalid-value", path);
    return null;
  }
  if (value === undefined) throw encodingError("invalid-value", path);

  const collectionType = unwrapCollection(field.type);
  if (collectionType !== undefined) {
    if (!Array.isArray(value)) throw encodingError("invalid-value", path);
    const childDepth = nextDepth(path, depth, context);
    enterContainer(value, path, childDepth, context);
    try {
      const itemField: HonuaOdataFieldInfo = { ...field, type: collectionType, nullable: true };
      return value.map((item, index) =>
        encodeTypedValue(item, itemField, model, [...path, index], childDepth, context, true),
      );
    } finally {
      context.ancestors.delete(value);
    }
  }

  const localType = stripNamespace(field.type);
  if (!field.type.startsWith("Edm.") && model.unsafeTypeNames.has(localType)) {
    throw encodingError("invalid-metadata", path);
  }
  const complexFields = ownLookup(model.complexTypes, localType);
  if (complexFields) {
    return encodeStructuredValue(value, complexFields, model, path, nextDepth(path, depth, context), context);
  }

  if (ownLookup(model.enumTypes, localType)) {
    if (typeof value !== "string" || value.length === 0) throw encodingError("invalid-value", path);
    return value;
  }

  const integerBounds = INTEGER_BOUNDS[field.type];
  if (integerBounds) {
    const integer = exactInteger(value, integerBounds, path);
    if (field.type === "Edm.Int64") {
      context.requiresIeee754Compatible = true;
      return integer.toString();
    }
    return Number(integer);
  }

  switch (field.type) {
    case "Edm.Decimal": {
      const decimal = exactDecimal(value, field, path);
      context.requiresIeee754Compatible = true;
      return decimal;
    }
    case "Edm.Single":
    case "Edm.Double":
      return floatingJsonValue(value, path);
    case "Edm.Guid":
      return guidValue(value, path);
    case "Edm.String":
      if (typeof value !== "string") throw encodingError("invalid-value", path);
      if (typeof field.maxLength === "number" && codePointLengthExceeds(value, field.maxLength)) {
        throw encodingError("invalid-value", path);
      }
      return value;
    case "Edm.Boolean":
      if (typeof value !== "boolean") throw encodingError("invalid-value", path);
      return value;
    case "Edm.Binary":
      return validatedString(value, BINARY_LEXEME, path);
    case "Edm.Date":
      return validatedString(value, DATE_LEXEME, path);
    case "Edm.DateTimeOffset":
      return validatedString(value, DATE_TIME_OFFSET_LEXEME, path);
    case "Edm.Duration":
      return validatedString(value, DURATION_LEXEME, path);
    case "Edm.TimeOfDay":
      return validatedString(value, TIME_OF_DAY_LEXEME, path);
    case "Edm.Geography":
    case "Edm.GeographyPoint":
    case "Edm.GeographyLineString":
    case "Edm.GeographyPolygon":
    case "Edm.GeographyMultiPoint":
    case "Edm.GeographyMultiLineString":
    case "Edm.GeographyMultiPolygon":
    case "Edm.GeographyCollection":
    case "Edm.Geometry":
    case "Edm.GeometryPoint":
    case "Edm.GeometryLineString":
    case "Edm.GeometryPolygon":
    case "Edm.GeometryMultiPoint":
    case "Edm.GeometryMultiLineString":
    case "Edm.GeometryMultiPolygon":
    case "Edm.GeometryCollection":
    case "Edm.Untyped":
      return encodeUntypedValue(value, path, depth, context);
    default:
      throw encodingError("unsupported-type", path);
  }
}

function encodeUntypedValue(
  value: unknown,
  path: readonly (string | number)[],
  depth: number,
  context: EncodingContext,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw encodingError("invalid-value", path);
    return value;
  }
  if (Array.isArray(value)) {
    const childDepth = nextDepth(path, depth, context);
    enterContainer(value, path, childDepth, context);
    try {
      return value.map((item, index) => encodeUntypedValue(item, [...path, index], childDepth, context));
    } finally {
      context.ancestors.delete(value);
    }
  }
  if (isRecord(value)) {
    return encodeStructuredValue(value, [], emptyCodecModel(), path, nextDepth(path, depth, context), context);
  }
  throw encodingError("invalid-value", path);
}

function encodeKeyPrimitive(
  value: unknown,
  field: HonuaOdataFieldInfo,
  model: OdataCodecModel,
  path: readonly (string | number)[],
): string {
  if (unwrapCollection(field.type) !== undefined || ownLookup(model.complexTypes, stripNamespace(field.type))) {
    throw encodingError("unsupported-type", path);
  }

  if (!field.type.startsWith("Edm.") && model.unsafeTypeNames.has(stripNamespace(field.type))) {
    throw encodingError("invalid-metadata", path);
  }

  const integerBounds = INTEGER_BOUNDS[field.type];
  if (integerBounds) return exactInteger(value, integerBounds, path).toString();

  if (ownLookup(model.enumTypes, stripNamespace(field.type))) {
    if (!qualifiedIdentifier(field.type) || typeof value !== "string" || value.length === 0) {
      throw encodingError("invalid-value", path);
    }
    return `${field.type}'${escapeOdataString(value)}'`;
  }

  switch (field.type) {
    case "Edm.Decimal":
      return exactDecimal(value, field, path);
    case "Edm.Single":
    case "Edm.Double":
      return floatingKeyValue(value, path);
    case "Edm.Guid":
      return guidValue(value, path);
    case "Edm.String": {
      if (typeof value !== "string") throw encodingError("invalid-value", path);
      if (typeof field.maxLength === "number" && codePointLengthExceeds(value, field.maxLength)) {
        throw encodingError("invalid-value", path);
      }
      return `'${escapeOdataString(value)}'`;
    }
    case "Edm.Boolean":
      if (typeof value !== "boolean") throw encodingError("invalid-value", path);
      return value ? "true" : "false";
    case "Edm.Binary":
      return `binary'${validatedString(value, BINARY_LEXEME, path)}'`;
    case "Edm.Date":
      return validatedString(value, DATE_LEXEME, path);
    case "Edm.DateTimeOffset":
      return validatedString(value, DATE_TIME_OFFSET_LEXEME, path);
    case "Edm.Duration":
      return `duration'${validatedString(value, DURATION_LEXEME, path)}'`;
    case "Edm.TimeOfDay":
      return validatedString(value, TIME_OF_DAY_LEXEME, path);
    default:
      throw encodingError("unsupported-type", path);
  }
}

function exactInteger(
  value: unknown,
  bounds: { readonly minimum: bigint; readonly maximum: bigint },
  path: readonly (string | number)[],
): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw encodingError("invalid-value", path);
    parsed = BigInt(value);
  } else if (typeof value === "string" && value.length <= 20 && INTEGER_LEXEME.test(value)) {
    try {
      parsed = BigInt(value);
    } catch {
      throw encodingError("invalid-value", path);
    }
  } else {
    throw encodingError("invalid-value", path);
  }
  if (parsed < bounds.minimum || parsed > bounds.maximum) throw encodingError("invalid-value", path);
  return parsed;
}

function exactDecimal(value: unknown, field: HonuaOdataFieldInfo, path: readonly (string | number)[]): string {
  let lexeme: string;
  if (typeof value === "bigint") lexeme = value.toString();
  else if (typeof value === "number" && Number.isFinite(value)) lexeme = numberToPlainDecimal(value);
  else if (typeof value === "string") lexeme = value;
  else throw encodingError("invalid-value", path);

  const shape = decimalShape(lexeme);
  if (!shape) throw encodingError("invalid-value", path);
  if (typeof field.precision === "number" && shape.digits > field.precision) {
    throw encodingError("invalid-value", path);
  }
  if (typeof field.scale === "number" && shape.fractionalDigits > field.scale) {
    throw encodingError("invalid-value", path);
  }
  return lexeme;
}

function decimalShape(value: string): { readonly digits: number; readonly fractionalDigits: number } | undefined {
  if (value.length === 0 || value.length > MAX_DECIMAL_LEXEME_CHARACTERS) return undefined;
  let index = value[0] === "-" ? 1 : 0;
  if (index === value.length) return undefined;
  let digits = 0;
  let totalDigits = 0;
  let fractionalDigits = 0;
  let sawDot = false;
  let digitsAfterDot = 0;
  let sawNonZero = false;
  for (; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 48 && code <= 57) {
      totalDigits += 1;
      if (code !== 48) sawNonZero = true;
      if (sawNonZero) digits += 1;
      if (sawDot) {
        fractionalDigits += 1;
        digitsAfterDot += 1;
      }
      continue;
    }
    if (value[index] === "." && !sawDot && totalDigits > 0) {
      sawDot = true;
      continue;
    }
    return undefined;
  }
  if (totalDigits === 0 || (sawDot && digitsAfterDot === 0)) return undefined;
  return { digits: Math.max(1, digits), fractionalDigits };
}

function numberToPlainDecimal(value: number): string {
  if (Object.is(value, -0)) return "0";
  const raw = String(value);
  if (!/[eE]/.test(raw)) return raw;
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(raw);
  if (!match) return raw;
  const sign = match[1] ?? "";
  const integer = match[2] ?? "";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4]);
  const digits = `${integer}${fraction}`;
  const decimalPosition = integer.length + exponent;
  if (decimalPosition <= 0) return `${sign}0.${"0".repeat(-decimalPosition)}${digits}`;
  if (decimalPosition >= digits.length) return `${sign}${digits}${"0".repeat(decimalPosition - digits.length)}`;
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

function floatingJsonValue(value: unknown, path: readonly (string | number)[]): number | string {
  if (typeof value === "string") {
    if (value === "INF" || value === "-INF" || value === "NaN") return value;
    if (!JSON_NUMBER_LEXEME.test(value)) throw encodingError("invalid-value", path);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw encodingError("invalid-value", path);
    return parsed;
  }
  if (typeof value !== "number") throw encodingError("invalid-value", path);
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "INF";
  if (value === Number.NEGATIVE_INFINITY) return "-INF";
  return value;
}

function floatingKeyValue(value: unknown, path: readonly (string | number)[]): string {
  if (typeof value === "string") {
    if (value === "INF" || value === "-INF" || value === "NaN") return value;
    if (!JSON_NUMBER_LEXEME.test(value) || !Number.isFinite(Number(value))) {
      throw encodingError("invalid-value", path);
    }
    return value;
  }
  const encoded = floatingJsonValue(value, path);
  return typeof encoded === "number" ? String(encoded) : encoded;
}

function guidValue(value: unknown, path: readonly (string | number)[]): string {
  if (typeof value !== "string" || !GUID_LEXEME.test(value)) throw encodingError("invalid-value", path);
  return value;
}

function validatedString(value: unknown, pattern: RegExp, path: readonly (string | number)[]): string {
  if (typeof value !== "string" || !pattern.test(value)) throw encodingError("invalid-value", path);
  return value;
}

function ownDataProperty(
  value: Readonly<Record<string, unknown>>,
  name: string,
  path: readonly (string | number)[],
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw encodingError("invalid-value", path);
  return descriptor.value;
}

function enterContainer(
  value: object,
  path: readonly (string | number)[],
  depth: number,
  context: EncodingContext,
): void {
  if (depth > context.maxDepth) throw encodingError("max-depth-exceeded", path);
  if (context.ancestors.has(value)) throw encodingError("cyclic-value", path);
  context.ancestors.add(value);
}

function nextDepth(path: readonly (string | number)[], depth: number, context: EncodingContext): number {
  const next = depth + 1;
  if (next > context.maxDepth) throw encodingError("max-depth-exceeded", path);
  return next;
}

function defineEnumerableValue(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function encodePathSegment(value: string, path: readonly (string | number)[]): string {
  try {
    return encodeURIComponent(value).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    throw encodingError("invalid-value", path);
  }
}

function escapeOdataString(value: string): string {
  return value.replace(/'/g, "''");
}

function unwrapCollection(type: string): string | undefined {
  if (!type.startsWith("Collection(") || !type.endsWith(")")) return undefined;
  const inner = type.slice("Collection(".length, -1);
  return inner.length > 0 ? inner : undefined;
}

function stripNamespace(type: string): string {
  const dot = type.lastIndexOf(".");
  return dot === -1 ? type : type.slice(dot + 1);
}

function simpleIdentifier(value: string): boolean {
  return value.length <= 256 && SIMPLE_IDENTIFIER.test(value);
}

function qualifiedIdentifier(value: string): boolean {
  return value.length <= 512 && QUALIFIED_IDENTIFIER.test(value);
}

function codePointLengthExceeds(value: string, maximum: number): boolean {
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > maximum) return true;
  }
  return false;
}

function ownLookup<T>(record: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function emptyCodecModel(): OdataCodecModel {
  return {
    entityType: "",
    fields: [],
    keys: [],
    complexTypes: Object.freeze({}),
    enumTypes: Object.freeze({}),
    unsafeTypeNames: new Set(),
  };
}

function encodingError(
  code: HonuaOdataEdmEncodingErrorCode,
  path: readonly (string | number)[],
): HonuaOdataEdmEncodingError {
  return new HonuaOdataEdmEncodingError(code, renderPath(path));
}

function renderPath(path: readonly (string | number)[]): string {
  let rendered = "$";
  for (const segment of path) {
    if (typeof segment === "number") {
      rendered += `[${segment}]`;
      continue;
    }
    const safe = boundedPathSegment(segment);
    rendered += /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(safe) ? `.${safe}` : `[${JSON.stringify(safe)}]`;
  }
  return rendered;
}

function boundedPathSegment(value: string): string {
  let output = "";
  let length = 0;
  for (const character of value) {
    if (length >= MAX_ERROR_PATH_SEGMENT_CODE_POINTS) return `${output}…`;
    output += character;
    length += 1;
  }
  return output;
}

function encodingErrorReason(code: HonuaOdataEdmEncodingErrorCode): string {
  switch (code) {
    case "cyclic-value":
      return "cyclic values are not supported";
    case "invalid-metadata":
      return "the metadata declaration is incomplete or inconsistent";
    case "invalid-options":
      return "the encoder option is outside its supported bound";
    case "invalid-value":
      return "the value does not match its declared EDM type";
    case "max-depth-exceeded":
      return "the maximum nesting depth was exceeded";
    case "missing-key":
      return "a required key component is missing";
    case "unknown-entity-set":
      return "the metadata snapshot does not declare the entity set";
    case "unsupported-type":
      return "the declared EDM type is not supported for this operation";
  }
}
