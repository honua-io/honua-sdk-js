/**
 * Translate the canonical `geospatial.v1` conformance fixtures into the
 * SDK's protocol-neutral `Query` / `Result` vocabulary and derive the
 * assertions a live `Result` must satisfy to be conformant.
 *
 * The fixtures are the cross-SDK source of truth for the wire contract; this
 * module is the *only* place that knows the `geospatial.v1` field names. It
 * keeps the suite resilient: if a golden fixture renames/removes/retypes a
 * field (drift), the derived expectations change and the live round-trip
 * assertion fails — which is exactly the honua-server#1238 regression class
 * this gate exists to catch.
 *
 * @module
 */

import type { Query } from "@honua/sdk-js/contract";

// ── Canonical geospatial.v1 fixture shapes (protobuf-JSON) ──────────────────
// Only the fields the conformance scenarios assert on are typed here; unknown
// fields are tolerated so a purely additive schema change does not break the
// loader (additive changes are not drift).

/** geospatial.v1 SpatialReference. */
export interface CanonSpatialReference {
  wkid?: number;
  latestWkid?: number;
  wkt?: string;
}

/** geospatial.v1 AttributeValue — a scalar wrapper (oneof). */
export interface CanonAttributeValue {
  stringValue?: string;
  doubleValue?: number;
  floatValue?: number;
  intValue?: number;
  bigIntValue?: string;
  boolValue?: boolean;
  // Any future scalar wrappers fall through; the value extractor returns the
  // first defined member so additive scalars do not break extraction.
  [key: string]: unknown;
}

/** geospatial.v1 FieldDefinition. */
export interface CanonFieldDefinition {
  name: string;
  fieldType: string;
  alias?: string;
  length?: number;
  nullable?: boolean;
}

/** geospatial.v1 Feature. */
export interface CanonFeature {
  id?: string;
  attributes?: Record<string, CanonAttributeValue>;
  geometry?: Record<string, unknown>;
}

/** geospatial.v1 QueryFeaturesRequest. */
export interface CanonQueryRequest {
  serviceId: string;
  layerId: number;
  where?: string;
  outFields?: string[];
  returnGeometry?: boolean;
  outSr?: CanonSpatialReference;
  resultOffsetLong?: string | number;
  resultRecordCountLong?: string | number;
  orderBy?: string;
  spatialFilter?: Record<string, unknown>;
}

/** geospatial.v1 QueryFeaturesResponse. */
export interface CanonQueryResponse {
  objectIdFieldName?: string;
  geometryType?: string;
  spatialReference?: CanonSpatialReference;
  fields?: CanonFieldDefinition[];
  features?: CanonFeature[];
  exceededTransferLimit?: boolean;
  totalCount?: string | number;
}

// ── Request → protocol-neutral Query ────────────────────────────────────────

/** Parse a `geospatial.v1` `orderBy` string ("NAME ASC") into the SDK shape. */
function parseOrderBy(orderBy: string | undefined): Query["orderBy"] {
  if (!orderBy) return undefined;
  const specs = orderBy
    .split(",")
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
    .map((clause) => {
      const parts = clause.split(/\s+/);
      const field = parts[0] ?? "";
      const dir = (parts[1] ?? "asc").toLowerCase();
      return { field, direction: dir === "desc" ? ("desc" as const) : ("asc" as const) };
    })
    .filter((spec) => spec.field.length > 0);
  return specs.length > 0 ? specs : undefined;
}

/**
 * Map the canonical `QueryFeaturesRequest` fixture into a protocol-neutral
 * `Query`. The spatial filter from the fixture is in `geospatial.v1` shape
 * (proto geometry); rather than re-encode it into the SDK's spatial-filter
 * vocabulary (which would couple this suite to private encodings), the
 * conformance scenario issues the attribute/field/pagination portion of the
 * query — the part the honua-server#1238 projection regression affected — and
 * asserts the response *shape* against the golden. The `where` clause already
 * constrains the result set deterministically against the pinned seed.
 */
export function canonRequestToQuery(req: CanonQueryRequest): Query {
  const query: Query = {
    where: req.where ?? "1=1",
    returnGeometry: req.returnGeometry ?? true,
  };
  if (req.outFields && req.outFields.length > 0) {
    query.outFields = [...req.outFields];
  }
  const orderBy = parseOrderBy(req.orderBy);
  if (orderBy) query.orderBy = orderBy;
  const limit = canonicalInt64ToSafeInteger(req.resultRecordCountLong, "resultRecordCountLong");
  const offset = canonicalInt64ToSafeInteger(req.resultOffsetLong, "resultOffsetLong");
  if (limit !== undefined || offset !== undefined) {
    query.pagination = {
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    };
  }
  const wkid = req.outSr?.latestWkid ?? req.outSr?.wkid;
  if (typeof wkid === "number") query.outSr = wkid;
  return query;
}

function canonicalInt64ToSafeInteger(value: string | number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} must be a non-negative safe integer`);
    return value;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new RangeError(`${field} must be a canonical non-negative int64 string`);
  const exact = BigInt(value);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${field} exceeds the SDK safe-integer boundary`);
  return Number(exact);
}

// ── Golden response → expected Result contract ──────────────────────────────

/** geospatial.v1 FIELD_TYPE_* → SDK EsriFieldType string. */
const CANON_FIELD_TYPE_TO_ESRI: Record<string, string> = {
  FIELD_TYPE_STRING: "esriFieldTypeString",
  FIELD_TYPE_INTEGER: "esriFieldTypeInteger",
  FIELD_TYPE_BIG_INTEGER: "esriFieldTypeInteger",
  FIELD_TYPE_SMALL_INTEGER: "esriFieldTypeSmallInteger",
  FIELD_TYPE_DOUBLE: "esriFieldTypeDouble",
  FIELD_TYPE_FLOAT: "esriFieldTypeSingle",
  FIELD_TYPE_BOOLEAN: "esriFieldTypeSmallInteger",
  FIELD_TYPE_DATE_TIME: "esriFieldTypeDate",
  FIELD_TYPE_DATE: "esriFieldTypeDate",
  FIELD_TYPE_GEOMETRY: "esriFieldTypeGeometry",
  FIELD_TYPE_BLOB: "esriFieldTypeBlob",
  FIELD_TYPE_GUID: "esriFieldTypeGUID",
  FIELD_TYPE_OID: "esriFieldTypeOID",
};

/**
 * The canonical set of `EsriFieldType` strings the SDK contract recognises
 * (mirrors the named members of `EsriFieldType` in `src/core/types.ts`; that
 * union is open-ended via `(string & {})`, so there is no runtime enum to
 * import). The live projection check flags any on-the-wire field type outside
 * this set as drift.
 */
export const VALID_ESRI_FIELD_TYPES: ReadonlySet<string> = new Set<string>([
  "esriFieldTypeString",
  "esriFieldTypeInteger",
  "esriFieldTypeSmallInteger",
  "esriFieldTypeDouble",
  "esriFieldTypeSingle",
  "esriFieldTypeDate",
  "esriFieldTypeOID",
  "esriFieldTypeGeometry",
  "esriFieldTypeBlob",
  "esriFieldTypeRaster",
  "esriFieldTypeGUID",
  "esriFieldTypeGlobalID",
  "esriFieldTypeXML",
]);

/** Map a geospatial.v1 field type to its canonical SDK EsriFieldType. */
export function canonFieldTypeToEsri(fieldType: string): string {
  const mapped = CANON_FIELD_TYPE_TO_ESRI[fieldType];
  if (!mapped) {
    throw new Error(
      `Unknown geospatial.v1 field type "${fieldType}" in golden fixture. Either the schema added a field type (update mapping.ts) or this is drift.`,
    );
  }
  return mapped;
}

/** Extract the single defined scalar from a canonical AttributeValue. */
export function canonAttributeValue(value: CanonAttributeValue): unknown {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.floatValue !== undefined) return value.floatValue;
  if (value.intValue !== undefined) return value.intValue;
  if (value.bigIntValue !== undefined) return value.bigIntValue;
  if (value.boolValue !== undefined) return value.boolValue;
  // Fall back to the first defined member for additive scalar wrappers.
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined) return value[key];
  }
  return undefined;
}

/** A field name + canonical SDK type the live result must expose. */
export interface ExpectedField {
  name: string;
  esriType: string;
  nullable?: boolean;
}

/** What a conformant live `Result` must satisfy for the feature-query workflow. */
export interface ExpectedQueryResult {
  /** Fields (name + canonical type) the golden declares. */
  fields: ExpectedField[];
  /** Object-id field name the golden declares. */
  objectIdFieldName?: string;
  /** Geometry presence: the golden carries geometry on every feature. */
  expectsGeometry: boolean;
  /** Whether the golden signalled more records than returned. */
  exceededTransferLimit: boolean;
  /** Names that must appear in each returned feature's attributes. */
  attributeNames: string[];
  /** Total count, if the golden declared one. */
  totalCount?: number;
}

/**
 * Derive the conformance expectations from the golden response fixture. The
 * live `Result` is then checked against these (see feature-service suite):
 * field schema (names + types), object-id field, geometry presence,
 * `exceededTransferLimit`, attribute coverage, and total count. Any drift in
 * the golden (the contract) changes these expectations.
 */
export function goldenToExpectedQueryResult(golden: CanonQueryResponse): ExpectedQueryResult {
  const fields: ExpectedField[] = (golden.fields ?? []).map((field) => ({
    name: field.name,
    esriType: canonFieldTypeToEsri(field.fieldType),
    ...(field.nullable !== undefined ? { nullable: field.nullable } : {}),
  }));
  const attributeNames = new Set<string>();
  let expectsGeometry = (golden.features?.length ?? 0) > 0;
  for (const feature of golden.features ?? []) {
    if (!feature.geometry) expectsGeometry = false;
    for (const name of Object.keys(feature.attributes ?? {})) {
      attributeNames.add(name);
    }
  }
  const result: ExpectedQueryResult = {
    fields,
    expectsGeometry,
    exceededTransferLimit: golden.exceededTransferLimit ?? false,
    attributeNames: [...attributeNames],
  };
  if (golden.objectIdFieldName) result.objectIdFieldName = golden.objectIdFieldName;
  if (golden.totalCount !== undefined) {
    const n = typeof golden.totalCount === "string" ? Number.parseInt(golden.totalCount, 10) : golden.totalCount;
    if (Number.isFinite(n)) result.totalCount = n;
  }
  return result;
}
