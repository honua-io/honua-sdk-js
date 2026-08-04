/**
 * Realtime append/update/delete patch semantics over a normative Honua GeoArrow
 * batch, with declared rebuild thresholds.
 *
 * Every other columnar operation produces a brand new batch from a whole input
 * batch. A live layer cannot afford that: at a million rows a full re-encode
 * plus a full re-transfer per event defeats the columnar path outright, and it
 * invalidates the `ArrayBuffer` identities a renderer has already bound. This
 * module defines how a snapshot batch plus a delta stream becomes an updated
 * batch, when writing into the existing backings is legal, and when the SDK
 * must rebuild instead.
 *
 * ## The three outcomes
 *
 * {@link applyColumnarPatch} returns exactly one of:
 *
 * - `patched-in-place` — appended rows were written into caller-declared
 *   reserved capacity, updates were written over the existing values, and
 *   deletes became tombstones. No backing buffer was reallocated, so
 *   `bufferIdentityPreserved` is `true` and a renderer binding taken before the
 *   patch still aliases the same `ArrayBuffer`s.
 * - `rebuilt` — a declared threshold was crossed or the patch could not be
 *   expressed in the existing layout, so a compacted batch was produced with a
 *   new batch id and a new identity generation. `bufferIdentityPreserved` is
 *   `false`, the named `reason` says which rule fired, and every consumer keyed
 *   on the previous identity must rebind.
 * - `rejected` — the patch was refused before a single byte moved. The input
 *   batch is byte-identical to what it was before the call.
 *
 * ## Identity
 *
 * Updates and deletes are keyed by the batch's feature-id column. A batch
 * without one cannot resolve them and is rejected rather than guessing by row
 * position, because row position is not stable across a rebuild. The feature-id
 * index is cached per feature-id backing buffer and extended incrementally as
 * rows are appended, so patch cost stays proportional to the patch rather than
 * to the batch.
 *
 * At most one operation per feature id per patch is accepted. Two operations on
 * one feature would need a conflict-resolution rule that the realtime contract
 * does not define, and silently applying last-one-wins would make the result
 * depend on delivery order within an event batch.
 *
 * ## Tombstones
 *
 * A delete is never compacted in place, because compaction moves every
 * subsequent row and therefore invalidates offsets, bound buffers, and any row
 * index a caller is holding. A delete records a tombstone in the batch's
 * bounded overlay (run-length ranges in schema metadata) and leaves the payload
 * untouched. {@link decodePatchedGeoArrowBatch} and {@link columnarPatchLiveMask}
 * honor the overlay, so a deleted row never resurfaces; a rebuild is what
 * physically removes it.
 *
 * Layout-unaware readers — `decodeGeoArrowBatch`, aggregation, filters — still
 * see tombstoned rows, because the overlay is Honua metadata rather than an
 * Arrow-level concept. That is the price of not moving a million rows per
 * delete, and the tombstone-ratio threshold is what keeps the window small.
 *
 * ## Determinism
 *
 * The same base batch and the same patch always produce the same output bytes.
 *
 * - Appended rows are written in patch order at the end of the batch; updates
 *   are written where the row already is; deletes never move a row. Nothing is
 *   ordered by hash iteration or by first-seen order.
 * - Threshold evaluation is a fixed sequence — tombstone ratio, tombstone
 *   overlay bytes, capacity, vertex growth, then layout feasibility — so a
 *   patch that crosses two rules always names the same one.
 * - A rebuild copies live rows in ascending source-row order, then appends in
 *   patch order. Cancellation checks and progress reports only suspend that
 *   pass; they cannot change one output byte.
 *
 * A batch whose identity declares sort keys cannot accept an append or an
 * update to a sort-key column, because both would silently break the declared
 * order that pagination, caching, and picking depend on. Declare
 * `ordering: { stable: false, keys: [] }` for a patchable live batch.
 *
 * @experimental
 */
import type {
  ColumnarBatchIdentityV1,
  CreateGeoArrowBatchInput,
  DecodedGeoArrowRow,
  GeoArrowBatchInspection,
  GeoArrowConversionLimits,
  GeoArrowDimensions,
  GeoArrowGeometryKind,
  GeoArrowLineString,
  GeoArrowPoint,
  GeoArrowPolygon,
  GeoArrowPosition,
} from "./geoarrow-types.js";
import { createGeoArrowBatch, decodeGeoArrowBatch, inspectGeoArrowBatch } from "./geoarrow.js";
import { createColumnarBatch } from "./transfer.js";
import type { ColumnarBatchV1, ColumnarBufferV1 } from "./types.js";
import type { ColumnarWorkerOperation, ColumnarWorkerOperationContext } from "./worker.js";

/** Honua's realtime columnar patch layout, recorded in schema metadata. */
export const HONUA_COLUMNAR_PATCH_LAYOUT_VERSION = "1.0" as const;

/** Stable discriminator for a versioned columnar patch. */
export const COLUMNAR_PATCH_KIND = "honua.columnar-patch" as const;

/** Version discriminator for the first columnar patch contract. */
export const COLUMNAR_PATCH_VERSION = "1.0" as const;

/** Tombstoned rows as a fraction of `rowCount` before a rebuild is forced. */
export const DEFAULT_COLUMNAR_PATCH_MAX_TOMBSTONE_RATIO = 0.25;

/** UTF-8 ceiling for the encoded tombstone overlay before a rebuild is forced. */
export const DEFAULT_COLUMNAR_PATCH_MAX_TOMBSTONE_OVERLAY_BYTES = 4_096;

/** Fraction of declared reserved capacity that may be consumed before a rebuild. */
export const DEFAULT_COLUMNAR_PATCH_MAX_CAPACITY_UTILIZATION = 0.9;

/** Vertex count relative to the last rebuild before a rebuild is forced. */
export const DEFAULT_COLUMNAR_PATCH_MAX_VERTEX_GROWTH_RATIO = 1.5;

/** Operations accepted in one patch. There is no unbounded mode. */
export const DEFAULT_COLUMNAR_PATCH_MAX_OPERATIONS = 65_536;

/** Rows copied between cooperative abort checks during a rebuild. */
export const COLUMNAR_PATCH_ABORT_CHECK_ROWS = 8_192;

const META = Object.freeze({
  version: "honua.columnar-patch.version",
  sequence: "honua.columnar-patch.sequence",
  cursor: "honua.columnar-patch.cursor",
  observedAt: "honua.columnar-patch.observed-at",
  generation: "honua.columnar-patch.generation",
  tombstones: "honua.columnar-patch.tombstones",
  baseRows: "honua.columnar-patch.base-rows",
  baseVertices: "honua.columnar-patch.base-vertices",
  reserveRows: "honua.columnar-patch.reserve-rows",
  reserveVertices: "honua.columnar-patch.reserve-vertices",
  reserveRings: "honua.columnar-patch.reserve-rings",
});

/** A semantic geometry value carried by an append or an update. */
export type ColumnarPatchGeometry = GeoArrowPoint | GeoArrowLineString | GeoArrowPolygon | null;

/**
 * Resumable position for one patch, matching the realtime cursor contract:
 * the cursor resumes the stream, the sequence orders it, and `observedAt`
 * records freshness on the patched batch identity.
 */
export interface ColumnarPatchCursorV1 {
  readonly cursor: string;
  /** Strictly increasing per batch lineage. */
  readonly sequence: number;
  /** RFC 3339 instant at which the producing source observed the change. */
  readonly observedAt: string;
}

/** Add one row keyed by a feature id that the batch does not already carry. */
export interface ColumnarPatchAppendV1 {
  readonly op: "append";
  readonly featureId: number;
  readonly geometry: ColumnarPatchGeometry;
  /** Required when the batch declares a temporal column. */
  readonly timestamp?: bigint | null;
  /** Required when the batch declares a dictionary column. */
  readonly dictionaryValue?: string | null;
}

/** Overwrite declared columns of the row that carries `featureId`. */
export interface ColumnarPatchUpdateV1 {
  readonly op: "update";
  readonly featureId: number;
  readonly geometry?: ColumnarPatchGeometry;
  readonly timestamp?: bigint | null;
  readonly dictionaryValue?: string | null;
}

/** Tombstone the row that carries `featureId`. */
export interface ColumnarPatchDeleteV1 {
  readonly op: "delete";
  readonly featureId: number;
}

export type ColumnarPatchOperationV1 = ColumnarPatchAppendV1 | ColumnarPatchUpdateV1 | ColumnarPatchDeleteV1;

/** Input accepted by {@link createColumnarPatch}. */
export interface CreateColumnarPatchInput {
  /** Must equal the target batch's schema id; a mismatch is schema drift. */
  readonly schemaId: string;
  /** Must equal the target batch's geometry kind; a mismatch is geometry drift. */
  readonly geometryKind: GeoArrowGeometryKind;
  readonly cursor: ColumnarPatchCursorV1;
  readonly operations: readonly ColumnarPatchOperationV1[];
  /** Ceiling on operations in one patch. Defaults to 65,536. */
  readonly maxOperations?: number;
}

/** One versioned, self-describing realtime patch. */
export interface ColumnarPatchV1 {
  readonly kind: typeof COLUMNAR_PATCH_KIND;
  readonly version: typeof COLUMNAR_PATCH_VERSION;
  readonly schemaId: string;
  readonly geometryKind: GeoArrowGeometryKind;
  readonly cursor: ColumnarPatchCursorV1;
  readonly operations: readonly ColumnarPatchOperationV1[];
}

/**
 * Explicit, caller-declared spare capacity. Nothing is over-allocated
 * implicitly: a batch created without a reserve rebuilds on its first append.
 */
export interface ColumnarPatchReserveV1 {
  /** Rows of spare capacity in every row-indexed column. */
  readonly rows: number;
  /**
   * Spare coordinate positions. Ignored for point geometry, where one row is
   * exactly one vertex and `rows` already declares the coordinate capacity.
   */
  readonly vertices?: number;
  /** Spare polygon rings. Ignored for point and linestring geometry. */
  readonly rings?: number;
}

/** Row, vertex, and ring counts describing declared or remaining capacity. */
export interface ColumnarPatchCapacityV1 {
  readonly rows: number;
  readonly vertices: number;
  readonly rings: number;
}

/** Declared numeric ceilings that force a deterministic rebuild. */
export interface ColumnarPatchThresholds {
  /** Tombstones / rowCount. Defaults to 0.25. */
  readonly maxTombstoneRatio?: number;
  /** UTF-8 bytes of the encoded tombstone overlay. Defaults to 4,096. */
  readonly maxTombstoneOverlayBytes?: number;
  /** Consumed fraction of the declared reserve. Defaults to 0.9. */
  readonly maxCapacityUtilization?: number;
  /** Vertices relative to the last rebuild. Defaults to 1.5. */
  readonly maxVertexGrowthRatio?: number;
}

/** Overlay state carried by a patched batch. */
export interface ColumnarPatchStateV1 {
  readonly layoutVersion: typeof HONUA_COLUMNAR_PATCH_LAYOUT_VERSION;
  readonly rowCount: number;
  /** Rows that are not tombstoned. */
  readonly liveRowCount: number;
  readonly tombstoneCount: number;
  readonly tombstoneRatio: number;
  /** Inclusive ascending disjoint tombstoned row ranges. */
  readonly tombstoneRanges: readonly (readonly [number, number])[];
  readonly tombstoneOverlayBytes: number;
  /** Sequence of the most recently applied patch, absent before the first. */
  readonly sequence?: number;
  readonly cursor?: string;
  readonly observedAt?: string;
  /** Patches applied since the batch was created or last rebuilt. */
  readonly generation: number;
  readonly vertices: number;
  readonly rings: number;
  /** Row and vertex counts recorded when the batch was created or rebuilt. */
  readonly baseRows: number;
  readonly baseVertices: number;
  /** Capacity declared when the batch was created or rebuilt. */
  readonly reserve: ColumnarPatchCapacityV1;
  /** Capacity still unused, derived from the batch's own backing allocations. */
  readonly capacity: ColumnarPatchCapacityV1;
}

/** Exact accounting for one applied patch. */
export interface ColumnarPatchMetricsV1 {
  readonly appendedRows: number;
  readonly updatedRows: number;
  readonly deletedRows: number;
  readonly rowsTouched: number;
  /** Bytes written into payload backings. */
  readonly payloadBytesCopied: number;
  /** UTF-8 bytes of rewritten patch-state schema metadata. */
  readonly metadataBytes: number;
  /** Backing bytes newly allocated. Always zero for an in-place patch. */
  readonly backingBytesAllocated: number;
  readonly tombstones: number;
  readonly liveRows: number;
}

/** Which declared rule forced a rebuild. */
export type ColumnarPatchRebuildReason =
  | "tombstone-ratio"
  | "tombstone-overlay"
  | "capacity"
  | "vertex-growth"
  | "layout";

/** Why a patch was refused without mutating the batch. */
export type ColumnarPatchRejectionCode =
  | "duplicate-sequence"
  | "stale-sequence"
  | "schema-drift"
  | "geometry-kind-drift"
  | "invalid-geometry"
  | "incomplete-append"
  | "unknown-feature-id"
  | "deleted-feature-id"
  | "duplicate-feature-id"
  | "missing-feature-id-column"
  | "ordering-conflict"
  | "patch-limit-exceeded"
  | "rebuild-required"
  | "invalid-patch-state";

/** Typed failure for patch validation and patch-state parsing. */
export class HonuaColumnarPatchError extends Error {
  public constructor(
    public readonly code: ColumnarPatchRejectionCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HonuaColumnarPatchError";
  }
}

export interface ColumnarPatchAppliedInPlaceV1 {
  readonly outcome: "patched-in-place";
  readonly batch: ColumnarBatchV1;
  readonly state: ColumnarPatchStateV1;
  readonly metrics: ColumnarPatchMetricsV1;
  readonly bufferIdentityPreserved: true;
}

export interface ColumnarPatchRebuiltV1 {
  readonly outcome: "rebuilt";
  readonly batch: ColumnarBatchV1;
  readonly state: ColumnarPatchStateV1;
  readonly metrics: ColumnarPatchMetricsV1;
  readonly bufferIdentityPreserved: false;
  readonly reason: ColumnarPatchRebuildReason;
}

export interface ColumnarPatchRejectedV1 {
  readonly outcome: "rejected";
  readonly code: ColumnarPatchRejectionCode;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  /** The unmodified input batch. */
  readonly batch: ColumnarBatchV1;
}

export type ApplyColumnarPatchOutcomeV1 =
  | ColumnarPatchAppliedInPlaceV1
  | ColumnarPatchRebuiltV1
  | ColumnarPatchRejectedV1;

/** Rebuild inputs. Omitted values are derived deterministically from the patch. */
export interface ColumnarPatchRebuildOptions {
  /** Defaults to `<base batch id>~<patch sequence>`. */
  readonly batchId?: string;
  /** Defaults to the base identity with freshness advanced to the patch cursor. */
  readonly identity?: ColumnarBatchIdentityV1;
  /** Defaults to the reserve the batch already declares. */
  readonly reserve?: ColumnarPatchReserveV1;
}

export interface ApplyColumnarPatchOptions {
  readonly thresholds?: ColumnarPatchThresholds;
  readonly limits?: GeoArrowConversionLimits;
  readonly signal?: AbortSignal;
  /** Monotonic progress in `[0, 1]` with a stage label. */
  readonly reportProgress?: (fraction: number, stage: string) => void;
  readonly rebuild?: ColumnarPatchRebuildOptions;
  /**
   * When `false`, any condition that would rebuild is rejected with
   * `rebuild-required` instead, so a renderer that cannot rebind stays in
   * control of when the batch identity changes. Defaults to `true`.
   */
  readonly allowRebuild?: boolean;
}

export interface CreatePatchableGeoArrowBatchOptions extends GeoArrowConversionLimits {
  readonly reserve: ColumnarPatchReserveV1;
}

export interface PatchableGeoArrowBatchMetrics {
  readonly rows: number;
  readonly vertices: number;
  readonly rings: number;
  /** Payload bytes populated by the conversion. */
  readonly copiedBytes: number;
  /** Total backing bytes, including the declared reserve. */
  readonly backingBytes: number;
  /** Backing bytes held for the declared reserve. */
  readonly reservedBytes: number;
}

export interface CreatedPatchableGeoArrowBatch {
  readonly batch: ColumnarBatchV1;
  readonly state: ColumnarPatchStateV1;
  readonly metrics: PatchableGeoArrowBatchMetrics;
}

/** Rows of a patched batch with tombstoned rows removed. */
export interface DecodedPatchedGeoArrowBatch {
  readonly rows: readonly DecodedGeoArrowRow[];
  readonly state: ColumnarPatchStateV1;
  readonly metrics: {
    readonly rows: number;
    readonly tombstonedRows: number;
    readonly materializedRows: number;
  };
}

/** Options for the patch worker operation. */
export interface CreateColumnarPatchOperationOptions extends ApplyColumnarPatchOptions {
  /**
   * The patch to apply, or a provider consulted once per request so one
   * registered operation can drain a live stream.
   */
  readonly patch:
    | ColumnarPatchV1
    | ((batch: ColumnarBatchV1, context: ColumnarWorkerOperationContext) => ColumnarPatchV1 | Promise<ColumnarPatchV1>);
}

function reject(
  code: ColumnarPatchRejectionCode,
  message: string,
  batch: ColumnarBatchV1,
  detail?: Readonly<Record<string, unknown>>,
): ColumnarPatchRejectedV1 {
  return Object.freeze({
    outcome: "rejected" as const,
    code,
    message,
    ...(detail === undefined ? {} : { detail: Object.freeze({ ...detail }) }),
    batch,
  });
}

function requireSafeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HonuaColumnarPatchError("invalid-patch-state", `${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function requireCleanString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new HonuaColumnarPatchError("invalid-patch-state", `${label} must be a non-empty trimmed string.`);
  }
  return value;
}

function requireUint32(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) {
    throw new HonuaColumnarPatchError("invalid-patch-state", `${label} must be a uint32 feature id.`);
  }
  return value as number;
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Validate one realtime patch. Structural problems throw here; problems that
 * only exist relative to a batch become a `rejected` outcome in
 * {@link applyColumnarPatch}.
 */
export function createColumnarPatch(input: CreateColumnarPatchInput): ColumnarPatchV1 {
  if (typeof input !== "object" || input === null) {
    throw new HonuaColumnarPatchError("invalid-patch-state", "Columnar patch input must be an object.");
  }
  const schemaId = requireCleanString(input.schemaId, "patch.schemaId");
  const geometryKind = input.geometryKind;
  if (geometryKind !== "point" && geometryKind !== "linestring" && geometryKind !== "polygon") {
    throw new HonuaColumnarPatchError(
      "geometry-kind-drift",
      `Unsupported patch geometry kind "${String(geometryKind)}".`,
    );
  }
  const rawCursor = input.cursor;
  if (typeof rawCursor !== "object" || rawCursor === null) {
    throw new HonuaColumnarPatchError("invalid-patch-state", "patch.cursor must be an object.");
  }
  const cursor = Object.freeze({
    cursor: requireCleanString(rawCursor.cursor, "patch.cursor.cursor"),
    sequence: requireSafeCount(rawCursor.sequence, "patch.cursor.sequence"),
    observedAt: requireCleanString(rawCursor.observedAt, "patch.cursor.observedAt"),
  });
  if (Number.isNaN(Date.parse(cursor.observedAt))) {
    throw new HonuaColumnarPatchError("invalid-patch-state", "patch.cursor.observedAt must be an RFC 3339 instant.");
  }
  if (!Array.isArray(input.operations)) {
    throw new HonuaColumnarPatchError("invalid-patch-state", "patch.operations must be an array.");
  }
  const maxOperations =
    input.maxOperations === undefined
      ? DEFAULT_COLUMNAR_PATCH_MAX_OPERATIONS
      : requireSafeCount(input.maxOperations, "patch.maxOperations");
  if (input.operations.length > maxOperations) {
    throw new HonuaColumnarPatchError(
      "patch-limit-exceeded",
      `Patch carries ${input.operations.length} operations; the limit is ${maxOperations}.`,
      { operations: input.operations.length, limit: maxOperations },
    );
  }
  const operations = input.operations.map((operation, index) => normalizeOperation(operation, index));
  return Object.freeze({
    kind: COLUMNAR_PATCH_KIND,
    version: COLUMNAR_PATCH_VERSION,
    schemaId,
    geometryKind,
    cursor,
    operations: Object.freeze(operations),
  });
}

function normalizeOperation(operation: ColumnarPatchOperationV1, index: number): ColumnarPatchOperationV1 {
  if (typeof operation !== "object" || operation === null) {
    throw new HonuaColumnarPatchError("invalid-patch-state", `patch.operations[${index}] must be an object.`);
  }
  const featureId = requireUint32(operation.featureId, `patch.operations[${index}].featureId`);
  if (operation.op === "delete") return Object.freeze({ op: "delete" as const, featureId });
  if (operation.op === "append") {
    if (!("geometry" in operation)) {
      throw new HonuaColumnarPatchError(
        "invalid-patch-state",
        `patch.operations[${index}] must declare a geometry to append.`,
      );
    }
    return Object.freeze({
      op: "append" as const,
      featureId,
      geometry: operation.geometry,
      ...("timestamp" in operation ? { timestamp: assertTimestamp(operation.timestamp, index) } : {}),
      ...("dictionaryValue" in operation
        ? { dictionaryValue: assertDictionaryValue(operation.dictionaryValue, index) }
        : {}),
    });
  }
  if (operation.op === "update") {
    if (!("geometry" in operation) && !("timestamp" in operation) && !("dictionaryValue" in operation)) {
      throw new HonuaColumnarPatchError(
        "invalid-patch-state",
        `patch.operations[${index}] must declare at least one column to update.`,
      );
    }
    return Object.freeze({
      op: "update" as const,
      featureId,
      ...("geometry" in operation ? { geometry: operation.geometry } : {}),
      ...("timestamp" in operation ? { timestamp: assertTimestamp(operation.timestamp, index) } : {}),
      ...("dictionaryValue" in operation
        ? { dictionaryValue: assertDictionaryValue(operation.dictionaryValue, index) }
        : {}),
    });
  }
  throw new HonuaColumnarPatchError(
    "invalid-patch-state",
    `patch.operations[${index}].op must be "append", "update", or "delete".`,
  );
}

function assertTimestamp(value: unknown, index: number): bigint | null {
  if (value === null || typeof value === "bigint") return value as bigint | null;
  throw new HonuaColumnarPatchError(
    "invalid-patch-state",
    `patch.operations[${index}].timestamp must be a bigint or null.`,
  );
}

function assertDictionaryValue(value: unknown, index: number): string | null {
  if (value === null || typeof value === "string") return value as string | null;
  throw new HonuaColumnarPatchError(
    "invalid-patch-state",
    `patch.operations[${index}].dictionaryValue must be a string or null.`,
  );
}

/** Inclusive ascending disjoint tombstone ranges with bounded mutation. */
class TombstoneSet {
  #ranges: [number, number][];
  #count: number;

  public constructor(ranges: readonly (readonly [number, number])[] = []) {
    this.#ranges = ranges.map(([start, end]) => [start, end]);
    this.#count = this.#ranges.reduce((total, [start, end]) => total + (end - start + 1), 0);
  }

  public get count(): number {
    return this.#count;
  }

  public get ranges(): readonly (readonly [number, number])[] {
    return this.#ranges.map(([start, end]) => Object.freeze([start, end] as const));
  }

  public has(row: number): boolean {
    let low = 0;
    let high = this.#ranges.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const [start, end] = this.#ranges[middle]!;
      if (row < start) high = middle - 1;
      else if (row > end) low = middle + 1;
      else return true;
    }
    return false;
  }

  public add(row: number): void {
    if (this.has(row)) return;
    let insert = 0;
    while (insert < this.#ranges.length && this.#ranges[insert]![0] < row) insert += 1;
    this.#ranges.splice(insert, 0, [row, row]);
    this.#count += 1;
    this.#merge(insert);
  }

  #merge(index: number): void {
    if (index > 0 && this.#ranges[index - 1]![1] + 1 === this.#ranges[index]![0]) {
      this.#ranges[index - 1]![1] = this.#ranges[index]![1];
      this.#ranges.splice(index, 1);
      index -= 1;
    }
    if (index + 1 < this.#ranges.length && this.#ranges[index]![1] + 1 === this.#ranges[index + 1]![0]) {
      this.#ranges[index]![1] = this.#ranges[index + 1]![1];
      this.#ranges.splice(index + 1, 1);
    }
  }

  public encode(): string {
    return this.#ranges.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(",");
  }
}

function parseTombstones(encoded: string | undefined, rowCount: number): TombstoneSet {
  if (encoded === undefined || encoded === "") return new TombstoneSet();
  const ranges: [number, number][] = [];
  let previousEnd = -2;
  for (const token of encoded.split(",")) {
    const separator = token.indexOf("-");
    const startText = separator === -1 ? token : token.slice(0, separator);
    const endText = separator === -1 ? token : token.slice(separator + 1);
    const start = Number(startText);
    const end = Number(endText);
    if (
      !/^\d+$/.test(startText) ||
      !/^\d+$/.test(endText) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      end >= rowCount ||
      start <= previousEnd + 1
    ) {
      throw new HonuaColumnarPatchError(
        "invalid-patch-state",
        "Tombstone overlay must be ascending, disjoint, non-adjacent, and inside the batch.",
        { encoded },
      );
    }
    previousEnd = end;
    ranges.push([start, end]);
  }
  return new TombstoneSet(ranges);
}

interface ResolvedThresholds {
  readonly maxTombstoneRatio: number;
  readonly maxTombstoneOverlayBytes: number;
  readonly maxCapacityUtilization: number;
  readonly maxVertexGrowthRatio: number;
}

function resolveThresholds(thresholds: ColumnarPatchThresholds = {}): ResolvedThresholds {
  const ratio = (value: number | undefined, fallback: number, name: string): number => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new HonuaColumnarPatchError("invalid-patch-state", `thresholds.${name} must be a non-negative number.`);
    }
    return value;
  };
  return Object.freeze({
    maxTombstoneRatio: ratio(
      thresholds.maxTombstoneRatio,
      DEFAULT_COLUMNAR_PATCH_MAX_TOMBSTONE_RATIO,
      "maxTombstoneRatio",
    ),
    maxTombstoneOverlayBytes: ratio(
      thresholds.maxTombstoneOverlayBytes,
      DEFAULT_COLUMNAR_PATCH_MAX_TOMBSTONE_OVERLAY_BYTES,
      "maxTombstoneOverlayBytes",
    ),
    maxCapacityUtilization: ratio(
      thresholds.maxCapacityUtilization,
      DEFAULT_COLUMNAR_PATCH_MAX_CAPACITY_UTILIZATION,
      "maxCapacityUtilization",
    ),
    maxVertexGrowthRatio: ratio(
      thresholds.maxVertexGrowthRatio,
      DEFAULT_COLUMNAR_PATCH_MAX_VERTEX_GROWTH_RATIO,
      "maxVertexGrowthRatio",
    ),
  });
}

function dimensionNames(dimensions: GeoArrowDimensions): readonly ("x" | "y" | "z" | "m")[] {
  switch (dimensions) {
    case "xy":
      return ["x", "y"];
    case "xyz":
      return ["x", "y", "z"];
    case "xym":
      return ["x", "y", "m"];
    default:
      return ["x", "y", "z", "m"];
  }
}

function descriptorMap(batch: ColumnarBatchV1): ReadonlyMap<string, ColumnarBufferV1> {
  return new Map(batch.buffers.map((buffer) => [buffer.id, buffer]));
}

/** Spare bytes between a descriptor's declared slice and the end of its backing. */
function spareBytes(buffer: ColumnarBufferV1 | undefined): number {
  if (!buffer) return Number.POSITIVE_INFINITY;
  return buffer.data.byteLength - (buffer.byteOffset + buffer.byteLength);
}

/**
 * Everything needed to compute remaining capacity without re-validating the
 * batch: field names, geometry shape, row count, and buffer descriptors.
 */
interface CapacityContext {
  readonly kind: GeoArrowGeometryKind;
  readonly names: readonly ("x" | "y" | "z" | "m")[];
  readonly coordinateLayout: "interleaved" | "separated";
  readonly geometryField: string;
  readonly temporalField?: string;
  readonly dictionaryField?: string;
  readonly featureIdField?: string;
  readonly rows: number;
  readonly descriptors: ReadonlyMap<string, ColumnarBufferV1>;
}

interface Layout extends CapacityContext {
  readonly inspection: GeoArrowBatchInspection;
  readonly vertices: number;
  readonly rings: number;
}

function readLayout(batch: ColumnarBatchV1, limits: GeoArrowConversionLimits): Layout {
  const inspection = inspectGeoArrowBatch(batch, limits);
  return {
    inspection,
    kind: inspection.geometry.kind,
    names: dimensionNames(inspection.geometry.dimensions),
    coordinateLayout: inspection.geometry.coordinateLayout,
    geometryField: inspection.geometry.field,
    ...(inspection.temporal === undefined ? {} : { temporalField: inspection.temporal.field }),
    ...(inspection.dictionary === undefined ? {} : { dictionaryField: inspection.dictionary.field }),
    ...(inspection.featureIds === undefined ? {} : { featureIdField: inspection.featureIds.field }),
    rows: inspection.batch.rowCount,
    vertices: inspection.metrics.vertices,
    rings: inspection.metrics.rings,
    descriptors: descriptorMap(inspection.batch),
  };
}

/** Remaining append capacity, derived from the batch's own allocations. */
function remainingCapacity(context: CapacityContext): ColumnarPatchCapacityV1 {
  const geometryField = context.geometryField;
  const rowLimits: number[] = [];
  const validityRows = (id: string): void => {
    const descriptor = context.descriptors.get(id);
    if (descriptor) rowLimits.push((descriptor.data.byteLength - descriptor.byteOffset) * 8 - context.rows);
  };
  validityRows(`${geometryField}.validity`);
  if (context.kind !== "point") {
    rowLimits.push(Math.floor(spareBytes(context.descriptors.get(`${geometryField}.offsets`)) / 4));
  }
  if (context.temporalField !== undefined) {
    rowLimits.push(Math.floor(spareBytes(context.descriptors.get(`${context.temporalField}.values`)) / 8));
    validityRows(`${context.temporalField}.validity`);
  }
  if (context.dictionaryField !== undefined) {
    rowLimits.push(Math.floor(spareBytes(context.descriptors.get(`${context.dictionaryField}.indices`)) / 4));
    validityRows(`${context.dictionaryField}.validity`);
  }
  if (context.featureIdField !== undefined) {
    rowLimits.push(Math.floor(spareBytes(context.descriptors.get(`${context.featureIdField}.values`)) / 4));
  }
  const coordinateSpare =
    context.coordinateLayout === "interleaved"
      ? Math.floor(spareBytes(context.descriptors.get(`${geometryField}.coordinates`)) / (8 * context.names.length))
      : Math.min(
          ...context.names.map((name) =>
            Math.floor(spareBytes(context.descriptors.get(`${geometryField}.${name}`)) / 8),
          ),
        );
  const rings =
    context.kind === "polygon"
      ? Math.floor(spareBytes(context.descriptors.get(`${geometryField}.ring-offsets`)) / 4)
      : 0;
  if (context.kind === "point") rowLimits.push(coordinateSpare);
  const rows = rowLimits.length === 0 ? coordinateSpare : Math.max(0, Math.min(...rowLimits));
  return Object.freeze({
    rows: Number.isFinite(rows) ? rows : 0,
    vertices: context.kind === "point" ? rows : Math.max(0, coordinateSpare),
    rings: Math.max(0, rings),
  });
}

function buildState(
  metadata: Readonly<Record<string, string>>,
  context: CapacityContext,
  vertices: number,
  rings: number,
): ColumnarPatchStateV1 {
  const declared = metadata[META.version];
  if (declared !== undefined && declared !== HONUA_COLUMNAR_PATCH_LAYOUT_VERSION) {
    throw new HonuaColumnarPatchError(
      "invalid-patch-state",
      `Batch declares columnar patch layout "${declared}"; this build implements ${HONUA_COLUMNAR_PATCH_LAYOUT_VERSION}.`,
    );
  }
  const tombstones = parseTombstones(metadata[META.tombstones], context.rows);
  const number = (key: string, fallback: number): number => {
    const value = metadata[key];
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
      throw new HonuaColumnarPatchError(
        "invalid-patch-state",
        `Patch metadata "${key}" must be a non-negative integer.`,
      );
    }
    return parsed;
  };
  const capacity = remainingCapacity(context);
  const sequence = metadata[META.sequence] === undefined ? undefined : number(META.sequence, 0);
  const encoded = tombstones.encode();
  return Object.freeze({
    layoutVersion: HONUA_COLUMNAR_PATCH_LAYOUT_VERSION,
    rowCount: context.rows,
    liveRowCount: context.rows - tombstones.count,
    tombstoneCount: tombstones.count,
    tombstoneRatio: context.rows === 0 ? 0 : tombstones.count / context.rows,
    tombstoneRanges: Object.freeze(tombstones.ranges),
    tombstoneOverlayBytes: utf8Length(encoded),
    ...(sequence === undefined ? {} : { sequence }),
    ...(metadata[META.cursor] === undefined ? {} : { cursor: metadata[META.cursor]! }),
    ...(metadata[META.observedAt] === undefined ? {} : { observedAt: metadata[META.observedAt]! }),
    generation: number(META.generation, 0),
    vertices,
    rings,
    baseRows: number(META.baseRows, context.rows),
    baseVertices: number(META.baseVertices, vertices),
    reserve: Object.freeze({
      rows: number(META.reserveRows, capacity.rows),
      vertices: number(META.reserveVertices, capacity.vertices),
      rings: number(META.reserveRings, capacity.rings),
    }),
    capacity,
  });
}

function readState(batch: ColumnarBatchV1, layout: Layout): ColumnarPatchStateV1 {
  return buildState(batch.schema.metadata ?? {}, layout, layout.vertices, layout.rings);
}

/**
 * Read the patch overlay a batch carries. A batch that has never been patched
 * reports an empty overlay and whatever capacity its allocations already hold.
 */
export function inspectColumnarPatchState(
  batch: ColumnarBatchV1,
  limits: GeoArrowConversionLimits = {},
): ColumnarPatchStateV1 {
  return readState(batch, readLayout(batch, limits));
}

/**
 * A per-row liveness mask for renderers: `1` for a live row, `0` for a
 * tombstoned one. Bind it as a filter attribute so a deleted feature stops
 * drawing without waiting for the rebuild that physically removes it.
 */
export function columnarPatchLiveMask(state: ColumnarPatchStateV1): Uint8Array {
  const mask = new Uint8Array(state.rowCount).fill(1);
  for (const [start, end] of state.tombstoneRanges) mask.fill(0, start, end + 1);
  return mask;
}

/**
 * Materialize the live rows of a patched batch in row order. A tombstoned row
 * is never returned, and an updated value is the value that is returned,
 * because the update was written over the row it belongs to.
 */
export function decodePatchedGeoArrowBatch(
  batch: ColumnarBatchV1,
  limits: GeoArrowConversionLimits = {},
): DecodedPatchedGeoArrowBatch {
  const layout = readLayout(batch, limits);
  const state = readState(batch, layout);
  const decoded = decodeGeoArrowBatch(batch, limits);
  const mask = columnarPatchLiveMask(state);
  const rows: DecodedGeoArrowRow[] = [];
  for (let row = 0; row < decoded.rows.length; row += 1) if (mask[row] === 1) rows.push(decoded.rows[row]!);
  return Object.freeze({
    rows: Object.freeze(rows),
    state,
    metrics: Object.freeze({
      rows: layout.rows,
      tombstonedRows: state.tombstoneCount,
      materializedRows: rows.length,
    }),
  });
}

interface ReservePlan {
  readonly rows: number;
  readonly vertices: number;
  readonly rings: number;
}

function resolveReserve(reserve: ColumnarPatchReserveV1, kind: GeoArrowGeometryKind): ReservePlan {
  if (typeof reserve !== "object" || reserve === null) {
    throw new HonuaColumnarPatchError("invalid-patch-state", "reserve must be an object.");
  }
  const rows = requireSafeCount(reserve.rows, "reserve.rows");
  const vertices =
    kind === "point"
      ? rows
      : reserve.vertices === undefined
        ? 0
        : requireSafeCount(reserve.vertices, "reserve.vertices");
  const rings =
    kind === "polygon" ? (reserve.rings === undefined ? 0 : requireSafeCount(reserve.rings, "reserve.rings")) : 0;
  return { rows, vertices, rings };
}

/** Extra backing bytes each normative buffer needs to hold the declared reserve. */
function reserveBytesFor(buffer: ColumnarBufferV1, layout: Layout, reserve: ReservePlan): number {
  const geometry = layout.inspection.geometry;
  const suffix = buffer.id.slice(buffer.id.lastIndexOf(".") + 1);
  if (buffer.field === geometry.field) {
    if (suffix === "validity") {
      return Math.ceil((layout.rows + reserve.rows) / 8) - Math.ceil(layout.rows / 8);
    }
    if (buffer.id.endsWith(".ring-offsets")) return reserve.rings * 4;
    if (suffix === "offsets") return reserve.rows * 4;
    if (suffix === "coordinates") return reserve.vertices * layout.names.length * 8;
    return reserve.vertices * 8;
  }
  if (suffix === "validity") return Math.ceil((layout.rows + reserve.rows) / 8) - Math.ceil(layout.rows / 8);
  if (layout.inspection.temporal && buffer.field === layout.inspection.temporal.field) return reserve.rows * 8;
  if (layout.inspection.dictionary && buffer.field === layout.inspection.dictionary.field) {
    return suffix === "indices" ? reserve.rows * 4 : 0;
  }
  return reserve.rows * 4;
}

/** Re-home every payload buffer into a backing that carries the declared reserve. */
function reserveCapacity(
  batch: ColumnarBatchV1,
  reserve: ReservePlan,
  patchMetadata: Readonly<Record<string, string>>,
  limits: GeoArrowConversionLimits,
): { readonly batch: ColumnarBatchV1; readonly reservedBytes: number } {
  const layout = readLayout(batch, limits);
  let reservedBytes = 0;
  const buffers = batch.buffers.map((buffer) => {
    const extra = reserveBytesFor(buffer, layout, reserve);
    reservedBytes += extra;
    const backing = new ArrayBuffer(buffer.byteLength + extra);
    new Uint8Array(backing).set(new Uint8Array(buffer.data, buffer.byteOffset, buffer.byteLength));
    return {
      id: buffer.id,
      role: buffer.role,
      ...(buffer.field === undefined ? {} : { field: buffer.field }),
      data: backing,
      byteOffset: 0,
      byteLength: buffer.byteLength,
    };
  });
  return {
    batch: createColumnarBatch(
      {
        id: batch.id,
        schema: { ...batch.schema, metadata: withPatchMetadata(batch.schema.metadata, patchMetadata) },
        rowCount: batch.rowCount,
        sequence: batch.sequence,
        ...(batch.rowOffset === undefined ? {} : { rowOffset: batch.rowOffset }),
        ...(batch.identity === undefined ? {} : { identity: batch.identity }),
        buffers,
      },
      limits,
    ),
    reservedBytes,
  };
}

/**
 * Replace the patch overlay wholesale rather than merging it. A compacted
 * rebuild carries no tombstones, and a surviving stale range would silently
 * hide a live row.
 */
function withPatchMetadata(
  metadata: Readonly<Record<string, string>> | undefined,
  patchMetadata: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged: Record<string, string> = { ...metadata };
  for (const key of Object.values(META)) delete merged[key];
  return { ...merged, ...patchMetadata };
}

function patchMetadataFor(options: {
  readonly baseRows: number;
  readonly baseVertices: number;
  readonly reserve: ReservePlan;
  readonly generation: number;
  readonly tombstones: string;
  readonly cursor?: ColumnarPatchCursorV1;
}): Readonly<Record<string, string>> {
  return {
    [META.version]: HONUA_COLUMNAR_PATCH_LAYOUT_VERSION,
    [META.generation]: String(options.generation),
    [META.baseRows]: String(options.baseRows),
    [META.baseVertices]: String(options.baseVertices),
    [META.reserveRows]: String(options.reserve.rows),
    [META.reserveVertices]: String(options.reserve.vertices),
    [META.reserveRings]: String(options.reserve.rings),
    ...(options.tombstones === "" ? {} : { [META.tombstones]: options.tombstones }),
    ...(options.cursor === undefined
      ? {}
      : {
          [META.sequence]: String(options.cursor.sequence),
          [META.cursor]: options.cursor.cursor,
          [META.observedAt]: options.cursor.observedAt,
        }),
  };
}

/**
 * Convert semantic GeoArrow input into a batch that carries explicitly declared
 * spare capacity, so later appends can be written without reallocating a
 * backing buffer. The reserve is never implicit: a batch created through
 * `createGeoArrowBatch` has none and rebuilds on its first append.
 */
export function createPatchableGeoArrowBatch(
  input: CreateGeoArrowBatchInput,
  options: CreatePatchableGeoArrowBatchOptions,
): CreatedPatchableGeoArrowBatch {
  if (typeof options !== "object" || options === null) {
    throw new HonuaColumnarPatchError("invalid-patch-state", "Patchable batch options must be an object.");
  }
  const limits = { ...options } as GeoArrowConversionLimits & { reserve?: ColumnarPatchReserveV1 };
  delete limits.reserve;
  const created = createGeoArrowBatch(input, limits);
  const layout = readLayout(created.batch, limits);
  const reserve = resolveReserve(options.reserve, layout.kind);
  const metadata = patchMetadataFor({
    baseRows: layout.rows,
    baseVertices: layout.vertices,
    reserve,
    generation: 0,
    tombstones: "",
  });
  const reserved = reserveCapacity(created.batch, reserve, metadata, limits);
  const reservedLayout = readLayout(reserved.batch, limits);
  return Object.freeze({
    batch: reserved.batch,
    state: readState(reserved.batch, reservedLayout),
    metrics: Object.freeze({
      rows: created.metrics.rows,
      vertices: created.metrics.vertices,
      rings: created.metrics.rings,
      copiedBytes: created.metrics.copiedBytes,
      backingBytes: created.metrics.backingBytes + reserved.reservedBytes,
      reservedBytes: reserved.reservedBytes,
    }),
  });
}

interface FeatureIdIndexEntry {
  rows: number;
  readonly index: Map<number, number>;
}

const featureIdIndexCache = new WeakMap<ArrayBuffer, FeatureIdIndexEntry>();

/**
 * Feature-id to row index, cached per feature-id backing buffer. Feature ids
 * are immutable row identity, so the cache is extended for appended rows rather
 * than rebuilt, which keeps patch cost proportional to the patch.
 */
function featureIdIndex(values: Uint32Array, backing: ArrayBuffer): Map<number, number> {
  let entry = featureIdIndexCache.get(backing);
  if (!entry || entry.rows > values.length) {
    entry = { rows: 0, index: new Map<number, number>() };
    featureIdIndexCache.set(backing, entry);
  }
  for (let row = entry.rows; row < values.length; row += 1) entry.index.set(values[row]!, row);
  entry.rows = values.length;
  return entry.index;
}

interface PlannedGeometry {
  readonly isNull: boolean;
  readonly positions: readonly GeoArrowPosition[];
  readonly ringSizes: readonly number[];
  readonly vertices: number;
  readonly rings: number;
}

const NULL_POINT_GEOMETRY = (names: number): PlannedGeometry => ({
  isNull: true,
  positions: [Object.freeze(new Array<number>(names).fill(0))],
  ringSizes: [],
  vertices: 1,
  rings: 0,
});

function planGeometry(
  value: ColumnarPatchGeometry,
  kind: GeoArrowGeometryKind,
  names: readonly string[],
  label: string,
): PlannedGeometry {
  if (value === null) {
    return kind === "point"
      ? NULL_POINT_GEOMETRY(names.length)
      : { isNull: true, positions: [], ringSizes: [], vertices: 0, rings: 0 };
  }
  if (!Array.isArray(value)) {
    throw new HonuaColumnarPatchError("invalid-geometry", `${label} must be an array or null.`);
  }
  if (kind === "point") {
    return { isNull: false, positions: [planPosition(value, names, label)], ringSizes: [], vertices: 1, rings: 0 };
  }
  if (kind === "linestring") {
    const positions = (value as readonly unknown[]).map((position, index) =>
      planPosition(position, names, `${label}[${index}]`),
    );
    return { isNull: false, positions, ringSizes: [], vertices: positions.length, rings: 0 };
  }
  const positions: GeoArrowPosition[] = [];
  const ringSizes: number[] = [];
  (value as readonly unknown[]).forEach((ring, ringIndex) => {
    if (!Array.isArray(ring)) {
      throw new HonuaColumnarPatchError("invalid-geometry", `${label}[${ringIndex}] must be an array.`);
    }
    if (ring.length !== 0 && ring.length < 4) {
      throw new HonuaColumnarPatchError(
        "invalid-geometry",
        `${label}[${ringIndex}] must be empty or contain at least four positions.`,
      );
    }
    const ringPositions = ring.map((position, index) =>
      planPosition(position, names, `${label}[${ringIndex}][${index}]`),
    );
    if (
      ringPositions.length > 0 &&
      !ringPositions[0]!.every((coordinate, index) => coordinate === ringPositions[ringPositions.length - 1]![index])
    ) {
      throw new HonuaColumnarPatchError("invalid-geometry", `${label}[${ringIndex}] must be closed.`);
    }
    ringSizes.push(ringPositions.length);
    positions.push(...ringPositions);
  });
  return { isNull: false, positions, ringSizes, vertices: positions.length, rings: ringSizes.length };
}

function planPosition(value: unknown, names: readonly string[], label: string): GeoArrowPosition {
  if (!Array.isArray(value) || value.length !== names.length) {
    throw new HonuaColumnarPatchError(
      "invalid-geometry",
      `${label} must contain ${names.length} coordinates (${names.join(", ")}).`,
    );
  }
  for (const coordinate of value) {
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
      throw new HonuaColumnarPatchError("invalid-geometry", `${label} must contain finite numbers.`);
    }
  }
  return Object.freeze([...(value as readonly number[])]);
}

interface PlannedAppend {
  readonly featureId: number;
  readonly geometry: PlannedGeometry;
  readonly timestamp: bigint | null;
  readonly dictionaryValue: string | null;
  readonly dictionaryIndex: number | null;
}

interface PlannedUpdate {
  readonly row: number;
  readonly featureId: number;
  readonly geometry?: PlannedGeometry;
  readonly timestamp?: bigint | null;
  readonly dictionaryValue?: string | null;
  readonly dictionaryIndex?: number | null;
}

interface PatchPlan {
  readonly appends: readonly PlannedAppend[];
  readonly updates: readonly PlannedUpdate[];
  readonly updatesByRow: ReadonlyMap<number, PlannedUpdate>;
  readonly deletes: readonly number[];
  readonly tombstones: TombstoneSet;
  readonly appendedVertices: number;
  readonly appendedRings: number;
  /** Set when the patch cannot be expressed in the current layout. */
  readonly layoutBlocked: boolean;
  readonly layoutBlockedReason?: string;
  readonly newDictionaryValues: readonly string[];
}

function decodeDictionaryValues(inspection: GeoArrowBatchInspection): Map<string, number> {
  const dictionary = inspection.dictionary;
  const byValue = new Map<string, number>();
  if (!dictionary) return byValue;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let index = 0; index < dictionary.offsets.length - 1; index += 1) {
    const value = decoder.decode(dictionary.values.subarray(dictionary.offsets[index], dictionary.offsets[index + 1]));
    if (!byValue.has(value)) byValue.set(value, index);
  }
  return byValue;
}

function bitSet(validity: Uint8Array | undefined, row: number): boolean {
  return validity === undefined || (validity[row >> 3]! & (1 << (row & 7))) !== 0;
}

function rowVertexSpan(inspection: GeoArrowBatchInspection, row: number): { vertices: number; rings: number } {
  const geometry = inspection.geometry;
  if (geometry.kind === "point") return { vertices: 1, rings: 0 };
  const start = geometry.offsets![row]!;
  const end = geometry.offsets![row + 1]!;
  if (geometry.kind === "linestring") return { vertices: end - start, rings: 0 };
  return { vertices: geometry.ringOffsets![end]! - geometry.ringOffsets![start]!, rings: end - start };
}

/**
 * Validate the whole patch against the batch before a byte moves. Every
 * rejection returns here; nothing below this point can fail partway through.
 */
function planPatch(
  batch: ColumnarBatchV1,
  patch: ColumnarPatchV1,
  layout: Layout,
  state: ColumnarPatchStateV1,
): PatchPlan | ColumnarPatchRejectedV1 {
  const inspection = layout.inspection;
  const featureIds = inspection.featureIds;
  if (!featureIds) {
    return reject(
      "missing-feature-id-column",
      "A patchable batch must declare a feature-id column; row position is not stable identity.",
      batch,
    );
  }
  const index = featureIdIndex(featureIds.values, layout.descriptors.get(`${featureIds.field}.values`)!.data);
  const tombstones = new TombstoneSet(state.tombstoneRanges);
  const orderingKeys = new Set((batch.identity?.ordering.keys ?? []).map((key) => key.field));
  const dictionaryByValue =
    inspection.dictionary === undefined ? new Map<string, number>() : decodeDictionaryValues(inspection);
  const appends: PlannedAppend[] = [];
  const updates: PlannedUpdate[] = [];
  const updatesByRow = new Map<number, PlannedUpdate>();
  const deletes: number[] = [];
  const touched = new Set<number>();
  const newDictionaryValues: string[] = [];
  let appendedVertices = 0;
  let appendedRings = 0;
  let layoutBlocked = false;
  let layoutBlockedReason: string | undefined;
  const block = (reason: string): void => {
    if (!layoutBlocked) {
      layoutBlocked = true;
      layoutBlockedReason = reason;
    }
  };

  for (const operation of patch.operations) {
    if (touched.has(operation.featureId)) {
      return reject(
        "duplicate-feature-id",
        `Feature ${operation.featureId} carries more than one operation in one patch.`,
        batch,
        { featureId: operation.featureId },
      );
    }
    touched.add(operation.featureId);

    if (operation.op === "append") {
      if (orderingKeys.size > 0) {
        return reject(
          "ordering-conflict",
          "Appending to a batch whose identity declares sort keys would break the declared order.",
          batch,
          { keys: [...orderingKeys] },
        );
      }
      const existingRow = index.get(operation.featureId);
      if (existingRow !== undefined && existingRow < layout.rows) {
        if (!tombstones.has(existingRow)) {
          return reject("duplicate-feature-id", `Feature ${operation.featureId} already exists in the batch.`, batch, {
            featureId: operation.featureId,
            row: existingRow,
          });
        }
        // Re-creating a deleted id is legal, but two rows may not carry one id:
        // the compacting rebuild is what frees the tombstoned row's identity.
        block("re-creating a tombstoned feature id needs a compacting rebuild");
      }
      if (inspection.temporal && operation.timestamp === undefined) {
        return reject(
          "incomplete-append",
          `Append of feature ${operation.featureId} omits the batch's temporal column.`,
          batch,
          { featureId: operation.featureId, column: inspection.temporal.field },
        );
      }
      if (inspection.dictionary && operation.dictionaryValue === undefined) {
        return reject(
          "incomplete-append",
          `Append of feature ${operation.featureId} omits the batch's dictionary column.`,
          batch,
          { featureId: operation.featureId, column: inspection.dictionary.field },
        );
      }
      let geometry: PlannedGeometry;
      try {
        geometry = planGeometry(operation.geometry, layout.kind, layout.names, `append(${operation.featureId})`);
      } catch (cause) {
        if (cause instanceof HonuaColumnarPatchError) return reject(cause.code, cause.message, batch, cause.detail);
        throw cause;
      }
      if (geometry.isNull && inspection.geometry.validity === undefined) {
        block("appending a null geometry needs a validity buffer the batch does not declare");
      }
      const timestamp = operation.timestamp ?? null;
      if (timestamp === null && inspection.temporal && inspection.temporal.validity === undefined) {
        block("appending a null timestamp needs a validity buffer the batch does not declare");
      }
      const dictionaryValue = operation.dictionaryValue ?? null;
      let dictionaryIndex: number | null = null;
      if (inspection.dictionary) {
        if (dictionaryValue === null) {
          if (inspection.dictionary.validity === undefined) {
            block("appending a null dictionary value needs a validity buffer the batch does not declare");
          }
        } else {
          const existing = dictionaryByValue.get(dictionaryValue);
          if (existing === undefined) {
            block("appending an unseen dictionary value needs a larger dictionary");
            if (!newDictionaryValues.includes(dictionaryValue)) newDictionaryValues.push(dictionaryValue);
          } else dictionaryIndex = existing;
        }
      }
      appends.push({ featureId: operation.featureId, geometry, timestamp, dictionaryValue, dictionaryIndex });
      appendedVertices += geometry.vertices;
      appendedRings += geometry.rings;
      continue;
    }

    const row = index.get(operation.featureId);
    if (row === undefined || row >= layout.rows) {
      return reject("unknown-feature-id", `Feature ${operation.featureId} is not present in the batch.`, batch, {
        featureId: operation.featureId,
      });
    }
    if (tombstones.has(row)) {
      return reject("deleted-feature-id", `Feature ${operation.featureId} is already tombstoned.`, batch, {
        featureId: operation.featureId,
        row,
      });
    }
    if (operation.op === "delete") {
      deletes.push(row);
      tombstones.add(row);
      continue;
    }

    const update: {
      row: number;
      featureId: number;
      geometry?: PlannedGeometry;
      timestamp?: bigint | null;
      dictionaryValue?: string | null;
      dictionaryIndex?: number | null;
    } = { row, featureId: operation.featureId };
    if ("geometry" in operation) {
      if (orderingKeys.has(inspection.geometry.field)) {
        return reject("ordering-conflict", "Updating a declared sort key would break the declared order.", batch, {
          field: inspection.geometry.field,
        });
      }
      let geometry: PlannedGeometry;
      try {
        geometry = planGeometry(
          operation.geometry as ColumnarPatchGeometry,
          layout.kind,
          layout.names,
          `update(${operation.featureId})`,
        );
      } catch (cause) {
        if (cause instanceof HonuaColumnarPatchError) return reject(cause.code, cause.message, batch, cause.detail);
        throw cause;
      }
      const span = rowVertexSpan(inspection, row);
      if (geometry.vertices !== span.vertices || geometry.rings !== span.rings) {
        block("an update that changes a row's vertex or ring count moves every later row");
      }
      if (
        geometry.isNull !== !bitSet(inspection.geometry.validity, row) &&
        inspection.geometry.validity === undefined
      ) {
        block("changing geometry nullability needs a validity buffer the batch does not declare");
      }
      update.geometry = geometry;
    }
    if ("timestamp" in operation) {
      if (!inspection.temporal) {
        return reject("schema-drift", "The patch updates a temporal column the batch does not declare.", batch);
      }
      if (orderingKeys.has(inspection.temporal.field)) {
        return reject("ordering-conflict", "Updating a declared sort key would break the declared order.", batch, {
          field: inspection.temporal.field,
        });
      }
      const timestamp = operation.timestamp ?? null;
      if (timestamp === null && inspection.temporal.validity === undefined) {
        block("writing a null timestamp needs a validity buffer the batch does not declare");
      }
      update.timestamp = timestamp;
    }
    if ("dictionaryValue" in operation) {
      if (!inspection.dictionary) {
        return reject("schema-drift", "The patch updates a dictionary column the batch does not declare.", batch);
      }
      if (orderingKeys.has(inspection.dictionary.field)) {
        return reject("ordering-conflict", "Updating a declared sort key would break the declared order.", batch, {
          field: inspection.dictionary.field,
        });
      }
      const value = operation.dictionaryValue ?? null;
      update.dictionaryValue = value;
      if (value === null) {
        if (inspection.dictionary.validity === undefined) {
          block("writing a null dictionary value needs a validity buffer the batch does not declare");
        }
        update.dictionaryIndex = null;
      } else {
        const existing = dictionaryByValue.get(value);
        if (existing === undefined) {
          block("writing an unseen dictionary value needs a larger dictionary");
          if (!newDictionaryValues.includes(value)) newDictionaryValues.push(value);
        } else update.dictionaryIndex = existing;
      }
    }
    updates.push(update);
    updatesByRow.set(row, update);
  }

  return {
    appends,
    updates,
    updatesByRow,
    deletes,
    tombstones,
    appendedVertices,
    appendedRings,
    layoutBlocked,
    ...(layoutBlockedReason === undefined ? {} : { layoutBlockedReason }),
    newDictionaryValues,
  };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
}

interface WriteAccounting {
  bytes: number;
}

function writeValidityBit(
  descriptor: ColumnarBufferV1,
  row: number,
  valid: boolean,
  accounting: WriteAccounting,
): void {
  const bytes = new Uint8Array(descriptor.data, descriptor.byteOffset);
  const byte = row >> 3;
  const mask = 1 << (row & 7);
  if (valid) bytes[byte]! |= mask;
  else bytes[byte]! &= ~mask;
  accounting.bytes += 1;
}

/**
 * Write appended rows and updated values into the batch's existing backings and
 * return the descriptors for the grown slices. Nothing here can fail: every
 * bound was proven in {@link planPatch} and the capacity check.
 */
function applyInPlace(
  layout: Layout,
  plan: PatchPlan,
  accounting: WriteAccounting,
): { readonly buffers: readonly ColumnarBufferV1[]; readonly vertices: number; readonly rings: number } {
  const inspection = layout.inspection;
  const geometry = inspection.geometry;
  const descriptors = new Map(layout.descriptors);
  const appended = plan.appends.length;
  const rows = layout.rows;
  const names = layout.names;

  const grow = (id: string, byteLength: number): ColumnarBufferV1 => {
    const descriptor = descriptors.get(id)!;
    const grown = { ...descriptor, byteLength };
    descriptors.set(id, grown);
    return grown;
  };

  // Updates first: they only rewrite bytes that already belong to the batch.
  for (const update of plan.updates) {
    if (update.geometry) {
      const start =
        geometry.kind === "point"
          ? update.row
          : geometry.kind === "linestring"
            ? geometry.offsets![update.row]!
            : geometry.ringOffsets![geometry.offsets![update.row]!]!;
      writePositions(layout, start, update.geometry.positions, accounting);
      if (geometry.kind === "polygon" && update.geometry.ringSizes.length > 0) {
        let vertex = start;
        let ring = geometry.offsets![update.row]!;
        for (const size of update.geometry.ringSizes) {
          geometry.ringOffsets![ring] = vertex;
          accounting.bytes += 4;
          vertex += size;
          ring += 1;
        }
      }
      if (geometry.validity) {
        writeValidityBit(
          descriptors.get(`${geometry.field}.validity`)!,
          update.row,
          !update.geometry.isNull,
          accounting,
        );
      }
    }
    if (update.timestamp !== undefined && inspection.temporal) {
      inspection.temporal.values[update.row] = update.timestamp ?? 0n;
      accounting.bytes += 8;
      if (inspection.temporal.validity) {
        writeValidityBit(
          descriptors.get(`${inspection.temporal.field}.validity`)!,
          update.row,
          update.timestamp !== null,
          accounting,
        );
      }
    }
    if (update.dictionaryValue !== undefined && inspection.dictionary) {
      inspection.dictionary.indices[update.row] = update.dictionaryIndex ?? 0;
      accounting.bytes += 4;
      if (inspection.dictionary.validity) {
        writeValidityBit(
          descriptors.get(`${inspection.dictionary.field}.validity`)!,
          update.row,
          update.dictionaryValue !== null,
          accounting,
        );
      }
    }
  }

  if (appended === 0) return { buffers: [...descriptors.values()], vertices: layout.vertices, rings: layout.rings };

  // Appends: written past every declared slice, then the slices are grown.
  let vertex = layout.vertices;
  let ring = layout.rings;
  const offsetsDescriptor = geometry.kind === "point" ? undefined : descriptors.get(`${geometry.field}.offsets`)!;
  const offsets =
    offsetsDescriptor === undefined
      ? undefined
      : new Int32Array(offsetsDescriptor.data, offsetsDescriptor.byteOffset, rows + appended + 1);
  const ringOffsetsDescriptor =
    geometry.kind === "polygon" ? descriptors.get(`${geometry.field}.ring-offsets`)! : undefined;
  const ringOffsets =
    ringOffsetsDescriptor === undefined
      ? undefined
      : new Int32Array(ringOffsetsDescriptor.data, ringOffsetsDescriptor.byteOffset, ring + plan.appendedRings + 1);
  const temporalDescriptor =
    inspection.temporal === undefined ? undefined : descriptors.get(`${inspection.temporal.field}.values`)!;
  const temporalValues =
    temporalDescriptor === undefined
      ? undefined
      : new BigInt64Array(temporalDescriptor.data, temporalDescriptor.byteOffset, rows + appended);
  const dictionaryDescriptor =
    inspection.dictionary === undefined ? undefined : descriptors.get(`${inspection.dictionary.field}.indices`)!;
  const dictionaryIndices =
    dictionaryDescriptor === undefined
      ? undefined
      : new Int32Array(dictionaryDescriptor.data, dictionaryDescriptor.byteOffset, rows + appended);
  const featureIdDescriptor = descriptors.get(`${inspection.featureIds!.field}.values`)!;
  const featureIdValues = new Uint32Array(featureIdDescriptor.data, featureIdDescriptor.byteOffset, rows + appended);

  plan.appends.forEach((append, offset) => {
    const row = rows + offset;
    if (offsets) {
      offsets[row + 1] = geometry.kind === "polygon" ? ring + append.geometry.rings : vertex + append.geometry.vertices;
      accounting.bytes += 4;
    }
    if (ringOffsets) {
      let ringVertex = vertex;
      for (const size of append.geometry.ringSizes) {
        ringOffsets[ring] = ringVertex;
        accounting.bytes += 4;
        ringVertex += size;
        ring += 1;
      }
      ringOffsets[ring] = ringVertex;
      accounting.bytes += 4;
    }
    writePositions(layout, vertex, append.geometry.positions, accounting);
    vertex += append.geometry.vertices;
    if (geometry.validity) {
      writeValidityBit(descriptors.get(`${geometry.field}.validity`)!, row, !append.geometry.isNull, accounting);
    }
    if (temporalValues) {
      temporalValues[row] = append.timestamp ?? 0n;
      accounting.bytes += 8;
      if (inspection.temporal!.validity) {
        writeValidityBit(
          descriptors.get(`${inspection.temporal!.field}.validity`)!,
          row,
          append.timestamp !== null,
          accounting,
        );
      }
    }
    if (dictionaryIndices) {
      dictionaryIndices[row] = append.dictionaryIndex ?? 0;
      accounting.bytes += 4;
      if (inspection.dictionary!.validity) {
        writeValidityBit(
          descriptors.get(`${inspection.dictionary!.field}.validity`)!,
          row,
          append.dictionaryValue !== null,
          accounting,
        );
      }
    }
    featureIdValues[row] = append.featureId;
    accounting.bytes += 4;
  });

  const newRows = rows + appended;
  if (geometry.validity) grow(`${geometry.field}.validity`, Math.ceil(newRows / 8));
  if (offsets) grow(`${geometry.field}.offsets`, (newRows + 1) * 4);
  if (ringOffsets) grow(`${geometry.field}.ring-offsets`, (ring + 1) * 4);
  if (geometry.coordinateLayout === "interleaved") {
    grow(`${geometry.field}.coordinates`, vertex * names.length * 8);
  } else for (const name of names) grow(`${geometry.field}.${name}`, vertex * 8);
  if (inspection.temporal) {
    grow(`${inspection.temporal.field}.values`, newRows * 8);
    if (inspection.temporal.validity) grow(`${inspection.temporal.field}.validity`, Math.ceil(newRows / 8));
  }
  if (inspection.dictionary) {
    grow(`${inspection.dictionary.field}.indices`, newRows * 4);
    if (inspection.dictionary.validity) grow(`${inspection.dictionary.field}.validity`, Math.ceil(newRows / 8));
  }
  grow(`${inspection.featureIds!.field}.values`, newRows * 4);
  return { buffers: [...descriptors.values()], vertices: vertex, rings: ring };
}

function writePositions(
  layout: Layout,
  vertex: number,
  positions: readonly GeoArrowPosition[],
  accounting: WriteAccounting,
): void {
  const geometry = layout.inspection.geometry;
  const names = layout.names;
  const descriptor =
    geometry.coordinateLayout === "interleaved" ? layout.descriptors.get(`${geometry.field}.coordinates`)! : undefined;
  if (descriptor) {
    const values = new Float64Array(descriptor.data, descriptor.byteOffset);
    positions.forEach((position, offset) => {
      const base = (vertex + offset) * names.length;
      for (let dimension = 0; dimension < names.length; dimension += 1) values[base + dimension] = position[dimension]!;
      accounting.bytes += names.length * 8;
    });
    return;
  }
  names.forEach((name, dimension) => {
    const buffer = layout.descriptors.get(`${geometry.field}.${name}`)!;
    const values = new Float64Array(buffer.data, buffer.byteOffset);
    positions.forEach((position, offset) => {
      values[vertex + offset] = position[dimension]!;
      accounting.bytes += 8;
    });
  });
}

interface RebuildItem {
  readonly kind: "copy" | "row" | "append";
  readonly start: number;
  readonly end: number;
}

/** Live source-row runs, split at every updated row so a run is a pure copy. */
function rebuildItems(
  rows: number,
  tombstones: TombstoneSet,
  updatesByRow: ReadonlyMap<number, PlannedUpdate>,
): RebuildItem[] {
  const items: RebuildItem[] = [];
  let start = -1;
  for (let row = 0; row < rows; row += 1) {
    if (tombstones.has(row)) {
      if (start !== -1) items.push({ kind: "copy", start, end: row });
      start = -1;
      continue;
    }
    if (updatesByRow.has(row)) {
      if (start !== -1) items.push({ kind: "copy", start, end: row });
      items.push({ kind: "row", start: row, end: row + 1 });
      start = -1;
      continue;
    }
    if (start === -1) start = row;
  }
  if (start !== -1) items.push({ kind: "copy", start, end: rows });
  return items;
}

interface RebuildResult {
  readonly batch: ColumnarBatchV1;
  readonly payloadBytes: number;
  readonly backingBytes: number;
}

/**
 * Compact the live rows into fresh buffers, applying updates as they are
 * written and appending new rows at the end. The pass copies packed buffer
 * slices; it never materializes a source row as an object, so peak transient
 * memory stays proportional to the output payload rather than to the row count.
 */
function rebuild(
  layout: Layout,
  state: ColumnarPatchStateV1,
  plan: PatchPlan,
  patch: ColumnarPatchV1,
  options: ApplyColumnarPatchOptions,
  limits: GeoArrowConversionLimits,
): RebuildResult {
  const inspection = layout.inspection;
  const batch = inspection.batch;
  const items = rebuildItems(layout.rows, plan.tombstones, plan.updatesByRow);
  const reserve = resolveReserve(options.rebuild?.reserve ?? state.reserve, layout.kind);
  const dictionaryByValue = plan.newDictionaryValues.length === 0 ? undefined : decodeDictionaryValues(inspection);
  const dictionaryAdditions = new Map<string, number>();
  if (dictionaryByValue) {
    let next = inspection.dictionary!.offsets.length - 1;
    for (const value of plan.newDictionaryValues) {
      if (!dictionaryByValue.has(value)) {
        dictionaryAdditions.set(value, next);
        next += 1;
      }
    }
  }
  const resolveDictionary = (value: string | null | undefined, planned: number | null | undefined): number => {
    if (value === null || value === undefined) return planned ?? 0;
    return planned ?? dictionaryByValue?.get(value) ?? dictionaryAdditions.get(value) ?? 0;
  };

  // Pass one: sizes.
  let rows = 0;
  let vertices = 0;
  let rings = 0;
  for (const item of items) {
    if (item.kind === "copy") {
      rows += item.end - item.start;
      const span = spanOf(inspection, item.start, item.end);
      vertices += span.vertices;
      rings += span.rings;
      continue;
    }
    rows += 1;
    const update = plan.updatesByRow.get(item.start)!;
    const span = update.geometry ?? rowVertexSpan(inspection, item.start);
    vertices += span.vertices;
    rings += span.rings;
  }
  rows += plan.appends.length;
  vertices += plan.appendedVertices;
  rings += plan.appendedRings;

  const geometry = inspection.geometry;
  const names = layout.names;
  const buffers: ColumnarBufferV1[] = [];
  let payloadBytes = 0;
  let backingBytes = 0;
  const allocate = (
    id: string,
    role: ColumnarBufferV1["role"],
    field: string,
    payload: number,
    extra: number,
  ): ColumnarBufferV1 => {
    const data = new ArrayBuffer(payload + extra);
    payloadBytes += payload;
    backingBytes += payload + extra;
    const descriptor = { id, role, field, data, byteOffset: 0, byteLength: payload };
    buffers.push(descriptor);
    return descriptor;
  };

  const validityBytes = Math.ceil(rows / 8);
  const reservedValidityBytes = Math.ceil((rows + reserve.rows) / 8) - validityBytes;
  const geometryValidity = geometry.validity
    ? new Uint8Array(
        allocate(`${geometry.field}.validity`, "validity", geometry.field, validityBytes, reservedValidityBytes).data,
      )
    : undefined;
  const offsets =
    geometry.kind === "point"
      ? undefined
      : new Int32Array(
          allocate(`${geometry.field}.offsets`, "offsets", geometry.field, (rows + 1) * 4, reserve.rows * 4).data,
        );
  const ringOffsets =
    geometry.kind === "polygon"
      ? new Int32Array(
          allocate(`${geometry.field}.ring-offsets`, "offsets", geometry.field, (rings + 1) * 4, reserve.rings * 4)
            .data,
        )
      : undefined;
  const interleaved =
    geometry.coordinateLayout === "interleaved"
      ? new Float64Array(
          allocate(
            `${geometry.field}.coordinates`,
            "geometry",
            geometry.field,
            vertices * names.length * 8,
            reserve.vertices * names.length * 8,
          ).data,
        )
      : undefined;
  const separated =
    geometry.coordinateLayout === "separated"
      ? names.map(
          (name) =>
            new Float64Array(
              allocate(`${geometry.field}.${name}`, "geometry", geometry.field, vertices * 8, reserve.vertices * 8)
                .data,
            ),
        )
      : undefined;
  const temporal = inspection.temporal;
  const temporalValidity = temporal?.validity
    ? new Uint8Array(
        allocate(`${temporal.field}.validity`, "validity", temporal.field, validityBytes, reservedValidityBytes).data,
      )
    : undefined;
  const temporalValues = temporal
    ? new BigInt64Array(allocate(`${temporal.field}.values`, "values", temporal.field, rows * 8, reserve.rows * 8).data)
    : undefined;
  const dictionary = inspection.dictionary;
  const dictionaryValidity = dictionary?.validity
    ? new Uint8Array(
        allocate(`${dictionary.field}.validity`, "validity", dictionary.field, validityBytes, reservedValidityBytes)
          .data,
      )
    : undefined;
  const dictionaryIndices = dictionary
    ? new Int32Array(
        allocate(`${dictionary.field}.indices`, "dictionary", dictionary.field, rows * 4, reserve.rows * 4).data,
      )
    : undefined;
  const featureIds = inspection.featureIds!;
  const featureIdValues = new Uint32Array(
    allocate(`${featureIds.field}.values`, "values", featureIds.field, rows * 4, reserve.rows * 4).data,
  );

  if (dictionary) {
    const encoder = new TextEncoder();
    const additions = [...dictionaryAdditions.keys()];
    const additionBytes = additions.reduce((total, value) => total + utf8Length(value), 0);
    const dictionaryOffsets = new Int32Array(
      allocate(
        `${dictionary.field}.offsets`,
        "offsets",
        dictionary.field,
        (dictionary.offsets.length + additions.length) * 4,
        0,
      ).data,
    );
    const dictionaryValues = new Uint8Array(
      allocate(
        `${dictionary.field}.values`,
        "dictionary",
        dictionary.field,
        dictionary.values.length + additionBytes,
        0,
      ).data,
    );
    dictionaryOffsets.set(dictionary.offsets);
    dictionaryValues.set(dictionary.values);
    let offset = dictionary.values.length;
    additions.forEach((value, position) => {
      const written = encoder.encodeInto(value, dictionaryValues.subarray(offset));
      offset += written.written;
      dictionaryOffsets[dictionary.offsets.length + position] = offset;
    });
  }

  // Pass two: write.
  let row = 0;
  let vertex = 0;
  let ring = 0;
  let checked = 0;
  const writeRowGeometry = (planned: PlannedGeometry): void => {
    if (offsets) offsets[row + 1] = geometry.kind === "polygon" ? ring + planned.rings : vertex + planned.vertices;
    if (ringOffsets) {
      let ringVertex = vertex;
      for (const size of planned.ringSizes) {
        ringOffsets[ring] = ringVertex;
        ringVertex += size;
        ring += 1;
      }
      ringOffsets[ring] = ringVertex;
    }
    planned.positions.forEach((position, offset) => {
      if (interleaved) {
        const base = (vertex + offset) * names.length;
        for (let dimension = 0; dimension < names.length; dimension += 1) {
          interleaved[base + dimension] = position[dimension]!;
        }
      } else
        for (let dimension = 0; dimension < names.length; dimension += 1) {
          separated![dimension]![vertex + offset] = position[dimension]!;
        }
    });
    vertex += planned.vertices;
    if (geometryValidity && !planned.isNull) geometryValidity[row >> 3]! |= 1 << (row & 7);
  };

  for (const item of items) {
    assertNotAborted(options.signal);
    if (item.kind === "copy") {
      const span = spanOf(inspection, item.start, item.end);
      copyCoordinates(inspection, names, interleaved, separated, span.startVertex, span.vertices, vertex);
      for (let source = item.start; source < item.end; source += 1) {
        const sourceSpan = rowVertexSpan(inspection, source);
        if (offsets) {
          offsets[row + 1] = geometry.kind === "polygon" ? ring + sourceSpan.rings : vertex + sourceSpan.vertices;
        }
        if (ringOffsets) {
          const firstRing = geometry.offsets![source]!;
          for (let index = 0; index < sourceSpan.rings; index += 1) {
            ringOffsets[ring + index] =
              vertex + (geometry.ringOffsets![firstRing + index]! - geometry.ringOffsets![firstRing]!);
          }
          ring += sourceSpan.rings;
          ringOffsets[ring] = vertex + sourceSpan.vertices;
        }
        if (geometryValidity && bitSet(geometry.validity, source)) geometryValidity[row >> 3]! |= 1 << (row & 7);
        if (temporalValues) {
          temporalValues[row] = temporal!.values[source]!;
          if (temporalValidity && bitSet(temporal!.validity, source)) temporalValidity[row >> 3]! |= 1 << (row & 7);
        }
        if (dictionaryIndices) {
          dictionaryIndices[row] = dictionary!.indices[source]!;
          if (dictionaryValidity && bitSet(dictionary!.validity, source))
            dictionaryValidity[row >> 3]! |= 1 << (row & 7);
        }
        featureIdValues[row] = featureIds.values[source]!;
        vertex += sourceSpan.vertices;
        row += 1;
        checked += 1;
        if (checked % COLUMNAR_PATCH_ABORT_CHECK_ROWS === 0) assertNotAborted(options.signal);
      }
      continue;
    }
    if (item.kind === "row") {
      const source = item.start;
      const update = plan.updatesByRow.get(source)!;
      if (update.geometry) writeRowGeometry(update.geometry);
      else {
        const sourceSpan = rowVertexSpan(inspection, source);
        const startVertex =
          geometry.kind === "point"
            ? source
            : geometry.kind === "linestring"
              ? geometry.offsets![source]!
              : geometry.ringOffsets![geometry.offsets![source]!]!;
        copyCoordinates(inspection, names, interleaved, separated, startVertex, sourceSpan.vertices, vertex);
        if (offsets)
          offsets[row + 1] = geometry.kind === "polygon" ? ring + sourceSpan.rings : vertex + sourceSpan.vertices;
        if (ringOffsets) {
          const firstRing = geometry.offsets![source]!;
          for (let index = 0; index < sourceSpan.rings; index += 1) {
            ringOffsets[ring + index] =
              vertex + (geometry.ringOffsets![firstRing + index]! - geometry.ringOffsets![firstRing]!);
          }
          ring += sourceSpan.rings;
          ringOffsets[ring] = vertex + sourceSpan.vertices;
        }
        if (geometryValidity && bitSet(geometry.validity, source)) geometryValidity[row >> 3]! |= 1 << (row & 7);
        vertex += sourceSpan.vertices;
      }
      if (temporalValues) {
        const value = update.timestamp === undefined ? temporal!.values[source]! : (update.timestamp ?? 0n);
        temporalValues[row] = value;
        const valid = update.timestamp === undefined ? bitSet(temporal!.validity, source) : update.timestamp !== null;
        if (temporalValidity && valid) temporalValidity[row >> 3]! |= 1 << (row & 7);
      }
      if (dictionaryIndices) {
        const value =
          update.dictionaryValue === undefined
            ? dictionary!.indices[source]!
            : resolveDictionary(update.dictionaryValue, update.dictionaryIndex);
        dictionaryIndices[row] = value;
        const valid =
          update.dictionaryValue === undefined ? bitSet(dictionary!.validity, source) : update.dictionaryValue !== null;
        if (dictionaryValidity && valid) dictionaryValidity[row >> 3]! |= 1 << (row & 7);
      }
      featureIdValues[row] = featureIds.values[source]!;
      row += 1;
    }
  }

  for (const append of plan.appends) {
    assertNotAborted(options.signal);
    writeRowGeometry(append.geometry);
    if (temporalValues) {
      temporalValues[row] = append.timestamp ?? 0n;
      if (temporalValidity && append.timestamp !== null) temporalValidity[row >> 3]! |= 1 << (row & 7);
    }
    if (dictionaryIndices) {
      dictionaryIndices[row] = resolveDictionary(append.dictionaryValue, append.dictionaryIndex);
      if (dictionaryValidity && append.dictionaryValue !== null) dictionaryValidity[row >> 3]! |= 1 << (row & 7);
    }
    featureIdValues[row] = append.featureId;
    row += 1;
  }
  const identity =
    options.rebuild?.identity ??
    (batch.identity === undefined
      ? undefined
      : {
          ...batch.identity,
          freshness: {
            ...batch.identity.freshness,
            observedAt: patch.cursor.observedAt,
            generation: String(patch.cursor.sequence),
          },
        });
  const metadata = patchMetadataFor({
    baseRows: rows,
    baseVertices: vertices,
    reserve,
    generation: 0,
    tombstones: "",
    cursor: patch.cursor,
  });
  return {
    batch: createColumnarBatch(
      {
        id: options.rebuild?.batchId ?? `${batch.id}~${patch.cursor.sequence}`,
        schema: { ...batch.schema, metadata: withPatchMetadata(batch.schema.metadata, metadata) },
        rowCount: rows,
        sequence: batch.sequence,
        ...(identity === undefined ? {} : { identity }),
        buffers,
      },
      limits,
    ),
    payloadBytes,
    backingBytes,
  };
}

function spanOf(
  inspection: GeoArrowBatchInspection,
  start: number,
  end: number,
): { startVertex: number; vertices: number; rings: number } {
  const geometry = inspection.geometry;
  if (geometry.kind === "point") return { startVertex: start, vertices: end - start, rings: 0 };
  const firstRing = geometry.offsets![start]!;
  const lastRing = geometry.offsets![end]!;
  if (geometry.kind === "linestring") {
    return { startVertex: firstRing, vertices: lastRing - firstRing, rings: 0 };
  }
  const startVertex = geometry.ringOffsets![firstRing]!;
  return { startVertex, vertices: geometry.ringOffsets![lastRing]! - startVertex, rings: lastRing - firstRing };
}

function copyCoordinates(
  inspection: GeoArrowBatchInspection,
  names: readonly ("x" | "y" | "z" | "m")[],
  interleaved: Float64Array | undefined,
  separated: readonly Float64Array[] | undefined,
  sourceVertex: number,
  vertices: number,
  targetVertex: number,
): void {
  if (vertices === 0) return;
  const geometry = inspection.geometry;
  if (interleaved) {
    const source = geometry.coordinates.interleaved!;
    interleaved.set(
      source.subarray(sourceVertex * names.length, (sourceVertex + vertices) * names.length),
      targetVertex * names.length,
    );
    return;
  }
  names.forEach((name, dimension) => {
    separated![dimension]!.set(
      geometry.coordinates[name]!.subarray(sourceVertex, sourceVertex + vertices),
      targetVertex,
    );
  });
}

interface ThresholdDecision {
  readonly rebuild: boolean;
  readonly reason?: ColumnarPatchRebuildReason;
}

/**
 * Threshold evaluation in one fixed order, so a patch that crosses two rules
 * always names the same one.
 */
function evaluateThresholds(
  layout: Layout,
  state: ColumnarPatchStateV1,
  plan: PatchPlan,
  thresholds: ResolvedThresholds,
): ThresholdDecision {
  const rowCount = layout.rows + plan.appends.length;
  const tombstoneRatio = rowCount === 0 ? 0 : plan.tombstones.count / rowCount;
  if (tombstoneRatio > thresholds.maxTombstoneRatio) return { rebuild: true, reason: "tombstone-ratio" };
  if (utf8Length(plan.tombstones.encode()) > thresholds.maxTombstoneOverlayBytes) {
    return { rebuild: true, reason: "tombstone-overlay" };
  }
  if (plan.appends.length > 0) {
    if (
      plan.appends.length > state.capacity.rows ||
      plan.appendedVertices > state.capacity.vertices ||
      plan.appendedRings > state.capacity.rings
    ) {
      return { rebuild: true, reason: "capacity" };
    }
    const consumedRows = rowCount - state.baseRows;
    const consumedVertices = layout.vertices + plan.appendedVertices - state.baseVertices;
    const rowUtilization = state.reserve.rows === 0 ? 1 : consumedRows / state.reserve.rows;
    const vertexUtilization =
      state.reserve.vertices === 0 ? (consumedVertices > 0 ? 1 : 0) : consumedVertices / state.reserve.vertices;
    if (Math.max(rowUtilization, vertexUtilization) > thresholds.maxCapacityUtilization) {
      return { rebuild: true, reason: "capacity" };
    }
    if (
      state.baseVertices > 0 &&
      (layout.vertices + plan.appendedVertices) / state.baseVertices > thresholds.maxVertexGrowthRatio
    ) {
      return { rebuild: true, reason: "vertex-growth" };
    }
  }
  if (plan.layoutBlocked) return { rebuild: true, reason: "layout" };
  return { rebuild: false };
}

/**
 * Apply one realtime patch to a normative GeoArrow batch.
 *
 * The call either writes into the batch's existing backings, rebuilds a
 * compacted batch, or refuses the patch without touching a byte. See the module
 * documentation for the identity, tombstone, threshold, and determinism rules.
 */
export function applyColumnarPatch(
  batch: ColumnarBatchV1,
  patch: ColumnarPatchV1,
  options: ApplyColumnarPatchOptions = {},
): ApplyColumnarPatchOutcomeV1 {
  if (typeof patch !== "object" || patch === null || patch.kind !== COLUMNAR_PATCH_KIND) {
    throw new HonuaColumnarPatchError("invalid-patch-state", `Patch must be a ${COLUMNAR_PATCH_KIND} value.`);
  }
  if (patch.version !== COLUMNAR_PATCH_VERSION) {
    throw new HonuaColumnarPatchError(
      "invalid-patch-state",
      `Patch declares version "${patch.version}"; this build implements ${COLUMNAR_PATCH_VERSION}.`,
    );
  }
  const limits = options.limits ?? {};
  const thresholds = resolveThresholds(options.thresholds);
  const progress = options.reportProgress;
  assertNotAborted(options.signal);
  progress?.(0.05, "inspect");
  const layout = readLayout(batch, limits);
  const state = readState(layout.inspection.batch, layout);

  if (patch.schemaId !== batch.schema.id) {
    return reject(
      "schema-drift",
      `Patch targets schema "${patch.schemaId}"; the batch carries "${batch.schema.id}".`,
      batch,
      {
        expected: batch.schema.id,
        actual: patch.schemaId,
      },
    );
  }
  if (patch.geometryKind !== layout.kind) {
    return reject(
      "geometry-kind-drift",
      `Patch targets ${patch.geometryKind} geometry; the batch carries ${layout.kind}.`,
      batch,
      { expected: layout.kind, actual: patch.geometryKind },
    );
  }
  if (state.sequence !== undefined) {
    if (patch.cursor.sequence === state.sequence) {
      return reject("duplicate-sequence", `Patch sequence ${patch.cursor.sequence} was already applied.`, batch, {
        sequence: patch.cursor.sequence,
      });
    }
    if (patch.cursor.sequence < state.sequence) {
      return reject(
        "stale-sequence",
        `Patch sequence ${patch.cursor.sequence} is behind the applied sequence ${state.sequence}.`,
        batch,
        { sequence: patch.cursor.sequence, applied: state.sequence },
      );
    }
  }

  progress?.(0.2, "plan");
  const plan = planPatch(batch, patch, layout, state);
  if ("outcome" in plan) return plan;
  assertNotAborted(options.signal);

  const decision = evaluateThresholds(layout, state, plan, thresholds);
  if (decision.rebuild && options.allowRebuild === false) {
    return reject(
      "rebuild-required",
      `Applying this patch requires a rebuild (${decision.reason}) and rebuilds are disabled.`,
      batch,
      {
        reason: decision.reason,
        ...(plan.layoutBlockedReason === undefined ? {} : { detail: plan.layoutBlockedReason }),
      },
    );
  }

  const rowsTouched = plan.appends.length + plan.updates.length + plan.deletes.length;
  if (decision.rebuild) {
    progress?.(0.4, "rebuild");
    const rebuilt = rebuild(layout, state, plan, patch, options, limits);
    const rebuiltState = inspectColumnarPatchState(rebuilt.batch, limits);
    progress?.(1, "complete");
    return Object.freeze({
      outcome: "rebuilt" as const,
      batch: rebuilt.batch,
      state: rebuiltState,
      metrics: Object.freeze({
        appendedRows: plan.appends.length,
        updatedRows: plan.updates.length,
        deletedRows: plan.deletes.length,
        rowsTouched,
        payloadBytesCopied: rebuilt.payloadBytes,
        metadataBytes: metadataByteLength(rebuilt.batch),
        backingBytesAllocated: rebuilt.backingBytes,
        tombstones: 0,
        liveRows: rebuilt.batch.rowCount,
      }),
      bufferIdentityPreserved: false as const,
      reason: decision.reason!,
    });
  }

  progress?.(0.4, "apply");
  const accounting: WriteAccounting = { bytes: 0 };
  const written = applyInPlace(layout, plan, accounting);
  const rowCount = layout.rows + plan.appends.length;
  const metadata = patchMetadataFor({
    baseRows: state.baseRows,
    baseVertices: state.baseVertices,
    reserve: { rows: state.reserve.rows, vertices: state.reserve.vertices, rings: state.reserve.rings },
    generation: state.generation + 1,
    tombstones: plan.tombstones.encode(),
    cursor: patch.cursor,
  });
  const identity =
    batch.identity === undefined
      ? undefined
      : {
          ...batch.identity,
          freshness: {
            ...batch.identity.freshness,
            observedAt: patch.cursor.observedAt,
            generation: String(patch.cursor.sequence),
          },
        };
  const patched = createColumnarBatch(
    {
      id: batch.id,
      schema: { ...batch.schema, metadata: withPatchMetadata(batch.schema.metadata, metadata) },
      rowCount,
      sequence: batch.sequence,
      ...(batch.rowOffset === undefined ? {} : { rowOffset: batch.rowOffset }),
      ...(identity === undefined ? {} : { identity }),
      buffers: written.buffers,
    },
    limits,
  );
  // The patched batch is the input layout with grown slices, so its state is
  // derived rather than re-validated: one patch pays for one inspection.
  const patchedState = buildState(
    patched.schema.metadata ?? {},
    { ...layout, rows: rowCount, descriptors: descriptorMap(patched) },
    written.vertices,
    written.rings,
  );
  progress?.(1, "complete");
  return Object.freeze({
    outcome: "patched-in-place" as const,
    batch: patched,
    state: patchedState,
    metrics: Object.freeze({
      appendedRows: plan.appends.length,
      updatedRows: plan.updates.length,
      deletedRows: plan.deletes.length,
      rowsTouched,
      payloadBytesCopied: accounting.bytes,
      metadataBytes: metadataByteLength(patched),
      backingBytesAllocated: 0,
      tombstones: patchedState.tombstoneCount,
      liveRows: patchedState.liveRowCount,
    }),
    bufferIdentityPreserved: true as const,
  });
}

function metadataByteLength(batch: ColumnarBatchV1): number {
  const metadata = batch.schema.metadata ?? {};
  let bytes = 0;
  for (const key of Object.values(META)) {
    const value = metadata[key];
    if (value !== undefined) bytes += utf8Length(key) + utf8Length(value);
  }
  return bytes;
}

/**
 * Register realtime patch application as a columnar worker operation, so it
 * runs off the main thread under the existing session lifecycle.
 *
 * A rejection has no batch to return, so it is raised as
 * {@link HonuaColumnarPatchError}. The worker host deliberately does not
 * forward an operation's message across the boundary, so the caller sees
 * `operation-failed` without the rejection code: call
 * {@link applyColumnarPatch} directly when the code has to be observable.
 *
 * Buffer identity is preserved inside the worker, but a worker round trip
 * transfers ownership in both directions, so a renderer bound on the main
 * thread rebinds either way. Apply patches on the thread that owns the binding
 * when preserving that binding is the point.
 */
export function createColumnarPatchOperation(options: CreateColumnarPatchOperationOptions): ColumnarWorkerOperation {
  if (typeof options !== "object" || options === null) {
    throw new HonuaColumnarPatchError("invalid-patch-state", "Columnar patch operation options must be an object.");
  }
  if (typeof options.patch !== "object" && typeof options.patch !== "function") {
    throw new HonuaColumnarPatchError("invalid-patch-state", "Columnar patch operation requires a patch or provider.");
  }
  return async (batch: ColumnarBatchV1, context: ColumnarWorkerOperationContext): Promise<ColumnarBatchV1> => {
    const patch = typeof options.patch === "function" ? await options.patch(batch, context) : options.patch;
    if (context.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const outcome = applyColumnarPatch(batch, patch, {
      ...options,
      signal: context.signal,
      reportProgress: (fraction, stage) => {
        context.reportProgress(fraction, stage);
      },
    });
    if (outcome.outcome === "rejected") {
      throw new HonuaColumnarPatchError(outcome.code, outcome.message, outcome.detail);
    }
    return outcome.batch;
  };
}
