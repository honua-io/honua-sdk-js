/**
 * Lossless, JSON-safe decoding for values returned by DuckDB/Arrow.
 *
 * This module deliberately has no runtime dependency on DuckDB or Apache
 * Arrow. The GeoParquet source can therefore compile decoders from DESCRIBE
 * output without pulling either optional peer into lightweight imports.
 */

import type { AggregationSpec } from "../contract/types.js";
import type { SourceProfileField } from "./metadata.js";

export type DuckDbLosslessJsonValue =
  | null
  | boolean
  | number
  | string
  | DuckDbLosslessJsonValue[]
  | { [key: string]: DuckDbLosslessJsonValue };

export type DuckDbLosslessErrorCode =
  | "GEOPARQUET_LOSSLESS_ACCESSOR"
  | "GEOPARQUET_LOSSLESS_AGGREGATE_TYPE"
  | "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER"
  | "GEOPARQUET_LOSSLESS_CONTAINER_LIMIT"
  | "GEOPARQUET_LOSSLESS_CYCLE"
  | "GEOPARQUET_LOSSLESS_DEPTH_LIMIT"
  | "GEOPARQUET_LOSSLESS_INVALID_TYPE"
  | "GEOPARQUET_LOSSLESS_INVALID_VALUE"
  | "GEOPARQUET_LOSSLESS_PRECISION_LOSS"
  | "GEOPARQUET_LOSSLESS_UNSUPPORTED_TYPE";

const MAX_TYPE_LENGTH = 4_096;
const MAX_TYPE_DEPTH = 64;
const MAX_CONTAINER_DEPTH = 32;
const MAX_CONTAINER_ENTRIES = 100_000;
const MAX_ERROR_PATH_LENGTH = 512;
const MAX_ERROR_TYPE_LENGTH = 160;
const MAX_ERROR_FIELD_LENGTH = 64;

/** A redacted, fixed-code failure from the lossless result boundary. */
export class DuckDbLosslessDecodeError extends Error {
  public readonly code: DuckDbLosslessErrorCode;
  public readonly path: string;
  public readonly declaredType: string;

  public constructor(code: DuckDbLosslessErrorCode, path: string, declaredType: string) {
    const safePath = boundedDisplay(path, MAX_ERROR_PATH_LENGTH);
    const safeType = boundedDisplay(declaredType, MAX_ERROR_TYPE_LENGTH);
    super(`geoparquet: ${code} at ${safePath} for declared type ${safeType}`);
    this.name = "DuckDbLosslessDecodeError";
    this.code = code;
    this.path = safePath;
    this.declaredType = safeType;
  }
}

type DuckType =
  | { readonly kind: "array"; readonly child: DuckType; readonly length: number }
  | { readonly kind: "decimal"; readonly precision: number; readonly scale: number }
  | { readonly kind: "list"; readonly child: DuckType }
  | { readonly kind: "map"; readonly key: DuckType; readonly value: DuckType }
  | { readonly kind: "scalar"; readonly name: string }
  | {
      readonly kind: "struct";
      readonly fields: readonly { readonly name: string; readonly type: DuckType }[];
    }
  | {
      readonly kind: "temporal";
      readonly name: "DATE" | "TIME" | "TIMESTAMP";
      readonly precision: number;
      readonly zoned: boolean;
    };

interface DecodeState {
  readonly declaredType: string;
  readonly ancestors: WeakSet<object>;
  entries: number;
}

/** A decoder compiled once from one effective DuckDB DESCRIBE type. */
export interface DuckDbLosslessValueDecoder {
  readonly declaredType: string;
  decode(value: unknown, fieldName?: string): DuckDbLosslessJsonValue;
}

/** Compile a reusable decoder for one effective DuckDB output type. */
export function compileDuckDbLosslessValueDecoder(declaredType: string): DuckDbLosslessValueDecoder {
  const boundedType = validateDeclaredTypeInput(declaredType);
  const parsed = parseDuckType(boundedType);
  assertSupportedType(parsed, boundedType);
  return Object.freeze({
    declaredType: boundedType,
    decode(value: unknown, fieldName?: string): DuckDbLosslessJsonValue {
      const path = fieldName === undefined ? "$" : appendFieldPath("$", fieldName);
      return decodeValue(parsed, value, { declaredType: boundedType, ancestors: new WeakSet(), entries: 0 }, path, 0);
    },
  });
}

/** Decode one value without retaining a compiled decoder. */
export function decodeDuckDbLosslessValue(
  declaredType: string,
  value: unknown,
  fieldName?: string,
): DuckDbLosslessJsonValue {
  return compileDuckDbLosslessValueDecoder(declaredType).decode(value, fieldName);
}

/** Effective fields emitted by an aggregate SELECT, in SQL projection order. */
export interface DuckDbAggregateOutputField extends SourceProfileField {
  readonly source: "group" | "metric";
}

/**
 * Derive aggregate result types using DuckDB's output rules rather than the
 * input field type. This mirrors compileAggregate's aliases and ordering.
 */
export function deriveDuckDbAggregateOutputFields(
  aggregation: AggregationSpec,
  inputFields: readonly SourceProfileField[],
): readonly DuckDbAggregateOutputField[] {
  if (aggregation.metrics.length === 0) aggregateFailure("$.metrics", "METRIC_REQUIRED");
  const byName = new Map<string, SourceProfileField>();
  for (const field of inputFields) {
    if (byName.has(field.name)) aggregateFailure("$", "DUPLICATE_INPUT_FIELD");
    byName.set(field.name, field);
  }

  const output: DuckDbAggregateOutputField[] = [];
  const outputNames = new Set<string>();
  for (const [index, name] of (aggregation.groupBy ?? []).entries()) {
    const field = byName.get(name);
    if (!field) aggregateFailure(`$.groupBy[${index}]`, "UNKNOWN_GROUP_FIELD");
    pushAggregateField(output, outputNames, { ...field, source: "group" }, `$.groupBy[${index}]`);
  }

  for (const [index, metric] of aggregation.metrics.entries()) {
    const path = `$.metrics[${index}]`;
    const name = metric.alias ?? `${metric.fn}_${metric.field === "*" ? "all" : metric.field}`;
    let input: SourceProfileField | undefined;
    if (metric.field !== "*") {
      input = byName.get(metric.field);
      if (!input) aggregateFailure(path, "UNKNOWN_METRIC_FIELD");
    } else if (metric.fn !== "count") {
      aggregateFailure(path, "WILDCARD_ONLY_VALID_FOR_COUNT");
    }

    const type = aggregateMetricType(metric.fn, input?.type, path);
    pushAggregateField(output, outputNames, { name, type, source: "metric" }, path);
  }
  return Object.freeze(output.map((field) => Object.freeze(field)));
}

function aggregateMetricType(
  fn: AggregationSpec["metrics"][number]["fn"],
  inputType: string | undefined,
  path: string,
) {
  if (fn === "count") return "BIGINT";
  if (!inputType) aggregateFailure(path, "METRIC_INPUT_TYPE_REQUIRED");
  const parsed = parseDuckType(validateDeclaredTypeInput(inputType));
  switch (fn) {
    case "min":
    case "max":
      return inputType;
    case "avg":
    case "stddev":
    case "var":
      if (!isNumericType(parsed)) aggregateFailure(path, "NUMERIC_METRIC_REQUIRED");
      return "DOUBLE";
    case "sum":
      if (parsed.kind === "decimal") return `DECIMAL(38,${parsed.scale})`;
      if (parsed.kind === "scalar" && isIntegerName(parsed.name)) return "HUGEINT";
      if (parsed.kind === "scalar" && isFloatingName(parsed.name)) return "DOUBLE";
      aggregateFailure(path, "SUM_INPUT_TYPE_UNSUPPORTED");
  }
}

function pushAggregateField(
  output: DuckDbAggregateOutputField[],
  names: Set<string>,
  field: DuckDbAggregateOutputField,
  path: string,
): void {
  if (names.has(field.name)) aggregateFailure(path, "DUPLICATE_OUTPUT_FIELD");
  names.add(field.name);
  output.push(field);
}

function aggregateFailure(path: string, _reason: string): never {
  throw new DuckDbLosslessDecodeError("GEOPARQUET_LOSSLESS_AGGREGATE_TYPE", path, "AGGREGATE");
}

function isNumericType(type: DuckType): boolean {
  return type.kind === "decimal" || (type.kind === "scalar" && (isIntegerName(type.name) || isFloatingName(type.name)));
}

function decodeValue(
  type: DuckType,
  value: unknown,
  state: DecodeState,
  path: string,
  depth: number,
): DuckDbLosslessJsonValue {
  if (depth > MAX_CONTAINER_DEPTH) failure(state, "GEOPARQUET_LOSSLESS_DEPTH_LIMIT", path);
  if (value === null) return null;
  switch (type.kind) {
    case "array":
      return decodeSequence(type.child, value, state, path, depth, type.length);
    case "list":
      return decodeSequence(type.child, value, state, path, depth);
    case "map":
      return decodeMap(type, value, state, path, depth);
    case "struct":
      return decodeStruct(type, value, state, path, depth);
    case "decimal":
      return decodeDecimal(type, value, state, path);
    case "temporal":
      return decodeTemporal(type, value, state, path);
    case "scalar":
      return decodeScalar(type.name, value, state, path);
  }
}

function assertSupportedType(type: DuckType, declaredType: string): void {
  switch (type.kind) {
    case "array":
    case "list":
      assertSupportedType(type.child, declaredType);
      return;
    case "map":
      assertSupportedType(type.key, declaredType);
      assertSupportedType(type.value, declaredType);
      return;
    case "struct":
      for (const field of type.fields) assertSupportedType(field.type, declaredType);
      return;
    case "decimal":
    case "temporal":
      return;
    case "scalar":
      if (
        isIntegerName(type.name) ||
        isFloatingName(type.name) ||
        type.name === "BOOLEAN" ||
        type.name === "NULL" ||
        type.name === "SQLNULL" ||
        TEXT_TYPES.has(type.name) ||
        BINARY_TYPES.has(type.name)
      ) {
        return;
      }
      throw new DuckDbLosslessDecodeError("GEOPARQUET_LOSSLESS_UNSUPPORTED_TYPE", "$", declaredType);
  }
}

const INTEGER_TYPES: Readonly<
  Record<string, { readonly bits: number; readonly signed: boolean; readonly string: boolean }>
> = {
  BIGINT: { bits: 64, signed: true, string: true },
  HUGEINT: { bits: 128, signed: true, string: true },
  INTEGER: { bits: 32, signed: true, string: false },
  SMALLINT: { bits: 16, signed: true, string: false },
  TINYINT: { bits: 8, signed: true, string: false },
  UBIGINT: { bits: 64, signed: false, string: true },
  UHUGEINT: { bits: 128, signed: false, string: true },
  UINTEGER: { bits: 32, signed: false, string: false },
  USMALLINT: { bits: 16, signed: false, string: false },
  UTINYINT: { bits: 8, signed: false, string: false },
};

function decodeScalar(name: string, value: unknown, state: DecodeState, path: string): DuckDbLosslessJsonValue {
  const integer = INTEGER_TYPES[name];
  if (integer) {
    const exact = exactInteger(value, integer.bits, integer.signed, state, path);
    return integer.string ? exact.toString() : Number(exact);
  }
  if (isFloatingName(name)) {
    if (typeof value !== "number" || !Number.isFinite(value)) invalidValue(state, path, value);
    return value;
  }
  if (name === "BOOLEAN") {
    if (typeof value !== "boolean") invalidValue(state, path, value);
    return value;
  }
  if (TEXT_TYPES.has(name)) {
    if (typeof value !== "string") invalidValue(state, path, value);
    return value;
  }
  if (BINARY_TYPES.has(name)) return encodeBinary(value, state, path);
  if (name === "NULL" || name === "SQLNULL") invalidValue(state, path, value);
  failure(state, "GEOPARQUET_LOSSLESS_UNSUPPORTED_TYPE", path);
}

const TEXT_TYPES = new Set([
  "BIT",
  "BIT STRING",
  "CHAR",
  "CHARACTER",
  "CHARACTER VARYING",
  "JSON",
  "STRING",
  "TEXT",
  "UUID",
  "VARBIT",
  "VARCHAR",
]);
const BINARY_TYPES = new Set(["BINARY", "BLOB", "BYTEA", "VARBINARY"]);
const FLOATING_TYPES = new Set(["DOUBLE", "FLOAT", "REAL"]);

function isFloatingName(name: string): boolean {
  return FLOATING_TYPES.has(name);
}

function isIntegerName(name: string): boolean {
  return INTEGER_TYPES[name] !== undefined;
}

function exactInteger(value: unknown, bits: number, signed: boolean, state: DecodeState, path: string): bigint {
  let exact: bigint;
  if (typeof value === "bigint") {
    exact = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failure(state, "GEOPARQUET_LOSSLESS_PRECISION_LOSS", path);
    exact = BigInt(value);
  } else if (typeof value === "string") {
    if (!canonicalInteger(value)) invalidValue(state, path, value);
    exact = BigInt(value);
  } else {
    const bytes = copyTypedArrayBytes(value);
    if (!bytes || bytes.length !== bits / 8) invalidValue(state, path, value);
    exact = littleEndianInteger(bytes, signed);
  }

  const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const maximum = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  if (exact < minimum || exact > maximum) invalidValue(state, path, value);
  return exact;
}

function canonicalInteger(value: string): boolean {
  return /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(value);
}

function littleEndianInteger(bytes: Uint8Array, signed: boolean): bigint {
  let result = 0n;
  for (let index = bytes.length - 1; index >= 0; index--) result = (result << 8n) | BigInt(bytes[index]!);
  if (signed && (bytes[bytes.length - 1]! & 0x80) !== 0) result -= 1n << BigInt(bytes.length * 8);
  return result;
}

function decodeDecimal(
  type: Extract<DuckType, { kind: "decimal" }>,
  value: unknown,
  state: DecodeState,
  path: string,
): string {
  let unscaled: bigint;
  if (typeof value === "bigint") {
    unscaled = value;
  } else if (typeof value === "string") {
    unscaled = parseDecimalString(value, type, state, path);
  } else if (typeof value === "number") {
    failure(state, "GEOPARQUET_LOSSLESS_PRECISION_LOSS", path);
  } else {
    const bytes = copyTypedArrayBytes(value);
    if (!bytes || bytes.length !== 16) invalidValue(state, path, value);
    unscaled = littleEndianInteger(bytes, true);
  }
  validateDecimalPrecision(unscaled, type.precision, state, path);
  return formatDecimal(unscaled, type.scale);
}

function parseDecimalString(
  value: string,
  type: Extract<DuckType, { kind: "decimal" }>,
  state: DecodeState,
  path: string,
): bigint {
  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (!match) invalidValue(state, path, value);
  const fraction = match[3] ?? "";
  if (fraction.length > type.scale) invalidValue(state, path, value);
  const digits = `${match[2]}${fraction.padEnd(type.scale, "0")}`;
  const exact = BigInt(digits);
  return match[1] === "-" && exact !== 0n ? -exact : exact;
}

function validateDecimalPrecision(unscaled: bigint, precision: number, state: DecodeState, path: string): void {
  const magnitude = unscaled < 0n ? -unscaled : unscaled;
  if (magnitude.toString().length > precision) invalidValue(state, path, unscaled);
}

function formatDecimal(unscaled: bigint, scale: number): string {
  const negative = unscaled < 0n;
  const magnitude = (negative ? -unscaled : unscaled).toString().padStart(scale + 1, "0");
  const result = scale === 0 ? magnitude : `${magnitude.slice(0, -scale)}.${magnitude.slice(-scale)}`;
  return negative ? `-${result}` : result;
}

function encodeBinary(value: unknown, state: DecodeState, path: string): string {
  const bytes = copyTypedArrayBytes(value) ?? copyArrayBufferBytes(value);
  if (!bytes) invalidValue(state, path, value);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const hasB = index + 1 < bytes.length;
    const hasC = index + 2 < bytes.length;
    const b = hasB ? bytes[index + 1]! : 0;
    const c = hasC ? bytes[index + 2]! : 0;
    encoded += alphabet[a >> 2];
    encoded += alphabet[((a & 3) << 4) | (b >> 4)];
    encoded += hasB ? alphabet[((b & 15) << 2) | (c >> 6)] : "=";
    encoded += hasC ? alphabet[c & 63] : "=";
  }
  return encoded;
}

function decodeTemporal(
  type: Extract<DuckType, { kind: "temporal" }>,
  value: unknown,
  state: DecodeState,
  path: string,
): string {
  if (type.name === "DATE") return decodeDate(value, state, path);
  if (type.name === "TIME") return decodeTime(type, value, state, path);
  return decodeTimestamp(type, value, state, path);
}

function decodeDate(value: unknown, state: DecodeState, path: string): string {
  if (typeof value === "string") {
    const parsed = parseDateParts(value, state, path);
    return `${formatYear(parsed.year)}-${two(parsed.month)}-${two(parsed.day)}`;
  }
  const milliseconds = dateMilliseconds(value);
  if (milliseconds === undefined || !Number.isSafeInteger(milliseconds) || milliseconds % 86_400_000 !== 0) {
    invalidValue(state, path, value);
  }
  return formatCivilDate(civilFromDays(BigInt(milliseconds / 86_400_000)));
}

function decodeTime(
  type: Extract<DuckType, { kind: "temporal" }>,
  value: unknown,
  state: DecodeState,
  path: string,
): string {
  if (typeof value === "string") return normalizeTimeString(value, type.precision, type.zoned, state, path);
  if (type.zoned) failure(state, "GEOPARQUET_LOSSLESS_PRECISION_LOSS", path);
  const units = temporalUnits(value, type.precision, state, path, false);
  const perSecond = 10n ** BigInt(type.precision);
  const perDay = 86_400n * perSecond;
  if (units < 0n || units >= perDay) invalidValue(state, path, value);
  const seconds = units / perSecond;
  const fraction = units % perSecond;
  const hour = Number(seconds / 3_600n);
  const minute = Number((seconds % 3_600n) / 60n);
  const second = Number(seconds % 60n);
  return formatClock(hour, minute, second, fraction, type.precision);
}

function decodeTimestamp(
  type: Extract<DuckType, { kind: "temporal" }>,
  value: unknown,
  state: DecodeState,
  path: string,
): string {
  if (typeof value === "string") return normalizeTimestampString(value, type, state, path);
  const units = temporalUnits(value, type.precision, state, path, true);
  return formatEpochTimestamp(units, type.precision, type.zoned);
}

function temporalUnits(
  value: unknown,
  precision: number,
  state: DecodeState,
  path: string,
  allowDate: boolean,
): bigint {
  if (typeof value === "bigint") return value;
  let milliseconds: number | undefined;
  if (typeof value === "number") milliseconds = value;
  else if (allowDate) milliseconds = dateMilliseconds(value);
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) invalidValue(state, path, value);

  const exponent = precision - 3;
  const scaled = exponent >= 0 ? milliseconds * 10 ** exponent : milliseconds / 10 ** -exponent;
  if (!Number.isSafeInteger(scaled)) failure(state, "GEOPARQUET_LOSSLESS_PRECISION_LOSS", path);
  return BigInt(scaled);
}

function normalizeTimeString(
  value: string,
  precision: number,
  zoned: boolean,
  state: DecodeState,
  path: string,
): string {
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.([0-9]+))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) invalidValue(state, path, value);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  validateClock(hour, minute, second, state, path);
  const fraction = normalizeFraction(match[4] ?? "", precision, state, path);
  const zone = match[5];
  if (zoned !== (zone !== undefined)) invalidValue(state, path, value);
  if (zone) parseOffsetSeconds(zone, state, path);
  return `${formatClock(hour, minute, second, fraction, precision)}${zone ?? ""}`;
}

function normalizeTimestampString(
  value: string,
  type: Extract<DuckType, { kind: "temporal" }>,
  state: DecodeState,
  path: string,
): string {
  const match =
    /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.([0-9]+))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) invalidValue(state, path, value);
  const date = validateDateParts(BigInt(match[1]!), Number(match[2]), Number(match[3]), state, path);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  validateClock(hour, minute, second, state, path);
  const fraction = normalizeFraction(match[7] ?? "", type.precision, state, path);
  const zone = match[8];
  if (type.zoned !== (zone !== undefined)) invalidValue(state, path, value);

  if (!type.zoned) {
    return `${formatCivilDate(date)}T${formatClock(hour, minute, second, fraction, type.precision)}`;
  }
  const perSecond = 10n ** BigInt(type.precision);
  const offsetSeconds = parseOffsetSeconds(zone!, state, path);
  const days = daysFromCivil(date.year, date.month, date.day);
  const units = (days * 86_400n + BigInt(hour * 3_600 + minute * 60 + second - offsetSeconds)) * perSecond + fraction;
  return formatEpochTimestamp(units, type.precision, true);
}

function normalizeFraction(digits: string, precision: number, state: DecodeState, path: string): bigint {
  if (digits.length > precision || (precision === 0 && digits.length > 0)) invalidValue(state, path, digits);
  return BigInt((digits || "0").padEnd(precision, "0"));
}

function parseOffsetSeconds(zone: string, state: DecodeState, path: string): number {
  if (zone === "Z") return 0;
  const sign = zone[0] === "-" ? -1 : 1;
  const hour = Number(zone.slice(1, 3));
  const minute = Number(zone.slice(4, 6));
  if (hour > 14 || minute > 59 || (hour === 14 && minute !== 0)) invalidValue(state, path, zone);
  return sign * (hour * 3_600 + minute * 60);
}

function formatEpochTimestamp(units: bigint, precision: number, zoned: boolean): string {
  const perSecond = 10n ** BigInt(precision);
  const seconds = floorDiv(units, perSecond);
  const fraction = units - seconds * perSecond;
  const days = floorDiv(seconds, 86_400n);
  const secondsOfDay = seconds - days * 86_400n;
  const date = civilFromDays(days);
  const hour = Number(secondsOfDay / 3_600n);
  const minute = Number((secondsOfDay % 3_600n) / 60n);
  const second = Number(secondsOfDay % 60n);
  return `${formatCivilDate(date)}T${formatClock(hour, minute, second, fraction, precision)}${zoned ? "Z" : ""}`;
}

function formatClock(hour: number, minute: number, second: number, fraction: bigint, precision: number): string {
  const suffix = precision === 0 ? "" : `.${fraction.toString().padStart(precision, "0")}`;
  return `${two(hour)}:${two(minute)}:${two(second)}${suffix}`;
}

function validateClock(hour: number, minute: number, second: number, state: DecodeState, path: string): void {
  if (hour > 23 || minute > 59 || second > 59) invalidValue(state, path, hour);
}

interface CivilDate {
  readonly year: bigint;
  readonly month: number;
  readonly day: number;
}

function parseDateParts(value: string, state: DecodeState, path: string): CivilDate {
  const match = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) invalidValue(state, path, value);
  return validateDateParts(BigInt(match[1]!), Number(match[2]), Number(match[3]), state, path);
}

function validateDateParts(year: bigint, month: number, day: number, state: DecodeState, path: string): CivilDate {
  const leap = year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
  const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1]!) invalidValue(state, path, day);
  return { year, month, day };
}

function daysFromCivil(year: bigint, month: number, day: number): bigint {
  const adjustedYear = year - (month <= 2 ? 1n : 0n);
  const era = floorDiv(adjustedYear, 400n);
  const yearOfEra = adjustedYear - era * 400n;
  const adjustedMonth = BigInt(month + (month > 2 ? -3 : 9));
  const dayOfYear = (153n * adjustedMonth + 2n) / 5n + BigInt(day - 1);
  const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear;
  return era * 146_097n + dayOfEra - 719_468n;
}

function civilFromDays(days: bigint): CivilDate {
  const z = days + 719_468n;
  const era = floorDiv(z, 146_097n);
  const dayOfEra = z - era * 146_097n;
  const yearOfEra = (dayOfEra - dayOfEra / 1_460n + dayOfEra / 36_524n - dayOfEra / 146_096n) / 365n;
  let year = yearOfEra + era * 400n;
  const dayOfYear = dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n);
  const monthPrime = (5n * dayOfYear + 2n) / 153n;
  const day = Number(dayOfYear - (153n * monthPrime + 2n) / 5n + 1n);
  const month = Number(monthPrime + (monthPrime < 10n ? 3n : -9n));
  if (month <= 2) year += 1n;
  return { year, month, day };
}

function formatCivilDate(date: CivilDate): string {
  return `${formatYear(date.year)}-${two(date.month)}-${two(date.day)}`;
}

function formatYear(year: bigint): string {
  if (year >= 0n && year <= 9_999n) return year.toString().padStart(4, "0");
  const sign = year < 0n ? "-" : "+";
  const magnitude = year < 0n ? -year : year;
  return `${sign}${magnitude.toString().padStart(6, "0")}`;
}

function two(value: number): string {
  return value.toString().padStart(2, "0");
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  const remainder = value % divisor;
  return remainder < 0n ? quotient - 1n : quotient;
}

function dateMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "object" || value === null) return undefined;
  try {
    return Reflect.apply(Date.prototype.getTime, value, []);
  } catch {
    return undefined;
  }
}

function decodeSequence(
  child: DuckType,
  value: unknown,
  state: DecodeState,
  path: string,
  depth: number,
  fixedLength?: number,
): DuckDbLosslessJsonValue[] {
  if (typeof value !== "object" || value === null) invalidValue(state, path, value);
  enterContainer(value, state, path);
  try {
    const sequence = sequenceReader(value, state, path);
    if (fixedLength !== undefined && sequence.length !== fixedLength) invalidValue(state, path, value);
    addEntries(sequence.length, state, path);
    const result: DuckDbLosslessJsonValue[] = [];
    for (let index = 0; index < sequence.length; index++) {
      result.push(decodeValue(child, sequence.get(index), state, `${path}[${index}]`, depth + 1));
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

interface SequenceReader {
  readonly length: number;
  get(index: number): unknown;
}

function sequenceReader(value: object, state: DecodeState, path: string): SequenceReader {
  if (Array.isArray(value)) return arrayReader(value, state, path);
  const typedValues = copyTypedArrayValues(value, state, path);
  if (typedValues) return { length: typedValues.length, get: (index) => typedValues[index] };

  const length = ownDataProperty(value, "length", state, path);
  const get = brandedMethod(value, "Vector", "get", state, path);
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || !get) {
    failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
  }
  if (length > MAX_CONTAINER_ENTRIES) failure(state, "GEOPARQUET_LOSSLESS_CONTAINER_LIMIT", path);
  return {
    length,
    get(index: number): unknown {
      try {
        return Reflect.apply(get, value, [index]);
      } catch {
        failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", `${path}[${index}]`);
      }
    },
  };
}

function arrayReader(value: unknown[], state: DecodeState, path: string): SequenceReader {
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
  }
  if (isAccessor(lengthDescriptor)) failure(state, "GEOPARQUET_LOSSLESS_ACCESSOR", path);
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CONTAINER_ENTRIES) {
    failure(state, "GEOPARQUET_LOSSLESS_CONTAINER_LIMIT", path);
  }
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
    }
    if (isAccessor(descriptors[key])) failure(state, "GEOPARQUET_LOSSLESS_ACCESSOR", `${path}[${key}]`);
  }
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor) invalidValue(state, `${path}[${index}]`, undefined);
    if (isAccessor(descriptor)) failure(state, "GEOPARQUET_LOSSLESS_ACCESSOR", `${path}[${index}]`);
  }
  return { length, get: (index) => descriptors[String(index)]!.value };
}

function decodeStruct(
  type: Extract<DuckType, { kind: "struct" }>,
  value: unknown,
  state: DecodeState,
  path: string,
  depth: number,
): { [key: string]: DuckDbLosslessJsonValue } {
  if (typeof value !== "object" || value === null) invalidValue(state, path, value);
  enterContainer(value, state, path);
  try {
    const entries = structEntries(value, type.fields.length, state, path);
    addEntries(entries.length, state, path);
    const byName = new Map<string, unknown>();
    for (const [name, child] of entries) {
      if (byName.has(name)) failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", appendFieldPath(path, name));
      byName.set(name, child);
    }
    if (byName.size !== type.fields.length) invalidValue(state, path, value);

    const result: { [key: string]: DuckDbLosslessJsonValue } = {};
    for (const field of type.fields) {
      if (!byName.has(field.name)) invalidValue(state, appendFieldPath(path, field.name), undefined);
      Object.defineProperty(result, field.name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: decodeValue(field.type, byName.get(field.name), state, appendFieldPath(path, field.name), depth + 1),
      });
    }
    return result;
  } finally {
    state.ancestors.delete(value);
  }
}

function structEntries(
  value: object,
  expected: number,
  state: DecodeState,
  path: string,
): readonly (readonly [string, unknown])[] {
  if (isPlainRecord(value, state, path)) return plainRecordEntries(value, state, path);
  const iterator = brandedMethod(value, "StructRow", Symbol.iterator, state, path);
  if (!iterator) failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
  return iteratorEntries(value, iterator, expected, state, path, true).map(
    ([key, child]) => [key as string, child] as const,
  );
}

function decodeMap(
  type: Extract<DuckType, { kind: "map" }>,
  value: unknown,
  state: DecodeState,
  path: string,
  depth: number,
): DuckDbLosslessJsonValue[] {
  if (typeof value !== "object" || value === null) invalidValue(state, path, value);
  enterContainer(value, state, path);
  try {
    const entries = mapEntries(value, state, path);
    addEntries(entries.length * 2, state, path);
    return entries.map(([key, child], index) => ({
      key: decodeValue(type.key, key, state, `${path}[${index}].key`, depth + 1),
      value: decodeValue(type.value, child, state, `${path}[${index}].value`, depth + 1),
    }));
  } finally {
    state.ancestors.delete(value);
  }
}

function mapEntries(value: object, state: DecodeState, path: string): readonly (readonly [unknown, unknown])[] {
  const native = nativeMapEntries(value, state, path);
  if (native) {
    if (native.length > MAX_CONTAINER_ENTRIES) failure(state, "GEOPARQUET_LOSSLESS_CONTAINER_LIMIT", path);
    return native;
  }
  if (isPlainRecord(value, state, path)) return plainRecordEntries(value, state, path);
  const iterator = brandedMethod(value, "MapRow", Symbol.iterator, state, path);
  if (!iterator) failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
  return iteratorEntries(value, iterator, MAX_CONTAINER_ENTRIES, state, path, false);
}

function nativeMapEntries(
  value: object,
  state: DecodeState,
  path: string,
): readonly (readonly [unknown, unknown])[] | undefined {
  let size: unknown;
  try {
    size = Reflect.apply(Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!, value, []);
  } catch {
    return undefined;
  }
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
  if (size > MAX_CONTAINER_ENTRIES) failure(state, "GEOPARQUET_LOSSLESS_CONTAINER_LIMIT", path);
  try {
    return Array.from(Reflect.apply(Map.prototype.entries, value, []));
  } catch {
    return undefined;
  }
}

function plainRecordEntries(value: object, state: DecodeState, path: string): readonly (readonly [string, unknown])[] {
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
  }
  if (keys.length > MAX_CONTAINER_ENTRIES) failure(state, "GEOPARQUET_LOSSLESS_CONTAINER_LIMIT", path);
  return keys.map((key) => {
    if (typeof key !== "string") failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", appendFieldPath(path, key));
    }
    if (!descriptor) failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", appendFieldPath(path, key));
    if (isAccessor(descriptor)) failure(state, "GEOPARQUET_LOSSLESS_ACCESSOR", appendFieldPath(path, key));
    return [key, descriptor.value] as const;
  });
}

function iteratorEntries(
  value: object,
  iteratorMethod: (...args: unknown[]) => unknown,
  maximum: number,
  state: DecodeState,
  path: string,
  stringKeys: boolean,
): readonly (readonly [unknown, unknown])[] {
  let iterator: unknown;
  try {
    iterator = Reflect.apply(iteratorMethod, value, []);
  } catch {
    failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
  }
  if (typeof iterator !== "object" || iterator === null) failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
  const next = dataMethod(iterator, "next", state, path);
  if (!next) failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);

  const result: Array<readonly [unknown, unknown]> = [];
  for (let index = 0; index <= maximum; index++) {
    let step: unknown;
    try {
      step = Reflect.apply(next, iterator, []);
    } catch {
      failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", `${path}[${index}]`);
    }
    const done = ownDataProperty(step, "done", state, `${path}[${index}]`);
    if (done === true) return result;
    if (done !== false) failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", `${path}[${index}]`);
    const pair = ownDataProperty(step, "value", state, `${path}[${index}]`);
    if (!Array.isArray(pair)) failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", `${path}[${index}]`);
    const pairReader = arrayReader(pair, state, `${path}[${index}]`);
    if (pairReader.length !== 2) failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", `${path}[${index}]`);
    const key = pairReader.get(0);
    if (stringKeys && typeof key !== "string") {
      failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", `${path}[${index}]`);
    }
    result.push([key, pairReader.get(1)]);
  }
  failure(state, "GEOPARQUET_LOSSLESS_CONTAINER_LIMIT", path);
}

function isPlainRecord(value: object, state: DecodeState, path: string): boolean {
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || prototype === Object.prototype;
  } catch {
    failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
  }
}

function brandedMethod(
  value: object,
  brand: string,
  key: PropertyKey,
  state: DecodeState,
  path: string,
): ((...args: unknown[]) => unknown) | undefined {
  let current: object | null = value;
  let brandFound = false;
  let method: ((...args: unknown[]) => unknown) | undefined;
  for (let depth = 0; current && depth < 8; depth++) {
    let constructorDescriptor: PropertyDescriptor | undefined;
    let methodDescriptor: PropertyDescriptor | undefined;
    try {
      constructorDescriptor = Object.getOwnPropertyDescriptor(current, "constructor");
      methodDescriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
    }
    if (isAccessor(constructorDescriptor) || isAccessor(methodDescriptor)) {
      failure(state, "GEOPARQUET_LOSSLESS_ACCESSOR", path);
    }
    const constructorName = functionName(constructorDescriptor?.value);
    if (constructorName === brand) brandFound = true;
    if (methodDescriptor) {
      if (typeof methodDescriptor.value !== "function") return undefined;
      method ??= methodDescriptor.value;
      if (brandFound) return method;
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
    }
  }
  return brandFound ? method : undefined;
}

function dataMethod(
  value: object,
  key: PropertyKey,
  state: DecodeState,
  path: string,
): ((...args: unknown[]) => unknown) | undefined {
  let current: object | null = value;
  for (let depth = 0; current && depth < 8; depth++) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
    }
    if (isAccessor(descriptor)) failure(state, "GEOPARQUET_LOSSLESS_ACCESSOR", path);
    if (descriptor) return typeof descriptor.value === "function" ? descriptor.value : undefined;
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
    }
  }
  return undefined;
}

function functionName(value: unknown): string | undefined {
  if (typeof value !== "function") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "name");
    return typeof descriptor?.value === "string" ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownDataProperty(value: unknown, key: PropertyKey, state: DecodeState, path: string): unknown {
  if (typeof value !== "object" || value === null) failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    failure(state, "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER", path);
  }
  if (!descriptor) return undefined;
  if (isAccessor(descriptor)) failure(state, "GEOPARQUET_LOSSLESS_ACCESSOR", path);
  return descriptor.value;
}

function isAccessor(descriptor: PropertyDescriptor | undefined): boolean {
  return descriptor !== undefined && ("get" in descriptor || "set" in descriptor);
}

function enterContainer(value: object, state: DecodeState, path: string): void {
  if (state.ancestors.has(value)) failure(state, "GEOPARQUET_LOSSLESS_CYCLE", path);
  state.ancestors.add(value);
}

function addEntries(count: number, state: DecodeState, path: string): void {
  state.entries += count;
  if (state.entries > MAX_CONTAINER_ENTRIES) failure(state, "GEOPARQUET_LOSSLESS_CONTAINER_LIMIT", path);
}

function copyTypedArrayValues(value: object, state: DecodeState, path: string): readonly unknown[] | undefined {
  if (!ArrayBuffer.isView(value)) return undefined;
  try {
    const length = Reflect.apply(typedArrayLength, value, []) as number;
    if (length > MAX_CONTAINER_ENTRIES) failure(state, "GEOPARQUET_LOSSLESS_CONTAINER_LIMIT", path);
    return Array.from(Reflect.apply(typedArrayValues, value, []) as Iterable<unknown>);
  } catch (error) {
    if (error instanceof DuckDbLosslessDecodeError) throw error;
    return undefined;
  }
}

function copyTypedArrayBytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== "object" || value === null || !ArrayBuffer.isView(value)) return undefined;
  try {
    const buffer = Reflect.apply(typedArrayBuffer, value, []) as ArrayBuffer;
    const byteOffset = Reflect.apply(typedArrayByteOffset, value, []) as number;
    const byteLength = Reflect.apply(typedArrayByteLength, value, []) as number;
    return new Uint8Array(buffer, byteOffset, byteLength).slice();
  } catch {
    return undefined;
  }
}

function copyArrayBufferBytes(value: unknown): Uint8Array | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const byteLength = Reflect.apply(arrayBufferByteLength, value, []) as number;
    return new Uint8Array(value as ArrayBuffer, 0, byteLength).slice();
  } catch {
    return undefined;
  }
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "length")!.get!;
const typedArrayValues = Object.getOwnPropertyDescriptor(typedArrayPrototype, "values")!.value as (
  ...args: unknown[]
) => unknown;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;

function invalidValue(state: DecodeState, path: string, value: unknown): never {
  failure(
    state,
    typeof value === "object" && value !== null
      ? "GEOPARQUET_LOSSLESS_AMBIGUOUS_WRAPPER"
      : "GEOPARQUET_LOSSLESS_INVALID_VALUE",
    path,
  );
}

function failure(state: DecodeState, code: DuckDbLosslessErrorCode, path: string): never {
  throw new DuckDbLosslessDecodeError(code, path, state.declaredType);
}

function boundedDisplay(value: string, maximum: number): string {
  let clean = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    clean += code <= 31 || code === 127 ? "?" : character;
  }
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 1)}…`;
}

function appendFieldPath(path: string, field: string): string {
  const fieldDisplay = boundedDisplay(field, MAX_ERROR_FIELD_LENGTH);
  const segment = /^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldDisplay)
    ? `.${fieldDisplay}`
    : `[${JSON.stringify(fieldDisplay)}]`;
  const result = `${path}${segment}`;
  if (result.length <= MAX_ERROR_PATH_LENGTH) return result;
  const tailLength = Math.min(segment.length, MAX_ERROR_PATH_LENGTH / 2);
  return `${result.slice(0, MAX_ERROR_PATH_LENGTH - tailLength - 1)}…${segment.slice(-tailLength)}`;
}

function validateDeclaredTypeInput(declaredType: string): string {
  if (typeof declaredType !== "string" || declaredType.length === 0 || declaredType.length > MAX_TYPE_LENGTH) {
    throw new DuckDbLosslessDecodeError("GEOPARQUET_LOSSLESS_INVALID_TYPE", "$", "INVALID");
  }
  return declaredType;
}

type Token =
  | { readonly kind: "number"; readonly value: string }
  | { readonly kind: "punctuation"; readonly value: "(" | ")" | "," | "[" | "]" }
  | { readonly kind: "quoted"; readonly value: string }
  | { readonly kind: "word"; readonly value: string };

function parseDuckType(declaredType: string): DuckType {
  let tokens: readonly Token[];
  try {
    tokens = tokenizeType(declaredType);
    const parser = new DuckTypeParser(tokens);
    const parsed = parser.parseType(0);
    if (!parser.done()) throw new Error("trailing token");
    return parsed;
  } catch (error) {
    if (error instanceof DuckDbLosslessDecodeError) throw error;
    throw new DuckDbLosslessDecodeError("GEOPARQUET_LOSSLESS_INVALID_TYPE", "$", declaredType);
  }
}

function tokenizeType(input: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === '"') {
      let value = "";
      index++;
      let closed = false;
      while (index < input.length) {
        if (input[index] === '"') {
          if (input[index + 1] === '"') {
            value += '"';
            index += 2;
            continue;
          }
          index++;
          closed = true;
          break;
        }
        value += input[index++];
      }
      if (!closed || value.length === 0) throw new Error("invalid quoted identifier");
      tokens.push({ kind: "quoted", value });
      continue;
    }
    if (char === "(" || char === ")" || char === "," || char === "[" || char === "]") {
      tokens.push({ kind: "punctuation", value: char });
      index++;
      continue;
    }
    if (/[0-9]/.test(char)) {
      const start = index++;
      while (index < input.length && /[0-9]/.test(input[index]!)) index++;
      tokens.push({ kind: "number", value: input.slice(start, index) });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (index < input.length && /[A-Za-z0-9_$]/.test(input[index]!)) index++;
      tokens.push({ kind: "word", value: input.slice(start, index) });
      continue;
    }
    throw new Error("invalid type character");
  }
  return tokens;
}

class DuckTypeParser {
  private index = 0;

  public constructor(private readonly tokens: readonly Token[]) {}

  public done(): boolean {
    return this.index === this.tokens.length;
  }

  public parseType(depth: number): DuckType {
    if (depth > MAX_TYPE_DEPTH) throw new Error("type depth");
    const nameToken = this.take("word");
    const name = normalizeScalarName(nameToken.value);
    let parsed: DuckType;
    switch (name) {
      case "STRUCT":
        parsed = this.parseStruct(depth);
        break;
      case "MAP":
        parsed = this.parseMap(depth);
        break;
      case "LIST":
        parsed = this.parseList(depth);
        break;
      case "ARRAY":
        parsed = this.parseArray(depth);
        break;
      case "DECIMAL":
      case "NUMERIC":
        parsed = this.parseDecimal();
        break;
      case "DATE":
        parsed = { kind: "temporal", name: "DATE", precision: 0, zoned: false };
        break;
      case "TIME":
        parsed = { kind: "temporal", name: "TIME", precision: 6, zoned: this.parseZoneSuffix() };
        break;
      case "TIMESTAMP":
        parsed = { kind: "temporal", name: "TIMESTAMP", precision: 6, zoned: this.parseZoneSuffix() };
        break;
      case "TIMESTAMP_S":
        parsed = { kind: "temporal", name: "TIMESTAMP", precision: 0, zoned: false };
        break;
      case "TIMESTAMP_MS":
        parsed = { kind: "temporal", name: "TIMESTAMP", precision: 3, zoned: false };
        break;
      case "TIMESTAMP_NS":
        parsed = { kind: "temporal", name: "TIMESTAMP", precision: 9, zoned: false };
        break;
      case "TIMESTAMPTZ":
        parsed = { kind: "temporal", name: "TIMESTAMP", precision: 6, zoned: true };
        break;
      default:
        parsed = this.parseScalar(name);
    }

    while (this.matches("[")) {
      if (this.matches("]")) parsed = { kind: "list", child: parsed };
      else {
        const length = this.positiveInteger();
        this.expect("]");
        parsed = { kind: "array", child: parsed, length };
      }
      depth++;
      if (depth > MAX_TYPE_DEPTH) throw new Error("type depth");
    }
    return parsed;
  }

  private parseStruct(depth: number): DuckType {
    this.expect("(");
    const fields: Array<{ readonly name: string; readonly type: DuckType }> = [];
    const names = new Set<string>();
    do {
      const name = this.takeAny("word", "quoted").value;
      if (names.has(name)) throw new Error("duplicate struct field");
      names.add(name);
      fields.push({ name, type: this.parseType(depth + 1) });
      if (fields.length > MAX_CONTAINER_ENTRIES) throw new Error("struct width");
    } while (this.matches(","));
    this.expect(")");
    if (fields.length === 0) throw new Error("empty struct");
    return { kind: "struct", fields };
  }

  private parseMap(depth: number): DuckType {
    this.expect("(");
    const key = this.parseType(depth + 1);
    this.expect(",");
    const value = this.parseType(depth + 1);
    this.expect(")");
    return { kind: "map", key, value };
  }

  private parseList(depth: number): DuckType {
    this.expect("(");
    const child = this.parseType(depth + 1);
    this.expect(")");
    return { kind: "list", child };
  }

  private parseArray(depth: number): DuckType {
    this.expect("(");
    const child = this.parseType(depth + 1);
    this.expect(",");
    const length = this.positiveInteger();
    this.expect(")");
    return { kind: "array", child, length };
  }

  private parseDecimal(): DuckType {
    if (!this.matches("(")) return { kind: "decimal", precision: 18, scale: 3 };
    const precision = this.positiveInteger();
    let scale = 0;
    if (this.matches(",")) scale = this.nonNegativeInteger();
    this.expect(")");
    if (precision > 38 || scale > precision) throw new Error("decimal bounds");
    return { kind: "decimal", precision, scale };
  }

  private parseZoneSuffix(): boolean {
    const token = this.peek();
    if (token?.kind !== "word") return false;
    const word = token.value.toUpperCase();
    if (word !== "WITH" && word !== "WITHOUT") return false;
    this.index++;
    this.expectWord("TIME");
    this.expectWord("ZONE");
    return word === "WITH";
  }

  private parseScalar(initialName: string): DuckType {
    let name = initialName;
    if (name === "DOUBLE" && this.matchesWord("PRECISION")) name = "DOUBLE";
    if (name === "CHARACTER" && this.matchesWord("VARYING")) name = "CHARACTER VARYING";
    if (name === "BIT" && this.matchesWord("STRING")) name = "BIT STRING";
    if (this.matches("(")) {
      this.nonNegativeInteger();
      this.expect(")");
    }
    return { kind: "scalar", name };
  }

  private positiveInteger(): number {
    const value = this.nonNegativeInteger();
    if (value < 1) throw new Error("positive integer required");
    return value;
  }

  private nonNegativeInteger(): number {
    const token = this.take("number");
    const value = Number(token.value);
    if (!Number.isSafeInteger(value) || value > MAX_CONTAINER_ENTRIES) throw new Error("integer bound");
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private matches(value: Token["value"]): boolean {
    if (this.peek()?.value !== value) return false;
    this.index++;
    return true;
  }

  private matchesWord(value: string): boolean {
    const token = this.peek();
    if (token?.kind !== "word" || token.value.toUpperCase() !== value) return false;
    this.index++;
    return true;
  }

  private expect(value: Token["value"]): void {
    if (!this.matches(value)) throw new Error("unexpected token");
  }

  private expectWord(value: string): void {
    if (!this.matchesWord(value)) throw new Error("unexpected word");
  }

  private take<K extends Token["kind"]>(kind: K): Extract<Token, { kind: K }> {
    const token = this.tokens[this.index];
    if (!token || token.kind !== kind) throw new Error("unexpected token kind");
    this.index++;
    return token as Extract<Token, { kind: K }>;
  }

  private takeAny<A extends Token["kind"], B extends Token["kind"]>(
    first: A,
    second: B,
  ): Extract<Token, { kind: A | B }> {
    const token = this.tokens[this.index];
    if (!token || (token.kind !== first && token.kind !== second)) throw new Error("unexpected token kind");
    this.index++;
    return token as Extract<Token, { kind: A | B }>;
  }
}

function normalizeScalarName(name: string): string {
  switch (name.toUpperCase()) {
    case "BOOL":
    case "LOGICAL":
      return "BOOLEAN";
    case "DEC":
      return "DECIMAL";
    case "DATETIME":
      return "TIMESTAMP";
    case "FLOAT4":
      return "FLOAT";
    case "FLOAT8":
      return "DOUBLE";
    case "INT":
    case "INT4":
    case "SIGNED":
      return "INTEGER";
    case "INT1":
      return "TINYINT";
    case "INT2":
    case "SHORT":
      return "SMALLINT";
    case "INT8":
    case "LONG":
      return "BIGINT";
    case "BPCHAR":
      return "CHAR";
    default:
      return name.toUpperCase();
  }
}
