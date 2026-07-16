import type { LogicalField } from "../contract/schema.js";
import { canonicalStringify, sha256, toJsonValue } from "./canonical.js";
import { semanticUnsupported } from "./semantic-compiler.js";
import { HonuaQueryPlanningError } from "./types.js";

const MAX_SOURCE_IDENTITY_TEXT = 512;
const MAX_PHYSICAL_SEGMENT_TEXT = 512;
// biome-ignore lint/suspicious/noControlCharactersInRegex: request identities and identifiers reject control bytes
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const ODATA_IDENTIFIER = /^[_\p{ID_Start}][_\p{ID_Continue}]*$/u;
const DECIMAL_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Trace from one public semantic field to its exact protocol request name. */
export interface SemanticCompilerFieldMapping {
  readonly logicalField: string;
  readonly physicalPath: readonly string[];
  readonly requestField: string;
}

/** @internal Record each field mapping once, in first-use order. */
export function recordSemanticFieldMapping(
  mappings: SemanticCompilerFieldMapping[],
  field: LogicalField,
  requestField: string,
): void {
  if (mappings.some((candidate) => candidate.logicalField === field.name)) return;
  mappings.push({ logicalField: field.name, physicalPath: [...field.path], requestField });
}

/** @internal Quote one SQL-92 identifier without changing its Unicode spelling. */
export function sql92Identifier(value: string, path: string): string {
  verifiedPhysicalSegment(value, path);
  return `"${value.replace(/"/g, '""')}"`;
}

/** @internal Compile an OData structural-property path with no alias rewriting. */
export function odataPropertyPath(segments: readonly string[], path: string): string {
  if (segments.length === 0) {
    semanticUnsupported("unsupported-source", path, "OData fields require a non-empty physical property path");
  }
  for (const segment of segments) {
    verifiedPhysicalSegment(segment, path);
    if (!ODATA_IDENTIFIER.test(segment)) {
      semanticUnsupported(
        "unsupported-source",
        path,
        "OData cannot represent a physical property path segment in its identifier grammar",
      );
    }
  }
  return segments.join("/");
}

/** @internal SQL/OData single-quoted string literal with quote doubling. */
export function quotedSemanticString(value: string, path: string): string {
  if (CONTROL_CHARACTER.test(value)) {
    semanticUnsupported("unsupported-node", path, "Text literals containing control characters are not portable");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** @internal Convert a finite JavaScript number to a deterministic non-exponent decimal. */
export function finiteDecimalNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    semanticUnsupported("unsupported-field-type", path, "The request dialect requires a finite numeric literal");
  }
  return expandExponent(Object.is(value, -0) ? "0" : String(value));
}

/** @internal Validate an exact JSON string-encoded integer or decimal. */
export function exactDecimalText(value: string, path: string): string {
  if (!DECIMAL_TEXT.test(value)) {
    semanticUnsupported(
      "unsupported-field-type",
      path,
      "String-encoded numeric literals require a canonical non-exponent decimal",
    );
  }
  return value;
}

/** @internal Validate one bounded, credential-free source version token. */
export function verifiedSemanticSourceVersion(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_SOURCE_IDENTITY_TEXT ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new HonuaQueryPlanningError("invalid-query", `${path} is invalid`);
  }
  return value;
}

/** @internal Validate a bounded source locator string. */
export function verifiedSemanticSourceText(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_SOURCE_IDENTITY_TEXT ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new HonuaQueryPlanningError("invalid-query", `${path} is invalid`);
  }
  return value;
}

/** @internal Domain-separated identity of the exact request pre-image. */
export function semanticRequestFingerprint(domain: string, value: unknown): `sha256:${string}` {
  return sha256(`${domain}\n${canonicalStringify(toJsonValue(value))}`);
}

function verifiedPhysicalSegment(value: string, path: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PHYSICAL_SEGMENT_TEXT ||
    CONTROL_CHARACTER.test(value)
  ) {
    semanticUnsupported("unsupported-source", path, "The physical field path contains an unsafe segment");
  }
}

function expandExponent(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(value);
  if (!match) return value;
  const sign = match[1] ?? "";
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4]);
  const digits = `${integer}${fraction}`;
  const decimalPosition = integer.length + exponent;
  if (decimalPosition <= 0) return `${sign}0.${"0".repeat(-decimalPosition)}${digits}`;
  if (decimalPosition >= digits.length) return `${sign}${digits}${"0".repeat(decimalPosition - digits.length)}`;
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}
