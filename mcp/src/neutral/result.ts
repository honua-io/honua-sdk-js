import type { DegradedReason, Result } from "@honua/sdk-js/contract";
import { esriToGeoJson } from "@honua/sdk-js/geometry";

/**
 * PROTOCOL-NEUTRAL result projection (#1005).
 *
 * A `Result` carries whatever geometry encoding its protocol produced —
 * Esri-JSON from GeoServices, GeoJSON from OGC API Features / STAC. Returning
 * that raw makes the tool output protocol-dependent, so the neutral contract
 * normalizes to GeoJSON and says which encoding it used.
 *
 * `Result.degraded` is surfaced verbatim: when a protocol served a request a
 * different way than asked (client-side aggregation on OGC, for example), the
 * answer says so instead of quietly presenting a weaker number as authoritative.
 */

export type GeometryFormat = "geojson" | "esri-json";

function looksGeoJson(geometry: Record<string, unknown>): boolean {
  return typeof geometry.type === "string" && "coordinates" in geometry;
}

/** Re-encode one feature geometry into the requested format. */
export function projectGeometry(
  geometry: Record<string, unknown> | null | undefined,
  format: GeometryFormat,
): Record<string, unknown> | null {
  if (!geometry) return null;
  if (format === "esri-json") return geometry;
  if (looksGeoJson(geometry)) return geometry;
  const converted = esriToGeoJson(geometry);
  return converted ? (converted as unknown as Record<string, unknown>) : null;
}

/** Normalize `Result.degraded` for tool output; `undefined` when nothing degraded. */
export function projectDegraded(degraded: readonly DegradedReason[] | undefined) {
  if (!degraded || degraded.length === 0) return undefined;
  return degraded.map((reason) => ({
    capability: reason.capability,
    reason: reason.reason,
    protocol: reason.protocol ?? null,
    sourceId: reason.sourceId ?? null,
  }));
}

export interface ProjectFeaturesOptions {
  readonly returnGeometry: boolean;
  readonly geometryFormat: GeometryFormat;
}

/** Project canonical features onto the tool's neutral feature shape. */
export function projectFeatures(result: Result, options: ProjectFeaturesOptions) {
  return result.features.map((feature) => {
    const geometry = options.returnGeometry
      ? projectGeometry(feature.geometry as Record<string, unknown> | null | undefined, options.geometryFormat)
      : null;
    return {
      attributes: feature.attributes,
      ...(geometry ? { geometry } : {}),
    };
  });
}
