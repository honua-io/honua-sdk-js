/**
 * The shipped 2D {@link SceneStateSyncPort}: a live MapLibre GL map bound to the
 * shared scene state.
 *
 * The synchronizer in `state-sync.ts` is a transport and deliberately never
 * touches a renderer. This module is the other half for the 2D side — it reads
 * and writes a real map for camera, selection, filters, time, and detail, and it
 * reports what a Web Mercator plane cannot hold instead of quietly dropping it.
 *
 * The map is duck-typed: nothing here imports the renderer package, so a 3D-only
 * or headless consumer pays no 2D cost, and a test can drive the port with a
 * plain object.
 *
 * @beta Part of the beta `@honua/app-platform/scene-workspace` surface.
 * @module
 */

import type { FeatureSelectionTarget, FilterClause } from "../exploration/index.js";
import {
  DEFAULT_MAPLIBRE_CAMERA_GEOMETRY,
  type MapLibreCameraGeometry,
  type MapLibreCameraLimits,
  mapLibreViewToSceneCamera,
  sceneCameraToMapLibreView,
} from "./camera-correspondence.js";
import { compileMapLibreFilterSet } from "./primitives.js";
import {
  type SceneStateSyncPortDegradation,
  type SceneStateSyncRendererPort,
  createPortCore,
} from "./state-sync-port-kit.js";
import {
  HonuaSceneStateSyncError,
  type SceneStateSyncDelivery,
  type SceneStateSyncIdentity,
  type SceneStateSyncMapping,
  type SceneStateSyncMappings,
  type SceneStateSyncSlice,
} from "./state-sync.js";
import type { SceneCameraState, SceneDetailState, SceneTimelineState } from "./types.js";

/** A feature-state address, the same shape the 2D renderer takes. */
interface FeatureStateAddress {
  readonly source: string;
  readonly id: string | number;
  readonly sourceLayer?: string;
}

/**
 * The slice of a live 2D map this port drives.
 *
 * Only `getCenter`/`getZoom`/`getBearing`/`getPitch`/`jumpTo`/`on`/`off` are
 * required — everything else is feature-detected, and a missing capability
 * narrows the port's declared fidelity rather than throwing at apply time.
 */
export interface MapLibreStateSyncTarget {
  getCenter(): { readonly lng: number; readonly lat: number } | readonly [number, number];
  getZoom(): number;
  getBearing(): number;
  getPitch(): number;
  getRoll?(): number;
  // `center` is a mutable tuple on purpose: the renderer's own camera options
  // type accepts `[number, number]`, and a `readonly` tuple here would make a
  // live map fail to satisfy this target in a consumer's build.
  jumpTo(options: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number; roll?: number }): void;
  // Narrowed to the camera events this port binds. The renderer's own `on`
  // is keyed by its event vocabulary, so a plain `string` here would stop a
  // live map from satisfying this target.
  on(type: "moveend" | "rotateend" | "pitchend", listener: () => void): unknown;
  off(type: "moveend" | "rotateend" | "pitchend", listener: () => void): unknown;
  getMinZoom?(): number;
  getMaxZoom?(): number;
  getMaxPitch?(): number;
  getCanvas?(): { readonly clientHeight?: number } | null | undefined;
  getContainer?(): { readonly clientHeight?: number } | null | undefined;
  getStyle?():
    | { readonly layers?: readonly { readonly id?: unknown; readonly type?: unknown; readonly source?: unknown }[] }
    | null
    | undefined;
  getFilter?(id: string): unknown;
  setFilter?(id: string, filter: unknown): void;
  getSource?(id: string): unknown;
  setFeatureState?(target: FeatureStateAddress, state: Record<string, unknown>): void;
  removeFeatureState?(target: FeatureStateAddress, key?: string): void;
}

export interface CreateMapLibreStateSyncPortOptions {
  /** Port identifier; must satisfy the envelope's credential-free id charset. */
  readonly id?: string;
  /** Shared-plan identity stamped onto everything this port publishes. */
  readonly identity: SceneStateSyncIdentity;
  readonly now?: () => string;
  /**
   * Override the viewport/lens geometry the zoom-to-height correspondence uses.
   * By default the viewport height is read from the live map on every
   * conversion, so a resized map stays correct.
   */
  readonly geometry?: Partial<MapLibreCameraGeometry>;
  /** Feature-state key written for selected features. Defaults to `selected`. */
  readonly selectionStateKey?: string;
  /** Feature-state key written for the detail target. Defaults to `detail`. */
  readonly detailStateKey?: string;
  /**
   * Layers the port may filter. Defaults to every filterable layer in the
   * current style. Style-authored filters are preserved: the port captures each
   * layer's original filter once and composes shared clauses on top of it.
   */
  readonly filterLayers?: readonly string[];
  /**
   * Numeric epoch-millisecond field the `time` slice is applied against. Without
   * it the port declares `time` outbound-unsupported rather than pretending.
   */
  readonly timeField?: string;
  readonly onDegraded?: (degradation: SceneStateSyncPortDegradation) => void;
}

const FILTERABLE_LAYER_TYPES = new Set(["fill", "line", "circle", "symbol", "fill-extrusion", "heatmap"]);
const DEFAULT_PORT_ID = "maplibre-state-sync";

/**
 * Bind a live 2D map to the shared scene state.
 *
 * Camera changes are published automatically from the map's own `moveend` /
 * `rotateend` / `pitchend` events. Selection, filters, time, detail, and
 * attribution have no renderer event to hang off — those are host decisions —
 * so the host publishes them with {@link SceneStateSyncRendererPort.publish}.
 */
export function createMapLibreStateSyncPort(
  map: MapLibreStateSyncTarget,
  options: CreateMapLibreStateSyncPortOptions,
): SceneStateSyncRendererPort {
  if (map === null || typeof map !== "object")
    throw new HonuaSceneStateSyncError("invalid-input", "map must be a live 2D map instance");
  for (const method of ["getCenter", "getZoom", "getBearing", "getPitch", "jumpTo", "on", "off"] as const) {
    if (typeof map[method] !== "function")
      throw new HonuaSceneStateSyncError("invalid-input", `map.${method} must be a function`);
  }
  if (options === null || typeof options !== "object" || options.identity === undefined)
    throw new HonuaSceneStateSyncError("invalid-input", "options.identity is required");

  const id = options.id ?? DEFAULT_PORT_ID;
  const selectionStateKey = options.selectionStateKey ?? "selected";
  const detailStateKey = options.detailStateKey ?? "detail";
  const featureStateCapable = typeof map.setFeatureState === "function" && typeof map.removeFeatureState === "function";
  const filterCapable = typeof map.setFilter === "function";
  const rollSupported = typeof map.getRoll === "function";
  const timeField =
    typeof options.timeField === "string" && options.timeField.length > 0 ? options.timeField : undefined;

  const baselineFilters = new Map<string, unknown>();
  const appliedSelection: FeatureStateAddress[] = [];
  let appliedDetail: FeatureStateAddress | undefined;
  let currentFilters: Readonly<Record<string, FilterClause>> = Object.freeze({});
  let currentTime: SceneTimelineState = Object.freeze({});
  let applying = false;
  let cameraEventDuringApply = false;

  const core = createPortCore({
    id,
    renderer: "maplibre",
    identity: options.identity,
    ...(options.now ? { now: options.now } : {}),
    ...(options.onDegraded ? { onDegraded: options.onDegraded } : {}),
    bind: () => {
      const handler = (): void => {
        if (applying) {
          cameraEventDuringApply = true;
          return;
        }
        core.publish("camera", readCamera());
      };
      const events = ["moveend", "rotateend", "pitchend"] as const;
      for (const event of events) map.on(event, handler);
      return () => {
        for (const event of events) map.off(event, handler);
      };
    },
  });

  function geometry(): MapLibreCameraGeometry {
    const viewportHeightPixels =
      positive(options.geometry?.viewportHeightPixels) ??
      positive(map.getCanvas?.()?.clientHeight) ??
      positive(map.getContainer?.()?.clientHeight) ??
      DEFAULT_MAPLIBRE_CAMERA_GEOMETRY.viewportHeightPixels;
    return {
      viewportHeightPixels,
      fovRadians: positive(options.geometry?.fovRadians) ?? DEFAULT_MAPLIBRE_CAMERA_GEOMETRY.fovRadians,
      tileSizePixels: positive(options.geometry?.tileSizePixels) ?? DEFAULT_MAPLIBRE_CAMERA_GEOMETRY.tileSizePixels,
    };
  }

  function limits(): MapLibreCameraLimits {
    return {
      minZoom: numberOr(map.getMinZoom?.(), 0),
      maxZoom: numberOr(map.getMaxZoom?.(), 22),
      maxPitch: numberOr(map.getMaxPitch?.(), 60),
      rollSupported,
    };
  }

  function readCamera(): SceneCameraState {
    const center = map.getCenter();
    const [longitude, latitude] = Array.isArray(center)
      ? [center[0] as number, center[1] as number]
      : [(center as { lng: number }).lng, (center as { lat: number }).lat];
    return mapLibreViewToSceneCamera(
      {
        center: [longitude, latitude],
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
        roll: rollSupported ? numberOr(map.getRoll?.(), 0) : 0,
      },
      geometry(),
    );
  }

  function applyCamera(camera: SceneCameraState | undefined, revision: number): void {
    if (camera === undefined) return;
    const projection = sceneCameraToMapLibreView(camera, { geometry: geometry(), limits: limits() });
    for (const degradation of projection.degradations) {
      core.degrade("camera", degradation.code, degradation.message, {
        revision,
        requested: degradation.requested,
        applied: degradation.applied,
      });
    }
    cameraEventDuringApply = false;
    applying = true;
    try {
      map.jumpTo({
        center: [projection.view.center[0], projection.view.center[1]],
        zoom: projection.view.zoom,
        bearing: projection.view.bearing,
        pitch: projection.view.pitch,
        ...(rollSupported ? { roll: projection.view.roll } : {}),
      });
    } finally {
      applying = false;
    }
    // The 2D map applies `jumpTo` synchronously and fires its move events inside
    // that call, so the read-back below is the settled state. Both the read-back
    // and the delivered pose are registered as echoes: when the plane clamped
    // something, the clamped read-back must acknowledge rather than publish, or
    // the 3D view would be dragged down to the 2D limits.
    core.markApplied("camera", revision, readCamera(), camera);
    if (cameraEventDuringApply) {
      cameraEventDuringApply = false;
      core.publish("camera", readCamera());
    }
  }

  function resolveFilterLayers(): { readonly id: string; readonly source: string }[] {
    const styleLayers = map.getStyle?.()?.layers ?? [];
    const resolved: { id: string; source: string }[] = [];
    for (const layer of styleLayers) {
      const layerId = typeof layer.id === "string" ? layer.id : undefined;
      const source = typeof layer.source === "string" ? layer.source : undefined;
      const type = typeof layer.type === "string" ? layer.type : undefined;
      if (!layerId || !source || !type || !FILTERABLE_LAYER_TYPES.has(type)) continue;
      if (options.filterLayers && !options.filterLayers.includes(layerId)) continue;
      resolved.push({ id: layerId, source });
    }
    return resolved;
  }

  function timeClauses(): unknown[] {
    if (!timeField) return [];
    const clauses: unknown[] = [];
    const start = epochMs(currentTime.startTime);
    const current = epochMs(currentTime.currentTime);
    if (start !== undefined) clauses.push([">=", timeField, start]);
    if (current !== undefined) clauses.push(["<=", timeField, current]);
    return clauses;
  }

  function applyFilterComposition(slice: SceneStateSyncSlice, revision: number): void {
    if (!filterCapable) return;
    const layers = resolveFilterLayers();
    if (layers.length === 0) {
      core.degrade(
        slice,
        "filters-no-target-layers",
        "The current style has no filterable layer, so shared clauses had nowhere to land.",
        { revision },
      );
      return;
    }
    const time = timeClauses();
    // An omission is a property of the filter state, so it is reported when the
    // `filters` slice is applied and not again on every `time` delivery that
    // recomposes the same clauses. Re-reporting would attribute a filter
    // shortfall to time revisions and, during playback, evict unrelated
    // diagnostics from the bounded degradation history.
    const reportOmissions = slice === "filters";
    // Keyed by source, then clause key. Both are `SAFE_ID`s, which permit `:`,
    // so concatenating them into one string is genuinely ambiguous -- clause
    // `a:b` on source `c` and clause `a` on source `b:c` would collide and the
    // second omission would be silently skipped.
    const reported = new Map<string, Set<string>>();
    for (const layer of layers) {
      if (!baselineFilters.has(layer.id)) baselineFilters.set(layer.id, map.getFilter?.(layer.id));
      const baseline = baselineFilters.get(layer.id);
      const compilation = compileMapLibreFilterSet(currentFilters, layer.source);
      // A clause addressed at this source that compiles to nothing is dropped
      // by the 2D filter language -- `like` has no expression at all, and the
      // comparison, membership and range operators have none for a value of the
      // wrong shape. Reporting it is what keeps the slice from claiming a
      // filter landed that the renderer silently discarded (#1304). Reported
      // once per clause and source rather than once per layer, since the
      // shortfall is a property of the clause and the source, not of the layer.
      if (reportOmissions) {
        let reportedForSource = reported.get(layer.source);
        if (!reportedForSource) {
          reportedForSource = new Set<string>();
          reported.set(layer.source, reportedForSource);
        }
        for (const omission of compilation.omitted) {
          if (reportedForSource.has(omission.key)) continue;
          reportedForSource.add(omission.key);
          core.degrade(
            slice,
            "filters-clause-not-expressible",
            `Clause ${omission.key} (${omission.operator} on ${omission.field}) has no 2D layer-filter expression for source ${layer.source}, so it was not applied.`,
            { revision },
          );
        }
      }
      const compiled = compilation.filter.slice(1);
      const parts = [...(baseline === undefined ? [] : [baseline]), ...compiled, ...time];
      try {
        map.setFilter?.(layer.id, parts.length === 0 ? undefined : ["all", ...parts]);
      } catch (cause) {
        core.degrade(
          slice,
          "filters-layer-rejected",
          `Layer ${layer.id} rejected the composed filter: ${describe(cause)}`,
          { revision },
        );
      }
    }
  }

  function addressFor(target: FeatureSelectionTarget): FeatureStateAddress | undefined {
    if (typeof target === "string" || typeof target === "number")
      return { source: options.identity.sourceId, id: target };
    if (target === null || typeof target !== "object") return undefined;
    const record = target as { sourceId?: unknown; id?: unknown; sourceLayer?: unknown };
    if (typeof record.sourceId !== "string") return undefined;
    if (typeof record.id !== "string" && typeof record.id !== "number") return undefined;
    return {
      source: record.sourceId,
      id: record.id,
      ...(typeof record.sourceLayer === "string" ? { sourceLayer: record.sourceLayer } : {}),
    };
  }

  function applySelection(targets: readonly FeatureSelectionTarget[], revision: number): void {
    if (!featureStateCapable) return;
    for (const address of appliedSelection.splice(0)) {
      try {
        map.removeFeatureState?.(address, selectionStateKey);
      } catch {
        // A source removed since the last application cannot retain state.
      }
    }
    for (const target of targets) {
      const address = addressFor(target);
      if (!address) {
        core.degrade(
          "selection",
          "selection-target-unresolved",
          "Selection target carries no source-qualified identity.",
          {
            revision,
          },
        );
        continue;
      }
      if (typeof map.getSource === "function" && map.getSource(address.source) === undefined) {
        core.degrade(
          "selection",
          "selection-source-missing",
          `Source ${address.source} is not in the current style, so its selection cannot be drawn.`,
          { revision },
        );
        continue;
      }
      map.setFeatureState?.(address, { [selectionStateKey]: true });
      appliedSelection.push(address);
    }
  }

  function applyDetail(detail: SceneDetailState, revision: number): void {
    if (!featureStateCapable) return;
    if (appliedDetail) {
      try {
        map.removeFeatureState?.(appliedDetail, detailStateKey);
      } catch {
        // Same as selection: a departed source holds no state.
      }
      appliedDetail = undefined;
    }
    const target =
      detail.target ??
      (detail.sourceId !== undefined && detail.featureId !== undefined
        ? { sourceId: detail.sourceId, id: detail.featureId }
        : undefined);
    if (target === undefined) return;
    const address = addressFor(target as FeatureSelectionTarget);
    if (!address) {
      core.degrade("detail", "detail-target-unresolved", "Detail target carries no source-qualified identity.", {
        revision,
      });
      return;
    }
    map.setFeatureState?.(address, { [detailStateKey]: true });
    appliedDetail = address;
  }

  function apply(delivery: SceneStateSyncDelivery): void {
    const { slice, value, revision } = delivery.envelope;
    switch (slice) {
      case "camera":
        applyCamera(value as SceneCameraState | undefined, revision);
        return;
      case "filters":
        currentFilters = value as Readonly<Record<string, FilterClause>>;
        applyFilterComposition("filters", revision);
        core.markApplied("filters", revision, currentFilters);
        return;
      case "time":
        currentTime = value as SceneTimelineState;
        if (!timeField) {
          core.degrade(
            "time",
            "time-field-unconfigured",
            "No temporal field is configured, so shared time cannot reach a 2D layer filter.",
            { revision },
          );
          return;
        }
        applyFilterComposition("time", revision);
        core.markApplied("time", revision, currentTime);
        return;
      case "selection":
        applySelection(value as readonly FeatureSelectionTarget[], revision);
        core.markApplied("selection", revision, value);
        return;
      case "detail":
        applyDetail(value as SceneDetailState, revision);
        core.markApplied("detail", revision, value);
        return;
      default:
        // `attribution` and `realtime` are credential-free host read models; the
        // port records them for echo suppression and declares them `equivalent`
        // rather than rewriting the renderer's own credit control.
        core.markApplied(slice, revision, value);
    }
  }

  const port: SceneStateSyncRendererPort = {
    id,
    renderer: "maplibre",
    mappings: buildMappings({ featureStateCapable, filterCapable, rollSupported, timeField }),
    subscribe(listener, signal) {
      return core.subscribe(listener, signal);
    },
    apply(delivery) {
      apply(delivery);
    },
    publish(slice, value) {
      return core.publish(slice, value);
    },
    readFromRenderer(slice) {
      if (slice !== "camera") return "unsupported";
      return core.publish("camera", readCamera());
    },
    get degradations() {
      return core.degradations;
    },
    get disposed() {
      return core.disposed;
    },
    dispose() {
      if (core.disposed) return;
      for (const address of appliedSelection.splice(0)) {
        try {
          map.removeFeatureState?.(address, selectionStateKey);
        } catch {
          // Teardown never throws on a renderer that is already gone.
        }
      }
      if (appliedDetail) {
        try {
          map.removeFeatureState?.(appliedDetail, detailStateKey);
        } catch {
          // As above.
        }
        appliedDetail = undefined;
      }
      for (const [layerId, baseline] of baselineFilters) {
        try {
          map.setFilter?.(layerId, baseline);
        } catch {
          // A layer removed since the first application needs no restore.
        }
      }
      baselineFilters.clear();
      core.dispose();
    },
  };
  return port;
}

function buildMappings(capabilities: {
  readonly featureStateCapable: boolean;
  readonly filterCapable: boolean;
  readonly rollSupported: boolean;
  readonly timeField: string | undefined;
}): SceneStateSyncMappings {
  const mapping = (
    inbound: SceneStateSyncMapping["inbound"],
    outbound: SceneStateSyncMapping["outbound"],
    code: string,
    message: string,
  ): SceneStateSyncMapping => Object.freeze({ inbound, outbound, code, message });
  return Object.freeze({
    camera: mapping(
      "exact",
      "equivalent",
      "maplibre-2d-camera",
      `Zoom maps to camera height through the documented ground-resolution correspondence.${
        capabilities.rollSupported ? "" : " Camera roll is dropped."
      } Latitudes beyond the Web Mercator limit, pitches beyond the map maximum, and heights outside the zoom range are clamped and reported.`,
    ),
    selection: capabilities.featureStateCapable
      ? mapping(
          "exact",
          "exact",
          "maplibre-feature-state-selection",
          "Source-qualified selection is written as feature state on the addressed source.",
        )
      : mapping(
          "exact",
          "unsupported",
          "maplibre-feature-state-unavailable",
          "This map exposes no feature-state API, so shared selection cannot be drawn.",
        ),
    filters: capabilities.filterCapable
      ? mapping(
          "exact",
          "equivalent",
          "maplibre-layer-filter",
          "Protocol-neutral clauses compile to layer filters composed on top of the style's own filter. The 2D filter language has no expression for `like`, and none for a comparison, membership or range clause whose value has the wrong shape; such a clause is not applied and is reported as a degradation.",
        )
      : mapping(
          "exact",
          "unsupported",
          "maplibre-layer-filter-unavailable",
          "This map exposes no setFilter API, so shared filters cannot be applied.",
        ),
    time:
      capabilities.timeField && capabilities.filterCapable
        ? mapping(
            "exact",
            "equivalent",
            "maplibre-time-window-filter",
            `Shared time is applied as an epoch-millisecond window on ${capabilities.timeField}; the 2D renderer has no clock of its own.`,
          )
        : mapping(
            "exact",
            "unsupported",
            "maplibre-time-field-unconfigured",
            "No temporal field is configured for this map, so shared time has nothing to filter.",
          ),
    detail: capabilities.featureStateCapable
      ? mapping(
          "exact",
          "exact",
          "maplibre-feature-state-detail",
          "The detail target is written as feature state so the drawn feature reflects the open detail view.",
        )
      : mapping(
          "exact",
          "unsupported",
          "maplibre-feature-state-unavailable",
          "This map exposes no feature-state API, so the detail target cannot be drawn.",
        ),
    attribution: mapping(
      "exact",
      "equivalent",
      "maplibre-attribution-ids",
      "Credential-free attribution identifiers are shared for the host to render; the map's own attribution control is not rewritten.",
    ),
    realtime: mapping(
      "exact",
      "equivalent",
      "maplibre-realtime-status",
      "Realtime status is shared for the host to render; a 2D map has no realtime surface of its own.",
    ),
  }) as SceneStateSyncMappings;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function epochMs(value: string | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function describe(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return [...text]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .slice(0, 160);
}
