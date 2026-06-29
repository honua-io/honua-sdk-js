/**
 * WMS 1.3.0 axis-order helpers, shared by the first-party WMS client path and
 * the Esri-compat `WMSLayer` so both emit BBOX in the authority-defined axis
 * order.
 *
 * Under WMS 1.3.0 the authority-defined axis order for geographic EPSG codes
 * (EPSG:4326 and friends) is latitude,longitude, so the canonical
 * `[minx, miny, maxx, maxy]` tuple must be transposed to
 * `[miny, minx, maxy, maxx]` on the wire. WMS 1.1.1 (`SRS`) always uses
 * lon,lat and must not be transposed.
 */

/**
 * Geographic EPSG codes whose WMS 1.3.0 axis order is latitude,longitude.
 *
 * Matching only the exact string `"EPSG:4326"` would leave other authority
 * lat/lon CRSes (notably ETRS89 / EPSG:4258 and NAD83 / EPSG:4269) — and even
 * the URN / URL spellings of 4326 itself — transposed incorrectly. The axis
 * order is derived from the CRS authority code instead.
 */
export const WMS_LATLON_GEOGRAPHIC_EPSG: ReadonlySet<number> = new Set([
  4326, // WGS 84
  4258, // ETRS89
  4269, // NAD83
  4267, // NAD27
  4203, // AGD66
  4283, // GDA94
  7844, // GDA2020
  4490, // China Geodetic Coordinate System 2000
  4214, // Beijing 1954
  4152, // NAD83(HARN)
  4759, // NAD83(NSRS2007)
  4617, // NAD83(CSRS)
  4674, // SIRGAS 2000
  4618, // SAD69
  4612, // JGD2000
  4019, // GRS 1980 ensemble
]);

/**
 * Extract the trailing EPSG numeric code from any of the CRS spellings WMS
 * clients use: `EPSG:4326`, `urn:ogc:def:crs:EPSG::4326`,
 * `urn:ogc:def:crs:EPSG:8.9:4326`, and `http://www.opengis.net/def/crs/EPSG/0/4326`.
 * Returns `undefined` for non-EPSG identifiers (e.g. `CRS:84`, OGC URNs).
 */
export function parseEpsgCode(crs: string): number | undefined {
  const upper = crs.toUpperCase();
  const idx = upper.lastIndexOf("EPSG");
  if (idx < 0) return undefined;
  const digitGroups = crs.slice(idx).match(/\d+/g);
  if (!digitGroups || digitGroups.length === 0) return undefined;
  // The authority code is the last numeric group (URN forms embed a version
  // number such as `8.9` between the authority and the code).
  const code = Number(digitGroups[digitGroups.length - 1]);
  return Number.isInteger(code) ? code : undefined;
}

/** Whether a WMS 1.3.0 BBOX for `crs` must be transposed to lat,lon on the wire. */
export function wmsBboxRequiresAxisSwap(crs: string): boolean {
  const code = parseEpsgCode(crs);
  return code !== undefined && WMS_LATLON_GEOGRAPHIC_EPSG.has(code);
}

/**
 * Order a canonical `[minx, miny, maxx, maxy]` BBOX for the wire under the given
 * WMS `version` and `crs`. Only WMS 1.3.0 with a lat/lon geographic CRS is
 * transposed; all other combinations keep lon,lat order.
 */
export function orderWmsBbox(
  bbox: readonly [number, number, number, number],
  version: string,
  crs: string,
): [number, number, number, number] {
  const [minx, miny, maxx, maxy] = bbox;
  if (version === "1.3.0" && wmsBboxRequiresAxisSwap(crs)) {
    return [miny, minx, maxy, maxx];
  }
  return [minx, miny, maxx, maxy];
}
