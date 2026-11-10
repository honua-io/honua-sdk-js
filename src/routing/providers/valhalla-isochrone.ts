import { HonuaHttpError } from "../../core/errors.js";
import { type ProviderTransportOptions, providerGetJson } from "../../geocoding/provider-http.js";
import {
  type IsochroneContour,
  type IsochroneRequest,
  type ProviderIsochroneResult,
  assertIsochroneRequest,
} from "../isochrone.js";
import type { RoutingProvenance } from "../provider.js";

interface IsochroneContext {
  readonly baseUrl: string;
  readonly costing: string;
  readonly provenance: RoutingProvenance;
  readonly transport: ProviderTransportOptions;
}

/** @internal */
export async function valhallaIsochrone(
  context: IsochroneContext,
  request: IsochroneRequest,
): Promise<ProviderIsochroneResult> {
  assertIsochroneRequest(request);
  const payload = {
    locations: [{ lat: request.origin.latitude, lon: request.origin.longitude }],
    costing: request.travelMode ?? context.costing,
    contours: [...request.minutes].sort((a, b) => a - b).map((time) => ({ time })),
    polygons: true,
  };
  const data = await providerGetJson<unknown>(
    `${context.baseUrl}/isochrone?json=${encodeURIComponent(JSON.stringify(payload))}`,
    {
      ...context.transport,
      signal: request.signal,
      label: "valhalla isochrone",
    },
  );
  return { contours: normalizeContours(data, request), provenance: context.provenance };
}

function normalizeContours(data: unknown, request: IsochroneRequest): IsochroneContour[] {
  if (
    !isRecord(data) ||
    data.type !== "FeatureCollection" ||
    !Array.isArray(data.features) ||
    data.features.length > 4
  ) {
    throw invalidResponse(data);
  }
  const contours = data.features.map((feature: unknown): IsochroneContour => {
    if (
      !isRecord(feature) ||
      feature.type !== "Feature" ||
      !isRecord(feature.properties) ||
      feature.properties.metric !== "time" ||
      !request.minutes.includes(feature.properties.contour as number) ||
      !validGeometry(feature.geometry)
    )
      throw invalidResponse(data);
    return { minutes: feature.properties.contour as number, geometry: feature.geometry };
  });
  const returned = new Set(contours.map((contour) => contour.minutes));
  if (returned.size !== request.minutes.length || contours.length !== returned.size) throw invalidResponse(data);
  return contours.sort((a, b) => a.minutes - b.minutes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validGeometry(value: unknown): value is IsochroneContour["geometry"] {
  if (!isRecord(value) || !Array.isArray(value.coordinates)) return false;
  const polygons =
    value.type === "Polygon" ? [value.coordinates] : value.type === "MultiPolygon" ? value.coordinates : [];
  return (
    polygons.length > 0 &&
    polygons.every((polygon: unknown) => Array.isArray(polygon) && polygon.length > 0 && polygon.every(validRing))
  );
}

function validRing(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 4) return false;
  if (
    !value.every(
      (position: unknown) =>
        Array.isArray(position) &&
        position.length === 2 &&
        Number.isFinite(position[0]) &&
        Math.abs(position[0]) <= 180 &&
        Number.isFinite(position[1]) &&
        Math.abs(position[1]) <= 90,
    )
  )
    return false;
  const first = value[0];
  const last = value[value.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

function invalidResponse(data: unknown): HonuaHttpError {
  return new HonuaHttpError(
    200,
    "Valhalla isochrone response must contain each requested time contour as a valid WGS84 polygon.",
    data,
  );
}
