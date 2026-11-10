import type { DeckGlAdapter, DeckGlPickedSelection, DeckGlProjection, DeckGlSelectionIdentity } from "./types.js";
import { HonuaDeckGlAdapterError } from "./types.js";

import { type Bin, type HexbinLimits, binGeometry, countBins, unproject } from "./hexbin-grid.js";

const VERTICES_PER_BIN = 7;
export interface DeckGlHexbinRequest {
  readonly layerId: string;
  /** Packed WGS84 longitude/latitude pairs; input is borrowed only during construction. */
  readonly positions: Float32Array | Float64Array;
  readonly identity: DeckGlSelectionIdentity;
  /** Hexagon circumradius in EPSG:3857 map meters, not ground distance. */
  readonly radiusMeters: number;
  readonly limits?: { readonly maxRows?: number; readonly maxBins?: number };
  /** Applied to each bin after counting. Components must be integer RGBA bytes. */
  readonly color?: (count: number) => readonly [number, number, number, number];
}

export interface DeckGlHexbin {
  readonly id: string;
  readonly count: number;
  readonly center: readonly [number, number];
}

export interface DeckGlHexbinProjection {
  readonly projection: DeckGlProjection;
  readonly bins: readonly DeckGlHexbin[];
  readonly aggregation: "count";
  readonly execution: "cpu-bounded";
  readonly inputRows: number;
  /** Returns original input identities, never a bin index disguised as a feature ID. */
  selectionsForBin(index: number): readonly DeckGlPickedSelection[];
}

/** Count points in fixed Web Mercator hexagons, then render through the optional SolidPolygonLayer peer. */
export function projectDeckGlHexbins(adapter: DeckGlAdapter, request: DeckGlHexbinRequest): DeckGlHexbinProjection {
  if (adapter.disposed) throw new HonuaDeckGlAdapterError("disposed", "Cannot aggregate with a disposed adapter.");
  const limits = validateRequest(adapter, request);
  const identity = snapshotIdentity(request.identity, limits.rows);
  const { bins, assignments } = countBins(request, limits);
  const outputBytes = bins.length * (VERTICES_PER_BIN * 20 + 4) + 4;
  if (outputBytes > adapter.limits.maxBackingBytes) {
    throw new HonuaDeckGlAdapterError(
      "limit-exceeded",
      "Hexbin polygon buffers exceed the adapter backing-byte limit.",
    );
  }
  const geometry = binGeometry(bins, request);
  const projection = adapter.project({
    layer: "feature-polygon",
    layerId: request.layerId,
    data: geometry,
    identity: { ...identity, featureIds: bins.map((bin) => bin.id) },
  });
  return createResult({ projection, bins, assignments, identity });
}

interface AggregatedProjection {
  readonly projection: DeckGlProjection;
  readonly bins: readonly Bin[];
  readonly assignments: Uint32Array;
  readonly identity: DeckGlSelectionIdentity;
}

function createResult({ projection, bins, assignments, identity }: AggregatedProjection): DeckGlHexbinProjection {
  const summaries = Object.freeze(
    bins.map((bin) =>
      Object.freeze({
        id: bin.id,
        count: bin.count,
        center: Object.freeze(unproject(bin.x, bin.y)),
      }),
    ),
  );
  const members = groupMembers(bins, assignments);
  return Object.freeze({
    projection,
    bins: summaries,
    aggregation: "count",
    execution: "cpu-bounded",
    inputRows: assignments.length,
    selectionsForBin(index: number) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= bins.length) throw invalid("Invalid hexbin index.");
      return Object.freeze(
        Array.from(members.rows.subarray(members.offsets[index], members.offsets[index + 1]), (rowIndex) => ({
          sourceId: identity.sourceId,
          planId: identity.planId,
          ...(identity.sourceVersion === undefined ? {} : { sourceVersion: identity.sourceVersion }),
          featureId: identity.featureIds[rowIndex],
          rowIndex,
        })),
      );
    },
  });
}

function validateRequest(adapter: DeckGlAdapter, request: DeckGlHexbinRequest): HexbinLimits {
  if (
    !(request.positions instanceof Float32Array || request.positions instanceof Float64Array) ||
    request.positions.length % 2 !== 0
  ) {
    throw invalid("positions must be packed Float32Array or Float64Array longitude/latitude pairs.");
  }
  const rows = request.positions.length / 2;
  const maxRows = request.limits?.maxRows ?? Math.min(100_000, adapter.limits.maxRows);
  const maxBins = request.limits?.maxBins ?? Math.min(20_000, Math.floor(adapter.limits.maxRows / VERTICES_PER_BIN));
  if (
    !Number.isSafeInteger(maxRows) ||
    maxRows < 0 ||
    maxRows > Math.min(adapter.limits.maxRows, 1_000_000) ||
    !Number.isSafeInteger(maxBins) ||
    maxBins < 0 ||
    maxBins > Math.floor(adapter.limits.maxRows / VERTICES_PER_BIN)
  ) {
    throw invalid("Hexbin limits must be non-negative integers within the adapter row/vertex budget.");
  }
  if (rows > maxRows || request.positions.buffer.byteLength > adapter.limits.maxBackingBytes) {
    throw new HonuaDeckGlAdapterError(
      "limit-exceeded",
      "Hexbin input exceeds the configured row or backing-byte limit.",
    );
  }
  if (!Number.isFinite(request.radiusMeters) || request.radiusMeters < 1 || request.radiusMeters > 1_000_000) {
    throw invalid("radiusMeters must be between 1 and 1,000,000 Web Mercator map meters.");
  }
  return { rows, maxBins };
}

function snapshotIdentity(identity: DeckGlSelectionIdentity, rows: number): DeckGlSelectionIdentity {
  if (
    !identity ||
    typeof identity.sourceId !== "string" ||
    !identity.sourceId.trim() ||
    typeof identity.planId !== "string" ||
    !identity.planId.trim() ||
    identity.featureIds?.length !== rows ||
    (identity.sourceVersion !== undefined && typeof identity.sourceVersion !== "string")
  ) {
    throw invalid("Hexbin input requires source, plan and one scalar identity per point.");
  }
  const featureIds = Array.from(identity.featureIds, (id) => {
    if (typeof id !== "string" && typeof id !== "bigint" && !(typeof id === "number" && Number.isFinite(id))) {
      throw invalid("Hexbin feature identities must be strings, finite numbers or bigints.");
    }
    return id;
  });
  return { sourceId: identity.sourceId, planId: identity.planId, sourceVersion: identity.sourceVersion, featureIds };
}

function groupMembers(bins: readonly Bin[], assignments: Uint32Array) {
  const offsets = new Uint32Array(bins.length + 1);
  for (let index = 0; index < bins.length; index++) offsets[index + 1] = offsets[index] + bins[index].count;
  const cursors = offsets.slice(0, -1);
  const rows = new Uint32Array(assignments.length);
  for (let row = 0; row < assignments.length; row++) rows[cursors[assignments[row]]++] = row;
  return { offsets, rows };
}

function invalid(message: string): HonuaDeckGlAdapterError {
  return new HonuaDeckGlAdapterError("invalid-data", message);
}
