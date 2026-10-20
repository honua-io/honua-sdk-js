import { HonuaGeometryError } from "./errors.js";

/** GeoServices query geometry defaults to WGS84, never the target layer CRS. */
export function geometryInputSpatialReference(geometry: unknown): string | number {
  if (typeof geometry === "string") {
    try {
      geometry = JSON.parse(geometry);
    } catch {
      // GeoServices also accepts comma-separated coordinate strings.
      return 4326;
    }
  }
  if (typeof geometry !== "object" || geometry === null || !("spatialReference" in geometry)) return 4326;
  const sr = geometry.spatialReference;
  if (typeof sr === "object" && sr !== null) {
    if ("wkt" in sr && typeof sr.wkt === "string" && sr.wkt.trim()) return JSON.stringify(sr);
    if ("latestWkid" in sr && typeof sr.latestWkid === "number" && Number.isInteger(sr.latestWkid) && sr.latestWkid > 0)
      return sr.latestWkid;
    if ("wkid" in sr && typeof sr.wkid === "number" && Number.isInteger(sr.wkid) && sr.wkid > 0) return sr.wkid;
  }
  throw new HonuaGeometryError("malformed-geometry", "Query geometry has an invalid spatialReference", {
    operation: "query-input-spatial-reference",
    reason: "invalid-spatial-reference",
  });
}
