/**
 * Standalone data-to-map bridge: mount any contract `Source` as a live,
 * styled MapLibre layer set — no MapPackage, no Honua server, no
 * app-platform import. This is the `connection.mount(target)` slice of the
 * kernel ADR (`docs/decisions/north-star-sdk-application-kernel.md`) scoped
 * to a caller-owned MapLibre host.
 *
 * The module is peer-injected and safe to import in Node/SSR/worker code:
 * it never imports `maplibre-gl`. The host passes a duck-typed map (any
 * MapLibre GL `Map` instance satisfies {@link DataToMapLibreMap}).
 *
 * @module
 */

import type { QueryTileSourceDescriptor } from "../contract/tiles.js";
import type { Query, Result, Source } from "../contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import type { FeatureStateMap, HoverHandle, MapEventTarget } from "../interactions/feature-state.js";
import { createHoverHandler } from "../interactions/feature-state.js";
import type { PopupBindingHandle, PopupFactory, PopupFeature } from "../runtime/popups.js";
import { bindPopup } from "../runtime/popups.js";
import { buildMapLibreQueryTileSourceSpec, diagnoseQueryTileSourceSupport } from "../runtime/query-tiles.js";
import type { Renderer } from "../style/renderers.js";
import type { AdapterGeoJsonFeatureCollection } from "./feature-service-adapter.js";
import {
  type MapLibreGeometryKind,
  canonicalFeaturesToGeoJson,
  defaultPaint,
  defaultPolygonOutlinePaint,
  geometryKinds,
  layerType,
  mapLibreGeometryType,
  removeUndefined,
  safeId,
} from "./geojson-projection.js";
import type { SourceToMapLibreMap } from "./source-to-maplibre.js";

/**
 * Materialization strategy chosen by the bridge.
 *
 * - `"geojson"` — drain the source through `queryAll` into one bounded
 *   GeoJSON source; filter changes diff-update through `setData`.
 * - `"query-tiles"` — reuse the existing dynamic query-tile path: the map
 *   pulls viewport-bounded vector tiles and the source's own tile cache
 *   applies; filter changes rewrite the tile URL template where possible.
 *
 * @experimental
 */
export type DataToMapStrategy = "geojson" | "query-tiles";

/** Machine-readable reason and event codes recorded on {@link MountedSourceDiagnostics}. @experimental */
export type DataToMapDiagnosticCode =
  | "strategy-override"
  | "query-capability"
  | "tiles-capability"
  | "tile-endpoint-missing"
  | "count-probe-unavailable"
  | "count-probe-failed"
  | "result-size-within-limit"
  | "result-size-exceeds-limit"
  | "result-size-unknown"
  | "overflow-truncated"
  | "geometry-unsupported"
  | "source-degraded"
  | "tile-support"
  | "filter-applied"
  | "filter-recreated-source"
  | "refresh-applied"
  | "renderer-applied"
  | "renderer-recreated-layers"
  | "renderer-recreated-source";

/** One strategy reason or lifecycle event. @experimental */
export interface DataToMapDiagnostic {
  readonly code: DataToMapDiagnosticCode;
  readonly severity: "info" | "warning";
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** Pagination-truncation report for the bounded GeoJSON path. @experimental */
export interface DataToMapOverflow {
  /** True when more matching rows exist than were materialized. */
  readonly truncated: boolean;
  /** Rows actually rendered on the map. */
  readonly renderedFeatureCount: number;
  /** The bound that produced the truncation ({@link MountSourceOptions.maxGeoJsonFeatures}). */
  readonly limit: number;
  /** Matching row count when the source reported one. */
  readonly totalCount?: number;
}

/**
 * Explain/diagnostics surface returned on the handle: the chosen strategy,
 * why it was chosen, and the current materialization state.
 *
 * @experimental
 */
export interface MountedSourceDiagnostics {
  readonly strategy: DataToMapStrategy;
  /** Why the strategy was selected (capabilities, probes, overrides). */
  readonly reasons: readonly DataToMapDiagnostic[];
  /** Lifecycle events appended by `setFilter` / `refresh`. */
  readonly updates: readonly DataToMapDiagnostic[];
  /** Rendered feature count (GeoJSON strategy only). */
  readonly featureCount?: number;
  /** Matching row count when known (GeoJSON strategy only). */
  readonly totalCount?: number;
  /** Set when pagination limits truncated the materialized data. */
  readonly overflow?: DataToMapOverflow;
  /** Geometry kinds present in the materialized data (GeoJSON strategy only). */
  readonly geometryKinds?: readonly MapLibreGeometryKind[];
}

/** Strategy selection result from {@link explainDataToMapStrategy}. @experimental */
export interface DataToMapStrategyExplanation {
  readonly strategy: DataToMapStrategy;
  readonly reasons: readonly DataToMapDiagnostic[];
  /** Matching row count observed by the size probe, when one ran. */
  readonly probedCount?: number;
}

/** Error codes raised by the bridge. @experimental */
export type DataToMapBridgeErrorCode =
  | "invalid-option"
  | "disposed"
  | "source-conflict"
  | "layer-conflict"
  | "map-mutation-failed"
  | "interaction-unsupported"
  | "filter-unsupported";

/** A stable, machine-readable bridge failure. @experimental */
export class HonuaDataToMapBridgeError extends Error {
  public constructor(
    public readonly code: DataToMapBridgeErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HonuaDataToMapBridgeError";
  }
}

/**
 * Minimal injected MapLibre map surface. Source/layer mutation is required;
 * event and feature-state methods are needed only when `popup` / `hover`
 * options are requested, and `fitBounds` only when `fitBounds` is requested.
 * A real `maplibre-gl` `Map` satisfies the whole interface.
 *
 * @experimental
 */
export interface DataToMapLibreMap extends SourceToMapLibreMap {
  on?(
    event: string,
    layerOrHandler: string | ((...args: unknown[]) => void),
    handler?: (...args: unknown[]) => void,
  ): void;
  off?(
    event: string,
    layerOrHandler: string | ((...args: unknown[]) => void),
    handler?: (...args: unknown[]) => void,
  ): void;
  setFeatureState?(
    target: { source: string; id: string | number; sourceLayer?: string },
    state: Record<string, unknown>,
  ): void;
  setPaintProperty?(layerId: string, name: string, value: unknown): void;
  setLayoutProperty?(layerId: string, name: string, value: unknown): void;
  setFilter?(layerId: string, filter: unknown): void;
  getFeatureState?(target: { source: string; id: string | number; sourceLayer?: string }): Record<string, unknown>;
  removeFeatureState?(target: { source: string; id: string | number; sourceLayer?: string }, key?: string): void;
  fitBounds?(bounds: [number, number, number, number], options?: Record<string, unknown>): void;
}

/** Click-popup configuration. @experimental */
export interface MountSourcePopupOptions {
  /** Creates one popup handle per click — usually `() => new maplibregl.Popup()`. */
  readonly factory: PopupFactory;
  /** Restrict the default renderer to these properties, in order. */
  readonly fields?: readonly string[];
  /** Custom formatter; return `undefined` to suppress the popup for a click. */
  readonly render?: (context: MountSourcePopupContext) => Node | string | undefined;
  /** Title rendered by the default formatter. */
  readonly title?: string;
}

/** Click context passed to a custom popup formatter. @experimental */
export interface MountSourcePopupContext {
  readonly features: readonly PopupFeature[];
  readonly lngLat: readonly [number, number];
}

/** Options for {@link mountSource}. @experimental */
export interface MountSourceOptions<T = Record<string, unknown>> {
  /**
   * Force a strategy instead of capability + result-size selection.
   * `"query-tiles"` requires {@link MountSourceOptions.queryTiles}.
   */
  readonly strategy?: DataToMapStrategy;
  /** Initial filter applied to the mounted data. Replaced by `setFilter`. */
  readonly query?: Readonly<Omit<Query<T>, "signal">>;
  /**
   * Bound (and result-size heuristic threshold) for GeoJSON materialization.
   * Truncation is reported through {@link MountedSourceDiagnostics.overflow}.
   * @default 10000
   */
  readonly maxGeoJsonFeatures?: number;
  /**
   * Dynamic query-tile source descriptor enabling the `"query-tiles"`
   * strategy (see `@honua/sdk-js/runtime` query-tile helpers). Without it the
   * bridge can only materialize GeoJSON, even when the source declares the
   * `tiles` capability.
   */
  readonly queryTiles?: QueryTileSourceDescriptor<T>;
  /** Vector `source-layer` for the tile strategy. Defaults to the tile descriptor's `sourceId`. */
  readonly sourceLayer?: string;
  /** MapLibre source id. @default `honua-<descriptor id>` */
  readonly sourceId?: string;
  /** Base layer id; geometry suffixes (`-point`, `-line`, …) are appended. Defaults to the source id. */
  readonly layerId?: string;
  /** Existing layer id to insert the bridge layers before. */
  readonly beforeId?: string;
  /**
   * Restrict default styling to one geometry kind, or `"auto"` (default) to
   * install the stable point/line/polygon(+outline) matrix so filter changes
   * can move between geometry kinds without structural layer churn.
   */
  readonly geometry?: MapLibreGeometryKind | "auto";
  /**
   * Full layer override: the bridge adds these layers verbatim (injecting
   * `source`, and `source-layer` for the tile strategy, when absent) instead
   * of the geometry-appropriate defaults. Each entry must carry a unique `id`.
   */
  readonly layers?: readonly Readonly<Record<string, unknown>>[];
  /**
   * First-class renderer object from `@honua/sdk-js/style`
   * (`classBreaksRenderer`, `uniqueValueRenderer`, `heatmapRenderer`,
   * `clusterRenderer`). Layers and paint derive from the renderer instead of
   * the geometry defaults; `paint`/`layout` overrides still win per property.
   * A cluster renderer additionally configures GeoJSON-source clustering and
   * requires the `"geojson"` strategy. Mutually exclusive with `layers`.
   * Swap at runtime with {@link MountedSource.setRenderer}.
   */
  readonly renderer?: Renderer;
  /** Per-geometry paint overrides merged over the defaults. */
  readonly paint?: Partial<
    Readonly<Record<MapLibreGeometryKind | "polygonOutline", Readonly<Record<string, unknown>>>>
  >;
  /** Per-geometry layout overrides. */
  readonly layout?: Partial<
    Readonly<Record<MapLibreGeometryKind | "polygonOutline", Readonly<Record<string, unknown>>>>
  >;
  /** Attribution override; defaults to the source descriptor's attribution. */
  readonly attribution?: string;
  /** Fit the map to the mounted data (GeoJSON bbox or tile descriptor bounds). */
  readonly fitBounds?: boolean | { readonly padding?: number };
  /** Open a popup on layer click. Requires `map.on`/`map.off`. */
  readonly popup?: MountSourcePopupOptions;
  /**
   * Toggle a boolean feature-state key (default `"hover"`) while the pointer
   * is over a feature. Requires event and feature-state map methods, and
   * feature ids (`schema.primaryKey` or GeoJSON feature ids).
   */
  readonly hover?: boolean | { readonly stateKey?: string };
  /** Cancels mounting and any in-flight refresh work. */
  readonly signal?: AbortSignal;
}

/**
 * Live handle returned by {@link mountSource}. Owns every MapLibre resource
 * the bridge created (source, layers, event listeners); `dispose()` is
 * idempotent and removes all of them.
 *
 * @experimental
 */
export interface MountedSource<T = Record<string, unknown>> extends AsyncDisposable {
  readonly strategy: DataToMapStrategy;
  readonly sourceId: string;
  readonly layerIds: readonly string[];
  /**
   * Resolved vector `source-layer` used by the mounted layers — the explicit
   * option, or the default derived from the query-tile descriptor. Always
   * `undefined` for the GeoJSON strategy. Feature-state operations against a
   * vector tile source must target this same value.
   */
  readonly sourceLayer?: string;
  readonly state: "ready" | "disposed";
  readonly diagnostics: MountedSourceDiagnostics;
  /**
   * Replace the mounted filter and diff-update in place: `setData` for the
   * GeoJSON strategy, tile URL rewrite (`setTiles`) for the tile strategy.
   * Passing `undefined` clears the filter.
   */
  setFilter(query: Readonly<Omit<Query<T>, "signal">> | undefined): Promise<MountedSourceDiagnostics>;
  /**
   * Swap the mounted renderer and diff-update in place where MapLibre
   * allows: when the layer structure is unchanged, paint/layout/filter are
   * updated per property (`setPaintProperty`/`setLayoutProperty`/
   * `setFilter`) without layer teardown; a structural change (e.g. to or
   * from a cluster/heatmap renderer) recreates only the owned layers, and
   * changed GeoJSON cluster options recreate the source. Passing
   * `undefined` restores the geometry-default styling.
   */
  setRenderer(renderer: Renderer | undefined): Promise<MountedSourceDiagnostics>;
  /** Re-execute the current filter and diff-update the mounted data. */
  refresh(): Promise<MountedSourceDiagnostics>;
  /** Remove every owned source, layer, and listener. Safe to call twice. */
  dispose(): void;
}

const DEFAULT_MAX_GEOJSON_FEATURES = 10_000;
const GEOMETRY_SUFFIXES = ["point", "line", "polygon", "polygon-outline"] as const;

/**
 * Explain which materialization strategy {@link mountSource} would pick for
 * a source, without touching a map. Runs the same capability checks and (when
 * both strategies are viable) the same result-size probe.
 *
 * @experimental
 */
export async function explainDataToMapStrategy<T>(
  source: Source<T>,
  options: MountSourceOptions<T> = {},
): Promise<DataToMapStrategyExplanation> {
  const limit = normalizedLimit(options.maxGeoJsonFeatures);
  const reasons: DataToMapDiagnostic[] = [];
  const canQuery = source.capabilities.has("query");
  const tileDescriptor = options.queryTiles;

  if (options.strategy === "geojson") {
    if (!canQuery) {
      throw new HonuaCapabilityNotSupportedError("query", source.descriptor.protocol, source.descriptor.id);
    }
    reasons.push(info("strategy-override", "Explicit geojson strategy override."));
    return { strategy: "geojson", reasons };
  }
  if (options.strategy === "query-tiles") {
    if (!tileDescriptor) {
      throw new HonuaDataToMapBridgeError(
        "invalid-option",
        "The query-tiles strategy requires options.queryTiles (a dynamic query-tile source descriptor).",
      );
    }
    reasons.push(info("strategy-override", "Explicit query-tiles strategy override."));
    return { strategy: "query-tiles", reasons };
  }
  if (options.strategy !== undefined) {
    throw new HonuaDataToMapBridgeError("invalid-option", `Unknown strategy "${String(options.strategy)}".`, {
      strategy: options.strategy,
    });
  }

  if (!canQuery && !tileDescriptor) {
    throw new HonuaCapabilityNotSupportedError("query", source.descriptor.protocol, source.descriptor.id);
  }
  if (!tileDescriptor) {
    reasons.push(
      info(
        "query-capability",
        "The source advertises query and no dynamic query-tile descriptor was supplied; using bounded GeoJSON materialization.",
      ),
    );
    if (source.capabilities.has("tiles")) {
      reasons.push(
        info(
          "tile-endpoint-missing",
          "The source declares the tiles capability but no options.queryTiles descriptor was supplied, so the dynamic query-tile strategy is unavailable.",
        ),
      );
    }
    return { strategy: "geojson", reasons };
  }
  if (!canQuery) {
    reasons.push(
      info("tiles-capability", "The source does not advertise query; using the dynamic query-tile strategy."),
    );
    return { strategy: "query-tiles", reasons };
  }

  // Both strategies are viable — apply the result-size heuristic. Probe with
  // the same initial filter the mount path would apply, so a selective
  // descriptor-level query counts what would actually be materialized.
  const initialQuery = options.query ?? options.queryTiles?.query;
  let count: number | undefined;
  if (source.capabilities.has("queryExtent")) {
    try {
      const probe = await source.queryExtent({
        ...(initialQuery ?? {}),
        ...(options.signal ? { signal: options.signal } : {}),
      } as Query<T>);
      count = probe.count;
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      reasons.push(
        warning("count-probe-failed", "The result-size probe (queryExtent) failed; the count is unknown.", {
          error: errorMessage(cause),
        }),
      );
    }
  } else {
    reasons.push(
      info("count-probe-unavailable", "The source does not advertise queryExtent; the result size is unknown."),
    );
  }
  if (count !== undefined && count <= limit) {
    reasons.push(
      info("result-size-within-limit", `${count} matching rows fit within the ${limit}-feature GeoJSON bound.`, {
        count,
        limit,
      }),
    );
    return { strategy: "geojson", reasons, probedCount: count };
  }
  if (count !== undefined) {
    reasons.push(
      info(
        "result-size-exceeds-limit",
        `${count} matching rows exceed the ${limit}-feature GeoJSON bound; using viewport-bounded query tiles.`,
        { count, limit },
      ),
    );
    return { strategy: "query-tiles", reasons, probedCount: count };
  }
  reasons.push(
    info(
      "result-size-unknown",
      "The result size is unknown; preferring viewport-bounded query tiles over unbounded materialization.",
    ),
  );
  return { strategy: "query-tiles", reasons };
}

/**
 * Mount a contract `Source` onto a caller-owned MapLibre map as a styled,
 * interactive layer set and return a disposable handle that owns everything
 * it created.
 *
 * The bridge selects GeoJSON materialization or the dynamic query-tile path
 * from declared capabilities and a result-size heuristic (override with
 * `options.strategy`), applies geometry-appropriate default styling, and can
 * wire click popups and hover feature-state.
 *
 * @example
 * ```ts
 * import maplibregl from "maplibre-gl";
 * import { connect } from "@honua/sdk-js";
 * import { mountSource } from "@honua/sdk-js/map";
 *
 * const connection = await connect({
 *   endpoint: FEATURE_LAYER_URL,
 *   protocol: "auto",
 *   authorizationScopeFingerprint: "public",
 * });
 * const mounted = await mountSource(map, connection.source(), {
 *   popup: { factory: () => new maplibregl.Popup() },
 *   hover: true,
 *   fitBounds: true,
 * });
 * console.log(mounted.diagnostics.strategy, mounted.diagnostics.reasons);
 * // Later: mounted.dispose(); // or `await using mounted = …`
 * ```
 *
 * @experimental
 */
export async function mountSource<T = Record<string, unknown>>(
  map: DataToMapLibreMap,
  source: Source<T>,
  options: MountSourceOptions<T> = {},
): Promise<MountedSource<T>> {
  validateOptions(map, options);
  const limit = normalizedLimit(options.maxGeoJsonFeatures);
  const lifecycle = new AbortController();
  const signal = combineSignals([lifecycle.signal, options.signal]);
  signal.throwIfAborted();

  const explanation = await explainDataToMapStrategy(source, options);
  signal.throwIfAborted();
  const strategy = explanation.strategy;
  const reasons = [...explanation.reasons];
  const updates: DataToMapDiagnostic[] = [];

  if (options.renderer?.kind === "cluster" && strategy !== "geojson") {
    throw new HonuaDataToMapBridgeError(
      "invalid-option",
      'A cluster renderer requires the "geojson" strategy (MapLibre clustering is a GeoJSON-source feature); pass strategy: "geojson".',
      { strategy },
    );
  }

  const sourceId = options.sourceId ?? `honua-${safeId(source.descriptor.id)}`;
  const layerBase = options.layerId ?? sourceId;
  const sourceLayer =
    strategy === "query-tiles"
      ? (options.sourceLayer ?? options.queryTiles?.tilejson?.vector_layers?.[0]?.id ?? options.queryTiles?.sourceId)
      : undefined;

  let currentQuery: Readonly<Omit<Query<T>, "signal">> | undefined = options.query ?? options.queryTiles?.query;

  // ── Materialize the initial source spec ────────────────────────
  let featureCount: number | undefined;
  let totalCount: number | undefined;
  let overflow: DataToMapOverflow | undefined;
  let presentKinds: readonly MapLibreGeometryKind[] | undefined;
  let geojsonBounds: [number, number, number, number] | undefined;
  let sourceSpec: Record<string, unknown>;
  let currentTiles: readonly string[] | undefined;

  const materialize = async (query: Readonly<Omit<Query<T>, "signal">> | undefined) => {
    const callerLimit = query?.pagination?.limit;
    const result = await source.queryAll({
      ...(query ?? {}),
      returnGeometry: true,
      // MapLibre GeoJSON sources are always WGS84; respect an explicit caller override.
      outSr: query?.outSr ?? 4326,
      pagination: { ...(query?.pagination ?? {}), limit: Math.min(callerLimit ?? limit, limit) },
      signal,
    } as Query<T>);
    signal.throwIfAborted();
    return result;
  };

  if (strategy === "geojson") {
    const result = await materialize(currentQuery);
    const converted = canonicalFeaturesToGeoJson(result.features, source.descriptor.schema?.primaryKey);
    featureCount = converted.data.features.length;
    totalCount = resolveTotalCount(result);
    overflow = computeOverflow(result, limit, reasons);
    presentKinds = geometryKinds(converted.data.features);
    geojsonBounds = computeBounds(converted.data);
    if (converted.unsupported > 0) {
      reasons.push(
        warning(
          "geometry-unsupported",
          `${converted.unsupported} feature geometry value(s) could not be projected and remain attribute-only.`,
          { unsupportedGeometryCount: converted.unsupported },
        ),
      );
    }
    if (result.degraded && result.degraded.length > 0) {
      reasons.push(
        warning("source-degraded", "The source reported degraded execution semantics.", {
          reasons: result.degraded.map((entry) => entry.reason),
        }),
      );
    }
    sourceSpec = {
      type: "geojson",
      data: converted.data,
      promoteId: source.descriptor.schema?.primaryKey,
      attribution: options.attribution ?? source.descriptor.attribution,
      ...(options.renderer?.kind === "cluster" ? options.renderer.toMapLibreSource() : {}),
    };
    removeUndefined(sourceSpec);
  } else {
    const descriptor = tileDescriptorWithQuery(requireTileDescriptor(options), currentQuery);
    for (const diagnostic of diagnoseQueryTileSourceSupport(descriptor)) {
      reasons.push({
        code: "tile-support",
        severity: diagnostic.severity === "info" ? "info" : "warning",
        message: diagnostic.message,
        detail: { queryTileDiagnostic: diagnostic.code },
      });
    }
    const spec = buildMapLibreQueryTileSourceSpec(descriptor, { useTileJsonUrl: currentQuery === undefined });
    currentTiles = spec.tiles ? [...spec.tiles] : undefined;
    sourceSpec = { ...spec, attribution: options.attribution ?? spec.attribution };
    removeUndefined(sourceSpec);
  }

  // ── Build the layer set ────────────────────────────────────────
  let currentRenderer: Renderer | undefined = options.renderer;
  let layers = buildLayers(strategy, sourceId, layerBase, sourceLayer, options, currentRenderer);
  let layerIds = layers.map((layer) => String(layer.id));
  const interactiveIdsFor = (ids: readonly string[]): readonly string[] =>
    options.layers ? ids : ids.filter((id) => !id.endsWith("-polygon-outline") && !id.endsWith("-cluster-count"));
  const interactiveLayerIds = interactiveIdsFor(layerIds);

  // ── Mutate the map transactionally ─────────────────────────────
  signal.throwIfAborted();
  assertIdsAvailable(map, sourceId, layerIds);
  const attempted: string[] = [];
  try {
    map.addSource(sourceId, sourceSpec);
    for (const layer of layers) {
      attempted.push(String(layer.id));
      map.addLayer(layer, options.beforeId);
    }
  } catch (cause) {
    rollback(map, sourceId, attempted);
    throw new HonuaDataToMapBridgeError(
      "map-mutation-failed",
      `Failed to mount source "${sourceId}" transactionally.`,
      { sourceId, attemptedLayerIds: attempted },
      { cause },
    );
  }

  // ── Interactions ───────────────────────────────────────────────
  const popupHandles: PopupBindingHandle[] = [];
  const hoverHandles: HoverHandle[] = [];
  const wireInteractions = (ids: readonly string[]): void => {
    if (options.popup) {
      const popup = options.popup;
      for (const layerId of ids) {
        popupHandles.push(
          bindPopup(map as MapEventTarget, {
            binding: { sourceId, ...(popup.title !== undefined ? { title: popup.title } : {}) },
            layerId,
            popupFactory: popup.factory,
            render: (context) => renderPopup(popup, context.features, context.lngLat),
          }),
        );
      }
    }
    if (options.hover) {
      const stateKey = typeof options.hover === "object" ? (options.hover.stateKey ?? "hover") : "hover";
      for (const layerId of ids) {
        hoverHandles.push(
          createHoverHandler(map as FeatureStateMap & MapEventTarget, {
            source: sourceId,
            layer: layerId,
            stateKey,
            ...(sourceLayer !== undefined ? { sourceLayer } : {}),
          }),
        );
      }
    }
  };
  try {
    wireInteractions(interactiveLayerIds);
  } catch (cause) {
    removeInteractions(popupHandles, hoverHandles);
    rollback(map, sourceId, layerIds);
    throw new HonuaDataToMapBridgeError(
      "map-mutation-failed",
      `Failed to wire interactions for source "${sourceId}".`,
      { sourceId },
      { cause },
    );
  }

  // ── Optional camera fit ────────────────────────────────────────
  if (options.fitBounds && typeof map.fitBounds === "function") {
    const bounds =
      strategy === "geojson" ? geojsonBounds : (options.queryTiles?.bounds ?? options.queryTiles?.tilejson?.bounds);
    if (bounds) {
      const padding = typeof options.fitBounds === "object" ? (options.fitBounds.padding ?? 32) : 32;
      map.fitBounds([bounds[0], bounds[1], bounds[2], bounds[3]], { padding });
    }
  }

  // ── Handle ─────────────────────────────────────────────────────
  let state: "ready" | "disposed" = "ready";
  let refreshTail: Promise<void> = Promise.resolve();

  const snapshotDiagnostics = (): MountedSourceDiagnostics =>
    Object.freeze({
      strategy,
      reasons: Object.freeze([...reasons]),
      updates: Object.freeze([...updates]),
      ...(featureCount !== undefined ? { featureCount } : {}),
      ...(totalCount !== undefined ? { totalCount } : {}),
      ...(overflow !== undefined ? { overflow } : {}),
      ...(presentKinds !== undefined ? { geometryKinds: Object.freeze([...presentKinds]) } : {}),
    });

  const applyGeoJsonUpdate = async (
    query: Readonly<Omit<Query<T>, "signal">> | undefined,
    code: "filter-applied" | "refresh-applied",
  ): Promise<void> => {
    const result = await materialize(query);
    if (state === "disposed") {
      throw new HonuaDataToMapBridgeError("disposed", "The mounted source was disposed during an update.");
    }
    const converted = canonicalFeaturesToGeoJson(result.features, source.descriptor.schema?.primaryKey);
    const handle = map.getSource(sourceId) as { setData?(data: AdapterGeoJsonFeatureCollection): void } | undefined;
    if (!handle || typeof handle.setData !== "function") {
      throw new HonuaDataToMapBridgeError(
        "map-mutation-failed",
        `Mounted source "${sourceId}" no longer exposes setData().`,
        { sourceId },
      );
    }
    handle.setData(converted.data);
    featureCount = converted.data.features.length;
    totalCount = resolveTotalCount(result);
    overflow = computeOverflow(result, limit, updates);
    presentKinds = geometryKinds(converted.data.features);
    updates.push(info(code, `Updated GeoJSON data in place with setData() (${featureCount} features).`));
  };

  const applyTileUpdate = async (
    query: Readonly<Omit<Query<T>, "signal">> | undefined,
    code: "filter-applied" | "refresh-applied",
  ): Promise<void> => {
    const descriptor = tileDescriptorWithQuery(requireTileDescriptor(options), query);
    const spec = buildMapLibreQueryTileSourceSpec(descriptor, { useTileJsonUrl: false });
    const nextTiles = spec.tiles ? [...spec.tiles] : undefined;
    if (!nextTiles || nextTiles.length === 0) {
      throw new HonuaDataToMapBridgeError(
        "filter-unsupported",
        "The query-tile descriptor cannot produce a tile URL template for filter updates.",
        { sourceId },
      );
    }
    if (
      code === "filter-applied" &&
      currentTiles !== undefined &&
      sameStringArray(nextTiles, currentTiles) &&
      !sameQuery(query, currentQuery)
    ) {
      throw new HonuaDataToMapBridgeError(
        "filter-unsupported",
        "The query-tile descriptor's fixed tile URLs cannot carry the new filter; supply an endpoint-based descriptor or use the geojson strategy.",
        { sourceId },
      );
    }
    const handle = map.getSource(sourceId) as { setTiles?(tiles: string[]): unknown } | undefined;
    if (handle && typeof handle.setTiles === "function") {
      handle.setTiles([...nextTiles]);
      currentTiles = nextTiles;
      updates.push(info(code, "Rewrote the tile URL template in place with setTiles()."));
      return;
    }
    // Structural fallback for hosts without setTiles: recreate the source
    // while keeping the layers' event bindings (they are keyed by layer id).
    for (const layerId of [...layerIds].reverse()) if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    const nextSpec: Record<string, unknown> = { ...spec, attribution: options.attribution ?? spec.attribution };
    removeUndefined(nextSpec);
    map.addSource(sourceId, nextSpec);
    for (const layer of layers) map.addLayer(layer, options.beforeId);
    currentTiles = nextTiles;
    updates.push(
      warning(
        "filter-recreated-source",
        "The map host does not expose setTiles(); the tile source and layers were recreated in place.",
      ),
    );
  };

  const clusterSourceOptionsOf = (renderer: Renderer | undefined): Record<string, unknown> | undefined =>
    renderer?.kind === "cluster" ? renderer.toMapLibreSource() : undefined;

  const applyRendererUpdate = async (next: Renderer | undefined): Promise<void> => {
    if (next?.kind === "cluster" && strategy !== "geojson") {
      throw new HonuaDataToMapBridgeError(
        "invalid-option",
        'A cluster renderer requires the "geojson" strategy (MapLibre clustering is a GeoJSON-source feature).',
        { sourceId, strategy },
      );
    }
    const nextLayers = buildLayers(strategy, sourceId, layerBase, sourceLayer, options, next);
    const nextIds = nextLayers.map((layer) => String(layer.id));
    const nextCluster = clusterSourceOptionsOf(next);
    const clusterChanged = !sameJson(clusterSourceOptionsOf(currentRenderer), nextCluster);

    const structureUnchanged =
      !clusterChanged &&
      nextIds.length === layerIds.length &&
      nextIds.every((id, index) => id === layerIds[index] && nextLayers[index].type === layers[index].type);

    if (structureUnchanged && typeof map.setPaintProperty === "function") {
      // Diff-update in place: no layer teardown, no source touch.
      for (let index = 0; index < nextLayers.length; index++) {
        const id = nextIds[index];
        diffProperties(recordOf(layers[index].paint), recordOf(nextLayers[index].paint), (name, value) =>
          map.setPaintProperty?.(id, name, value),
        );
        if (typeof map.setLayoutProperty === "function") {
          diffProperties(recordOf(layers[index].layout), recordOf(nextLayers[index].layout), (name, value) =>
            map.setLayoutProperty?.(id, name, value),
          );
        }
        if (typeof map.setFilter === "function" && !sameJson(layers[index].filter, nextLayers[index].filter)) {
          map.setFilter(id, nextLayers[index].filter);
        }
      }
      layers = nextLayers;
      currentRenderer = next;
      updates.push(info("renderer-applied", "Updated renderer paint/layout in place without layer teardown."));
      return;
    }

    // Structural path: replace the owned layers; recreate the source only
    // when GeoJSON cluster options changed. Materialize the replacement data
    // BEFORE any teardown so a failed or aborted query leaves the previously
    // working layers and interactions on the map untouched.
    const replacement = clusterChanged
      ? await (async () => {
          const result = await materialize(currentQuery);
          const converted = canonicalFeaturesToGeoJson(result.features, source.descriptor.schema?.primaryKey);
          return { result, converted };
        })()
      : undefined;
    removeInteractions(popupHandles, hoverHandles);
    for (const layerId of [...layerIds].reverse()) if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (replacement) {
      const { result, converted } = replacement;
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      const nextSpec: Record<string, unknown> = {
        type: "geojson",
        data: converted.data,
        promoteId: source.descriptor.schema?.primaryKey,
        attribution: options.attribution ?? source.descriptor.attribution,
        ...(nextCluster ?? {}),
      };
      removeUndefined(nextSpec);
      map.addSource(sourceId, nextSpec);
      featureCount = converted.data.features.length;
      totalCount = resolveTotalCount(result);
      overflow = computeOverflow(result, limit, updates);
      presentKinds = geometryKinds(converted.data.features);
    }
    for (const layer of nextLayers) map.addLayer(layer, options.beforeId);
    layers = nextLayers;
    layerIds = nextIds;
    currentRenderer = next;
    wireInteractions(interactiveIdsFor(layerIds));
    updates.push(
      info(
        clusterChanged ? "renderer-recreated-source" : "renderer-recreated-layers",
        clusterChanged
          ? "Renderer swap changed GeoJSON cluster options; the source and layers were recreated."
          : "Renderer swap changed the layer structure; the owned layers were recreated in place.",
      ),
    );
  };

  const enqueue = (work: () => Promise<void>): Promise<MountedSourceDiagnostics> => {
    const run = refreshTail.then(async () => {
      if (state === "disposed") {
        throw new HonuaDataToMapBridgeError("disposed", "Cannot update a disposed mounted source.");
      }
      signal.throwIfAborted();
      await work();
      return snapshotDiagnostics();
    });
    refreshTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const dispose = (): void => {
    if (state === "disposed") return;
    state = "disposed";
    lifecycle.abort(new DOMException("Mounted source disposed", "AbortError"));
    const failures: unknown[] = [];
    try {
      removeInteractions(popupHandles, hoverHandles);
    } catch (error) {
      failures.push(error);
    }
    for (const layerId of [...layerIds].reverse()) {
      try {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new HonuaDataToMapBridgeError(
        "map-mutation-failed",
        `Disposal of source "${sourceId}" completed with ${failures.length} renderer failure(s).`,
        { sourceId, failureCount: failures.length },
        { cause: failures[0] },
      );
    }
  };

  return {
    strategy,
    sourceId,
    get layerIds() {
      return [...layerIds];
    },
    sourceLayer,
    get state() {
      return state;
    },
    get diagnostics() {
      return snapshotDiagnostics();
    },
    setFilter(query) {
      return enqueue(async () => {
        if (strategy === "geojson") await applyGeoJsonUpdate(query, "filter-applied");
        else await applyTileUpdate(query, "filter-applied");
        currentQuery = query;
      });
    },
    setRenderer(renderer) {
      return enqueue(() => applyRendererUpdate(renderer));
    },
    refresh() {
      return enqueue(async () => {
        if (strategy === "geojson") await applyGeoJsonUpdate(currentQuery, "refresh-applied");
        else await applyTileUpdate(currentQuery, "refresh-applied");
      });
    },
    dispose,
    async [Symbol.asyncDispose]() {
      await refreshTail;
      dispose();
    },
  };
}

// ── Internals ────────────────────────────────────────────────────

function validateOptions<T>(map: DataToMapLibreMap, options: MountSourceOptions<T>): void {
  if (options.maxGeoJsonFeatures !== undefined) normalizedLimit(options.maxGeoJsonFeatures);
  if (
    options.geometry !== undefined &&
    options.geometry !== "auto" &&
    options.geometry !== "point" &&
    options.geometry !== "line" &&
    options.geometry !== "polygon"
  ) {
    throw new HonuaDataToMapBridgeError("invalid-option", `Unknown geometry "${String(options.geometry)}".`, {
      geometry: options.geometry,
    });
  }
  if (options.renderer !== undefined) {
    if (options.layers !== undefined) {
      throw new HonuaDataToMapBridgeError(
        "invalid-option",
        "options.renderer and options.layers are mutually exclusive; renderer-derived layers own the layer set.",
      );
    }
    const renderer = options.renderer as Partial<Renderer>;
    if (typeof renderer.toMapLibre !== "function" || typeof renderer.kind !== "string") {
      throw new HonuaDataToMapBridgeError(
        "invalid-option",
        "options.renderer must be a renderer object from @honua/sdk-js/style (classBreaksRenderer, uniqueValueRenderer, heatmapRenderer, clusterRenderer).",
      );
    }
  }
  if (options.layers !== undefined) {
    if (options.layers.length === 0) {
      throw new HonuaDataToMapBridgeError("invalid-option", "options.layers must contain at least one layer.");
    }
    const seen = new Set<string>();
    for (const layer of options.layers) {
      const id = layer.id;
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
        throw new HonuaDataToMapBridgeError("invalid-option", "Every options.layers entry needs a unique string id.", {
          layerId: id,
        });
      }
      seen.add(id);
    }
  }
  if (options.popup && (typeof map.on !== "function" || typeof map.off !== "function")) {
    throw new HonuaDataToMapBridgeError(
      "interaction-unsupported",
      "Popups require a map with on()/off() event methods.",
    );
  }
  if (
    options.hover &&
    (typeof map.on !== "function" || typeof map.off !== "function" || typeof map.setFeatureState !== "function")
  ) {
    throw new HonuaDataToMapBridgeError(
      "interaction-unsupported",
      "Hover feature-state requires a map with on()/off() and setFeatureState() methods.",
    );
  }
}

function normalizedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_GEOJSON_FEATURES;
  if (!Number.isInteger(value) || value < 1) {
    throw new HonuaDataToMapBridgeError("invalid-option", "maxGeoJsonFeatures must be a positive integer.", {
      maxGeoJsonFeatures: value,
    });
  }
  return value;
}

function requireTileDescriptor<T>(options: MountSourceOptions<T>): QueryTileSourceDescriptor<T> {
  const descriptor = options.queryTiles;
  if (!descriptor) {
    throw new HonuaDataToMapBridgeError(
      "invalid-option",
      "The query-tiles strategy requires options.queryTiles (a dynamic query-tile source descriptor).",
    );
  }
  return descriptor;
}

function tileDescriptorWithQuery<T>(
  descriptor: QueryTileSourceDescriptor<T>,
  query: Readonly<Omit<Query<T>, "signal">> | undefined,
): QueryTileSourceDescriptor<T> {
  if (query !== undefined) return { ...descriptor, query: { ...query } };
  // `setFilter(undefined)` clears the mounted filter: strip a baked
  // descriptor-level query too, so the rebuilt tile URL is unfiltered.
  if (descriptor.query === undefined) return descriptor;
  const { query: _cleared, ...rest } = descriptor;
  return rest;
}

function buildLayers<T>(
  strategy: DataToMapStrategy,
  sourceId: string,
  layerBase: string,
  sourceLayer: string | undefined,
  options: MountSourceOptions<T>,
  renderer: Renderer | undefined,
): readonly Readonly<Record<string, unknown>>[] {
  if (options.layers) {
    return options.layers.map((layer) =>
      Object.freeze({
        source: sourceId,
        ...(strategy === "query-tiles" && sourceLayer !== undefined && layer["source-layer"] === undefined
          ? { "source-layer": sourceLayer }
          : {}),
        ...layer,
      }),
    );
  }
  if (renderer?.kind === "cluster") {
    return renderer.toMapLibre("point").map((fragment) =>
      Object.freeze({
        id: `${layerBase}-${fragment.role}`,
        type: fragment.type,
        source: sourceId,
        ...(fragment.filter !== undefined ? { filter: fragment.filter } : {}),
        paint: { ...fragment.paint },
        ...(Object.keys(fragment.layout).length > 0 ? { layout: { ...fragment.layout } } : {}),
        metadata: { "honua:mount": "data-to-map-bridge", "honua:strategy": strategy, "honua:renderer": renderer.kind },
      }),
    );
  }
  if (renderer?.kind === "heatmap") {
    const [fragment] = renderer.toMapLibre("point");
    return [
      Object.freeze({
        id: `${layerBase}-heatmap`,
        type: fragment.type,
        source: sourceId,
        ...(sourceLayer !== undefined ? { "source-layer": sourceLayer } : {}),
        filter: ["==", ["geometry-type"], "Point"],
        paint: { ...fragment.paint },
        ...(Object.keys(fragment.layout).length > 0 ? { layout: { ...fragment.layout } } : {}),
        metadata: { "honua:mount": "data-to-map-bridge", "honua:strategy": strategy, "honua:renderer": renderer.kind },
      }),
    ];
  }
  const requested = options.geometry === undefined || options.geometry === "auto" ? undefined : options.geometry;
  const kinds: readonly MapLibreGeometryKind[] = requested ? [requested] : ["point", "line", "polygon"];
  const layers: Record<string, unknown>[] = [];
  for (const kind of kinds) {
    const fragment = renderer ? renderer.toMapLibre(kind)[0] : undefined;
    const rendererLayout = fragment && Object.keys(fragment.layout).length > 0 ? fragment.layout : undefined;
    layers.push(
      layerSpec(
        strategy,
        sourceId,
        `${layerBase}-${kind}`,
        layerType(kind),
        kind,
        sourceLayer,
        {
          ...defaultPaint(kind),
          ...(fragment?.paint ?? {}),
          ...(options.paint?.[kind] ?? {}),
        },
        rendererLayout || options.layout?.[kind]
          ? { ...(rendererLayout ?? {}), ...(options.layout?.[kind] ?? {}) }
          : undefined,
      ),
    );
    if (kind === "polygon") {
      layers.push(
        layerSpec(
          strategy,
          sourceId,
          `${layerBase}-polygon-outline`,
          "line",
          "polygon",
          sourceLayer,
          {
            ...defaultPolygonOutlinePaint(),
            ...(options.paint?.polygonOutline ?? {}),
          },
          options.layout?.polygonOutline,
        ),
      );
    }
  }
  return layers.map((layer) => Object.freeze(layer));
}

function layerSpec(
  strategy: DataToMapStrategy,
  sourceId: string,
  id: string,
  type: "circle" | "line" | "fill",
  kind: MapLibreGeometryKind,
  sourceLayer: string | undefined,
  paint: Readonly<Record<string, unknown>>,
  layout: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  return {
    id,
    type,
    source: sourceId,
    ...(sourceLayer !== undefined ? { "source-layer": sourceLayer } : {}),
    filter: ["==", ["geometry-type"], mapLibreGeometryType(kind)],
    paint,
    ...(layout ? { layout: { ...layout } } : {}),
    metadata: { "honua:mount": "data-to-map-bridge", "honua:strategy": strategy },
  };
}

function assertIdsAvailable(map: DataToMapLibreMap, sourceId: string, layerIds: readonly string[]): void {
  if (map.getSource(sourceId)) {
    throw new HonuaDataToMapBridgeError("source-conflict", `MapLibre source "${sourceId}" already exists.`, {
      sourceId,
    });
  }
  for (const layerId of layerIds) {
    if (map.getLayer(layerId)) {
      throw new HonuaDataToMapBridgeError("layer-conflict", `MapLibre layer "${layerId}" already exists.`, {
        layerId,
      });
    }
  }
}

function rollback(map: DataToMapLibreMap, sourceId: string, layerIds: readonly string[]): void {
  for (const layerId of [...layerIds].reverse()) {
    try {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    } catch {
      /* best-effort rollback */
    }
  }
  try {
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  } catch {
    /* best-effort rollback */
  }
}

function removeInteractions(popupHandles: PopupBindingHandle[], hoverHandles: HoverHandle[]): void {
  for (const handle of popupHandles.splice(0)) handle.remove();
  for (const handle of hoverHandles.splice(0)) handle.remove();
}

function renderPopup(
  options: MountSourcePopupOptions,
  features: readonly PopupFeature[],
  lngLat: [number, number],
): Node | string | undefined {
  if (options.render) return options.render({ features, lngLat });
  const doc = typeof document !== "undefined" ? document : undefined;
  const feature = features[0];
  if (!doc || !feature?.properties) return undefined;
  const root = doc.createElement("div");
  if (options.title) {
    const title = doc.createElement("h3");
    title.textContent = options.title;
    root.appendChild(title);
  }
  const fields = options.fields
    ? options.fields.filter((field) => Object.hasOwn(feature.properties ?? {}, field))
    : Object.keys(feature.properties);
  const dl = doc.createElement("dl");
  for (const field of fields) {
    const dt = doc.createElement("dt");
    dt.textContent = field;
    const dd = doc.createElement("dd");
    dd.textContent = String(feature.properties[field]);
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  root.appendChild(dl);
  return root;
}

function resolveTotalCount<T>(result: Result<T>): number | undefined {
  // Some adapters report totalCount as the returned page size; drop it when
  // the result was truncated and the count carries no extra information.
  if (result.totalCount !== undefined && (result.totalCount > result.features.length || !result.exceededTransferLimit))
    return result.totalCount;
  return result.exceededTransferLimit ? undefined : (result.totalCount ?? result.features.length);
}

function computeOverflow<T>(
  result: Result<T>,
  limit: number,
  sink: DataToMapDiagnostic[],
): DataToMapOverflow | undefined {
  if (!result.exceededTransferLimit) return undefined;
  const overflow: DataToMapOverflow = Object.freeze({
    truncated: true,
    renderedFeatureCount: result.features.length,
    limit,
    ...(result.totalCount !== undefined && result.totalCount > result.features.length
      ? { totalCount: result.totalCount }
      : {}),
  });
  sink.push(
    warning(
      "overflow-truncated",
      `GeoJSON materialization was truncated at ${result.features.length} of the matching rows (limit ${limit}); raise maxGeoJsonFeatures or use the query-tiles strategy.`,
      { renderedFeatureCount: result.features.length, limit },
    ),
  );
  return overflow;
}

function computeBounds(data: AdapterGeoJsonFeatureCollection): [number, number, number, number] | undefined {
  let xmin = Number.POSITIVE_INFINITY;
  let ymin = Number.POSITIVE_INFINITY;
  let xmax = Number.NEGATIVE_INFINITY;
  let ymax = Number.NEGATIVE_INFINITY;
  const visit = (coordinates: unknown): void => {
    if (!Array.isArray(coordinates)) return;
    if (coordinates.length >= 2 && typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
      const [x, y] = coordinates;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        xmin = Math.min(xmin, x);
        ymin = Math.min(ymin, y);
        xmax = Math.max(xmax, x);
        ymax = Math.max(ymax, y);
      }
      return;
    }
    for (const entry of coordinates) visit(entry);
  };
  for (const feature of data.features) visit(feature.geometry?.coordinates);
  if (!Number.isFinite(xmin) || !Number.isFinite(ymin) || !Number.isFinite(xmax) || !Number.isFinite(ymax)) {
    return undefined;
  }
  return [xmin, ymin, xmax, ymax];
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameQuery(left: unknown, right: unknown): boolean {
  return sameJson(left, right);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Apply added/changed keys and unset removed keys through a MapLibre setter. */
function diffProperties(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  set: (name: string, value: unknown) => void,
): void {
  for (const [key, value] of Object.entries(next)) {
    if (!sameJson(previous[key], value)) set(key, value);
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) set(key, undefined);
  }
}

function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const available = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return available.length === 1 ? (available[0] as AbortSignal) : AbortSignal.any(available);
}

function info(code: DataToMapDiagnosticCode, message: string, detail?: Readonly<Record<string, unknown>>) {
  return Object.freeze({ code, severity: "info" as const, message, ...(detail ? { detail } : {}) });
}

function warning(code: DataToMapDiagnosticCode, message: string, detail?: Readonly<Record<string, unknown>>) {
  return Object.freeze({ code, severity: "warning" as const, message, ...(detail ? { detail } : {}) });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
