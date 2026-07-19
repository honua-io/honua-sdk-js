/**
 * Bind a Honua columnar batch directly to deck.gl GPU-binary attributes.
 *
 * This is the renderer seam that consumes {@link ColumnarBatchV1} batches
 * **without** a GeoJSON round-trip: every deck.gl binary attribute is a
 * typed-array *view* aliasing a batch backing `ArrayBuffer`, so no per-feature
 * JavaScript object, GeoJSON `Feature`, or coordinate array is ever
 * materialized. The resulting {@link DeckGlProjectionRequest} is handed to a
 * {@link DeckGlAdapter} (`createDeckGlAdapter(...).project(...)`), whose metrics
 * report `copiedBytes: 0` because the SDK forwards the batch's own buffers.
 *
 * @experimental
 * @packageDocumentation
 */

import { inspectGeoArrowBatch } from "../columnar/geoarrow.js";
import type { ColumnarBatchV1, ColumnarBufferV1 } from "../columnar/types.js";
import { COLUMNAR_BATCH_KIND, COLUMNAR_BATCH_VERSION } from "../columnar/types.js";
import type {
  DeckGlBinaryAttribute,
  DeckGlLayerKind,
  DeckGlProjectionRequest,
  DeckGlSelectionIdentity,
} from "./types.js";
import { HonuaDeckGlAdapterError } from "./types.js";

/**
 * Numeric component type of a columnar buffer, mapped to the matching
 * typed-array view. Names mirror the deck.gl adapter's supported component set.
 */
export type ColumnarComponentType =
  | "int8"
  | "uint8"
  | "uint8-clamped"
  | "int16"
  | "uint16"
  | "float16"
  | "int32"
  | "uint32"
  | "float32"
  | "float64";

interface TypedArrayCtor {
  new (buffer: ArrayBufferLike, byteOffset: number, length: number): Exclude<ArrayBufferView, DataView>;
  readonly BYTES_PER_ELEMENT: number;
}

/**
 * Bind one columnar buffer to a named deck.gl binary accessor
 * (for example `getPosition`, `getFillColor`, `getRadius`).
 */
export interface ColumnarDeckGlAttributeBinding {
  /** deck.gl binary accessor name, for example `getPosition`. */
  readonly accessor: string;
  /** `id` of the {@link ColumnarBufferV1} in the batch that backs this attribute. */
  readonly bufferId: string;
  /** Numeric component type of the buffer's elements. */
  readonly component: ColumnarComponentType;
  /** Components per vertex (deck.gl attribute size). */
  readonly size: 1 | 2 | 3 | 4;
  /** Byte offset into the buffer view where addressing begins. Defaults to 0. */
  readonly offset?: number;
  /** Byte stride between consecutive rows. Defaults to `size * componentBytes`. */
  readonly stride?: number;
  /** deck.gl `normalized` flag forwarded verbatim. */
  readonly normalized?: boolean;
}

/**
 * Identity for picking. Feature ids come from a columnar buffer (zero-copy) or,
 * when omitted, are the row indices `0..rowCount`.
 */
export interface ColumnarDeckGlIdentity {
  readonly sourceId: string;
  readonly planId: string;
  readonly sourceVersion?: string;
  /**
   * Bind a scalar id column as the picking identity. When omitted, sequential
   * row indices are used so picking still resolves a stable row.
   */
  readonly featureIdColumn?: {
    readonly bufferId: string;
    readonly component: Exclude<ColumnarComponentType, "float16">;
  };
}

/** Binds a request-level `data.startIndices` boundary array for `"feature-path"`/`"feature-polygon"` projections. */
export interface ColumnarDeckGlStartIndicesBinding {
  /** `id` of the {@link ColumnarBufferV1} carrying vertex-index boundaries, length `featureCount + 1`. */
  readonly bufferId: string;
  readonly component: "int32" | "uint32";
}

/** Request to bind a columnar batch to a deck.gl projection. */
export interface ColumnarDeckGlProjectionRequest {
  readonly batch: ColumnarBatchV1;
  /** Only `scatterplot`, `feature-path`, and `feature-polygon` are supported by adapter contract v1.0. Defaults to `scatterplot`. */
  readonly layer?: DeckGlLayerKind;
  readonly layerId: string;
  readonly attributes: readonly ColumnarDeckGlAttributeBinding[];
  /**
   * Total addressed vertex count backing the geometry attribute
   * (`getPosition`/`getPath`/`getPolygon`). Defaults to `batch.rowCount`
   * (correct for one-vertex-per-row layers like `scatterplot`). Required to
   * differ from `batch.rowCount` for `"feature-path"`/`"feature-polygon"`,
   * where `batch.rowCount` counts geometries, not vertices.
   */
  readonly vertexCount?: number;
  /** Required for `"feature-path"`/`"feature-polygon"`; forbidden otherwise. */
  readonly startIndices?: ColumnarDeckGlStartIndicesBinding;
  readonly identity: ColumnarDeckGlIdentity;
  /** Forwarded to the deck.gl constructor. `id`, `data`, and `pickable` are reserved. */
  readonly props?: Readonly<Record<string, unknown>>;
}

/** Normative GeoArrow Point batch request for the direct scatterplot path. */
export interface GeoArrowPointDeckGlProjectionRequest {
  readonly batch: ColumnarBatchV1;
  readonly layerId: string;
  readonly props?: Readonly<Record<string, unknown>>;
}

export interface GeoArrowPointDeckGlBindingMetrics {
  readonly rows: number;
  readonly positionBytes: number;
  readonly copiedBytes: 0;
  readonly geoJsonFeaturesMaterialized: 0;
}

/** Direct request plus measured proof that the SDK retained the GeoArrow buffer. */
export interface GeoArrowPointDeckGlBinding {
  readonly request: DeckGlProjectionRequest;
  readonly metrics: GeoArrowPointDeckGlBindingMetrics;
}

function componentInfo(component: ColumnarComponentType): TypedArrayCtor {
  switch (component) {
    case "int8":
      return Int8Array as unknown as TypedArrayCtor;
    case "uint8":
      return Uint8Array as unknown as TypedArrayCtor;
    case "uint8-clamped":
      return Uint8ClampedArray as unknown as TypedArrayCtor;
    case "int16":
      return Int16Array as unknown as TypedArrayCtor;
    case "uint16":
      return Uint16Array as unknown as TypedArrayCtor;
    case "float16": {
      const ctor = (globalThis as { Float16Array?: TypedArrayCtor }).Float16Array;
      if (!ctor) {
        throw new HonuaDeckGlAdapterError(
          "invalid-data",
          'Component "float16" is not supported by this JavaScript runtime.',
          { component },
        );
      }
      return ctor;
    }
    case "int32":
      return Int32Array as unknown as TypedArrayCtor;
    case "uint32":
      return Uint32Array as unknown as TypedArrayCtor;
    case "float32":
      return Float32Array as unknown as TypedArrayCtor;
    case "float64":
      return Float64Array as unknown as TypedArrayCtor;
    default:
      throw new HonuaDeckGlAdapterError("invalid-data", `Unsupported columnar component "${String(component)}".`, {
        component,
      });
  }
}

function assertColumnarBatch(batch: ColumnarBatchV1): void {
  if (
    typeof batch !== "object" ||
    batch === null ||
    batch.kind !== COLUMNAR_BATCH_KIND ||
    batch.version !== COLUMNAR_BATCH_VERSION
  ) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      `Columnar deck.gl binding requires a ${COLUMNAR_BATCH_KIND}@${COLUMNAR_BATCH_VERSION} batch.`,
    );
  }
}

function bufferIndex(batch: ColumnarBatchV1): ReadonlyMap<string, ColumnarBufferV1> {
  const index = new Map<string, ColumnarBufferV1>();
  for (const buffer of batch.buffers) index.set(buffer.id, buffer);
  return index;
}

function requireBuffer(
  buffers: ReadonlyMap<string, ColumnarBufferV1>,
  bufferId: string,
  label: string,
): ColumnarBufferV1 {
  const buffer = buffers.get(bufferId);
  if (!buffer) {
    throw new HonuaDeckGlAdapterError("invalid-data", `${label} references unknown buffer id "${bufferId}".`, {
      bufferId,
    });
  }
  return buffer;
}

/**
 * Create a typed-array view aliasing the columnar buffer's slice. The returned
 * view's `.buffer` is the batch's own `ArrayBuffer` — no payload bytes are
 * copied. Throws on component misalignment rather than letting the typed-array
 * constructor surface an opaque `RangeError`.
 */
function viewBuffer(buffer: ColumnarBufferV1, ctor: TypedArrayCtor, label: string): Exclude<ArrayBufferView, DataView> {
  const bytes = ctor.BYTES_PER_ELEMENT;
  if (buffer.byteOffset % bytes !== 0) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      `${label} buffer byteOffset ${buffer.byteOffset} is not aligned to its ${bytes}-byte component.`,
      { bufferId: buffer.id, byteOffset: buffer.byteOffset, componentBytes: bytes },
    );
  }
  if (buffer.byteLength % bytes !== 0) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      `${label} buffer byteLength ${buffer.byteLength} is not a multiple of its ${bytes}-byte component.`,
      { bufferId: buffer.id, byteLength: buffer.byteLength, componentBytes: bytes },
    );
  }
  try {
    return new ctor(buffer.data, buffer.byteOffset, buffer.byteLength / bytes);
  } catch (cause) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      `${label} buffer view could not be created over its backing allocation.`,
      { bufferId: buffer.id },
      { cause },
    );
  }
}

/**
 * Bind a columnar batch to a {@link DeckGlProjectionRequest} whose binary
 * attributes alias the batch's backing buffers with **zero payload copies** and
 * **no GeoJSON conversion**. Pass the result to
 * `createDeckGlAdapter(...).project(...)`.
 */
export function bindColumnarBatchToDeckGl(request: ColumnarDeckGlProjectionRequest): DeckGlProjectionRequest {
  if (typeof request !== "object" || request === null) {
    throw new HonuaDeckGlAdapterError("invalid-data", "Columnar deck.gl binding request must be an object.");
  }
  const { batch } = request;
  assertColumnarBatch(batch);
  if (!Array.isArray(request.attributes) || request.attributes.length === 0) {
    throw new HonuaDeckGlAdapterError("invalid-data", "At least one columnar attribute binding is required.");
  }
  const buffers = bufferIndex(batch);
  const rowCount = batch.rowCount;
  const vertexCount = request.vertexCount ?? rowCount;
  if (!Number.isSafeInteger(vertexCount) || vertexCount < 0) {
    throw new HonuaDeckGlAdapterError("invalid-data", "vertexCount must be a non-negative safe integer.", {
      vertexCount,
    });
  }
  const layer = request.layer ?? "scatterplot";
  const usesStartIndices = layer === "feature-path" || layer === "feature-polygon";
  if (usesStartIndices && request.startIndices === undefined) {
    throw new HonuaDeckGlAdapterError("invalid-data", `Layer "${layer}" requires a startIndices buffer binding.`, {
      layer,
    });
  }
  if (!usesStartIndices && request.startIndices !== undefined) {
    throw new HonuaDeckGlAdapterError("invalid-data", `Layer "${layer}" does not accept a startIndices binding.`, {
      layer,
    });
  }
  let startIndices: ArrayLike<number> | undefined;
  if (request.startIndices !== undefined) {
    const ctor = componentInfo(request.startIndices.component);
    const buffer = requireBuffer(buffers, request.startIndices.bufferId, "startIndices");
    startIndices = viewBuffer(buffer, ctor, "startIndices") as unknown as ArrayLike<number>;
  }

  const attributes: Record<string, DeckGlBinaryAttribute> = Object.create(null) as Record<
    string,
    DeckGlBinaryAttribute
  >;
  const seenAccessors = new Set<string>();
  for (const binding of request.attributes) {
    if (typeof binding !== "object" || binding === null) {
      throw new HonuaDeckGlAdapterError("invalid-data", "Each attribute binding must be an object.");
    }
    if (typeof binding.accessor !== "string" || binding.accessor.length === 0) {
      throw new HonuaDeckGlAdapterError("invalid-data", "Attribute binding accessor must be a non-empty string.");
    }
    if (seenAccessors.has(binding.accessor)) {
      throw new HonuaDeckGlAdapterError("invalid-data", `Duplicate attribute binding for "${binding.accessor}".`, {
        accessor: binding.accessor,
      });
    }
    seenAccessors.add(binding.accessor);
    const label = `attribute "${binding.accessor}"`;
    const buffer = requireBuffer(buffers, binding.bufferId, label);
    const ctor = componentInfo(binding.component);
    const value = viewBuffer(buffer, ctor, label);
    attributes[binding.accessor] = Object.freeze({
      value,
      size: binding.size,
      ...(binding.offset === undefined ? {} : { offset: binding.offset }),
      ...(binding.stride === undefined ? {} : { stride: binding.stride }),
      ...(binding.normalized === undefined ? {} : { normalized: binding.normalized }),
    });
  }

  const featureIds = resolveFeatureIds(request.identity, buffers, rowCount);
  const identity: DeckGlSelectionIdentity = Object.freeze({
    sourceId: request.identity.sourceId,
    planId: request.identity.planId,
    ...(request.identity.sourceVersion === undefined ? {} : { sourceVersion: request.identity.sourceVersion }),
    featureIds,
  });

  return Object.freeze({
    layer,
    layerId: request.layerId,
    data: Object.freeze({
      length: vertexCount,
      attributes: Object.freeze(attributes),
      ...(startIndices === undefined ? {} : { startIndices }),
    }),
    identity,
    ...(request.props === undefined ? {} : { props: request.props }),
  });
}

/**
 * Bind a normative, non-null interleaved GeoArrow Point batch directly to a
 * deck.gl ScatterplotLayer request. The geometry buffer becomes getPosition by
 * identity; no GeoJSON feature or coordinate object is created.
 *
 * Separated coordinates, M dimensions, and nullable points require a bounded
 * gather/filter operation and therefore fail explicitly in this zero-copy v1
 * path instead of silently copying or rendering nulls at an invented location.
 */
export function bindGeoArrowPointBatchToDeckGl(
  input: GeoArrowPointDeckGlProjectionRequest,
): GeoArrowPointDeckGlBinding {
  if (typeof input !== "object" || input === null) {
    throw new HonuaDeckGlAdapterError("invalid-data", "GeoArrow deck.gl binding request must be an object.");
  }
  let inspection: ReturnType<typeof inspectGeoArrowBatch>;
  try {
    inspection = inspectGeoArrowBatch(input.batch);
  } catch (cause) {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as { code: unknown }).code)
        : undefined;
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct deck.gl binding requires an exactly validated normative GeoArrow batch.",
      { ...(code === undefined ? {} : { geoArrowCode: code }) },
      { cause },
    );
  }
  const batch = inspection.batch;
  const metadata = batch.schema.metadata;
  if (
    metadata?.["honua.geoarrow.layout.version"] !== "1.0" ||
    metadata["honua.geoarrow.spec.version"] !== "0.2" ||
    metadata["honua.geoarrow.geometry.kind"] !== "point"
  ) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct deck.gl binding requires a normative Honua GeoArrow 1.0 Point batch.",
      { expectedLayout: "honua-geoarrow@1.0", expectedGeometry: "point" },
    );
  }
  if (metadata["honua.geoarrow.geometry.coordinate-layout"] !== "interleaved") {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct deck.gl Point binding requires interleaved coordinates; separated coordinates need an explicit bounded conversion.",
      { coordinateLayout: metadata["honua.geoarrow.geometry.coordinate-layout"], copiedBytes: 0 },
    );
  }
  const dimensions = metadata["honua.geoarrow.geometry.dimensions"];
  if (dimensions !== "xy" && dimensions !== "xyz") {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct deck.gl Point binding supports XY or XYZ coordinates; M dimensions need an explicit mapping.",
      { dimensions },
    );
  }
  if (inspection.geometry.crs !== "OGC:CRS84") {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      'Direct deck.gl Point binding requires explicit longitude/latitude axis evidence via CRS "OGC:CRS84".',
      { crs: inspection.geometry.crs ?? null },
    );
  }
  const size = dimensions === "xy" ? 2 : 3;
  const geometryField = metadata["honua.geoarrow.geometry.field"];
  const schemaField = batch.schema.fields.find((field) => field.name === geometryField);
  if (
    !schemaField ||
    schemaField.nullable ||
    schemaField.type.name !== "geoarrow.point" ||
    schemaField.type.parameters?.dimensions !== dimensions ||
    schemaField.type.parameters?.coordinateLayout !== "interleaved" ||
    schemaField.metadata?.["ARROW:extension:name"] !== "geoarrow.point"
  ) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "GeoArrow Point schema does not match its direct rendering layout.",
      {
        geometryField,
      },
    );
  }
  const positionId = `${geometryField}.coordinates`;
  const position = batch.buffers.find((buffer) => buffer.id === positionId);
  if (
    !position ||
    position.field !== geometryField ||
    position.role !== "geometry" ||
    position.byteLength !== batch.rowCount * size * Float64Array.BYTES_PER_ELEMENT
  ) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "GeoArrow Point coordinate buffer is missing or has the wrong extent.",
      {
        bufferId: positionId,
      },
    );
  }
  if (inspection.geometry.validity !== undefined) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Nullable GeoArrow points need an explicit bounded filter before direct deck.gl rendering.",
      { bufferId: `${geometryField}.validity`, copiedBytes: 0 },
    );
  }
  const identity = requireGeoArrowBatchIdentity(batch, "Point");
  const featureIdColumn = resolveGeoArrowFeatureIdColumn(batch, metadata);

  const request = bindColumnarBatchToDeckGl({
    batch,
    layerId: input.layerId,
    attributes: [{ accessor: "getPosition", bufferId: positionId, component: "float64", size }],
    identity: {
      sourceId: identity.sourceId,
      planId: identity.planId,
      sourceVersion: identity.sourceVersion,
      ...(featureIdColumn === undefined ? {} : { featureIdColumn }),
    },
    ...(input.props === undefined ? {} : { props: input.props }),
  });
  const positionView = request.data.attributes.getPosition.value;
  if (positionView.buffer !== position.data) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct GeoArrow position binding unexpectedly copied its payload.",
    );
  }
  return Object.freeze({
    request,
    metrics: Object.freeze({
      rows: batch.rowCount,
      positionBytes: position.byteLength,
      copiedBytes: 0,
      geoJsonFeaturesMaterialized: 0,
    }),
  });
}

function requireGeoArrowBatchIdentity(
  batch: ColumnarBatchV1,
  geometryLabel: string,
): { readonly sourceId: string; readonly planId: string; readonly sourceVersion: string | undefined } {
  const identity = batch.identity;
  if (
    !identity ||
    identity.schemaVersion !== batch.schema.id ||
    typeof identity.sourceId !== "string" ||
    identity.sourceId.length === 0 ||
    typeof identity.planId !== "string" ||
    identity.planId.length === 0
  ) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      `GeoArrow ${geometryLabel} batch identity is missing or inconsistent.`,
    );
  }
  return { sourceId: identity.sourceId, planId: identity.planId, sourceVersion: identity.sourceVersion };
}

function resolveGeoArrowFeatureIdColumn(
  batch: ColumnarBatchV1,
  metadata: Readonly<Record<string, string>> | undefined,
): { readonly bufferId: string; readonly component: "uint32" } | undefined {
  const featureIdField = metadata?.["honua.geoarrow.feature-id.field"];
  if (featureIdField === undefined) return undefined;
  const id = `${featureIdField}.values`;
  const buffer = batch.buffers.find((candidate) => candidate.id === id);
  if (
    !buffer ||
    buffer.role !== "values" ||
    buffer.field !== featureIdField ||
    buffer.byteLength !== batch.rowCount * Uint32Array.BYTES_PER_ELEMENT
  ) {
    throw new HonuaDeckGlAdapterError("invalid-data", "GeoArrow feature id buffer is missing or malformed.", {
      bufferId: id,
    });
  }
  return { bufferId: id, component: "uint32" as const };
}

/** Normative GeoArrow LineString batch request for the direct PathLayer path. */
export interface GeoArrowLineDeckGlProjectionRequest {
  readonly batch: ColumnarBatchV1;
  readonly layerId: string;
  readonly props?: Readonly<Record<string, unknown>>;
}

export interface GeoArrowLineDeckGlBindingMetrics {
  /** Number of LineString features (deck.gl paths). */
  readonly rows: number;
  /** Total vertex count across every path. */
  readonly vertices: number;
  readonly positionBytes: number;
  readonly copiedBytes: 0;
  readonly geoJsonFeaturesMaterialized: 0;
}

/** Direct request plus measured proof that the SDK retained the GeoArrow buffers. */
export interface GeoArrowLineDeckGlBinding {
  readonly request: DeckGlProjectionRequest;
  readonly metrics: GeoArrowLineDeckGlBindingMetrics;
}

/**
 * Bind a normative, non-null interleaved GeoArrow LineString batch directly
 * to a deck.gl `PathLayer` request. The geometry coordinate buffer becomes
 * `getPath` and the row-offsets buffer becomes `data.startIndices` by
 * identity; no GeoJSON feature, coordinate array, or path object is created.
 * Every path is rendered `_pathType: "open"` since OGC LineStrings are never
 * implicitly closed loops.
 *
 * Separated coordinates, M dimensions, and nullable lines require a bounded
 * gather/filter operation and therefore fail explicitly in this zero-copy v1
 * path instead of silently copying or rendering nulls at an invented
 * location.
 */
export function bindGeoArrowLineBatchToDeckGl(input: GeoArrowLineDeckGlProjectionRequest): GeoArrowLineDeckGlBinding {
  if (typeof input !== "object" || input === null) {
    throw new HonuaDeckGlAdapterError("invalid-data", "GeoArrow deck.gl binding request must be an object.");
  }
  let inspection: ReturnType<typeof inspectGeoArrowBatch>;
  try {
    inspection = inspectGeoArrowBatch(input.batch);
  } catch (cause) {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as { code: unknown }).code)
        : undefined;
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct deck.gl binding requires an exactly validated normative GeoArrow batch.",
      { ...(code === undefined ? {} : { geoArrowCode: code }) },
      { cause },
    );
  }
  const batch = inspection.batch;
  const metadata = batch.schema.metadata;
  if (
    metadata?.["honua.geoarrow.layout.version"] !== "1.0" ||
    metadata["honua.geoarrow.spec.version"] !== "0.2" ||
    metadata["honua.geoarrow.geometry.kind"] !== "linestring"
  ) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct deck.gl binding requires a normative Honua GeoArrow 1.0 LineString batch.",
      { expectedLayout: "honua-geoarrow@1.0", expectedGeometry: "linestring" },
    );
  }
  if (metadata["honua.geoarrow.geometry.coordinate-layout"] !== "interleaved") {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct deck.gl Path binding requires interleaved coordinates; separated coordinates need an explicit bounded conversion.",
      { coordinateLayout: metadata["honua.geoarrow.geometry.coordinate-layout"], copiedBytes: 0 },
    );
  }
  const dimensions = metadata["honua.geoarrow.geometry.dimensions"];
  if (dimensions !== "xy" && dimensions !== "xyz") {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct deck.gl Path binding supports XY or XYZ coordinates; M dimensions need an explicit mapping.",
      { dimensions },
    );
  }
  if (inspection.geometry.crs !== "OGC:CRS84") {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      'Direct deck.gl Path binding requires explicit longitude/latitude axis evidence via CRS "OGC:CRS84".',
      { crs: inspection.geometry.crs ?? null },
    );
  }
  const size = dimensions === "xy" ? 2 : 3;
  const geometryField = metadata["honua.geoarrow.geometry.field"];
  const schemaField = batch.schema.fields.find((field) => field.name === geometryField);
  if (
    !schemaField ||
    schemaField.nullable ||
    schemaField.type.name !== "geoarrow.linestring" ||
    schemaField.type.parameters?.dimensions !== dimensions ||
    schemaField.type.parameters?.coordinateLayout !== "interleaved" ||
    schemaField.metadata?.["ARROW:extension:name"] !== "geoarrow.linestring"
  ) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "GeoArrow LineString schema does not match its direct rendering layout.",
      { geometryField },
    );
  }
  if (inspection.geometry.validity !== undefined) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Nullable GeoArrow lines need an explicit bounded filter before direct deck.gl rendering.",
      { bufferId: `${geometryField}.validity`, copiedBytes: 0 },
    );
  }
  const offsets = inspection.geometry.offsets;
  if (!offsets || offsets.length !== batch.rowCount + 1) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "GeoArrow LineString offsets buffer is missing or has the wrong extent.",
      { bufferId: `${geometryField}.offsets` },
    );
  }
  const vertices = offsets[offsets.length - 1]!;
  const offsetsId = `${geometryField}.offsets`;
  const offsetsBuffer = batch.buffers.find((buffer) => buffer.id === offsetsId);
  if (!offsetsBuffer || offsetsBuffer.field !== geometryField || offsetsBuffer.role !== "offsets") {
    throw new HonuaDeckGlAdapterError("invalid-data", "GeoArrow LineString offsets buffer is missing or malformed.", {
      bufferId: offsetsId,
    });
  }
  const positionId = `${geometryField}.coordinates`;
  const position = batch.buffers.find((buffer) => buffer.id === positionId);
  if (
    !position ||
    position.field !== geometryField ||
    position.role !== "geometry" ||
    position.byteLength !== vertices * size * Float64Array.BYTES_PER_ELEMENT
  ) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "GeoArrow LineString coordinate buffer is missing or has the wrong extent.",
      { bufferId: positionId },
    );
  }

  const identity = requireGeoArrowBatchIdentity(batch, "LineString");
  const featureIdColumn = resolveGeoArrowFeatureIdColumn(batch, metadata);

  const request = bindColumnarBatchToDeckGl({
    batch,
    layer: "feature-path",
    layerId: input.layerId,
    vertexCount: vertices,
    attributes: [{ accessor: "getPath", bufferId: positionId, component: "float64", size }],
    startIndices: { bufferId: offsetsId, component: "int32" },
    identity: {
      sourceId: identity.sourceId,
      planId: identity.planId,
      sourceVersion: identity.sourceVersion,
      ...(featureIdColumn === undefined ? {} : { featureIdColumn }),
    },
    ...(input.props === undefined ? {} : { props: input.props }),
  });
  const pathView = request.data.attributes.getPath.value;
  if (pathView.buffer !== position.data) {
    throw new HonuaDeckGlAdapterError("invalid-data", "Direct GeoArrow path binding unexpectedly copied its payload.");
  }
  const startIndicesView = request.data.startIndices as unknown as Int32Array | undefined;
  if (startIndicesView === undefined || startIndicesView.buffer !== offsetsBuffer.data) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct GeoArrow path binding unexpectedly copied its startIndices payload.",
    );
  }
  return Object.freeze({
    request,
    metrics: Object.freeze({
      rows: batch.rowCount,
      vertices,
      positionBytes: position.byteLength,
      copiedBytes: 0,
      geoJsonFeaturesMaterialized: 0,
    }),
  });
}

/** Normative GeoArrow Polygon batch request for the direct SolidPolygonLayer path. */
export interface GeoArrowPolygonDeckGlProjectionRequest {
  readonly batch: ColumnarBatchV1;
  readonly layerId: string;
  readonly props?: Readonly<Record<string, unknown>>;
}

export interface GeoArrowPolygonDeckGlBindingMetrics {
  /** Number of Polygon features. */
  readonly rows: number;
  /** Total vertex count across every polygon's single exterior ring. */
  readonly vertices: number;
  readonly positionBytes: number;
  readonly copiedBytes: 0;
  readonly geoJsonFeaturesMaterialized: 0;
}

/** Direct request plus measured proof that the SDK retained the GeoArrow buffers. */
export interface GeoArrowPolygonDeckGlBinding {
  readonly request: DeckGlProjectionRequest;
  readonly metrics: GeoArrowPolygonDeckGlBindingMetrics;
}

/**
 * Bind a normative, non-null, hole-free, interleaved GeoArrow Polygon batch
 * directly to a deck.gl `SolidPolygonLayer` request. The geometry coordinate
 * buffer becomes `getPolygon` and the ring-offsets buffer becomes
 * `data.startIndices` by identity; no GeoJSON feature, coordinate array, or
 * triangulation input array is materialized by the SDK.
 *
 * Separated coordinates, M dimensions, nullable polygons, empty polygons, and
 * polygons with holes require a bounded gather/filter/retriangulation
 * operation and therefore fail explicitly in this zero-copy v1 path instead
 * of silently copying, dropping holes, or rendering nulls at an invented
 * location.
 */
export function bindGeoArrowPolygonBatchToDeckGl(
  input: GeoArrowPolygonDeckGlProjectionRequest,
): GeoArrowPolygonDeckGlBinding {
  if (typeof input !== "object" || input === null) {
    throw new HonuaDeckGlAdapterError("invalid-data", "GeoArrow deck.gl binding request must be an object.");
  }
  let inspection: ReturnType<typeof inspectGeoArrowBatch>;
  try {
    inspection = inspectGeoArrowBatch(input.batch);
  } catch (cause) {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? String((cause as { code: unknown }).code)
        : undefined;
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct deck.gl binding requires an exactly validated normative GeoArrow batch.",
      { ...(code === undefined ? {} : { geoArrowCode: code }) },
      { cause },
    );
  }
  const batch = inspection.batch;
  const metadata = batch.schema.metadata;
  if (
    metadata?.["honua.geoarrow.layout.version"] !== "1.0" ||
    metadata["honua.geoarrow.spec.version"] !== "0.2" ||
    metadata["honua.geoarrow.geometry.kind"] !== "polygon"
  ) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct deck.gl binding requires a normative Honua GeoArrow 1.0 Polygon batch.",
      { expectedLayout: "honua-geoarrow@1.0", expectedGeometry: "polygon" },
    );
  }
  if (metadata["honua.geoarrow.geometry.coordinate-layout"] !== "interleaved") {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct deck.gl Polygon binding requires interleaved coordinates; separated coordinates need an explicit bounded conversion.",
      { coordinateLayout: metadata["honua.geoarrow.geometry.coordinate-layout"], copiedBytes: 0 },
    );
  }
  const dimensions = metadata["honua.geoarrow.geometry.dimensions"];
  if (dimensions !== "xy" && dimensions !== "xyz") {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct deck.gl Polygon binding supports XY or XYZ coordinates; M dimensions need an explicit mapping.",
      { dimensions },
    );
  }
  if (inspection.geometry.crs !== "OGC:CRS84") {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      'Direct deck.gl Polygon binding requires explicit longitude/latitude axis evidence via CRS "OGC:CRS84".',
      { crs: inspection.geometry.crs ?? null },
    );
  }
  const size = dimensions === "xy" ? 2 : 3;
  const geometryField = metadata["honua.geoarrow.geometry.field"];
  const schemaField = batch.schema.fields.find((field) => field.name === geometryField);
  if (
    !schemaField ||
    schemaField.nullable ||
    schemaField.type.name !== "geoarrow.polygon" ||
    schemaField.type.parameters?.dimensions !== dimensions ||
    schemaField.type.parameters?.coordinateLayout !== "interleaved" ||
    schemaField.metadata?.["ARROW:extension:name"] !== "geoarrow.polygon"
  ) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "GeoArrow Polygon schema does not match its direct rendering layout.",
      { geometryField },
    );
  }
  if (inspection.geometry.validity !== undefined) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Nullable GeoArrow polygons need an explicit bounded filter before direct deck.gl rendering.",
      { bufferId: `${geometryField}.validity`, copiedBytes: 0 },
    );
  }
  const ringCounts = inspection.geometry.offsets;
  if (!ringCounts || ringCounts.length !== batch.rowCount + 1) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "GeoArrow Polygon ring-count offsets buffer is missing or has the wrong extent.",
      { bufferId: `${geometryField}.offsets` },
    );
  }
  for (let row = 0; row < batch.rowCount; row += 1) {
    const ringsInRow = ringCounts[row + 1]! - ringCounts[row]!;
    if (ringsInRow !== 1) {
      throw new HonuaDeckGlAdapterError(
        "invalid-data",
        "Polygons with holes or empty polygons need an explicit bounded conversion before direct deck.gl rendering.",
        { row, rings: ringsInRow },
      );
    }
  }
  const ringOffsets = inspection.geometry.ringOffsets;
  if (!ringOffsets || ringOffsets.length !== batch.rowCount + 1) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "GeoArrow Polygon ring-offsets buffer is missing or has the wrong extent.",
      { bufferId: `${geometryField}.ring-offsets` },
    );
  }
  const vertices = ringOffsets[ringOffsets.length - 1]!;
  const ringOffsetsId = `${geometryField}.ring-offsets`;
  const ringOffsetsBuffer = batch.buffers.find((buffer) => buffer.id === ringOffsetsId);
  if (!ringOffsetsBuffer || ringOffsetsBuffer.field !== geometryField || ringOffsetsBuffer.role !== "offsets") {
    throw new HonuaDeckGlAdapterError("invalid-data", "GeoArrow Polygon ring-offsets buffer is missing or malformed.", {
      bufferId: ringOffsetsId,
    });
  }
  const positionId = `${geometryField}.coordinates`;
  const position = batch.buffers.find((buffer) => buffer.id === positionId);
  if (
    !position ||
    position.field !== geometryField ||
    position.role !== "geometry" ||
    position.byteLength !== vertices * size * Float64Array.BYTES_PER_ELEMENT
  ) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "GeoArrow Polygon coordinate buffer is missing or has the wrong extent.",
      { bufferId: positionId },
    );
  }

  const identity = requireGeoArrowBatchIdentity(batch, "Polygon");
  const featureIdColumn = resolveGeoArrowFeatureIdColumn(batch, metadata);

  const request = bindColumnarBatchToDeckGl({
    batch,
    layer: "feature-polygon",
    layerId: input.layerId,
    vertexCount: vertices,
    attributes: [{ accessor: "getPolygon", bufferId: positionId, component: "float64", size }],
    startIndices: { bufferId: ringOffsetsId, component: "int32" },
    identity: {
      sourceId: identity.sourceId,
      planId: identity.planId,
      sourceVersion: identity.sourceVersion,
      ...(featureIdColumn === undefined ? {} : { featureIdColumn }),
    },
    ...(input.props === undefined ? {} : { props: input.props }),
  });
  const polygonView = request.data.attributes.getPolygon.value;
  if (polygonView.buffer !== position.data) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct GeoArrow polygon binding unexpectedly copied its payload.",
    );
  }
  const startIndicesView = request.data.startIndices as unknown as Int32Array | undefined;
  if (startIndicesView === undefined || startIndicesView.buffer !== ringOffsetsBuffer.data) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "Direct GeoArrow polygon binding unexpectedly copied its startIndices payload.",
    );
  }
  return Object.freeze({
    request,
    metrics: Object.freeze({
      rows: batch.rowCount,
      vertices,
      positionBytes: position.byteLength,
      copiedBytes: 0,
      geoJsonFeaturesMaterialized: 0,
    }),
  });
}

function resolveFeatureIds(
  identity: ColumnarDeckGlIdentity,
  buffers: ReadonlyMap<string, ColumnarBufferV1>,
  rowCount: number,
): ArrayLike<string | number | bigint> {
  const column = identity.featureIdColumn;
  if (column === undefined) {
    // Zero-copy sequential identity: a lazy ArrayLike that never allocates a
    // parallel id array for the whole batch.
    return sequentialIds(rowCount);
  }
  const ctor = componentInfo(column.component);
  const buffer = requireBuffer(buffers, column.bufferId, "identity.featureIdColumn");
  const view = viewBuffer(buffer, ctor, "identity.featureIdColumn") as unknown as ArrayLike<string | number | bigint>;
  if (view.length < rowCount) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      `identity.featureIdColumn addresses ${view.length} rows but the batch has ${rowCount}.`,
      { available: view.length, rowCount },
    );
  }
  return view;
}

/**
 * Lazy row-index identity so the picking id array never materializes eagerly.
 * A read of index `i` returns `i`; `length` returns the row count.
 */
function sequentialIds(length: number): ArrayLike<number> {
  const target: { length: number } = { length };
  return new Proxy(target, {
    get(base, key, receiver): unknown {
      if (typeof key === "string") {
        const asIndex = Number(key);
        if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < length) return asIndex;
      }
      return Reflect.get(base, key, receiver);
    },
  }) as unknown as ArrayLike<number>;
}
