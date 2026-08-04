/**
 * Canonical component catalog for the Honua custom-element kit
 * (`@honua/sdk-js/controls` + `@honua/sdk-js/web-components`; both moving to
 * `@honua/app-platform` per `docs/decisions/scope-split-and-1.0.md`).
 *
 * Tracked by issue #679 (parent epic #678 "app-platform component production
 * readiness"): before either kit's custom elements can be considered one
 * coherent, production-supported surface, every shipped tag needs exactly one
 * documented owner, described once, regardless of which subpath (or which
 * import order) a consumer reaches it through.
 *
 * This module is pure metadata — it holds no reference to the actual element
 * classes and performs no `customElements` registration. Importing it never
 * touches DOM globals and carries none of either kit's runtime weight (in
 * particular, none of `web-components`' `src/core` / `src/runtime`
 * dependency), so it is safe to import from any environment — SSR, workers,
 * either kit's bundle, or a lint/doc tool introspecting the catalog — without
 * pulling in the other kit's closure. {@link "./registry.js"} is the
 * companion module that turns catalog entries into actual registrations.
 *
 * @module
 */

/** The kit that implements a catalog entry. */
export type HonuaComponentSource = "controls" | "web-components";

/**
 * Component maturity, distinct from the `@honua/sdk-js` subpath support tier
 * (`config/support-manifest.v1.json`'s `supported`/`beta`/`experimental`/...
 * vocabulary describes *entrypoints*, not individual widgets).
 *
 * - `"survival-tier"` — the baseline widget shipped for issue #493: usable,
 *   accessible, but not yet hardened to epic #678's production bar (bounded
 *   virtualized tables, capability-aware editing/sketch, pluggable chart
 *   adapters, secure export, full qualification gates).
 * - `"production-tier"` — the target state feature issues #680-683 raise
 *   individual components to. `honua-feature-editor` is the first entry there
 *   (issue #680): a capability-aware, schema/domain/subtype-derived editing and
 *   sketch surface composed from the public contract edit primitives. The
 *   survival-tier `honua-editor` remains as the simpler controller-driven
 *   widget.
 */
export type HonuaComponentSupportTier = "survival-tier" | "production-tier";

/** One custom-element tag's catalog entry: ownership, maturity, and contract. */
export interface HonuaComponentCatalogEntry {
  /** Stable catalog id (`"<source>.<slug>"`), e.g. `"web-components.layer-list"`. Never reused. */
  readonly id: string;
  /** Custom-element tag name this entry defines. */
  readonly tag: string;
  /** Kit that implements this entry. */
  readonly source: HonuaComponentSource;
  /** Class export name from the owning kit's subpath, e.g. `"HonuaLayerListElement"`. */
  readonly className: string;
  /** Component maturity; see {@link HonuaComponentSupportTier}. */
  readonly supportTier: HonuaComponentSupportTier;
  /**
   * Whether this entry is `tag`'s default/canonical registrant — the one
   * `registerAllComponents()` (see `./registry.js`) and each kit's blanket
   * auto-registration (importing `@honua/sdk-js/controls` or
   * `@honua/sdk-js/web-components`) claim the tag with when no explicit
   * choice is made. Exactly one entry is canonical per distinct `tag`.
   */
  readonly canonical: boolean;
  /** Adapters/context this element needs to become interactive (not merely render). */
  readonly requiredAdapters: readonly string[];
  /** Custom event names the element dispatches (`"change"` for the framework-free controls idiom). */
  readonly events: readonly string[];
  /** Other catalog ids that register the *same* `tag` with a different class. */
  readonly collidesWithIds: readonly string[];
}

/**
 * The full component catalog: every custom-element tag shipped by either
 * kit. Two tags — `honua-legend` and `honua-layer-list` — have two competing
 * implementations (`controls` and `web-components`); each is represented as
 * its own entry with `collidesWithIds` naming the other, and exactly one of
 * the two is `canonical: true`.
 */
export const HONUA_COMPONENT_CATALOG: readonly HonuaComponentCatalogEntry[] = [
  // ── controls kit (@honua/sdk-js/controls) ──────────────────────────────
  {
    id: "controls.basemap-switcher",
    tag: "honua-basemap-switcher",
    source: "controls",
    className: "HonuaBasemapSwitcherElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["maplibre-map"],
    events: ["change"],
    collidesWithIds: [],
  },
  {
    id: "controls.swipe-control",
    tag: "honua-swipe-control",
    source: "controls",
    className: "HonuaSwipeControlElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["maplibre-map"],
    events: ["change"],
    collidesWithIds: [],
  },
  {
    id: "controls.legend",
    tag: "honua-legend",
    source: "controls",
    className: "HonuaLegendElement",
    supportTier: "survival-tier",
    canonical: false,
    requiredAdapters: ["maplibre-map"],
    events: [],
    collidesWithIds: ["web-components.legend"],
  },
  {
    id: "controls.layer-list",
    tag: "honua-layer-list",
    source: "controls",
    className: "HonuaLayerListElement",
    supportTier: "survival-tier",
    canonical: false,
    requiredAdapters: ["maplibre-map"],
    events: ["change"],
    collidesWithIds: ["web-components.layer-list"],
  },

  // ── web-components kit (@honua/sdk-js/web-components) ──────────────────
  {
    id: "web-components.map",
    tag: "honua-map",
    source: "web-components",
    className: "HonuaMapElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: [],
    events: [
      "honua-controller-ready",
      "honua-map-ready",
      "honua-map-error",
      "honua-map-click",
      "honua-map-hover",
      "honua-selection-change",
      "honua-viewport-change",
    ],
    collidesWithIds: [],
  },
  {
    id: "web-components.layer-list",
    tag: "honua-layer-list",
    source: "web-components",
    className: "HonuaLayerListElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["web-component-controller"],
    events: ["honua-layer-visibility-change", "honua-layer-opacity-change", "honua-layer-order-change"],
    collidesWithIds: ["controls.layer-list"],
  },
  {
    id: "web-components.legend",
    tag: "honua-legend",
    source: "web-components",
    className: "HonuaLegendElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["web-component-controller"],
    events: [],
    collidesWithIds: ["controls.legend"],
  },
  {
    id: "web-components.feature-table",
    tag: "honua-feature-table",
    source: "web-components",
    className: "HonuaFeatureTableElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["web-component-controller"],
    events: ["honua-filter-change", "honua-selection-change", "honua-table-conflict"],
    collidesWithIds: [],
  },
  {
    id: "web-components.search",
    tag: "honua-search",
    source: "web-components",
    className: "HonuaSearchElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["web-component-controller"],
    events: ["honua-search", "honua-selection-change", "honua-geocode-select"],
    collidesWithIds: [],
  },
  {
    id: "web-components.editor",
    tag: "honua-editor",
    source: "web-components",
    className: "HonuaEditorElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["web-component-controller"],
    events: ["honua-edit-change"],
    collidesWithIds: [],
  },
  {
    id: "web-components.feature-editor",
    tag: "honua-feature-editor",
    source: "web-components",
    className: "HonuaFeatureEditorElement",
    supportTier: "production-tier",
    canonical: true,
    requiredAdapters: ["edit-capable-source"],
    events: ["honua-feature-edit-change", "honua-feature-edit-commit"],
    collidesWithIds: [],
  },
  {
    id: "web-components.chart",
    tag: "honua-chart",
    source: "web-components",
    className: "HonuaChartElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["web-component-controller"],
    events: [],
    collidesWithIds: [],
  },
  {
    id: "web-components.basemap-control",
    tag: "honua-basemap-control",
    source: "web-components",
    className: "HonuaBasemapControlElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["web-component-controller"],
    events: ["honua-basemap-change"],
    collidesWithIds: [],
  },
  {
    id: "web-components.bookmarks",
    tag: "honua-bookmarks",
    source: "web-components",
    className: "HonuaBookmarksElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["web-component-controller"],
    events: ["honua-bookmark-change", "honua-viewport-change"],
    collidesWithIds: [],
  },
  {
    id: "web-components.locate-control",
    tag: "honua-locate-control",
    source: "web-components",
    className: "HonuaLocateControlElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["web-component-controller"],
    events: ["honua-locate-change", "honua-viewport-change"],
    collidesWithIds: [],
  },
  {
    id: "web-components.measure-control",
    tag: "honua-measure-control",
    source: "web-components",
    className: "HonuaMeasureControlElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["web-component-controller", "measurement-geometry-provider"],
    events: ["honua-measure-change"],
    collidesWithIds: [],
  },
  {
    id: "web-components.measurement",
    tag: "honua-measurement",
    source: "web-components",
    className: "HonuaMeasurementElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: [],
    events: ["honua-measure-change"],
    collidesWithIds: [],
  },
  {
    id: "web-components.time-slider",
    tag: "honua-time-slider",
    source: "web-components",
    className: "HonuaTimeSliderElement",
    supportTier: "survival-tier",
    canonical: true,
    // The temporal playback controller (`createTemporalPlayback`, issue #497)
    // is the required adapter: the element is a view over it and renders an
    // honest degraded panel until one is bound.
    requiredAdapters: ["temporal-playback-controller"],
    events: ["honua-time-change", "honua-time-playback-change"],
    collidesWithIds: [],
  },
  {
    id: "web-components.sketch-control",
    tag: "honua-sketch-control",
    source: "web-components",
    className: "HonuaSketchControlElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["web-component-controller", "sketch-geometry-provider"],
    events: ["honua-sketch-change"],
    collidesWithIds: [],
  },
  {
    id: "web-components.print-export",
    tag: "honua-print-export",
    source: "web-components",
    className: "HonuaPrintExportElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["web-component-controller"],
    events: ["honua-export"],
    collidesWithIds: [],
  },
  {
    id: "web-components.map-status",
    tag: "honua-map-status",
    source: "web-components",
    className: "HonuaMapStatusElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["web-component-controller"],
    events: ["honua-fullscreen-change"],
    collidesWithIds: [],
  },
  {
    id: "web-components.action-panel",
    tag: "honua-action-panel",
    source: "web-components",
    className: "HonuaActionPanelElement",
    supportTier: "survival-tier",
    canonical: true,
    requiredAdapters: ["web-component-controller"],
    events: ["honua-action"],
    collidesWithIds: [],
  },
];

/** Looks up one catalog entry by its stable id. */
export function getComponentCatalogEntry(id: string): HonuaComponentCatalogEntry | undefined {
  return HONUA_COMPONENT_CATALOG.find((entry) => entry.id === id);
}

/** All catalog entries, optionally filtered by kit. */
export function listComponentCatalogEntries(source?: HonuaComponentSource): readonly HonuaComponentCatalogEntry[] {
  if (!source) return HONUA_COMPONENT_CATALOG;
  return HONUA_COMPONENT_CATALOG.filter((entry) => entry.source === source);
}

/** Every entry that registers `tag` (one entry unless the tag is contested). */
export function getComponentCatalogEntriesForTag(tag: string): readonly HonuaComponentCatalogEntry[] {
  return HONUA_COMPONENT_CATALOG.filter((entry) => entry.tag === tag);
}

/** The single canonical/default entry for `tag`, or `undefined` for an unknown tag. */
export function getCanonicalComponentCatalogEntry(tag: string): HonuaComponentCatalogEntry | undefined {
  return HONUA_COMPONENT_CATALOG.find((entry) => entry.tag === tag && entry.canonical);
}

// ── migration diagnostics ────────────────────────────────────────────────

/** A deprecated import/registration path and its canonical replacement. */
export interface HonuaDeprecatedComponentDiagnostic {
  /** The deprecated specifier: an `@honua/sdk-js` subpath or a catalog id. */
  readonly specifier: string;
  /** The canonical replacement a consumer should migrate to. */
  readonly canonicalReplacement: string;
  /** SDK version the specifier is removed in, when it is a subpath-level deprecation. */
  readonly removedIn?: string;
  /** Human-readable migration guidance. */
  readonly note: string;
}

const DEPRECATED_COMPONENT_ALIASES: readonly HonuaDeprecatedComponentDiagnostic[] = [
  {
    specifier: "@honua/sdk-js/controls",
    canonicalReplacement: "@honua/app-platform/controls",
    removedIn: "0.2.0",
    note: "Moved to @honua/app-platform/controls per docs/decisions/scope-split-and-1.0.md. The @honua/sdk-js/controls re-export is retained through the 0.1.x line and removed in 0.2.0.",
  },
  {
    specifier: "@honua/sdk-js/web-components",
    canonicalReplacement: "@honua/app-platform/web-components",
    removedIn: "0.2.0",
    note: "Moved to @honua/app-platform/web-components per docs/decisions/scope-split-and-1.0.md. The @honua/sdk-js/web-components re-export is retained through the 0.1.x line and removed in 0.2.0.",
  },
  {
    specifier: "controls.legend",
    canonicalReplacement: "web-components.legend",
    note: 'honua-legend\'s canonical/default registrant is the web-components (controller-driven) implementation. The controls (map-style-derive) implementation no longer auto-registers on import — call defineHonuaLegend() explicitly (or registerComponent("controls.legend")) to claim the tag with it instead.',
  },
  {
    specifier: "controls.layer-list",
    canonicalReplacement: "web-components.layer-list",
    note: 'honua-layer-list\'s canonical/default registrant is the web-components (controller-driven) implementation. Call defineHonuaLayerList() explicitly (or registerComponent("controls.layer-list")) to claim the tag with the controls (overlay-definition) implementation instead.',
  },
];

/**
 * Looks up migration guidance for a deprecated `@honua/sdk-js` component
 * subpath (e.g. `"@honua/sdk-js/controls"`) or a contested-tag catalog id
 * (e.g. `"controls.legend"`). Returns `undefined` for specifiers the catalog
 * has no recorded alias for.
 */
export function describeDeprecatedComponentImport(specifier: string): HonuaDeprecatedComponentDiagnostic | undefined {
  return DEPRECATED_COMPONENT_ALIASES.find((alias) => alias.specifier === specifier);
}

/** Every recorded deprecated component import/alias and its canonical replacement. */
export function listDeprecatedComponentImports(): readonly HonuaDeprecatedComponentDiagnostic[] {
  return DEPRECATED_COMPONENT_ALIASES;
}
