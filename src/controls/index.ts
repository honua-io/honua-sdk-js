/**
 * Native Honua UI control kit (`@honua/sdk-js/controls`) — optional,
 * framework-free custom elements for apps built on the native lane
 * (HonuaClient + MapLibre). Tracked by issue #274; ships the basemap
 * switcher, the legend, the layer list, and the swipe control.
 *
 * This entry is intentionally independent of the SDK core bundle (the same
 * posture as `@honua/sdk-js/esri-compat`): it imports nothing from
 * `src/core`/`src/runtime` and has no dependency on `maplibre-gl` — controls
 * drive any MapLibre `Map` through a duck-typed interface.
 *
 * Importing this module registers the basemap switcher and the swipe control
 * when a browser `customElements` registry is present. Node imports are
 * safe; call `defineHonuaControls()` explicitly when using a scoped registry.
 * The legend and the layer list are opt-in via {@link defineHonuaLegend} /
 * {@link defineHonuaLayerList} — both tags also have a controller-driven
 * implementation in `@honua/sdk-js/web-components`, which is each tag's
 * canonical/default registrant (see `./catalog.js`). Issue #679 consolidated
 * component ownership so importing any combination of `./controls` and
 * `./web-components`, in any order, always registers the same tags with the
 * same constructors — claiming a controls-kit implementation for a contested
 * tag is now always an explicit call, never an import-order accident.
 *
 * `./catalog.js` and `./registry.js` (re-exported below) are the
 * consolidated component catalog and typed registration surface spanning
 * both kits: `HONUA_COMPONENT_CATALOG` describes every shipped tag's
 * ownership, support tier, required adapters, and events, and
 * `registerComponent` / `registerComponents` / `registerAllComponents` /
 * `createComponentRegistry` register by catalog id — individually, as a
 * named subset, as the full canonical set, or against an isolated registry —
 * regardless of which subpath (`./controls` or `./web-components`) a caller
 * imports them from.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver
 *   contract — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

import "./basemap-switcher.js";
import "./swipe-control.js";

export { HonuaBasemapStyleBinding } from "./basemap-style-binding.js";
export { HonuaBasemapSwitcherElement, defineHonuaBasemapSwitcher, defineHonuaControls } from "./basemap-switcher.js";
export {
  HONUA_COMPONENT_CATALOG,
  describeDeprecatedComponentImport,
  getCanonicalComponentCatalogEntry,
  getComponentCatalogEntriesForTag,
  getComponentCatalogEntry,
  listComponentCatalogEntries,
  listDeprecatedComponentImports,
} from "./catalog.js";
export type {
  HonuaComponentCatalogEntry,
  HonuaComponentSource,
  HonuaComponentSupportTier,
  HonuaDeprecatedComponentDiagnostic,
} from "./catalog.js";
export { HonuaLayerListElement, defineHonuaLayerList } from "./layer-list.js";
export { HonuaLegendDeriveError, deriveLegendEntries } from "./legend-derive.js";
export type { HonuaLegendDeriveErrorCode } from "./legend-derive.js";
export { HonuaLegendElement, defineHonuaLegend } from "./legend.js";
export {
  HONUA_COMPONENT_QUALIFICATION_DATA_VERSION,
  HONUA_COMPONENT_QUALIFICATION_GATES,
  HONUA_COMPONENT_QUALIFICATION_STATUSES,
  describeComponentQualificationGate,
  getComponentQualification,
  isComponentProductionQualified,
  listComponentQualifications,
  summarizeComponentQualification,
} from "./qualification.js";
export type {
  HonuaComponentQualification,
  HonuaComponentQualificationCell,
  HonuaComponentQualificationGate,
  HonuaComponentQualificationGateId,
  HonuaComponentQualificationRequirement,
  HonuaComponentQualificationStatus,
  HonuaComponentQualificationSummary,
} from "./qualification.js";
export {
  HonuaComponentCatalogError,
  createComponentRegistry,
  registerAllComponents,
  registerComponent,
  registerComponents,
} from "./registry.js";
export type {
  HonuaComponentCatalogId,
  HonuaComponentRegistrationOptions,
  HonuaComponentRegistry,
} from "./registry.js";
export { HonuaSwipeControlElement, defineHonuaSwipeControl } from "./swipe-control.js";
export type {
  HonuaBasemapDefinition,
  HonuaBasemapKind,
  HonuaBasemapLayerSpecification,
  HonuaBasemapSwitcherChangeDetail,
  HonuaBasemapSwitcherMap,
  HonuaLayerListChangeDetail,
  HonuaLayerListMap,
  HonuaLayerListOverlay,
  HonuaLegendEntry,
  HonuaLegendMap,
  HonuaLegendSection,
  HonuaLegendSwatchColor,
  HonuaLegendSwatchShape,
  HonuaSwipeChangeDetail,
  HonuaSwipeMap,
  HonuaSwipeOrientation,
} from "./types.js";
