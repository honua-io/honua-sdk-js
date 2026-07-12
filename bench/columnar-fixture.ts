/**
 * Deterministic million-feature columnar fixture for the large-data
 * (columnar) rendering path. The fixture is generated in-process into packed
 * typed-array buffers — never per-feature JavaScript objects or GeoJSON — so it
 * exercises the same zero-copy contract the renderer consumes.
 *
 * Determinism: values are derived from the row index with a fixed-parameter
 * integer hash (a splitmix64-style mixer). There is no `Math.random`, so the
 * same `featureCount` always produces byte-for-byte identical buffers and two
 * benchmark runs are directly comparable.
 */
import { createColumnarBatch } from "../src/columnar/transfer.js";
import type { ColumnarBatchLimits, ColumnarBatchV1, ColumnarBufferV1 } from "../src/columnar/types.js";

/** Bytes each feature contributes across all packed columns. */
export const COLUMNAR_FIXTURE_BYTES_PER_FEATURE =
  8 /* getPosition: 2 x float32 */ +
  4 /* getRadius: 1 x float32 */ +
  4 /* getFillColor: 4 x uint8 */ +
  4; /* id: 1 x uint32 */

/** Raw packed buffers plus the metadata needed to bind them to a renderer. */
export interface ColumnarFixture {
  readonly featureCount: number;
  readonly position: Float32Array;
  readonly radius: Float32Array;
  readonly fillColor: Uint8Array;
  readonly id: Uint32Array;
  /** Total bytes across every backing allocation. */
  readonly backingBytes: number;
}

/**
 * Deterministic 64-bit → 32-bit mixer. `Number` math stays exact because every
 * intermediate is masked to 32 bits before multiplication.
 */
function mix(index: number, salt: number): number {
  let h = (index ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h;
}

/**
 * Build the packed columnar fixture for `featureCount` point features. Only
 * four contiguous typed arrays are allocated regardless of feature count.
 */
export function buildColumnarFixture(featureCount: number): ColumnarFixture {
  if (!Number.isInteger(featureCount) || featureCount < 0) {
    throw new Error(`buildColumnarFixture: featureCount must be a non-negative integer, got ${featureCount}`);
  }
  const position = new Float32Array(featureCount * 2);
  const radius = new Float32Array(featureCount);
  const fillColor = new Uint8Array(featureCount * 4);
  const id = new Uint32Array(featureCount);

  for (let i = 0; i < featureCount; i += 1) {
    const hx = mix(i, 0x9e3779b9);
    const hy = mix(i, 0x85ebca6b);
    const hr = mix(i, 0xc2b2ae35);
    // Longitude in [-180, 180), latitude in [-85, 85): stable, valid coordinates.
    position[i * 2] = -180 + (hx % 3600) / 10;
    position[i * 2 + 1] = -85 + (hy % 1700) / 10;
    radius[i] = 10 + (hr % 400) / 10;
    fillColor[i * 4] = hx & 0xff;
    fillColor[i * 4 + 1] = (hx >>> 8) & 0xff;
    fillColor[i * 4 + 2] = (hy >>> 8) & 0xff;
    fillColor[i * 4 + 3] = 0xff;
    id[i] = i + 1;
  }

  return Object.freeze({
    featureCount,
    position,
    radius,
    fillColor,
    id,
    backingBytes: position.byteLength + radius.byteLength + fillColor.byteLength + id.byteLength,
  });
}

/** Buffer ids used by {@link buildColumnarBatchFixture}. Stable across runs. */
export const COLUMNAR_FIXTURE_BUFFER_IDS = Object.freeze({
  position: "buf:position",
  radius: "buf:radius",
  fillColor: "buf:fill-color",
  id: "buf:id",
});

function bufferOf(
  fixtureBuffer: ArrayBufferView,
  id: string,
  role: ColumnarBufferV1["role"],
  field: string,
): ColumnarBufferV1 {
  return {
    id,
    role,
    field,
    data: fixtureBuffer.buffer as ArrayBuffer,
    byteOffset: fixtureBuffer.byteOffset,
    byteLength: fixtureBuffer.byteLength,
  };
}

/**
 * Wrap the packed fixture as a validated {@link ColumnarBatchV1}. The batch's
 * buffers reference the fixture's own `ArrayBuffer`s — the renderer binding
 * aliases these with zero copies.
 */
export function buildColumnarBatchFixture(
  featureCount: number,
  limits: ColumnarBatchLimits = {},
): {
  readonly fixture: ColumnarFixture;
  readonly batch: ColumnarBatchV1;
} {
  const fixture = buildColumnarFixture(featureCount);
  const batch = createColumnarBatch(
    {
      id: `columnar-fixture:${featureCount}`,
      schema: {
        id: `columnar-fixture-schema@1:${featureCount}`,
        fields: [
          { name: "position", type: { name: "geoarrow.point" }, nullable: false },
          { name: "radius", type: { name: "float32" }, nullable: false },
          { name: "fill_color", type: { name: "fixed_size_list", parameters: { size: 4 } }, nullable: false },
          { name: "id", type: { name: "uint32" }, nullable: false },
        ],
      },
      rowCount: featureCount,
      sequence: 0,
      buffers: [
        bufferOf(fixture.position, COLUMNAR_FIXTURE_BUFFER_IDS.position, "geometry", "position"),
        bufferOf(fixture.radius, COLUMNAR_FIXTURE_BUFFER_IDS.radius, "values", "radius"),
        bufferOf(fixture.fillColor, COLUMNAR_FIXTURE_BUFFER_IDS.fillColor, "values", "fill_color"),
        bufferOf(fixture.id, COLUMNAR_FIXTURE_BUFFER_IDS.id, "values", "id"),
      ],
    },
    limits,
  );
  return { fixture, batch };
}
