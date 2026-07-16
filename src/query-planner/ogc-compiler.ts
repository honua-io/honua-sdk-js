import type {
  CanonicalGeometry,
  CrsDefinition,
  ExecutableBoundingBox,
  ExecutableCrsBinding,
  ExecutableGeometryValue,
  JsonValue,
  LogicalField,
  Position,
  SourceProtocol,
  SourceSchemaV2,
} from "../contract/schema.js";
import { canonicalStringify, sha256, toJsonValue } from "./canonical.js";
import { semanticSchemaField, semanticUnsupported } from "./semantic-compiler.js";
import { HonuaQueryPlanningError } from "./types.js";

const MAX_EVIDENCE_ENTRIES = 256;
const MAX_EVIDENCE_TEXT_BYTES = 8_192;
const MAX_NAMESPACE_BINDINGS = 64;
const MAX_NAMESPACE_TEXT_BYTES = 2_048;
const TEXT_ENCODER = new TextEncoder();

export interface OgcAxisPlan {
  readonly srsName: string;
  /** Target/definition-axis index to source/payload-axis index. */
  readonly permutation: readonly number[];
}

export interface NormalizedNamespaceBindings {
  readonly bindings: Readonly<Record<string, string>>;
  readonly ordered: readonly (readonly [string, string])[];
}

/** @internal Normalize an explicit conformance declaration without inferring support. */
export function normalizeConformanceUris(value: readonly string[], path: string): readonly string[] {
  if (!Array.isArray(value)) throw new HonuaQueryPlanningError("invalid-query", `${path} must be an array`);
  if (value.length > MAX_EVIDENCE_ENTRIES) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `${path} exceeds the ${MAX_EVIDENCE_ENTRIES}-entry evidence bound`,
    );
  }
  const normalized = value.map((entry, index) => normalizeEvidenceUri(entry, `${path}[${index}]`));
  normalized.sort(compareUtf8);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] === normalized[index - 1]) {
      throw new HonuaQueryPlanningError("invalid-query", `${path} contains duplicate conformance URI`);
    }
  }
  return Object.freeze(normalized);
}

/** @internal Normalize explicit CRS/namespace-style URI evidence. */
export function normalizeIdentifierUris(value: readonly string[] | undefined, path: string): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new HonuaQueryPlanningError("invalid-query", `${path} must be an array`);
  if (value.length > MAX_EVIDENCE_ENTRIES) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `${path} exceeds the ${MAX_EVIDENCE_ENTRIES}-entry evidence bound`,
    );
  }
  const normalized = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || byteLength(entry) > MAX_EVIDENCE_TEXT_BYTES) {
      throw new HonuaQueryPlanningError("invalid-query", `${path}[${index}] must be a bounded non-empty URI`);
    }
    assertAbsolutePublicIdentifier(entry, `${path}[${index}]`);
    return entry;
  });
  normalized.sort(compareUtf8);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] === normalized[index - 1]) {
      throw new HonuaQueryPlanningError("invalid-query", `${path} contains duplicate URI evidence`);
    }
  }
  return Object.freeze(normalized);
}

/** @internal Stable identity for normalized source capability evidence. */
export function compilerEvidenceFingerprint(domain: string, evidence: JsonValue): `sha256:${string}` {
  return sha256(`${domain}\n${canonicalStringify(evidence)}`);
}

/** @internal Stable identity for an immutable compiled request pre-image. */
export function compiledRequestFingerprint(domain: string, artifact: JsonValue): `sha256:${string}` {
  return sha256(`${domain}\n${canonicalStringify(artifact)}`);
}

/** @internal Match only the OGC conformance identifier itself, not a substring. */
export function hasConformanceClass(conformsTo: readonly string[], standard: string, name: string): boolean {
  const expected = `/spec/${standard.toLowerCase()}/conf/${name.toLowerCase()}`;
  return conformsTo.some((entry) => {
    const url = new URL(entry);
    return (
      url.hostname.toLowerCase() === "www.opengis.net" && trimTrailingSlash(url.pathname).toLowerCase() === expected
    );
  });
}

/** @internal Select the physical source property represented by one logical field. */
export function ogcFieldPath(
  schema: SourceSchemaV2,
  name: string,
  protocol: Extract<SourceProtocol, "ogc-features" | "wfs">,
  path: string,
): readonly string[] {
  const field = semanticSchemaField(schema, name, path);
  const nativePaths = field.native
    .filter((entry) => entry.protocol === protocol && entry.path !== undefined)
    .map((entry) => entry.path as readonly string[]);
  if (nativePaths.length > 1) {
    const identities = new Set(nativePaths.map((entry) => canonicalStringify(toJsonValue(entry))));
    if (identities.size > 1) {
      semanticUnsupported(
        "unsupported-source",
        path,
        `${protocol} field ${JSON.stringify(name)} has conflicting native property paths`,
      );
    }
  }
  return nativePaths[0] ?? field.path;
}

/** @internal Require a single CQL2 queryable name. */
export function cql2FieldName(schema: SourceSchemaV2, name: string, path: string): string {
  const fieldPath = ogcFieldPath(schema, name, "ogc-features", path);
  if (fieldPath.length !== 1) {
    semanticUnsupported(
      "unsupported-source",
      path,
      `CQL2 property ${JSON.stringify(name)} must resolve to exactly one native path segment`,
    );
  }
  return fieldPath[0] as string;
}

/** @internal Require a namespace-safe FES ValueReference. */
export function fesValueReference(
  schema: SourceSchemaV2,
  name: string,
  namespaces: NormalizedNamespaceBindings,
  path: string,
): string {
  const segments = ogcFieldPath(schema, name, "wfs", path);
  for (const [index, segment] of segments.entries()) {
    assertFesPathSegment(segment, namespaces, `${path}.nativePath[${index}]`);
  }
  return segments.join("/");
}

/** @internal Validate and deterministically order namespace bindings. */
export function normalizeNamespaceBindings(
  value: Readonly<Record<string, string>> | undefined,
  path: string,
): NormalizedNamespaceBindings {
  if (value === undefined) return { bindings: Object.freeze({}), ordered: Object.freeze([]) };
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new HonuaQueryPlanningError("invalid-query", `${path} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new HonuaQueryPlanningError("invalid-query", `${path} must be a plain object`);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_NAMESPACE_BINDINGS) {
    throw new HonuaQueryPlanningError(
      "invalid-query",
      `${path} exceeds the ${MAX_NAMESPACE_BINDINGS}-binding namespace bound`,
    );
  }
  const bindings: Record<string, string> = {};
  for (const [prefix, uri] of entries) {
    if (
      !XML_PREFIX.test(prefix) ||
      prefix.toLowerCase().startsWith("xml") ||
      RESERVED_FES_PREFIXES.has(prefix.toLowerCase())
    ) {
      throw new HonuaQueryPlanningError("invalid-query", `${path}.${prefix} is not a safe XML namespace prefix`);
    }
    if (typeof uri !== "string" || uri.length === 0 || byteLength(uri) > MAX_NAMESPACE_TEXT_BYTES) {
      throw new HonuaQueryPlanningError("invalid-query", `${path}.${prefix} must be a bounded non-empty URI`);
    }
    assertAbsolutePublicIdentifier(uri, `${path}.${prefix}`);
    bindings[prefix] = uri;
  }
  const ordered = Object.entries(bindings).sort(([left], [right]) => compareUtf8(left, right));
  const normalizedBindings = Object.fromEntries(ordered) as Record<string, string>;
  return {
    bindings: Object.freeze(normalizedBindings),
    ordered: Object.freeze(ordered.map((entry) => Object.freeze(entry) as readonly [string, string])),
  };
}

/** @internal Verify a QName used for a WFS feature type. */
export function validateFesTypeName(typeName: string, namespaces: NormalizedNamespaceBindings, path: string): string {
  if (typeof typeName !== "string" || typeName.length === 0 || typeName.length > 512) {
    throw new HonuaQueryPlanningError("invalid-query", `${path} must be a bounded non-empty QName`);
  }
  assertFesPathSegment(typeName, namespaces, path);
  return typeName;
}

/** @internal Produce a URI usable as CQL2 filter-crs, WFS srsName, or output CRS. */
export function ogcCrsUri(definition: CrsDefinition, path: string): string {
  if (definition.kind === "authority") {
    if (definition.uri !== undefined) {
      assertAbsolutePublicIdentifier(definition.uri, path);
      return definition.uri;
    }
    const authority = encodeURIComponent(definition.authority);
    const version = encodeURIComponent(definition.version ?? "0");
    const code = encodeURIComponent(definition.code);
    return `http://www.opengis.net/def/crs/${authority}/${version}/${code}`;
  }
  if (definition.kind === "uri") {
    assertAbsolutePublicIdentifier(definition.uri, path);
    return definition.uri;
  }
  semanticUnsupported(
    "unsupported-crs",
    path,
    `OGC request parameters require an authority or URI CRS, not ${definition.kind}`,
  );
}

/** @internal Build an executable axis reordering plan; this never transforms values or units. */
export function ogcAxisPlan(binding: ExecutableCrsBinding, dimensions: 2 | 3, path: string): OgcAxisPlan {
  if (binding.coordinateEpoch !== undefined) {
    semanticUnsupported("crs-transform-required", path, "OGC filter encodings cannot preserve a coordinate epoch");
  }
  const targetOrder = binding.definition.definitionAxisOrder;
  if (targetOrder.state !== "known") {
    semanticUnsupported("unsupported-crs", path, "OGC filter execution requires known CRS-definition axis order");
  }
  const sourceAxes = binding.coordinateOrder.axes;
  const targetAxes = targetOrder.axes;
  if (sourceAxes.length !== dimensions || targetAxes.length !== dimensions) {
    semanticUnsupported(
      "crs-transform-required",
      path,
      `OGC filter execution requires exactly ${dimensions} source and CRS-definition axes for the coordinate layout`,
    );
  }
  const unused = new Set(sourceAxes.map((_, index) => index));
  const permutation = targetAxes.map((target) => {
    const matches = [...unused].filter((index) => {
      const source = sourceAxes[index];
      return source?.direction === target.direction && normalizeUnit(source.unit) === normalizeUnit(target.unit);
    });
    if (matches.length !== 1) {
      semanticUnsupported(
        "crs-transform-required",
        path,
        "payload axes cannot be reordered losslessly into CRS-definition order",
      );
    }
    const index = matches[0] as number;
    unused.delete(index);
    return index;
  });
  return { srsName: ogcCrsUri(binding.definition, path), permutation };
}

/** @internal Reorder a validated semantic geometry into CRS-definition axis order. */
export function geometryInDefinitionOrder(value: ExecutableGeometryValue, path: string): CanonicalGeometry {
  if (value.layout !== "xy" && value.layout !== "xyz") {
    semanticUnsupported(
      "unsupported-geometry",
      `${path}.layout`,
      "OGC CQL2/FES geometry literals cannot preserve measured coordinate layouts",
    );
  }
  const dimensions = value.layout === "xy" ? 2 : 3;
  const plan = ogcAxisPlan(value.crs, dimensions, `${path}.crs`);
  return mapGeometryPositions(value.geometry, (position) =>
    reorderPosition(position, plan.permutation),
  ) as CanonicalGeometry;
}

/** @internal Reorder a validated semantic bounding box into CRS-definition axis order. */
export function bboxInDefinitionOrder(value: ExecutableBoundingBox, path: string): readonly number[] {
  const layout: unknown = value.box.layout;
  if (layout !== "xy" && layout !== "xyz") {
    semanticUnsupported(
      "unsupported-geometry",
      `${path}.box.layout`,
      "OGC CQL2/FES bounding boxes cannot preserve measured coordinate layouts",
    );
  }
  const dimensions = layout === "xy" ? 2 : 3;
  const plan = ogcAxisPlan(value.crs, dimensions, `${path}.crs`);
  const lower = value.box.bounds.slice(0, dimensions);
  const upper = value.box.bounds.slice(dimensions);
  return [
    ...plan.permutation.map((index) => lower[index] as number),
    ...plan.permutation.map((index) => upper[index] as number),
  ];
}

/** @internal Return the executable filter CRS after verifying every spatial leaf agrees. */
export function sharedFilterCrs(
  current: ExecutableCrsBinding | undefined,
  next: ExecutableCrsBinding,
  path: string,
): ExecutableCrsBinding {
  if (current === undefined) return next;
  const left = canonicalStringify(
    toJsonValue({
      definition: current.definition,
      coordinateOrder: current.coordinateOrder,
      coordinateEpoch: current.coordinateEpoch ?? null,
    }),
  );
  const right = canonicalStringify(
    toJsonValue({
      definition: next.definition,
      coordinateOrder: next.coordinateOrder,
      coordinateEpoch: next.coordinateEpoch ?? null,
    }),
  );
  if (left !== right) {
    semanticUnsupported(
      "crs-transform-required",
      path,
      "one compiled filter cannot mix spatial operands with different executable CRS bindings",
    );
  }
  return current;
}

/** @internal Resolve the field metadata used to encode typed literals. */
export function compilerField(schema: SourceSchemaV2, name: string, path: string): LogicalField {
  return semanticSchemaField(schema, name, path);
}

/** @internal CQL2 identifiers follow the XML-Name-derived grammar in CQL2 1.0. */
export function cql2Identifier(value: string, path: string): string {
  if (!CQL_IDENTIFIER.test(value)) {
    semanticUnsupported(
      "unsupported-source",
      path,
      `CQL2 text cannot represent queryable identifier ${JSON.stringify(value)}`,
    );
  }
  return CQL_KEYWORDS.has(value.toUpperCase()) ? `"${value}"` : value;
}

/** @internal Encode a CQL2 character literal with all standardized control escapes. */
export function cql2StringLiteral(value: string, path: string): string {
  let output = "";
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    const controlEscape = CQL2_CONTROL_ESCAPES[code];
    if (character === "\\") output += "\\\\";
    else if (character === "'") output += "''";
    else if (controlEscape !== undefined) output += controlEscape;
    else if (code < 0x20 || code === 0x7f) {
      semanticUnsupported("unsupported-node", path, `CQL2 text cannot preserve control character U+${hex(code)}`);
    } else output += character;
  }
  return `'${output}'`;
}

const CQL2_CONTROL_ESCAPES: Readonly<Record<number, string>> = Object.freeze({
  7: "\\a",
  8: "\\b",
  9: "\\t",
  10: "\\n",
  11: "\\v",
  12: "\\f",
  13: "\\r",
});

/** @internal Escape XML 1.0 character data after rejecting unrepresentable code points. */
export function xmlText(value: string, path: string): string {
  assertXmlCharacters(value, path);
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** @internal Escape XML 1.0 attribute data after rejecting unrepresentable code points. */
export function xmlAttribute(value: string, path: string): string {
  return xmlText(value, path).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/** @internal Canonical finite-number rendering shared by CQL2, WKT, and GML. */
export function ogcNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) throw new HonuaQueryPlanningError("invalid-query", `${path} must be finite`);
  return Object.is(value, -0) ? "0" : String(value);
}

/** @internal Convert canonical geometry to deterministic WKT after axis reordering. */
export function geometryToWkt(value: CanonicalGeometry, layout: "xy" | "xyz", path: string): string {
  const suffix = layout === "xyz" ? " Z" : "";
  const position = (entry: Position, entryPath: string) =>
    entry.map((ordinate, index) => ogcNumber(ordinate, `${entryPath}[${index}]`)).join(" ");
  const sequence = (entries: readonly Position[], entryPath: string) =>
    entries.map((entry, index) => position(entry, `${entryPath}[${index}]`)).join(", ");
  const polygon = (rings: readonly (readonly Position[])[], entryPath: string) =>
    rings.map((ring, index) => `(${sequence(ring, `${entryPath}[${index}]`)})`).join(", ");
  switch (value.type) {
    case "Point":
      return `POINT${suffix} (${position(value.coordinates, `${path}.coordinates`)})`;
    case "MultiPoint":
      return `MULTIPOINT${suffix} (${value.coordinates
        .map((entry, index) => `(${position(entry, `${path}.coordinates[${index}]`)})`)
        .join(", ")})`;
    case "LineString":
      return `LINESTRING${suffix} (${sequence(value.coordinates, `${path}.coordinates`)})`;
    case "MultiLineString":
      return `MULTILINESTRING${suffix} (${value.coordinates
        .map((entry, index) => `(${sequence(entry, `${path}.coordinates[${index}]`)})`)
        .join(", ")})`;
    case "Polygon":
      return `POLYGON${suffix} (${polygon(value.coordinates, `${path}.coordinates`)})`;
    case "MultiPolygon":
      return `MULTIPOLYGON${suffix} (${value.coordinates
        .map((entry, index) => `(${polygon(entry, `${path}.coordinates[${index}]`)})`)
        .join(", ")})`;
    case "GeometryCollection":
      return `GEOMETRYCOLLECTION${suffix} (${value.geometries
        .map((entry, index) => geometryToWkt(entry, layout, `${path}.geometries[${index}]`))
        .join(", ")})`;
  }
}

/** @internal JSON-safe deep coordinate reorder. */
function mapGeometryPositions(
  value: CanonicalGeometry,
  transform: (position: Position) => Position,
): CanonicalGeometry {
  const mapPositions = (input: unknown): unknown => {
    if (!Array.isArray(input)) return input;
    if (input.length >= 2 && input.every((entry) => typeof entry === "number")) {
      return transform(input as unknown as Position);
    }
    return input.map(mapPositions);
  };
  if (value.type === "GeometryCollection") {
    return {
      type: value.type,
      geometries: value.geometries.map((entry) =>
        mapGeometryPositions(entry, transform),
      ) as unknown as typeof value.geometries,
    };
  }
  return { type: value.type, coordinates: mapPositions(value.coordinates) } as CanonicalGeometry;
}

function reorderPosition(value: Position, permutation: readonly number[]): Position {
  return permutation.map((index) => value[index] as number) as unknown as Position;
}

function normalizeEvidenceUri(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > MAX_EVIDENCE_TEXT_BYTES) {
    throw new HonuaQueryPlanningError("invalid-query", `${path} must be a bounded non-empty URI`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HonuaQueryPlanningError("invalid-query", `${path} must be an absolute URI`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new HonuaQueryPlanningError("invalid-query", `${path} must be a credential-free HTTP(S) conformance URI`);
  }
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase();
  url.pathname = trimTrailingSlash(url.pathname);
  return url.toString();
}

function assertAbsolutePublicIdentifier(value: string, path: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HonuaQueryPlanningError("invalid-query", `${path} must be an absolute URI`);
  }
  if (
    !new Set(["http:", "https:", "urn:"]).has(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new HonuaQueryPlanningError("invalid-query", `${path} must be a credential-free HTTP(S) URI or URN`);
  }
}

function assertFesPathSegment(value: string, namespaces: NormalizedNamespaceBindings, path: string): void {
  if (!FES_PATH_SEGMENT.test(value)) {
    semanticUnsupported(
      "unsupported-source",
      path,
      `FES ValueReference segment ${JSON.stringify(value)} is outside the safe QName subset`,
    );
  }
  const colon = value.indexOf(":");
  if (colon >= 0) {
    const prefix = value.slice(0, colon);
    if (!Object.hasOwn(namespaces.bindings, prefix)) {
      semanticUnsupported(
        "unsupported-source",
        path,
        `FES QName prefix ${JSON.stringify(prefix)} has no namespace binding`,
      );
    }
  }
}

function assertXmlCharacters(value: string, path: string): void {
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    const valid =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff);
    if (!valid) semanticUnsupported("unsupported-node", path, `XML 1.0 cannot preserve character U+${hex(code)}`);
  }
}

function byteLength(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength;
}

function trimTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = TEXT_ENCODER.encode(left);
  const rightBytes = TEXT_ENCODER.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] as number) - (rightBytes[index] as number);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function normalizeUnit(value: string): string {
  return value.trim().toLowerCase().replaceAll(" ", "-");
}

function hex(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, "0");
}

const XML_NAME_START = "(?:[_\\p{L}]|[\\p{Nl}])";
const XML_NAME_PART = "(?:[-._\\p{L}\\p{Nl}\\p{N}\\p{M}\\u00B7\\u203F\\u2040])";
const XML_PREFIX = new RegExp(`^${XML_NAME_START}${XML_NAME_PART}*$`, "u");
const RESERVED_FES_PREFIXES = new Set(["fes", "gml", "wfs", "xs", "xsi"]);
const FES_QNAME = `(?:${XML_NAME_START}${XML_NAME_PART}*:)?${XML_NAME_START}${XML_NAME_PART}*`;
const FES_PATH_SEGMENT = new RegExp(`^${FES_QNAME}$`, "u");
const CQL_IDENTIFIER = new RegExp(`^(?::|${XML_NAME_START})(?::|${XML_NAME_PART})*$`, "u");
const CQL_KEYWORDS = new Set([
  "A_EQUALS",
  "A_CONTAINS",
  "A_CONTAINEDBY",
  "A_OVERLAPS",
  "ACCENTI",
  "AND",
  "BBOX",
  "BETWEEN",
  "CASEI",
  "DATE",
  "DIV",
  "FALSE",
  "GEOMETRYCOLLECTION",
  "IN",
  "IS",
  "LIKE",
  "LINESTRING",
  "MULTILINESTRING",
  "MULTIPOINT",
  "MULTIPOLYGON",
  "NOT",
  "NULL",
  "OR",
  "POINT",
  "POLYGON",
  "S_INTERSECTS",
  "S_EQUALS",
  "S_DISJOINT",
  "S_TOUCHES",
  "S_WITHIN",
  "S_OVERLAPS",
  "S_CROSSES",
  "S_CONTAINS",
  "T_AFTER",
  "T_BEFORE",
  "T_CONTAINS",
  "T_DISJOINT",
  "T_DURING",
  "T_EQUALS",
  "T_FINISHEDBY",
  "T_FINISHES",
  "T_INTERSECTS",
  "T_MEETS",
  "T_METBY",
  "T_OVERLAPPEDBY",
  "T_OVERLAPS",
  "T_STARTEDBY",
  "T_STARTS",
  "TIMESTAMP",
  "TRUE",
]);
