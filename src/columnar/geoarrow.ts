import {
  type CreateGeoArrowBatchInput,
  type CreatedGeoArrowBatch,
  type DecodedGeoArrowBatch,
  type DecodedGeoArrowRow,
  GEOARROW_SPEC_VERSION,
  type GeoArrowBatchInspection,
  type GeoArrowConversionLimits,
  type GeoArrowCoordinateLayout,
  type GeoArrowCrs,
  type GeoArrowCrsType,
  type GeoArrowDictionaryBuffers,
  type GeoArrowDimensions,
  type GeoArrowEdges,
  type GeoArrowGeometryBuffers,
  type GeoArrowGeometryColumnInput,
  type GeoArrowGeometryKind,
  type GeoArrowLineString,
  type GeoArrowPoint,
  type GeoArrowPolygon,
  type GeoArrowPosition,
  type GeoArrowTemporalBuffers,
  type GeoArrowTimestampUnit,
  HONUA_GEOARROW_LAYOUT_VERSION,
  HonuaGeoArrowError,
} from "./geoarrow-types.js";
import { createColumnarBatch, inspectColumnarBatch } from "./transfer.js";
import {
  type ColumnarBatchLimits,
  type ColumnarBatchV1,
  type ColumnarBufferV1,
  type ColumnarFieldV1,
  DEFAULT_COLUMNAR_BATCH_MAX_BACKING_BYTES,
  DEFAULT_COLUMNAR_BATCH_MAX_METADATA_ENTRIES,
  DEFAULT_COLUMNAR_BATCH_MAX_ROWS,
  DEFAULT_COLUMNAR_BATCH_MAX_STRING_BYTES,
} from "./types.js";

const DEFAULT_MAX_VERTICES = 8_000_000;
const DEFAULT_MAX_RINGS = 2_000_000;
const DEFAULT_MAX_DICTIONARY_VALUES = 65_536;
const INT32_MAX = 0x7fff_ffff;
const MAX_JSON_DEPTH = 64;
const MAX_GEOARROW_DESCRIPTOR_BYTES = 16 * 1024 * 1024;
const MAX_GEOARROW_JSON_NODES = 65_536;

const META = Object.freeze({
  version: "honua.geoarrow.layout.version",
  specVersion: "honua.geoarrow.spec.version",
  geometryField: "honua.geoarrow.geometry.field",
  geometryKind: "honua.geoarrow.geometry.kind",
  dimensions: "honua.geoarrow.geometry.dimensions",
  coordinateLayout: "honua.geoarrow.geometry.coordinate-layout",
  temporalField: "honua.geoarrow.temporal.field",
  temporalUnit: "honua.geoarrow.temporal.unit",
  temporalTimezone: "honua.geoarrow.temporal.timezone",
  dictionaryField: "honua.geoarrow.dictionary.field",
  dictionaryOrdered: "honua.geoarrow.dictionary.ordered",
  featureIdField: "honua.geoarrow.feature-id.field",
});

/**
 * Payload-validation scope for one inspection.
 *
 * `"full"` walks every payload byte the batch declares, which is what an
 * unbounded consumer needs and what {@link inspectGeoArrowBatch} always does.
 * `"window"` performs the same structural and schema validation but defers the
 * per-row payload checks (coordinate finiteness, dictionary index range, and
 * dictionary UTF-8 decoding) to a caller that reads only a bounded row window
 * and validates exactly the rows it materializes. It exists so a bounded
 * conversion stays proportional to its window instead of to the batch.
 *
 * @internal
 */
export type GeoArrowInspectionScope = "full" | "window";

interface ResolvedLimits {
  readonly maxRows: number;
  readonly maxVertices: number;
  readonly maxRings: number;
  readonly maxDictionaryValues: number;
  readonly maxCopiedBytes: number;
  readonly maxDescriptorBytes: number;
  readonly maxJsonNodes: number;
  readonly batch: ColumnarBatchLimits;
}

interface NormalizedGeometry {
  readonly kind: GeoArrowGeometryKind;
  readonly field: string;
  readonly dimensions: GeoArrowDimensions;
  readonly coordinateLayout: GeoArrowCoordinateLayout;
  readonly crs?: GeoArrowCrs;
  readonly crsType?: GeoArrowCrsType;
  readonly edges: GeoArrowEdges;
  readonly values: readonly (GeoArrowPoint | GeoArrowLineString | GeoArrowPolygon | null)[];
  readonly vertices: number;
  readonly rings: number;
  readonly hasNull: boolean;
}

interface EncodedDictionary {
  readonly values: readonly (string | null)[];
  readonly dictionary: readonly string[];
  readonly indices: readonly number[];
  readonly hasNull: boolean;
  readonly bytes: number;
}

function fail(
  code: ConstructorParameters<typeof HonuaGeoArrowError>[0],
  message: string,
  detail?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): never {
  throw new HonuaGeoArrowError(code, message, detail, cause === undefined ? undefined : { cause });
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) fail("invalid-input", `${name} must be a positive safe integer.`);
  return result;
}

function resolveLimits(limits: GeoArrowConversionLimits): ResolvedLimits {
  const maxRows = positiveLimit(limits.maxRows, DEFAULT_COLUMNAR_BATCH_MAX_ROWS, "maxRows");
  const maxVertices = positiveLimit(limits.maxVertices, DEFAULT_MAX_VERTICES, "maxVertices");
  const maxRings = positiveLimit(limits.maxRings, DEFAULT_MAX_RINGS, "maxRings");
  const maxDictionaryValues = positiveLimit(
    limits.maxDictionaryValues,
    DEFAULT_MAX_DICTIONARY_VALUES,
    "maxDictionaryValues",
  );
  const maxBackingBytes = positiveLimit(
    limits.maxBackingBytes,
    DEFAULT_COLUMNAR_BATCH_MAX_BACKING_BYTES,
    "maxBackingBytes",
  );
  const requestedCopiedBytes = positiveLimit(limits.maxCopiedBytes, maxBackingBytes, "maxCopiedBytes");
  const maxCopiedBytes = Math.min(requestedCopiedBytes, maxBackingBytes);
  const maxDescriptorBytes = positiveLimit(
    limits.maxStringBytes,
    DEFAULT_COLUMNAR_BATCH_MAX_STRING_BYTES,
    "maxStringBytes",
  );
  const maxJsonNodes = positiveLimit(
    limits.maxMetadataEntries,
    DEFAULT_COLUMNAR_BATCH_MAX_METADATA_ENTRIES,
    "maxMetadataEntries",
  );
  for (const [name, value] of Object.entries({
    maxRows,
    maxVertices,
    maxRings,
    maxDictionaryValues,
    maxCopiedBytes: requestedCopiedBytes,
  })) {
    if (value > INT32_MAX) {
      fail("invalid-input", `${name} cannot exceed the int32 GeoArrow representation ceiling ${INT32_MAX}.`, {
        resource: name,
        actual: value,
        limit: INT32_MAX,
      });
    }
  }
  if (maxDescriptorBytes > MAX_GEOARROW_DESCRIPTOR_BYTES) {
    fail(
      "invalid-input",
      `maxStringBytes cannot exceed the ${MAX_GEOARROW_DESCRIPTOR_BYTES}-byte GeoArrow descriptor ceiling.`,
      { resource: "maxStringBytes", actual: maxDescriptorBytes, limit: MAX_GEOARROW_DESCRIPTOR_BYTES },
    );
  }
  if (maxJsonNodes > MAX_GEOARROW_JSON_NODES) {
    fail("invalid-input", `maxMetadataEntries cannot exceed the ${MAX_GEOARROW_JSON_NODES}-node GeoArrow ceiling.`, {
      resource: "maxMetadataEntries",
      actual: maxJsonNodes,
      limit: MAX_GEOARROW_JSON_NODES,
    });
  }
  return Object.freeze({
    maxRows,
    maxVertices,
    maxRings,
    maxDictionaryValues,
    maxCopiedBytes,
    maxDescriptorBytes,
    maxJsonNodes,
    batch: limits,
  });
}

function arrayLength(value: unknown, label: string): number {
  if (!Array.isArray(value)) fail("invalid-input", `${label} must be an array.`);
  const length = value.length;
  if (!Number.isSafeInteger(length)) fail("invalid-input", `${label}.length must be a safe integer.`);
  return length;
}

function dimensionNames(dimensions: GeoArrowDimensions): readonly ("x" | "y" | "z" | "m")[] {
  switch (dimensions) {
    case "xy":
      return ["x", "y"];
    case "xyz":
      return ["x", "y", "z"];
    case "xym":
      return ["x", "y", "m"];
    case "xyzm":
      return ["x", "y", "z", "m"];
    default:
      fail("unsupported-layout", `Unsupported GeoArrow dimensions "${String(dimensions)}".`);
  }
}

function normalizePosition(
  value: unknown,
  names: readonly string[],
  label: string,
  allowEmptyPoint = false,
): GeoArrowPosition {
  const length = arrayLength(value, label);
  const coordinates = value as readonly unknown[];
  if (length !== names.length) {
    fail("invalid-input", `${label} must contain ${names.length} coordinates (${names.join(", ")}).`);
  }
  const emptyPoint =
    allowEmptyPoint && coordinates.every((coordinate) => typeof coordinate === "number" && Number.isNaN(coordinate));
  const result: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const coordinate = coordinates[index];
    if (typeof coordinate !== "number" || (!emptyPoint && !Number.isFinite(coordinate))) {
      fail("invalid-input", `${label}[${index}] must be finite, or every ordinate must be NaN for an empty Point.`);
    }
    result.push(coordinate);
  }
  return Object.freeze(result);
}

function samePosition(first: GeoArrowPosition, last: GeoArrowPosition): boolean {
  return first.length === last.length && first.every((coordinate, index) => coordinate === last[index]);
}

function normalizeGeometry(
  input: GeoArrowGeometryColumnInput,
  rows: number,
  limits: ResolvedLimits,
): NormalizedGeometry {
  if (typeof input !== "object" || input === null) fail("invalid-input", "geometry must be an object.");
  const kind: unknown = input.kind;
  if (kind !== "point" && kind !== "linestring" && kind !== "polygon") {
    fail("unsupported-layout", `Unsupported geometry kind "${String(kind)}".`);
  }
  const field = cleanField(input.field ?? "geometry", "geometry.field");
  const dimensions = input.dimensions ?? "xy";
  const names = dimensionNames(dimensions);
  const coordinateLayout = input.coordinateLayout ?? "separated";
  if (coordinateLayout !== "interleaved" && coordinateLayout !== "separated") {
    fail("unsupported-layout", `Unsupported coordinate layout "${String(coordinateLayout)}".`);
  }
  const edges = input.edges ?? "planar";
  if (!["planar", "spherical", "vincenty", "thomas", "andoyer", "karney"].includes(edges)) {
    fail("unsupported-layout", `Unsupported edge interpretation "${String(edges)}".`);
  }
  if (arrayLength(input.values, "geometry.values") !== rows) {
    fail("invalid-input", "geometry.values length must match the batch row count.");
  }

  let vertices = 0;
  let rings = 0;
  let hasNull = false;
  const values: (GeoArrowPoint | GeoArrowLineString | GeoArrowPolygon | null)[] = [];
  const addVertices = (count: number): void => {
    if (count > limits.maxVertices - vertices) {
      fail("vertex-limit-exceeded", `Geometry exceeds the ${limits.maxVertices}-vertex conversion limit.`, {
        limit: limits.maxVertices,
      });
    }
    vertices += count;
  };

  for (let row = 0; row < rows; row += 1) {
    const geometry = input.values[row];
    if (geometry === null) {
      hasNull = true;
      if (input.kind === "point") addVertices(1);
      values.push(null);
      continue;
    }
    if (input.kind === "point") {
      addVertices(1);
      values.push(normalizePosition(geometry, names, `geometry.values[${row}]`, true));
      continue;
    }
    const partCount = arrayLength(geometry, `geometry.values[${row}]`);
    if (input.kind === "linestring") {
      const rawLine = geometry as GeoArrowLineString;
      addVertices(partCount);
      const line: GeoArrowPosition[] = [];
      for (let vertex = 0; vertex < partCount; vertex += 1) {
        line.push(normalizePosition(rawLine[vertex], names, `geometry.values[${row}][${vertex}]`));
      }
      values.push(Object.freeze(line));
      continue;
    }
    const rawPolygon = geometry as GeoArrowPolygon;
    if (partCount > limits.maxRings - rings) {
      fail("ring-limit-exceeded", `Geometry exceeds the ${limits.maxRings}-ring conversion limit.`, {
        limit: limits.maxRings,
      });
    }
    rings += partCount;
    const polygon: GeoArrowLineString[] = [];
    for (let ringIndex = 0; ringIndex < partCount; ringIndex += 1) {
      const rawRing = rawPolygon[ringIndex];
      const vertexCount = arrayLength(rawRing, `geometry.values[${row}][${ringIndex}]`);
      if (vertexCount !== 0 && vertexCount < 4) {
        fail("invalid-input", `Polygon ring ${row}:${ringIndex} must be empty or contain at least four positions.`);
      }
      addVertices(vertexCount);
      const ring: GeoArrowPosition[] = [];
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        ring.push(normalizePosition(rawRing[vertex], names, `geometry.values[${row}][${ringIndex}][${vertex}]`));
      }
      if (ring.length > 0 && !samePosition(ring[0]!, ring[ring.length - 1]!)) {
        fail("invalid-input", `Polygon ring ${row}:${ringIndex} must be closed.`);
      }
      polygon.push(Object.freeze(ring));
    }
    values.push(Object.freeze(polygon));
  }

  const crs = input.crs === undefined ? undefined : normalizeCrs(input.crs, limits);
  const crsType = normalizeCrsType(input.crsType, crs);
  return Object.freeze({
    kind: input.kind,
    field,
    dimensions,
    coordinateLayout,
    ...(crs === undefined ? {} : { crs }),
    ...(crsType === undefined ? {} : { crsType }),
    edges,
    values: Object.freeze(values),
    vertices,
    rings,
    hasNull,
  });
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code <= 0x1f) bytes += 6;
    else if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 6;
    } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

interface JsonBudget {
  bytes: number;
  nodes: number;
  readonly maxBytes: number;
  readonly maxNodes: number;
  readonly ancestors: WeakSet<object>;
}

function consumeJson(budget: JsonBudget, bytes: number): void {
  if (bytes > budget.maxBytes - budget.bytes) {
    fail("invalid-input", `CRS metadata exceeds the ${budget.maxBytes}-byte descriptor limit.`, {
      resource: "crs-json-bytes",
      limit: budget.maxBytes,
    });
  }
  budget.bytes += bytes;
}

function normalizeJsonValue(value: unknown, depth: number, budget: JsonBudget, label: string): unknown {
  if (depth > MAX_JSON_DEPTH) fail("invalid-input", `CRS metadata exceeds the ${MAX_JSON_DEPTH}-level depth limit.`);
  budget.nodes += 1;
  if (budget.nodes > budget.maxNodes) {
    fail("invalid-input", `CRS metadata exceeds the ${budget.maxNodes}-node descriptor limit.`, {
      resource: "crs-json-nodes",
      limit: budget.maxNodes,
    });
  }
  if (value === null) {
    consumeJson(budget, 4);
    return null;
  }
  if (typeof value === "string") {
    consumeJson(budget, jsonStringBytes(value));
    return value;
  }
  if (typeof value === "boolean") {
    consumeJson(budget, value ? 4 : 5);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid-input", `${label} must contain only finite JSON numbers.`);
    consumeJson(budget, utf8Bytes(String(value)));
    return value;
  }
  if (value === null || typeof value !== "object") {
    fail("invalid-input", `${label} contains a non-JSON value.`);
  }
  if (budget.ancestors.has(value)) fail("invalid-input", `${label} contains a cycle.`);
  budget.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail("invalid-input", `${label} must contain only plain JSON arrays.`);
      }
      consumeJson(budget, 2);
      if (value.length > budget.maxNodes - budget.nodes) {
        fail("invalid-input", `CRS metadata exceeds the ${budget.maxNodes}-node descriptor limit.`);
      }
      const normalized: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) consumeJson(budget, 1);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) {
          fail("invalid-input", `${label}[${index}] must be a plain JSON data property.`);
        }
        normalized.push(normalizeJsonValue(descriptor.value, depth + 1, budget, `${label}[${index}]`));
      }
      return Object.freeze(normalized);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("invalid-input", `${label} must contain only plain JSON objects.`);
    }
    consumeJson(budget, 2);
    const normalized = Object.create(null) as Record<string, unknown>;
    let propertyCount = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      propertyCount += 1;
      if (propertyCount > budget.maxNodes - budget.nodes) {
        fail("invalid-input", `CRS metadata exceeds the ${budget.maxNodes}-node descriptor limit.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined) {
        fail("invalid-input", `${label}.${key} must be a plain JSON data property.`);
      }
      if (propertyCount > 1) consumeJson(budget, 1);
      consumeJson(budget, jsonStringBytes(key) + 1);
      normalized[key] = normalizeJsonValue(descriptor.value, depth + 1, budget, `${label}.${key}`);
    }
    return Object.freeze(normalized);
  } finally {
    budget.ancestors.delete(value);
  }
}

function boundedJson(
  value: unknown,
  limits: ResolvedLimits,
  label: string,
): { readonly value: unknown; readonly json: string } {
  const budget: JsonBudget = {
    bytes: 0,
    nodes: 0,
    maxBytes: limits.maxDescriptorBytes,
    maxNodes: limits.maxJsonNodes,
    ancestors: new WeakSet(),
  };
  try {
    const normalized = normalizeJsonValue(value, 0, budget, label);
    const json = JSON.stringify(normalized);
    if (utf8Bytes(json) !== budget.bytes) fail("invalid-input", `${label} byte accounting is inconsistent.`);
    return Object.freeze({ value: normalized, json });
  } catch (cause) {
    if (cause instanceof HonuaGeoArrowError) throw cause;
    fail("invalid-input", `${label} could not be inspected as bounded plain JSON.`, undefined, cause);
  }
}

function normalizeCrs(crs: GeoArrowCrs, limits: ResolvedLimits): GeoArrowCrs {
  if (typeof crs === "string") {
    if (crs.trim() === "") fail("invalid-input", "geometry.crs must not be empty.");
    if (jsonStringBytes(crs) > limits.maxDescriptorBytes) {
      fail("invalid-input", `CRS metadata exceeds the ${limits.maxDescriptorBytes}-byte descriptor limit.`);
    }
    return crs;
  }
  if (typeof crs !== "object" || crs === null || Array.isArray(crs)) {
    fail("invalid-input", "geometry.crs must be a serialized CRS string or PROJJSON object.");
  }
  return boundedJson(crs, limits, "geometry.crs").value as GeoArrowCrs;
}

const GEOARROW_CRS_TYPES: readonly GeoArrowCrsType[] = ["projjson", "wkt2:2019", "authority_code", "srid"];

function normalizeCrsType(crsType: unknown, crs: GeoArrowCrs | undefined): GeoArrowCrsType | undefined {
  if (crsType === undefined) return undefined;
  if (typeof crsType !== "string" || !GEOARROW_CRS_TYPES.includes(crsType as GeoArrowCrsType)) {
    fail("invalid-input", `Unsupported geometry.crsType "${String(crsType)}".`);
  }
  if (crs === undefined) fail("invalid-input", "geometry.crsType requires geometry.crs.");
  return crsType as GeoArrowCrsType;
}

function extensionMetadata(geometry: NormalizedGeometry, limits: ResolvedLimits): string {
  const metadata: Record<string, unknown> = {};
  if (geometry.crs !== undefined) metadata.crs = geometry.crs;
  if (geometry.crsType !== undefined) metadata.crs_type = geometry.crsType;
  if (geometry.edges !== "planar") metadata.edges = geometry.edges;
  return boundedJson(metadata, limits, "GeoArrow extension metadata").json;
}

function coordinateField(dimensions: GeoArrowDimensions, layout: GeoArrowCoordinateLayout): ColumnarFieldV1 {
  const names = dimensionNames(dimensions);
  if (layout === "separated") {
    return {
      name: "coordinates",
      type: { name: "struct", parameters: { dimensions } },
      nullable: false,
      children: names.map((name) => ({ name, type: { name: "float64" }, nullable: false })),
    };
  }
  return {
    name: names.join(""),
    type: { name: "fixed_size_list", parameters: { size: names.length, valueType: "float64" } },
    nullable: false,
    children: [{ name: "values", type: { name: "float64" }, nullable: false }],
  };
}

function geometryField(geometry: NormalizedGeometry, limits: ResolvedLimits): ColumnarFieldV1 {
  const coordinate = coordinateField(geometry.dimensions, geometry.coordinateLayout);
  let children: readonly ColumnarFieldV1[];
  if (geometry.kind === "point") children = [coordinate];
  else if (geometry.kind === "linestring") {
    children = [
      {
        name: "vertices",
        type: { name: "list", parameters: { offsetType: "int32" } },
        nullable: false,
        children: [coordinate],
      },
    ];
  } else {
    children = [
      {
        name: "rings",
        type: { name: "list", parameters: { offsetType: "int32" } },
        nullable: false,
        children: [
          {
            name: "vertices",
            type: { name: "list", parameters: { offsetType: "int32" } },
            nullable: false,
            children: [coordinate],
          },
        ],
      },
    ];
  }
  const encodedExtensionMetadata = extensionMetadata(geometry, limits);
  return {
    name: geometry.field,
    type: {
      name: `geoarrow.${geometry.kind}`,
      parameters: {
        dimensions: geometry.dimensions,
        coordinateLayout: geometry.coordinateLayout,
        offsetType: "int32",
      },
    },
    nullable: geometry.hasNull,
    children,
    metadata: {
      "ARROW:extension:name": `geoarrow.${geometry.kind}`,
      ...(encodedExtensionMetadata === "{}" ? {} : { "ARROW:extension:metadata": encodedExtensionMetadata }),
    },
  };
}

function allocate<T extends ArrayBufferView>(ctor: { new (length: number): T }, length: number, label: string): T {
  try {
    return new ctor(length);
  } catch (cause) {
    fail("copy-limit-exceeded", `Unable to allocate bounded ${label} payload.`, { length }, cause);
  }
}

function validityBitmap(values: readonly unknown[], nullable: (value: unknown) => boolean): Uint8Array | undefined {
  if (!values.some(nullable)) return undefined;
  const bitmap = allocate(Uint8Array, Math.ceil(values.length / 8), "validity");
  values.forEach((value, index) => {
    if (!nullable(value)) bitmap[index >> 3]! |= 1 << (index & 7);
  });
  return bitmap;
}

function pushBuffer(
  buffers: ColumnarBufferV1[],
  id: string,
  role: ColumnarBufferV1["role"],
  field: string,
  view: ArrayBufferView,
): void {
  buffers.push({
    id,
    role,
    field,
    data: view.buffer as ArrayBuffer,
    byteOffset: view.byteOffset,
    byteLength: view.byteLength,
  });
}

function geometryPositions(geometry: NormalizedGeometry): readonly GeoArrowPosition[] {
  const positions: GeoArrowPosition[] = [];
  for (const value of geometry.values) {
    if (value === null) {
      if (geometry.kind === "point")
        positions.push(Object.freeze(new Array<number>(dimensionNames(geometry.dimensions).length).fill(0)));
      continue;
    }
    if (geometry.kind === "point") positions.push(value as GeoArrowPoint);
    else if (geometry.kind === "linestring") positions.push(...(value as GeoArrowLineString));
    else for (const ring of value as GeoArrowPolygon) positions.push(...ring);
  }
  return positions;
}

function encodeGeometry(geometry: NormalizedGeometry, buffers: ColumnarBufferV1[]): void {
  const validity = validityBitmap(geometry.values, (value) => value === null);
  if (validity) pushBuffer(buffers, `${geometry.field}.validity`, "validity", geometry.field, validity);

  if (geometry.kind !== "point") {
    const offsets = allocate(Int32Array, geometry.values.length + 1, "geometry offsets");
    let offset = 0;
    geometry.values.forEach((value, row) => {
      offsets[row] = offset;
      if (value !== null) offset += (value as readonly unknown[]).length;
    });
    offsets[geometry.values.length] = offset;
    pushBuffer(buffers, `${geometry.field}.offsets`, "offsets", geometry.field, offsets);
  }
  if (geometry.kind === "polygon") {
    const ringOffsets = allocate(Int32Array, geometry.rings + 1, "ring offsets");
    let ringIndex = 0;
    let vertexOffset = 0;
    for (const value of geometry.values) {
      if (value === null) continue;
      for (const ring of value as GeoArrowPolygon) {
        ringOffsets[ringIndex] = vertexOffset;
        vertexOffset += ring.length;
        ringIndex += 1;
      }
    }
    ringOffsets[ringIndex] = vertexOffset;
    pushBuffer(buffers, `${geometry.field}.ring-offsets`, "offsets", geometry.field, ringOffsets);
  }

  const names = dimensionNames(geometry.dimensions);
  const positions = geometryPositions(geometry);
  if (geometry.coordinateLayout === "interleaved") {
    const coordinates = allocate(Float64Array, geometry.vertices * names.length, "interleaved coordinates");
    let index = 0;
    for (const position of positions) for (const coordinate of position) coordinates[index++] = coordinate;
    pushBuffer(buffers, `${geometry.field}.coordinates`, "geometry", geometry.field, coordinates);
    return;
  }
  names.forEach((name, dimension) => {
    const coordinates = allocate(Float64Array, geometry.vertices, `${name} coordinates`);
    positions.forEach((position, vertex) => {
      coordinates[vertex] = position[dimension]!;
    });
    pushBuffer(buffers, `${geometry.field}.${name}`, "geometry", geometry.field, coordinates);
  });
}

function encodeDictionaryValues(
  values: readonly (string | null)[],
  maxValues: number,
  maxBytes: number,
): EncodedDictionary {
  const dictionary: string[] = [];
  const byValue = new Map<string, number>();
  const indices: number[] = [];
  let hasNull = false;
  let bytes = 0;
  values.forEach((value, row) => {
    if (value === null) {
      hasNull = true;
      indices.push(0);
      return;
    }
    if (typeof value !== "string") fail("invalid-input", `dictionary.values[${row}] must be a string or null.`);
    let index = byValue.get(value);
    if (index === undefined) {
      if (dictionary.length === maxValues) {
        fail("dictionary-limit-exceeded", `Dictionary exceeds the ${maxValues}-value conversion limit.`, {
          limit: maxValues,
        });
      }
      index = dictionary.length;
      const encodedBytes = utf8Bytes(value);
      if (encodedBytes > INT32_MAX - bytes || encodedBytes > maxBytes - bytes) {
        fail("copy-limit-exceeded", "Dictionary UTF-8 values exceed the bounded int32 payload representation.", {
          resource: "dictionary-utf8-bytes",
          actual: bytes + encodedBytes,
          limit: Math.min(INT32_MAX, maxBytes),
        });
      }
      bytes += encodedBytes;
      dictionary.push(value);
      byValue.set(value, index);
    }
    indices.push(index);
  });
  return { values, dictionary, indices, hasNull, bytes };
}

function checkedAdd(total: number, addition: number, limit: number): number {
  if (!Number.isSafeInteger(addition) || addition < 0 || addition > limit - total) {
    fail("copy-limit-exceeded", `Conversion payload exceeds the ${limit}-byte copy limit.`, { limit });
  }
  return total + addition;
}

function expectedPayloadBytes(
  rows: number,
  geometry: NormalizedGeometry,
  temporal: CreateGeoArrowBatchInput["temporal"],
  dictionary: EncodedDictionary | undefined,
  featureIds: CreateGeoArrowBatchInput["featureIds"],
  limit: number,
): number {
  let bytes = 0;
  const validityBytes = Math.ceil(rows / 8);
  if (geometry.hasNull) bytes = checkedAdd(bytes, validityBytes, limit);
  if (geometry.kind !== "point") bytes = checkedAdd(bytes, (rows + 1) * 4, limit);
  if (geometry.kind === "polygon") bytes = checkedAdd(bytes, (geometry.rings + 1) * 4, limit);
  bytes = checkedAdd(bytes, geometry.vertices * dimensionNames(geometry.dimensions).length * 8, limit);
  if (temporal) {
    if (temporal.values.some((value) => value === null)) bytes = checkedAdd(bytes, validityBytes, limit);
    bytes = checkedAdd(bytes, rows * 8, limit);
  }
  if (dictionary) {
    if (dictionary.hasNull) bytes = checkedAdd(bytes, validityBytes, limit);
    bytes = checkedAdd(bytes, rows * 4, limit);
    bytes = checkedAdd(bytes, (dictionary.dictionary.length + 1) * 4, limit);
    bytes = checkedAdd(bytes, dictionary.bytes, limit);
  }
  if (featureIds) bytes = checkedAdd(bytes, rows * 4, limit);
  return bytes;
}

function cleanField(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    fail("invalid-input", `${label} must be a clean non-empty identifier.`);
  }
  return value;
}

/**
 * Convert bounded semantic geometry/temporal/dictionary values to the normative
 * Honua GeoArrow mapping. All returned payload buffers are newly owned, exact
 * copy accounting is returned, and the generic transfer contract remains valid.
 */
export function createGeoArrowBatch(
  input: CreateGeoArrowBatchInput,
  limits: GeoArrowConversionLimits = {},
): CreatedGeoArrowBatch {
  if (typeof input !== "object" || input === null) fail("invalid-input", "GeoArrow batch input must be an object.");
  const resolved = resolveLimits(limits);
  const rows = arrayLength(input.geometry?.values, "geometry.values");
  if (rows > resolved.maxRows) {
    fail("row-limit-exceeded", `Batch has ${rows} rows; the conversion limit is ${resolved.maxRows}.`, {
      rows,
      limit: resolved.maxRows,
    });
  }
  const geometry = normalizeGeometry(input.geometry, rows, resolved);
  const fields: ColumnarFieldV1[] = [geometryField(geometry, resolved)];
  const fieldNames = new Set([geometry.field]);
  const registerField = (field: string, label: string): string => {
    const cleaned = cleanField(field, label);
    if (fieldNames.has(cleaned)) fail("invalid-input", `${label} duplicates field "${cleaned}".`);
    fieldNames.add(cleaned);
    return cleaned;
  };

  let temporalField: string | undefined;
  if (input.temporal) {
    temporalField = registerField(input.temporal.field, "temporal.field");
    if (arrayLength(input.temporal.values, "temporal.values") !== rows) {
      fail("invalid-input", "temporal.values length must match geometry.values.");
    }
    if (!["second", "millisecond", "microsecond", "nanosecond"].includes(input.temporal.unit)) {
      fail("unsupported-layout", `Unsupported timestamp unit "${String(input.temporal.unit)}".`);
    }
    fields.push({
      name: temporalField,
      type: {
        name: "timestamp",
        parameters: {
          unit: input.temporal.unit,
          ...(input.temporal.timezone === undefined ? {} : { timezone: input.temporal.timezone }),
        },
      },
      nullable: input.temporal.values.some((value) => value === null),
    });
  }

  let encodedDictionary: EncodedDictionary | undefined;
  let dictionaryField: string | undefined;
  if (input.dictionary) {
    dictionaryField = registerField(input.dictionary.field, "dictionary.field");
    if (arrayLength(input.dictionary.values, "dictionary.values") !== rows) {
      fail("invalid-input", "dictionary.values length must match geometry.values.");
    }
    encodedDictionary = encodeDictionaryValues(
      input.dictionary.values,
      resolved.maxDictionaryValues,
      resolved.maxCopiedBytes,
    );
    fields.push({
      name: dictionaryField,
      type: {
        name: "dictionary",
        parameters: { indexType: "int32", valueType: "utf8", ordered: input.dictionary.ordered ?? false },
      },
      nullable: encodedDictionary.hasNull,
    });
  }

  let featureIdField: string | undefined;
  if (input.featureIds) {
    featureIdField = registerField(input.featureIds.field, "featureIds.field");
    if (!Number.isSafeInteger(input.featureIds.values.length) || input.featureIds.values.length !== rows) {
      fail("invalid-input", "featureIds.values length must match geometry.values.");
    }
    fields.push({ name: featureIdField, type: { name: "uint32" }, nullable: false });
  }

  const copiedBytes = expectedPayloadBytes(
    rows,
    geometry,
    input.temporal,
    encodedDictionary,
    input.featureIds,
    resolved.maxCopiedBytes,
  );
  const schemaMetadata: Record<string, string> = {
    [META.version]: HONUA_GEOARROW_LAYOUT_VERSION,
    [META.specVersion]: GEOARROW_SPEC_VERSION,
    [META.geometryField]: geometry.field,
    [META.geometryKind]: geometry.kind,
    [META.dimensions]: geometry.dimensions,
    [META.coordinateLayout]: geometry.coordinateLayout,
  };
  if (input.temporal && temporalField) {
    schemaMetadata[META.temporalField] = temporalField;
    schemaMetadata[META.temporalUnit] = input.temporal.unit;
    if (input.temporal.timezone !== undefined) schemaMetadata[META.temporalTimezone] = input.temporal.timezone;
  }
  if (input.dictionary && dictionaryField) {
    schemaMetadata[META.dictionaryField] = dictionaryField;
    schemaMetadata[META.dictionaryOrdered] = String(input.dictionary.ordered ?? false);
  }
  if (featureIdField) schemaMetadata[META.featureIdField] = featureIdField;

  const buffers: ColumnarBufferV1[] = [];
  encodeGeometry(geometry, buffers);
  if (input.temporal && temporalField) {
    const validity = validityBitmap(input.temporal.values, (value) => value === null);
    if (validity) pushBuffer(buffers, `${temporalField}.validity`, "validity", temporalField, validity);
    const values = allocate(BigInt64Array, rows, "timestamp values");
    input.temporal.values.forEach((value, index) => {
      if (value !== null) {
        if (typeof value !== "bigint") fail("invalid-input", `temporal.values[${index}] must be a bigint or null.`);
        values[index] = value;
      }
    });
    pushBuffer(buffers, `${temporalField}.values`, "values", temporalField, values);
  }
  if (encodedDictionary && dictionaryField) {
    const validity = validityBitmap(encodedDictionary.values, (value) => value === null);
    if (validity) pushBuffer(buffers, `${dictionaryField}.validity`, "validity", dictionaryField, validity);
    const indices = allocate(Int32Array, rows, "dictionary indices");
    indices.set(encodedDictionary.indices);
    const offsets = allocate(Int32Array, encodedDictionary.dictionary.length + 1, "dictionary offsets");
    const values = allocate(Uint8Array, encodedDictionary.bytes, "dictionary UTF-8 values");
    let offset = 0;
    const encoder = new TextEncoder();
    encodedDictionary.dictionary.forEach((dictionaryValue, index) => {
      offsets[index] = offset;
      const target = values.subarray(offset);
      const result = encoder.encodeInto(dictionaryValue, target);
      if (result.read !== dictionaryValue.length) fail("invalid-input", "Dictionary UTF-8 encoding was truncated.");
      offset += result.written;
    });
    offsets[encodedDictionary.dictionary.length] = offset;
    pushBuffer(buffers, `${dictionaryField}.indices`, "dictionary", dictionaryField, indices);
    pushBuffer(buffers, `${dictionaryField}.offsets`, "offsets", dictionaryField, offsets);
    pushBuffer(buffers, `${dictionaryField}.values`, "dictionary", dictionaryField, values);
  }
  if (input.featureIds && featureIdField) {
    const values = allocate(Uint32Array, rows, "feature ids");
    for (let index = 0; index < rows; index += 1) {
      const value = input.featureIds.values[index];
      if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
        fail("invalid-input", `featureIds.values[${index}] must be a uint32.`);
      }
      values[index] = value;
    }
    pushBuffer(buffers, `${featureIdField}.values`, "values", featureIdField, values);
  }

  const batch = createColumnarBatch(
    {
      id: input.id,
      sequence: input.sequence,
      ...(input.rowOffset === undefined ? {} : { rowOffset: input.rowOffset }),
      rowCount: rows,
      schema: { id: input.schemaId, fields, metadata: schemaMetadata },
      identity: input.identity,
      buffers,
    },
    resolved.batch,
  );
  const baseMetrics = inspectColumnarBatch(batch, resolved.batch);
  if (baseMetrics.backingBytes !== copiedBytes) {
    fail("invalid-batch", "GeoArrow conversion accounting disagrees with the columnar envelope.", {
      copiedBytes,
      backingBytes: baseMetrics.backingBytes,
    });
  }
  return Object.freeze({
    batch,
    metrics: Object.freeze({
      rows,
      vertices: geometry.vertices,
      rings: geometry.rings,
      dictionaryValues: encodedDictionary?.dictionary.length ?? 0,
      copiedBytes,
      backingBytes: baseMetrics.backingBytes,
    }),
  });
}

function requireMetadata(metadata: Readonly<Record<string, string>> | undefined, key: string): string {
  const value = metadata?.[key];
  if (value === undefined) fail("invalid-batch", `GeoArrow schema metadata is missing "${key}".`, { key });
  return value;
}

function parseExtensionMetadata(
  field: ColumnarFieldV1,
  limits: ResolvedLimits,
): { readonly crs?: GeoArrowCrs; readonly crsType?: GeoArrowCrsType; readonly edges: GeoArrowEdges } {
  const fieldMetadataKeys = Object.keys(field.metadata ?? {});
  if (fieldMetadataKeys.some((key) => key !== "ARROW:extension:name" && key !== "ARROW:extension:metadata")) {
    fail("invalid-batch", `Geometry field "${field.name}" contains undeclared extension metadata.`);
  }
  const encoded = field.metadata?.["ARROW:extension:metadata"] ?? "{}";
  if (utf8Bytes(encoded) > limits.maxDescriptorBytes) {
    fail("invalid-batch", "GeoArrow extension metadata exceeds the bounded descriptor limit.");
  }
  try {
    const parsed = JSON.parse(encoded) as unknown;
    const value = boundedJson(parsed, limits, "GeoArrow extension metadata").value as {
      crs?: unknown;
      crs_type?: unknown;
      edges?: unknown;
    };
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    if (Object.keys(value).some((key) => key !== "crs" && key !== "crs_type" && key !== "edges")) {
      fail("invalid-batch", "GeoArrow extension metadata contains an undeclared property.");
    }
    const edges = value.edges ?? "planar";
    if (!["planar", "spherical", "vincenty", "thomas", "andoyer", "karney"].includes(String(edges))) {
      fail("unsupported-layout", `Unsupported GeoArrow edges metadata "${String(edges)}".`);
    }
    if (
      value.crs !== undefined &&
      typeof value.crs !== "string" &&
      (typeof value.crs !== "object" || value.crs === null || Array.isArray(value.crs))
    ) {
      fail("invalid-batch", "GeoArrow extension CRS metadata is malformed.");
    }
    const crsType = value.crs_type;
    if (
      crsType !== undefined &&
      (typeof crsType !== "string" || !GEOARROW_CRS_TYPES.includes(crsType as GeoArrowCrsType))
    ) {
      fail("invalid-batch", `Unsupported GeoArrow crs_type metadata "${String(crsType)}".`);
    }
    if (crsType !== undefined && value.crs === undefined) {
      fail("invalid-batch", "GeoArrow crs_type metadata requires crs metadata.");
    }
    return Object.freeze({
      ...(value.crs === undefined ? {} : { crs: value.crs as GeoArrowCrs }),
      ...(crsType === undefined ? {} : { crsType: crsType as GeoArrowCrsType }),
      edges: edges as GeoArrowEdges,
    });
  } catch (cause) {
    if (cause instanceof HonuaGeoArrowError) {
      if (cause.code !== "invalid-input") throw cause;
      fail("invalid-batch", "GeoArrow extension metadata exceeds the bounded JSON contract.", cause.detail, cause);
    }
    fail("invalid-batch", "GeoArrow extension metadata is not valid JSON.", undefined, cause);
  }
}

function bufferMap(batch: ColumnarBatchV1): ReadonlyMap<string, ColumnarBufferV1> {
  return new Map(batch.buffers.map((buffer) => [buffer.id, buffer]));
}

function optionalBuffer(buffers: ReadonlyMap<string, ColumnarBufferV1>, id: string): ColumnarBufferV1 | undefined {
  return buffers.get(id);
}

function requiredBuffer(buffers: ReadonlyMap<string, ColumnarBufferV1>, id: string): ColumnarBufferV1 {
  const buffer = buffers.get(id);
  if (!buffer) fail("invalid-batch", `GeoArrow batch is missing buffer "${id}".`, { bufferId: id });
  return buffer;
}

interface TypedArrayConstructor<T extends ArrayBufferView> {
  readonly BYTES_PER_ELEMENT: number;
  new (buffer: ArrayBuffer, byteOffset: number, length: number): T;
}

function typedView<T extends ArrayBufferView>(buffer: ColumnarBufferV1, ctor: TypedArrayConstructor<T>): T {
  if (buffer.byteOffset % ctor.BYTES_PER_ELEMENT !== 0 || buffer.byteLength % ctor.BYTES_PER_ELEMENT !== 0) {
    fail("invalid-batch", `Buffer "${buffer.id}" is not component-aligned.`, { bufferId: buffer.id });
  }
  try {
    return new ctor(buffer.data, buffer.byteOffset, buffer.byteLength / ctor.BYTES_PER_ELEMENT);
  } catch (cause) {
    fail(
      "invalid-batch",
      `Buffer "${buffer.id}" cannot be viewed with its normative component type.`,
      undefined,
      cause,
    );
  }
}

function optionalValidity(
  buffers: ReadonlyMap<string, ColumnarBufferV1>,
  id: string,
  rows: number,
): Uint8Array | undefined {
  const descriptor = optionalBuffer(buffers, id);
  if (!descriptor) return undefined;
  const view = typedView(descriptor, Uint8Array);
  if (view.length !== Math.ceil(rows / 8)) {
    fail("invalid-batch", `Validity buffer "${id}" has the wrong length.`, {
      expected: Math.ceil(rows / 8),
      actual: view.length,
    });
  }
  return view;
}

function offsetsView(buffer: ColumnarBufferV1, length: number, label: string): Int32Array {
  const view = typedView(buffer, Int32Array);
  if (view.length !== length) fail("invalid-batch", `${label} must contain ${length} int32 offsets.`);
  if (view[0] !== 0) fail("invalid-batch", `${label} must start at zero.`);
  for (let index = 1; index < view.length; index += 1) {
    if (view[index]! < view[index - 1]!) fail("invalid-batch", `${label} must be monotonic.`);
  }
  return view;
}

function assertCount(
  count: number,
  limit: number,
  code: "vertex-limit-exceeded" | "ring-limit-exceeded",
  label: string,
): void {
  if (count > limit) fail(code, `${label} ${count} exceeds the conversion limit ${limit}.`, { actual: count, limit });
}

function assertType(
  field: ColumnarFieldV1,
  name: string,
  parameters: Readonly<Record<string, string | number | boolean>> | undefined,
  label: string,
): void {
  if (field.type.name !== name) fail("invalid-batch", `${label} must use type "${name}".`);
  const actual = field.type.parameters;
  const expectedEntries = Object.entries(parameters ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const actualEntries = Object.entries(actual ?? {}).sort(([left], [right]) => left.localeCompare(right));
  if (
    actualEntries.length !== expectedEntries.length ||
    actualEntries.some(
      ([key, value], index) => key !== expectedEntries[index]?.[0] || value !== expectedEntries[index]?.[1],
    )
  ) {
    fail("invalid-batch", `${label} type parameters do not match the normative GeoArrow layout.`, {
      expected: Object.fromEntries(expectedEntries),
      actual: Object.fromEntries(actualEntries),
    });
  }
}

function singleChild(field: ColumnarFieldV1, name: string, label: string): ColumnarFieldV1 {
  if (field.children?.length !== 1 || field.children[0]?.name !== name) {
    fail("invalid-batch", `${label} must contain exactly one child named "${name}".`);
  }
  return field.children[0];
}

function assertCoordinateSchema(
  coordinate: ColumnarFieldV1,
  dimensions: GeoArrowDimensions,
  layout: GeoArrowCoordinateLayout,
  label: string,
): void {
  const names = dimensionNames(dimensions);
  if (coordinate.nullable) fail("invalid-batch", `${label} coordinate storage must be non-nullable.`);
  if (layout === "interleaved") {
    if (coordinate.name !== names.join("")) fail("invalid-batch", `${label} has the wrong interleaved child name.`);
    assertType(coordinate, "fixed_size_list", { size: names.length, valueType: "float64" }, label);
    const values = singleChild(coordinate, "values", label);
    if (values.nullable || values.children !== undefined)
      fail("invalid-batch", `${label}.values must be a non-nullable leaf.`);
    assertType(values, "float64", undefined, `${label}.values`);
    return;
  }
  if (coordinate.name !== "coordinates")
    fail("invalid-batch", `${label} separated coordinates must be named "coordinates".`);
  assertType(coordinate, "struct", { dimensions }, label);
  if (coordinate.children?.length !== names.length)
    fail("invalid-batch", `${label} has the wrong coordinate child count.`);
  names.forEach((name, index) => {
    const child = coordinate.children?.[index];
    if (!child || child.name !== name || child.nullable || child.children !== undefined) {
      fail("invalid-batch", `${label}.${name} must be a non-nullable float64 leaf in dimension order.`);
    }
    assertType(child, "float64", undefined, `${label}.${name}`);
  });
}

function assertGeometrySchema(
  field: ColumnarFieldV1,
  kind: GeoArrowGeometryKind,
  dimensions: GeoArrowDimensions,
  layout: GeoArrowCoordinateLayout,
): void {
  assertType(
    field,
    `geoarrow.${kind}`,
    { dimensions, coordinateLayout: layout, offsetType: "int32" },
    `geometry field "${field.name}"`,
  );
  let coordinate: ColumnarFieldV1;
  if (kind === "point")
    coordinate = singleChild(
      field,
      layout === "interleaved" ? dimensionNames(dimensions).join("") : "coordinates",
      field.name,
    );
  else if (kind === "linestring") {
    const vertices = singleChild(field, "vertices", field.name);
    if (vertices.nullable) fail("invalid-batch", `${field.name}.vertices must be non-nullable.`);
    assertType(vertices, "list", { offsetType: "int32" }, `${field.name}.vertices`);
    coordinate = singleChild(
      vertices,
      layout === "interleaved" ? dimensionNames(dimensions).join("") : "coordinates",
      `${field.name}.vertices`,
    );
  } else {
    const rings = singleChild(field, "rings", field.name);
    if (rings.nullable) fail("invalid-batch", `${field.name}.rings must be non-nullable.`);
    assertType(rings, "list", { offsetType: "int32" }, `${field.name}.rings`);
    const vertices = singleChild(rings, "vertices", `${field.name}.rings`);
    if (vertices.nullable) fail("invalid-batch", `${field.name}.rings.vertices must be non-nullable.`);
    assertType(vertices, "list", { offsetType: "int32" }, `${field.name}.rings.vertices`);
    coordinate = singleChild(
      vertices,
      layout === "interleaved" ? dimensionNames(dimensions).join("") : "coordinates",
      `${field.name}.rings.vertices`,
    );
  }
  assertCoordinateSchema(coordinate, dimensions, layout, `${field.name} coordinate storage`);
}

function inspectGeometry(
  batch: ColumnarBatchV1,
  buffers: ReadonlyMap<string, ColumnarBufferV1>,
  limits: ResolvedLimits,
  scope: GeoArrowInspectionScope,
): GeoArrowGeometryBuffers {
  const metadata = batch.schema.metadata;
  const fieldName = requireMetadata(metadata, META.geometryField);
  const field = batch.schema.fields.find((candidate) => candidate.name === fieldName);
  if (!field) fail("invalid-batch", `GeoArrow geometry field "${fieldName}" does not exist.`);
  const kind = requireMetadata(metadata, META.geometryKind) as GeoArrowGeometryKind;
  if (!["point", "linestring", "polygon"].includes(kind))
    fail("unsupported-layout", `Unsupported geometry kind "${kind}".`);
  if (field.type.name !== `geoarrow.${kind}` || field.metadata?.["ARROW:extension:name"] !== `geoarrow.${kind}`) {
    fail("invalid-batch", `Geometry field "${fieldName}" does not carry the expected GeoArrow extension name.`);
  }
  const dimensions = requireMetadata(metadata, META.dimensions) as GeoArrowDimensions;
  const names = dimensionNames(dimensions);
  const coordinateLayout = requireMetadata(metadata, META.coordinateLayout) as GeoArrowCoordinateLayout;
  if (coordinateLayout !== "interleaved" && coordinateLayout !== "separated") {
    fail("unsupported-layout", `Unsupported coordinate layout "${coordinateLayout}".`);
  }
  assertGeometrySchema(field, kind, dimensions, coordinateLayout);
  const extension = parseExtensionMetadata(field, limits);
  const validity = optionalValidity(buffers, `${fieldName}.validity`, batch.rowCount);
  if (field.nullable !== (validity !== undefined)) {
    fail("invalid-batch", `Geometry field "${fieldName}" nullability must match its validity buffer.`);
  }
  let offsets: Int32Array | undefined;
  let ringOffsets: Int32Array | undefined;
  let vertices: number;
  if (kind === "point") vertices = batch.rowCount;
  else {
    offsets = offsetsView(requiredBuffer(buffers, `${fieldName}.offsets`), batch.rowCount + 1, "geometry offsets");
    if (kind === "polygon") {
      const rings = offsets[offsets.length - 1]!;
      assertCount(rings, limits.maxRings, "ring-limit-exceeded", "Ring count");
      ringOffsets = offsetsView(requiredBuffer(buffers, `${fieldName}.ring-offsets`), rings + 1, "ring offsets");
      vertices = ringOffsets[ringOffsets.length - 1]!;
    } else vertices = offsets[offsets.length - 1]!;
  }
  assertCount(vertices, limits.maxVertices, "vertex-limit-exceeded", "Vertex count");

  const coordinates: Record<"x" | "y" | "z" | "m" | "interleaved", Float64Array | undefined> = {
    x: undefined,
    y: undefined,
    z: undefined,
    m: undefined,
    interleaved: undefined,
  };
  if (coordinateLayout === "interleaved") {
    const view = typedView(requiredBuffer(buffers, `${fieldName}.coordinates`), Float64Array);
    if (view.length !== vertices * names.length)
      fail("invalid-batch", "Interleaved coordinate buffer length is inconsistent with geometry offsets.");
    coordinates.interleaved = view;
  } else {
    names.forEach((name) => {
      const view = typedView(requiredBuffer(buffers, `${fieldName}.${name}`), Float64Array);
      if (view.length !== vertices)
        fail("invalid-batch", `Coordinate buffer "${name}" length is inconsistent with geometry offsets.`);
      coordinates[name] = view;
    });
  }
  if (scope === "full") {
    if (kind === "point") {
      let allCoordinatesFinite = true;
      coordinateScan: for (const view of Object.values(coordinates)) {
        if (!view) continue;
        for (let index = 0; index < view.length; index += 1) {
          if (!Number.isFinite(view[index]!)) {
            allCoordinatesFinite = false;
            break coordinateScan;
          }
        }
      }
      if (!allCoordinatesFinite) {
        for (let row = 0; row < batch.rowCount; row += 1) {
          if (!isValid(validity, row)) continue;
          let allNaN = true;
          let allFinite = true;
          for (let dimension = 0; dimension < names.length; dimension += 1) {
            const coordinate =
              coordinateLayout === "interleaved"
                ? coordinates.interleaved![row * names.length + dimension]!
                : coordinates[names[dimension]!]![row]!;
            allNaN &&= Number.isNaN(coordinate);
            allFinite &&= Number.isFinite(coordinate);
          }
          if (!allNaN && !allFinite) {
            fail("invalid-batch", "Point coordinates must be finite, or all NaN for an empty Point.");
          }
        }
      }
    } else {
      for (const view of Object.values(coordinates)) {
        if (!view) continue;
        // Indexed rather than iterated. `for...of` over a typed array pays the
        // iterator protocol per element, and this is the only unbounded loop a
        // full inspection runs: it visits every coordinate of every column, on
        // every inspection, including the one each realtime patch application
        // performs (#941). Against a million-row batch the iterator form is the
        // dominant cost of applying a patch; the indexed form checks exactly the
        // same values.
        for (let index = 0; index < view.length; index += 1) {
          if (!Number.isFinite(view[index]!)) fail("invalid-batch", "Coordinate buffers must contain finite values.");
        }
      }
    }
  }
  return Object.freeze({
    kind,
    field: fieldName,
    dimensions,
    coordinateLayout,
    ...extension,
    ...(validity === undefined ? {} : { validity }),
    ...(offsets === undefined ? {} : { offsets }),
    ...(ringOffsets === undefined ? {} : { ringOffsets }),
    coordinates: Object.freeze(coordinates),
  });
}

function inspectTemporal(
  batch: ColumnarBatchV1,
  buffers: ReadonlyMap<string, ColumnarBufferV1>,
): GeoArrowTemporalBuffers | undefined {
  const field = batch.schema.metadata?.[META.temporalField];
  if (field === undefined) {
    if (
      batch.schema.metadata?.[META.temporalUnit] !== undefined ||
      batch.schema.metadata?.[META.temporalTimezone] !== undefined
    ) {
      fail("invalid-batch", "Timestamp unit/timezone metadata requires a declared timestamp field.");
    }
    return undefined;
  }
  const unit = requireMetadata(batch.schema.metadata, META.temporalUnit) as GeoArrowTimestampUnit;
  if (!["second", "millisecond", "microsecond", "nanosecond"].includes(unit)) {
    fail("unsupported-layout", `Unsupported timestamp unit "${unit}".`);
  }
  const values = typedView(requiredBuffer(buffers, `${field}.values`), BigInt64Array);
  if (values.length !== batch.rowCount) fail("invalid-batch", "Timestamp value buffer length must equal rowCount.");
  const validity = optionalValidity(buffers, `${field}.validity`, batch.rowCount);
  const schemaField = batch.schema.fields.find((candidate) => candidate.name === field);
  if (!schemaField) fail("invalid-batch", `Timestamp field "${field}" does not exist in the schema.`);
  const timezone = batch.schema.metadata?.[META.temporalTimezone];
  assertType(
    schemaField,
    "timestamp",
    { unit, ...(timezone === undefined ? {} : { timezone }) },
    `timestamp field "${field}"`,
  );
  if (schemaField.children !== undefined || schemaField.metadata !== undefined) {
    fail("invalid-batch", `Timestamp field "${field}" must be a metadata-free leaf.`);
  }
  if (schemaField.nullable !== (validity !== undefined)) {
    fail("invalid-batch", `Timestamp field "${field}" nullability must match its validity buffer.`);
  }
  return Object.freeze({
    field,
    unit,
    ...(timezone === undefined ? {} : { timezone }),
    ...(validity === undefined ? {} : { validity }),
    values,
  });
}

function inspectDictionary(
  batch: ColumnarBatchV1,
  buffers: ReadonlyMap<string, ColumnarBufferV1>,
  limits: ResolvedLimits,
  scope: GeoArrowInspectionScope,
): GeoArrowDictionaryBuffers | undefined {
  const field = batch.schema.metadata?.[META.dictionaryField];
  if (field === undefined) {
    if (batch.schema.metadata?.[META.dictionaryOrdered] !== undefined) {
      fail("invalid-batch", "Dictionary ordered metadata requires a declared dictionary field.");
    }
    return undefined;
  }
  const indices = typedView(requiredBuffer(buffers, `${field}.indices`), Int32Array);
  if (indices.length !== batch.rowCount) fail("invalid-batch", "Dictionary index buffer length must equal rowCount.");
  const offsetsDescriptor = requiredBuffer(buffers, `${field}.offsets`);
  const offsets = typedView(offsetsDescriptor, Int32Array);
  if (offsets.length === 0) fail("invalid-batch", "Dictionary offsets must contain at least one value.");
  if (offsets.length - 1 > limits.maxDictionaryValues) {
    fail(
      "dictionary-limit-exceeded",
      `Dictionary has ${offsets.length - 1} values; the limit is ${limits.maxDictionaryValues}.`,
    );
  }
  offsetsView(offsetsDescriptor, offsets.length, "dictionary offsets");
  const values = typedView(requiredBuffer(buffers, `${field}.values`), Uint8Array);
  if (offsets[offsets.length - 1] !== values.length)
    fail("invalid-batch", "Dictionary offsets do not span the UTF-8 value buffer.");
  const validity = optionalValidity(buffers, `${field}.validity`, batch.rowCount);
  const schemaField = batch.schema.fields.find((candidate) => candidate.name === field);
  if (!schemaField) fail("invalid-batch", `Dictionary field "${field}" does not exist in the schema.`);
  const orderedMetadata = batch.schema.metadata?.[META.dictionaryOrdered];
  if (orderedMetadata !== "true" && orderedMetadata !== "false") {
    fail("invalid-batch", `Dictionary field "${field}" must declare boolean ordered metadata.`);
  }
  const ordered = orderedMetadata === "true";
  assertType(
    schemaField,
    "dictionary",
    { indexType: "int32", valueType: "utf8", ordered },
    `dictionary field "${field}"`,
  );
  if (schemaField.children !== undefined || schemaField.metadata !== undefined) {
    fail("invalid-batch", `Dictionary field "${field}" must be a metadata-free leaf.`);
  }
  if (schemaField.nullable !== (validity !== undefined)) {
    fail("invalid-batch", `Dictionary field "${field}" nullability must match its validity buffer.`);
  }
  if (scope === "full") {
    for (let row = 0; row < batch.rowCount; row += 1) {
      if (isValid(validity, row) && (indices[row]! < 0 || indices[row]! >= offsets.length - 1)) {
        fail("invalid-batch", `Dictionary index at row ${row} is outside the dictionary.`);
      }
    }
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for (let index = 0; index < offsets.length - 1; index += 1) {
        decoder.decode(values.subarray(offsets[index], offsets[index + 1]));
      }
    } catch (cause) {
      fail("invalid-batch", "Dictionary value bytes are not valid UTF-8.", undefined, cause);
    }
  }
  return Object.freeze({
    field,
    ordered,
    ...(validity === undefined ? {} : { validity }),
    indices,
    offsets,
    values,
  });
}

function assertExactFields(
  batch: ColumnarBatchV1,
  geometry: GeoArrowGeometryBuffers,
  temporal: GeoArrowTemporalBuffers | undefined,
  dictionary: GeoArrowDictionaryBuffers | undefined,
  featureIds: GeoArrowBatchInspection["featureIds"],
): void {
  const expected = [geometry.field];
  if (temporal) expected.push(temporal.field);
  if (dictionary) expected.push(dictionary.field);
  if (featureIds) expected.push(featureIds.field);
  if (
    batch.schema.fields.length !== expected.length ||
    batch.schema.fields.some((field, index) => field.name !== expected[index])
  ) {
    fail(
      "invalid-batch",
      "Normative GeoArrow schema fields must appear exactly in geometry/temporal/dictionary/id order.",
      {
        expected,
        actual: batch.schema.fields.map(({ name }) => name),
      },
    );
  }
}

function assertExactBuffers(
  batch: ColumnarBatchV1,
  geometry: GeoArrowGeometryBuffers,
  temporal: GeoArrowTemporalBuffers | undefined,
  dictionary: GeoArrowDictionaryBuffers | undefined,
  featureIds: GeoArrowBatchInspection["featureIds"],
): void {
  const expected = new Map<string, { readonly role: ColumnarBufferV1["role"]; readonly field: string }>();
  const add = (id: string, role: ColumnarBufferV1["role"], field: string): void => {
    expected.set(id, { role, field });
  };
  if (geometry.validity) add(`${geometry.field}.validity`, "validity", geometry.field);
  if (geometry.kind !== "point") add(`${geometry.field}.offsets`, "offsets", geometry.field);
  if (geometry.kind === "polygon") add(`${geometry.field}.ring-offsets`, "offsets", geometry.field);
  if (geometry.coordinateLayout === "interleaved") add(`${geometry.field}.coordinates`, "geometry", geometry.field);
  else
    for (const name of dimensionNames(geometry.dimensions))
      add(`${geometry.field}.${name}`, "geometry", geometry.field);
  if (temporal) {
    if (temporal.validity) add(`${temporal.field}.validity`, "validity", temporal.field);
    add(`${temporal.field}.values`, "values", temporal.field);
  }
  if (dictionary) {
    if (dictionary.validity) add(`${dictionary.field}.validity`, "validity", dictionary.field);
    add(`${dictionary.field}.indices`, "dictionary", dictionary.field);
    add(`${dictionary.field}.offsets`, "offsets", dictionary.field);
    add(`${dictionary.field}.values`, "dictionary", dictionary.field);
  }
  if (featureIds) add(`${featureIds.field}.values`, "values", featureIds.field);
  if (batch.buffers.length !== expected.size) {
    fail("invalid-batch", "Normative GeoArrow batch contains missing or undeclared buffers.", {
      expected: [...expected.keys()],
      actual: batch.buffers.map(({ id }) => id),
    });
  }
  for (const buffer of batch.buffers) {
    const descriptor = expected.get(buffer.id);
    if (!descriptor || buffer.role !== descriptor.role || buffer.field !== descriptor.field) {
      fail("invalid-batch", `Buffer "${buffer.id}" does not match its normative role/field declaration.`, {
        bufferId: buffer.id,
        expected: descriptor,
        actual: { role: buffer.role, field: buffer.field },
      });
    }
  }
}

/** Validate the normative mapping and return zero-copy typed-array views. */
export function inspectGeoArrowBatch(
  batch: ColumnarBatchV1,
  limits: GeoArrowConversionLimits = {},
): GeoArrowBatchInspection {
  return inspectGeoArrowBatchScoped(batch, limits, "full");
}

/**
 * {@link inspectGeoArrowBatch} with an explicit payload-validation scope.
 *
 * Only bounded conversions inside this module pass `"window"`, and they must
 * validate coordinate finiteness, dictionary index range, and dictionary UTF-8
 * for every row they materialize. It is deliberately absent from the package
 * surface: an external consumer must not be able to skip payload validation.
 *
 * @internal
 */
export function inspectGeoArrowBatchScoped(
  batch: ColumnarBatchV1,
  limits: GeoArrowConversionLimits,
  scope: GeoArrowInspectionScope,
): GeoArrowBatchInspection {
  const resolved = resolveLimits(limits);
  let baseMetrics: ReturnType<typeof inspectColumnarBatch>;
  try {
    // Snapshot every descriptor and identity field before interpreting layout
    // metadata. Payload ArrayBuffers remain aliased by identity.
    batch = createColumnarBatch(batch, limits);
    baseMetrics = inspectColumnarBatch(batch, limits);
  } catch (cause) {
    fail("invalid-batch", "The GeoArrow batch does not satisfy the columnar transport contract.", undefined, cause);
  }
  if (batch.rowCount > resolved.maxRows) {
    fail("row-limit-exceeded", `Batch has ${batch.rowCount} rows; the conversion limit is ${resolved.maxRows}.`);
  }
  if (
    batch.schema.metadata?.[META.version] !== HONUA_GEOARROW_LAYOUT_VERSION ||
    batch.schema.metadata?.[META.specVersion] !== GEOARROW_SPEC_VERSION
  ) {
    fail(
      "unsupported-layout",
      `Batch must use Honua GeoArrow ${HONUA_GEOARROW_LAYOUT_VERSION} over GeoArrow ${GEOARROW_SPEC_VERSION}.`,
    );
  }
  if (!batch.identity)
    fail("invalid-batch", "A normative GeoArrow batch must carry cache/auth/order/freshness identity.");
  const buffers = bufferMap(batch);
  const geometry = inspectGeometry(batch, buffers, resolved, scope);
  const temporal = inspectTemporal(batch, buffers);
  const dictionary = inspectDictionary(batch, buffers, resolved, scope);
  const featureIdField = batch.schema.metadata?.[META.featureIdField];
  let featureIds: GeoArrowBatchInspection["featureIds"];
  if (featureIdField !== undefined) {
    const values = typedView(requiredBuffer(buffers, `${featureIdField}.values`), Uint32Array);
    if (values.length !== batch.rowCount) fail("invalid-batch", "Feature id buffer length must equal rowCount.");
    const schemaField = batch.schema.fields.find((candidate) => candidate.name === featureIdField);
    if (!schemaField) fail("invalid-batch", `Feature id field "${featureIdField}" does not exist in the schema.`);
    assertType(schemaField, "uint32", undefined, `feature id field "${featureIdField}"`);
    if (schemaField.nullable || schemaField.children !== undefined || schemaField.metadata !== undefined) {
      fail("invalid-batch", `Feature id field "${featureIdField}" must be a non-nullable scalar.`);
    }
    featureIds = Object.freeze({ field: featureIdField, values });
  }
  assertExactFields(batch, geometry, temporal, dictionary, featureIds);
  assertExactBuffers(batch, geometry, temporal, dictionary, featureIds);
  const vertices =
    geometry.kind === "point"
      ? batch.rowCount
      : geometry.kind === "polygon"
        ? geometry.ringOffsets![geometry.ringOffsets!.length - 1]!
        : geometry.offsets![geometry.offsets!.length - 1]!;
  const rings = geometry.kind === "polygon" ? geometry.offsets![geometry.offsets!.length - 1]! : 0;
  return Object.freeze({
    batch,
    geometry,
    ...(temporal === undefined ? {} : { temporal }),
    ...(dictionary === undefined ? {} : { dictionary }),
    ...(featureIds === undefined ? {} : { featureIds }),
    metrics: Object.freeze({
      rows: batch.rowCount,
      vertices,
      rings,
      dictionaryValues: dictionary ? dictionary.offsets.length - 1 : 0,
      copiedBytes: 0,
      backingBytes: baseMetrics.backingBytes,
    }),
  });
}

function isValid(validity: Uint8Array | undefined, index: number): boolean {
  return validity === undefined || (validity[index >> 3]! & (1 << (index & 7))) !== 0;
}

/**
 * Row-level primitives shared with the bounded object-`Result` conversion.
 * They are module exports rather than package exports: `columnar/index.ts`
 * deliberately does not re-export them.
 *
 * @internal
 */
export { decodeGeometry as decodeGeoArrowGeometryAt, isValid as isGeoArrowRowValid };

function positionAt(geometry: GeoArrowGeometryBuffers, vertex: number): GeoArrowPosition {
  const names = dimensionNames(geometry.dimensions);
  if (geometry.coordinateLayout === "interleaved") {
    const values = geometry.coordinates.interleaved!;
    return Object.freeze(names.map((_, dimension) => values[vertex * names.length + dimension]!));
  }
  return Object.freeze(names.map((name) => geometry.coordinates[name]![vertex]!));
}

function decodeGeometry(geometry: GeoArrowGeometryBuffers, row: number): DecodedGeoArrowRow["geometry"] {
  if (!isValid(geometry.validity, row)) return null;
  if (geometry.kind === "point") return positionAt(geometry, row);
  const start = geometry.offsets![row]!;
  const end = geometry.offsets![row + 1]!;
  if (geometry.kind === "linestring") {
    const line: GeoArrowPosition[] = [];
    for (let vertex = start; vertex < end; vertex += 1) line.push(positionAt(geometry, vertex));
    return Object.freeze(line);
  }
  const polygon: GeoArrowLineString[] = [];
  for (let ring = start; ring < end; ring += 1) {
    const ringPositions: GeoArrowPosition[] = [];
    for (let vertex = geometry.ringOffsets![ring]!; vertex < geometry.ringOffsets![ring + 1]!; vertex += 1) {
      ringPositions.push(positionAt(geometry, vertex));
    }
    polygon.push(Object.freeze(ringPositions));
  }
  return Object.freeze(polygon);
}

function decodeDictionary(dictionary: GeoArrowDictionaryBuffers): readonly string[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const values: string[] = [];
  for (let index = 0; index < dictionary.offsets.length - 1; index += 1) {
    values.push(decoder.decode(dictionary.values.subarray(dictionary.offsets[index], dictionary.offsets[index + 1])));
  }
  return Object.freeze(values);
}

/**
 * Explicitly materialize bounded semantic rows. Callers cannot accidentally
 * decode an unbounded result because the same finite row/vertex/ring limits are
 * mandatory and defaulted before any row object is created.
 */
export function decodeGeoArrowBatch(
  batch: ColumnarBatchV1,
  limits: GeoArrowConversionLimits = {},
): DecodedGeoArrowBatch {
  const inspection = inspectGeoArrowBatch(batch, limits);
  const dictionaryValues = inspection.dictionary ? decodeDictionary(inspection.dictionary) : undefined;
  const rows: DecodedGeoArrowRow[] = [];
  for (let row = 0; row < batch.rowCount; row += 1) {
    const timestamp = inspection.temporal
      ? isValid(inspection.temporal.validity, row)
        ? inspection.temporal.values[row]!
        : null
      : undefined;
    const dictionaryValue = inspection.dictionary
      ? isValid(inspection.dictionary.validity, row)
        ? dictionaryValues![inspection.dictionary.indices[row]!]!
        : null
      : undefined;
    rows.push(
      Object.freeze({
        geometry: decodeGeometry(inspection.geometry, row),
        ...(timestamp === undefined ? {} : { timestamp }),
        ...(dictionaryValue === undefined ? {} : { dictionaryValue }),
        ...(inspection.featureIds === undefined ? {} : { featureId: inspection.featureIds.values[row]! }),
      }),
    );
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    metrics: Object.freeze({
      rows: inspection.metrics.rows,
      vertices: inspection.metrics.vertices,
      rings: inspection.metrics.rings,
      dictionaryValues: inspection.metrics.dictionaryValues,
      materializedRows: rows.length,
    }),
  });
}
