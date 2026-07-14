/**
 * Experimental vendor-neutral source schema v2.
 *
 * This module is the production projection of the contract accepted in
 * `docs/decisions/vendor-neutral-source-contract-v2.md`. It deliberately lives
 * beside, rather than replacing, the legacy Esri-shaped `SourceSchema`: the
 * discovery rollout dual-reads both contracts until the 1.0 cutover.
 *
 * @experimental
 * @module
 */

import { canonicalStringify, sha256, toJsonValue } from "../query-planner/canonical.js";
import validateProjJsonV07Crs from "./generated/projjson-v0.7-crs-validator.js";
import { SOURCE_SCHEMA_V2_KIND, SOURCE_SCHEMA_V2_VERSION, type SourceSchemaV2Envelope } from "./schema-envelope.js";
import { PROTOCOLS, type Protocol } from "./types.js";

export { SOURCE_SCHEMA_V2_KIND, SOURCE_SCHEMA_V2_VERSION } from "./schema-envelope.js";
export const SOURCE_SCHEMA_V2_FINGERPRINT_DOMAIN = "honua:schema:2.0" as const;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const EXTENSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*\.)+[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_NATIVE_DEFINITION_BYTES = 64 * 1024;
const MAX_PROJJSON_BYTES = 64 * 1024;
const MAX_FIELD_DOMAIN_BYTES = 1024 * 1024;
const MAX_CODED_DOMAIN_VALUES = 10_000;
const MAX_SCHEMA_BYTES = 4 * 1024 * 1024;
const MAX_TYPE_DEPTH = 32;
// A struct level adds a type object, fields array, and field object to the raw
// graph. Keep this defensive prewalk high enough for the independently
// enforced 32-level logical-type limit while still bounding adversarial input.
const MAX_SCHEMA_GRAPH_DEPTH = MAX_TYPE_DEPTH * 4 + 32;
const MAX_JSON_VALUE_DEPTH = 32;
const MAX_JSON_NODE_COUNT = 100_000;
const PROJJSON_V07_SCHEMA = "https://proj.org/schemas/v0.7/projjson.schema.json";
const PROJJSON_V07_TYPES = new Set([
  "GeographicCRS",
  "GeodeticCRS",
  "ProjectedCRS",
  "VerticalCRS",
  "CompoundCRS",
  "BoundCRS",
  "EngineeringCRS",
  "ParametricCRS",
  "TemporalCRS",
  "DerivedProjectedCRS",
  "DerivedGeographicCRS",
  "DerivedGeodeticCRS",
  "DerivedVerticalCRS",
  "DerivedEngineeringCRS",
  "DerivedTemporalCRS",
  "DerivedParametricCRS",
]);

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
export type ExtensionIdentifier = `${string}.${string}`;
export type ExtensionMap = Readonly<Record<ExtensionIdentifier, JsonValue>>;
export type IsoInstant = string;
export type Sha256 = `sha256:${string}`;
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];
export type SourceProtocol = Protocol | ExtensionIdentifier;

export interface NativeTypeReference {
  readonly protocol: SourceProtocol;
  readonly name: string;
  readonly namespace?: string;
  readonly path?: readonly string[];
  /** Sanitized metadata only. Raw protocol documents remain on native handles. */
  readonly definition?: JsonValue;
}

export interface MetadataProvenance {
  readonly method: "observed" | "declared" | "standard-default" | "inferred" | "unavailable";
  readonly protocol: SourceProtocol;
  readonly source: string;
  readonly observedAt?: IsoInstant;
  readonly validator?:
    | { readonly kind: "etag"; readonly value: string }
    | { readonly kind: "last-modified"; readonly value: string }
    | { readonly kind: "version"; readonly value: string };
  readonly detail?: string;
}

// ── CRS, axis order, geometry, and extent ────────────────────

export type AxisDirection = "east" | "west" | "north" | "south" | "up" | "down" | "future" | "past" | "other";

export interface CoordinateAxis {
  readonly name: string;
  readonly abbreviation?: string;
  readonly direction: AxisDirection;
  readonly unit: string;
}

export type AxisOrder =
  | {
      readonly state: "known";
      readonly source: "crs-definition" | "protocol" | "encoding" | "declared";
      readonly axes: readonly [CoordinateAxis, CoordinateAxis, ...CoordinateAxis[]];
    }
  | {
      readonly state: "unknown";
      readonly reason: "missing" | "unrecognized" | "conflicting";
      readonly native?: NativeTypeReference;
    };

export type CrsDefinition =
  | {
      readonly kind: "authority";
      readonly authority: string;
      readonly code: string;
      readonly version?: string;
      readonly uri?: string;
      readonly wkt?: string;
      readonly definitionAxisOrder: AxisOrder;
    }
  | {
      readonly kind: "wkt";
      readonly wkt: string;
      readonly dialect: "wkt1" | "wkt2" | "unknown";
      /** Only engine-validated WKT is safe to use for execution. */
      readonly validation: "unverified" | "engine";
      readonly name?: string;
      readonly definitionAxisOrder: AxisOrder;
    }
  | {
      readonly kind: "uri";
      readonly uri: string;
      readonly name?: string;
      readonly definitionAxisOrder: AxisOrder;
    }
  | {
      readonly kind: "projjson";
      readonly projjson: JsonObject;
      readonly name?: string;
      readonly definitionAxisOrder: AxisOrder;
    }
  | {
      readonly kind: "unknown";
      readonly reason: "missing" | "unrecognized" | "conflicting";
      readonly native?: NativeTypeReference;
    };

export type ResolvedCrsDefinition =
  | Exclude<CrsDefinition, { readonly kind: "unknown" | "wkt" }>
  | (Extract<CrsDefinition, { readonly kind: "wkt" }> & { readonly validation: "engine" });

export interface ReprojectionRecord {
  readonly source: ResolvedCrsDefinition;
  readonly target: ResolvedCrsDefinition;
  readonly operation?: string;
  readonly engine: string;
  readonly accuracyMeters?: number;
  readonly transformedAt?: IsoInstant;
}

export type CrsProvenance =
  | {
      readonly method: "metadata" | "payload" | "standard-default" | "declared";
      readonly native?: NativeTypeReference;
    }
  | {
      readonly method: "reprojected";
      readonly native?: NativeTypeReference;
      readonly reprojection: ReprojectionRecord;
    };

export interface CrsBinding {
  readonly definition: CrsDefinition;
  /** Coordinate order in the encoded payload, independent of CRS-definition order. */
  readonly coordinateOrder: AxisOrder;
  readonly coordinateEpoch?: number;
  readonly provenance: CrsProvenance;
}

export type KnownAxisOrder = Extract<AxisOrder, { readonly state: "known" }>;

export interface ExecutableCrsBinding {
  readonly definition: ResolvedCrsDefinition;
  readonly coordinateOrder: KnownAxisOrder;
  readonly coordinateEpoch?: number;
  readonly provenance: CrsProvenance;
}

export type CoordinateLayout = "xy" | "xyz" | "xym" | "xyzm";
export type Position2D = readonly [number, number];
export type Position3D = readonly [number, number, number];
export type Position4D = readonly [number, number, number, number];
export type Position = Position2D | Position3D | Position4D;
export type LinePositions<TPosition extends Position = Position> = readonly [TPosition, TPosition, ...TPosition[]];
export type LinearRing<TPosition extends Position = Position> = readonly [
  TPosition,
  TPosition,
  TPosition,
  TPosition,
  ...TPosition[],
];

export interface PointGeometry<TPosition extends Position = Position> {
  readonly type: "Point";
  readonly coordinates: TPosition;
}

export interface MultiPointGeometry<TPosition extends Position = Position> {
  readonly type: "MultiPoint";
  readonly coordinates: NonEmptyReadonlyArray<TPosition>;
}

export interface LineStringGeometry<TPosition extends Position = Position> {
  readonly type: "LineString";
  readonly coordinates: LinePositions<TPosition>;
}

export interface MultiLineStringGeometry<TPosition extends Position = Position> {
  readonly type: "MultiLineString";
  readonly coordinates: NonEmptyReadonlyArray<LinePositions<TPosition>>;
}

export interface PolygonGeometry<TPosition extends Position = Position> {
  readonly type: "Polygon";
  readonly coordinates: NonEmptyReadonlyArray<LinearRing<TPosition>>;
}

export interface MultiPolygonGeometry<TPosition extends Position = Position> {
  readonly type: "MultiPolygon";
  readonly coordinates: NonEmptyReadonlyArray<NonEmptyReadonlyArray<LinearRing<TPosition>>>;
}

export interface GeometryCollectionGeometry<TPosition extends Position = Position> {
  readonly type: "GeometryCollection";
  readonly geometries: NonEmptyReadonlyArray<CanonicalGeometry<TPosition>>;
}

export type CanonicalGeometry<TPosition extends Position = Position> =
  | PointGeometry<TPosition>
  | MultiPointGeometry<TPosition>
  | LineStringGeometry<TPosition>
  | MultiLineStringGeometry<TPosition>
  | PolygonGeometry<TPosition>
  | MultiPolygonGeometry<TPosition>
  | GeometryCollectionGeometry<TPosition>;

export type GeometryKind = CanonicalGeometry["type"];

export type PresentGeometryWithCrs<TCrs extends CrsBinding | ExecutableCrsBinding> =
  | {
      readonly state: "present";
      readonly geometry: CanonicalGeometry<Position2D>;
      readonly crs: TCrs;
      readonly layout: "xy";
    }
  | {
      readonly state: "present";
      readonly geometry: CanonicalGeometry<Position3D>;
      readonly crs: TCrs;
      readonly layout: "xyz" | "xym";
    }
  | {
      readonly state: "present";
      readonly geometry: CanonicalGeometry<Position4D>;
      readonly crs: TCrs;
      readonly layout: "xyzm";
    };

export type PresentGeometryValue = PresentGeometryWithCrs<CrsBinding>;
export type ExecutableGeometryValue = PresentGeometryWithCrs<ExecutableCrsBinding>;

export interface EmptyGeometryValue {
  readonly state: "empty";
  readonly expectedType?: GeometryKind;
  readonly crs: CrsBinding;
  readonly layout: CoordinateLayout | "unknown";
}

export type GeometryValue = PresentGeometryValue | EmptyGeometryValue;

export type GeometryTypeKnowledge =
  | { readonly state: "known"; readonly type: GeometryKind }
  | { readonly state: "mixed"; readonly types: readonly [GeometryKind, GeometryKind, ...GeometryKind[]] }
  | {
      readonly state: "unknown";
      readonly reason: "missing" | "unrecognized" | "conflicting" | "unsupported";
      readonly native?: NativeTypeReference;
    };

export interface GeometryFieldSchema {
  readonly field: string;
  readonly geometryTypes: GeometryTypeKnowledge;
  readonly crs: CrsBinding;
  readonly layout: CoordinateLayout | "unknown";
  readonly allowsEmpty: boolean | "unknown";
}

export type PrimaryGeometryField =
  | { readonly state: "known"; readonly field: string }
  | { readonly state: "none"; readonly reason: "not-declared" | "no-default" }
  | { readonly state: "unknown"; readonly reason: "metadata-unavailable" | "conflicting" };

export type SourceGeometrySchema =
  | { readonly state: "none"; readonly reason: "declared-non-spatial" | "no-geometry-fields" }
  | {
      readonly state: "known";
      readonly fields: NonEmptyReadonlyArray<GeometryFieldSchema>;
      readonly primaryField: PrimaryGeometryField;
    }
  | {
      readonly state: "unknown";
      readonly reason: "metadata-unavailable" | "missing" | "unrecognized" | "conflicting";
      readonly native?: NativeTypeReference;
    };

export type BoundingBox =
  | { readonly layout: "xy"; readonly bounds: readonly [number, number, number, number] }
  | { readonly layout: "xyz"; readonly bounds: readonly [number, number, number, number, number, number] };

export interface ExecutableBoundingBox {
  readonly box: BoundingBox;
  readonly crs: ExecutableCrsBinding;
}

export type SpatialExtent =
  | {
      readonly state: "known";
      readonly boxes: NonEmptyReadonlyArray<BoundingBox>;
      readonly crs: CrsBinding;
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    }
  | {
      readonly state: "empty";
      readonly reason: "empty-source" | "empty-result" | "all-geometries-empty";
      readonly crs: CrsBinding;
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    }
  | {
      readonly state: "mixed";
      readonly extents: readonly [
        Extract<SpatialExtent, { readonly state: "known" | "empty" }>,
        Extract<SpatialExtent, { readonly state: "known" | "empty" }>,
        ...Extract<SpatialExtent, { readonly state: "known" | "empty" }>[],
      ];
      readonly reason: "multiple-crs";
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    }
  | {
      readonly state: "unknown";
      readonly reason: "not-reported" | "not-computed" | "invalid";
      readonly native?: NativeTypeReference;
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    }
  | {
      readonly state: "none";
      readonly reason: "non-spatial";
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    };

export type TemporalReferenceSystem =
  | { readonly kind: "gregorian" }
  | { readonly kind: "uri"; readonly uri: string }
  | {
      readonly kind: "unknown";
      readonly reason: "missing" | "unrecognized" | "conflicting";
      readonly native?: NativeTypeReference;
    };

export type TemporalInterval = readonly [string | null, string | null];

export type TemporalExtent =
  | {
      readonly state: "known";
      readonly intervals: NonEmptyReadonlyArray<TemporalInterval>;
      readonly referenceSystem: TemporalReferenceSystem;
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    }
  | {
      readonly state: "empty";
      readonly reason: "empty-source" | "empty-result" | "no-temporal-values";
      readonly referenceSystem?: TemporalReferenceSystem;
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    }
  | {
      readonly state: "unknown";
      readonly reason: "not-reported" | "not-computed" | "invalid" | "conflicting";
      readonly native?: NativeTypeReference;
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    }
  | {
      readonly state: "none";
      readonly reason: "non-temporal";
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    };

// ── Logical fields and source schema ─────────────────────────

export type IntegerWidth = 8 | 16 | 32 | 64;
export type FloatWidth = 32 | 64;
export type TemporalUnit = "second" | "millisecond" | "microsecond" | "nanosecond";

export type LogicalType =
  | { readonly kind: "boolean" }
  | {
      readonly kind: "integer";
      readonly bits: IntegerWidth;
      readonly signed: boolean;
      readonly jsonEncoding: "number" | "string";
    }
  | { readonly kind: "float"; readonly bits: FloatWidth }
  | {
      readonly kind: "decimal";
      readonly precision?: number;
      readonly scale?: number;
      readonly jsonEncoding: "number" | "string";
    }
  | { readonly kind: "string"; readonly maxLength?: number; readonly encoding?: string }
  | { readonly kind: "binary"; readonly encoding: "base64" | "url" | "opaque" }
  | { readonly kind: "uuid" }
  | { readonly kind: "date" }
  | { readonly kind: "time"; readonly unit: TemporalUnit }
  | {
      readonly kind: "timestamp";
      readonly unit: TemporalUnit;
      readonly timezone: "utc" | "offset" | "local" | "unknown";
    }
  | { readonly kind: "duration"; readonly unit: TemporalUnit }
  | { readonly kind: "json" }
  | { readonly kind: "geometry" }
  | { readonly kind: "list"; readonly element: LogicalType }
  | { readonly kind: "struct"; readonly fields: readonly LogicalField[] }
  | { readonly kind: "union"; readonly members: readonly [LogicalType, LogicalType, ...LogicalType[]] }
  | {
      readonly kind: "unknown";
      readonly reason: "missing" | "unrecognized" | "conflicting" | "unsupported";
      readonly native?: NativeTypeReference;
    };

export type BuiltInFieldRole =
  | "primary-key"
  | "feature-id"
  | "geometry"
  | "time-instant"
  | "time-start"
  | "time-end"
  | "created-at"
  | "updated-at";
export type FieldRole = BuiltInFieldRole | ExtensionIdentifier;
export type DomainValue = Exclude<JsonPrimitive, null>;
export type OrderedDomainValue = string | number;

export interface CodedDomainValue {
  readonly value: DomainValue;
  readonly label?: string;
  readonly description?: string;
  readonly extensions?: ExtensionMap;
}

export interface RangeEndpoint {
  readonly value: OrderedDomainValue;
  readonly inclusive: boolean;
}

export type FieldValueDomain =
  | { readonly state: "none"; readonly reason: "unconstrained" | "not-applicable" }
  | {
      readonly state: "coded";
      readonly values: NonEmptyReadonlyArray<CodedDomainValue>;
      readonly openness: "closed" | "open" | "unknown";
    }
  | ({ readonly state: "range"; readonly unit?: string } & (
      | { readonly minimum: RangeEndpoint; readonly maximum?: RangeEndpoint }
      | { readonly minimum?: never; readonly maximum: RangeEndpoint }
    ))
  | {
      readonly state: "unknown";
      readonly reason: "not-reported" | "unrecognized" | "conflicting" | "limit-exceeded";
      readonly native?: NativeTypeReference;
    };

export type FieldConstraint =
  | { readonly kind: "length"; readonly minimum?: number; readonly maximum?: number }
  | { readonly kind: "pattern"; readonly syntax: "ecma-262"; readonly expression: string; readonly flags?: string }
  | { readonly kind: "multiple-of"; readonly value: number }
  | { readonly kind: "unique" }
  | { readonly kind: ExtensionIdentifier; readonly value: JsonValue };

export type FieldConstraintState =
  | { readonly state: "none" }
  | { readonly state: "known"; readonly values: NonEmptyReadonlyArray<FieldConstraint> }
  | {
      readonly state: "partial";
      readonly values: NonEmptyReadonlyArray<FieldConstraint>;
      readonly reason: "unrecognized" | "conflicting" | "limit-exceeded";
      readonly native: NonEmptyReadonlyArray<NativeTypeReference>;
    }
  | {
      readonly state: "unknown";
      readonly reason: "not-reported" | "unrecognized" | "conflicting" | "limit-exceeded";
      readonly native?: NativeTypeReference;
    };

export interface LogicalField {
  readonly name: string;
  /**
   * Absolute native path from the source-record root. Struct descendants
   * strictly extend their parent's path. Paths are unique among fields that
   * can be addressed at the same time; mutually exclusive union branches may
   * reuse one native path.
   */
  readonly path: NonEmptyReadonlyArray<string>;
  readonly title?: string;
  readonly description?: string;
  readonly type: LogicalType;
  readonly nullability: "nullable" | "non-nullable" | "unknown";
  readonly mutability: "read-only" | "read-write" | "write-once" | "unknown";
  readonly roles: readonly FieldRole[];
  readonly defaultValue?: JsonValue;
  readonly domain: FieldValueDomain;
  readonly constraints: FieldConstraintState;
  readonly native: readonly NativeTypeReference[];
  readonly extensions?: ExtensionMap;
}

export type KeyDefinition =
  | { readonly state: "known"; readonly fields: NonEmptyReadonlyArray<string> }
  | { readonly state: "none" }
  | { readonly state: "unknown"; readonly reason: "metadata-unavailable" | "not-declared" | "conflicting" };

export type TemporalSchema =
  | { readonly state: "none" }
  | { readonly state: "instant"; readonly field: string }
  | { readonly state: "interval"; readonly startField: string; readonly endField: string }
  | { readonly state: "mixed"; readonly fields: NonEmptyReadonlyArray<string> }
  | { readonly state: "unknown"; readonly reason: "metadata-unavailable" | "not-declared" | "conflicting" };

export interface SourceSchemaV2 extends SourceSchemaV2Envelope {
  readonly fields: readonly LogicalField[];
  readonly key: KeyDefinition;
  readonly geometry: SourceGeometrySchema;
  readonly temporal: TemporalSchema;
  readonly openContent: "closed" | "open" | "unknown";
  readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
  readonly extensions?: ExtensionMap;
}

export type SourceSchemaV2Input = Omit<SourceSchemaV2, "kind" | "version" | "fingerprint">;

export type SchemaState<TSchema extends SourceSchemaV2 = SourceSchemaV2> =
  | { readonly state: "known"; readonly value: TSchema }
  | {
      readonly state: "unavailable";
      readonly reason: "not-requested" | "request-failed" | "not-advertised" | "invalid";
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    };

export type SchemaIdentity =
  | { readonly state: "known"; readonly fingerprint: Sha256 }
  | {
      readonly state: "unavailable";
      readonly reason: "not-requested" | "request-failed" | "not-advertised" | "invalid";
      readonly provenance: NonEmptyReadonlyArray<MetadataProvenance>;
    };

export type SchemaIdentityFor<TSchemaState extends SchemaState> = TSchemaState extends {
  readonly state: "known";
  readonly value: infer TSchema extends SourceSchemaV2;
}
  ? { readonly state: "known"; readonly fingerprint: TSchema["fingerprint"] }
  : TSchemaState extends Extract<SchemaState, { readonly state: "unavailable" }>
    ? {
        readonly state: "unavailable";
        readonly reason: TSchemaState["reason"];
        readonly provenance: TSchemaState["provenance"];
      }
    : never;

export type FeatureIdentityValue = string | number | boolean;

export interface FeatureIdentityPart {
  readonly field: string;
  readonly value: FeatureIdentityValue;
}

export type FeatureIdentity =
  | { readonly kind: "scalar"; readonly value: FeatureIdentityValue; readonly field?: string }
  | {
      readonly kind: "composite";
      readonly parts: readonly [FeatureIdentityPart, FeatureIdentityPart, ...FeatureIdentityPart[]];
    };

/** Create, validate, canonicalize, fingerprint, and deeply freeze a schema. */
export function createSourceSchemaV2(input: SourceSchemaV2Input): SourceSchemaV2 {
  const plainInput = object(toPlainJson(input), "$");
  const candidate = {
    ...plainInput,
    kind: SOURCE_SCHEMA_V2_KIND,
    version: SOURCE_SCHEMA_V2_VERSION,
  };
  const normalized = normalizeSchema(candidate, false);
  const fingerprint = schemaFingerprint(normalized);
  const schema = { ...normalized, fingerprint };
  assertSchemaByteBound(schema);
  return deepFreeze(schema);
}

/** Parse a serialized/object schema, rejecting future versions and fingerprint drift. */
export function parseSourceSchemaV2(value: string | unknown): SourceSchemaV2 {
  let parsed: unknown;
  if (typeof value === "string") {
    if (value.length > MAX_SCHEMA_BYTES || utf8ByteLength(value) > MAX_SCHEMA_BYTES) {
      throw new TypeError(`Serialized SourceSchemaV2 exceeds the ${MAX_SCHEMA_BYTES}-byte bound`);
    }
    try {
      parsed = JSON.parse(value) as unknown;
    } catch (cause) {
      throw new TypeError("SourceSchemaV2 must be valid JSON", { cause });
    }
    assertUniqueJsonObjectNames(value);
  } else {
    parsed = value;
  }
  const candidate = toPlainJson(parsed);
  const record = object(candidate, "$", [
    "kind",
    "version",
    "fingerprint",
    "fields",
    "key",
    "geometry",
    "temporal",
    "openContent",
    "provenance",
    "extensions",
  ]);
  if (record.kind !== SOURCE_SCHEMA_V2_KIND || record.version !== SOURCE_SCHEMA_V2_VERSION) {
    throw new TypeError(
      `Unsupported source schema discriminator; expected ${SOURCE_SCHEMA_V2_KIND}@${SOURCE_SCHEMA_V2_VERSION}`,
    );
  }
  if (typeof record.fingerprint !== "string" || !SHA256_PATTERN.test(record.fingerprint)) {
    throw new TypeError("SourceSchemaV2.fingerprint must be a lowercase SHA-256 digest");
  }
  const normalized = normalizeSchema(record, true);
  const computed = schemaFingerprint(normalized);
  if (record.fingerprint !== computed)
    throw new TypeError("SourceSchemaV2 fingerprint does not match canonical content");
  const schema = { ...normalized, fingerprint: computed };
  assertSchemaByteBound(schema);
  return deepFreeze(schema);
}

/** Canonical JSON form suitable for cache/storage interchange. */
export function serializeSourceSchemaV2(schema: SourceSchemaV2): string {
  const verified = parseSourceSchemaV2(schema);
  return canonicalStringify(toJsonValue(verified));
}

/** JSON-safe clone whose fingerprint and nested immutability are revalidated. */
export function cloneSourceSchemaV2(schema: SourceSchemaV2): SourceSchemaV2 {
  return parseSourceSchemaV2(serializeSourceSchemaV2(schema));
}

export function sourceSchemaIdentity(schema: SchemaState): SchemaIdentity {
  if (schema.state === "known") {
    const verified = parseSourceSchemaV2(schema.value);
    return deepFreeze({ state: "known", fingerprint: verified.fingerprint });
  }
  if (!includes(["not-requested", "request-failed", "not-advertised", "invalid"] as const, schema.reason)) {
    throw new TypeError("SchemaState.reason is invalid");
  }
  return deepFreeze({ state: "unavailable", reason: schema.reason, provenance: cloneProvenance(schema.provenance) });
}

/** @internal Adapter boundary for degrading malformed CRS metadata without losing its enclosing schema. */
export function validateSourceCrsDefinition(value: unknown): CrsDefinition {
  return deepFreeze(normalizeCrsDefinition(toPlainJson(value), "$.crs"));
}

function normalizeSchema(value: unknown, hasFingerprint: boolean): Omit<SourceSchemaV2, "fingerprint"> {
  const allowed = [
    "kind",
    "version",
    ...(hasFingerprint ? ["fingerprint"] : []),
    "fields",
    "key",
    "geometry",
    "temporal",
    "openContent",
    "provenance",
    "extensions",
  ];
  const record = object(value, "$", allowed);
  if (record.kind !== SOURCE_SCHEMA_V2_KIND || record.version !== SOURCE_SCHEMA_V2_VERSION) {
    throw new TypeError(`SourceSchemaV2 must use ${SOURCE_SCHEMA_V2_KIND}@${SOURCE_SCHEMA_V2_VERSION}`);
  }
  const fields = array(record.fields, "$.fields").map((field, index) => normalizeField(field, `$.fields[${index}]`, 0));
  fields.sort(compareFields);
  unique(
    fields.map((field) => field.name),
    "SourceSchemaV2 field names",
  );
  unique(
    fields.map((field) => canonicalStringify(toJsonValue(field.path))),
    "SourceSchemaV2 field paths",
  );
  const names = new Set(fields.map((field) => field.name));
  const key = normalizeKey(record.key, names);
  const geometry = normalizeGeometrySchema(record.geometry, names, fields);
  const temporal = normalizeTemporalSchema(record.temporal, names, fields);
  validateFieldSemantics(fields, key, geometry, temporal);
  if (record.openContent !== "closed" && record.openContent !== "open" && record.openContent !== "unknown") {
    throw new TypeError("SourceSchemaV2.openContent is invalid");
  }
  const provenance = normalizeProvenanceArray(record.provenance, "$.provenance");
  const extensions =
    record.extensions === undefined ? undefined : normalizeExtensions(record.extensions, "$.extensions");
  return {
    kind: SOURCE_SCHEMA_V2_KIND,
    version: SOURCE_SCHEMA_V2_VERSION,
    fields,
    key,
    geometry,
    temporal,
    openContent: record.openContent,
    provenance,
    ...(extensions ? { extensions } : {}),
  };
}

function normalizeField(value: unknown, path: string, depth: number): LogicalField {
  const record = object(value, path, [
    "name",
    "path",
    "title",
    "description",
    "type",
    "nullability",
    "mutability",
    "roles",
    "defaultValue",
    "domain",
    "constraints",
    "native",
    "extensions",
  ]);
  const name = text(record.name, `${path}.name`);
  const fieldPath = nonEmptyTextArray(record.path, `${path}.path`);
  const type = normalizeLogicalType(record.type, `${path}.type`, depth + 1);
  if (!includes(["nullable", "non-nullable", "unknown"] as const, record.nullability)) {
    throw new TypeError(`${path}.nullability is invalid`);
  }
  if (!includes(["read-only", "read-write", "write-once", "unknown"] as const, record.mutability)) {
    throw new TypeError(`${path}.mutability is invalid`);
  }
  const roles = [
    ...new Set(array(record.roles, `${path}.roles`).map((role, index) => fieldRole(role, `${path}.roles[${index}]`))),
  ].sort(compareCanonical);
  const domain = normalizeDomain(record.domain, `${path}.domain`, type);
  const constraints = normalizeConstraints(record.constraints, `${path}.constraints`, type);
  const native = array(record.native, `${path}.native`).map((item, index) =>
    normalizeNative(item, `${path}.native[${index}]`),
  );
  const extensions =
    record.extensions === undefined ? undefined : normalizeExtensions(record.extensions, `${path}.extensions`);
  const defaultValue = Object.hasOwn(record, "defaultValue")
    ? jsonValue(record.defaultValue, `${path}.defaultValue`)
    : undefined;
  if (defaultValue === null && record.nullability === "non-nullable") {
    throw new TypeError(`${path}.defaultValue cannot be null for a non-nullable field`);
  }
  if (defaultValue !== undefined && !logicalValueCompatible(defaultValue, type)) {
    throw new TypeError(`${path}.defaultValue is incompatible with logical type ${type.kind}`);
  }
  const normalized: LogicalField = {
    name,
    path: fieldPath,
    ...(record.title === undefined ? {} : { title: text(record.title, `${path}.title`) }),
    ...(record.description === undefined ? {} : { description: text(record.description, `${path}.description`) }),
    type,
    nullability: record.nullability,
    mutability: record.mutability,
    roles,
    ...(Object.hasOwn(record, "defaultValue") ? { defaultValue: defaultValue as JsonValue } : {}),
    domain,
    constraints,
    native,
    ...(extensions ? { extensions } : {}),
  };
  const domainBytes = new TextEncoder().encode(
    canonicalStringify(toJsonValue({ domain: normalized.domain, constraints: normalized.constraints })),
  ).byteLength;
  if (domainBytes > MAX_FIELD_DOMAIN_BYTES) {
    throw new TypeError(`${path} domain and constraints exceed the ${MAX_FIELD_DOMAIN_BYTES}-byte bound`);
  }
  return normalized;
}

function normalizeLogicalType(value: unknown, path: string, depth: number): LogicalType {
  if (depth > MAX_TYPE_DEPTH) throw new TypeError(`${path} exceeds maximum logical-type depth ${MAX_TYPE_DEPTH}`);
  const record = object(value, path);
  const kind = record.kind;
  switch (kind) {
    case "boolean":
    case "uuid":
    case "date":
    case "json":
    case "geometry":
      exactKeys(record, path, ["kind"]);
      return { kind };
    case "integer": {
      exactKeys(record, path, ["kind", "bits", "signed", "jsonEncoding"]);
      if (!includes([8, 16, 32, 64] as const, record.bits)) throw new TypeError(`${path}.bits is invalid`);
      if (typeof record.signed !== "boolean") throw new TypeError(`${path}.signed must be boolean`);
      if (record.jsonEncoding !== "number" && record.jsonEncoding !== "string") {
        throw new TypeError(`${path}.jsonEncoding is invalid`);
      }
      return { kind, bits: record.bits, signed: record.signed, jsonEncoding: record.jsonEncoding };
    }
    case "float":
      exactKeys(record, path, ["kind", "bits"]);
      if (record.bits !== 32 && record.bits !== 64) throw new TypeError(`${path}.bits is invalid`);
      return { kind, bits: record.bits };
    case "decimal": {
      exactKeys(record, path, ["kind", "precision", "scale", "jsonEncoding"]);
      if (record.jsonEncoding !== "number" && record.jsonEncoding !== "string") {
        throw new TypeError(`${path}.jsonEncoding is invalid`);
      }
      const precision = optionalPositiveInteger(record.precision, `${path}.precision`);
      const scale = optionalNonNegativeInteger(record.scale, `${path}.scale`);
      if (precision !== undefined && scale !== undefined && scale > precision) {
        throw new TypeError(`${path}.scale must not exceed precision`);
      }
      return {
        kind,
        ...(precision === undefined ? {} : { precision }),
        ...(scale === undefined ? {} : { scale }),
        jsonEncoding: record.jsonEncoding,
      };
    }
    case "string": {
      exactKeys(record, path, ["kind", "maxLength", "encoding"]);
      const maxLength = optionalNonNegativeInteger(record.maxLength, `${path}.maxLength`);
      return {
        kind,
        ...(maxLength === undefined ? {} : { maxLength }),
        ...(record.encoding === undefined ? {} : { encoding: text(record.encoding, `${path}.encoding`) }),
      };
    }
    case "binary":
      exactKeys(record, path, ["kind", "encoding"]);
      if (!includes(["base64", "url", "opaque"] as const, record.encoding)) {
        throw new TypeError(`${path}.encoding is invalid`);
      }
      return { kind, encoding: record.encoding };
    case "time":
    case "duration":
      exactKeys(record, path, ["kind", "unit"]);
      return { kind, unit: temporalUnit(record.unit, `${path}.unit`) };
    case "timestamp":
      exactKeys(record, path, ["kind", "unit", "timezone"]);
      if (!includes(["utc", "offset", "local", "unknown"] as const, record.timezone)) {
        throw new TypeError(`${path}.timezone is invalid`);
      }
      return { kind, unit: temporalUnit(record.unit, `${path}.unit`), timezone: record.timezone };
    case "list":
      exactKeys(record, path, ["kind", "element"]);
      return { kind, element: normalizeLogicalType(record.element, `${path}.element`, depth + 1) };
    case "struct": {
      exactKeys(record, path, ["kind", "fields"]);
      const fields = array(record.fields, `${path}.fields`).map((field, index) =>
        // normalizeField advances once when it enters the child's logical
        // type. Passing the current type depth avoids counting a struct field
        // wrapper as a second logical-type level.
        normalizeField(field, `${path}.fields[${index}]`, depth),
      );
      fields.sort(compareFields);
      unique(
        fields.map((field) => field.name),
        `${path} field names`,
      );
      unique(
        fields.map((field) => canonicalStringify(toJsonValue(field.path))),
        `${path} field paths`,
      );
      return { kind, fields };
    }
    case "union": {
      exactKeys(record, path, ["kind", "members"]);
      const members = array(record.members, `${path}.members`).map((member, index) =>
        normalizeLogicalType(member, `${path}.members[${index}]`, depth + 1),
      );
      if (members.length < 2) throw new TypeError(`${path}.members must contain at least two types`);
      members.sort(compareCanonical);
      unique(
        members.map((member) => canonicalStringify(toJsonValue(typeFingerprintProjection(member)))),
        `${path}.members`,
      );
      return { kind, members: members as [LogicalType, LogicalType, ...LogicalType[]] };
    }
    case "unknown":
      exactKeys(record, path, ["kind", "reason", "native"]);
      if (!includes(["missing", "unrecognized", "conflicting", "unsupported"] as const, record.reason)) {
        throw new TypeError(`${path}.reason is invalid`);
      }
      return {
        kind,
        reason: record.reason,
        ...(record.native === undefined ? {} : { native: normalizeNative(record.native, `${path}.native`) }),
      };
    default:
      throw new TypeError(`${path}.kind is not a recognized logical type`);
  }
}

function normalizeDomain(value: unknown, path: string, type: LogicalType): FieldValueDomain {
  const record = object(value, path);
  switch (record.state) {
    case "none":
      exactKeys(record, path, ["state", "reason"]);
      if (record.reason !== "unconstrained" && record.reason !== "not-applicable") {
        throw new TypeError(`${path}.reason is invalid`);
      }
      return { state: "none", reason: record.reason };
    case "coded": {
      exactKeys(record, path, ["state", "values", "openness"]);
      if (!includes(["closed", "open", "unknown"] as const, record.openness)) {
        throw new TypeError(`${path}.openness is invalid`);
      }
      const rawValues = array(record.values, `${path}.values`);
      if (rawValues.length === 0 || rawValues.length > MAX_CODED_DOMAIN_VALUES) {
        throw new TypeError(`${path}.values must contain 1-${MAX_CODED_DOMAIN_VALUES} entries`);
      }
      const values = rawValues.map((entry, index) => {
        const coded = object(entry, `${path}.values[${index}]`, ["value", "label", "description", "extensions"]);
        const domainValue = coded.value;
        if (
          domainValue === null ||
          (typeof domainValue !== "string" && typeof domainValue !== "number" && typeof domainValue !== "boolean") ||
          (typeof domainValue === "number" && !Number.isFinite(domainValue))
        ) {
          throw new TypeError(`${path}.values[${index}].value must be a finite JSON scalar`);
        }
        if (!domainValueCompatible(domainValue, type)) {
          throw new TypeError(`${path}.values[${index}].value is incompatible with logical type ${type.kind}`);
        }
        const extensions =
          coded.extensions === undefined
            ? undefined
            : normalizeExtensions(coded.extensions, `${path}.values[${index}].extensions`);
        return {
          value: domainValue,
          ...(coded.label === undefined ? {} : { label: text(coded.label, `${path}.values[${index}].label`) }),
          ...(coded.description === undefined
            ? {}
            : { description: text(coded.description, `${path}.values[${index}].description`) }),
          ...(extensions ? { extensions } : {}),
        };
      });
      values.sort((left, right) => compareCanonical(left.value, right.value));
      unique(
        values.map((entry) => canonicalStringify(toJsonValue(entry.value))),
        `${path}.values`,
      );
      return { state: "coded", values: values as [CodedDomainValue, ...CodedDomainValue[]], openness: record.openness };
    }
    case "range": {
      exactKeys(record, path, ["state", "minimum", "maximum", "unit"]);
      if (record.minimum === undefined && record.maximum === undefined) {
        throw new TypeError(`${path} must include a minimum or maximum`);
      }
      const minimum =
        record.minimum === undefined ? undefined : normalizeRangeEndpoint(record.minimum, `${path}.minimum`);
      const maximum =
        record.maximum === undefined ? undefined : normalizeRangeEndpoint(record.maximum, `${path}.maximum`);
      if (!rangeType(type)) throw new TypeError(`${path} range is incompatible with logical type ${type.kind}`);
      if (minimum && !domainValueCompatible(minimum.value, type)) {
        throw new TypeError(`${path}.minimum is incompatible with logical type ${type.kind}`);
      }
      if (maximum && !domainValueCompatible(maximum.value, type)) {
        throw new TypeError(`${path}.maximum is incompatible with logical type ${type.kind}`);
      }
      if (minimum && maximum) {
        if (typeof minimum.value !== typeof maximum.value)
          throw new TypeError(`${path} endpoints use conflicting encodings`);
        const comparison = compareDomainValues(minimum.value, maximum.value, type);
        if (comparison === undefined) {
          throw new TypeError(`${path} endpoints cannot be ordered deterministically`);
        }
        if (comparison > 0) {
          throw new TypeError(`${path}.minimum must not exceed maximum`);
        }
        if (comparison === 0 && (!minimum.inclusive || !maximum.inclusive)) {
          throw new TypeError(`${path} equal endpoints must both be inclusive`);
        }
      }
      return {
        state: "range",
        ...(minimum ? { minimum } : {}),
        ...(maximum ? { maximum } : {}),
        ...(record.unit === undefined ? {} : { unit: text(record.unit, `${path}.unit`) }),
      } as FieldValueDomain;
    }
    case "unknown":
      exactKeys(record, path, ["state", "reason", "native"]);
      if (!includes(["not-reported", "unrecognized", "conflicting", "limit-exceeded"] as const, record.reason)) {
        throw new TypeError(`${path}.reason is invalid`);
      }
      return {
        state: "unknown",
        reason: record.reason,
        ...(record.native === undefined ? {} : { native: normalizeNative(record.native, `${path}.native`) }),
      };
    default:
      throw new TypeError(`${path}.state is invalid`);
  }
}

function normalizeRangeEndpoint(value: unknown, path: string): RangeEndpoint {
  const record = object(value, path, ["value", "inclusive"]);
  if ((typeof record.value !== "number" && typeof record.value !== "string") || record.value === "") {
    throw new TypeError(`${path}.value must be a number or non-empty string`);
  }
  if (typeof record.value === "number" && !Number.isFinite(record.value))
    throw new TypeError(`${path}.value must be finite`);
  if (typeof record.inclusive !== "boolean") throw new TypeError(`${path}.inclusive must be boolean`);
  return { value: record.value, inclusive: record.inclusive };
}

function normalizeConstraints(value: unknown, path: string, type: LogicalType): FieldConstraintState {
  const record = object(value, path);
  if (record.state === "none") {
    exactKeys(record, path, ["state"]);
    return { state: "none" };
  }
  if (record.state === "unknown") {
    exactKeys(record, path, ["state", "reason", "native"]);
    if (!includes(["not-reported", "unrecognized", "conflicting", "limit-exceeded"] as const, record.reason)) {
      throw new TypeError(`${path}.reason is invalid`);
    }
    return {
      state: "unknown",
      reason: record.reason,
      ...(record.native === undefined ? {} : { native: normalizeNative(record.native, `${path}.native`) }),
    };
  }
  if (record.state !== "known" && record.state !== "partial") throw new TypeError(`${path}.state is invalid`);
  exactKeys(record, path, record.state === "known" ? ["state", "values"] : ["state", "values", "reason", "native"]);
  const values = array(record.values, `${path}.values`).map((entry, index) =>
    normalizeConstraint(entry, `${path}.values[${index}]`, type),
  );
  if (values.length === 0) throw new TypeError(`${path}.values must be non-empty`);
  values.sort((left, right) => compareCanonical(left.kind, right.kind));
  unique(
    values.map((entry) => entry.kind),
    `${path}.values constraint kinds`,
  );
  if (record.state === "known") return { state: "known", values: values as [FieldConstraint, ...FieldConstraint[]] };
  if (!includes(["unrecognized", "conflicting", "limit-exceeded"] as const, record.reason)) {
    throw new TypeError(`${path}.reason is invalid`);
  }
  const native = array(record.native, `${path}.native`).map((entry, index) =>
    normalizeNative(entry, `${path}.native[${index}]`),
  );
  if (native.length === 0) throw new TypeError(`${path}.native must be non-empty`);
  native.sort((left, right) => compareCanonical(nativeIdentity(left), nativeIdentity(right)));
  unique(
    native.map((entry) => canonicalStringify(nativeIdentity(entry))),
    `${path}.native identities`,
  );
  return {
    state: "partial",
    values: values as [FieldConstraint, ...FieldConstraint[]],
    reason: record.reason,
    native: native as [NativeTypeReference, ...NativeTypeReference[]],
  };
}

function normalizeConstraint(value: unknown, path: string, type: LogicalType): FieldConstraint {
  const record = object(value, path);
  const kind = text(record.kind, `${path}.kind`);
  if (kind === "length") {
    exactKeys(record, path, ["kind", "minimum", "maximum"]);
    if (type.kind !== "string" && type.kind !== "binary" && type.kind !== "list") {
      throw new TypeError(`${path} length constraint is incompatible with ${type.kind}`);
    }
    const minimum = optionalNonNegativeInteger(record.minimum, `${path}.minimum`);
    const maximum = optionalNonNegativeInteger(record.maximum, `${path}.maximum`);
    if (minimum === undefined && maximum === undefined) throw new TypeError(`${path} requires a bound`);
    if (minimum !== undefined && maximum !== undefined && minimum > maximum)
      throw new TypeError(`${path} bounds conflict`);
    if (type.kind === "string" && type.maxLength !== undefined && maximum !== undefined && type.maxLength !== maximum) {
      throw new TypeError(`${path}.maximum conflicts with logical string maxLength`);
    }
    return { kind, ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) };
  }
  if (kind === "pattern") {
    exactKeys(record, path, ["kind", "syntax", "expression", "flags"]);
    if (type.kind !== "string") throw new TypeError(`${path} pattern constraint requires a string type`);
    if (record.syntax !== "ecma-262") throw new TypeError(`${path}.syntax must be ecma-262`);
    const expression = text(record.expression, `${path}.expression`, true);
    const flags = record.flags === undefined ? undefined : text(record.flags, `${path}.flags`, true);
    try {
      void new RegExp(expression, flags);
    } catch (cause) {
      throw new TypeError(`${path} contains an invalid ECMA-262 pattern`, { cause });
    }
    return { kind, syntax: "ecma-262", expression, ...(flags === undefined ? {} : { flags }) };
  }
  if (kind === "multiple-of") {
    exactKeys(record, path, ["kind", "value"]);
    if (type.kind !== "integer" && type.kind !== "float" && type.kind !== "decimal") {
      throw new TypeError(`${path} multiple-of constraint requires a numeric type`);
    }
    if (typeof record.value !== "number" || !Number.isFinite(record.value) || record.value <= 0) {
      throw new TypeError(`${path}.value must be finite and positive`);
    }
    return { kind, value: record.value };
  }
  if (kind === "unique") {
    exactKeys(record, path, ["kind"]);
    return { kind };
  }
  extensionIdentifier(kind, `${path}.kind`);
  exactKeys(record, path, ["kind", "value"]);
  return { kind: kind as ExtensionIdentifier, value: jsonValue(record.value, `${path}.value`) };
}

function normalizeKey(value: unknown, names: ReadonlySet<string>): KeyDefinition {
  const record = object(value, "$.key");
  if (record.state === "none") {
    exactKeys(record, "$.key", ["state"]);
    return { state: "none" };
  }
  if (record.state === "known") {
    exactKeys(record, "$.key", ["state", "fields"]);
    const fields = nonEmptyTextArray(record.fields, "$.key.fields");
    unique(fields, "$.key.fields");
    for (const field of fields)
      if (!names.has(field)) throw new TypeError(`$.key.fields references unknown field ${field}`);
    return { state: "known", fields };
  }
  if (record.state === "unknown") {
    exactKeys(record, "$.key", ["state", "reason"]);
    if (!includes(["metadata-unavailable", "not-declared", "conflicting"] as const, record.reason)) {
      throw new TypeError("$.key.reason is invalid");
    }
    return { state: "unknown", reason: record.reason };
  }
  throw new TypeError("$.key.state is invalid");
}

function normalizeGeometrySchema(
  value: unknown,
  names: ReadonlySet<string>,
  fields: readonly LogicalField[],
): SourceGeometrySchema {
  const record = object(value, "$.geometry");
  const hasDescendantGeometry = fields.some((field) => logicalTypeHasDescendantGeometry(field.type));
  if (hasDescendantGeometry && (record.state !== "unknown" || record.reason !== "unrecognized")) {
    throw new TypeError("$.geometry must be unknown/unrecognized while geometry exists below a top-level field path");
  }
  if (record.state === "none") {
    exactKeys(record, "$.geometry", ["state", "reason"]);
    if (record.reason !== "declared-non-spatial" && record.reason !== "no-geometry-fields") {
      throw new TypeError("$.geometry.reason is invalid");
    }
    if (fields.some((field) => field.type.kind === "geometry")) {
      throw new TypeError("$.geometry cannot be none while a logical geometry field exists");
    }
    return { state: "none", reason: record.reason };
  }
  if (record.state === "unknown") {
    exactKeys(record, "$.geometry", ["state", "reason", "native"]);
    if (!includes(["metadata-unavailable", "missing", "unrecognized", "conflicting"] as const, record.reason)) {
      throw new TypeError("$.geometry.reason is invalid");
    }
    return {
      state: "unknown",
      reason: record.reason,
      ...(record.native === undefined ? {} : { native: normalizeNative(record.native, "$.geometry.native") }),
    };
  }
  if (record.state !== "known") throw new TypeError("$.geometry.state is invalid");
  exactKeys(record, "$.geometry", ["state", "fields", "primaryField"]);
  const geometryFields = array(record.fields, "$.geometry.fields").map((entry, index) =>
    normalizeGeometryField(entry, `$.geometry.fields[${index}]`),
  );
  if (geometryFields.length === 0) throw new TypeError("$.geometry.fields must be non-empty");
  geometryFields.sort((left, right) => compareUtf8(left.field, right.field));
  unique(
    geometryFields.map((field) => field.field),
    "$.geometry.fields",
  );
  for (const field of geometryFields) {
    if (!names.has(field.field)) throw new TypeError(`$.geometry.fields references unknown field ${field.field}`);
    if (fields.find((candidate) => candidate.name === field.field)?.type.kind !== "geometry") {
      throw new TypeError(`$.geometry.fields ${field.field} is not logically typed as geometry`);
    }
  }
  const primary = normalizePrimaryGeometry(record.primaryField, new Set(geometryFields.map((field) => field.field)));
  return {
    state: "known",
    fields: geometryFields as [GeometryFieldSchema, ...GeometryFieldSchema[]],
    primaryField: primary,
  };
}

function normalizeGeometryField(value: unknown, path: string): GeometryFieldSchema {
  const record = object(value, path, ["field", "geometryTypes", "crs", "layout", "allowsEmpty"]);
  const geometryTypes = normalizeGeometryTypes(record.geometryTypes, `${path}.geometryTypes`);
  if (!includes(["xy", "xyz", "xym", "xyzm", "unknown"] as const, record.layout)) {
    throw new TypeError(`${path}.layout is invalid`);
  }
  if (typeof record.allowsEmpty !== "boolean" && record.allowsEmpty !== "unknown") {
    throw new TypeError(`${path}.allowsEmpty is invalid`);
  }
  return {
    field: text(record.field, `${path}.field`),
    geometryTypes,
    crs: normalizeCrsBinding(record.crs, `${path}.crs`),
    layout: record.layout,
    allowsEmpty: record.allowsEmpty,
  };
}

function normalizeGeometryTypes(value: unknown, path: string): GeometryTypeKnowledge {
  const record = object(value, path);
  if (record.state === "known") {
    exactKeys(record, path, ["state", "type"]);
    return { state: "known", type: geometryKind(record.type, `${path}.type`) };
  }
  if (record.state === "mixed") {
    exactKeys(record, path, ["state", "types"]);
    const types = array(record.types, `${path}.types`).map((entry, index) =>
      geometryKind(entry, `${path}.types[${index}]`),
    );
    if (types.length < 2) throw new TypeError(`${path}.types must contain at least two kinds`);
    types.sort(compareCanonical);
    unique(types, `${path}.types`);
    return { state: "mixed", types: types as [GeometryKind, GeometryKind, ...GeometryKind[]] };
  }
  if (record.state === "unknown") {
    exactKeys(record, path, ["state", "reason", "native"]);
    if (!includes(["missing", "unrecognized", "conflicting", "unsupported"] as const, record.reason)) {
      throw new TypeError(`${path}.reason is invalid`);
    }
    return {
      state: "unknown",
      reason: record.reason,
      ...(record.native === undefined ? {} : { native: normalizeNative(record.native, `${path}.native`) }),
    };
  }
  throw new TypeError(`${path}.state is invalid`);
}

function normalizePrimaryGeometry(value: unknown, geometryFields: ReadonlySet<string>): PrimaryGeometryField {
  const record = object(value, "$.geometry.primaryField");
  if (record.state === "known") {
    exactKeys(record, "$.geometry.primaryField", ["state", "field"]);
    const field = text(record.field, "$.geometry.primaryField.field");
    if (!geometryFields.has(field)) throw new TypeError("$.geometry.primaryField references an unknown geometry field");
    return { state: "known", field };
  }
  if (record.state === "none") {
    exactKeys(record, "$.geometry.primaryField", ["state", "reason"]);
    if (record.reason !== "not-declared" && record.reason !== "no-default") {
      throw new TypeError("$.geometry.primaryField.reason is invalid");
    }
    return { state: "none", reason: record.reason };
  }
  if (record.state === "unknown") {
    exactKeys(record, "$.geometry.primaryField", ["state", "reason"]);
    if (record.reason !== "metadata-unavailable" && record.reason !== "conflicting") {
      throw new TypeError("$.geometry.primaryField.reason is invalid");
    }
    return { state: "unknown", reason: record.reason };
  }
  throw new TypeError("$.geometry.primaryField.state is invalid");
}

function normalizeTemporalSchema(
  value: unknown,
  names: ReadonlySet<string>,
  fields: readonly LogicalField[],
): TemporalSchema {
  const record = object(value, "$.temporal");
  const requireTemporal = (field: string) => {
    if (!names.has(field)) throw new TypeError(`$.temporal references unknown field ${field}`);
    const kind = fields.find((candidate) => candidate.name === field)?.type.kind;
    if (kind !== "date" && kind !== "time" && kind !== "timestamp") {
      throw new TypeError(`$.temporal field ${field} is not an instant or endpoint type`);
    }
  };
  if (record.state === "none") {
    exactKeys(record, "$.temporal", ["state"]);
    return { state: "none" };
  }
  if (record.state === "instant") {
    exactKeys(record, "$.temporal", ["state", "field"]);
    const field = text(record.field, "$.temporal.field");
    requireTemporal(field);
    return { state: "instant", field };
  }
  if (record.state === "interval") {
    exactKeys(record, "$.temporal", ["state", "startField", "endField"]);
    const startField = text(record.startField, "$.temporal.startField");
    const endField = text(record.endField, "$.temporal.endField");
    requireTemporal(startField);
    requireTemporal(endField);
    if (startField === endField) throw new TypeError("$.temporal interval fields must differ");
    return { state: "interval", startField, endField };
  }
  if (record.state === "mixed") {
    exactKeys(record, "$.temporal", ["state", "fields"]);
    const temporalFields = [...nonEmptyTextArray(record.fields, "$.temporal.fields")].sort(compareCanonical);
    unique(temporalFields, "$.temporal.fields");
    for (const field of temporalFields) requireTemporal(field);
    return { state: "mixed", fields: temporalFields as [string, ...string[]] };
  }
  if (record.state === "unknown") {
    exactKeys(record, "$.temporal", ["state", "reason"]);
    if (!includes(["metadata-unavailable", "not-declared", "conflicting"] as const, record.reason)) {
      throw new TypeError("$.temporal.reason is invalid");
    }
    return { state: "unknown", reason: record.reason };
  }
  throw new TypeError("$.temporal.state is invalid");
}

function validateFieldSemantics(
  fields: readonly LogicalField[],
  key: KeyDefinition,
  geometry: SourceGeometrySchema,
  temporal: TemporalSchema,
): void {
  const keyFields = new Set(key.state === "known" ? key.fields : []);
  const geometryFields = new Set(geometry.state === "known" ? geometry.fields.map((field) => field.field) : []);
  const instantFields = new Set(temporal.state === "instant" ? [temporal.field] : []);
  const mixedFields = new Set(temporal.state === "mixed" ? temporal.fields : []);
  const simultaneouslyAddressablePaths = new Set(fields.map((field) => canonicalStringify(toJsonValue(field.path))));
  for (const field of fields) {
    const has = (role: FieldRole) => field.roles.includes(role);
    if (has("geometry") !== (field.type.kind === "geometry")) {
      throw new TypeError(`Field ${field.name} geometry type, role, and schema membership must agree`);
    }
    if (geometry.state === "known" && geometryFields.has(field.name) !== (field.type.kind === "geometry")) {
      throw new TypeError(`Field ${field.name} geometry type, role, and schema membership must agree`);
    }
    if (has("primary-key") !== keyFields.has(field.name)) {
      throw new TypeError(`Field ${field.name} primary-key role must agree with schema.key`);
    }
    if (keyFields.has(field.name)) {
      if (field.nullability !== "non-nullable") {
        throw new TypeError(`Known key field ${field.name} must be non-nullable`);
      }
      if (!featureIdentityLogicalType(field.type)) {
        throw new TypeError(`Known key field ${field.name} cannot produce a FeatureIdentityValue`);
      }
    }
    const temporalType = field.type.kind === "date" || field.type.kind === "time" || field.type.kind === "timestamp";
    if (
      (has("time-instant") || has("time-start") || has("time-end") || has("created-at") || has("updated-at")) &&
      !temporalType
    ) {
      throw new TypeError(`Field ${field.name} has a temporal role but is not temporally typed`);
    }
    if (temporal.state === "interval") {
      if (has("time-start") !== (field.name === temporal.startField)) {
        throw new TypeError(`Field ${field.name} time-start role must agree with schema.temporal`);
      }
      if (has("time-end") !== (field.name === temporal.endField)) {
        throw new TypeError(`Field ${field.name} time-end role must agree with schema.temporal`);
      }
    } else if (temporal.state !== "mixed" && (has("time-start") || has("time-end"))) {
      throw new TypeError(`Field ${field.name} interval role requires interval temporal schema`);
    }
    if (temporal.state !== "mixed" && has("time-instant") !== instantFields.has(field.name)) {
      throw new TypeError(`Field ${field.name} time-instant role must agree with schema.temporal`);
    }
    if (temporal.state === "mixed") {
      const hasTemporalRole =
        has("time-instant") || has("time-start") || has("time-end") || has("created-at") || has("updated-at");
      if (mixedFields.has(field.name) !== hasTemporalRole) {
        throw new TypeError(`Field ${field.name} temporal role must agree with mixed schema.temporal`);
      }
    }
    if (field.type.kind === "geometry" && Object.hasOwn(field, "defaultValue") && field.defaultValue !== null) {
      const geometryField =
        geometry.state === "known" ? geometry.fields.find((item) => item.field === field.name) : undefined;
      const summary = canonicalGeometrySummary(field.defaultValue!);
      const expectedArity =
        geometryField?.layout === "xy"
          ? 2
          : geometryField?.layout === "xyz" || geometryField?.layout === "xym"
            ? 3
            : geometryField?.layout === "xyzm"
              ? 4
              : undefined;
      if (expectedArity !== undefined && summary?.arity !== expectedArity) {
        throw new TypeError(
          `Field ${field.name} defaultValue ordinate arity does not match declared ${geometryField!.layout} layout`,
        );
      }
      if (
        summary &&
        geometryField?.geometryTypes.state === "known" &&
        summary.type !== geometryField.geometryTypes.type
      ) {
        throw new TypeError(
          `Field ${field.name} defaultValue type ${summary.type} does not match declared ${geometryField.geometryTypes.type}`,
        );
      }
      if (
        summary &&
        geometryField?.geometryTypes.state === "mixed" &&
        !geometryField.geometryTypes.types.includes(summary.type)
      ) {
        throw new TypeError(`Field ${field.name} defaultValue type ${summary.type} is not in the declared mixed types`);
      }
    }
    validateDescendantFieldSemantics(field.type, field.path, simultaneouslyAddressablePaths);
  }
}

function featureIdentityLogicalType(type: LogicalType): boolean {
  if (type.kind === "union") return type.members.every(featureIdentityLogicalType);
  return includes(
    [
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
    ] as const,
    type.kind,
  );
}

function logicalTypeContainsGeometry(type: LogicalType): boolean {
  if (type.kind === "geometry") return true;
  if (type.kind === "list") return logicalTypeContainsGeometry(type.element);
  if (type.kind === "union") return type.members.some(logicalTypeContainsGeometry);
  if (type.kind === "struct") return type.fields.some((field) => logicalTypeContainsGeometry(field.type));
  return false;
}

function logicalTypeHasDescendantGeometry(type: LogicalType): boolean {
  return type.kind !== "geometry" && logicalTypeContainsGeometry(type);
}

function validateDescendantFieldSemantics(
  type: LogicalType,
  parentPath: readonly string[],
  simultaneouslyAddressablePaths: Set<string>,
): void {
  if (type.kind === "list") {
    validateDescendantFieldSemantics(type.element, parentPath, simultaneouslyAddressablePaths);
    return;
  }
  if (type.kind === "union") {
    const branchPaths = new Set<string>();
    for (const member of type.members) {
      const branchAddressablePaths = new Set(simultaneouslyAddressablePaths);
      validateDescendantFieldSemantics(member, parentPath, branchAddressablePaths);
      for (const path of branchAddressablePaths) {
        if (!simultaneouslyAddressablePaths.has(path)) branchPaths.add(path);
      }
    }
    for (const path of branchPaths) simultaneouslyAddressablePaths.add(path);
    return;
  }
  if (type.kind !== "struct") return;
  for (const field of type.fields) {
    const label = field.path.join(".");
    if (!strictPathDescendant(field.path, parentPath)) {
      throw new TypeError(`Nested field ${label} path must strictly extend parent path ${parentPath.join(".")}`);
    }
    const pathIdentity = canonicalStringify(toJsonValue(field.path));
    if (simultaneouslyAddressablePaths.has(pathIdentity)) {
      throw new TypeError(`Logical field path ${label} collides with another simultaneously addressable field`);
    }
    simultaneouslyAddressablePaths.add(pathIdentity);
    if (field.roles.includes("geometry") !== (field.type.kind === "geometry")) {
      throw new TypeError(`Nested field ${label} geometry type and role must agree`);
    }
    const unreachableRole = field.roles.find(
      (role) =>
        role !== "geometry" &&
        includes(
          ["primary-key", "feature-id", "time-instant", "time-start", "time-end", "created-at", "updated-at"] as const,
          role,
        ),
    );
    if (unreachableRole) {
      throw new TypeError(
        `Nested field ${label} cannot carry ${unreachableRole}; source key/time identity is top-level string-addressed`,
      );
    }
    validateDescendantFieldSemantics(field.type, field.path, simultaneouslyAddressablePaths);
  }
}

function strictPathDescendant(path: readonly string[], parentPath: readonly string[]): boolean {
  return path.length > parentPath.length && parentPath.every((segment, index) => path[index] === segment);
}

function normalizeCrsBinding(value: unknown, path: string): CrsBinding {
  const record = object(value, path, ["definition", "coordinateOrder", "coordinateEpoch", "provenance"]);
  const coordinateEpoch =
    record.coordinateEpoch === undefined ? undefined : finiteNumber(record.coordinateEpoch, `${path}.coordinateEpoch`);
  const definition = normalizeCrsDefinition(record.definition, `${path}.definition`);
  const provenance = normalizeCrsProvenance(record.provenance, `${path}.provenance`);
  if (
    provenance.method === "reprojected" &&
    canonicalStringify(crsDefinitionFingerprintProjection(definition)) !==
      canonicalStringify(crsDefinitionFingerprintProjection(provenance.reprojection.target))
  ) {
    throw new TypeError(`${path}.definition must semantically match provenance.reprojection.target`);
  }
  return {
    definition,
    coordinateOrder: normalizeAxisOrder(record.coordinateOrder, `${path}.coordinateOrder`),
    ...(coordinateEpoch === undefined ? {} : { coordinateEpoch }),
    provenance,
  };
}

function normalizeCrsDefinition(value: unknown, path: string): CrsDefinition {
  const record = object(value, path);
  switch (record.kind) {
    case "authority":
      exactKeys(record, path, ["kind", "authority", "code", "version", "uri", "wkt", "definitionAxisOrder"]);
      return {
        kind: "authority",
        authority: text(record.authority, `${path}.authority`),
        code: text(record.code, `${path}.code`),
        ...(record.version === undefined ? {} : { version: text(record.version, `${path}.version`) }),
        ...(record.uri === undefined ? {} : { uri: absoluteUri(record.uri, `${path}.uri`) }),
        ...(record.wkt === undefined ? {} : { wkt: text(record.wkt, `${path}.wkt`) }),
        definitionAxisOrder: normalizeAxisOrder(record.definitionAxisOrder, `${path}.definitionAxisOrder`),
      };
    case "wkt":
      exactKeys(record, path, ["kind", "wkt", "dialect", "validation", "name", "definitionAxisOrder"]);
      if (!includes(["wkt1", "wkt2", "unknown"] as const, record.dialect))
        throw new TypeError(`${path}.dialect is invalid`);
      if (!includes(["unverified", "engine"] as const, record.validation)) {
        throw new TypeError(`${path}.validation is invalid`);
      }
      return {
        kind: "wkt",
        wkt: text(record.wkt, `${path}.wkt`),
        dialect: record.dialect,
        validation: record.validation,
        ...(record.name === undefined ? {} : { name: text(record.name, `${path}.name`) }),
        definitionAxisOrder: normalizeAxisOrder(record.definitionAxisOrder, `${path}.definitionAxisOrder`),
      };
    case "uri":
      exactKeys(record, path, ["kind", "uri", "name", "definitionAxisOrder"]);
      return {
        kind: "uri",
        uri: absoluteUri(record.uri, `${path}.uri`),
        ...(record.name === undefined ? {} : { name: text(record.name, `${path}.name`) }),
        definitionAxisOrder: normalizeAxisOrder(record.definitionAxisOrder, `${path}.definitionAxisOrder`),
      };
    case "projjson": {
      exactKeys(record, path, ["kind", "projjson", "name", "definitionAxisOrder"]);
      const projjson = jsonObject(record.projjson, `${path}.projjson`);
      if (new TextEncoder().encode(canonicalStringify(toJsonValue(projjson))).byteLength > MAX_PROJJSON_BYTES) {
        throw new TypeError(`${path}.projjson exceeds ${MAX_PROJJSON_BYTES} bytes`);
      }
      validateProjJson(projjson, `${path}.projjson`);
      return {
        kind: "projjson",
        projjson,
        ...(record.name === undefined ? {} : { name: text(record.name, `${path}.name`) }),
        definitionAxisOrder: normalizeAxisOrder(record.definitionAxisOrder, `${path}.definitionAxisOrder`),
      };
    }
    case "unknown":
      exactKeys(record, path, ["kind", "reason", "native"]);
      if (!includes(["missing", "unrecognized", "conflicting"] as const, record.reason)) {
        throw new TypeError(`${path}.reason is invalid`);
      }
      return {
        kind: "unknown",
        reason: record.reason,
        ...(record.native === undefined ? {} : { native: normalizeNative(record.native, `${path}.native`) }),
      };
    default:
      throw new TypeError(`${path}.kind is invalid`);
  }
}

function normalizeAxisOrder(value: unknown, path: string): AxisOrder {
  const record = object(value, path);
  if (record.state === "known") {
    exactKeys(record, path, ["state", "source", "axes"]);
    if (!includes(["crs-definition", "protocol", "encoding", "declared"] as const, record.source)) {
      throw new TypeError(`${path}.source is invalid`);
    }
    const axes = array(record.axes, `${path}.axes`).map((axis, index) => normalizeAxis(axis, `${path}.axes[${index}]`));
    if (axes.length < 2) throw new TypeError(`${path}.axes must contain at least two axes`);
    return {
      state: "known",
      source: record.source,
      axes: axes as [CoordinateAxis, CoordinateAxis, ...CoordinateAxis[]],
    };
  }
  if (record.state === "unknown") {
    exactKeys(record, path, ["state", "reason", "native"]);
    if (!includes(["missing", "unrecognized", "conflicting"] as const, record.reason)) {
      throw new TypeError(`${path}.reason is invalid`);
    }
    return {
      state: "unknown",
      reason: record.reason,
      ...(record.native === undefined ? {} : { native: normalizeNative(record.native, `${path}.native`) }),
    };
  }
  throw new TypeError(`${path}.state is invalid`);
}

function normalizeAxis(value: unknown, path: string): CoordinateAxis {
  const record = object(value, path, ["name", "abbreviation", "direction", "unit"]);
  if (
    !includes(["east", "west", "north", "south", "up", "down", "future", "past", "other"] as const, record.direction)
  ) {
    throw new TypeError(`${path}.direction is invalid`);
  }
  return {
    name: text(record.name, `${path}.name`),
    ...(record.abbreviation === undefined ? {} : { abbreviation: text(record.abbreviation, `${path}.abbreviation`) }),
    direction: record.direction,
    unit: text(record.unit, `${path}.unit`),
  };
}

function normalizeCrsProvenance(value: unknown, path: string): CrsProvenance {
  const record = object(value, path);
  if (record.method === "reprojected") {
    exactKeys(record, path, ["method", "native", "reprojection"]);
    const reprojection = object(record.reprojection, `${path}.reprojection`, [
      "source",
      "target",
      "operation",
      "engine",
      "accuracyMeters",
      "transformedAt",
    ]);
    const source = normalizeCrsDefinition(reprojection.source, `${path}.reprojection.source`);
    const target = normalizeCrsDefinition(reprojection.target, `${path}.reprojection.target`);
    if (!isResolvedCrsDefinition(source) || !isResolvedCrsDefinition(target))
      throw new TypeError(`${path}.reprojection CRS must be resolved`);
    return {
      method: "reprojected",
      ...(record.native === undefined ? {} : { native: normalizeNative(record.native, `${path}.native`) }),
      reprojection: {
        source,
        target,
        ...(reprojection.operation === undefined
          ? {}
          : { operation: text(reprojection.operation, `${path}.reprojection.operation`) }),
        engine: text(reprojection.engine, `${path}.reprojection.engine`),
        ...(reprojection.accuracyMeters === undefined
          ? {}
          : {
              accuracyMeters: nonNegativeFiniteNumber(
                reprojection.accuracyMeters,
                `${path}.reprojection.accuracyMeters`,
              ),
            }),
        ...(reprojection.transformedAt === undefined
          ? {}
          : { transformedAt: rfc3339Timestamp(reprojection.transformedAt, `${path}.reprojection.transformedAt`) }),
      },
    };
  }
  if (!includes(["metadata", "payload", "standard-default", "declared"] as const, record.method)) {
    throw new TypeError(`${path}.method is invalid`);
  }
  exactKeys(record, path, ["method", "native"]);
  return {
    method: record.method,
    ...(record.native === undefined ? {} : { native: normalizeNative(record.native, `${path}.native`) }),
  };
}

function isResolvedCrsDefinition(definition: CrsDefinition): definition is ResolvedCrsDefinition {
  return definition.kind !== "unknown" && (definition.kind !== "wkt" || definition.validation === "engine");
}

function normalizeNative(value: unknown, path: string): NativeTypeReference {
  const record = object(value, path, ["protocol", "name", "namespace", "path", "definition"]);
  const protocol = sourceProtocol(record.protocol, `${path}.protocol`);
  const definition =
    record.definition === undefined
      ? undefined
      : sanitizeNativeDefinition(jsonValue(record.definition, `${path}.definition`));
  if (
    definition !== undefined &&
    new TextEncoder().encode(canonicalStringify(toJsonValue(definition))).byteLength > MAX_NATIVE_DEFINITION_BYTES
  ) {
    throw new TypeError(`${path}.definition exceeds ${MAX_NATIVE_DEFINITION_BYTES} bytes`);
  }
  return {
    protocol,
    name: text(record.name, `${path}.name`),
    ...(record.namespace === undefined ? {} : { namespace: text(record.namespace, `${path}.namespace`) }),
    ...(record.path === undefined ? {} : { path: textArray(record.path, `${path}.path`) }),
    ...(definition === undefined ? {} : { definition }),
  };
}

const REDACTED_NATIVE_VALUE = "[REDACTED]";
const SENSITIVE_NATIVE_KEY =
  /^(?:authorization|proxy[-_]?authorization|bearer[-_]?token|token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|apikey|secret|client[-_]?secret|password|passwd|credential|private[-_]?key|session[-_]?token|cookie|set[-_]?cookie|aws[-_]?access[-_]?key[-_]?id|aws[-_]?secret[-_]?access[-_]?key)$/i;
const SENSITIVE_QUERY_NAMES = new Set([
  "authorization",
  "auth",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "key",
  "secret",
  "clientsecret",
  "password",
  "credential",
  "signature",
  "sig",
  "policy",
  "expires",
  "sas",
  "se",
  "sp",
  "spr",
  "sr",
  "sv",
  "code",
]);

function sanitizeNativeDefinition(value: JsonValue): JsonValue {
  if (typeof value === "string") return sanitizeNativeString(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeNativeDefinition);
  const sanitized = Object.create(null) as Record<string, JsonValue>;
  for (const [key, child] of Object.entries(value)) {
    sanitized[key] =
      SENSITIVE_NATIVE_KEY.test(key) && !credentialPlaceholder(child)
        ? REDACTED_NATIVE_VALUE
        : sanitizeNativeDefinition(child);
  }
  return sanitized;
}

function sanitizeNativeString(value: string): string {
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value)) return REDACTED_NATIVE_VALUE;
  let sanitized = value.replace(/[A-Za-z][A-Za-z0-9+.-]*:[/\\]{2}[^\s<>"',]+/g, (url) => sanitizeNativeUrl(url));
  sanitized = sanitized.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, `$1 ${REDACTED_NATIVE_VALUE}`);
  sanitized = sanitized.replace(
    /\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
    REDACTED_NATIVE_VALUE,
  );
  sanitized = sanitized.replace(
    /\b(token|access[-_]?token|refresh[-_]?token|id[-_]?token|api[-_]?key|apikey|secret|client[-_]?secret|password|passwd|credential|signature|sig|aws[-_]?access[-_]?key[-_]?id|aws[-_]?secret[-_]?access[-_]?key)\s*([=:])\s*([^\s&,;"']+)/gi,
    (_match, key: string, separator: string, credential: string) =>
      credentialPlaceholder(credential)
        ? `${key}${separator}${credential}`
        : `${key}${separator}${REDACTED_NATIVE_VALUE}`,
  );
  return sanitized;
}

function sanitizeNativeUrl(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:[/\\]{2}/.test(value)) return value;
  if (value.includes("\\")) return REDACTED_NATIVE_VALUE;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveQueryParameter(key) && url.searchParams.getAll(key).some((entry) => !credentialPlaceholder(entry))) {
        url.searchParams.set(key, REDACTED_NATIVE_VALUE);
      }
    }
    if (url.hash) url.hash = sanitizeNativeString(url.hash);
    return url.toString();
  } catch {
    // A malformed authority/port cannot be safely decomposed. Native evidence
    // is diagnostic-only, so fail closed rather than preserve possible userinfo.
    return REDACTED_NATIVE_VALUE;
  }
}

function sensitiveQueryParameter(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return SENSITIVE_QUERY_NAMES.has(normalized) || normalized.startsWith("xamz") || normalized.startsWith("xgoog");
}

function credentialPlaceholder(value: JsonValue): boolean {
  if (value === null || value === "") return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return (
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(normalized) ||
    /^\{\{[A-Za-z_][A-Za-z0-9_]*\}\}$/.test(normalized) ||
    /^<[A-Za-z_][A-Za-z0-9_-]*>$/.test(normalized) ||
    /^\[[A-Za-z_][A-Za-z0-9_-]*\]$/.test(normalized) ||
    /^(?:YOUR|EXAMPLE|PLACEHOLDER|REDACTED|CHANGEME)(?:[_-][A-Za-z0-9_-]+)?$/i.test(normalized)
  );
}

function normalizeProvenanceArray(value: unknown, path: string): NonEmptyReadonlyArray<MetadataProvenance> {
  const provenance = array(value, path).map((entry, index) => normalizeProvenance(entry, `${path}[${index}]`));
  if (provenance.length === 0) throw new TypeError(`${path} must be non-empty`);
  return provenance as [MetadataProvenance, ...MetadataProvenance[]];
}

function normalizeProvenance(value: unknown, path: string): MetadataProvenance {
  const record = object(value, path, ["method", "protocol", "source", "observedAt", "validator", "detail"]);
  if (!includes(["observed", "declared", "standard-default", "inferred", "unavailable"] as const, record.method)) {
    throw new TypeError(`${path}.method is invalid`);
  }
  const validator =
    record.validator === undefined ? undefined : normalizeValidator(record.validator, `${path}.validator`);
  return {
    method: record.method,
    protocol: sourceProtocol(record.protocol, `${path}.protocol`),
    source: sanitizeProvenanceText(text(record.source, `${path}.source`)),
    ...(record.observedAt === undefined
      ? {}
      : { observedAt: rfc3339Timestamp(record.observedAt, `${path}.observedAt`) }),
    ...(validator ? { validator } : {}),
    ...(record.detail === undefined ? {} : { detail: sanitizeProvenanceText(text(record.detail, `${path}.detail`)) }),
  };
}

function sanitizeProvenanceText(value: string): string {
  const sanitized = sanitizeNativeString(value);
  // Native URL sanitization handles valid absolute URLs. Fail closed for
  // protocol-relative, bare, or malformed user-info that URL parsing cannot
  // safely decompose, while retaining surrounding diagnostic prose.
  return sanitized.replace(
    /(^|[\s(=])(?:\/\/)?[^\s/@:]+:[^\s/@]*@[^\s,;)]+/g,
    (_match, prefix: string) => `${prefix}${REDACTED_NATIVE_VALUE}`,
  );
}

function normalizeValidator(value: unknown, path: string): NonNullable<MetadataProvenance["validator"]> {
  const record = object(value, path, ["kind", "value"]);
  if (!includes(["etag", "last-modified", "version"] as const, record.kind))
    throw new TypeError(`${path}.kind is invalid`);
  return { kind: record.kind, value: text(record.value, `${path}.value`) };
}

function normalizeExtensions(value: unknown, path: string): ExtensionMap {
  const record = object(value, path);
  const out: Record<ExtensionIdentifier, JsonValue> = {};
  for (const key of Object.keys(record).sort()) {
    extensionIdentifier(key, `${path}.${key}`);
    out[key as ExtensionIdentifier] = jsonValue(record[key], `${path}.${key}`);
  }
  return out;
}

function schemaFingerprint(schema: Omit<SourceSchemaV2, "fingerprint">): Sha256 {
  const projection = {
    kind: schema.kind,
    version: schema.version,
    openContent: schema.openContent,
    ...(schema.extensions ? { extensions: schema.extensions } : {}),
    fields: schema.fields.map(fieldFingerprintProjection),
    key: schema.key,
    geometry: geometryFingerprintProjection(schema.geometry),
    temporal: schema.temporal,
  };
  return sha256(`${SOURCE_SCHEMA_V2_FINGERPRINT_DOMAIN}\n${canonicalStringify(toJsonValue(projection))}`);
}

function fieldFingerprintProjection(field: LogicalField): JsonObject {
  return toJsonValue({
    name: field.name,
    path: field.path,
    type: typeFingerprintProjection(field.type),
    nullability: field.nullability,
    mutability: field.mutability,
    defaultValuePresent: Object.hasOwn(field, "defaultValue"),
    ...(Object.hasOwn(field, "defaultValue") ? { defaultValue: field.defaultValue } : {}),
    roles: [...field.roles].sort(compareCanonical),
    domain: domainFingerprintProjection(field.domain),
    constraints: constraintFingerprintProjection(field.constraints),
    ...(field.extensions ? { extensions: field.extensions } : {}),
  }) as JsonObject;
}

function typeFingerprintProjection(type: LogicalType): JsonValue {
  if (type.kind === "unknown") return { kind: type.kind, reason: type.reason };
  if (type.kind === "list") return { kind: type.kind, element: typeFingerprintProjection(type.element) };
  if (type.kind === "struct") {
    return { kind: type.kind, fields: [...type.fields].sort(compareFields).map(fieldFingerprintProjection) };
  }
  if (type.kind === "union") {
    return { kind: type.kind, members: [...type.members].map(typeFingerprintProjection).sort(compareCanonical) };
  }
  return toJsonValue(type) as JsonValue;
}

function domainFingerprintProjection(domain: FieldValueDomain): JsonValue {
  if (domain.state === "unknown") {
    return {
      state: domain.state,
      reason: domain.reason,
      nativePresent: domain.native !== undefined,
      ...(domain.native ? { native: nativeIdentity(domain.native) } : {}),
    };
  }
  return toJsonValue(domain) as JsonValue;
}

function constraintFingerprintProjection(constraints: FieldConstraintState): JsonValue {
  if (constraints.state === "unknown") {
    return {
      state: constraints.state,
      reason: constraints.reason,
      nativePresent: constraints.native !== undefined,
      ...(constraints.native ? { native: nativeIdentity(constraints.native) } : {}),
    };
  }
  if (constraints.state === "partial") {
    return {
      state: constraints.state,
      reason: constraints.reason,
      values: constraints.values,
      native: constraints.native.map(nativeIdentity).sort(compareCanonical),
    };
  }
  return toJsonValue(constraints) as JsonValue;
}

function nativeIdentity(native: NativeTypeReference): JsonValue {
  return {
    protocol: native.protocol,
    name: native.name,
    ...(native.namespace === undefined ? {} : { namespace: native.namespace }),
    ...(native.path === undefined ? {} : { path: native.path }),
  };
}

function geometryFingerprintProjection(geometry: SourceGeometrySchema): JsonValue {
  if (geometry.state !== "known") {
    return geometry.state === "unknown"
      ? { state: geometry.state, reason: geometry.reason }
      : { state: geometry.state, reason: geometry.reason };
  }
  return toJsonValue({
    state: geometry.state,
    fields: geometry.fields.map((field) => ({
      field: field.field,
      geometryTypes:
        field.geometryTypes.state === "mixed"
          ? { state: "mixed", types: [...field.geometryTypes.types].sort(compareCanonical) }
          : field.geometryTypes.state === "unknown"
            ? { state: "unknown", reason: field.geometryTypes.reason }
            : field.geometryTypes,
      crs: crsFingerprintProjection(field.crs),
      layout: field.layout,
      allowsEmpty: field.allowsEmpty,
    })),
    primaryField: geometry.primaryField,
  }) as JsonValue;
}

function crsFingerprintProjection(binding: CrsBinding): JsonValue {
  return {
    definition: crsDefinitionFingerprintProjection(binding.definition),
    coordinateOrder: axisFingerprintProjection(binding.coordinateOrder),
    ...(binding.coordinateEpoch === undefined ? {} : { coordinateEpoch: binding.coordinateEpoch }),
    provenance:
      binding.provenance.method === "reprojected"
        ? {
            method: "reprojected",
            reprojection: {
              source: crsDefinitionFingerprintProjection(binding.provenance.reprojection.source),
              target: crsDefinitionFingerprintProjection(binding.provenance.reprojection.target),
              ...(binding.provenance.reprojection.operation === undefined
                ? {}
                : { operation: binding.provenance.reprojection.operation }),
              engine: binding.provenance.reprojection.engine,
              ...(binding.provenance.reprojection.accuracyMeters === undefined
                ? {}
                : { accuracyMeters: binding.provenance.reprojection.accuracyMeters }),
            },
          }
        : { method: binding.provenance.method },
  };
}

function crsDefinitionFingerprintProjection(definition: CrsDefinition): JsonValue {
  switch (definition.kind) {
    case "authority":
      return {
        kind: definition.kind,
        authority: definition.authority,
        code: definition.code,
        ...(definition.version === undefined ? {} : { version: definition.version }),
        ...(definition.uri === undefined ? {} : { uri: definition.uri }),
        ...(definition.wkt === undefined ? {} : { wkt: definition.wkt }),
        definitionAxisOrder: axisFingerprintProjection(definition.definitionAxisOrder),
      };
    case "wkt":
      return {
        kind: definition.kind,
        wkt: definition.wkt,
        dialect: definition.dialect,
        validation: definition.validation,
        definitionAxisOrder: axisFingerprintProjection(definition.definitionAxisOrder),
      };
    case "uri":
      return {
        kind: definition.kind,
        uri: definition.uri,
        definitionAxisOrder: axisFingerprintProjection(definition.definitionAxisOrder),
      };
    case "projjson":
      return {
        kind: definition.kind,
        projjson: definition.projjson,
        definitionAxisOrder: axisFingerprintProjection(definition.definitionAxisOrder),
      };
    case "unknown":
      return { kind: definition.kind, reason: definition.reason };
  }
}

function axisFingerprintProjection(order: AxisOrder): JsonValue {
  return order.state === "known"
    ? {
        state: order.state,
        source: order.source,
        axes: order.axes.map((axis) => ({
          // Axis display names/abbreviations do not define semantic identity.
          direction: axis.direction,
          unit: axis.unit,
        })),
      }
    : { state: order.state, reason: order.reason };
}

function cloneProvenance(value: NonEmptyReadonlyArray<MetadataProvenance>): NonEmptyReadonlyArray<MetadataProvenance> {
  return normalizeProvenanceArray(toPlainJson(value), "$.provenance");
}

function toPlainJson(value: unknown): unknown {
  assertBoundedGraphDepth(value, "$", MAX_SCHEMA_GRAPH_DEPTH);
  return toJsonValue(value) as unknown;
}

function jsonValue(value: unknown, path: string): JsonValue {
  assertBoundedGraphDepth(value, path, MAX_JSON_VALUE_DEPTH);
  return toJsonValue(value, path) as JsonValue;
}

function jsonObject(value: unknown, path: string): JsonObject {
  const json = jsonValue(value, path);
  if (json === null || Array.isArray(json) || typeof json !== "object")
    throw new TypeError(`${path} must be an object`);
  return json as JsonObject;
}

function object(value: unknown, path: string, allowed?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${path} must be an object`);
  const record = value as Record<string, unknown>;
  if (allowed) exactKeys(record, path, allowed);
  return record;
}

function exactKeys(record: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const set = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !set.has(key));
  if (unexpected) throw new TypeError(`${path}.${unexpected} is not part of SourceSchemaV2`);
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function text(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === ""))
    throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function textArray(value: unknown, path: string): readonly string[] {
  return array(value, path).map((entry, index) => text(entry, `${path}[${index}]`));
}

function nonEmptyTextArray(value: unknown, path: string): NonEmptyReadonlyArray<string> {
  const out = textArray(value, path);
  if (out.length === 0) throw new TypeError(`${path} must be non-empty`);
  return out as [string, ...string[]];
}

function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new TypeError(`${path} must be a positive safe integer`);
  return value as number;
}

function optionalNonNegativeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${path} must be a non-negative safe integer`);
  return value as number;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
  return value;
}

function nonNegativeFiniteNumber(value: unknown, path: string): number {
  const number = finiteNumber(value, path);
  if (number < 0) throw new TypeError(`${path} must be non-negative`);
  return number;
}

function rfc3339Timestamp(value: unknown, path: string): string {
  const timestamp = text(value, path);
  if (!timestampValue(timestamp, "nanosecond", "offset")) {
    throw new TypeError(`${path} must be an RFC 3339 timestamp`);
  }
  return timestamp;
}

function temporalUnit(value: unknown, path: string): TemporalUnit {
  if (!includes(["second", "millisecond", "microsecond", "nanosecond"] as const, value)) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

function geometryKind(value: unknown, path: string): GeometryKind {
  if (
    !includes(
      [
        "Point",
        "MultiPoint",
        "LineString",
        "MultiLineString",
        "Polygon",
        "MultiPolygon",
        "GeometryCollection",
      ] as const,
      value,
    )
  ) {
    throw new TypeError(`${path} is invalid`);
  }
  return value;
}

function fieldRole(value: unknown, path: string): FieldRole {
  if (
    includes(
      [
        "primary-key",
        "feature-id",
        "geometry",
        "time-instant",
        "time-start",
        "time-end",
        "created-at",
        "updated-at",
      ] as const,
      value,
    )
  ) {
    return value;
  }
  return extensionIdentifier(value, path);
}

function sourceProtocol(value: unknown, path: string): SourceProtocol {
  if (typeof value === "string" && PROTOCOLS.includes(value as Protocol)) {
    return value as Protocol;
  }
  return extensionIdentifier(value, path);
}

function extensionIdentifier(value: unknown, path: string): ExtensionIdentifier {
  if (typeof value !== "string" || !EXTENSION_ID_PATTERN.test(value)) {
    throw new TypeError(`${path} must be a reverse-DNS extension identifier`);
  }
  return value as ExtensionIdentifier;
}

function absoluteUri(value: unknown, path: string): string {
  const textValue = text(value, path);
  if (
    textValue.trim() !== textValue ||
    [...textValue].some((character) => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f)
  ) {
    throw new TypeError(`${path} must not contain whitespace or control characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(textValue);
  } catch (cause) {
    throw new TypeError(`${path} must be an absolute URI`, { cause });
  }
  if (!parsed.protocol || !["http:", "https:", "urn:"].includes(parsed.protocol)) {
    throw new TypeError(`${path} uses an unsafe or unsupported URI scheme`);
  }
  if (parsed.username || parsed.password) throw new TypeError(`${path} must not include user-info`);
  if (textValue.includes("#")) throw new TypeError(`${path} must not include a fragment`);
  if (/%(?![0-9A-Fa-f]{2})/.test(textValue)) throw new TypeError(`${path} contains malformed percent encoding`);
  for (const match of textValue.matchAll(/%([0-9A-Fa-f]{2})/g)) {
    const encoded = match[1]!;
    const decoded = String.fromCharCode(Number.parseInt(encoded, 16));
    if (encoded !== encoded.toUpperCase() || /^[A-Za-z0-9._~-]$/.test(decoded)) {
      throw new TypeError(`${path} contains a non-canonical percent encoding`);
    }
  }
  const canonical = parsed.toString();
  if (canonical !== textValue) throw new TypeError(`${path} must use the canonical RFC 3986 serialization`);
  return canonical;
}

function logicalValueCompatible(value: JsonValue, type: LogicalType): boolean {
  if (value === null) return true;
  if (type.kind === "list")
    return Array.isArray(value) && value.every((entry) => logicalValueCompatible(entry, type.element));
  if (type.kind === "struct") {
    if (Array.isArray(value) || typeof value !== "object") return false;
    const record = value as JsonObject;
    const fields = new Map(type.fields.map((field) => [field.name, field]));
    if (Object.keys(record).some((key) => !fields.has(key))) return false;
    return type.fields.every((field) => {
      if (!Object.hasOwn(record, field.name)) return field.nullability !== "non-nullable";
      const child = record[field.name] as JsonValue;
      return !(child === null && field.nullability === "non-nullable") && logicalValueCompatible(child, field.type);
    });
  }
  if (type.kind === "union") return type.members.some((member) => logicalValueCompatible(value, member));
  if (type.kind === "json" || type.kind === "unknown") return true;
  if (type.kind === "geometry") return canonicalGeometryValue(value);
  if (Array.isArray(value) || typeof value === "object") return false;
  return domainValueCompatible(value, type);
}

function canonicalGeometryValue(value: JsonValue): boolean {
  return canonicalGeometrySummary(value) !== undefined;
}

function canonicalGeometrySummary(
  value: JsonValue,
): { readonly arity: 2 | 3 | 4; readonly type: GeometryKind } | undefined {
  const state: { arity?: 2 | 3 | 4 } = {};
  if (!inspectCanonicalGeometry(value, state) || state.arity === undefined) return undefined;
  return { arity: state.arity, type: (value as JsonObject).type as GeometryKind };
}

function inspectCanonicalGeometry(value: JsonValue, state: { arity?: 2 | 3 | 4 }): boolean {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const record = value as JsonObject;
  if (typeof record.type !== "string") return false;
  if (record.type === "GeometryCollection") {
    return (
      exactJsonKeys(record, ["type", "geometries"]) &&
      Array.isArray(record.geometries) &&
      record.geometries.length > 0 &&
      record.geometries.every((geometry) => inspectCanonicalGeometry(geometry, state))
    );
  }
  if (!exactJsonKeys(record, ["type", "coordinates"])) return false;
  const position = (candidate: JsonValue | undefined): boolean => {
    if (
      !Array.isArray(candidate) ||
      candidate.length < 2 ||
      candidate.length > 4 ||
      !candidate.every((ordinate) => typeof ordinate === "number" && Number.isFinite(ordinate))
    ) {
      return false;
    }
    const arity = candidate.length as 2 | 3 | 4;
    if (state.arity !== undefined && state.arity !== arity) return false;
    state.arity = arity;
    return true;
  };
  const positions = (candidate: JsonValue | undefined, minimum: number): boolean =>
    Array.isArray(candidate) && candidate.length >= minimum && candidate.every(position);
  const rings = (candidate: JsonValue | undefined): boolean => {
    if (!Array.isArray(candidate) || candidate.length === 0) return false;
    return candidate.every((ring) => {
      if (!positions(ring, 4)) return false;
      const first = ring[0];
      const last = ring[ring.length - 1];
      return (
        Array.isArray(first) &&
        Array.isArray(last) &&
        first.length === last.length &&
        first.every((ordinate, index) => ordinate === last[index])
      );
    });
  };
  switch (record.type) {
    case "Point":
      return position(record.coordinates);
    case "MultiPoint":
      return positions(record.coordinates, 1);
    case "LineString":
      return positions(record.coordinates, 2);
    case "MultiLineString":
      return (
        Array.isArray(record.coordinates) &&
        record.coordinates.length > 0 &&
        record.coordinates.every((line) => positions(line, 2))
      );
    case "Polygon":
      return rings(record.coordinates);
    case "MultiPolygon":
      return Array.isArray(record.coordinates) && record.coordinates.length > 0 && record.coordinates.every(rings);
    default:
      return false;
  }
}

function exactJsonKeys(record: JsonObject, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}

function domainValueCompatible(value: DomainValue | OrderedDomainValue, type: LogicalType): boolean {
  switch (type.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      if (type.jsonEncoding === "string") {
        return typeof value === "string" && integerString(value, type.bits, type.signed);
      }
      return typeof value === "number" && integerNumber(value, type.bits, type.signed);
    case "float":
      return typeof value === "number" && Number.isFinite(value);
    case "decimal":
      return type.jsonEncoding === "string"
        ? typeof value === "string" && decimalString(value, type.precision, type.scale)
        : typeof value === "number" && decimalNumber(value, type.precision, type.scale);
    case "string":
      return typeof value === "string" && (type.maxLength === undefined || value.length <= type.maxLength);
    case "binary":
      return typeof value === "string" && binaryValue(value, type.encoding);
    case "uuid":
      return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
    case "date":
      return typeof value === "string" && calendarDate(value);
    case "time":
      return typeof value === "string" && timeOfDay(value, type.unit);
    case "timestamp":
      return typeof value === "string" && timestampValue(value, type.unit, type.timezone);
    case "duration":
      return typeof value === "string" && durationValue(value);
    case "json":
    case "unknown":
      return true;
    case "union":
      return type.members.some((member) => domainValueCompatible(value, member));
    case "geometry":
    case "list":
    case "struct":
      return false;
  }
}

function rangeType(type: LogicalType): boolean {
  return (
    type.kind === "integer" ||
    type.kind === "float" ||
    type.kind === "decimal" ||
    type.kind === "string" ||
    type.kind === "date" ||
    type.kind === "time" ||
    type.kind === "timestamp" ||
    type.kind === "unknown"
  );
}

function compareDomainValues(
  left: OrderedDomainValue,
  right: OrderedDomainValue,
  type: LogicalType,
): number | undefined {
  if (typeof left === "number" && typeof right === "number") return left === right ? 0 : left < right ? -1 : 1;
  if (typeof left !== "string" || typeof right !== "string") return 0;
  if (type.kind === "integer" || type.kind === "decimal") return compareDecimalStrings(left, right);
  if (type.kind === "timestamp") {
    const leftTime = exactTimestampKey(left);
    const rightTime = exactTimestampKey(right);
    if (!leftTime || !rightTime || leftTime.zoned !== rightTime.zoned) return undefined;
    if (leftTime.epochSecond !== rightTime.epochSecond) {
      return leftTime.epochSecond < rightTime.epochSecond ? -1 : 1;
    }
    if (leftTime.leapSecond !== rightTime.leapSecond) return leftTime.leapSecond ? -1 : 1;
    return leftTime.fraction === rightTime.fraction ? 0 : leftTime.fraction < rightTime.fraction ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

function exactTimestampKey(value: string):
  | {
      readonly epochSecond: bigint;
      readonly fraction: bigint;
      readonly leapSecond: boolean;
      readonly zoned: boolean;
    }
  | undefined {
  const timestamp = parseTimestampValue(value, "nanosecond");
  if (!timestamp) return undefined;
  const localSecond =
    BigInt(daysFromCivil(timestamp.year, timestamp.month, timestamp.day)) * 86_400n +
    BigInt(timestamp.hour * 3_600 + timestamp.minute * 60 + timestamp.second);
  return {
    epochSecond: localSecond - BigInt(timestamp.offsetSeconds ?? 0),
    fraction: BigInt(timestamp.fraction.padEnd(9, "0") || "0"),
    leapSecond: timestamp.second === 60,
    zoned: timestamp.zone !== undefined,
  };
}

/** Proleptic-Gregorian civil day number, based on Howard Hinnant's days-from-civil algorithm. */
function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const monthPrime = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * monthPrime + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function integerString(value: string, bits: 8 | 16 | 32 | 64, signed: boolean): boolean {
  if (!(signed ? /^-?(?:0|[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/).test(value) || value === "-0") return false;
  return integerBigInt(BigInt(value), bits, signed);
}

function integerNumber(value: number, bits: 8 | 16 | 32 | 64, signed: boolean): boolean {
  return Number.isSafeInteger(value) && integerBigInt(BigInt(value), bits, signed);
}

function integerBigInt(value: bigint, bits: 8 | 16 | 32 | 64, signed: boolean): boolean {
  const width = BigInt(bits);
  const minimum = signed ? -(1n << (width - 1n)) : 0n;
  const maximum = signed ? (1n << (width - 1n)) - 1n : (1n << width) - 1n;
  return value >= minimum && value <= maximum;
}

function decimalString(value: string, precision: number | undefined, scale: number | undefined): boolean {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) return false;
  const integer = match[2]!;
  const fraction = match[3] ?? "";
  if (match[1] === "-" && integer === "0" && !/[1-9]/.test(fraction)) return false;
  return decimalDigitsFit(integer, fraction, precision, scale);
}

function binaryValue(value: string, encoding: "base64" | "url" | "opaque"): boolean {
  if (encoding === "opaque") return true;
  if (encoding === "base64") {
    return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
  }
  try {
    absoluteUri(value, "binary URL");
    return true;
  } catch {
    return false;
  }
}

function decimalNumber(value: number, precision: number | undefined, scale: number | undefined): boolean {
  if (!Number.isFinite(value)) return false;
  const expanded = expandExponentialNumber(Object.is(value, -0) ? 0 : value);
  const match = /^-?(0|[1-9]\d*)(?:\.(\d+))?$/.exec(expanded);
  return match !== null && decimalDigitsFit(match[1]!, match[2] ?? "", precision, scale);
}

function decimalDigitsFit(
  integer: string,
  fraction: string,
  precision: number | undefined,
  scale: number | undefined,
): boolean {
  if (scale !== undefined && fraction.length > scale) return false;
  const integerDigits = integer === "0" ? 0 : integer.length;
  if (precision !== undefined && scale !== undefined && integerDigits > precision - scale) return false;
  const totalDigits = Math.max(1, integerDigits + fraction.length);
  return precision === undefined || totalDigits <= precision;
}

function expandExponentialNumber(value: number): string {
  const lexical = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(lexical);
  if (!match) return lexical;
  const sign = match[1]!;
  const integer = match[2]!;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4]!);
  const digits = `${integer}${fraction}`;
  const point = integer.length + exponent;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function calendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function timeOfDay(value: string, unit: TemporalUnit): boolean {
  const match = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?$/.exec(value);
  if (!match) return false;
  const fractionLength = match[4]?.length ?? 0;
  return fractionLength <= temporalFractionDigits(unit);
}

function timestampValue(value: string, unit: TemporalUnit, timezone: "utc" | "offset" | "local" | "unknown"): boolean {
  const timestamp = parseTimestampValue(value, unit);
  if (!timestamp) return false;
  if (timezone === "utc" && timestamp.zone !== "Z") return false;
  if (timezone === "offset" && timestamp.zone === undefined) return false;
  if (timezone === "local" && timestamp.zone !== undefined) return false;
  return true;
}

interface ParsedTimestampValue {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly fraction: string;
  readonly zone?: string;
  readonly offsetSeconds?: number;
}

function parseTimestampValue(value: string, unit: TemporalUnit): ParsedTimestampValue | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d|60)(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const zone = match[8];
  if (!calendarDate(`${match[1]}-${match[2]}-${match[3]}`) || fraction.length > temporalFractionDigits(unit)) {
    return undefined;
  }
  const offsetSeconds = zone === undefined ? undefined : timestampOffsetSeconds(zone);
  if (zone !== undefined && offsetSeconds === undefined) return undefined;
  if (
    second === 60 &&
    (offsetSeconds === undefined || !isUtcLeapSecondBoundary(year, month, day, hour, minute, offsetSeconds))
  ) {
    return undefined;
  }
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    fraction,
    ...(zone === undefined ? {} : { zone, offsetSeconds: offsetSeconds! }),
  };
}

function timestampOffsetSeconds(zone: string): number | undefined {
  if (zone === "Z") return 0;
  if (!validOffset(zone)) return undefined;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(zone)!;
  const magnitude = Number(match[2]) * 3_600 + Number(match[3]) * 60;
  return match[1] === "-" ? -magnitude : magnitude;
}

function isUtcLeapSecondBoundary(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  offsetSeconds: number,
): boolean {
  const localSecondBeforeLeap =
    BigInt(daysFromCivil(year, month, day)) * 86_400n + BigInt(hour * 3_600 + minute * 60 + 59);
  const utcSecondBeforeLeap = localSecondBeforeLeap - BigInt(offsetSeconds);
  for (let candidateYear = year - 1; candidateYear <= year + 1; candidateYear++) {
    for (const [candidateMonth, candidateDay] of [
      [6, 30],
      [12, 31],
    ] as const) {
      const boundary = BigInt(daysFromCivil(candidateYear, candidateMonth, candidateDay)) * 86_400n + 86_399n;
      if (utcSecondBeforeLeap === boundary) return true;
    }
  }
  return false;
}

function temporalFractionDigits(unit: TemporalUnit): number {
  switch (unit) {
    case "second":
      return 0;
    case "millisecond":
      return 3;
    case "microsecond":
      return 6;
    case "nanosecond":
      return 9;
  }
}

function validOffset(value: string): boolean {
  const match = /^[+-](\d{2}):(\d{2})$/.exec(value);
  return match !== null && Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

function durationValue(value: string): boolean {
  return /^-?P(?=\d|T\d)(?:\d+(?:\.\d+)?Y)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?W)?(?:\d+(?:\.\d+)?D)?(?:T(?=\d)(?:\d+(?:\.\d+)?H)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?S)?)?$/.test(
    value,
  );
}

function compareDecimalStrings(left: string, right: string): number {
  const normalizedLeft = decimalParts(left);
  const normalizedRight = decimalParts(right);
  if (normalizedLeft.negative !== normalizedRight.negative) return normalizedLeft.negative ? -1 : 1;
  const direction = normalizedLeft.negative ? -1 : 1;
  if (normalizedLeft.integer.length !== normalizedRight.integer.length) {
    return normalizedLeft.integer.length < normalizedRight.integer.length ? -direction : direction;
  }
  if (normalizedLeft.integer !== normalizedRight.integer) {
    return normalizedLeft.integer < normalizedRight.integer ? -direction : direction;
  }
  const fractionalLength = Math.max(normalizedLeft.fraction.length, normalizedRight.fraction.length);
  const leftFraction = normalizedLeft.fraction.padEnd(fractionalLength, "0");
  const rightFraction = normalizedRight.fraction.padEnd(fractionalLength, "0");
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -direction : direction;
}

function decimalParts(value: string): {
  readonly negative: boolean;
  readonly integer: string;
  readonly fraction: string;
} {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer = "0", fraction = ""] = unsigned.split(".");
  const normalizedInteger = integer.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fraction.replace(/0+$/, "");
  const zero = normalizedInteger === "0" && normalizedFraction === "";
  return { negative: zero ? false : negative, integer: normalizedInteger, fraction: normalizedFraction };
}

function validateProjJson(projjson: JsonObject, path: string): void {
  assertBoundedGraphDepth(projjson, path, 32);
  if (projjson.$schema !== undefined && projjson.$schema !== PROJJSON_V07_SCHEMA) {
    throw new TypeError(`${path}.$schema must identify the supported PROJJSON v0.7 schema`);
  }
  if (typeof projjson.type !== "string" || !PROJJSON_V07_TYPES.has(projjson.type)) {
    throw new TypeError(`${path}.type is not a supported PROJJSON v0.7 CRS root`);
  }
  const validator = validateProjJsonV07Crs as typeof validateProjJsonV07Crs & {
    errors?:
      | readonly {
          readonly instancePath?: string;
          readonly schemaPath?: string;
          readonly keyword?: string;
          readonly params?: { readonly missingProperty?: string; readonly additionalProperty?: string };
          readonly message?: string;
        }[]
      | null;
  };
  if (!validator(projjson)) {
    const selected = selectProjJsonError(projjson.type, validator.errors ?? []);
    const instancePath = selected?.instancePath ? jsonPointerPath(selected.instancePath) : "";
    const missing = selected?.params?.missingProperty;
    const additional = selected?.params?.additionalProperty;
    const selectedPath = missing
      ? `${instancePath}.${missing}`
      : additional
        ? `${instancePath}.${additional}`
        : instancePath;
    const detail = selected?.message ? `: ${selected.message}` : "";
    throw new TypeError(`${path}${selectedPath} does not satisfy the official PROJJSON v0.7 CRS schema${detail}`);
  }
}

function selectProjJsonError(
  type: string,
  errors: readonly {
    readonly instancePath?: string;
    readonly schemaPath?: string;
    readonly keyword?: string;
    readonly params?: { readonly missingProperty?: string; readonly additionalProperty?: string };
    readonly message?: string;
  }[],
): (typeof errors)[number] | undefined {
  // Ajv's standalone code preserves precise instance paths but referenced
  // branch validators use local schema paths (for example `#/required`). Pick
  // a missing property from the selected root vocabulary before considering
  // deeper errors from the other oneOf branches.
  const rootRequired: Readonly<Record<string, readonly string[]>> = {
    GeographicCRS: ["name", "datum", "datum_ensemble"],
    GeodeticCRS: ["name", "datum", "datum_ensemble"],
    ProjectedCRS: ["name", "base_crs", "conversion", "coordinate_system"],
    VerticalCRS: ["name", "datum", "datum_ensemble"],
    CompoundCRS: ["name", "components"],
    BoundCRS: ["source_crs", "target_crs", "transformation"],
    EngineeringCRS: ["name", "datum"],
    ParametricCRS: ["name", "datum"],
    TemporalCRS: ["name", "datum"],
    DerivedProjectedCRS: ["name", "base_crs", "conversion", "coordinate_system"],
    DerivedGeographicCRS: ["name", "base_crs", "conversion", "coordinate_system"],
    DerivedGeodeticCRS: ["name", "base_crs", "conversion", "coordinate_system"],
    DerivedVerticalCRS: ["name", "base_crs", "conversion", "coordinate_system"],
    DerivedEngineeringCRS: ["name", "base_crs", "conversion", "coordinate_system"],
    DerivedTemporalCRS: ["name", "base_crs", "conversion", "coordinate_system"],
    DerivedParametricCRS: ["name", "base_crs", "conversion", "coordinate_system"],
  };
  const expected = rootRequired[type] ?? [];
  const missingRoot = errors.find(
    (error) =>
      error.instancePath === "" &&
      error.keyword === "required" &&
      error.params?.missingProperty !== undefined &&
      expected.includes(error.params.missingProperty),
  );
  if (missingRoot) return missingRoot;
  const officialRootMembers = new Set([
    "$schema",
    "type",
    "name",
    "datum",
    "datum_ensemble",
    "coordinate_system",
    "deformation_models",
    "base_crs",
    "conversion",
    "components",
    "source_crs",
    "target_crs",
    "transformation",
    "geoid_model",
    "geoid_models",
    "scope",
    "area",
    "bbox",
    "vertical_extent",
    "temporal_extent",
    "usages",
    "remarks",
    "id",
    "ids",
  ]);
  const unknownAdditional = errors.find(
    (error) =>
      error.instancePath === "" &&
      error.keyword === "additionalProperties" &&
      error.params?.additionalProperty !== undefined &&
      !officialRootMembers.has(error.params.additionalProperty),
  );
  if (unknownAdditional) return unknownAdditional;
  return (
    [...errors]
      .filter((error) => error.keyword !== "oneOf" && error.instancePath !== "/type")
      .sort((left, right) => (right.instancePath?.length ?? 0) - (left.instancePath?.length ?? 0))[0] ?? errors[0]
  );
}

function jsonPointerPath(pointer: string): string {
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((part) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`))
    .join("");
}

function assertBoundedGraphDepth(value: unknown, path: string, maximum: number): void {
  type GraphFrame =
    | { readonly kind: "enter"; readonly value: unknown; readonly depth: number; readonly path: string }
    | { readonly kind: "leave"; readonly value: object };
  const stack: GraphFrame[] = [{ kind: "enter", value, depth: 0, path }];
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  let scalarAndKeyBytes = 0;
  const consumeBytes = (textValue: string, valuePath: string): void => {
    assertUnicodeScalarString(textValue, valuePath);
    const remaining = MAX_SCHEMA_BYTES - scalarAndKeyBytes;
    if (remaining < 0 || textValue.length > remaining) {
      throw new TypeError(`${path} exceeds the ${MAX_SCHEMA_BYTES}-byte bound`);
    }
    scalarAndKeyBytes += utf8ByteLength(textValue);
    if (scalarAndKeyBytes > MAX_SCHEMA_BYTES) {
      throw new TypeError(`${path} exceeds the ${MAX_SCHEMA_BYTES}-byte bound`);
    }
  };
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.kind === "leave") {
      ancestors.delete(current.value);
      continue;
    }
    if (current.value === null) {
      consumeBytes("null", current.path);
      continue;
    }
    if (typeof current.value === "string") {
      consumeBytes(current.value, current.path);
      continue;
    }
    if (typeof current.value === "boolean") {
      consumeBytes(current.value ? "true" : "false", current.path);
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) throw new TypeError(`${current.path} must contain only finite numbers`);
      consumeBytes(String(current.value), current.path);
      continue;
    }
    if (typeof current.value !== "object") {
      throw new TypeError(`${current.path} contains unsupported ${typeof current.value}`);
    }
    if (current.depth > maximum) throw new TypeError(`${current.path} exceeds maximum JSON nesting depth ${maximum}`);
    if (++nodes > MAX_JSON_NODE_COUNT) throw new TypeError(`${path} exceeds the bounded JSON node count`);
    if (ancestors.has(current.value)) throw new TypeError(`${current.path} must not contain cycles`);
    const prototype = Object.getPrototypeOf(current.value);
    if (!Array.isArray(current.value) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${current.path} must contain only plain JSON objects`);
    }
    if (Object.getOwnPropertySymbols(current.value).length > 0) {
      throw new TypeError(`${current.path} must not contain symbol keys`);
    }
    ancestors.add(current.value);
    stack.push({ kind: "leave", value: current.value });
    if (Array.isArray(current.value)) {
      const arrayValue = current.value;
      if (arrayValue.length > MAX_JSON_NODE_COUNT) {
        throw new TypeError(`${current.path} exceeds the bounded JSON array length`);
      }
      const extraKey = Object.keys(arrayValue).find(
        (key) => !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= arrayValue.length,
      );
      if (extraKey !== undefined) throw new TypeError(`${current.path}.${extraKey} is not a JSON array element`);
      for (let index = arrayValue.length - 1; index >= 0; index--) {
        const descriptor = Object.getOwnPropertyDescriptor(arrayValue, String(index));
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError(`${current.path}[${index}] must be a plain JSON value`);
        }
        stack.push({
          kind: "enter",
          value: descriptor.value,
          depth: current.depth + 1,
          path: `${current.path}[${index}]`,
        });
      }
      continue;
    }
    const descriptors = Object.getOwnPropertyDescriptors(current.value);
    const keys = Object.keys(current.value);
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]!;
      consumeBytes(key, `${current.path} object key`);
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError(`${current.path}.${key} must be a plain JSON value`);
      }
      stack.push({
        kind: "enter",
        value: descriptor.value,
        depth: current.depth + 1,
        path: `${current.path}.${key}`,
      });
    }
  }
}

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${path} contains an unpaired high Unicode surrogate`);
      }
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${path} contains an unpaired low Unicode surrogate`);
    }
  }
}

/** Reject non-I-JSON duplicate names before JSON.parse's last-name-wins object is trusted. */
function assertUniqueJsonObjectNames(source: string): void {
  let index = 0;
  const whitespace = (): void => {
    while (index < source.length && /\s/.test(source[index]!)) index++;
  };
  const stringToken = (): string => {
    const start = index++;
    while (index < source.length) {
      const character = source[index++]!;
      if (character === "\\") index++;
      else if (character === '"') break;
    }
    return JSON.parse(source.slice(start, index)) as string;
  };
  const value = (depth: number): void => {
    if (depth > MAX_SCHEMA_GRAPH_DEPTH) {
      throw new TypeError(`Serialized SourceSchemaV2 exceeds maximum JSON nesting depth ${MAX_SCHEMA_GRAPH_DEPTH}`);
    }
    whitespace();
    const character = source[index];
    if (character === '"') {
      stringToken();
      return;
    }
    if (character === "{") {
      index++;
      whitespace();
      const names = new Set<string>();
      if (source[index] === "}") {
        index++;
        return;
      }
      while (index < source.length) {
        const name = stringToken();
        if (names.has(name)) throw new TypeError("SourceSchemaV2 JSON contains a duplicate object name");
        names.add(name);
        whitespace();
        index++; // colon; JSON syntax was already validated by the native parser.
        value(depth + 1);
        whitespace();
        if (source[index] === "}") {
          index++;
          return;
        }
        index++; // comma
        whitespace();
      }
      return;
    }
    if (character === "[") {
      index++;
      whitespace();
      if (source[index] === "]") {
        index++;
        return;
      }
      while (index < source.length) {
        value(depth + 1);
        whitespace();
        if (source[index] === "]") {
          index++;
          return;
        }
        index++; // comma
      }
      return;
    }
    while (index < source.length && !/[\s,}\]]/.test(source[index]!)) index++;
  };
  value(0);
}

function assertSchemaByteBound(schema: SourceSchemaV2): void {
  const serialized = canonicalStringify(toJsonValue(schema));
  if (utf8ByteLength(serialized) > MAX_SCHEMA_BYTES) {
    throw new TypeError(`SourceSchemaV2 exceeds the ${MAX_SCHEMA_BYTES}-byte bound`);
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function compareFields(left: LogicalField, right: LogicalField): number {
  const leftPath = canonicalStringify(toJsonValue(left.path));
  const rightPath = canonicalStringify(toJsonValue(right.path));
  return leftPath === rightPath ? compareUtf8(left.name, right.name) : compareUtf8(leftPath, rightPath);
}

function compareCanonical(left: unknown, right: unknown): number {
  return compareUtf8(canonicalStringify(toJsonValue(left)), canonicalStringify(toJsonValue(right)));
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function unique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new TypeError(`${label} must not contain duplicates`);
    seen.add(value);
  }
}

function includes<const T extends readonly unknown[]>(values: T, value: unknown): value is T[number] {
  return values.includes(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
