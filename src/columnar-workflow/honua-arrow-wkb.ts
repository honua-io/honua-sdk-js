import {
  type ColumnarBatchIdentityV1,
  type ColumnarBatchV1,
  type GeoArrowCrs,
  type GeoArrowDimensions,
  type GeoArrowEdges,
  type GeoArrowGeometryKind,
  type GeoArrowLineString,
  type GeoArrowPoint,
  type GeoArrowPolygon,
  type GeoArrowPosition,
  type GeoArrowTimestampUnit,
  createGeoArrowBatch,
} from "../columnar/index.js";

const GEOARROW_WKB_EXTENSION = "geoarrow.wkb";
const EXTENSION_NAME = "ARROW:extension:name";
const EXTENSION_METADATA = "ARROW:extension:metadata";
const MAX_METADATA_BYTES = 1024 * 1024;
const UINT32_MAX = 0xffff_ffff;
const ABORT_CHECK_VERTICES = 256;

export interface HonuaArrowWkbMappingOptions {
  /** Required only when an empty or all-null response cannot declare its geometry kind. */
  readonly geometryKind?: GeoArrowGeometryKind;
  /** Exact Arrow field to map to the non-nullable normative feature-id column. */
  readonly featureIdField?: string;
  /** Exact Arrow UTF-8 field to dictionary encode. */
  readonly dictionaryField?: string;
  /** Exact Arrow timestamp field to retain. */
  readonly temporalField?: string;
}

export type HonuaArrowWkbErrorCode =
  | "aborted"
  | "row-limit"
  | "backing-limit"
  | "invalid-payload"
  | "unsupported-layout";

export class HonuaArrowWkbError extends Error {
  constructor(
    readonly code: HonuaArrowWkbErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HonuaArrowWkbError";
  }
}

interface ArrowFieldLike {
  readonly name: string;
  readonly type: unknown;
  readonly metadata?: unknown;
}

interface ArrowVectorLike {
  get(index: number): unknown;
}

interface ArrowRecordBatchLike {
  readonly numRows: number;
  readonly schema: {
    readonly fields: readonly ArrowFieldLike[];
    readonly metadata?: unknown;
  };
  getChildAt(index: number): ArrowVectorLike | null;
}

export interface DecodeHonuaArrowWkbBatchInput extends HonuaArrowWkbMappingOptions {
  readonly recordBatch: unknown;
  readonly id: string;
  readonly sequence: number;
  readonly rowOffset?: number;
  readonly schemaId: string;
  readonly identity: ColumnarBatchIdentityV1;
  readonly maxRows: number;
  readonly maxBackingBytes: number;
  readonly signal?: AbortSignal;
}

interface GeometryDeclaration {
  readonly kind?: GeoArrowGeometryKind;
  readonly dimensions?: GeoArrowDimensions;
  readonly crs: GeoArrowCrs;
  readonly edges: GeoArrowEdges;
}

interface ParsedGeometry {
  readonly kind: GeoArrowGeometryKind;
  readonly dimensions: GeoArrowDimensions;
  readonly value: GeoArrowPoint | GeoArrowLineString | GeoArrowPolygon;
}

interface GeometryBudget {
  vertices: number;
  rings: number;
  readonly maxVertices: number;
  readonly maxRings: number;
  readonly signal?: AbortSignal;
}

function fail(
  code: HonuaArrowWkbErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): never {
  throw new HonuaArrowWkbError(code, message, details, cause === undefined ? undefined : { cause });
}

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) fail("aborted", "Honua Arrow WKB decoding was aborted.", undefined, signal.reason);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const metadataMap = (value: unknown, label: string): ReadonlyMap<string, string> => {
  if (value === undefined || value === null) return new Map();
  if (!(value instanceof Map)) fail("invalid-payload", `${label} must be a string map.`);
  for (const [key, item] of value) {
    if (typeof key !== "string" || typeof item !== "string") {
      fail("invalid-payload", `${label} must contain only string keys and values.`);
    }
  }
  return value as ReadonlyMap<string, string>;
};

const arrowBatch = (value: unknown): ArrowRecordBatchLike => {
  if (!isRecord(value) || !isRecord(value.schema) || !Array.isArray(value.schema.fields)) {
    fail("invalid-payload", "Arrow decoder received an invalid RecordBatch object.");
  }
  if (!Number.isSafeInteger(value.numRows) || (value.numRows as number) < 0) {
    fail("invalid-payload", "Arrow RecordBatch numRows must be a non-negative safe integer.");
  }
  if (typeof value.getChildAt !== "function") {
    fail("invalid-payload", "Arrow RecordBatch must expose getChildAt().");
  }
  for (const field of value.schema.fields) {
    if (!isRecord(field) || typeof field.name !== "string" || field.name.length === 0) {
      fail("invalid-payload", "Arrow RecordBatch fields must have non-empty names.");
    }
  }
  return value as unknown as ArrowRecordBatchLike;
};

const vector = (batch: ArrowRecordBatchLike, index: number): ArrowVectorLike => {
  const result = batch.getChildAt(index);
  if (!result || typeof result.get !== "function") {
    fail("invalid-payload", `Arrow field "${batch.schema.fields[index]?.name ?? index}" has no readable vector.`);
  }
  return result;
};

const fieldType = (field: ArrowFieldLike): string => String(field.type);

const parseMetadataJson = (value: string, label: string, maxBackingBytes: number): Record<string, unknown> => {
  const bytes = new TextEncoder().encode(value).byteLength;
  const limit = Math.min(MAX_METADATA_BYTES, maxBackingBytes);
  if (bytes > limit) {
    fail("backing-limit", `${label} exceeds the ${limit}-byte metadata ceiling.`, { bytes, limit });
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) fail("invalid-payload", `${label} must contain a JSON object.`);
    return parsed;
  } catch (error) {
    if (error instanceof HonuaArrowWkbError) throw error;
    fail("invalid-payload", `${label} is not valid JSON.`, undefined, error);
  }
};

const geometryFieldIndex = (batch: ArrowRecordBatchLike): number => {
  const matches = batch.schema.fields
    .map((field, index) => ({ field, index }))
    .filter(
      ({ field }) =>
        metadataMap(field.metadata, `Arrow field "${field.name}" metadata`).get(EXTENSION_NAME) ===
        GEOARROW_WKB_EXTENSION,
    );
  if (matches.length !== 1) {
    fail("unsupported-layout", "Honua Arrow decoding requires exactly one geoarrow.wkb geometry field.", {
      geometryFields: matches.length,
    });
  }
  if (fieldType(matches[0]!.field) !== "Binary") {
    fail("unsupported-layout", "Honua geoarrow.wkb geometry must use Arrow Binary storage.", {
      field: matches[0]!.field.name,
      type: fieldType(matches[0]!.field),
    });
  }
  return matches[0]!.index;
};

export const hasHonuaArrowWkbGeometry = (value: unknown): boolean => {
  try {
    const batch = arrowBatch(value);
    return batch.schema.fields.some(
      (field) =>
        metadataMap(field.metadata, `Arrow field "${field.name}" metadata`).get(EXTENSION_NAME) ===
        GEOARROW_WKB_EXTENSION,
    );
  } catch {
    return false;
  }
};

const declaredGeometryType = (raw: unknown): Pick<GeometryDeclaration, "kind" | "dimensions"> => {
  if (raw === undefined) return {};
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
    fail("invalid-payload", "geoarrow.wkb geometry_types must be an array of strings.");
  }
  let kind: GeoArrowGeometryKind | undefined;
  let dimensions: GeoArrowDimensions | undefined;
  for (const item of raw as string[]) {
    const match = /^(Point|LineString|Polygon)(?: (Z|M|ZM))?$/.exec(item);
    if (!match) {
      fail("unsupported-layout", `Honua Arrow geometry type "${item}" is not representable by the normative batch.`);
    }
    if (match[2] === "M" || match[2] === "ZM") {
      fail("unsupported-layout", "Honua Arrow WKB decoding does not admit M dimensions.");
    }
    const candidate = match[1]!.toLowerCase() as GeoArrowGeometryKind;
    const candidateDimensions: GeoArrowDimensions = match[2] === "Z" ? "xyz" : "xy";
    if ((kind && kind !== candidate) || (dimensions && dimensions !== candidateDimensions)) {
      fail("unsupported-layout", "Mixed Honua Arrow geometry kinds or dimensions require separate batches.");
    }
    kind = candidate;
    dimensions = candidateDimensions;
  }
  return { ...(kind ? { kind } : {}), ...(dimensions ? { dimensions } : {}) };
};

const geometryDeclaration = (
  batch: ArrowRecordBatchLike,
  index: number,
  maxBackingBytes: number,
): GeometryDeclaration => {
  const field = batch.schema.fields[index]!;
  const metadata = metadataMap(field.metadata, `Arrow field "${field.name}" metadata`);
  const extensionJson = metadata.get(EXTENSION_METADATA);
  const extension = extensionJson
    ? parseMetadataJson(extensionJson, `Arrow field "${field.name}" extension metadata`, maxBackingBytes)
    : {};
  const declared = declaredGeometryType(extension.geometry_types);
  const edgeValue = extension.edges ?? "planar";
  if (!["planar", "spherical", "vincenty", "thomas", "andoyer", "karney"].includes(String(edgeValue))) {
    fail("unsupported-layout", `Honua Arrow edge interpretation "${String(edgeValue)}" is unsupported.`);
  }

  const schemaMetadata = metadataMap(batch.schema.metadata, "Arrow schema metadata");
  const geoJson = schemaMetadata.get("geo");
  if (geoJson) {
    const geo = parseMetadataJson(geoJson, "Arrow geo schema metadata", maxBackingBytes);
    if (geo.primary_column !== field.name) {
      fail("invalid-payload", "Arrow geo primary_column does not match the geoarrow.wkb field.");
    }
    const columns = geo.columns;
    const column = isRecord(columns) ? columns[field.name] : undefined;
    if (!isRecord(column) || column.encoding !== "WKB") {
      fail("invalid-payload", "Arrow geo schema metadata must declare WKB for the primary geometry column.");
    }
  }

  return {
    ...declared,
    crs: (extension.crs as GeoArrowCrs | undefined) ?? "OGC:CRS84",
    edges: edgeValue as GeoArrowEdges,
  };
};

const integerType = (type: string): boolean => /^(?:U?Int)(?:8|16|32|64)$/.test(type);
const utf8Type = (type: string): boolean => type === "Utf8" || type === "LargeUtf8";
const timestampType = (type: string): { readonly unit: GeoArrowTimestampUnit; readonly timezone?: string } | null => {
  const prefix = "Timestamp<";
  if (!type.startsWith(prefix) || !type.endsWith(">")) return null;

  const body = type.slice(prefix.length, -1);
  const separator = body.indexOf(",");
  const declaredUnit = separator < 0 ? body : body.slice(0, separator);
  let unit: GeoArrowTimestampUnit;
  switch (declaredUnit) {
    case "SECOND":
      unit = "second";
      break;
    case "MILLISECOND":
      unit = "millisecond";
      break;
    case "MICROSECOND":
      unit = "microsecond";
      break;
    case "NANOSECOND":
      unit = "nanosecond";
      break;
    default:
      return null;
  }

  if (separator < 0) return { unit };
  const timezone = body.slice(separator + 1).trim();
  if (timezone.length === 0 || timezone.includes(">")) return null;
  return { unit, timezone };
};

const explicitField = (
  fields: readonly ArrowFieldLike[],
  name: string | undefined,
  accepts: (type: string) => boolean,
  role: string,
): number | undefined => {
  if (name === undefined) return undefined;
  const index = fields.findIndex((field) => field.name === name);
  if (index < 0) fail("unsupported-layout", `Arrow ${role} field "${name}" is missing.`);
  if (!accepts(fieldType(fields[index]!))) {
    fail("unsupported-layout", `Arrow ${role} field "${name}" has unsupported type ${fieldType(fields[index]!)}.`);
  }
  return index;
};

const uniqueAutomaticField = (
  fields: readonly ArrowFieldLike[],
  excluded: ReadonlySet<number>,
  accepts: (field: ArrowFieldLike) => boolean,
  role: string,
): number | undefined => {
  const matches = fields
    .map((field, index) => ({ field, index }))
    .filter(({ field, index }) => !excluded.has(index) && accepts(field));
  if (matches.length > 1) {
    fail("unsupported-layout", `Arrow response has ambiguous ${role} fields; configure the exact field name.`, {
      fields: matches.map(({ field }) => field.name),
    });
  }
  return matches[0]?.index;
};

const mappedFields = (
  batch: ArrowRecordBatchLike,
  geometryIndex: number,
  options: HonuaArrowWkbMappingOptions,
): { readonly featureId?: number; readonly dictionary?: number; readonly temporal?: number } => {
  const fields = batch.schema.fields;
  const used = new Set<number>([geometryIndex]);
  const configuredFeatureId = explicitField(fields, options.featureIdField, integerType, "feature-id");
  const featureId =
    configuredFeatureId ??
    uniqueAutomaticField(
      fields,
      used,
      (field) => integerType(fieldType(field)) && ["objectid", "object_id", "fid"].includes(field.name.toLowerCase()),
      "feature-id",
    );
  if (featureId !== undefined) used.add(featureId);
  const configuredDictionary = explicitField(fields, options.dictionaryField, utf8Type, "dictionary");
  const dictionary =
    configuredDictionary ?? uniqueAutomaticField(fields, used, (field) => utf8Type(fieldType(field)), "dictionary");
  if (dictionary !== undefined) used.add(dictionary);
  const configuredTemporal = explicitField(
    fields,
    options.temporalField,
    (type) => timestampType(type) !== null,
    "temporal",
  );
  const temporal =
    configuredTemporal ??
    uniqueAutomaticField(fields, used, (field) => timestampType(fieldType(field)) !== null, "temporal");
  if (temporal !== undefined) used.add(temporal);
  const unmapped = fields
    .filter((_field, index) => !used.has(index))
    .map((field) => ({ name: field.name, type: fieldType(field) }));
  if (unmapped.length > 0) {
    fail(
      "unsupported-layout",
      "Arrow response contains fields that the current normative GeoArrow batch cannot represent.",
      { unmapped },
    );
  }
  return {
    ...(featureId === undefined ? {} : { featureId }),
    ...(dictionary === undefined ? {} : { dictionary }),
    ...(temporal === undefined ? {} : { temporal }),
  };
};

class WkbCursor {
  private readonly view: DataView;
  private offset = 0;

  constructor(
    bytes: Uint8Array,
    private readonly budget: GeometryBudget,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  parse(): ParsedGeometry {
    throwIfAborted(this.budget.signal);
    const byteOrder = this.uint8();
    if (byteOrder !== 0 && byteOrder !== 1) fail("invalid-payload", "WKB byte order must be 0 or 1.");
    const littleEndian = byteOrder === 1;
    const rawType = this.uint32(littleEndian);
    const hasEwkbZ = (rawType & 0x8000_0000) !== 0;
    const hasEwkbM = (rawType & 0x4000_0000) !== 0;
    const hasSrid = (rawType & 0x2000_0000) !== 0;
    let type = rawType & 0x0fff_ffff;
    let hasZ = hasEwkbZ;
    let hasM = hasEwkbM;
    if (type >= 3000) {
      type -= 3000;
      hasZ = true;
      hasM = true;
    } else if (type >= 2000) {
      type -= 2000;
      hasM = true;
    } else if (type >= 1000) {
      type -= 1000;
      hasZ = true;
    }
    if (hasSrid) this.uint32(littleEndian);
    if (hasM) fail("unsupported-layout", "WKB M and ZM coordinates are not admitted by this decoder.");
    const dimensions: GeoArrowDimensions = hasZ ? "xyz" : "xy";
    const width = hasZ ? 3 : 2;
    let result: ParsedGeometry;
    if (type === 1) {
      result = { kind: "point", dimensions, value: this.position(littleEndian, width) };
    } else if (type === 2) {
      const count = this.count(littleEndian, this.budget.maxVertices - this.budget.vertices, "vertices");
      const line: GeoArrowPosition[] = [];
      for (let index = 0; index < count; index += 1) line.push(this.position(littleEndian, width));
      result = { kind: "linestring", dimensions, value: line };
    } else if (type === 3) {
      const ringCount = this.count(littleEndian, this.budget.maxRings - this.budget.rings, "rings");
      this.budget.rings += ringCount;
      const polygon: GeoArrowPosition[][] = [];
      for (let ring = 0; ring < ringCount; ring += 1) {
        const count = this.count(littleEndian, this.budget.maxVertices - this.budget.vertices, "vertices");
        const positions: GeoArrowPosition[] = [];
        for (let index = 0; index < count; index += 1) positions.push(this.position(littleEndian, width));
        polygon.push(positions);
      }
      result = { kind: "polygon", dimensions, value: polygon };
    } else {
      fail("unsupported-layout", `WKB geometry type ${type} is not representable by the normative batch.`);
    }
    if (this.offset !== this.view.byteLength) {
      fail("invalid-payload", "WKB geometry contains trailing bytes.", {
        consumed: this.offset,
        byteLength: this.view.byteLength,
      });
    }
    return result;
  }

  private ensure(bytes: number): void {
    if (bytes > this.view.byteLength - this.offset) fail("invalid-payload", "WKB geometry is truncated.");
  }

  private uint8(): number {
    this.ensure(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  private uint32(littleEndian: boolean): number {
    this.ensure(4);
    const value = this.view.getUint32(this.offset, littleEndian);
    this.offset += 4;
    return value;
  }

  private float64(littleEndian: boolean): number {
    this.ensure(8);
    const value = this.view.getFloat64(this.offset, littleEndian);
    this.offset += 8;
    if (!Number.isFinite(value)) fail("invalid-payload", "WKB coordinates must be finite numbers.");
    return value;
  }

  private count(littleEndian: boolean, remaining: number, resource: string): number {
    const count = this.uint32(littleEndian);
    if (count > remaining) {
      fail("backing-limit", `WKB ${resource} exceed the bounded decode ceiling.`, { count, remaining });
    }
    return count;
  }

  private position(littleEndian: boolean, width: number): GeoArrowPosition {
    if (this.budget.vertices >= this.budget.maxVertices) {
      fail("backing-limit", `WKB vertices exceed the ${this.budget.maxVertices}-vertex decode ceiling.`);
    }
    this.budget.vertices += 1;
    if (this.budget.vertices % ABORT_CHECK_VERTICES === 0) throwIfAborted(this.budget.signal);
    const result: number[] = [];
    for (let index = 0; index < width; index += 1) result.push(this.float64(littleEndian));
    return result;
  }
}

const wkbBytes = (value: unknown, field: string, row: number): Uint8Array | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  fail("invalid-payload", `Arrow WKB field "${field}" row ${row} is not a Uint8Array.`);
};

const featureIdValue = (value: unknown, field: string, row: number): number => {
  if (typeof value !== "number" && typeof value !== "bigint") {
    fail("invalid-payload", `Arrow feature-id field "${field}" row ${row} must be a non-null integer.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > UINT32_MAX) {
    fail("unsupported-layout", `Arrow feature-id field "${field}" row ${row} exceeds the uint32 contract.`);
  }
  return number;
};

const dictionaryValue = (value: unknown, field: string, row: number): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string")
    fail("invalid-payload", `Arrow dictionary field "${field}" row ${row} is not a string.`);
  return value;
};

const timestampValue = (value: unknown, field: string, row: number, unit: GeoArrowTimestampUnit): bigint | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value;
  if (value instanceof Date) {
    const milliseconds = BigInt(value.getTime());
    if (unit === "second") return milliseconds / 1000n;
    if (unit === "millisecond") return milliseconds;
    if (unit === "microsecond") return milliseconds * 1000n;
    return milliseconds * 1_000_000n;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail("invalid-payload", `Arrow timestamp field "${field}" row ${row} is not an exact integer timestamp.`);
  }
  return BigInt(value);
};

export function decodeHonuaArrowWkbRecordBatch(input: DecodeHonuaArrowWkbBatchInput): ColumnarBatchV1 {
  throwIfAborted(input.signal);
  const batch = arrowBatch(input.recordBatch);
  if (batch.numRows > input.maxRows) {
    fail("row-limit", `Arrow RecordBatch exceeds the ${input.maxRows}-row remaining budget.`, {
      rows: batch.numRows,
      limit: input.maxRows,
    });
  }
  if (!Number.isSafeInteger(input.maxBackingBytes) || input.maxBackingBytes <= 0) {
    fail("backing-limit", "Arrow WKB decoding requires a positive backing-byte ceiling.");
  }
  const geometryIndex = geometryFieldIndex(batch);
  const geometryField = batch.schema.fields[geometryIndex]!;
  const declaration = geometryDeclaration(batch, geometryIndex, input.maxBackingBytes);
  const fields = mappedFields(batch, geometryIndex, input);
  const maxVertices = Math.max(1, Math.floor(input.maxBackingBytes / 16));
  const maxRings = Math.max(1, Math.min(maxVertices, Math.floor(input.maxBackingBytes / 4)));
  const budget: GeometryBudget = { vertices: 0, rings: 0, maxVertices, maxRings, signal: input.signal };
  const geometries: Array<GeoArrowPoint | GeoArrowLineString | GeoArrowPolygon | null> = [];
  let observedKind: GeoArrowGeometryKind | undefined;
  let observedDimensions: GeoArrowDimensions | undefined;
  const geometryVector = vector(batch, geometryIndex);
  for (let row = 0; row < batch.numRows; row += 1) {
    throwIfAborted(input.signal);
    const bytes = wkbBytes(geometryVector.get(row), geometryField.name, row);
    if (!bytes) {
      geometries.push(null);
      continue;
    }
    const parsed = new WkbCursor(bytes, budget).parse();
    if (
      (observedKind && observedKind !== parsed.kind) ||
      (observedDimensions && observedDimensions !== parsed.dimensions)
    ) {
      fail("unsupported-layout", "Mixed Arrow WKB geometry kinds or dimensions require separate batches.");
    }
    observedKind = parsed.kind;
    observedDimensions = parsed.dimensions;
    geometries.push(parsed.value);
  }
  const kind = observedKind ?? declaration.kind ?? input.geometryKind;
  const dimensions = observedDimensions ?? declaration.dimensions ?? (kind ? "xy" : undefined);
  if (!kind || !dimensions) {
    fail("unsupported-layout", "Empty or all-null Arrow WKB responses require an explicit geometryKind hint.");
  }
  if (
    (declaration.kind && declaration.kind !== kind) ||
    (declaration.dimensions && declaration.dimensions !== dimensions)
  ) {
    fail("invalid-payload", "Arrow WKB values disagree with the declared geometry_types metadata.");
  }
  if (input.geometryKind && input.geometryKind !== kind) {
    fail(
      "invalid-payload",
      `Arrow WKB geometry kind ${kind} does not match the configured ${input.geometryKind} hint.`,
    );
  }

  const temporalInfo =
    fields.temporal === undefined ? null : timestampType(fieldType(batch.schema.fields[fields.temporal]!));
  const temporalValues: Array<bigint | null> = [];
  const dictionaryValues: Array<string | null> = [];
  const featureIdValues: number[] = [];
  const temporalVector = fields.temporal === undefined ? undefined : vector(batch, fields.temporal);
  const dictionaryVector = fields.dictionary === undefined ? undefined : vector(batch, fields.dictionary);
  const featureIdVector = fields.featureId === undefined ? undefined : vector(batch, fields.featureId);
  for (let row = 0; row < batch.numRows; row += 1) {
    throwIfAborted(input.signal);
    if (temporalVector && temporalInfo) {
      temporalValues.push(
        timestampValue(temporalVector.get(row), batch.schema.fields[fields.temporal!]!.name, row, temporalInfo.unit),
      );
    }
    if (dictionaryVector) {
      dictionaryValues.push(
        dictionaryValue(dictionaryVector.get(row), batch.schema.fields[fields.dictionary!]!.name, row),
      );
    }
    if (featureIdVector) {
      featureIdValues.push(featureIdValue(featureIdVector.get(row), batch.schema.fields[fields.featureId!]!.name, row));
    }
  }
  throwIfAborted(input.signal);

  const geometry =
    kind === "point"
      ? {
          kind,
          field: geometryField.name,
          dimensions,
          coordinateLayout: "interleaved" as const,
          crs: declaration.crs,
          edges: declaration.edges,
          values: geometries as readonly (GeoArrowPoint | null)[],
        }
      : kind === "linestring"
        ? {
            kind,
            field: geometryField.name,
            dimensions,
            coordinateLayout: "interleaved" as const,
            crs: declaration.crs,
            edges: declaration.edges,
            values: geometries as readonly (GeoArrowLineString | null)[],
          }
        : {
            kind,
            field: geometryField.name,
            dimensions,
            coordinateLayout: "interleaved" as const,
            crs: declaration.crs,
            edges: declaration.edges,
            values: geometries as readonly (GeoArrowPolygon | null)[],
          };
  return createGeoArrowBatch(
    {
      id: input.id,
      sequence: input.sequence,
      ...(input.rowOffset === undefined ? {} : { rowOffset: input.rowOffset }),
      schemaId: input.schemaId,
      identity: input.identity,
      geometry,
      ...(fields.temporal === undefined || !temporalInfo
        ? {}
        : {
            temporal: {
              field: batch.schema.fields[fields.temporal]!.name,
              unit: temporalInfo.unit,
              ...(temporalInfo.timezone ? { timezone: temporalInfo.timezone } : {}),
              values: temporalValues,
            },
          }),
      ...(fields.dictionary === undefined
        ? {}
        : {
            dictionary: {
              field: batch.schema.fields[fields.dictionary]!.name,
              values: dictionaryValues,
            },
          }),
      ...(fields.featureId === undefined
        ? {}
        : {
            featureIds: {
              field: batch.schema.fields[fields.featureId]!.name,
              values: featureIdValues,
            },
          }),
    },
    {
      maxRows: input.maxRows,
      maxVertices,
      maxRings,
      maxBackingBytes: input.maxBackingBytes,
      maxCopiedBytes: input.maxBackingBytes,
    },
  ).batch;
}
