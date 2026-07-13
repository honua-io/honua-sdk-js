/**
 * MapLibre runtime binding for edit-sketch snapping.
 *
 * Wires pointer-move on a MapLibre-shaped map to the renderer-neutral
 * snapping engine in `contract/edit-snapping.ts`, applies snapped
 * coordinates to an `EditSketchWorkflowModel`, surfaces snapped / unsnapped
 * events, and maintains a default visual indicator via a lightweight GeoJSON
 * circle layer.
 *
 * The map interfaces are duck-typed (same pattern as
 * `interactions/feature-state.ts`) so the SDK carries no hard runtime
 * dependency on `maplibre-gl`.
 *
 * @module
 */

import type { EditSketchTool, EditSketchWorkflowModel } from "../contract/edit-sketch.js";
import {
  type SnapCandidate,
  type SnapIndex,
  type SnapPosition,
  type SnapResolution,
  type SnapScreenPoint,
  type SnappingConfig,
  resolveSnapCandidate,
  resolveSnappingConfig,
  withSnappedActiveVertex,
} from "../contract/edit-snapping.js";

// ── Duck-typed map surface ────────────────────────────────────

/** Minimal subset of a MapLibre `Map` needed for snapping. */
export interface SnappingMap {
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  project(position: readonly [number, number]): SnapScreenPoint | { x: number; y: number };
  addSource?(id: string, source: Record<string, unknown>): void;
  removeSource?(id: string): void;
  addLayer?(layer: Record<string, unknown>, beforeId?: string): void;
  removeLayer?(id: string): void;
  getSource?(id: string): unknown;
  getLayer?(id: string): unknown;
}

// ── Options / handle ──────────────────────────────────────────

export interface EditSketchSnapIndicatorOptions {
  /** Render the default indicator layer. @default true */
  enabled?: boolean;
  /** Indicator source and layer id. @default "honua-snap-indicator" */
  id?: string;
  /** Paint overrides merged over the default circle paint. */
  paint?: Record<string, unknown>;
  /** Insert the indicator layer before this layer id. */
  beforeId?: string;
}

export interface EditSketchSnappingEvents {
  /** Fired when the pointer acquires or changes a snap target. */
  onSnap?(resolution: SnapResolution): void;
  /** Fired when the pointer leaves a snap target; receives the lost candidate. */
  onUnsnap?(previous: SnapCandidate): void;
}

export interface BindEditSketchSnappingOptions<T = Record<string, unknown>> extends EditSketchSnappingEvents {
  /** Snap index over the loaded snap-source features. */
  index: SnapIndex;
  /**
   * Sketch workflow whose snapping config drives resolution and that
   * receives snapped geometry via {@link EditSketchSnappingHandle.applySketchGeometry}.
   * When omitted, pass `config` and consume snaps through events / `current`.
   */
  model?: EditSketchWorkflowModel<T>;
  /** Snapping configuration when no model is bound (or overrides for one-off use). */
  config?: Partial<SnappingConfig>;
  /** Pointer event name to listen for. @default "mousemove" */
  pointerEvent?: string;
  /** Default snap indicator; `false` disables it. */
  indicator?: boolean | EditSketchSnapIndicatorOptions;
}

export interface EditSketchSnappingHandle {
  /** The currently snapped candidate, if any. */
  readonly current: SnapCandidate | undefined;
  /** Resolve a pointer position without going through a map event. */
  resolve(input: { point: SnapScreenPoint; position: SnapPosition }): SnapResolution;
  /** Return the snapped position for `position`, or `position` unchanged. */
  snapPosition(position: SnapPosition): SnapPosition;
  /** Effective snapping configuration. */
  config(): SnappingConfig;
  /** Merge configuration changes (writes through to the bound model). */
  setConfig(config: Partial<SnappingConfig>): void;
  /**
   * Apply `geometry` to the bound sketch model with its active vertex
   * replaced by the current snap position (no-op replacement when the
   * pointer is not snapped). Returns `true` when the model accepted the
   * geometry.
   */
  applySketchGeometry(tool: EditSketchTool, geometry: Record<string, unknown> | null): boolean;
  /** Detach event handlers and remove the indicator layer. */
  remove(): void;
}

const DEFAULT_INDICATOR_ID = "honua-snap-indicator";

const DEFAULT_INDICATOR_PAINT: Readonly<Record<string, unknown>> = Object.freeze({
  "circle-radius": 6,
  "circle-color": ["match", ["get", "kind"], "vertex", "#2563eb", "edge", "#0891b2", "#64748b"],
  "circle-opacity": 0.9,
  "circle-stroke-color": "#ffffff",
  "circle-stroke-width": 2,
});

/**
 * Bind edit-sketch snapping to a MapLibre-shaped map.
 *
 * @example
 * ```ts
 * const index = createSnapIndex();
 * index.setSourceFeatures("parcels", parcels);
 * const snapping = bindEditSketchSnapping(map, {
 *   index,
 *   model: workflow,
 *   onSnap: ({ candidate }) => showGuide(candidate),
 * });
 * map.on("click", (e) => {
 *   snapping.applySketchGeometry("point", { type: "Point", coordinates: [e.lngLat.lng, e.lngLat.lat] });
 * });
 * ```
 */
export function bindEditSketchSnapping<T = Record<string, unknown>>(
  map: SnappingMap,
  options: BindEditSketchSnappingOptions<T>,
): EditSketchSnappingHandle {
  const { index, model } = options;
  let localConfig = resolveSnappingConfig(options.config);
  const effectiveConfig = (): SnappingConfig => (model && !options.config ? model.snappingConfig() : localConfig);

  const pointerEvent = options.pointerEvent ?? "mousemove";
  const indicator = normalizeIndicatorOptions(options.indicator);
  const indicatorInstalled = indicator.enabled ? installIndicator(map, indicator) : false;

  let current: SnapCandidate | undefined;

  const project = (position: SnapPosition): SnapScreenPoint => {
    const projected = map.project([position[0], position[1]]);
    return { x: projected.x, y: projected.y };
  };

  const resolve = (input: { point: SnapScreenPoint; position: SnapPosition }): SnapResolution =>
    resolveSnapCandidate(index, { point: input.point, position: input.position, project }, effectiveConfig());

  const applyResolution = (resolution: SnapResolution): void => {
    const previous = current;
    current = resolution.candidate;
    if (indicatorInstalled) updateIndicator(map, indicator.id, current);
    if (current) {
      if (!previous || !sameCandidate(previous, current)) options.onSnap?.(resolution);
    } else if (previous) {
      options.onUnsnap?.(previous);
    }
  };

  const onPointerMove = (...args: unknown[]): void => {
    const input = pointerInput(args[0]);
    if (!input) return;
    applyResolution(resolve(input));
  };

  map.on(pointerEvent, onPointerMove);

  return {
    get current() {
      return current;
    },
    resolve(input) {
      const resolution = resolve(input);
      applyResolution(resolution);
      return resolution;
    },
    snapPosition(position) {
      const resolution = resolve({ point: project(position), position });
      return resolution.candidate ? resolution.candidate.position : position;
    },
    config() {
      return effectiveConfig();
    },
    setConfig(config) {
      if (model) model.setSnapping(config);
      localConfig = resolveSnappingConfig({ ...localConfig, ...config });
      // Disabling snapping must not leave a stale snap target behind: clear
      // the current candidate, indicator, and fire onUnsnap.
      if (!effectiveConfig().enabled && current) {
        applyResolution({ snapped: false, candidates: [] });
      }
    },
    applySketchGeometry(tool, geometry) {
      if (!model) return false;
      // Gate on the effective config so a snap acquired before snapping was
      // disabled (e.g. directly via model.setSnapping) is never applied.
      const active = effectiveConfig().enabled ? current : undefined;
      const snapped = active ? withSnappedActiveVertex(geometry, active.position) : geometry;
      const capability = model.setSketchGeometry(tool, snapped).toolCapability(tool);
      return capability.state === "supported";
    },
    remove() {
      map.off(pointerEvent, onPointerMove);
      if (indicatorInstalled) removeIndicator(map, indicator.id);
      current = undefined;
    },
  };
}

// ── Internals ─────────────────────────────────────────────────

interface ResolvedIndicatorOptions {
  enabled: boolean;
  id: string;
  paint: Record<string, unknown>;
  beforeId?: string;
}

function normalizeIndicatorOptions(
  input: boolean | EditSketchSnapIndicatorOptions | undefined,
): ResolvedIndicatorOptions {
  const options = typeof input === "object" ? input : {};
  return {
    enabled: input === false ? false : (options.enabled ?? true),
    id: options.id ?? DEFAULT_INDICATOR_ID,
    paint: { ...DEFAULT_INDICATOR_PAINT, ...(options.paint ?? {}) },
    ...(options.beforeId ? { beforeId: options.beforeId } : {}),
  };
}

function installIndicator(map: SnappingMap, options: ResolvedIndicatorOptions): boolean {
  if (!map.addSource || !map.addLayer) return false;
  if (!map.getSource?.(options.id)) {
    map.addSource(options.id, { type: "geojson", data: emptyIndicatorData() });
  }
  if (!map.getLayer?.(options.id)) {
    map.addLayer({ id: options.id, type: "circle", source: options.id, paint: options.paint }, options.beforeId);
  }
  return true;
}

function updateIndicator(map: SnappingMap, id: string, candidate: SnapCandidate | undefined): void {
  const source = map.getSource?.(id) as { setData?(data: unknown): void } | undefined;
  source?.setData?.(candidate ? indicatorData(candidate) : emptyIndicatorData());
}

function removeIndicator(map: SnappingMap, id: string): void {
  if (map.getLayer?.(id)) map.removeLayer?.(id);
  if (map.getSource?.(id)) map.removeSource?.(id);
}

function emptyIndicatorData(): Record<string, unknown> {
  return { type: "FeatureCollection", features: [] };
}

function indicatorData(candidate: SnapCandidate): Record<string, unknown> {
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [candidate.position[0], candidate.position[1]] },
        properties: {
          kind: candidate.kind,
          sourceId: candidate.sourceId,
          featureId: candidate.featureId,
          ...(candidate.vertexIndex !== undefined ? { vertexIndex: candidate.vertexIndex } : {}),
          ...(candidate.segmentIndex !== undefined ? { segmentIndex: candidate.segmentIndex } : {}),
        },
      },
    ],
  };
}

function sameCandidate(a: SnapCandidate, b: SnapCandidate): boolean {
  return (
    a.kind === b.kind &&
    a.sourceId === b.sourceId &&
    a.featureId === b.featureId &&
    a.vertexIndex === b.vertexIndex &&
    a.segmentIndex === b.segmentIndex &&
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1]
  );
}

function pointerInput(event: unknown): { point: SnapScreenPoint; position: SnapPosition } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const candidate = event as { point?: unknown; lngLat?: unknown };
  const point = candidate.point as { x?: unknown; y?: unknown } | undefined;
  const lngLat = candidate.lngLat as { lng?: unknown; lat?: unknown } | undefined;
  if (typeof point?.x !== "number" || typeof point.y !== "number") return undefined;
  if (typeof lngLat?.lng !== "number" || typeof lngLat.lat !== "number") return undefined;
  return { point: { x: point.x, y: point.y }, position: [lngLat.lng, lngLat.lat] };
}
