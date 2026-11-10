import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import type { GeoJsonMultiPolygon, GeoJsonPolygon } from "../expr/expression.js";
import type { RouteWaypoint, RoutingProvenance, RoutingProvider } from "./provider.js";

/** Travel-time contours from one WGS84 origin. @experimental */
export interface IsochroneRequest {
  readonly origin: RouteWaypoint;
  /** One to four distinct positive travel-time thresholds, in minutes. */
  readonly minutes: readonly number[];
  /** Defaults to the provider's configured costing mode. */
  readonly travelMode?: "auto" | "bicycle" | "pedestrian";
  readonly signal?: AbortSignal;
}

/** One provider-computed WGS84 travel-time polygon. @experimental */
export interface IsochroneContour {
  readonly minutes: number;
  readonly geometry: GeoJsonPolygon | GeoJsonMultiPolygon;
}

/** Provider attribution applies to every returned contour. @experimental */
export interface ProviderIsochroneResult {
  readonly contours: readonly IsochroneContour[];
  readonly provenance: RoutingProvenance;
}

/** A routing provider that also exposes travel-time polygons. @experimental */
export interface IsochroneRoutingProvider extends RoutingProvider {
  isochrone(request: IsochroneRequest): Promise<ProviderIsochroneResult>;
}

/** Reject route-only providers before any network request. @experimental */
export async function requestIsochrone(
  provider: RoutingProvider,
  request: IsochroneRequest,
): Promise<ProviderIsochroneResult> {
  if (!provider.capabilities.includes("isochrone") || !provider.isochrone) {
    throw new HonuaCapabilityNotSupportedError("isochrone", provider.id);
  }
  return provider.isochrone(request);
}

/** @internal */
export function assertIsochroneRequest(request: IsochroneRequest): void {
  const { longitude, latitude } = request.origin;
  if (
    !Number.isFinite(longitude) ||
    Math.abs(longitude) > 180 ||
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > 90
  ) {
    throw new Error("Isochrone origin must be a finite WGS84 longitude/latitude.");
  }
  if (
    request.minutes.length < 1 ||
    request.minutes.length > 4 ||
    new Set(request.minutes).size !== request.minutes.length ||
    request.minutes.some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    throw new Error("Isochrone minutes must contain one to four distinct positive finite thresholds.");
  }
  if (request.travelMode !== undefined && !["auto", "bicycle", "pedestrian"].includes(request.travelMode)) {
    throw new Error("Unsupported isochrone travelMode.");
  }
}
