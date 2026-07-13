/**
 * Renderer-neutral snapping for edit-sketch workflows.
 *
 * The engine resolves a pointer position (screen space plus a caller-provided
 * projection function) against a {@link SnapIndex} of loaded features and
 * returns the nearest snap candidate with deterministic ordering:
 *
 * 1. smallest screen distance wins;
 * 2. at equal distance, `vertex` beats `edge` beats `feature`;
 * 3. remaining ties break by source id, then feature id, then vertex /
 *    segment ordinal.
 *
 * The index is a packed uniform grid over feature vertices, segments, and
 * polygon bodies — no per-move full scans and no new runtime dependency.
 * Geometry is GeoJSON-shaped (`Point`, `MultiPoint`, `LineString`,
 * `MultiLineString`, `Polygon`, `MultiPolygon`, `GeometryCollection`).
 *
 * @module
 */

import type { EditWorkflowOptimisticHooks, EditWorkflowSnapshot, EditWorkflowSubmitResult } from "./edit-session.js";
import type { FeatureId } from "./types.js";

// ── Configuration ─────────────────────────────────────────────

export type SnapCandidateKind = "vertex" | "edge" | "feature";

/** A point in renderer screen space (CSS pixels). */
export interface SnapScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** A geographic (or planar) coordinate as `[x, y]` / `[lng, lat]`. */
export type SnapPosition = readonly [number, number];

/** Projects a geographic position into screen space. */
export type SnapProjection = (position: SnapPosition) => SnapScreenPoint;

/** Per-source snapping overrides inside {@link SnappingConfig.sources}. */
export interface SnapSourceOptions {
  /** Disable the source entirely. @default true */
  enabled?: boolean;
  /** Candidate kinds for this source; overrides {@link SnappingConfig.kinds}. */
  kinds?: readonly SnapCandidateKind[];
}

export interface SnappingConfig {
  /** Master switch. */
  enabled: boolean;
  /** Snap tolerance in screen pixels (candidates at exactly the tolerance still snap). */
  tolerance: number;
  /**
   * Candidate kinds resolved by default. `feature` adds whole-feature
   * (feature-body) candidates: inside a polygon the pointer itself is a
   * zero-distance candidate; otherwise the nearest point on the feature.
   */
  kinds: readonly SnapCandidateKind[];
  /**
   * Per-source enablement keyed by source id. Missing sources default to
   * enabled with the global `kinds`. `false` disables a source.
   */
  sources: Readonly<Record<string, boolean | SnapSourceOptions>>;
}

export const DEFAULT_SNAPPING_CONFIG: SnappingConfig = Object.freeze({
  enabled: true,
  tolerance: 12,
  kinds: Object.freeze(["vertex", "edge"]) as readonly SnapCandidateKind[],
  sources: Object.freeze({}),
});

/** Merge a partial config over {@link DEFAULT_SNAPPING_CONFIG}. */
export function resolveSnappingConfig(input?: Partial<SnappingConfig>): SnappingConfig {
  return {
    enabled: input?.enabled ?? DEFAULT_SNAPPING_CONFIG.enabled,
    tolerance: input?.tolerance ?? DEFAULT_SNAPPING_CONFIG.tolerance,
    kinds: [...(input?.kinds ?? DEFAULT_SNAPPING_CONFIG.kinds)],
    sources: { ...(input?.sources ?? {}) },
  };
}

// ── Candidates ────────────────────────────────────────────────

export interface SnapCandidate {
  kind: SnapCandidateKind;
  sourceId: string;
  featureId: FeatureId;
  /** Geographic position of the snap target. */
  position: SnapPosition;
  /** Screen-space position of the snap target. */
  screenPoint: SnapScreenPoint;
  /** Screen-space distance from the pointer, in pixels. */
  distance: number;
  /** Ordinal of the snapped vertex within the feature (vertex candidates). */
  vertexIndex?: number;
  /** Ordinal of the snapped segment within the feature (edge candidates). */
  segmentIndex?: number;
}

export interface SnapQueryInput {
  /** Pointer position in screen space. */
  point: SnapScreenPoint;
  /** Pointer position in geographic space. */
  position: SnapPosition;
  /** Projection from geographic space to screen space. */
  project: SnapProjection;
}

export interface SnapResolution {
  snapped: boolean;
  /** Best candidate under deterministic ordering, when snapped. */
  candidate?: SnapCandidate;
  /** All candidates within tolerance, deterministically sorted. */
  candidates: readonly SnapCandidate[];
}

const UNSNAPPED: SnapResolution = Object.freeze({ snapped: false, candidates: Object.freeze([]) });

const KIND_RANK: Readonly<Record<SnapCandidateKind, number>> = Object.freeze({ vertex: 0, edge: 1, feature: 2 });

export function compareSnapCandidates(a: SnapCandidate, b: SnapCandidate): number {
  if (a.distance !== b.distance) return a.distance - b.distance;
  if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
  const idOrder = compareFeatureIds(a.featureId, b.featureId);
  if (idOrder !== 0) return idOrder;
  return ordinalOf(a) - ordinalOf(b);
}

function ordinalOf(candidate: SnapCandidate): number {
  return candidate.vertexIndex ?? candidate.segmentIndex ?? -1;
}

function compareFeatureIds(a: FeatureId, b: FeatureId): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const left = String(a);
  const right = String(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

// ── Index ─────────────────────────────────────────────────────

/** Feature input for the snap index. Geometry is GeoJSON-shaped. */
export interface SnapIndexFeatureInput {
  id: FeatureId;
  geometry: Record<string, unknown> | null | undefined;
}

export interface SnapIndexStats {
  sourceCount: number;
  featureCount: number;
  vertexCount: number;
  segmentCount: number;
  /** Number of grid rebuilds performed so far (increments after invalidation). */
  gridBuilds: number;
}

interface IndexedFeature {
  sourceId: string;
  featureId: FeatureId;
  /** Flattened `[x, y]` vertex pairs in geometry traversal order. */
  vertices: number[];
  /** Flattened `[ax, ay, bx, by]` segment tuples in geometry traversal order. */
  segments: number[];
  /** Polygon rings (`[polygon][ring][vertex] = [x, y]`) for feature-body containment. */
  rings: SnapPosition[][][];
  bbox: readonly [number, number, number, number] | undefined;
  /** The geometry as provided, kept for optimistic rollback restoration. */
  geometry: Record<string, unknown> | null;
}

interface GridCell {
  /** `[featureRef, vertexOrdinal]` pairs. */
  vertices: Array<readonly [IndexedFeature, number]>;
  /** `[featureRef, segmentOrdinal]` pairs. */
  segments: Array<readonly [IndexedFeature, number]>;
  /** Features whose bbox overlaps this cell (feature-body candidates). */
  features: IndexedFeature[];
}

interface Grid {
  minX: number;
  minY: number;
  cellWidth: number;
  cellHeight: number;
  columns: number;
  rows: number;
  cells: Map<number, GridCell>;
}

interface QueryScope {
  vertices: ReadonlyArray<readonly [IndexedFeature, number]>;
  segments: ReadonlyArray<readonly [IndexedFeature, number]>;
  features: ReadonlyArray<IndexedFeature>;
}

/**
 * Uniform packed-grid spatial index over snap sources.
 *
 * Mutations mark the grid dirty; it is rebuilt lazily on the next query.
 * Feature geometries are treated as immutable once handed to the index.
 */
export class SnapIndex {
  #sources = new Map<string, Map<FeatureId, IndexedFeature>>();
  #grid: Grid | undefined;
  #dirty = true;
  #gridBuilds = 0;

  /** Replace every indexed feature for a source. */
  public setSourceFeatures(sourceId: string, features: readonly SnapIndexFeatureInput[]): void {
    const indexed = new Map<FeatureId, IndexedFeature>();
    for (const feature of features) indexed.set(feature.id, indexFeature(sourceId, feature));
    this.#sources.set(sourceId, indexed);
    this.invalidate();
  }

  /**
   * Insert or replace a single feature. Returns the previous feature input
   * (id + geometry) when one was indexed, so optimistic edits can restore it.
   */
  public upsertFeature(sourceId: string, feature: SnapIndexFeatureInput): SnapIndexFeatureInput | undefined {
    let indexed = this.#sources.get(sourceId);
    if (!indexed) {
      indexed = new Map();
      this.#sources.set(sourceId, indexed);
    }
    const previous = indexed.get(feature.id);
    indexed.set(feature.id, indexFeature(sourceId, feature));
    this.invalidate();
    return previous ? featureInputOf(previous) : undefined;
  }

  /** Remove a single feature. Returns the removed feature input, if any. */
  public removeFeature(sourceId: string, featureId: FeatureId): SnapIndexFeatureInput | undefined {
    const indexed = this.#sources.get(sourceId);
    const previous = indexed?.get(featureId);
    if (indexed && previous) {
      indexed.delete(featureId);
      this.invalidate();
    }
    return previous ? featureInputOf(previous) : undefined;
  }

  public removeSource(sourceId: string): void {
    if (this.#sources.delete(sourceId)) this.invalidate();
  }

  public clear(): void {
    this.#sources.clear();
    this.invalidate();
  }

  /** Force a lazy grid rebuild on the next query (e.g. after realtime updates). */
  public invalidate(): void {
    this.#dirty = true;
  }

  public sourceIds(): readonly string[] {
    return [...this.#sources.keys()];
  }

  public stats(): SnapIndexStats {
    let featureCount = 0;
    let vertexCount = 0;
    let segmentCount = 0;
    for (const features of this.#sources.values()) {
      featureCount += features.size;
      for (const feature of features.values()) {
        vertexCount += feature.vertices.length / 2;
        segmentCount += feature.segments.length / 4;
      }
    }
    return {
      sourceCount: this.#sources.size,
      featureCount,
      vertexCount,
      segmentCount,
      gridBuilds: this.#gridBuilds,
    };
  }

  /**
   * Resolve a pointer against this index. See {@link resolveSnapCandidate}
   * for the deterministic ordering contract.
   */
  public resolve(input: SnapQueryInput, config?: Partial<SnappingConfig>): SnapResolution {
    const resolved = resolveSnappingConfig(config);
    if (!resolved.enabled || resolved.tolerance < 0) return UNSNAPPED;
    const radius = searchRadius(input, resolved.tolerance);
    const scope = this.#query(
      input.position[0] - radius.x,
      input.position[1] - radius.y,
      input.position[0] + radius.x,
      input.position[1] + radius.y,
    );
    return resolveScope(scope, input, resolved);
  }

  /** Collect grid entries intersecting a geographic search box. */
  #query(minX: number, minY: number, maxX: number, maxY: number): QueryScope {
    const grid = this.#ensureGrid();
    if (!grid) return { vertices: [], segments: [], features: [] };
    const colStart = clampIndex(Math.floor((minX - grid.minX) / grid.cellWidth), grid.columns);
    const colEnd = clampIndex(Math.floor((maxX - grid.minX) / grid.cellWidth), grid.columns);
    const rowStart = clampIndex(Math.floor((minY - grid.minY) / grid.cellHeight), grid.rows);
    const rowEnd = clampIndex(Math.floor((maxY - grid.minY) / grid.cellHeight), grid.rows);
    const vertices: Array<readonly [IndexedFeature, number]> = [];
    const seenSegments = new Set<string>();
    const segments: Array<readonly [IndexedFeature, number]> = [];
    const seenFeatures = new Set<IndexedFeature>();
    const features: IndexedFeature[] = [];
    for (let row = rowStart; row <= rowEnd; row += 1) {
      for (let col = colStart; col <= colEnd; col += 1) {
        const cell = grid.cells.get(row * grid.columns + col);
        if (!cell) continue;
        for (const entry of cell.vertices) vertices.push(entry);
        for (const entry of cell.segments) {
          const key = `${entry[0].sourceId}|${String(entry[0].featureId)}|${entry[1]}`;
          if (seenSegments.has(key)) continue;
          seenSegments.add(key);
          segments.push(entry);
        }
        for (const feature of cell.features) {
          if (seenFeatures.has(feature)) continue;
          seenFeatures.add(feature);
          features.push(feature);
        }
      }
    }
    return { vertices, segments, features };
  }

  #ensureGrid(): Grid | undefined {
    if (!this.#dirty) return this.#grid;
    this.#grid = this.#buildGrid();
    this.#dirty = false;
    this.#gridBuilds += 1;
    return this.#grid;
  }

  #buildGrid(): Grid | undefined {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let primitiveCount = 0;
    const indexed: IndexedFeature[] = [];
    for (const features of this.#sources.values()) {
      for (const feature of features.values()) {
        if (!feature.bbox) continue;
        indexed.push(feature);
        minX = Math.min(minX, feature.bbox[0]);
        minY = Math.min(minY, feature.bbox[1]);
        maxX = Math.max(maxX, feature.bbox[2]);
        maxY = Math.max(maxY, feature.bbox[3]);
        primitiveCount += feature.vertices.length / 2 + feature.segments.length / 4;
      }
    }
    if (indexed.length === 0) return undefined;

    const axisCells = Math.min(128, Math.max(1, Math.ceil(Math.sqrt(primitiveCount))));
    const width = maxX - minX;
    const height = maxY - minY;
    const grid: Grid = {
      minX,
      minY,
      cellWidth: width > 0 ? width / axisCells : 1,
      cellHeight: height > 0 ? height / axisCells : 1,
      columns: width > 0 ? axisCells : 1,
      rows: height > 0 ? axisCells : 1,
      cells: new Map(),
    };

    const cellAt = (col: number, row: number): GridCell => {
      const key = row * grid.columns + col;
      let cell = grid.cells.get(key);
      if (!cell) {
        cell = { vertices: [], segments: [], features: [] };
        grid.cells.set(key, cell);
      }
      return cell;
    };
    const insertBbox = (
      bminX: number,
      bminY: number,
      bmaxX: number,
      bmaxY: number,
      insert: (cell: GridCell) => void,
    ) => {
      const colStart = clampIndex(Math.floor((bminX - grid.minX) / grid.cellWidth), grid.columns);
      const colEnd = clampIndex(Math.floor((bmaxX - grid.minX) / grid.cellWidth), grid.columns);
      const rowStart = clampIndex(Math.floor((bminY - grid.minY) / grid.cellHeight), grid.rows);
      const rowEnd = clampIndex(Math.floor((bmaxY - grid.minY) / grid.cellHeight), grid.rows);
      for (let row = rowStart; row <= rowEnd; row += 1) {
        for (let col = colStart; col <= colEnd; col += 1) insert(cellAt(col, row));
      }
    };

    for (const feature of indexed) {
      const vertices = feature.vertices;
      for (let i = 0; i < vertices.length; i += 2) {
        const ordinal = i / 2;
        insertBbox(vertices[i], vertices[i + 1], vertices[i], vertices[i + 1], (cell) =>
          cell.vertices.push([feature, ordinal]),
        );
      }
      const segments = feature.segments;
      for (let i = 0; i < segments.length; i += 4) {
        const ordinal = i / 4;
        insertBbox(
          Math.min(segments[i], segments[i + 2]),
          Math.min(segments[i + 1], segments[i + 3]),
          Math.max(segments[i], segments[i + 2]),
          Math.max(segments[i + 1], segments[i + 3]),
          (cell) => cell.segments.push([feature, ordinal]),
        );
      }
      if (feature.bbox && (feature.rings.length > 0 || feature.segments.length > 0 || feature.vertices.length > 0)) {
        insertBbox(feature.bbox[0], feature.bbox[1], feature.bbox[2], feature.bbox[3], (cell) =>
          cell.features.push(feature),
        );
      }
    }
    return grid;
  }
}

export function createSnapIndex(): SnapIndex {
  return new SnapIndex();
}

// ── Resolution ────────────────────────────────────────────────

/**
 * Resolve the pointer against the index and return the nearest snap candidate
 * under the deterministic ordering documented on this module.
 */
export function resolveSnapCandidate(
  index: SnapIndex,
  input: SnapQueryInput,
  config?: Partial<SnappingConfig>,
): SnapResolution {
  return index.resolve(input, config);
}

function resolveScope(scope: QueryScope, input: SnapQueryInput, resolved: SnappingConfig): SnapResolution {
  const kindsBySource = new Map<string, ReadonlySet<SnapCandidateKind> | undefined>();
  const kindsFor = (sourceId: string): ReadonlySet<SnapCandidateKind> | undefined => {
    if (!kindsBySource.has(sourceId)) kindsBySource.set(sourceId, sourceKinds(resolved, sourceId));
    return kindsBySource.get(sourceId);
  };

  const tolerance = resolved.tolerance;
  const candidates: SnapCandidate[] = [];
  const bestByFeature = new Map<IndexedFeature, SnapCandidate>();
  const trackFeatureBest = (feature: IndexedFeature, candidate: SnapCandidate): void => {
    const kinds = kindsFor(feature.sourceId);
    if (!kinds?.has("feature")) return;
    const featureCandidate: SnapCandidate = {
      kind: "feature",
      sourceId: candidate.sourceId,
      featureId: candidate.featureId,
      position: candidate.position,
      screenPoint: candidate.screenPoint,
      distance: candidate.distance,
    };
    const current = bestByFeature.get(feature);
    if (!current || compareSnapCandidates(featureCandidate, current) < 0) bestByFeature.set(feature, featureCandidate);
  };

  for (const [feature, ordinal] of scope.vertices) {
    const kinds = kindsFor(feature.sourceId);
    if (!kinds) continue;
    const x = feature.vertices[ordinal * 2];
    const y = feature.vertices[ordinal * 2 + 1];
    const screenPoint = input.project([x, y]);
    const distance = screenDistance(screenPoint, input.point);
    if (distance > tolerance) continue;
    const candidate: SnapCandidate = {
      kind: "vertex",
      sourceId: feature.sourceId,
      featureId: feature.featureId,
      position: [x, y],
      screenPoint,
      distance,
      vertexIndex: ordinal,
    };
    if (kinds.has("vertex")) candidates.push(candidate);
    trackFeatureBest(feature, candidate);
  }

  for (const [feature, ordinal] of scope.segments) {
    const kinds = kindsFor(feature.sourceId);
    if (!kinds || (!kinds.has("edge") && !kinds.has("feature"))) continue;
    const base = ordinal * 4;
    const ax = feature.segments[base];
    const ay = feature.segments[base + 1];
    const bx = feature.segments[base + 2];
    const by = feature.segments[base + 3];
    const screenA = input.project([ax, ay]);
    const screenB = input.project([bx, by]);
    const t = closestSegmentParameter(screenA, screenB, input.point);
    const screenPoint: SnapScreenPoint = {
      x: screenA.x + (screenB.x - screenA.x) * t,
      y: screenA.y + (screenB.y - screenA.y) * t,
    };
    const distance = screenDistance(screenPoint, input.point);
    if (distance > tolerance) continue;
    const candidate: SnapCandidate = {
      kind: "edge",
      sourceId: feature.sourceId,
      featureId: feature.featureId,
      position: [ax + (bx - ax) * t, ay + (by - ay) * t],
      screenPoint,
      distance,
      segmentIndex: ordinal,
    };
    if (kinds.has("edge")) candidates.push(candidate);
    trackFeatureBest(feature, candidate);
  }

  for (const feature of scope.features) {
    const kinds = kindsFor(feature.sourceId);
    if (!kinds?.has("feature") || feature.rings.length === 0) continue;
    if (!positionInRings(input.position, feature.rings)) continue;
    bestByFeature.set(feature, {
      kind: "feature",
      sourceId: feature.sourceId,
      featureId: feature.featureId,
      position: [input.position[0], input.position[1]],
      screenPoint: { x: input.point.x, y: input.point.y },
      distance: 0,
    });
  }

  for (const candidate of bestByFeature.values()) candidates.push(candidate);
  if (candidates.length === 0) return UNSNAPPED;
  candidates.sort(compareSnapCandidates);
  return { snapped: true, candidate: candidates[0], candidates };
}

/**
 * Return `geometry` with its active sketch vertex replaced by `position`.
 *
 * The active vertex is the last drawn coordinate: the point itself for
 * `Point`, the final coordinate for `MultiPoint` / `LineString` /
 * `MultiLineString`, and the final non-closing vertex of the last ring for
 * `Polygon` / `MultiPolygon` (ring closure is preserved). Unknown geometry
 * shapes are returned unchanged.
 */
export function withSnappedActiveVertex(
  geometry: Record<string, unknown> | null,
  position: SnapPosition,
): Record<string, unknown> | null {
  if (!geometry || typeof geometry.type !== "string") return geometry;
  const type = geometry.type;
  const coordinates = geometry.coordinates;
  const point = [position[0], position[1]];
  if (type === "Point" && Array.isArray(coordinates)) {
    return { ...geometry, coordinates: point };
  }
  if ((type === "MultiPoint" || type === "LineString") && Array.isArray(coordinates) && coordinates.length > 0) {
    const next = [...coordinates];
    next[next.length - 1] = point;
    return { ...geometry, coordinates: next };
  }
  if (type === "MultiLineString" && Array.isArray(coordinates) && coordinates.length > 0) {
    const lines = coordinates.map((line) => (Array.isArray(line) ? [...line] : line));
    const last = lines[lines.length - 1];
    if (!Array.isArray(last) || last.length === 0) return geometry;
    last[last.length - 1] = point;
    return { ...geometry, coordinates: lines };
  }
  if ((type === "Polygon" || type === "MultiPolygon") && Array.isArray(coordinates) && coordinates.length > 0) {
    const outer = coordinates.map((entry) => (Array.isArray(entry) ? [...entry] : entry));
    const rings = type === "Polygon" ? outer : outer[outer.length - 1];
    if (!Array.isArray(rings) || rings.length === 0) return geometry;
    if (type === "MultiPolygon") {
      outer[outer.length - 1] = rings.map((ring: unknown) => (Array.isArray(ring) ? [...ring] : ring));
    }
    const targetRings = type === "Polygon" ? outer : (outer[outer.length - 1] as unknown[]);
    const ring = targetRings[targetRings.length - 1];
    if (!Array.isArray(ring) || ring.length === 0) return geometry;
    const nextRing = [...ring];
    const first = nextRing[0];
    const lastIndex = nextRing.length - 1;
    const closed =
      nextRing.length > 1 &&
      Array.isArray(first) &&
      Array.isArray(nextRing[lastIndex]) &&
      first[0] === nextRing[lastIndex][0] &&
      first[1] === nextRing[lastIndex][1];
    const activeIndex = closed ? nextRing.length - 2 : nextRing.length - 1;
    if (activeIndex < 0) return geometry;
    nextRing[activeIndex] = point;
    if (closed && activeIndex === 0) nextRing[lastIndex] = [...point];
    targetRings[targetRings.length - 1] = nextRing;
    return { ...geometry, coordinates: outer };
  }
  return geometry;
}

// ── Edit-session lifecycle binding ────────────────────────────

export interface SnapIndexEditSessionHookOptions<T = Record<string, unknown>> {
  /** Hooks to compose with; index maintenance runs before delegation. */
  inner?: EditWorkflowOptimisticHooks<T>;
}

/**
 * Optimistic edit-session hooks that keep a {@link SnapIndex} in sync with
 * an edit workflow's lifecycle: `apply` upserts (or removes, for deletes)
 * the edited feature, `rollback` restores the pre-edit index entry, and
 * `commit` finalizes it. Pass the result as the `optimistic` option of
 * `createEditSession` / `createEditSketchWorkflow`.
 */
export function createSnapIndexEditSessionHooks<T = Record<string, unknown>>(
  index: SnapIndex,
  options: SnapIndexEditSessionHookOptions<T> = {},
): EditWorkflowOptimisticHooks<T> {
  interface JournalEntry {
    sourceId: string;
    featureId: FeatureId | undefined;
    previous: SnapIndexFeatureInput | undefined;
  }
  const journal: JournalEntry[] = [];
  const inner = options.inner;

  return {
    async apply(snapshot: EditWorkflowSnapshot<T>): Promise<void> {
      const sourceId = String(snapshot.sourceId);
      const featureId = snapshot.feature.id;
      let previous: SnapIndexFeatureInput | undefined;
      if (featureId !== undefined) {
        previous =
          snapshot.kind === "delete"
            ? index.removeFeature(sourceId, featureId)
            : index.upsertFeature(sourceId, { id: featureId, geometry: snapshot.feature.geometry ?? null });
      }
      journal.push({ sourceId, featureId, previous });
      await inner?.apply?.(snapshot);
    },
    async rollback(snapshot: EditWorkflowSnapshot<T>, result: EditWorkflowSubmitResult<T>): Promise<void> {
      const entry = journal.pop();
      if (entry && entry.featureId !== undefined) {
        if (entry.previous) index.upsertFeature(entry.sourceId, entry.previous);
        else index.removeFeature(entry.sourceId, entry.featureId);
      }
      await inner?.rollback?.(snapshot, result);
    },
    async commit(snapshot: EditWorkflowSnapshot<T>, result: EditWorkflowSubmitResult<T>): Promise<void> {
      const entry = journal.pop();
      const committedId = result.committedFeatureId;
      if (entry && snapshot.kind !== "delete" && committedId !== undefined && committedId !== entry.featureId) {
        // The optimistic apply could not index the feature under its
        // committed id (server-assigned id on create, or a re-keyed id), so
        // index the committed geometry now.
        if (entry.featureId !== undefined) index.removeFeature(entry.sourceId, entry.featureId);
        index.upsertFeature(entry.sourceId, { id: committedId, geometry: snapshot.feature.geometry ?? null });
      }
      await inner?.commit?.(snapshot, result);
    },
  };
}

// ── Internal helpers ──────────────────────────────────────────

function sourceKinds(config: SnappingConfig, sourceId: string): ReadonlySet<SnapCandidateKind> | undefined {
  const entry = config.sources[sourceId];
  if (entry === false) return undefined;
  if (entry === undefined || entry === true) return new Set(config.kinds);
  if (entry.enabled === false) return undefined;
  return new Set(entry.kinds ?? config.kinds);
}

function searchRadius(input: SnapQueryInput, tolerance: number): { x: number; y: number } {
  // Estimate geographic units per screen pixel around the pointer by probing
  // the projection, then over-scan by 50% to stay safe under local distortion.
  const [x, y] = input.position;
  const probe = 1e-6 * Math.max(1, Math.abs(x), Math.abs(y));
  const origin = input.project([x, y]);
  const alongX = input.project([x + probe, y]);
  const alongY = input.project([x, y + probe]);
  const pixelsPerUnitX = screenDistance(alongX, origin) / probe;
  const pixelsPerUnitY = screenDistance(alongY, origin) / probe;
  return {
    x: pixelsPerUnitX > 0 ? (tolerance / pixelsPerUnitX) * 1.5 : Number.POSITIVE_INFINITY,
    y: pixelsPerUnitY > 0 ? (tolerance / pixelsPerUnitY) * 1.5 : Number.POSITIVE_INFINITY,
  };
}

function screenDistance(a: SnapScreenPoint, b: SnapScreenPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function closestSegmentParameter(a: SnapScreenPoint, b: SnapScreenPoint, point: SnapScreenPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return 0;
  const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  return Math.min(1, Math.max(0, t));
}

function positionInRings(position: SnapPosition, polygons: SnapPosition[][][]): boolean {
  for (const rings of polygons) {
    if (rings.length === 0) continue;
    if (!positionInRing(position, rings[0])) continue;
    let inHole = false;
    for (let i = 1; i < rings.length; i += 1) {
      if (positionInRing(position, rings[i])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

function positionInRing(position: SnapPosition, ring: readonly SnapPosition[]): boolean {
  const [x, y] = position;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function clampIndex(value: number, size: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(size - 1, Math.max(0, value));
}

function featureInputOf(feature: IndexedFeature): SnapIndexFeatureInput {
  return { id: feature.featureId, geometry: feature.geometry };
}

interface GeometryAccumulator {
  vertices: number[];
  segments: number[];
  rings: SnapPosition[][][];
}

function indexFeature(sourceId: string, feature: SnapIndexFeatureInput): IndexedFeature {
  const accumulator: GeometryAccumulator = { vertices: [], segments: [], rings: [] };
  collectGeometry(feature.geometry ?? null, accumulator);
  return {
    sourceId,
    featureId: feature.id,
    vertices: accumulator.vertices,
    segments: accumulator.segments,
    rings: accumulator.rings,
    bbox: bboxOf(accumulator.vertices),
    geometry: feature.geometry ?? null,
  };
}

function bboxOf(vertices: readonly number[]): readonly [number, number, number, number] | undefined {
  if (vertices.length === 0) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < vertices.length; i += 2) {
    minX = Math.min(minX, vertices[i]);
    maxX = Math.max(maxX, vertices[i]);
    minY = Math.min(minY, vertices[i + 1]);
    maxY = Math.max(maxY, vertices[i + 1]);
  }
  return [minX, minY, maxX, maxY];
}

function collectGeometry(geometry: Record<string, unknown> | null, accumulator: GeometryAccumulator): void {
  if (!geometry || typeof geometry.type !== "string") return;
  const type = geometry.type;
  const coordinates = geometry.coordinates;
  if (type === "GeometryCollection" && Array.isArray(geometry.geometries)) {
    for (const nested of geometry.geometries) {
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        collectGeometry(nested as Record<string, unknown>, accumulator);
      }
    }
    return;
  }
  if (type === "Point") {
    const position = toPosition(coordinates);
    if (position) accumulator.vertices.push(position[0], position[1]);
    return;
  }
  if (type === "MultiPoint" && Array.isArray(coordinates)) {
    for (const entry of coordinates) {
      const position = toPosition(entry);
      if (position) accumulator.vertices.push(position[0], position[1]);
    }
    return;
  }
  if (type === "LineString") {
    collectPath(coordinates, accumulator, false);
    return;
  }
  if (type === "MultiLineString" && Array.isArray(coordinates)) {
    for (const line of coordinates) collectPath(line, accumulator, false);
    return;
  }
  if (type === "Polygon") {
    collectPolygon(coordinates, accumulator);
    return;
  }
  if (type === "MultiPolygon" && Array.isArray(coordinates)) {
    for (const polygon of coordinates) collectPolygon(polygon, accumulator);
  }
}

function collectPolygon(coordinates: unknown, accumulator: GeometryAccumulator): void {
  if (!Array.isArray(coordinates)) return;
  const rings: SnapPosition[][] = [];
  for (const ring of coordinates) {
    const positions = collectPath(ring, accumulator, true);
    if (positions.length >= 3) rings.push(positions);
  }
  if (rings.length > 0) accumulator.rings.push(rings);
}

function collectPath(coordinates: unknown, accumulator: GeometryAccumulator, isRing: boolean): SnapPosition[] {
  if (!Array.isArray(coordinates)) return [];
  const positions: SnapPosition[] = [];
  for (const entry of coordinates) {
    const position = toPosition(entry);
    if (position) positions.push(position);
  }
  const closed =
    isRing &&
    positions.length > 1 &&
    positions[0][0] === positions[positions.length - 1][0] &&
    positions[0][1] === positions[positions.length - 1][1];
  const vertexCount = closed ? positions.length - 1 : positions.length;
  for (let i = 0; i < vertexCount; i += 1) accumulator.vertices.push(positions[i][0], positions[i][1]);
  for (let i = 0; i < positions.length - 1; i += 1) {
    accumulator.segments.push(positions[i][0], positions[i][1], positions[i + 1][0], positions[i + 1][1]);
  }
  return positions;
}

function toPosition(value: unknown): SnapPosition | undefined {
  return Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number"
    ? [value[0], value[1]]
    : undefined;
}
