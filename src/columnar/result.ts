/**
 * Bounded conversion between Honua columnar batches and the protocol-neutral
 * object `Result` contract.
 *
 * The columnar plane is deliberately one-way at the buffer level: rows go in,
 * GPU-ready binaries come out, and nothing per-feature is ever materialized.
 * That is what keeps a million-row batch affordable, but it also means the
 * first time an application needs a popup, a table page, an export, or an
 * assertion in the shape the rest of the SDK speaks, it has no way back. These
 * two functions are that way back, and they are bounded by construction.
 *
 * **The ceiling is the feature, not a guard rail.** Materializing feature
 * objects costs roughly two orders of magnitude more memory per row than the
 * packed columns they came from, so an unbounded conversion is exactly the
 * silent materialization the columnar plane exists to avoid. `maxFeatures` is
 * therefore a required option on both directions, it is enforced before a
 * single feature object is allocated, and there is no sentinel, no `Infinity`,
 * and no options object that disables it. A conversion that would exceed it
 * fails closed with `HonuaGeoArrowError` code `row-limit-exceeded` naming both
 * the ceiling and the requested count.
 *
 * Conversion reads only the requested window. Payload validation that the
 * unbounded {@link inspectGeoArrowBatch} performs over the whole batch is
 * performed here per materialized row instead, so cost stays proportional to
 * the window rather than to the batch.
 *
 * @experimental
 */

import type { Result } from "../contract/types.js";
import type { HonuaFieldInfo, HonuaTypedFeature } from "../core/types.js";
import type {
  ColumnarBatchIdentityV1,
  CreateGeoArrowBatchInput,
  CreatedGeoArrowBatch,
  GeoArrowBatchInspection,
  GeoArrowConversionLimits,
  GeoArrowCoordinateLayout,
  GeoArrowCrs,
  GeoArrowDictionaryBuffers,
  GeoArrowDimensions,
  GeoArrowEdges,
  GeoArrowGeometryColumnInput,
  GeoArrowGeometryKind,
  GeoArrowLineString,
  GeoArrowPoint,
  GeoArrowPolygon,
  GeoArrowPosition,
  GeoArrowTimestampUnit,
  HonuaGeoArrowErrorCode,
} from "./geoarrow-types.js";
import { HonuaGeoArrowError } from "./geoarrow-types.js";
import {
  createGeoArrowBatch,
  decodeGeoArrowGeometryAt,
  inspectGeoArrowBatchScoped,
  isGeoArrowRowValid,
} from "./geoarrow.js";
import type { ColumnarBatchV1 } from "./types.js";

/**
 * Conservative ceiling recommended for a bounded conversion window.
 *
 * It exists because feature objects, unlike the packed columns they are read
 * from, cost hundreds of bytes per row: a hundred thousand point features is
 * already tens of megabytes of live JavaScript objects, which is the largest
 * bounded window that still behaves like an interaction rather than a bulk
 * export. It is exported as a documented starting point, **not** applied
 * implicitly — `maxFeatures` is always explicit at the call site so the cost of
 * materialization is always visible in the calling code.
 */
export const DEFAULT_COLUMNAR_RESULT_MAX_FEATURES = 100_000;

/** GeoJSON geometry types the Honua columnar geometry kinds map onto. */
export type ColumnarGeoJsonGeometryType = "Point" | "LineString" | "Polygon";

/**
 * GeoJSON geometry emitted onto a converted feature.
 *
 * Positions carry two components for `xy` and three for `xyz` geometry, in
 * `[x, y]` / `[x, y, z]` order. `xym` and `xyzm` batches are rejected rather
 * than silently stripped, because GeoJSON has no representation for an M
 * coordinate and dropping it would be a lossy conversion presented as a
 * successful one.
 */
export type ColumnarGeoJsonGeometry = {
  readonly type: ColumnarGeoJsonGeometryType;
  readonly coordinates: GeoArrowPoint | GeoArrowLineString | GeoArrowPolygon;
};

/** Attribute a batch's non-nullable `uint32` feature-id column is emitted as. */
export interface ColumnarResultFeatureIdBinding {
  readonly attribute: string;
}

/**
 * Attribute a batch's timestamp column is emitted as.
 *
 * The attribute value is the Arrow timestamp as a `bigint` in `unit`, never a
 * `Date` and never epoch milliseconds, so microsecond and nanosecond batches
 * round-trip exactly. A null timestamp becomes an explicit `null` attribute.
 */
export interface ColumnarResultTemporalBinding {
  readonly attribute: string;
  readonly unit: GeoArrowTimestampUnit;
  readonly timezone?: string;
}

/**
 * Attribute a batch's dictionary-encoded UTF-8 column is emitted as.
 *
 * Dictionary encoding is a storage detail: the attribute carries the decoded
 * `string`, and a null dictionary value becomes an explicit `null` attribute
 * rather than an omitted key or the zero-index value.
 */
export interface ColumnarResultDictionaryBinding {
  readonly attribute: string;
  readonly ordered: boolean;
}

/** Declared attribute names every converted feature carries. */
export interface ColumnarResultAttributeBinding {
  readonly featureId?: ColumnarResultFeatureIdBinding;
  readonly temporal?: ColumnarResultTemporalBinding;
  readonly dictionary?: ColumnarResultDictionaryBinding;
}

/** Geometry layout of the column a bounded `Result` was converted from. */
export interface ColumnarResultGeometryDescriptor {
  readonly kind: GeoArrowGeometryKind;
  readonly field: string;
  readonly dimensions: GeoArrowDimensions;
  readonly coordinateLayout: GeoArrowCoordinateLayout;
  readonly edges: GeoArrowEdges;
}

/**
 * Everything a bounded object view must carry to stay honest about the batch
 * it came from, and everything {@link resultToColumnarBatch} needs to put it
 * back without the caller restating the layout.
 *
 * `identity` is the source batch's own cache, authorization, ordering, and
 * freshness identity, copied and never re-observed: a bounded object view can
 * therefore never look fresher, differently ordered, or differently scoped
 * than the batch it was cut from.
 */
export interface ColumnarResultProvenance {
  readonly batchId: string;
  readonly schemaId: string;
  readonly sequence: number;
  /** Rows in the source batch, which is not the number of converted features. */
  readonly batchRowCount: number;
  /** Zero-based index of the first converted row within the source batch. */
  readonly offset: number;
  /** Converted feature count. Never greater than `maxFeatures`. */
  readonly count: number;
  /** Absolute row offset of the first converted row in the logical row stream. */
  readonly rowOffset: number;
  /** Ceiling that bounded this conversion. */
  readonly maxFeatures: number;
  readonly geometry: ColumnarResultGeometryDescriptor;
  readonly attributes: ColumnarResultAttributeBinding;
  readonly identity: ColumnarBatchIdentityV1;
}

/**
 * A protocol-neutral {@link Result} produced from a bounded columnar window.
 *
 * It **is** a `Result`: every consumer that accepts an object-path result
 * accepts this unchanged. The two extra members exist because the shared
 * envelope has nowhere to put them — `crs` so a consumer is never left
 * assuming EPSG:4326, and `columnar` so the bounded view carries the batch's
 * ordering and freshness with it.
 */
export interface ColumnarResult<T = Record<string, unknown>> extends Result<T> {
  /**
   * CRS the batch declared for its geometry column: a serialized CRS string or
   * a PROJJSON object. Undefined when the batch declared none, in which case
   * the coordinates carry no CRS claim at all and a consumer must not invent
   * one.
   */
  readonly crs?: GeoArrowCrs;
  /** Provenance of the bounded window this `Result` was cut from. */
  readonly columnar: ColumnarResultProvenance;
}

/** Explicit conversion window. There is no unbounded mode. */
export interface ColumnarBatchToResultOptions {
  /**
   * Hard ceiling on converted features. Required: conversion refuses rather
   * than materializing an unbounded number of feature objects.
   */
  readonly maxFeatures: number;
  /** Zero-based first row of the window. Defaults to the start of the batch. */
  readonly offset?: number;
  /** Rows to convert from `offset`. Defaults to the rest of the batch. */
  readonly limit?: number;
  /** Structural limits forwarded to batch inspection. */
  readonly limits?: GeoArrowConversionLimits;
}

/** Geometry layout for {@link resultToColumnarBatch}. */
export interface ResultToColumnarBatchGeometryOptions {
  readonly field?: string;
  readonly kind?: GeoArrowGeometryKind;
  readonly dimensions?: GeoArrowDimensions;
  readonly coordinateLayout?: GeoArrowCoordinateLayout;
  readonly edges?: GeoArrowEdges;
  readonly crs?: GeoArrowCrs;
}

/** Attributes {@link resultToColumnarBatch} lifts into typed columns. */
export interface ResultToColumnarBatchAttributeOptions {
  readonly featureId?: ColumnarResultFeatureIdBinding;
  readonly temporal?: ColumnarResultTemporalBinding;
  readonly dictionary?: { readonly attribute: string; readonly ordered?: boolean };
}

/**
 * Explicit conversion window plus the batch identity an object-path `Result`
 * cannot supply on its own. Every field except `maxFeatures` defaults from
 * {@link ColumnarResult.columnar} when the `Result` came from
 * {@link columnarBatchToResult}.
 */
export interface ResultToColumnarBatchOptions {
  /**
   * Hard ceiling on converted rows. Required, for the same reason as on
   * {@link ColumnarBatchToResultOptions}.
   */
  readonly maxFeatures: number;
  /** Zero-based first feature of the window. Defaults to the first feature. */
  readonly offset?: number;
  /** Features to convert from `offset`. Defaults to the rest of the array. */
  readonly limit?: number;
  readonly id?: string;
  readonly sequence?: number;
  readonly rowOffset?: number;
  readonly schemaId?: string;
  readonly identity?: ColumnarBatchIdentityV1;
  readonly geometry?: ResultToColumnarBatchGeometryOptions;
  readonly attributes?: ResultToColumnarBatchAttributeOptions;
  readonly limits?: GeoArrowConversionLimits;
}

const GEOJSON_TYPE_BY_KIND: Readonly<Record<GeoArrowGeometryKind, ColumnarGeoJsonGeometryType>> = Object.freeze({
  point: "Point",
  linestring: "LineString",
  polygon: "Polygon",
});

const KIND_BY_GEOJSON_TYPE: Readonly<Record<string, GeoArrowGeometryKind | undefined>> = Object.freeze({
  Point: "point",
  LineString: "linestring",
  Polygon: "polygon",
});

function fail(
  code: HonuaGeoArrowErrorCode,
  message: string,
  detail?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): never {
  throw new HonuaGeoArrowError(code, message, detail, cause === undefined ? undefined : { cause });
}

interface BoundedWindowOptions {
  readonly maxFeatures: number;
  readonly offset?: number;
  readonly limit?: number;
}

interface ResolvedWindow {
  readonly offset: number;
  readonly count: number;
}

/**
 * Resolve and bound the window before anything is read or allocated.
 *
 * Every rejection here happens against plain counts, so an over-ceiling request
 * costs one comparison and produces no feature object, no buffer view, and no
 * batch inspection.
 */
function resolveWindow(available: number, options: BoundedWindowOptions, label: string): ResolvedWindow {
  const maxFeatures = options.maxFeatures;
  if (!Number.isSafeInteger(maxFeatures) || maxFeatures <= 0) {
    fail(
      "invalid-input",
      `${label} requires a positive safe-integer maxFeatures ceiling; there is no unbounded conversion mode.`,
      { resource: "maxFeatures", actual: maxFeatures },
    );
  }
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    fail("invalid-input", `${label} offset must be a non-negative safe integer.`, {
      resource: "offset",
      actual: offset,
    });
  }
  if (offset > available) {
    fail("invalid-input", `${label} offset ${offset} is past the end of the ${available}-row window source.`, {
      resource: "offset",
      actual: offset,
      available,
    });
  }
  const remaining = available - offset;
  const limit = options.limit ?? remaining;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    fail("invalid-input", `${label} limit must be a non-negative safe integer.`, {
      resource: "limit",
      actual: limit,
    });
  }
  const count = Math.min(limit, remaining);
  if (count > maxFeatures) {
    fail("row-limit-exceeded", `${label} requested ${count} features; the maxFeatures ceiling is ${maxFeatures}.`, {
      resource: "maxFeatures",
      requested: count,
      limit: maxFeatures,
    });
  }
  return { offset, count };
}

/**
 * Component count a GeoJSON position carries for a declared GeoArrow layout.
 *
 * `xym` and `xyzm` fail closed: GeoJSON cannot carry an M coordinate, and
 * dropping one silently would report a lossy conversion as a faithful one.
 */
function geoJsonComponents(dimensions: GeoArrowDimensions): number {
  if (dimensions === "xy") return 2;
  if (dimensions === "xyz") return 3;
  fail(
    "unsupported-layout",
    `GeoJSON has no representation for an M coordinate, so "${dimensions}" geometry cannot be converted to an object Result.`,
    { dimensions },
  );
}

function assertFinitePosition(position: GeoArrowPosition, components: number, row: number): GeoArrowPosition {
  if (position.length !== components) {
    fail(
      "invalid-batch",
      `Geometry at row ${row} carries ${position.length} coordinates; the layout declares ${components}.`,
      {
        row,
        expected: components,
        actual: position.length,
      },
    );
  }
  for (let index = 0; index < components; index += 1) {
    if (!Number.isFinite(position[index]!)) {
      fail("invalid-batch", "Coordinate buffers must contain finite values.", { row, component: index });
    }
  }
  return position;
}

/**
 * Wrap a decoded GeoArrow geometry as GeoJSON.
 *
 * The decoded position arrays are reused rather than copied: they are already
 * freshly allocated for this window, so re-copying them would double the only
 * per-feature allocation the conversion makes.
 */
function toGeoJsonGeometry(
  kind: GeoArrowGeometryKind,
  components: number,
  decoded: GeoArrowPoint | GeoArrowLineString | GeoArrowPolygon,
  row: number,
): ColumnarGeoJsonGeometry {
  if (kind === "point") {
    const point = decoded as GeoArrowPoint;
    return Object.freeze({
      type: GEOJSON_TYPE_BY_KIND.point,
      coordinates: assertFinitePosition(point, components, row),
    });
  }
  if (kind === "linestring") {
    const line = decoded as GeoArrowLineString;
    for (const position of line) assertFinitePosition(position, components, row);
    return Object.freeze({ type: GEOJSON_TYPE_BY_KIND.linestring, coordinates: line });
  }
  const polygon = decoded as GeoArrowPolygon;
  for (const ring of polygon) for (const position of ring) assertFinitePosition(position, components, row);
  return Object.freeze({ type: GEOJSON_TYPE_BY_KIND.polygon, coordinates: polygon });
}

/**
 * Decode dictionary values lazily, for the window's distinct indices only.
 *
 * A batch may carry tens of thousands of dictionary values behind a window of
 * a few rows; decoding all of them would make a bounded conversion pay for the
 * whole column.
 */
function createDictionaryReader(dictionary: GeoArrowDictionaryBuffers): (index: number, row: number) => string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cache = new Map<number, string>();
  const size = dictionary.offsets.length - 1;
  return (index, row) => {
    const cached = cache.get(index);
    if (cached !== undefined) return cached;
    if (!Number.isInteger(index) || index < 0 || index >= size) {
      fail("invalid-batch", `Dictionary index at row ${row} is outside the dictionary.`, { row, index, size });
    }
    let value: string;
    try {
      value = decoder.decode(dictionary.values.subarray(dictionary.offsets[index]!, dictionary.offsets[index + 1]!));
    } catch (cause) {
      fail("invalid-batch", "Dictionary value bytes are not valid UTF-8.", { row, index }, cause);
    }
    cache.set(index, value);
    return value;
  };
}

function schemaFieldNullable(batch: ColumnarBatchV1, name: string): boolean {
  return batch.schema.fields.find((field) => field.name === name)?.nullable ?? false;
}

/**
 * Declared field schema for the attributes the conversion emits, so a consumer
 * reads the attribute types off the `Result` instead of guessing them.
 */
function describeFields(inspection: GeoArrowBatchInspection): readonly HonuaFieldInfo[] | undefined {
  const fields: HonuaFieldInfo[] = [];
  if (inspection.featureIds) {
    fields.push({ name: inspection.featureIds.field, type: "esriFieldTypeOID", nullable: false, editable: false });
  }
  if (inspection.temporal) {
    fields.push({
      name: inspection.temporal.field,
      type: "esriFieldTypeDate",
      nullable: schemaFieldNullable(inspection.batch, inspection.temporal.field),
    });
  }
  if (inspection.dictionary) {
    fields.push({
      name: inspection.dictionary.field,
      type: "esriFieldTypeString",
      nullable: schemaFieldNullable(inspection.batch, inspection.dictionary.field),
    });
  }
  return fields.length === 0 ? undefined : Object.freeze(fields);
}

function attributeBinding(inspection: GeoArrowBatchInspection): ColumnarResultAttributeBinding {
  return Object.freeze({
    ...(inspection.featureIds === undefined
      ? {}
      : { featureId: Object.freeze({ attribute: inspection.featureIds.field }) }),
    ...(inspection.temporal === undefined
      ? {}
      : {
          temporal: Object.freeze({
            attribute: inspection.temporal.field,
            unit: inspection.temporal.unit,
            ...(inspection.temporal.timezone === undefined ? {} : { timezone: inspection.temporal.timezone }),
          }),
        }),
    ...(inspection.dictionary === undefined
      ? {}
      : {
          dictionary: Object.freeze({
            attribute: inspection.dictionary.field,
            ordered: inspection.dictionary.ordered,
          }),
        }),
  });
}

/**
 * Convert a bounded, contiguous row window of a columnar batch into a
 * protocol-neutral {@link Result} of typed features.
 *
 * Features are emitted in batch row order, so the `Result` preserves the
 * batch's declared ordering exactly. Geometry becomes GeoJSON, the batch's
 * feature-id, timestamp, and dictionary columns become attributes under their
 * declared names, and a null timestamp or dictionary value becomes an explicit
 * `null` attribute rather than a missing key.
 *
 * @throws HonuaGeoArrowError `row-limit-exceeded` when the window exceeds
 * `options.maxFeatures`. The ceiling is checked before the batch is inspected,
 * so nothing is read or allocated on that path.
 * @throws HonuaGeoArrowError `unsupported-layout` for `xym`/`xyzm` geometry,
 * which GeoJSON cannot represent.
 *
 * @example
 * ```ts
 * const result = columnarBatchToResult(batch, { offset: 0, limit: 50, maxFeatures: 200 });
 * for (const feature of result.features) console.log(feature.geometry, feature.attributes);
 * ```
 */
export function columnarBatchToResult<T extends Record<string, unknown> = Record<string, unknown>>(
  batch: ColumnarBatchV1,
  options: ColumnarBatchToResultOptions,
): ColumnarResult<T> {
  if (typeof batch !== "object" || batch === null) fail("invalid-input", "batch must be a columnar batch object.");
  if (typeof options !== "object" || options === null) {
    fail("invalid-input", "columnarBatchToResult requires an options object carrying the maxFeatures ceiling.");
  }
  const batchRowCount = batch.rowCount;
  if (!Number.isSafeInteger(batchRowCount) || batchRowCount < 0) {
    fail("invalid-batch", "batch.rowCount must be a non-negative safe integer.");
  }
  // Bound first. Nothing below this line runs for an over-ceiling request.
  const window = resolveWindow(batchRowCount, options, "columnarBatchToResult");

  const inspection = inspectGeoArrowBatchScoped(batch, options.limits ?? {}, "window");
  const geometry = inspection.geometry;
  const components = geoJsonComponents(geometry.dimensions);
  const readDictionary =
    inspection.dictionary === undefined ? undefined : createDictionaryReader(inspection.dictionary);

  const end = window.offset + window.count;
  const features: HonuaTypedFeature<T>[] = [];
  for (let row = window.offset; row < end; row += 1) {
    const attributes: Record<string, unknown> = {};
    if (inspection.featureIds !== undefined) {
      attributes[inspection.featureIds.field] = inspection.featureIds.values[row]!;
    }
    if (inspection.temporal !== undefined) {
      attributes[inspection.temporal.field] = isGeoArrowRowValid(inspection.temporal.validity, row)
        ? inspection.temporal.values[row]!
        : null;
    }
    if (inspection.dictionary !== undefined) {
      attributes[inspection.dictionary.field] = isGeoArrowRowValid(inspection.dictionary.validity, row)
        ? readDictionary!(inspection.dictionary.indices[row]!, row)
        : null;
    }
    const decoded = decodeGeoArrowGeometryAt(geometry, row);
    features.push(
      Object.freeze({
        attributes: Object.freeze(attributes) as T,
        geometry: decoded === null ? null : toGeoJsonGeometry(geometry.kind, components, decoded, row),
      }),
    );
  }

  const fields = describeFields(inspection);
  const provenance: ColumnarResultProvenance = Object.freeze({
    batchId: inspection.batch.id,
    schemaId: inspection.batch.schema.id,
    sequence: inspection.batch.sequence,
    batchRowCount,
    offset: window.offset,
    count: window.count,
    rowOffset: (inspection.batch.rowOffset ?? 0) + window.offset,
    maxFeatures: options.maxFeatures,
    geometry: Object.freeze({
      kind: geometry.kind,
      field: geometry.field,
      dimensions: geometry.dimensions,
      coordinateLayout: geometry.coordinateLayout,
      edges: geometry.edges,
    }),
    attributes: attributeBinding(inspection),
    identity: inspection.batch.identity!,
  });

  const result: ColumnarResult<T> = {
    features: Object.freeze(features),
    exceededTransferLimit: window.count < batchRowCount,
    totalCount: batchRowCount,
    ...(fields === undefined ? {} : { fields }),
    ...(geometry.crs === undefined ? {} : { crs: geometry.crs }),
    columnar: provenance,
  };
  return Object.freeze(result);
}

function requiredOption<V>(value: V | undefined, name: string, predicate: (candidate: V) => boolean): V {
  if (value === undefined || !predicate(value)) {
    fail(
      "invalid-input",
      `resultToColumnarBatch requires options.${name}; only a Result produced by columnarBatchToResult can default it.`,
      { resource: name },
    );
  }
  return value;
}

/** First position of a GeoJSON coordinate tree, used only to infer dimensions. */
function firstPosition(kind: GeoArrowGeometryKind, coordinates: readonly unknown[]): readonly unknown[] | undefined {
  if (kind === "point") return coordinates.length === 0 ? undefined : coordinates;
  if (kind === "linestring") return Array.isArray(coordinates[0]) ? (coordinates[0] as readonly unknown[]) : undefined;
  const ring = coordinates[0];
  if (!Array.isArray(ring)) return undefined;
  return Array.isArray(ring[0]) ? (ring[0] as readonly unknown[]) : undefined;
}

function inferDimensions(position: readonly unknown[], index: number): GeoArrowDimensions {
  if (position.length === 2) return "xy";
  if (position.length === 3) return "xyz";
  fail(
    "invalid-input",
    `result.features[${index}].geometry carries ${position.length}-component positions; declare geometry.dimensions for a layout GeoJSON cannot imply.`,
    { index, components: position.length },
  );
}

/**
 * Convert a bounded, contiguous window of an object-path {@link Result} into a
 * normative GeoArrow columnar batch.
 *
 * This is the inverse of {@link columnarBatchToResult} and is bounded the same
 * way: `maxFeatures` is required and enforced before any feature is read. A
 * `Result` produced by {@link columnarBatchToResult} carries enough provenance
 * to default the batch identity, geometry layout, and attribute bindings; a
 * plain object-path `Result` must supply `id`, `schemaId`, and `identity`, and
 * any attribute it wants lifted into a typed column.
 *
 * Null and missing attributes are treated identically for the nullable
 * timestamp and dictionary columns and become null column values. A feature-id
 * column is not nullable, so a missing or null id fails closed.
 *
 * @throws HonuaGeoArrowError `row-limit-exceeded` when the window exceeds
 * `options.maxFeatures`, checked before any feature is read.
 * @throws HonuaGeoArrowError `unsupported-layout` when the window mixes
 * geometry kinds, which a single columnar geometry column cannot carry.
 */
export function resultToColumnarBatch<T extends Record<string, unknown> = Record<string, unknown>>(
  result: Result<T>,
  options: ResultToColumnarBatchOptions,
): CreatedGeoArrowBatch {
  if (typeof result !== "object" || result === null) fail("invalid-input", "result must be an object Result.");
  if (typeof options !== "object" || options === null) {
    fail("invalid-input", "resultToColumnarBatch requires an options object carrying the maxFeatures ceiling.");
  }
  const features = result.features;
  if (!Array.isArray(features)) fail("invalid-input", "result.features must be an array.");
  // Bound first. Nothing below this line runs for an over-ceiling request.
  const window = resolveWindow(features.length, options, "resultToColumnarBatch");

  const source = result as Partial<ColumnarResult<T>>;
  const provenance = source.columnar;
  const id = requiredOption(
    options.id ?? provenance?.batchId,
    "id",
    (value) => typeof value === "string" && value !== "",
  );
  const schemaId = requiredOption(
    options.schemaId ?? provenance?.schemaId,
    "schemaId",
    (value) => typeof value === "string" && value !== "",
  );
  const identity = requiredOption(
    options.identity ?? provenance?.identity,
    "identity",
    (value) => typeof value === "object" && value !== null,
  );
  const sequence = options.sequence ?? provenance?.sequence ?? 0;
  const rowOffset = options.rowOffset ?? (provenance === undefined ? undefined : provenance.rowOffset + window.offset);

  const featureIdBinding = options.attributes?.featureId ?? provenance?.attributes.featureId;
  const temporalBinding = options.attributes?.temporal ?? provenance?.attributes.temporal;
  const dictionaryBinding = options.attributes?.dictionary ?? provenance?.attributes.dictionary;

  let kind = options.geometry?.kind ?? provenance?.geometry.kind;
  let dimensions = options.geometry?.dimensions ?? provenance?.geometry.dimensions;
  const values: (GeoArrowPoint | GeoArrowLineString | GeoArrowPolygon | null)[] = [];
  const featureIdValues: number[] = [];
  const temporalValues: (bigint | null)[] = [];
  const dictionaryValues: (string | null)[] = [];

  const end = window.offset + window.count;
  for (let index = window.offset; index < end; index += 1) {
    const feature = features[index];
    if (typeof feature !== "object" || feature === null) {
      fail("invalid-input", `result.features[${index}] must be a feature object.`, { index });
    }
    if (featureIdBinding !== undefined) {
      const raw = (feature.attributes as Record<string, unknown> | undefined)?.[featureIdBinding.attribute];
      if (typeof raw !== "number") {
        fail(
          "invalid-input",
          `result.features[${index}].attributes.${featureIdBinding.attribute} must be a uint32 feature id; a feature-id column is not nullable.`,
          { index, attribute: featureIdBinding.attribute },
        );
      }
      featureIdValues.push(raw);
    }
    if (temporalBinding !== undefined) {
      const raw = (feature.attributes as Record<string, unknown> | undefined)?.[temporalBinding.attribute];
      if (raw === null || raw === undefined) temporalValues.push(null);
      else if (typeof raw === "bigint") temporalValues.push(raw);
      else if (typeof raw === "number" && Number.isSafeInteger(raw)) temporalValues.push(BigInt(raw));
      else {
        fail(
          "invalid-input",
          `result.features[${index}].attributes.${temporalBinding.attribute} must be a bigint, a safe-integer number in ${temporalBinding.unit}, or null.`,
          { index, attribute: temporalBinding.attribute },
        );
      }
    }
    if (dictionaryBinding !== undefined) {
      const raw = (feature.attributes as Record<string, unknown> | undefined)?.[dictionaryBinding.attribute];
      if (raw === null || raw === undefined) dictionaryValues.push(null);
      else if (typeof raw === "string") dictionaryValues.push(raw);
      else {
        fail(
          "invalid-input",
          `result.features[${index}].attributes.${dictionaryBinding.attribute} must be a string or null.`,
          { index, attribute: dictionaryBinding.attribute },
        );
      }
    }

    const raw = feature.geometry;
    if (raw === null || raw === undefined) {
      values.push(null);
      continue;
    }
    if (typeof raw !== "object") {
      fail("invalid-input", `result.features[${index}].geometry must be a GeoJSON geometry object or null.`, { index });
    }
    const type = (raw as { type?: unknown }).type;
    if (typeof type !== "string") {
      fail(
        "invalid-input",
        `result.features[${index}].geometry must carry a GeoJSON "type"; the columnar path does not accept Esri geometry envelopes.`,
        { index },
      );
    }
    const featureKind = KIND_BY_GEOJSON_TYPE[type];
    if (featureKind === undefined) {
      fail(
        "unsupported-layout",
        `Unsupported GeoJSON geometry type "${type}"; a Honua columnar geometry column carries point, linestring, or polygon.`,
        { index, type },
      );
    }
    if (kind === undefined) kind = featureKind;
    else if (kind !== featureKind) {
      fail(
        "unsupported-layout",
        `result.features[${index}].geometry is "${type}" but the column is geoarrow.${kind}; one columnar geometry column carries exactly one kind.`,
        { index, expected: kind, actual: featureKind },
      );
    }
    const coordinates = (raw as { coordinates?: unknown }).coordinates;
    if (!Array.isArray(coordinates)) {
      fail("invalid-input", `result.features[${index}].geometry.coordinates must be an array.`, { index });
    }
    if (dimensions === undefined) {
      const position = firstPosition(featureKind, coordinates);
      if (position !== undefined) dimensions = inferDimensions(position, index);
    }
    values.push(coordinates as GeoArrowPoint | GeoArrowLineString | GeoArrowPolygon);
  }

  if (kind === undefined) {
    fail(
      "invalid-input",
      "resultToColumnarBatch requires options.geometry.kind when the window carries no geometry to infer it from.",
      { resource: "geometry.kind" },
    );
  }
  // Every geometry in the window is null, so no coordinate layout is
  // observable; xy is the narrowest layout that round-trips those nulls.
  const resolvedDimensions = dimensions ?? "xy";
  const coordinateLayout = options.geometry?.coordinateLayout ?? provenance?.geometry.coordinateLayout;
  const edges = options.geometry?.edges ?? provenance?.geometry.edges;
  const crs = options.geometry?.crs ?? source.crs;
  const base = {
    field: options.geometry?.field ?? provenance?.geometry.field ?? "geometry",
    dimensions: resolvedDimensions,
    ...(coordinateLayout === undefined ? {} : { coordinateLayout }),
    ...(edges === undefined ? {} : { edges }),
    ...(crs === undefined ? {} : { crs }),
  };
  const geometry: GeoArrowGeometryColumnInput =
    kind === "point"
      ? { ...base, kind: "point", values: values as readonly (GeoArrowPoint | null)[] }
      : kind === "linestring"
        ? { ...base, kind: "linestring", values: values as readonly (GeoArrowLineString | null)[] }
        : { ...base, kind: "polygon", values: values as readonly (GeoArrowPolygon | null)[] };

  const input: CreateGeoArrowBatchInput = {
    id,
    sequence,
    ...(rowOffset === undefined ? {} : { rowOffset }),
    schemaId,
    identity,
    geometry,
    ...(temporalBinding === undefined
      ? {}
      : {
          temporal: {
            field: temporalBinding.attribute,
            unit: temporalBinding.unit,
            ...(temporalBinding.timezone === undefined ? {} : { timezone: temporalBinding.timezone }),
            values: temporalValues,
          },
        }),
    ...(dictionaryBinding === undefined
      ? {}
      : {
          dictionary: {
            field: dictionaryBinding.attribute,
            ordered: dictionaryBinding.ordered ?? false,
            values: dictionaryValues,
          },
        }),
    ...(featureIdBinding === undefined
      ? {}
      : { featureIds: { field: featureIdBinding.attribute, values: featureIdValues } }),
  };
  return createGeoArrowBatch(input, options.limits ?? {});
}
