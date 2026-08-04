import {
  type CodemodConstructorKind,
  SUPPORTED_ARCGIS_MODULE_KIND_BY_PATH,
  isKindSupportedForTarget,
} from "./codemod.js";

export type JsParityCategory = "layer" | "view" | "widget" | "control";
export type JsParityStatus = "native" | "compat" | "assisted" | "unsupported";
export type JsParityMatrixKind = CodemodConstructorKind;

export interface JsParityMatrixEntry {
  kind: JsParityMatrixKind;
  category: JsParityCategory;
  arcGisModule: string;
  honuaCompat: JsParityStatus;
  honuaMapLibre: JsParityStatus;
  esriLeaflet: JsParityStatus;
  notes: string;
}

export interface JsParitySummary {
  honuaCompat: Record<JsParityStatus, number>;
  honuaMapLibre: Record<JsParityStatus, number>;
  esriLeaflet: Record<JsParityStatus, number>;
}

const CONTROL_KINDS = new Set<CodemodConstructorKind>([
  "home-widget",
  "basemap-toggle-widget",
  "locate-widget",
  "scale-bar-widget",
  "compass-widget",
  "fullscreen-widget",
  "zoom-widget",
  "attribution-widget",
]);

const VIEW_KINDS = new Set<CodemodConstructorKind>(["map", "map-view", "scene-view", "web-map"]);

const LAYER_KINDS = new Set<CodemodConstructorKind>([
  "feature-layer",
  "graphics-layer",
  "group-layer",
  "map-image-layer",
  "tile-layer",
  "route-layer",
  "basemap",
  "vector-tile-layer",
  "geojson-layer",
  "wms-layer",
  "wfs-layer",
  "imagery-layer",
]);

const CANONICAL_MODULE_BY_KIND = buildCanonicalModuleMap();

// Per-kind overrides for the Honua MapLibre target. The codemod's
// HONUA_MAPLIBRE_NATIVE_KINDS only enumerates kinds with a deterministic
// native mapping; the entries here narrow the remaining "assisted" default
// for kinds whose verdict is grounded in docs/migration-punch-list.md or
// concrete codemod behavior (rather than guesswork).
// Intentionally empty. The one entry this table ever held ("search-widget":
// "unsupported") was grounded in the absence of a Locator-equivalent backend.
// LocatorCompat / LocatorSearchSourceCompat now supply that backend from the
// provider-pluggable geocoding layer with no server dependency (issue #956), so
// Search falls back to the derived "assisted" verdict like every other
// compat-shim widget. Add an entry here only when a kind's verdict is grounded
// in docs/migration-punch-list.md or concrete codemod behavior.
const HONUA_MAPLIBRE_STATUS_OVERRIDES: Readonly<Partial<Record<CodemodConstructorKind, JsParityStatus>>> =
  Object.freeze({});

const HONUA_MAPLIBRE_NOTE_OVERRIDES: Readonly<Partial<Record<CodemodConstructorKind, string>>> = Object.freeze({
  "layer-list": "LayerListCompat renders through the Honua widget host; MapLibre apps must wire it manually.",
  "legend-widget": "LegendCompat renders through the Honua widget host; MapLibre apps must wire it manually.",
  "popup-widget":
    "PopupCompat covers the simple template case; Arcade expressions and arrow-function fieldInfos.format fall through to manual TODO.",
  "search-widget":
    "SearchCompat searches view layers out of the box; address search wires LocatorCompat.toSearchSource() (or LocatorSearchSourceCompat) into `sources`. The geocoding provider is caller-configured (Nominatim/Photon/Pelias/Honua) — the codemod cannot pick one, so the source wiring stays assisted.",
  locator:
    "LocatorCompat maps addressToLocations/addressesToLocations/locationToAddress/suggestLocations onto the provider-pluggable geocoding contract with no server dependency. `new Locator({ url })` rewrites deterministically; the caller must attach a geocoding provider, and rest/locator function imports keep a TODO for the URL-to-provider swap. Provider capability misses (suggest on Nominatim) throw HonuaCapabilityNotSupportedError rather than being faked.",
  "locator-search-source":
    "LocatorSearchSourceCompat is the Search widget's geocoding backend; it omits its `suggest` hook entirely when the configured provider does not declare the suggest capability.",
  "feature-table-widget":
    "FeatureTableCompat renders through the Honua widget host; MapLibre apps must wire layout/columns manually.",
  "web-map":
    "Static WebMap JSON literals are auto-rewritten to webmapJsonToMapLibreStyle({...}); dynamic / portal-loaded WebMaps still fall through to manual TODO.",
  "geometry-engine":
    "geometryEngine imports rewrite to the geometryEngineCompat shim (@honua/geometry); covered ops (buffer/intersect/union/difference/area/length/simplify/convexHull/contains/intersects) migrate cleanly, uncovered ops (geodesic densify, offset, cut, …) keep a manual TODO.",
  "sketch-widget":
    "SketchCompat maps snappingOptions (enabled/distance/featureSources) onto the contract SnappingConfig; wire bindEditSketchSnapping from @honua/sdk-js/runtime for vertex/edge/feature snapping with MapLibre indicators.",
  "editor-widget":
    "EditorCompat maps snappingOptions onto the contract SnappingConfig shared with the edit-sketch snapping engine (vertex/edge/feature candidates, pixel tolerance, per-source enablement).",
});

const BASE_MATRIX_ROWS: JsParityMatrixEntry[] = (Object.keys(CANONICAL_MODULE_BY_KIND) as CodemodConstructorKind[])
  .sort()
  .map((kind) => {
    const honuaCompat: JsParityStatus = isKindSupportedForTarget(kind, "honua-compat") ? "compat" : "unsupported";
    const honuaMapLibre: JsParityStatus =
      HONUA_MAPLIBRE_STATUS_OVERRIDES[kind] ??
      (isKindSupportedForTarget(kind, "honua-maplibre") ? "native" : "assisted");
    const esriLeaflet: JsParityStatus = isKindSupportedForTarget(kind, "esri-leaflet") ? "compat" : "assisted";
    return {
      kind,
      category: classifyCategory(kind),
      arcGisModule: CANONICAL_MODULE_BY_KIND[kind],
      honuaCompat,
      honuaMapLibre,
      esriLeaflet,
      notes:
        HONUA_MAPLIBRE_NOTE_OVERRIDES[kind] ??
        (honuaMapLibre === "native"
          ? "Honua MapLibre target emits native helper mappings"
          : "assisted migration with TODO/report gating"),
    };
  });

export const JS_PARITY_MATRIX: readonly JsParityMatrixEntry[] = Object.freeze([...BASE_MATRIX_ROWS]);

export function getJsParityMatrix(): readonly JsParityMatrixEntry[] {
  return JS_PARITY_MATRIX;
}

export function summarizeJsParityMatrix(matrix: readonly JsParityMatrixEntry[] = JS_PARITY_MATRIX): JsParitySummary {
  const summary: JsParitySummary = {
    honuaCompat: {
      native: 0,
      compat: 0,
      assisted: 0,
      unsupported: 0,
    },
    honuaMapLibre: {
      native: 0,
      compat: 0,
      assisted: 0,
      unsupported: 0,
    },
    esriLeaflet: {
      native: 0,
      compat: 0,
      assisted: 0,
      unsupported: 0,
    },
  };

  for (const row of matrix) {
    summary.honuaCompat[row.honuaCompat] += 1;
    summary.honuaMapLibre[row.honuaMapLibre] += 1;
    summary.esriLeaflet[row.esriLeaflet] += 1;
  }

  return summary;
}

function buildCanonicalModuleMap(): Record<CodemodConstructorKind, string> {
  const result = {} as Record<CodemodConstructorKind, string>;

  for (const [modulePath, kind] of Object.entries(SUPPORTED_ARCGIS_MODULE_KIND_BY_PATH)) {
    if (modulePath.endsWith(".js")) {
      continue;
    }
    if (result[kind] === undefined) {
      result[kind] = modulePath;
    }
  }

  return result;
}

function classifyCategory(kind: CodemodConstructorKind): JsParityCategory {
  if (LAYER_KINDS.has(kind)) {
    return "layer";
  }
  if (VIEW_KINDS.has(kind)) {
    return "view";
  }
  if (CONTROL_KINDS.has(kind)) {
    return "control";
  }
  return "widget";
}
