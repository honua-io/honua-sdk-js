import type { SourceDescriptor } from "./contract/types.js";
import { encodeServiceIdPath, trimTrailingSlashes } from "./core/path-utils.js";
import { normalizeCapabilitySourceEndpoint } from "./source-capability-endpoint.js";
import type { CapabilitySourceEndpointIdentity } from "./source-capability-types.js";

/** Protocols whose descriptor-to-endpoint replay binding is certified by capability discovery. */
export type CapabilityDiscoveryProtocol = "geoservices-feature-service" | "geoservices-map-service" | "odata";

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
    const entitySet = requiredIdentifier(locator.entitySet, "OData locator.entitySet");
    const root = requiredEndpoint(locator.url);
    return endpointIdentity({
      endpoint: `${trimTrailingSlashes(root)}/${encodeURIComponent(entitySet)}`,
      protocol,
      sourceId: descriptor.id,
    });
  }
  if (protocol === "geoservices-feature-service" || protocol === "geoservices-map-service") {
    const serviceId = requiredServiceId(locator.serviceId);
    const layerId = locator.layerId;
    if (!Number.isSafeInteger(layerId) || (layerId as number) < 0) {
      throw new TypeError("GeoServices locator.layerId must be a non-negative safe integer");
    }
    const serviceType = protocol === "geoservices-feature-service" ? "FeatureServer" : "MapServer";
    return endpointIdentity({
      endpoint: canonicalGeoServicesLayerEndpoint(locator.url, serviceId, serviceType, layerId as number),
      protocol,
      sourceId: descriptor.id,
    });
  }
  throw new TypeError(
    `Capability discovery endpoint binding is not certified for protocol "${String(protocol)}"; use the protocol rollout issue for that adapter.`,
  );
}

function endpointIdentity(identity: CapabilitySourceEndpointIdentity): CapabilitySourceEndpointIdentity {
  return Object.freeze({ ...identity, endpoint: normalizeCapabilitySourceEndpoint(identity.endpoint) });
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

function requiredIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("/")) {
    throw new TypeError(`${path} must be one non-empty trimmed path identifier`);
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
