/**
 * ArcGIS JS module specifier shapes the migration tooling understands.
 *
 * The same ArcGIS modules are addressed by three specifier families:
 *
 * - `@arcgis/core/<path>` — the npm package (4.x ES modules).
 * - `esri/<path>` — the bare AMD/Dojo module id. This is what the CDN build,
 *   the Dojo loader, `arcgis-webpack-plugin`, and the `@types/arcgis-js-api`
 *   typings all expect, so it is the normal shape for every ArcGIS JS 3.x app
 *   and a large share of 4.x apps.
 * - `esri` — the 3.x typings root module (`import { AGSMouseEvent } from "esri"`).
 *
 * `esri-leaflet` (and any other package whose name merely starts with `esri`)
 * is a different product and is deliberately not matched here — the scanner
 * classifies it separately.
 */
export const ARCGIS_MODULE_PREFIX = "@arcgis/core/";
export const ARCGIS_LEGACY_MODULE_PREFIX = "esri/";
export const ARCGIS_LEGACY_MODULE_ROOT = "esri";

/** True when `modulePath` addresses an ArcGIS JS module in any supported specifier family. */
export function isArcGisModuleSpecifier(modulePath: string): boolean {
  if (modulePath.startsWith(ARCGIS_MODULE_PREFIX)) {
    return modulePath.length > ARCGIS_MODULE_PREFIX.length;
  }
  if (modulePath === ARCGIS_LEGACY_MODULE_ROOT) {
    return true;
  }
  return modulePath.startsWith(ARCGIS_LEGACY_MODULE_PREFIX) && modulePath.length > ARCGIS_LEGACY_MODULE_PREFIX.length;
}

/** True when `modulePath` is a bare `esri/*` (or `esri`) legacy specifier. */
export function isLegacyArcGisModuleSpecifier(modulePath: string): boolean {
  return (
    modulePath === ARCGIS_LEGACY_MODULE_ROOT ||
    (modulePath.startsWith(ARCGIS_LEGACY_MODULE_PREFIX) && modulePath.length > ARCGIS_LEGACY_MODULE_PREFIX.length)
  );
}

/**
 * Canonical `@arcgis/core/...` form of an ArcGIS module specifier: the `.js`
 * extension is dropped and a bare `esri/...` id is mapped onto its
 * `@arcgis/core/...` equivalent.
 *
 * This is what keeps a single module-to-kind table honest: `esri/WebMap` and
 * `@arcgis/core/WebMap` resolve to the same `CodemodConstructorKind` without a
 * second hand-maintained copy of the table. Paths that do not correspond (the
 * 3.x-only `esri/map`, `esri/tasks/query`, `esri/dijit/*`) simply canonicalize
 * to a path no table entry claims, so they stay reported as unhandled modules
 * instead of being silently mapped onto a 4.x construct they are not.
 *
 * Non-ArcGIS specifiers are returned unchanged apart from the `.js` trim.
 */
export function canonicalArcGisModulePath(modulePath: string): string {
  const withoutExtension = modulePath.endsWith(".js") ? modulePath.slice(0, -3) : modulePath;
  if (withoutExtension === ARCGIS_LEGACY_MODULE_ROOT) {
    return "@arcgis/core";
  }
  if (withoutExtension.startsWith(ARCGIS_LEGACY_MODULE_PREFIX)) {
    return `${ARCGIS_MODULE_PREFIX}${withoutExtension.slice(ARCGIS_LEGACY_MODULE_PREFIX.length)}`;
  }
  return withoutExtension;
}
