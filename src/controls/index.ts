/**
 * Native Honua UI control kit (`@honua/sdk-js/controls`) — optional,
 * framework-free custom elements for apps built on the native lane
 * (HonuaClient + MapLibre). Tracked by issue #274; the basemap switcher is
 * the first control, with a layer list and legend to follow.
 *
 * This entry is intentionally independent of the SDK core bundle (the same
 * posture as `@honua/sdk-js/esri-compat`): it imports nothing from
 * `src/core`/`src/runtime` and has no dependency on `maplibre-gl` — controls
 * drive any MapLibre `Map` through a duck-typed interface.
 *
 * Importing this module registers the shipped custom elements when a browser
 * `customElements` registry is present. Node imports are safe; call
 * `defineHonuaControls()` explicitly when using a scoped registry.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver
 *   contract — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

import "./basemap-switcher.js";

export { HonuaBasemapStyleBinding } from "./basemap-style-binding.js";
export { HonuaBasemapSwitcherElement, defineHonuaControls } from "./basemap-switcher.js";
export type {
  HonuaBasemapDefinition,
  HonuaBasemapKind,
  HonuaBasemapLayerSpecification,
  HonuaBasemapSwitcherChangeDetail,
  HonuaBasemapSwitcherMap,
} from "./types.js";
