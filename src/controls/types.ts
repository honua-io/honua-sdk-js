/**
 * Shared types for the native Honua control kit (`@honua/sdk-js/controls`).
 *
 * Controls in this entry operate directly on a MapLibre `Map` instance via a
 * duck-typed interface — they never import `maplibre-gl` and never touch the
 * SDK core, so the entry stays bundle-independent (same packaging posture as
 * `@honua/sdk-js/esri-compat`).
 *
 * @module
 */

/**
 * The flavor of a basemap definition. Purely descriptive metadata — the
 * switcher treats every base the same way (a set of sources + layers that are
 * shown exclusively). Exposed on the rendered radio as a `data-kind`
 * attribute so hosts can style per kind.
 *
 * - `"vector"` — vector tile base (e.g. MVT or `pmtiles://` vector sources).
 * - `"raster"` — raster tile base (e.g. XYZ imagery, WMTS, raster PMTiles).
 * - `"raster-dem-composite"` — composite base that pairs layers from multiple
 *   sources, typically a vector base plus a `raster-dem` hillshade rendered
 *   together as one exclusive option (e.g. a "Terrain" base).
 */
export type HonuaBasemapKind = "vector" | "raster" | "raster-dem-composite";

/**
 * A MapLibre layer specification owned by a basemap definition. The switcher
 * only requires the `id`; everything else is passed straight through to
 * `map.addLayer`, so any MapLibre layer type (`background`, `raster`, `fill`,
 * `line`, `symbol`, `hillshade`, ...) is supported.
 */
export interface HonuaBasemapLayerSpecification {
  /** Unique layer id within the map style. */
  readonly id: string;
  /** Remaining MapLibre layer specification properties (type, source, paint, layout, ...). */
  readonly [key: string]: unknown;
}

/**
 * One exclusive basemap option: a set of MapLibre sources and layers that are
 * added/shown together and hidden when another base is activated.
 *
 * The switcher is protocol-agnostic — `sources` values are passed verbatim to
 * `map.addSource`, so `pmtiles://` vector sources, raster tile URL templates,
 * `raster-dem` terrain sources, and inline GeoJSON all work as long as the
 * host map can resolve them.
 *
 * A composite base (e.g. "Terrain" = vector base + hillshade) is simply a
 * definition with multiple sources and multiple layers; the layers stay in
 * the order given. Bases may share source ids and even layer ids (a shared
 * layer stays visible while any base referencing it is active).
 */
export interface HonuaBasemapDefinition {
  /** Stable identifier emitted in `change` events and used by `value`. */
  readonly id: string;
  /** Human-readable label rendered on the radio button. */
  readonly label: string;
  /** Descriptive base kind (see {@link HonuaBasemapKind}). */
  readonly kind: HonuaBasemapKind;
  /** MapLibre sources keyed by source id, passed verbatim to `map.addSource`. */
  readonly sources: Readonly<Record<string, unknown>>;
  /** MapLibre layers added (in order) beneath the host's overlay layers. */
  readonly layers: readonly HonuaBasemapLayerSpecification[];
}

/**
 * Minimal duck-typed subset of `maplibre-gl.Map` required by the basemap
 * switcher. Mirrors the duck-typing pattern used by `src/runtime/runtime.ts`
 * (`MaplibreMap`) so the controls entry stays bundle-neutral: any MapLibre-GL
 * `Map` instance satisfies this interface, and tests can pass a plain stub.
 */
export interface HonuaBasemapSwitcherMap {
  /** Adds a source to the map style. */
  addSource(id: string, source: unknown): void;
  /** Removes a source; used when pruning bases that were removed from `bases`. */
  removeSource?(id: string): void;
  /** Returns a truthy handle when the source already exists. */
  getSource?(id: string): unknown;
  /** Adds a layer, optionally before an existing layer id. */
  addLayer(layer: unknown, beforeId?: string): void;
  /** Removes a layer; used when pruning bases that were removed from `bases`. */
  removeLayer?(id: string): void;
  /** Returns a truthy handle when the layer already exists. */
  getLayer?(id: string): unknown;
  /** Sets a layout property; used to toggle `visibility` exclusively. */
  setLayoutProperty(layerId: string, name: string, value: unknown): void;
  /** Used to find the insertion anchor so base layers stay beneath overlays. */
  getStyle?(): unknown;
}

/**
 * Detail payload of the `change` CustomEvent dispatched by
 * `<honua-basemap-switcher>` whenever the active base changes (user
 * interaction, programmatic `value` assignment, or initial activation).
 */
export interface HonuaBasemapSwitcherChangeDetail {
  /** Id of the now-active base. */
  readonly value: string;
  /** Id of the previously active base; absent on the initial activation. */
  readonly previousValue?: string;
  /** Kind of the now-active base. */
  readonly kind: HonuaBasemapKind;
}

/**
 * One overlay option rendered as a toggle row by `<honua-layer-list>`. An
 * overlay groups one or more MapLibre style layer ids that are shown/hidden
 * together (their `visibility` layout property is toggled in lock-step).
 */
export interface HonuaLayerListOverlay {
  /** Stable identifier emitted in `change` events. */
  readonly id: string;
  /** Human-readable label rendered next to the checkbox. */
  readonly label: string;
  /** Style layer ids toggled together when the overlay is toggled. */
  readonly layers: readonly string[];
  /** Optional attribution text (purely descriptive; rendered as a row hint). */
  readonly attribution?: string;
}

/**
 * Orientation of the divider rendered by `<honua-swipe-control>`:
 * - `"vertical"` — a vertical divider that moves left/right, clipping the top
 *   map's left edge (the default; a left/right comparison).
 * - `"horizontal"` — a horizontal divider that moves up/down, clipping the top
 *   map's top edge (a top/bottom comparison).
 */
export type HonuaSwipeOrientation = "vertical" | "horizontal";

/**
 * Detail payload of the `change` CustomEvent dispatched by
 * `<honua-swipe-control>` whenever the divider position changes (user drag,
 * keyboard, or programmatic `position` assignment).
 */
export interface HonuaSwipeChangeDetail {
  /** Divider position as a percentage 0–100 of the control's width/height. */
  readonly position: number;
  /** Current divider orientation. */
  readonly orientation: HonuaSwipeOrientation;
}

/**
 * Minimal duck-typed subset of `maplibre-gl.Map` required by
 * `<honua-layer-list>`. Any MapLibre-GL `Map` instance satisfies this
 * interface, and tests can pass a plain stub (same posture as
 * {@link HonuaBasemapSwitcherMap} and {@link HonuaLegendMap}).
 */
export interface HonuaLayerListMap {
  /** Returns a truthy handle when the layer exists (drives the not-seeded state). */
  getLayer?(id: string): unknown;
  /** Reads a layout property; used to sync checkbox state from the map. */
  getLayoutProperty?(layerId: string, name: string): unknown;
  /** Sets a layout property; used to toggle `visibility` per overlay layer. */
  setLayoutProperty(layerId: string, name: string, value: unknown): void;
  /** Subscribes to map events; used for `auto-refresh` on `styledata`. */
  on?(type: string, listener: (event?: unknown) => void): unknown;
  /** Unsubscribes a listener registered with `on`. */
  off?(type: string, listener: (event?: unknown) => void): unknown;
}

/**
 * Detail payload of the `change` CustomEvent dispatched by
 * `<honua-layer-list>` whenever an overlay is toggled (user interaction or
 * programmatic `setVisible`).
 */
export interface HonuaLayerListChangeDetail {
  /** Id of the toggled overlay. */
  readonly id: string;
  /** Whether the overlay's layers are now visible. */
  readonly visible: boolean;
}

/**
 * Minimal duck-typed subset of `maplibre-gl.Map` required by
 * `<honua-swipe-control>`. The control only needs each map's canvas
 * container so it can apply a CSS `clip-path` to the top map; any MapLibre-GL
 * `Map` instance satisfies this interface, and tests can pass a plain stub
 * (same posture as {@link HonuaBasemapSwitcherMap}).
 */
export interface HonuaSwipeMap {
  /** Returns the map's outermost container element (clip target). */
  getContainer(): HTMLElement;
}

/**
 * Swatch geometry rendered for a legend entry by `<honua-legend>`:
 * - `"fill"` — square swatch (polygon fills); supports an outline color.
 * - `"line"` — short horizontal bar (line layers).
 * - `"circle"` — round swatch (circle/point layers).
 */
export type HonuaLegendSwatchShape = "fill" | "line" | "circle";

/** Split fill/outline colors for a legend swatch (typically fill layers). */
export interface HonuaLegendSwatchColor {
  /** CSS color painted as the swatch body. */
  readonly fill?: string;
  /** CSS color painted as the swatch border. */
  readonly outline?: string;
}

/** One swatch+label row rendered by `<honua-legend>`. */
export interface HonuaLegendEntry {
  /** Visible text carrying the entry's meaning (swatches are aria-hidden). */
  readonly label: string;
  /** Swatch color: a CSS color string or split `{ fill, outline }` colors. */
  readonly color: string | HonuaLegendSwatchColor;
  /** Swatch geometry; defaults to `"fill"`. */
  readonly shape?: HonuaLegendSwatchShape;
}

/** A titled group of legend entries rendered by `<honua-legend>`. */
export interface HonuaLegendSection {
  /** Optional section title rendered above the rows. */
  readonly title?: string;
  /**
   * Style layer id this section describes. When the element has
   * `follow-layer-visibility`, the section is hidden while the layer's
   * `visibility` layout property is `"none"`.
   */
  readonly layer?: string;
  /** The swatch+label rows of the section. */
  readonly entries: readonly HonuaLegendEntry[];
}

/**
 * Minimal duck-typed subset of `maplibre-gl.Map` required by
 * `<honua-legend>`. Any MapLibre-GL `Map` instance satisfies this interface,
 * and tests can pass a plain stub (same posture as
 * {@link HonuaBasemapSwitcherMap}).
 */
export interface HonuaLegendMap {
  /** Returns a truthy handle (with a `type`) when the layer exists. */
  getLayer?(id: string): unknown;
  /** Reads a paint property value as written in the style (expressions are returned verbatim). */
  getPaintProperty?(layerId: string, name: string): unknown;
  /** Reads a layout property; used for `follow-layer-visibility`. */
  getLayoutProperty?(layerId: string, name: string): unknown;
  /** Subscribes to map events; used for `auto-refresh` on `styledata`. */
  on?(type: string, listener: (event?: unknown) => void): unknown;
  /** Unsubscribes a listener registered with `on`. */
  off?(type: string, listener: (event?: unknown) => void): unknown;
}
