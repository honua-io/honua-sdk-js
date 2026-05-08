/**
 * OGC API conformance-class → canonical capability mapping. The
 * conformance class identifiers are intentionally kept *internal* to
 * this module — `negotiateOgcCapabilities` is the only public surface
 * that maps from the server-advertised list onto canonical capability
 * names. Top-level SDK types must not expose conformance-class names
 * (acceptance criterion).
 *
 * @module
 */

import type { Capabilities, Capability, Protocol } from "../contract/types.js";
import { capabilities } from "../contract/types.js";
import type { HonuaOgcConformanceResponse } from "./types.js";

/**
 * Mapping from OGC conformance-class URI segments to one or more
 * canonical capabilities. Stored as substring keys because the server
 * may version the path differently (`features-1`, `features-2`,
 * `features-3`, `features-4` — and OGC has been re-issuing the URIs
 * over time). A substring match against `conformsTo[]` covers both
 * versions.
 */
const FEATURE_CONFORMANCE_MAP: ReadonlyArray<readonly [string, readonly Capability[]]> = [
  ["features-1/1.0/conf/core", ["query", "queryObjectIds"]],
  ["features-1/1.0/conf/oas3", []],
  ["features-1/1.0/conf/oas30", []],
  ["features-1/1.0/conf/geojson", []],
  ["features-1/1.0/conf/html", []],
  ["features-1/1.0/conf/crs", []],
  ["features-3/1.0/conf/filter", ["queryAggregate"]],
  ["features-3/1.0/conf/features-filter", ["queryAggregate"]],
  ["features-3/1.0/conf/queryables", []],
  ["features-3/1.0/conf/cql2-text", []],
  ["features-3/1.0/conf/cql2-json", []],
  ["features-4/1.0/conf/create-replace-delete", ["applyEdits"]],
  ["features-4/1.0/conf/transactions", ["applyEdits"]],
  ["features-2/1.0/conf/sql", ["sql"]],
];

const TILE_CONFORMANCE_MAP: ReadonlyArray<readonly [string, readonly Capability[]]> = [
  ["tiles-1/1.0/conf/core", ["tiles"]],
  ["tiles-1/1.0/conf/tileset", ["tiles"]],
  ["tiles-1/1.0/conf/tilesets-list", ["tiles"]],
  ["tiles-1/1.0/conf/dataset-tilesets", ["tiles"]],
  ["tiles-1/1.0/conf/geodata-tilesets", ["tiles"]],
  ["tiles-1/1.0/conf/geodata-selection", ["tiles"]],
  ["tiles-1/1.0/conf/multi-tile", ["tiles"]],
  ["tiles-1/1.0/conf/oas30", []],
  ["tiles-1/1.0/conf/mvt", ["tiles", "render"]],
  ["tiles-1/1.0/conf/png", ["tiles", "render"]],
  ["tiles-1/1.0/conf/jpeg", ["tiles", "render"]],
];

const MAP_CONFORMANCE_MAP: ReadonlyArray<readonly [string, readonly Capability[]]> = [
  ["maps-1/1.0/conf/core", ["render"]],
  ["maps-1/1.0/conf/dataset-map", ["render"]],
  ["maps-1/1.0/conf/collection-map", ["render"]],
  ["maps-1/1.0/conf/scaling", ["render"]],
  ["maps-1/1.0/conf/spatial-subsetting", ["render"]],
  ["maps-1/1.0/conf/png", ["render"]],
  ["maps-1/1.0/conf/jpeg", ["render"]],
  ["styles-1/1.0/conf/core", ["render"]],
];

const PROCESS_CONFORMANCE_MAP: ReadonlyArray<readonly [string, readonly Capability[]]> = [
  ["processes-1/1.0/conf/core", ["processes"]],
  ["processes-1/1.0/conf/ogc-process-description", ["processes"]],
  ["processes-1/1.0/conf/job-list", ["processes"]],
  ["processes-1/1.0/conf/dismiss", ["processes"]],
  ["processes-1/1.0/conf/callback", ["processes"]],
];

const RECORDS_CONFORMANCE_MAP: ReadonlyArray<readonly [string, readonly Capability[]]> = [
  ["ogcapi-records-1/1.0/conf/records-api", ["query", "queryObjectIds"]],
  ["ogcapi-records-1/1.0/conf/searchable-catalog", ["query", "queryObjectIds"]],
  ["ogcapi-records-1/1.0/conf/record-core-query-parameters", ["query"]],
  ["ogcapi-records-1/1.0/conf/cql-filter", ["query"]],
  ["ogcapi-records-1/1.0/conf/searchable-catalog-filtering", ["query"]],
  ["ogcapi-records-1/1.0/conf/sorting", ["query"]],
  ["ogcapi-records-1/1.0/conf/searchable-catalog/sorting", ["query"]],
  ["ogcapi-records-1/1.0/conf/json", []],
  ["ogcapi-records-1/1.0/conf/html", []],
  ["ogcapi-records-1/1.0/conf/oas30", []],
];

const STAC_CONFORMANCE_MAP: ReadonlyArray<readonly [string, readonly Capability[]]> = [
  ["stac-spec.org", ["query", "queryObjectIds"]],
  ["api.stacspec.org/v1.0.0/core", ["query"]],
  ["api.stacspec.org/v1.0.0/item-search", ["query", "queryObjectIds"]],
  ["api.stacspec.org/v1.0.0/ogcapi-features", ["query", "queryObjectIds"]],
  ["api.stacspec.org/v1.0.0/collections", []],
  // STAC's `filter` extension is CQL2 query-side filtering, not server-side
  // aggregation. The STAC source adapter has no aggregation implementation,
  // so this conformance class must not advertise `queryAggregate`.
  ["api.stacspec.org/v1.0.0/filter", []],
];

const CONFORMANCE_TABLES: Record<OgcConformanceProtocol, ReadonlyArray<readonly [string, readonly Capability[]]>> = {
  "ogc-features": FEATURE_CONFORMANCE_MAP,
  "ogc-tiles": TILE_CONFORMANCE_MAP,
  "ogc-maps": MAP_CONFORMANCE_MAP,
  "ogc-processes": PROCESS_CONFORMANCE_MAP,
  "ogc-records": RECORDS_CONFORMANCE_MAP,
  stac: STAC_CONFORMANCE_MAP,
};

/** Subset of `Protocol` for which OGC-style conformance applies. */
export type OgcConformanceProtocol =
  | Extract<Protocol, "ogc-features" | "ogc-tiles" | "ogc-maps" | "ogc-records" | "stac">
  | "ogc-processes";

/**
 * Translate the server-advertised `conformsTo[]` list into a canonical
 * `Capabilities` set for the given protocol. Conformance class
 * identifiers are matched against substring keys so version drift
 * (`features-1` → `features-3`) does not silently drop capabilities.
 *
 * Callers can intersect the result with their own narrower set when
 * they want to gate optional features even if the server claims them.
 */
export function negotiateOgcCapabilities(
  protocol: OgcConformanceProtocol,
  conformance: HonuaOgcConformanceResponse | { conformsTo?: readonly string[] } | undefined,
): Capabilities {
  const table = CONFORMANCE_TABLES[protocol];
  const advertised = conformance?.conformsTo ?? [];
  const out = new Set<Capability>();
  for (const uri of advertised) {
    if (typeof uri !== "string") continue;
    for (const [needle, caps] of table) {
      if (uri.includes(needle)) {
        for (const cap of caps) out.add(cap);
      }
    }
  }
  return capabilities(Array.from(out));
}

/**
 * `true` when the conformance response advertises a class containing
 * the given substring. Lets callers gate features on a specific
 * extension without exposing the URI as a primary SDK type.
 */
export function hasOgcConformanceClass(
  conformance: HonuaOgcConformanceResponse | { conformsTo?: readonly string[] } | undefined,
  classSubstring: string,
): boolean {
  const advertised = conformance?.conformsTo ?? [];
  for (const uri of advertised) {
    if (typeof uri === "string" && uri.includes(classSubstring)) return true;
  }
  return false;
}
