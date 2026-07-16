/** Shared canonical GeoServices service endpoint classification. */

import { HonuaDiscoveryError } from "./core/errors.js";

/** GeoServices service kinds supported by the discovery facade. */
export type GeoServicesServiceKind = "feature" | "map" | "image" | "geometry" | "geoprocessing";

/** Protocol identifiers corresponding to discoverable GeoServices service roots. */
export type GeoServicesServiceProtocol =
  | "geoservices-feature-service"
  | "geoservices-map-service"
  | "geoservices-image-service"
  | "geoservices-geometry-service"
  | "geoservices-gp-service";

/** A credential-free, canonical GeoServices service or selected-resource URL. */
export interface NormalizedGeoServicesEndpoint {
  /** Normalized input URL, including a selected layer/task when present. */
  readonly endpoint: string;
  /** Smallest SDK client root, immediately before `/rest/services`. */
  readonly clientBaseUrl: string;
  /** Canonical service URL without a selected layer/task segment. */
  readonly serviceUrl: string;
  /** Decoded folder-qualified service identifier. */
  readonly serviceId: string;
  readonly serviceKind: GeoServicesServiceKind;
  readonly protocol: GeoServicesServiceProtocol;
  /** Selected FeatureServer, MapServer, or ImageServer numeric layer/catalog id. */
  readonly layerId?: number;
  /** Selected GPServer task name. */
  readonly taskName?: string;
}

interface ServiceTypeDefinition {
  readonly path: "FeatureServer" | "MapServer" | "ImageServer" | "GeometryServer" | "GPServer";
  readonly serviceKind: GeoServicesServiceKind;
  readonly protocol: GeoServicesServiceProtocol;
  readonly resource: "layer" | "none" | "task";
}

const SERVICE_TYPES: Readonly<Record<string, ServiceTypeDefinition>> = Object.freeze({
  featureserver: Object.freeze({
    path: "FeatureServer",
    serviceKind: "feature",
    protocol: "geoservices-feature-service",
    resource: "layer",
  }),
  mapserver: Object.freeze({
    path: "MapServer",
    serviceKind: "map",
    protocol: "geoservices-map-service",
    resource: "layer",
  }),
  imageserver: Object.freeze({
    path: "ImageServer",
    serviceKind: "image",
    protocol: "geoservices-image-service",
    resource: "layer",
  }),
  geometryserver: Object.freeze({
    path: "GeometryServer",
    serviceKind: "geometry",
    protocol: "geoservices-geometry-service",
    resource: "none",
  }),
  gpserver: Object.freeze({
    path: "GPServer",
    serviceKind: "geoprocessing",
    protocol: "geoservices-gp-service",
    resource: "task",
  }),
});

const GEOSERVICES_PATH =
  /^(.*)\/rest\/services\/(.+?)\/(FeatureServer|MapServer|ImageServer|GeometryServer|GPServer)(?:\/([^/]+))?\/?$/i;

/**
 * Classify a canonical GeoServices service URL without issuing a request.
 * Returns `undefined` for non-GeoServices layouts and throws for malformed or
 * credential-bearing canonical layouts.
 */
export function parseGeoServicesEndpoint(input: string | URL): NormalizedGeoServicesEndpoint | undefined {
  const url = normalizeInputUrl(input);
  const match = GEOSERVICES_PATH.exec(url.pathname);
  if (!match) return undefined;

  const [, prefix = "", encodedServiceId = "", rawServiceType = "", encodedResource] = match;
  const definition = SERVICE_TYPES[rawServiceType.toLowerCase()];
  if (!definition) return undefined;
  const serviceSegments = encodedServiceId.split("/").map((segment) => decodePathSegment(segment, "service id"));
  if (serviceSegments.some(isUnsafePathSegment)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices URL contains an invalid service id.");
  }
  const serviceId = serviceSegments.join("/");
  const encodedCanonicalServiceId = serviceSegments.map((segment) => encodeURIComponent(segment)).join("/");
  const servicePath = `${prefix}/rest/services/${encodedCanonicalServiceId}/${definition.path}`;
  const serviceUrl = `${url.origin}${servicePath}`;
  const clientBaseUrl = `${url.origin}${prefix}`.replace(/\/$/, "");

  let layerId: number | undefined;
  let taskName: string | undefined;
  if (definition.resource === "none" && encodedResource !== undefined) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `${definition.path} URLs must identify the service root and cannot contain a resource segment.`,
    );
  }
  if (definition.resource === "layer" && encodedResource !== undefined) {
    if (!/^\d+$/.test(encodedResource)) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `${definition.path} resource identifiers must be non-negative decimal integers.`,
      );
    }
    layerId = Number(encodedResource);
    if (!Number.isSafeInteger(layerId)) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `${definition.path} resource identifier exceeds safe integer range.`,
      );
    }
  }
  if (definition.resource === "task" && encodedResource !== undefined) {
    taskName = decodePathSegment(encodedResource, "task name");
    if (isUnsafePathSegment(taskName)) {
      throw new HonuaDiscoveryError("invalid-endpoint", "GPServer URL contains an invalid task name.");
    }
  }

  const resourceSegment =
    layerId !== undefined ? `/${layerId}` : taskName !== undefined ? `/${encodeURIComponent(taskName)}` : "";
  return Object.freeze({
    endpoint: `${serviceUrl}${resourceSegment}`,
    clientBaseUrl,
    serviceUrl,
    serviceId,
    serviceKind: definition.serviceKind,
    protocol: definition.protocol,
    ...(layerId !== undefined ? { layerId } : {}),
    ...(taskName !== undefined ? { taskName } : {}),
  });
}

/** Normalize and require one of the five canonical GeoServices service layouts. */
export function normalizeGeoServicesEndpoint(input: string | URL): NormalizedGeoServicesEndpoint {
  const normalized = parseGeoServicesEndpoint(input);
  if (normalized) return normalized;
  throw new HonuaDiscoveryError(
    "invalid-endpoint",
    "Expected a canonical GeoServices FeatureServer, MapServer, ImageServer, GeometryServer, or GPServer URL.",
  );
}

function normalizeInputUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input.toString());
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices endpoints must be absolute HTTP(S) URLs.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices endpoints must use HTTP or HTTPS.");
  }
  const removableFormatQuery =
    url.searchParams.size > 0 &&
    [...url.searchParams].every(
      ([name, value]) =>
        (name.toLowerCase() === "f" || name.toLowerCase() === "format") &&
        (value.toLowerCase() === "json" || value.toLowerCase() === "pjson"),
    );
  if (url.username || url.password || (url.search && !removableFormatQuery) || url.hash) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "GeoServices endpoints must not contain credentials, identity-bearing query parameters, or fragments; configure authentication through clientOptions.",
    );
  }
  if (removableFormatQuery) url.search = "";
  while (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return url;
}

function decodePathSegment(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", `GeoServices URL contains an invalid encoded ${label}.`);
  }
}

function isUnsafePathSegment(value: string): boolean {
  return (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\0")
  );
}
