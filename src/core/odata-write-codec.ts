/**
 * Metadata-driven OData write encoding primitives.
 *
 * This module deliberately has no transport dependencies. Callers supply the
 * already-cached CSDL projection and decide how to attach the encoded body,
 * content type, and key to an HTTP request.
 */

import { encodeOdataKeyPredicatePath } from "./odata-key-path.js";
import {
  type HonuaOdataEnumTypeInfo,
  type HonuaOdataFieldInfo,
  type HonuaOdataMetadata,
  getOdataSourceSchemaProjectionDetails,
  getOdataSourceSchemaProjectionSafety,
} from "./odata.js";

const DEFAULT_MAX_DEPTH = 32;
const MAX_CONFIGURED_DEPTH = 32;
const MAX_CONTAINER_ITEMS = 10_000;
const MAX_ENCODED_VALUE_NODES = 20_000;
const MAX_ERROR_PATH_SEGMENT_CODE_POINTS = 64;
const MAX_DECIMAL_LEXEME_CHARACTERS = 1_024;
const MAX_TEMPORAL_LEXEME_CHARACTERS = 1_024;
const MAX_ENTITY_SET_PATH_CODE_UNITS = 2_048;
const UNDECLARED_PROPERTY_PATH_SEGMENT = "<undeclared-property>";

const GUID_LEXEME = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const JSON_NUMBER_LEXEME = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const INTEGER_LEXEME = /^-?(?:0|[1-9]\d*)$/;
const ENUM_INTEGER_LEXEME = /^[+-]?\d{1,20}$/;
const DATE_LEXEME = /^(-?(?:0\d{3}|[1-9]\d{3,}))-(\d{2})-(\d{2})$/;
const TIME_OF_DAY_LEXEME = /^(?:[01]\d|2[0-3]):[0-5]\d(?::(?:[0-5]\d|60)(?:\.(\d{1,12}))?)?$/;
const DATE_TIME_OFFSET_LEXEME =
  /^(-?(?:0\d{3}|[1-9]\d{3,})-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.(\d{1,12}))?)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;
const DURATION_LEXEME = /^[+-]?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d+))?S)?)?$/;
const BASE64URL_LEXEME = /^[A-Za-z0-9_-]*$/;
const BASE64URL_B16_LAST = /^[AEIMQUYcgkosw048]$/;
const BASE64URL_B8_LAST = /^[AQgw]$/;
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

function integerBounds(type: string): { readonly minimum: bigint; readonly maximum: bigint } | undefined {
  return Object.hasOwn(INTEGER_BOUNDS, type) ? INTEGER_BOUNDS[type] : undefined;
}

/** Stable failure categories for local, pre-transport encoding errors. */
export type HonuaOdataEdmEncodingErrorCode =
  | "cyclic-value"
  | "invalid-metadata"
  | "invalid-options"
  | "invalid-value"
  | "max-depth-exceeded"
  | "missing-key"
  | "resource-limit-exceeded"
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

/**
 * Controls the hard recursion bound for complex, collection, and untyped
 * values. Fixed breadth and aggregate-node budgets also protect every call.
 */
export interface HonuaOdataEdmEncodingOptions {
  /** Maximum nested container depth. Defaults to and cannot exceed 32. */
  readonly maxDepth?: number;
}

/** Controls metadata-typed entity-key encoding. */
export interface HonuaOdataEntityKeyEncodingOptions extends HonuaOdataEdmEncodingOptions {
  /**
   * Ordered metadata key fields to place in this URL predicate. Omit this for
   * a direct entity set. Navigation paths may provide the child-key subset
   * because the parent key is already carried by the path.
   */
  readonly keyFields?: readonly string[];
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
  nodes: number;
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
  try {
    const context = encodingContext(options);
    const model = codecModel(metadata, entitySet);
    const encoded = encodeStructuredValue(body, model.fields, model, [], 0, context);
    return { body: encoded, requiresIeee754Compatible: context.requiresIeee754Compatible };
  } catch (error) {
    rethrowEncodingError(error, "invalid-value", []);
  }
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
  options: HonuaOdataEntityKeyEncodingOptions = {},
): HonuaOdataEncodedEntityKey {
  try {
    const model = codecModel(metadata, entitySet);
    const configuredKeyFields = dataProperty(options, "keyFields", ["options", "keyFields"], "invalid-options");
    const keys =
      configuredKeyFields === undefined
        ? model.keys
        : keyFieldOverride(configuredKeyFields, model.keys, ["options", "keyFields"]);
    if (keys.length === 0) throw encodingError("invalid-metadata", ["key"]);
    if (new Set(keys).size !== keys.length) throw encodingError("invalid-metadata", ["key"]);

    const fields = new Map(model.fields.map((field) => [field.name, field]));
    const keyFields = keys.map((name) => {
      if (!simpleIdentifier(name)) throw encodingError("invalid-metadata", ["key"]);
      const field = fields.get(name);
      if (!field) throw encodingError("invalid-metadata", ["key", name]);
      return field;
    });

    let literal: string;
    if (keyFields.length === 1) {
      const field = keyFields[0]!;
      const value = isRecord(key, ["key"]) ? ownDataProperty(key, field.name, ["key", field.name]) : key;
      if (value === undefined || value === null) throw encodingError("missing-key", ["key", field.name]);
      literal = encodeKeyPrimitive(value, field, model, ["key", field.name]);
    } else {
      if (!isRecord(key, ["key"])) throw encodingError("missing-key", ["key"]);
      literal = keyFields
        .map((field) => {
          const value = ownDataProperty(key, field.name, ["key", field.name]);
          if (value === undefined || value === null) throw encodingError("missing-key", ["key", field.name]);
          return `${field.name}=${encodeKeyPrimitive(value, field, model, ["key", field.name])}`;
        })
        .join(",");
    }

    return { literal, pathSegment: encodePathSegment(literal, ["key"]) };
  } catch (error) {
    rethrowEncodingError(error, "invalid-value", ["key"]);
  }
}

function keyFieldOverride(
  value: unknown,
  declaredKeys: readonly string[],
  path: readonly (string | number)[],
): readonly string[] {
  if (!Array.isArray(value)) throw encodingError("invalid-options", path);
  const fields = arrayDataValues(value, path, "invalid-options");
  if (
    fields.length === 0 ||
    fields.some((field) => typeof field !== "string") ||
    new Set(fields).size !== fields.length
  ) {
    throw encodingError("invalid-options", path);
  }
  const selected = new Set(fields as string[]);
  const ordered = declaredKeys.filter((field) => selected.has(field));
  if (ordered.length !== fields.length || ordered.some((field, index) => field !== fields[index])) {
    throw encodingError("invalid-options", path);
  }
  return ordered;
}

function codecModel(metadata: HonuaOdataMetadata, requestedEntitySet: string): OdataCodecModel {
  try {
    return uncheckedCodecModel(metadata, requestedEntitySet);
  } catch (error) {
    rethrowEncodingError(error, "invalid-metadata", []);
  }
}

function uncheckedCodecModel(metadata: HonuaOdataMetadata, requestedEntitySet: string): OdataCodecModel {
  if (
    typeof requestedEntitySet !== "string" ||
    requestedEntitySet.length === 0 ||
    requestedEntitySet.length > MAX_ENTITY_SET_PATH_CODE_UNITS
  ) {
    throw encodingError("unknown-entity-set", []);
  }
  const metadataRecord = plainDataRecord(metadata, [], "invalid-metadata");
  const suffix = requestedEntitySet.slice(requestedEntitySet.lastIndexOf("/") + 1);
  const entitySets = plainDataRecord(
    dataProperty(metadataRecord, "entitySets", [], "invalid-metadata"),
    [],
    "invalid-metadata",
  );
  const entityType = ownLookup(entitySets, requestedEntitySet) ?? ownLookup(entitySets, suffix);
  if (typeof entityType !== "string" || !qualifiedIdentifier(entityType)) {
    throw encodingError("unknown-entity-set", []);
  }
  const detailsValue = getOdataSourceSchemaProjectionDetails(metadata);
  const details = detailsValue === undefined ? undefined : plainDataRecord(detailsValue, [], "invalid-metadata");
  const safetyValue = getOdataSourceSchemaProjectionSafety(metadata);
  const safety = safetyValue === undefined ? undefined : plainDataRecord(safetyValue, [], "invalid-metadata");
  const csdlVersion = safety ? dataProperty(safety, "csdlVersion", [], "invalid-metadata") : undefined;
  if (csdlVersion !== undefined && csdlVersion !== "4.0" && csdlVersion !== "4.01") {
    throw encodingError("invalid-metadata", []);
  }
  const unsafeTypeNames = new Set<string>();
  if (safety) {
    for (const property of [
      "ambiguousTypeNames",
      "inheritedTypeNames",
      "openComplexTypeNames",
      "unqualifiedTypeNames",
    ] as const) {
      const names = metadataStringArray(dataProperty(safety, property, [], "invalid-metadata"), []);
      for (const name of names) unsafeTypeNames.add(name);
    }
  }
  if (unsafeTypeNames.has(entityType)) throw encodingError("invalid-metadata", []);
  const fieldsRecord = plainDataRecord(
    details
      ? dataProperty(details, "fields", [], "invalid-metadata")
      : dataProperty(metadataRecord, "fields", [], "invalid-metadata"),
    [],
    "invalid-metadata",
  );
  const fields = metadataFieldArray(ownLookup(fieldsRecord, entityType), []);
  const keysRecord = plainDataRecord(
    dataProperty(metadataRecord, "keys", [], "invalid-metadata"),
    [],
    "invalid-metadata",
  );
  const complexTypes = plainDataRecord(
    details
      ? dataProperty(details, "complexTypes", [], "invalid-metadata")
      : (dataProperty(metadataRecord, "complexTypes", [], "invalid-metadata") ?? Object.freeze({})),
    [],
    "invalid-metadata",
  ) as Readonly<Record<string, readonly HonuaOdataFieldInfo[]>>;
  const enumTypes = plainDataRecord(
    details
      ? dataProperty(details, "enumTypes", [], "invalid-metadata")
      : (dataProperty(metadataRecord, "enumTypes", [], "invalid-metadata") ?? Object.freeze({})),
    [],
    "invalid-metadata",
  ) as NonNullable<HonuaOdataMetadata["enumTypes"]>;
  return {
    entityType,
    fields,
    keys: metadataStringArray(ownLookup(keysRecord, entityType) ?? [], []),
    complexTypes,
    enumTypes,
    unsafeTypeNames,
  };
}

function encodingContext(options: HonuaOdataEdmEncodingOptions): EncodingContext {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw encodingError("invalid-options", ["options"]);
  }
  const configuredDepth = dataProperty(options, "maxDepth", ["options", "maxDepth"], "invalid-options");
  const maxDepth = configuredDepth === undefined ? DEFAULT_MAX_DEPTH : configuredDepth;
  if (
    typeof maxDepth !== "number" ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > MAX_CONFIGURED_DEPTH
  ) {
    throw encodingError("invalid-options", ["options", "maxDepth"]);
  }
  return { maxDepth, ancestors: new WeakSet(), nodes: 1, requiresIeee754Compatible: false };
}

function encodeStructuredValue(
  value: unknown,
  fields: readonly HonuaOdataFieldInfo[],
  model: OdataCodecModel,
  path: readonly (string | number)[],
  depth: number,
  context: EncodingContext,
): Record<string, unknown> {
  if (!isRecord(value, path)) throw encodingError("invalid-value", path);
  enterContainer(value, path, depth, context);
  try {
    const declared = new Map(fields.map((field) => [field.name, field]));
    const output: Record<string, unknown> = {};
    for (const name of objectKeys(value, path)) {
      const field = declared.get(name);
      const childPath = [...path, field ? field.name : UNDECLARED_PROPERTY_PATH_SEGMENT];
      consumeValueNode(childPath, context);
      const input = ownDataProperty(value, name, childPath);
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
      return arrayDataValues(value, path).map((item, index) => {
        const childPath = [...path, index];
        consumeValueNode(childPath, context);
        return encodeTypedValue(item, itemField, model, childPath, childDepth, context, true);
      });
    } finally {
      context.ancestors.delete(value);
    }
  }

  const localType = stripNamespace(field.type);
  if (!field.type.startsWith("Edm.") && model.unsafeTypeNames.has(localType)) {
    throw encodingError("invalid-metadata", path);
  }
  const complexDeclaration = ownLookup(model.complexTypes, localType);
  if (complexDeclaration !== undefined) {
    const complexFields = metadataFieldArray(complexDeclaration, path);
    return encodeStructuredValue(value, complexFields, model, path, nextDepth(path, depth, context), context);
  }

  const enumType = ownLookup(model.enumTypes, localType);
  if (enumType) {
    if (!qualifiedIdentifier(field.type)) throw encodingError("invalid-metadata", path);
    return enumValue(value, enumType, path);
  }

  const bounds = integerBounds(field.type);
  if (bounds) {
    const integer = exactInteger(value, bounds, path);
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
      return singleJsonValue(value, path);
    case "Edm.Double":
      return doubleJsonValue(value, path);
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
      return binaryValue(value, field, path);
    case "Edm.Date":
      return dateValue(value, path);
    case "Edm.DateTimeOffset":
      return dateTimeOffsetValue(value, field, path);
    case "Edm.Duration":
      return durationValue(value, field, path);
    case "Edm.TimeOfDay":
      return timeOfDayValue(value, field, path);
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
      return arrayDataValues(value, path).map((item, index) => {
        const childPath = [...path, index];
        consumeValueNode(childPath, context);
        return encodeUntypedValue(item, childPath, childDepth, context);
      });
    } finally {
      context.ancestors.delete(value);
    }
  }
  if (isRecord(value, path)) {
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
  if (
    unwrapCollection(field.type) !== undefined ||
    ownLookup(model.complexTypes, stripNamespace(field.type)) !== undefined
  ) {
    throw encodingError("unsupported-type", path);
  }

  if (!field.type.startsWith("Edm.") && model.unsafeTypeNames.has(stripNamespace(field.type))) {
    throw encodingError("invalid-metadata", path);
  }

  const bounds = integerBounds(field.type);
  if (bounds) return exactInteger(value, bounds, path).toString();

  const enumType = ownLookup(model.enumTypes, stripNamespace(field.type));
  if (enumType) {
    if (!qualifiedIdentifier(field.type)) throw encodingError("invalid-metadata", path);
    return `${field.type}'${escapeOdataString(enumValue(value, enumType, path))}'`;
  }

  switch (field.type) {
    case "Edm.Decimal":
      return exactDecimal(value, field, path);
    case "Edm.Single":
      return singleKeyValue(value, path);
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
      return `binary'${binaryValue(value, field, path)}'`;
    case "Edm.Date":
      return dateValue(value, path);
    case "Edm.DateTimeOffset":
      return dateTimeOffsetValue(value, field, path);
    case "Edm.Duration":
      return `duration'${durationValue(value, field, path)}'`;
    case "Edm.TimeOfDay":
      return timeOfDayValue(value, field, path);
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

function validatedSingleValue(value: unknown, path: readonly (string | number)[]): number | string {
  const encoded = floatingJsonValue(value, path);
  if (typeof encoded === "string") return encoded;

  // Edm.Single's value space is IEEE-754 binary32. Admitting an arbitrary
  // binary64 Number here would silently round during server decoding, which
  // contradicts the opt-in codec's lossless contract. Callers can make that
  // conversion explicit with Math.fround before encoding.
  if (!Object.is(Math.fround(encoded), encoded)) throw encodingError("invalid-value", path);
  return encoded;
}

function singleJsonValue(value: unknown, path: readonly (string | number)[]): number | string {
  const encoded = validatedSingleValue(value, path);
  if (typeof encoded === "number" && Object.is(encoded, -0)) {
    // JSON.stringify(-0) emits 0, so the body projection cannot preserve the
    // IEEE-754 sign bit without violating OData's JSON-number requirement.
    throw encodingError("invalid-value", path);
  }
  return encoded;
}

function doubleJsonValue(value: unknown, path: readonly (string | number)[]): number | string {
  const encoded = floatingJsonValue(value, path);
  if (typeof encoded === "number" && Object.is(encoded, -0)) {
    // JSON.stringify(-0) emits 0. OData requires finite Double values to be
    // JSON numbers, so failing locally is the only lossless representation.
    throw encodingError("invalid-value", path);
  }
  return encoded;
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
  if (typeof encoded === "number" && Object.is(encoded, -0)) return "-0";
  return typeof encoded === "number" ? String(encoded) : encoded;
}

function singleKeyValue(value: unknown, path: readonly (string | number)[]): string {
  const encoded = validatedSingleValue(value, path);
  if (typeof encoded === "string") return encoded;
  if (Object.is(encoded, -0)) return "-0";
  return typeof value === "string" ? value : String(encoded);
}

function guidValue(value: unknown, path: readonly (string | number)[]): string {
  if (typeof value !== "string" || !GUID_LEXEME.test(value)) throw encodingError("invalid-value", path);
  return value;
}

function binaryValue(value: unknown, field: HonuaOdataFieldInfo, path: readonly (string | number)[]): string {
  if (typeof value !== "string") throw encodingError("invalid-value", path);
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const unpadded = padding === 0 ? value : value.slice(0, -padding);
  if (!BASE64URL_LEXEME.test(unpadded)) throw encodingError("invalid-value", path);

  const remainder = unpadded.length % 4;
  if (
    remainder === 1 ||
    (padding === 1 && remainder !== 3) ||
    (padding === 2 && remainder !== 2) ||
    (remainder === 2 && !BASE64URL_B8_LAST.test(unpadded.at(-1) ?? "")) ||
    (remainder === 3 && !BASE64URL_B16_LAST.test(unpadded.at(-1) ?? ""))
  ) {
    throw encodingError("invalid-value", path);
  }

  if (typeof field.maxLength === "number") {
    if (!Number.isSafeInteger(field.maxLength) || field.maxLength < 0) {
      throw encodingError("invalid-metadata", path);
    }
    if (Math.floor((unpadded.length * 3) / 4) > field.maxLength) {
      throw encodingError("invalid-value", path);
    }
  }
  return value;
}

function dateValue(value: unknown, path: readonly (string | number)[]): string {
  if (typeof value !== "string" || value.length > MAX_TEMPORAL_LEXEME_CHARACTERS) {
    throw encodingError("invalid-value", path);
  }
  const match = DATE_LEXEME.exec(value);
  if (!match || !validCalendarDate(match[1]!, match[2]!, match[3]!)) {
    throw encodingError("invalid-value", path);
  }
  return value;
}

function dateTimeOffsetValue(value: unknown, field: HonuaOdataFieldInfo, path: readonly (string | number)[]): string {
  if (typeof value !== "string" || value.length > MAX_TEMPORAL_LEXEME_CHARACTERS) {
    throw encodingError("invalid-value", path);
  }
  const match = DATE_TIME_OFFSET_LEXEME.exec(value);
  if (!match) throw encodingError("invalid-value", path);
  dateValue(match[1], path);
  validateTemporalPrecision(match[2], field, path);
  return value;
}

function durationValue(value: unknown, field: HonuaOdataFieldInfo, path: readonly (string | number)[]): string {
  if (typeof value !== "string" || value.length > MAX_TEMPORAL_LEXEME_CHARACTERS) {
    throw encodingError("invalid-value", path);
  }
  const match = DURATION_LEXEME.exec(value);
  const hasTimeDesignator = value.includes("T");
  const hasTimeComponent = match?.[2] !== undefined || match?.[3] !== undefined || match?.[4] !== undefined;
  if (!match || (match[1] === undefined && !hasTimeComponent) || (hasTimeDesignator && !hasTimeComponent)) {
    throw encodingError("invalid-value", path);
  }
  validateTemporalPrecision(match[5], field, path);
  return value;
}

function timeOfDayValue(value: unknown, field: HonuaOdataFieldInfo, path: readonly (string | number)[]): string {
  if (typeof value !== "string" || value.length > MAX_TEMPORAL_LEXEME_CHARACTERS) {
    throw encodingError("invalid-value", path);
  }
  const match = TIME_OF_DAY_LEXEME.exec(value);
  if (!match) throw encodingError("invalid-value", path);
  validateTemporalPrecision(match[1], field, path);
  return value;
}

function validCalendarDate(year: string, monthLexeme: string, dayLexeme: string): boolean {
  const month = Number(monthLexeme);
  const day = Number(dayLexeme);
  if (!Number.isSafeInteger(month) || month < 1 || month > 12 || !Number.isSafeInteger(day) || day < 1) {
    return false;
  }
  const maximumDay =
    month === 2 ? (isLeapYear(year) ? 29 : 28) : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
  return day <= maximumDay;
}

function isLeapYear(year: string): boolean {
  const unsigned = year.startsWith("-") ? year.slice(1) : year;
  const finalFourDigits = Number(unsigned.slice(-4));
  return finalFourDigits % 4 === 0 && (finalFourDigits % 100 !== 0 || finalFourDigits % 400 === 0);
}

function validateTemporalPrecision(
  fraction: string | undefined,
  field: HonuaOdataFieldInfo,
  path: readonly (string | number)[],
): void {
  const precision = field.precision ?? 0;
  if (!Number.isSafeInteger(precision) || precision < 0 || precision > 12) {
    throw encodingError("invalid-metadata", path);
  }
  if ((fraction?.length ?? 0) > precision) throw encodingError("invalid-value", path);
}

interface ValidatedEnumMember {
  readonly name: string;
  readonly value: bigint;
}

interface ValidatedEnumType {
  readonly bounds: { readonly minimum: bigint; readonly maximum: bigint };
  readonly isFlags: boolean;
  readonly members: readonly ValidatedEnumMember[];
}

function enumValue(value: unknown, enumType: HonuaOdataEnumTypeInfo, path: readonly (string | number)[]): string {
  if (typeof value !== "string" || value.length === 0) throw encodingError("invalid-value", path);
  const validated = validatedEnumType(enumType, path);

  if (ENUM_INTEGER_LEXEME.test(value)) {
    let parsed: bigint;
    try {
      parsed = BigInt(value);
    } catch {
      throw encodingError("invalid-value", path);
    }
    if (parsed < validated.bounds.minimum || parsed > validated.bounds.maximum || (validated.isFlags && parsed < 0n)) {
      throw encodingError("invalid-value", path);
    }
    return preferredEnumRepresentation(parsed, validated) ?? parsed.toString();
  }

  const names = value.split(",");
  if ((!validated.isFlags && names.length !== 1) || new Set(names).size !== names.length) {
    throw encodingError("invalid-value", path);
  }
  const declaredNames = new Set(validated.members.map((member) => member.name));
  if (names.some((name) => !simpleIdentifier(name) || !declaredNames.has(name))) {
    throw encodingError("invalid-value", path);
  }
  return names.join(",");
}

function validatedEnumType(enumType: HonuaOdataEnumTypeInfo, path: readonly (string | number)[]): ValidatedEnumType {
  try {
    const enumRecord = plainDataRecord(enumType, path, "invalid-metadata");
    const underlyingType = dataProperty(enumRecord, "underlyingType", path, "invalid-metadata");
    const bounds = typeof underlyingType === "string" ? integerBounds(underlyingType) : undefined;
    const isFlags = dataProperty(enumRecord, "isFlags", path, "invalid-metadata");
    const declarations = dataProperty(enumRecord, "members", path, "invalid-metadata");
    const declaration = dataProperty(enumRecord, "declaration", path, "invalid-metadata");
    if (!bounds || typeof isFlags !== "boolean" || !Array.isArray(declarations)) {
      throw encodingError("invalid-metadata", path);
    }
    if (declaration !== undefined) {
      const declarationRecord = plainDataRecord(declaration, path, "invalid-metadata");
      const state = dataProperty(declarationRecord, "state", path, "invalid-metadata");
      if (state !== "valid") throw encodingError("invalid-metadata", path);
      const valueMode = dataProperty(declarationRecord, "valueMode", path, "invalid-metadata");
      if (
        (valueMode !== "explicit" && valueMode !== "implicit" && valueMode !== "mixed") ||
        (isFlags && valueMode !== "explicit")
      ) {
        throw encodingError("invalid-metadata", path);
      }
    }

    const members: ValidatedEnumMember[] = [];
    const names = new Set<string>();
    for (const member of arrayDataValues(declarations, path, "invalid-metadata")) {
      const memberRecord = plainDataRecord(member, path, "invalid-metadata");
      const name = dataProperty(memberRecord, "name", path, "invalid-metadata");
      const rawValue = dataProperty(memberRecord, "value", path, "invalid-metadata");
      const parsed = metadataInteger(rawValue);
      if (
        typeof name !== "string" ||
        !simpleIdentifier(name) ||
        names.has(name) ||
        parsed === undefined ||
        parsed < bounds.minimum ||
        parsed > bounds.maximum ||
        (isFlags && parsed < 0n)
      ) {
        throw encodingError("invalid-metadata", path);
      }
      names.add(name);
      members.push({ name, value: parsed });
    }
    if (members.length === 0) throw encodingError("invalid-metadata", path);
    return { bounds, isFlags, members };
  } catch (error) {
    rethrowEncodingError(error, "invalid-metadata", path);
  }
}

function metadataInteger(value: unknown): bigint | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  if (typeof value !== "string" || value.length > 20 || !/^[+-]?\d+$/.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function preferredEnumRepresentation(value: bigint, enumType: ValidatedEnumType): string | undefined {
  const exact = enumType.members.find((member) => member.value === value);
  if (exact) return exact.name;
  if (!enumType.isFlags || value === 0n) return undefined;

  let combined = 0n;
  const names: string[] = [];
  for (const member of enumType.members) {
    if (member.value === 0n || (member.value & value) !== member.value) continue;
    const next = combined | member.value;
    if (next === combined) continue;
    combined = next;
    names.push(member.name);
  }
  return combined === value ? names.join(",") : undefined;
}

function metadataFieldArray(value: unknown, path: readonly (string | number)[]): readonly HonuaOdataFieldInfo[] {
  if (!Array.isArray(value)) throw encodingError("invalid-metadata", path);
  const declarations = arrayDataValues(value, path, "invalid-metadata");
  const fields: HonuaOdataFieldInfo[] = [];
  const names = new Set<string>();
  for (let index = 0; index < declarations.length; index += 1) {
    const field = metadataField(declarations[index], path);
    if (names.has(field.name)) throw encodingError("invalid-metadata", path);
    names.add(field.name);
    fields.push(field);
  }
  return Object.freeze(fields);
}

function metadataField(value: unknown, path: readonly (string | number)[]): HonuaOdataFieldInfo {
  const record = plainDataRecord(value, path, "invalid-metadata");
  const name = dataProperty(record, "name", path, "invalid-metadata");
  const type = dataProperty(record, "type", path, "invalid-metadata");
  const nullable = dataProperty(record, "nullable", path, "invalid-metadata");
  const maxLength = dataProperty(record, "maxLength", path, "invalid-metadata");
  const precision = dataProperty(record, "precision", path, "invalid-metadata");
  const scale = dataProperty(record, "scale", path, "invalid-metadata");
  if (typeof name !== "string" || !simpleIdentifier(name) || typeof type !== "string" || !metadataType(type)) {
    throw encodingError("invalid-metadata", path);
  }
  if (nullable !== undefined && typeof nullable !== "boolean") throw encodingError("invalid-metadata", path);
  if (
    maxLength !== undefined &&
    maxLength !== "max" &&
    (typeof maxLength !== "number" || !Number.isSafeInteger(maxLength) || maxLength < 0)
  ) {
    throw encodingError("invalid-metadata", path);
  }
  if (precision !== undefined && (typeof precision !== "number" || !Number.isSafeInteger(precision) || precision < 0)) {
    throw encodingError("invalid-metadata", path);
  }
  if (
    scale !== undefined &&
    scale !== "variable" &&
    scale !== "floating" &&
    (typeof scale !== "number" || !Number.isSafeInteger(scale) || scale < 0)
  ) {
    throw encodingError("invalid-metadata", path);
  }
  if (typeof precision === "number" && typeof scale === "number" && scale > precision) {
    throw encodingError("invalid-metadata", path);
  }
  return Object.freeze({
    name,
    type,
    ...(nullable === undefined ? {} : { nullable }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(precision === undefined ? {} : { precision }),
    ...(scale === undefined ? {} : { scale }),
  });
}

function metadataStringArray(value: unknown, path: readonly (string | number)[]): readonly string[] {
  if (!Array.isArray(value)) throw encodingError("invalid-metadata", path);
  const declarations = arrayDataValues(value, path, "invalid-metadata");
  const output: string[] = [];
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    if (typeof declaration !== "string" || declaration.length === 0 || declaration.length > 512) {
      throw encodingError("invalid-metadata", path);
    }
    output.push(declaration);
  }
  return Object.freeze(output);
}

function metadataType(value: string): boolean {
  if (value.length === 0 || value.length > 1_024) return false;
  const collectionType = unwrapCollection(value);
  if (collectionType === undefined) return qualifiedIdentifier(value);
  return unwrapCollection(collectionType) === undefined && qualifiedIdentifier(collectionType);
}

function plainDataRecord(
  value: unknown,
  path: readonly (string | number)[],
  errorCode: HonuaOdataEdmEncodingErrorCode,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw encodingError(errorCode, path);
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw encodingError(errorCode, path);
  } catch (error) {
    rethrowEncodingError(error, errorCode, path);
  }
  return value as Readonly<Record<string, unknown>>;
}

function ownDataProperty(value: object, name: string, path: readonly (string | number)[]): unknown {
  return dataProperty(value, name, path, "invalid-value");
}

function dataProperty(
  value: object,
  name: string,
  path: readonly (string | number)[],
  errorCode: HonuaOdataEdmEncodingErrorCode,
): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor) return undefined;
    if (!("value" in descriptor)) throw encodingError(errorCode, path);
    return descriptor.value;
  } catch (error) {
    rethrowEncodingError(error, errorCode, path);
  }
}

function arrayDataValues(
  value: readonly unknown[],
  path: readonly (string | number)[],
  errorCode: HonuaOdataEdmEncodingErrorCode = "invalid-value",
): unknown[] {
  const length = dataProperty(value, "length", path, errorCode);
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    throw encodingError(errorCode, path);
  }
  if ((length as number) > MAX_CONTAINER_ITEMS) {
    throw encodingError(errorCode === "invalid-value" ? "resource-limit-exceeded" : errorCode, path);
  }
  const output = new Array<unknown>(length as number);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = dataProperty(value, String(index), [...path, index], errorCode);
  }
  return output;
}

function objectKeys(value: object, path: readonly (string | number)[]): string[] {
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    throw encodingError("invalid-value", path);
  }
  if (keys.length > MAX_CONTAINER_ITEMS) throw encodingError("resource-limit-exceeded", path);
  return keys;
}

function consumeValueNode(path: readonly (string | number)[], context: EncodingContext): void {
  context.nodes += 1;
  if (context.nodes > MAX_ENCODED_VALUE_NODES) {
    throw encodingError("resource-limit-exceeded", path);
  }
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
    return encodeOdataKeyPredicatePath(value);
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
  return dataProperty(record, name, [], "invalid-metadata") as T | undefined;
}

function isRecord(value: unknown, path: readonly (string | number)[]): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    throw encodingError("invalid-value", path);
  }
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

function rethrowEncodingError(
  error: unknown,
  fallbackCode: HonuaOdataEdmEncodingErrorCode,
  fallbackPath: readonly (string | number)[],
): never {
  let isKnownEncodingError = false;
  try {
    isKnownEncodingError = error instanceof HonuaOdataEdmEncodingError;
  } catch {}
  if (isKnownEncodingError) throw error;
  throw encodingError(fallbackCode, fallbackPath);
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
    case "resource-limit-exceeded":
      return "the value exceeds a supported resource limit";
    case "unknown-entity-set":
      return "the metadata snapshot does not declare the entity set";
    case "unsupported-type":
      return "the declared EDM type is not supported for this operation";
  }
}
