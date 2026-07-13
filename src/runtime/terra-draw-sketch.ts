/**
 * terra-draw binding for edit-sketch workflows.
 *
 * Adapts [terra-draw](https://terradraw.io) draw modes (point, linestring,
 * polygon, rectangle, circle, freehand, select) to the renderer-neutral
 * {@link EditSketchWorkflowModel}, so completed and edited geometries flow
 * through the contract edit-session path — undo/redo, validation, and
 * `applyEdits` submission all apply unchanged.
 *
 * terra-draw is an OPTIONAL peer dependency. This module never imports it at
 * module scope: {@link bindTerraDrawSketch} accepts a duck-typed instance the
 * app constructed itself, and {@link createTerraDrawSketch} pulls in
 * `terra-draw` + `terra-draw-maplibre-gl-adapter` lazily via dynamic
 * `import()` the first time it is called. Importing the SDK without terra-draw
 * installed stays side-effect free.
 *
 * Snapping bridges through terra-draw's own pointer pipeline:
 * {@link createTerraDrawSnapping} produces a function with terra-draw's
 * `Snapping.toCustom` shape backed by the SDK {@link SnapIndex}, so the
 * linestring / polygon / polyline modes snap against SDK-indexed features.
 * Modes without a `snapping` option (point, rectangle, circle, freehand) keep
 * terra-draw's native behavior; that seam is documented rather than papered
 * over.
 *
 * @module
 */

import type {
  EditSketchTool,
  EditSketchToolCapability,
  EditSketchToolCapabilityInput,
  EditSketchWorkflowModel,
} from "../contract/edit-sketch.js";
import {
  type SnapIndex,
  type SnapResolution,
  type SnappingConfig,
  resolveSnapCandidate,
  resolveSnappingConfig,
} from "../contract/edit-snapping.js";

// ── Duck-typed terra-draw surface ─────────────────────────────

/** terra-draw feature ids are strings (uuid4 by default) or numbers. @experimental */
export type TerraDrawSketchFeatureId = string | number;

/** GeoJSON-shaped feature as stored by terra-draw. @experimental */
export interface TerraDrawSketchFeature {
  id?: TerraDrawSketchFeatureId;
  type?: string;
  geometry: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

/** Context passed to terra-draw `finish` listeners. @experimental */
export interface TerraDrawSketchFinishContext {
  /** The terra-draw mode that finished (e.g. `"polygon"`). */
  mode: string;
  /** The finishing action (`"draw"`, `"dragCoordinate"`, `"dragFeature"`, ...). */
  action: string;
}

type TerraDrawFinishListener = (id: TerraDrawSketchFeatureId, context: TerraDrawSketchFinishContext) => void;
type TerraDrawChangeListener = (ids: TerraDrawSketchFeatureId[], type: string, context?: unknown) => void;
type TerraDrawSelectionListener = (id: TerraDrawSketchFeatureId) => void;

/**
 * Minimal duck-typed subset of a terra-draw `TerraDraw` instance used by the
 * binding, so the SDK carries no compile- or run-time dependency on the
 * optional `terra-draw` peer (same pattern as `SnappingMap`).
 *
 * @experimental
 */
export interface TerraDrawSketchInstance {
  on(event: "finish", listener: TerraDrawFinishListener): void;
  on(event: "change", listener: TerraDrawChangeListener): void;
  on(event: "select", listener: TerraDrawSelectionListener): void;
  on(event: "deselect", listener: TerraDrawSelectionListener): void;
  off(event: "finish", listener: TerraDrawFinishListener): void;
  off(event: "change", listener: TerraDrawChangeListener): void;
  off(event: "select", listener: TerraDrawSelectionListener): void;
  off(event: "deselect", listener: TerraDrawSelectionListener): void;
  setMode(mode: string): void;
  getSnapshot(): TerraDrawSketchFeature[];
  getSnapshotFeature?(id: TerraDrawSketchFeatureId): TerraDrawSketchFeature | undefined;
  addFeatures?(features: TerraDrawSketchFeature[]): unknown;
  removeFeatures?(ids: TerraDrawSketchFeatureId[]): void;
}

// ── Tool / mode mapping ───────────────────────────────────────

/**
 * Canonical terra-draw mode for each {@link EditSketchTool}. `buffer` has no
 * terra-draw equivalent (it needs geometry-service support) and maps to
 * `undefined`.
 *
 * @experimental
 */
export const TERRA_DRAW_SKETCH_TOOL_MODES: Readonly<Record<EditSketchTool, string | undefined>> = Object.freeze({
  point: "point",
  line: "linestring",
  polygon: "polygon",
  rectangle: "rectangle",
  circle: "circle",
  buffer: undefined,
});

const MODE_TO_TOOL: Readonly<Record<string, EditSketchTool>> = Object.freeze({
  point: "point",
  marker: "point",
  linestring: "line",
  polyline: "line",
  "freehand-linestring": "line",
  polygon: "polygon",
  freehand: "polygon",
  sector: "polygon",
  sensor: "polygon",
  rectangle: "rectangle",
  "angled-rectangle": "rectangle",
  circle: "circle",
});

/**
 * Map a terra-draw mode name to the {@link EditSketchTool} it produces.
 * Freehand and sector/sensor modes draw polygons; marker draws points.
 * Returns `undefined` for modes with no sketch-tool equivalent (`select`,
 * `render`, `static`, custom modes).
 *
 * @experimental
 */
export function editSketchToolForTerraDrawMode(mode: string): EditSketchTool | undefined {
  return MODE_TO_TOOL[mode];
}

/**
 * Sketch-tool capability overrides for a workflow driven by terra-draw.
 *
 * The contract defaults mark `rectangle` and `circle` as unsupported because
 * they need renderer support; terra-draw provides it. Pass the registered
 * terra-draw mode names (defaults to every canonical drawing mode) and feed
 * the result to `createEditSketchWorkflow({ sketchTools })`.
 *
 * @experimental
 */
export function terraDrawSketchToolCapabilities(
  modes?: readonly string[],
): Partial<Record<EditSketchTool, EditSketchToolCapabilityInput>> {
  const registered = new Set(modes ?? Object.keys(MODE_TO_TOOL));
  const capabilities: Partial<Record<EditSketchTool, EditSketchToolCapabilityInput>> = {};
  for (const tool of ["point", "line", "polygon", "rectangle", "circle"] as const) {
    const supported = [...registered].some((mode) => MODE_TO_TOOL[mode] === tool);
    capabilities[tool] = supported
      ? "supported"
      : { state: "unsupported", reason: `no terra-draw mode registered for the ${tool} tool` };
  }
  return capabilities;
}

// ── Binding ───────────────────────────────────────────────────

/** A finished terra-draw sketch as applied (or not) to the workflow model. @experimental */
export interface TerraDrawSketchFinishEvent {
  featureId: TerraDrawSketchFeatureId;
  /** The sketch tool the finished mode mapped to, when one exists. */
  tool?: EditSketchTool;
  /** The terra-draw mode that produced the feature. */
  mode: string;
  /** The terra-draw finishing action (`"draw"`, `"dragFeature"`, ...). */
  action: string;
  /** Geometry handed to the model (after `transformGeometry`). */
  geometry: Record<string, unknown> | null;
  /** Whether the model accepted the geometry (mapped + supported tool). */
  applied: boolean;
}

/** @experimental */
export interface BindTerraDrawSketchOptions<T = Record<string, unknown>> {
  /** Sketch workflow that receives finished geometries. */
  model: EditSketchWorkflowModel<T>;
  /**
   * Transform a completed terra-draw geometry (always EPSG:4326 GeoJSON)
   * before it reaches the model — e.g. `(g) => toWebMercator(g, 4326)` from
   * `@honua/sdk-js/geometry` when the edit source stores Web Mercator.
   */
  transformGeometry?(geometry: Record<string, unknown>): Record<string, unknown>;
  /**
   * Inverse of {@link BindTerraDrawSketchOptions.transformGeometry}, used when
   * pushing model geometry back into terra-draw after undo/redo.
   */
  restoreGeometry?(geometry: Record<string, unknown>): Record<string, unknown>;
  /**
   * Scope which terra-draw features drive the model. Features rejected by the
   * filter still surface through {@link BindTerraDrawSketchOptions.onFinish}
   * with `applied: false`.
   */
  featureFilter?(id: TerraDrawSketchFeatureId, feature: TerraDrawSketchFeature): boolean;
  /** Override the terra-draw mode → sketch tool mapping. */
  toolForMode?(mode: string): EditSketchTool | undefined;
  /** Fired after every terra-draw `finish` event, applied or not. */
  onFinish?(event: TerraDrawSketchFinishEvent): void;
  /** Fired when the tracked sketch feature is deleted in terra-draw. */
  onDelete?(featureId: TerraDrawSketchFeatureId): void;
  onSelect?(featureId: TerraDrawSketchFeatureId): void;
  onDeselect?(featureId: TerraDrawSketchFeatureId): void;
}

/** @experimental */
export interface TerraDrawSketchHandle {
  /** The terra-draw feature currently backing the model geometry. */
  readonly activeFeatureId: TerraDrawSketchFeatureId | undefined;
  /** The feature currently selected in terra-draw select mode, if any. */
  readonly selectedFeatureId: TerraDrawSketchFeatureId | undefined;
  /**
   * Activate the terra-draw mode for `tool` and arm the model
   * (`model.startSketch`). Returns the tool capability; unsupported tools do
   * not change the terra-draw mode.
   */
  setTool(tool: EditSketchTool): EditSketchToolCapability;
  /** Switch terra-draw to select mode for update/reshape editing. */
  select(): void;
  /** Leave any drawing/select mode (terra-draw `"static"`). */
  cancel(): void;
  /** Undo via the workflow model, then sync terra-draw to the model. */
  undo(): boolean;
  /** Redo via the workflow model, then sync terra-draw to the model. */
  redo(): boolean;
  /**
   * Replace the tracked terra-draw feature with the model's current geometry
   * (applying `restoreGeometry` first). Returns `false` when the instance
   * cannot mutate features (`addFeatures`/`removeFeatures` missing).
   */
  syncFromModel(): boolean;
  /** Detach every terra-draw listener. */
  remove(): void;
}

/**
 * Bind a terra-draw instance to an {@link EditSketchWorkflowModel} (REQ-001).
 *
 * Every terra-draw `finish` event (freshly drawn features and select-mode
 * edits: dragged features, dragged/inserted/deleted coordinates) maps the
 * finishing mode to an {@link EditSketchTool} and applies the feature geometry
 * through `model.setSketchGeometry`, so workflow undo/redo and validation
 * cover terra-draw edits. Deleting the tracked feature stages a `null`
 * geometry through the same undoable path.
 *
 * The caller owns the terra-draw instance lifecycle (`start`/`stop`); the
 * binding only attaches listeners and detaches them in `remove()`.
 *
 * @example
 * ```ts
 * const workflow = createEditSketchWorkflow({ source, sketchTools: terraDrawSketchToolCapabilities() });
 * const handle = bindTerraDrawSketch(draw, { model: workflow });
 * handle.setTool("polygon");        // draw.setMode("polygon") + workflow arming
 * // ... user draws; workflow.snapshot().sketch.geometry now tracks terra-draw
 * handle.undo();                    // workflow history, mirrored back into terra-draw
 * await workflow.submit();          // edit-session applyEdits path, unchanged
 * ```
 *
 * @experimental
 */
export function bindTerraDrawSketch<T = Record<string, unknown>>(
  draw: TerraDrawSketchInstance,
  options: BindTerraDrawSketchOptions<T>,
): TerraDrawSketchHandle {
  const { model } = options;
  const toolForMode = options.toolForMode ?? editSketchToolForTerraDrawMode;
  const toolsByFeature = new Map<TerraDrawSketchFeatureId, EditSketchTool>();

  let activeFeatureId: TerraDrawSketchFeatureId | undefined;
  let selectedFeatureId: TerraDrawSketchFeatureId | undefined;
  let syncing = false;

  const featureById = (id: TerraDrawSketchFeatureId): TerraDrawSketchFeature | undefined =>
    draw.getSnapshotFeature?.(id) ?? draw.getSnapshot().find((feature) => feature.id === id);

  const onFinish: TerraDrawFinishListener = (id, context) => {
    if (syncing) return;
    const feature = featureById(id);
    const mode = modeOf(feature, context);
    const tool = toolForMode(mode);
    const included = feature === undefined || (options.featureFilter?.(id, feature) ?? true);
    let applied = false;
    let geometry: Record<string, unknown> | null = null;
    if (feature && tool && included) {
      const cloned = cloneJsonLike(feature.geometry) as Record<string, unknown>;
      geometry = options.transformGeometry ? options.transformGeometry(cloned) : cloned;
      applied = model.setSketchGeometry(tool, geometry).toolCapability(tool).state === "supported";
      if (applied) {
        const previousId = activeFeatureId;
        activeFeatureId = id;
        toolsByFeature.set(id, tool);
        if (previousId !== undefined && previousId !== id) {
          // The workflow model tracks a single sketch geometry, so a newly
          // finished feature replaces the previous one: drop the stale
          // draw-store feature instead of letting duplicates accumulate.
          // No syncing guard needed: onChange ignores deletes whose ids do
          // not include the (already swapped) activeFeatureId.
          toolsByFeature.delete(previousId);
          if (draw.removeFeatures && featureById(previousId)) draw.removeFeatures([previousId]);
        }
      }
    }
    options.onFinish?.({ featureId: id, ...(tool ? { tool } : {}), mode, action: context.action, geometry, applied });
  };

  const onChange: TerraDrawChangeListener = (ids, type) => {
    if (syncing || type !== "delete") return;
    if (activeFeatureId === undefined || !ids.includes(activeFeatureId)) return;
    const removedId = activeFeatureId;
    const tool = toolsByFeature.get(removedId) ?? model.snapshot().sketch.tool ?? "point";
    model.setSketchGeometry(tool, null);
    toolsByFeature.delete(removedId);
    activeFeatureId = undefined;
    if (selectedFeatureId === removedId) selectedFeatureId = undefined;
    options.onDelete?.(removedId);
  };

  const onSelect: TerraDrawSelectionListener = (id) => {
    selectedFeatureId = id;
    options.onSelect?.(id);
  };

  const onDeselect: TerraDrawSelectionListener = (id) => {
    if (selectedFeatureId === id || selectedFeatureId === undefined) selectedFeatureId = undefined;
    options.onDeselect?.(id);
  };

  draw.on("finish", onFinish);
  draw.on("change", onChange);
  draw.on("select", onSelect);
  draw.on("deselect", onDeselect);

  const syncFromModel = (): boolean => {
    if (!draw.removeFeatures || !draw.addFeatures) return false;
    const snapshot = model.snapshot();
    const geometry = snapshot.sketch.geometry ?? null;
    syncing = true;
    try {
      if (activeFeatureId !== undefined && featureById(activeFeatureId)) {
        draw.removeFeatures([activeFeatureId]);
      }
      if (geometry === null) {
        if (activeFeatureId !== undefined) toolsByFeature.delete(activeFeatureId);
        activeFeatureId = undefined;
        return true;
      }
      const restored = options.restoreGeometry
        ? options.restoreGeometry(cloneJsonLike(geometry) as Record<string, unknown>)
        : (cloneJsonLike(geometry) as Record<string, unknown>);
      const tool =
        (activeFeatureId !== undefined ? toolsByFeature.get(activeFeatureId) : undefined) ?? snapshot.sketch.tool;
      const mode = tool ? (TERRA_DRAW_SKETCH_TOOL_MODES[tool] ?? "polygon") : "polygon";
      const restoreId = activeFeatureId;
      const feature: TerraDrawSketchFeature = {
        ...(restoreId !== undefined ? { id: restoreId } : {}),
        type: "Feature",
        geometry: restored,
        properties: { mode },
      };
      // Restoring after a delete leaves the id up to terra-draw: diff the
      // snapshot to adopt the assigned id so the restored sketch stays
      // tracked for later deletes/changes.
      const priorIds = restoreId === undefined ? new Set(draw.getSnapshot().map((entry) => entry.id)) : undefined;
      draw.addFeatures([feature]);
      if (priorIds) {
        const added = draw.getSnapshot().find((entry) => entry.id !== undefined && !priorIds.has(entry.id));
        if (added?.id !== undefined) {
          activeFeatureId = added.id;
          if (tool) toolsByFeature.set(added.id, tool);
        }
      }
      return true;
    } finally {
      syncing = false;
    }
  };

  return {
    get activeFeatureId() {
      return activeFeatureId;
    },
    get selectedFeatureId() {
      return selectedFeatureId;
    },
    setTool(tool) {
      const capability = model.startSketch(tool);
      const mode = TERRA_DRAW_SKETCH_TOOL_MODES[tool];
      if (capability.state === "supported" && mode !== undefined) draw.setMode(mode);
      return capability;
    },
    select() {
      draw.setMode("select");
    },
    cancel() {
      draw.setMode("static");
    },
    undo() {
      const undone = model.undo();
      if (undone) syncFromModel();
      return undone;
    },
    redo() {
      const redone = model.redo();
      if (redone) syncFromModel();
      return redone;
    },
    syncFromModel,
    remove() {
      draw.off("finish", onFinish);
      draw.off("change", onChange);
      draw.off("select", onSelect);
      draw.off("deselect", onDeselect);
    },
  };
}

// ── Snapping bridge (REQ-004) ─────────────────────────────────

/** Pointer event shape terra-draw hands to `Snapping.toCustom`. @experimental */
export interface TerraDrawSnapEvent {
  lng: number;
  lat: number;
  containerX: number;
  containerY: number;
}

/** Context shape terra-draw hands to `Snapping.toCustom`. @experimental */
export interface TerraDrawSnapContext {
  project(lng: number, lat: number): { x: number; y: number };
}

/** @experimental */
export interface CreateTerraDrawSnappingOptions<T = Record<string, unknown>> {
  /** Snap index over the loaded snap-source features. */
  index: SnapIndex;
  /** Workflow whose live snapping config gates resolution. */
  model?: EditSketchWorkflowModel<T>;
  /** Snapping configuration when no model is bound (or one-off overrides). */
  config?: Partial<SnappingConfig>;
  /** Fired on every resolved pointer position (snapped or not). */
  onResolve?(resolution: SnapResolution): void;
}

/**
 * Build a snapping function with terra-draw's `Snapping.toCustom` shape backed
 * by the SDK snapping engine (REQ-004).
 *
 * terra-draw exposes per-mode snapping on its linestring, polygon, and
 * polyline modes; pass the result as `snapping.toCustom` when constructing
 * those modes and every drawn vertex snaps against the {@link SnapIndex}
 * with the SDK's deterministic candidate ordering. Point, rectangle, circle,
 * and freehand modes do not accept a `snapping` option in terra-draw — for
 * those, terra-draw's pointer pipeline has no custom-snapping seam, so only
 * terra-draw-native behavior applies.
 *
 * @example
 * ```ts
 * const snap = createTerraDrawSnapping({ index, model: workflow });
 * new TerraDrawPolygonMode({ snapping: { toCustom: snap } });
 * ```
 *
 * @experimental
 */
export function createTerraDrawSnapping<T = Record<string, unknown>>(
  options: CreateTerraDrawSnappingOptions<T>,
): (event: TerraDrawSnapEvent, context: TerraDrawSnapContext) => [number, number] | undefined {
  const effectiveConfig = (): SnappingConfig =>
    options.model && !options.config ? options.model.snappingConfig() : resolveSnappingConfig(options.config);
  return (event, context) => {
    const resolution = resolveSnapCandidate(
      options.index,
      {
        point: { x: event.containerX, y: event.containerY },
        position: [event.lng, event.lat],
        project: (position) => context.project(position[0], position[1]),
      },
      effectiveConfig(),
    );
    options.onResolve?.(resolution);
    return resolution.candidate ? [resolution.candidate.position[0], resolution.candidate.position[1]] : undefined;
  };
}

// ── Dynamic factory (optional peer, REQ-002) ──────────────────

/** @experimental */
export interface CreateTerraDrawSketchOptions<T = Record<string, unknown>>
  extends Omit<BindTerraDrawSketchOptions<T>, never> {
  /** Wire SDK snapping into the linestring/polygon modes' `toCustom` hook. */
  snapping?: CreateTerraDrawSnappingOptions<T>;
}

/** @experimental */
export interface TerraDrawSketchController<T = Record<string, unknown>> extends TerraDrawSketchHandle {
  /** The constructed terra-draw instance (duck-typed). */
  readonly draw: TerraDrawSketchInstance;
  /** The bound workflow model. */
  readonly model: EditSketchWorkflowModel<T>;
  /** Stop terra-draw and detach the binding. */
  stop(): void;
}

interface TerraDrawModuleLike {
  TerraDraw: new (options: { adapter: unknown; modes: unknown[] }) => TerraDrawSketchInstance & {
    start(): void;
    stop(): void;
  };
  TerraDrawPointMode: new (options?: Record<string, unknown>) => unknown;
  TerraDrawLineStringMode: new (options?: Record<string, unknown>) => unknown;
  TerraDrawPolygonMode: new (options?: Record<string, unknown>) => unknown;
  TerraDrawRectangleMode: new (options?: Record<string, unknown>) => unknown;
  TerraDrawCircleMode: new (options?: Record<string, unknown>) => unknown;
  TerraDrawFreehandMode: new (options?: Record<string, unknown>) => unknown;
  TerraDrawSelectMode: new (options?: Record<string, unknown>) => unknown;
}

interface TerraDrawMaplibreAdapterModuleLike {
  TerraDrawMapLibreGLAdapter: new (options: { map: unknown }) => unknown;
}

async function loadTerraDrawModules(): Promise<{
  terraDraw: TerraDrawModuleLike;
  adapter: TerraDrawMaplibreAdapterModuleLike;
}> {
  let terraDraw: TerraDrawModuleLike;
  try {
    terraDraw = (await import("terra-draw")) as unknown as TerraDrawModuleLike;
  } catch (cause) {
    throw new Error(
      "terra-draw-sketch: terra-draw is an optional peer dependency and is not installed. " +
        "Install it with `npm i terra-draw terra-draw-maplibre-gl-adapter` to use createTerraDrawSketch().",
      { cause: cause instanceof Error ? cause : undefined },
    );
  }
  let adapter: TerraDrawMaplibreAdapterModuleLike;
  try {
    adapter = (await import("terra-draw-maplibre-gl-adapter")) as unknown as TerraDrawMaplibreAdapterModuleLike;
  } catch (cause) {
    throw new Error(
      "terra-draw-sketch: terra-draw-maplibre-gl-adapter is an optional peer dependency and is not installed. " +
        "Install it with `npm i terra-draw-maplibre-gl-adapter` to use createTerraDrawSketch() on a MapLibre map.",
      { cause: cause instanceof Error ? cause : undefined },
    );
  }
  return { terraDraw, adapter };
}

/** Default select-mode flags: every mode's features selectable and reshapeable. */
function defaultSelectFlags(modes: readonly string[]): Record<string, unknown> {
  const flags: Record<string, unknown> = {};
  for (const mode of modes) {
    flags[mode] = {
      feature: {
        draggable: true,
        coordinates: { draggable: true, midpoints: true, deletable: true },
      },
    };
  }
  return flags;
}

/**
 * One-call terra-draw sketch setup for a MapLibre map.
 *
 * Dynamically imports the optional `terra-draw` and
 * `terra-draw-maplibre-gl-adapter` peers (throwing a descriptive error when
 * either is missing), registers the canonical drawing modes (point,
 * linestring, polygon, rectangle, circle, freehand, select), wires SDK
 * snapping into the modes that accept a custom snapping hook, starts the
 * instance, and returns it bound to the workflow model via
 * {@link bindTerraDrawSketch}.
 *
 * Apps that need custom mode options should construct terra-draw themselves
 * and call {@link bindTerraDrawSketch} directly.
 *
 * @experimental
 */
export async function createTerraDrawSketch<T = Record<string, unknown>>(
  map: unknown,
  options: CreateTerraDrawSketchOptions<T>,
): Promise<TerraDrawSketchController<T>> {
  const { terraDraw, adapter } = await loadTerraDrawModules();
  const snapping = options.snapping ? { toCustom: createTerraDrawSnapping(options.snapping) } : undefined;
  const drawModes = ["point", "linestring", "polygon", "rectangle", "circle", "freehand"];
  const modes: unknown[] = [
    new terraDraw.TerraDrawPointMode(),
    new terraDraw.TerraDrawLineStringMode(snapping ? { snapping } : {}),
    new terraDraw.TerraDrawPolygonMode(snapping ? { snapping } : {}),
    new terraDraw.TerraDrawRectangleMode(),
    new terraDraw.TerraDrawCircleMode(),
    new terraDraw.TerraDrawFreehandMode(),
    new terraDraw.TerraDrawSelectMode({ flags: defaultSelectFlags(drawModes) }),
  ];
  const draw = new terraDraw.TerraDraw({
    adapter: new adapter.TerraDrawMapLibreGLAdapter({ map }),
    modes,
  });
  draw.start();
  const handle = bindTerraDrawSketch(draw, options);
  return {
    draw,
    model: options.model,
    get activeFeatureId() {
      return handle.activeFeatureId;
    },
    get selectedFeatureId() {
      return handle.selectedFeatureId;
    },
    setTool: (tool) => handle.setTool(tool),
    select: () => handle.select(),
    cancel: () => handle.cancel(),
    undo: () => handle.undo(),
    redo: () => handle.redo(),
    syncFromModel: () => handle.syncFromModel(),
    remove: () => handle.remove(),
    stop() {
      handle.remove();
      draw.stop();
    },
  };
}

// ── Internal helpers ──────────────────────────────────────────

function modeOf(feature: TerraDrawSketchFeature | undefined, context: TerraDrawSketchFinishContext): string {
  const mode = feature?.properties?.mode;
  return typeof mode === "string" ? mode : context.mode;
}

function cloneJsonLike(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneJsonLike);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = cloneJsonLike(entry);
  return out;
}
