/**
 * {@link HonuaSourceLayer} — the declarative face of the data-to-map bridge
 * (REQ-002 of the react depth pass): mount a contract `Source` as a styled,
 * interactive MapLibre layer set inside any enclosing map (`HonuaMap`, a
 * {@link HonuaMapProvider}-published external map, or an explicit `map` prop).
 *
 * Prop changes diff in place (`query` → `setFilter`, `renderer.paint/layout` →
 * property setters); unmounting disposes every bridge-owned MapLibre resource;
 * React 18/19 StrictMode double-mounts neither leak nor double-add (see
 * {@link useMountedSource}).
 *
 * SSR-safe: no `window` / `document` access at module scope.
 *
 * @module
 */

import type { ReactNode } from "react";
import { useMemo } from "react";

import type { Query, Source } from "../contract/types.js";
import type {
  DataToMapLibreMap,
  MountSourceOptions,
  MountedSourceDiagnostics,
  MountSourcePopupOptions,
} from "../map/data-to-map-bridge.js";
import { useHonuaMap } from "./external-map.js";
import { useMapHoverBinding, useMapSelectionBinding } from "./selection.js";
import { useMountedSource } from "./use-mounted-source.js";

/**
 * Declarative styling for a {@link HonuaSourceLayer}: the bridge's renderer
 * surface (geometry restriction, per-geometry paint/layout overrides, or a
 * verbatim custom layer set). `paint` / `layout` changes are applied in place;
 * `geometry` / `layers` changes remount the layer set.
 *
 * @experimental
 */
export type HonuaSourceRenderer<T = Record<string, unknown>> = Pick<
  MountSourceOptions<T>,
  "geometry" | "layers" | "paint" | "layout"
>;

/** Props for {@link HonuaSourceLayer}. @experimental */
export interface HonuaSourceLayerProps<T = Record<string, unknown>> {
  /** The contract `Source` to mount. `null` while it is still resolving. */
  source: Source<T> | null | undefined;
  /**
   * Target map. Omit to resolve the nearest enclosing `HonuaMap` /
   * {@link HonuaMapProvider} (external-map interop).
   */
  map?: DataToMapLibreMap | null;
  /** Filter applied to the mounted data; changes diff via `setFilter`. */
  query?: Readonly<Omit<Query<T>, "signal">>;
  /** Renderer object: geometry restriction + paint/layout overrides or custom layers. */
  renderer?: HonuaSourceRenderer<T>;
  /** Open a popup on feature click (`factory` usually `() => new maplibregl.Popup()`). */
  popup?: MountSourcePopupOptions;
  /** Toggle hover feature-state on the mounted layers (bridge `hover` option). */
  hover?: boolean | { readonly stateKey?: string };
  /**
   * Share feature selection with the enclosing `HonuaSelectionProvider`:
   * clicks toggle the shared selection and the shared selection is mirrored
   * onto feature-state (default key `"selected"`). Also publishes hover to the
   * provider when {@link hover} is enabled. No-op without a provider.
   */
  selection?: boolean | { readonly stateKey?: string; readonly multiSelect?: boolean };
  /** When `false`, nothing is mounted. @default true */
  enabled?: boolean;
  /** Called with fresh diagnostics after the mount and each applied update. */
  onDiagnostics?: (diagnostics: MountedSourceDiagnostics) => void;
  /** Called when mounting or an update fails. */
  onError?: (error: unknown) => void;
  /** Force a bridge strategy (`"geojson"` / `"query-tiles"`). */
  strategy?: MountSourceOptions<T>["strategy"];
  /** MapLibre source id override. @default `honua-<descriptor id>` */
  sourceId?: string;
  /** Base layer id override; geometry suffixes are appended. */
  layerId?: string;
  /** Existing layer id to insert the bridge layers before. */
  beforeId?: string;
  /** GeoJSON materialization bound. @default 10000 */
  maxGeoJsonFeatures?: number;
  /** Dynamic query-tile descriptor enabling the tile strategy. */
  queryTiles?: MountSourceOptions<T>["queryTiles"];
  /** Vector `source-layer` for the tile strategy. */
  sourceLayer?: string;
  /** Attribution override. */
  attribution?: string;
  /** Fit the map to the mounted data. */
  fitBounds?: MountSourceOptions<T>["fitBounds"];
}

/**
 * Mount a contract `Source` through the data-to-map bridge, declaratively.
 * Renders nothing itself.
 *
 * @example
 * ```tsx
 * <HonuaSourceLayer
 *   source={source}
 *   query={{ where: "STATUS = 'OPEN'" }}
 *   renderer={{ paint: { point: { "circle-color": "#38bdf8" } } }}
 *   hover
 *   selection
 * />
 * ```
 *
 * @experimental
 */
export function HonuaSourceLayer<T = Record<string, unknown>>(props: HonuaSourceLayerProps<T>): ReactNode {
  const map = useHonuaMap(props.map);
  const { handle } = useMountedSource<T>(map, props.source, {
    enabled: props.enabled,
    query: props.query,
    geometry: props.renderer?.geometry,
    layers: props.renderer?.layers,
    paint: props.renderer?.paint,
    layout: props.renderer?.layout,
    popup: props.popup,
    hover: props.hover,
    onDiagnostics: props.onDiagnostics,
    onError: props.onError,
    strategy: props.strategy,
    sourceId: props.sourceId,
    layerId: props.layerId,
    beforeId: props.beforeId,
    maxGeoJsonFeatures: props.maxGeoJsonFeatures,
    queryTiles: props.queryTiles,
    sourceLayer: props.sourceLayer,
    attribution: props.attribution,
    fitBounds: props.fitBounds,
  });

  // Interactive layers exclude the polygon outline companion, mirroring the
  // bridge's own popup/hover wiring.
  const interactiveLayerIds = useMemo(
    () => (handle ? handle.layerIds.filter((id) => !id.endsWith("-polygon-outline")) : []),
    [handle],
  );
  const selection = props.selection;
  const selectionEnabled = Boolean(selection) && handle !== null;
  // Bind against the handle's *resolved* source-layer — the explicit prop or
  // the default the bridge derived from the query-tile descriptor. MapLibre
  // scopes vector-tile feature-state by source-layer, so the binding must
  // target the exact value the mounted layers render with.
  const resolvedSourceLayer = handle?.sourceLayer ?? props.sourceLayer;

  useMapSelectionBinding(map, {
    sourceId: handle?.sourceId ?? "",
    layerIds: interactiveLayerIds,
    sourceLayer: resolvedSourceLayer,
    stateKey: typeof selection === "object" ? selection.stateKey : undefined,
    multiSelect: typeof selection === "object" ? selection.multiSelect : undefined,
    enabled: selectionEnabled,
  });
  useMapHoverBinding(map, {
    sourceId: handle?.sourceId ?? "",
    layerIds: interactiveLayerIds,
    sourceLayer: resolvedSourceLayer,
    enabled: selectionEnabled && Boolean(props.hover),
  });

  return null;
}
