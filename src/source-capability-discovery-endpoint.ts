import type { SourceDescriptor } from "./contract/types.js";
import { encodeServiceIdPath, trimTrailingSlashes } from "./core/path-utils.js";
import { normalizeCapabilitySourceEndpoint } from "./source-capability-endpoint.js";
import type { CapabilitySourceEndpointIdentity } from "./source-capability-types.js";

/** Protocols whose descriptor-to-endpoint replay binding is certified by capability discovery. */
export type CapabilityDiscoveryProtocol =
  | "geoservices-feature-service"
  | "geoservices-map-service"
  | "geoservices-image-service"
  | "odata"
  | "grpc"
  | "pmtiles"
  | "wfs"
  | "ogc-features"
  | "ogc-records"
  | "ogc-tiles"
  | "ogc-maps"
  | "stac"
  | "geoparquet"
  | "wms"
  | "wmts";

/**
 * Reconstruct the smallest credential-free source endpoint from one resolved
 * descriptor. The result is suitable for capability cache creation and replay
 * verification; raw coordinates are never retained by the resulting profile.
 */
export function sourceCapabilityEndpointIdentity(
  descriptor: Pick<SourceDescriptor, "id" | "protocol" | "locator">,
): CapabilitySourceEndpointIdentity {
  const { protocol, locator } = descriptor;
  if (protocol === "odata") {
    return endpointIdentity({
      endpoint: canonicalOdataEntityEndpoint(locator.url, odataEntityPath(locator)),
      protocol,
      sourceId: descriptor.id,
    });
  }
  if (protocol === "grpc") {
    const serviceId = requiredServiceId(locator.serviceId);
    const layerId = locator.layerId;
    if (typeof layerId !== "number" || !Number.isSafeInteger(layerId) || layerId < 0) {
      throw new TypeError("gRPC descriptor requires locator.layerId to be a non-negative safe integer");
    }
    return endpointIdentity({
      endpoint: canonicalGeoServicesLayerEndpoint(locator.url, serviceId, "FeatureServer", layerId as number),
      protocol,
      sourceId: descriptor.id,
    });
  }
  if (protocol === "wfs") {
    const sourceId = requiredCollectionId(locator.typeName, "WFS");
    if (descriptor.id !== sourceId) {
      throw new TypeError("WFS descriptor.id must match locator.typeName");
    }
    return endpointIdentity({
      endpoint: requiredEndpoint(locator.url),
      protocol,
      sourceId,
    });
  }
  if (protocol === "ogc-features") {
    const sourceId = requiredCollectionId(locator.collectionId, "OGC Features");
    if (descriptor.id !== sourceId) {
      throw new TypeError("OGC Features descriptor.id must match locator.collectionId");
    }
    return endpointIdentity({
      endpoint: requiredEndpoint(locator.url),
      protocol,
      sourceId,
    });
  }
  if (protocol === "ogc-records" || protocol === "ogc-tiles" || protocol === "ogc-maps") {
    const sourceId = requiredCollectionId(locator.collectionId, "OGC");
    if (descriptor.id !== sourceId) {
      throw new TypeError(`${protocol.toUpperCase()} descriptor.id must match locator.collectionId`);
    }
    return endpointIdentity({
      endpoint: requiredEndpointWithBasePath(locator.url, locator.basePath),
      protocol,
      sourceId,
    });
  }
  if (protocol === "stac") {
    if (typeof locator.collectionId !== "string" && typeof locator.collectionId !== "number") {
      throw new TypeError("STAC locator.collectionId must be a string or number.");
    }
    const sourceId = String(locator.collectionId);
    if (descriptor.id !== sourceId) {
      throw new TypeError("STAC descriptor.id must match locator.collectionId.");
    }
    return endpointIdentity({
      endpoint: requiredEndpoint(locator.url),
      protocol,
      sourceId,
    });
  }
  if (protocol === "geoparquet") {
    return endpointIdentity({
      endpoint: requiredEndpoint(locator.url),
      protocol,
      sourceId: descriptor.id,
    });
  }
  if (protocol === "pmtiles") {
    return endpointIdentity({
      endpoint: requiredEndpoint(locator.url),
      protocol,
      sourceId: descriptor.id,
    });
  }
  if (protocol === "geoservices-feature-service" || protocol === "geoservices-map-service") {
    const serviceId = requiredServiceId(locator.serviceId);
    const layerId = locator.layerId;
    if (typeof layerId !== "number" || !Number.isSafeInteger(layerId) || layerId < 0) {
      throw new TypeError("GeoServices locator.layerId must be a non-negative safe integer");
    }
    const serviceType = protocol === "geoservices-feature-service" ? "FeatureServer" : "MapServer";
    return endpointIdentity({
      endpoint: canonicalGeoServicesLayerEndpoint(locator.url, serviceId, serviceType, layerId as number),
      protocol,
      sourceId: descriptor.id,
    });
  }
  if (protocol === "wms" || protocol === "wmts") {
    const layer = requiredRasterLayer(locator.typeName, protocol);
    if (descriptor.id !== layer) {
      throw new TypeError(`${protocol.toUpperCase()} descriptor.id must match locator.typeName`);
    }
    return endpointIdentity({
      endpoint: requiredEndpoint(locator.url),
      protocol,
      sourceId: layer,
    });
  }
  if (protocol === "geoservices-image-service") {
    const serviceId = requiredServiceId(locator.serviceId);
    if (descriptor.id !== serviceId) {
      throw new TypeError("GeoServices ImageServer descriptor.id must match locator.serviceId");
    }
    return endpointIdentity({
      endpoint: canonicalGeoServicesImageEndpoint(locator.url, serviceId),
      protocol,
      sourceId: serviceId,
    });
  }
  throw new TypeError(
    `Capability discovery endpoint binding is not certified for protocol "${String(protocol)}"; use the protocol rollout issue for that adapter.`,
  );
}

function requiredCollectionId(value: unknown, family: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${family} locator.collectionId / typeName must be a non-empty trimmed identifier`);
  }
  return value;
}

function requiredRasterLayer(value: unknown, protocol: "wms" | "wmts"): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${protocol.toUpperCase()} locator.typeName must be a non-empty trimmed layer identifier`);
  }
  return value;
}

function canonicalOdataEntityEndpoint(rawEndpoint: string, entityPath: readonly string[]): string {
  const endpoint = requiredEndpoint(rawEndpoint);
  const parsed = new URL(endpoint);
  const advertisedPath = trimTrailingSlashes(parsed.pathname);
  const basePath = advertisedPath === "" ? "/odata" : advertisedPath;
  parsed.pathname = `${basePath}/${entityPath.map((segment) => encodeURIComponent(segment)).join("/")}`;
  return parsed.toString();
}

function odataEntityPath(locator: SourceDescriptor["locator"]): readonly string[] {
  if (typeof locator.entitySet === "string" && locator.entitySet !== "") {
    return [requiredIdentifier(locator.entitySet, "OData locator.entitySet")];
  }
  if (typeof locator.layerId === "number" && Number.isFinite(locator.layerId)) {
    return [`Layers(${locator.layerId})`, "Features"];
  }
  throw new TypeError("OData locator requires locator.entitySet or a finite locator.layerId");
}

function endpointIdentity(identity: CapabilitySourceEndpointIdentity): CapabilitySourceEndpointIdentity {
  return Object.freeze({ ...identity, endpoint: normalizeCapabilitySourceEndpoint(identity.endpoint) });
}

function requiredEndpointWithBasePath(rawEndpoint: string, basePath: unknown): string {
  const endpoint = requiredEndpoint(rawEndpoint);
  const normalizedBasePath = requiredBasePath(basePath);
  if (!normalizedBasePath) return endpoint;
  const parsed = new URL(endpoint);
  const existing = trimTrailingSlashes(parsed.pathname);
  parsed.pathname = existing === "/" || existing === "" ? normalizedBasePath : `${existing}${normalizedBasePath}`;
  return parsed.toString();
}

function canonicalGeoServicesLayerEndpoint(
  rawEndpoint: string,
  serviceId: string,
  serviceType: "FeatureServer" | "MapServer",
  layerId: number,
): string {
  const endpoint = requiredEndpoint(rawEndpoint);
  const parsed = new URL(endpoint);
  const segments = trimTrailingSlashes(parsed.pathname).split("/");
  let typeIndex = segments.length - 1;
  let advertisedLayer: number | undefined;
  if (isAsciiDigits(segments[typeIndex] ?? "")) {
    advertisedLayer = Number.parseInt(segments[typeIndex]!, 10);
    typeIndex -= 1;
  }
  const advertisedType = segments[typeIndex]?.toLowerCase();
  if (advertisedType === "featureserver" || advertisedType === "mapserver") {
    if (advertisedType !== serviceType.toLowerCase()) {
      throw new TypeError("GeoServices locator.url contradicts descriptor protocol");
    }
    if (advertisedLayer !== undefined && advertisedLayer !== layerId) {
      throw new TypeError("GeoServices locator.url layer contradicts locator.layerId");
    }
    const restIndex = findRestServicesPrefix(segments, typeIndex);
    if (restIndex >= 0) {
      let advertisedServiceId: string;
      try {
        advertisedServiceId = segments
          .slice(restIndex + 2, typeIndex)
          .map((segment) => decodeURIComponent(segment))
          .join("/");
      } catch {
        throw new TypeError("GeoServices locator.url contains invalid percent encoding");
      }
      if (advertisedServiceId !== serviceId) {
        throw new TypeError("GeoServices locator.url contradicts locator.serviceId or descriptor protocol");
      }
    }
    parsed.pathname = `${segments.slice(0, typeIndex + 1).join("/")}/${layerId}`;
    return parsed.toString();
  }

  return `${trimTrailingSlashes(endpoint)}/rest/services/${encodeServiceIdPath(serviceId)}/${serviceType}/${layerId}`;
}

function canonicalGeoServicesImageEndpoint(rawEndpoint: string, serviceId: string): string {
  const endpoint = requiredEndpoint(rawEndpoint);
  const parsed = new URL(endpoint);
  const segments = trimTrailingSlashes(parsed.pathname).split("/");
  const imageIndex = segments.length - 1;
  const advertisedType = segments[imageIndex]?.toLowerCase();
  if (advertisedType === "imageserver") {
    const restIndex = findRestServicesPrefix(segments, imageIndex);
    if (restIndex >= 0) {
      let advertisedServiceId: string;
      try {
        advertisedServiceId = segments
          .slice(restIndex + 2, imageIndex)
          .map((segment) => decodeURIComponent(segment))
          .join("/");
      } catch {
        throw new TypeError("GeoServices locator.url contains invalid percent encoding");
      }
      if (advertisedServiceId !== serviceId) {
        throw new TypeError("GeoServices locator.url contradicts locator.serviceId or protocol");
      }
    }
    parsed.pathname = `${segments.slice(0, imageIndex + 1).join("/")}`;
    return parsed.toString();
  }
  return `${trimTrailingSlashes(endpoint)}/rest/services/${encodeServiceIdPath(serviceId)}/ImageServer`;
}

function findRestServicesPrefix(segments: readonly string[], typeIndex: number): number {
  for (let index = typeIndex - 2; index >= 0; index -= 1) {
    if (segments[index]?.toLowerCase() === "rest" && segments[index + 1]?.toLowerCase() === "services") {
      return index;
    }
  }
  return -1;
}

function isAsciiDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function requiredEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("Source locator.url must be a non-empty trimmed endpoint");
  }
  return value;
}

function requiredBasePath(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new TypeError("OGC locator.basePath must be a path string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || !trimmed.startsWith("/")) {
    throw new TypeError("OGC locator.basePath must be a non-empty path beginning with /");
  }
  return trimTrailingSlashes(trimmed);
}

function requiredIdentifier(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes("/") ||
    value === "." ||
    value === ".."
  ) {
    throw new TypeError(`${path} must be one non-empty trimmed routable path identifier`);
  }
  return value;
}

function requiredServiceId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("GeoServices locator.serviceId must be a non-empty trimmed identifier");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError("GeoServices locator.serviceId must contain routable path segments");
  }
  return value;
}
