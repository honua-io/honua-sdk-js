/**
 * `@honua/sdk-js/runtime` — MapLibre GL JS-first runtime for Honua
 * `MapPackage`. Consumes a server-produced `MapPackage` and binds it to
 * a caller-provided `MaplibreMap` instance.
 *
 * @example
 * ```ts
 * import { HonuaClient } from "@honua/sdk-js";
 * import { loadMapPackage } from "@honua/sdk-js/runtime";
 * import maplibregl from "maplibre-gl";
 *
 * const map = new maplibregl.Map({ container: "map" });
 * const runtime = await loadMapPackage(pkg, map, {
 *   client: new HonuaClient({ baseUrl: "https://honua.example.com" }),
 *   popupFactory: () => new maplibregl.Popup(),
 * });
 * runtime.setLayerVisibility("parcels-fill", false);
 * await runtime.updatePackage(nextPkg);
 * ```
 *
 * @module
 */

export { loadMapPackage } from "./load-package.js";
export type { LoadMapPackageOptions } from "./load-package.js";

export { HonuaMapRuntime } from "./runtime.js";
export type {
  HonuaMapRuntimeInternals,
  HonuaRuntimeEvent,
  HonuaRuntimeEventListener,
  HonuaRuntimeTelemetry,
  HonuaRuntimeTelemetrySpan,
  HonuaRuntimeTelemetrySpanResult,
  MaplibreMap,
  SetViewStateInput,
} from "./runtime.js";

export { HONUA_MAP_PACKAGE_FORMAT_V1 } from "./map-package.js";
export type {
  HonuaMapPackage,
  HonuaMapPackageFormat,
  HonuaMapPackageInitialView,
  HonuaMapPackageLabelBinding,
  HonuaMapPackageLegendEntry,
  HonuaMapPackageLocator,
  HonuaMapPackagePopupBinding,
  HonuaMapPackageProtocol,
  HonuaMapPackageSourceBinding,
  HonuaMapPackageStatus,
  HonuaMapPackageStyleRef,
  HonuaMapPackageThemeSpec,
  HonuaStyleRefBody,
  HonuaStyleRefLayerOverride,
} from "./map-package.js";

export { HonuaMapPackageError } from "./errors.js";
export type { HonuaMapPackageErrorStage } from "./errors.js";

export { buildLegend } from "./legend.js";
export type { LegendEntry } from "./legend.js";

export { bindPopup, defaultPopupRenderer } from "./popups.js";
export type {
  BindPopupOptions,
  PopupBindingHandle,
  PopupFactory,
  PopupFeature,
  PopupHandle,
  PopupRenderContext,
  PopupRenderer,
} from "./popups.js";

export { applyStyleRefs, applyTheme, composeStyle } from "./style-compose.js";
export type { StyleComposeOptions, StyleRefResolver, ThemeResolver } from "./style-compose.js";

export { projectSourceBindings, toHonuaSourceSpec } from "./source-bridge.js";
export type { NativeMapLibreSourceEntry, SourceBridgeProjection } from "./source-bridge.js";

export { diffPackages } from "./diff.js";
export type { MapPackageDiff } from "./diff.js";
