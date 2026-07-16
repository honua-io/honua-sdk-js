/** Internal GeoServices URL classification and metadata projection for connect(). */

import type {
  ConnectDiscoverySourceSnapshot,
  ConnectProtocolHint,
  ConnectResolvedProtocol,
  ConnectSourceSchemaProjection,
} from "./connect.js";
import type { DiscoveryCapabilityEvidence, DiscoveryProvenance } from "./contract/discovery.js";
import { type Capability, PROTOCOL_DEFAULT_CAPABILITIES, type SourceSchema } from "./contract/types.js";
import type { HonuaMetadataRequestOptions } from "./core/cache-state.js";
import type { HonuaClient } from "./core/client.js";
import { HonuaAbortError, HonuaDiscoveryError } from "./core/errors.js";
import type { HonuaLayerMetadata, HonuaServiceMetadata } from "./core/types.js";
import { parseGeoServicesEndpoint } from "./geoservices-endpoint.js";

export interface ConnectTarget {
  readonly endpoint: string;
  readonly clientBaseUrl: string;
  readonly protocol: ConnectResolvedProtocol;
  readonly serviceId?: string;
  readonly layerId?: number;
  /** OData service base path (endpoint pathname); the client is bound to the origin. */
  readonly odataBasePath?: string;
  /**
   * Raw OGC API (Tiles / Maps / Records / Processes) service-root path prefix
   * (endpoint pathname); the client is bound to the origin and the discovered
   * source adapters thread this prefix through their wire methods.
   */
  readonly ogcBasePath?: string;
}

export interface GeoServicesDiscoveryOptions {
  readonly metadata?: Omit<HonuaMetadataRequestOptions, "signal" | "refresh">;
  readonly refresh?: boolean;
  readonly signal?: AbortSignal;
}

export interface GeoServicesDiscoveryResult {
  readonly retrievedAt: string;
  readonly sources: readonly ConnectDiscoverySourceSnapshot[];
}

export function resolveConnectTarget(endpoint: string, hint: ConnectProtocolHint): ConnectTarget {
  const classifiedGeoServices = parseGeoServicesEndpoint(endpoint);
  const geoservices =
    classifiedGeoServices?.protocol === "geoservices-feature-service" ||
    classifiedGeoServices?.protocol === "geoservices-map-service" ||
    classifiedGeoServices?.protocol === "geoservices-image-service"
      ? {
          endpoint: classifiedGeoServices.endpoint,
          clientBaseUrl: classifiedGeoServices.clientBaseUrl,
          protocol: classifiedGeoServices.protocol,
          serviceId: classifiedGeoServices.serviceId,
          ...(classifiedGeoServices.layerId !== undefined ? { layerId: classifiedGeoServices.layerId } : {}),
        }
      : undefined;
  if (hint === "auto") {
    if (geoservices) return geoservices;
    if (classifiedGeoServices) {
      throw new HonuaDiscoveryError(
        "unsupported-protocol",
        `GeoServices ${classifiedGeoServices.serviceKind} services are not Source-backed by this connect() path; use discoverGeoServices() for service discovery.`,
        {
          endpoint,
          resolvedProtocol: classifiedGeoServices.protocol,
          serviceKind: classifiedGeoServices.serviceKind,
        },
      );
    }
    throw new HonuaDiscoveryError(
      "ambiguous-protocol",
      "connect() could not determine the protocol from the URL without probing. Pass an explicit protocol hint.",
      {
        autoDetectedLayouts: [
          "*/rest/services/*/FeatureServer[/layer]",
          "*/rest/services/*/MapServer[/layer]",
          "*/rest/services/*/ImageServer[/layer]",
        ],
        supportedProtocols: [
          "ogc-features",
          "stac",
          "wfs",
          "odata",
          "geoparquet",
          "ogc-records",
          "ogc-tiles",
          "ogc-maps",
          "geoservices-feature-service",
          "geoservices-map-service",
          "geoservices-image-service",
        ],
      },
    );
  }
  if (hint === "ogc-features" || hint === "stac") {
    if (geoservices) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `The canonical GeoServices URL resolves to "${geoservices.protocol}", not "${hint}".`,
        { endpoint, protocol: hint, resolvedProtocol: geoservices.protocol },
      );
    }
    return { endpoint, clientBaseUrl: endpoint, protocol: hint };
  }
  if (hint === "wfs") {
    if (geoservices) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `The canonical GeoServices URL resolves to "${geoservices.protocol}", not "wfs".`,
        { endpoint, protocol: hint, resolvedProtocol: geoservices.protocol },
      );
    }
    return { endpoint, clientBaseUrl: endpoint, protocol: hint };
  }
  if (hint === "odata") {
    if (geoservices) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `The canonical GeoServices URL resolves to "${geoservices.protocol}", not "odata".`,
        { endpoint, protocol: hint, resolvedProtocol: geoservices.protocol },
      );
    }
    // OData services are always mounted under a path (e.g. `/odata`, `/v4`).
    // Bind the client to the origin and carry the service path so both
    // discovery (`$metadata`) and the runtime adapter resolve the same base.
    const url = new URL(endpoint);
    const odataBasePath = url.pathname && url.pathname !== "/" ? url.pathname : "/odata";
    return { endpoint, clientBaseUrl: url.origin, protocol: "odata", odataBasePath };
  }
  if (hint === "geoparquet") {
    if (geoservices) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `The canonical GeoServices URL resolves to "${geoservices.protocol}", not "geoparquet".`,
        { endpoint, protocol: hint, resolvedProtocol: geoservices.protocol },
      );
    }
    // A GeoParquet asset is a static file (or hive-partitioned glob) addressed
    // directly; discovery reads its footer, so the client base URL is only the
    // asset origin and is never used for feature queries.
    return { endpoint, clientBaseUrl: new URL(endpoint).origin, protocol: "geoparquet" };
  }
  if ((hint as string) === "ogc-processes") {
    // OGC API Processes is intentionally not a Source-backed protocol: a
    // process is an invocable operation, not a queryable dataset, so it never
    // resolves to a connect() Source. Callers discover a Processes service's
    // capabilities and process list through discoverOgcProcesses() instead.
    throw new HonuaDiscoveryError(
      "unsupported-protocol",
      "OGC API Processes is not a Source-backed protocol; use discoverOgcProcesses() to discover a Processes service's capabilities and process list.",
      { endpoint, protocol: hint },
    );
  }
  if (hint === "ogc-records" || hint === "ogc-tiles" || hint === "ogc-maps") {
    if (geoservices) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `The canonical GeoServices URL resolves to "${geoservices.protocol}", not "${hint}".`,
        { endpoint, protocol: hint, resolvedProtocol: geoservices.protocol },
      );
    }
    // A raw OGC API Records / Tiles / Maps service root is mounted under a path
    // (or at the origin). Bind the client to the origin and carry the
    // service-root prefix so discovery (landing / conformance / collections)
    // and the runtime source adapters resolve against the same advertised
    // layout through the shared `basePath` seam.
    const url = new URL(endpoint);
    const ogcBasePath = url.pathname && url.pathname !== "/" ? url.pathname : "";
    return { endpoint, clientBaseUrl: url.origin, protocol: hint, ogcBasePath };
  }
  if (
    hint === "geoservices-feature-service" ||
    hint === "geoservices-map-service" ||
    hint === "geoservices-image-service"
  ) {
    if (!geoservices || geoservices.protocol !== hint) {
      const expected =
        hint === "geoservices-feature-service"
          ? "FeatureServer"
          : hint === "geoservices-map-service"
            ? "MapServer"
            : "ImageServer";
      throw new HonuaDiscoveryError("invalid-endpoint", `The endpoint is not a canonical ${expected} URL.`, {
        endpoint,
        protocol: hint,
      });
    }
    return geoservices;
  }
  throw new HonuaDiscoveryError(
    "unsupported-protocol",
    `connect() does not yet include a reviewed discovery adapter for "${String(hint)}".`,
    {
      protocol: hint,
      supportedProtocols: [
        "ogc-features",
        "stac",
        "wfs",
        "odata",
        "geoparquet",
        "ogc-records",
        "ogc-tiles",
        "ogc-maps",
        "geoservices-feature-service",
        "geoservices-map-service",
        "geoservices-image-service",
      ],
    },
  );
}

export async function discoverGeoServicesSources(
  client: HonuaClient,
  target: ConnectTarget,
  options: GeoServicesDiscoveryOptions,
  sourceSchemaProjection?: ConnectSourceSchemaProjection,
): Promise<GeoServicesDiscoveryResult> {
  const serviceId = target.serviceId;
  if (!serviceId) throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices discovery requires a service id.");
  const request: HonuaMetadataRequestOptions = {
    ...options.metadata,
    ...(options.signal ? { signal: options.signal } : {}),
    refresh: options.refresh === true,
  };
  const retrievedAt = new Date().toISOString();
  if (target.layerId !== undefined) {
    const metadata = await getLayerMetadata(client, target.protocol, serviceId, target.layerId, request);
    throwIfAborted(options.signal);
    if (metadata.id !== target.layerId) {
      throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices layer metadata id does not match the URL.", {
        expectedLayerId: target.layerId,
        receivedLayerId: metadata.id,
      });
    }
    return Object.freeze({
      retrievedAt,
      sources: Object.freeze([
        sourceSnapshot(
          target,
          metadata,
          layerEvidence(target, metadata, retrievedAt),
          retrievedAt,
          sourceSchemaProjection,
        ),
      ]),
    });
  }

  const service = await getServiceMetadata(client, target.protocol, serviceId, request);
  throwIfAborted(options.signal);
  const summaries = [...(service.layers ?? []), ...(service.tables ?? [])];
  validateLayerSummaries(summaries, target.protocol, serviceId);
  const serviceEvidence = serviceCapabilityEvidence(target, service, retrievedAt);
  const sources = await mapWithConcurrency(summaries, 4, async (summary) => {
    try {
      const metadata = await getLayerMetadata(client, target.protocol, serviceId, summary.id, request);
      if (metadata.id !== summary.id) {
        throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices layer metadata id does not match its listing.");
      }
      return sourceSnapshot(
        target,
        metadata,
        Object.freeze([...serviceEvidence, ...layerEvidence(target, metadata, retrievedAt)]),
        retrievedAt,
        sourceSchemaProjection,
      );
    } catch (error) {
      if (options.signal?.aborted || error instanceof HonuaAbortError) throw error;
      const unavailable: DiscoveryCapabilityEvidence = Object.freeze({
        kind: "unavailable" as const,
        reason: `Layer ${summary.id} metadata was unavailable; only service-level capability evidence was retained.`,
        provenance: Object.freeze([Object.freeze({ source: layerUrl(target, summary.id), retrievedAt })]),
      });
      return sourceSnapshot(
        target,
        { id: summary.id, name: summary.name },
        Object.freeze([...serviceEvidence, unavailable]),
        retrievedAt,
        sourceSchemaProjection,
      );
    }
  });
  throwIfAborted(options.signal);
  return Object.freeze({ retrievedAt, sources: Object.freeze(sources) });
}

function validateLayerSummaries(
  summaries: readonly { readonly id: number; readonly name: string }[],
  protocol: ConnectResolvedProtocol,
  serviceId: string,
): void {
  if (summaries.length === 0) {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices discovery returned no layers or tables.", {
      protocol,
      serviceId,
    });
  }
  const ids = new Set<number>();
  for (const summary of summaries) {
    if (!Number.isInteger(summary.id) || summary.id < 0 || ids.has(summary.id)) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        "GeoServices layer identifiers must be unique non-negative integers.",
        { layerId: summary.id },
      );
    }
    ids.add(summary.id);
  }
}

function getServiceMetadata(
  client: HonuaClient,
  protocol: ConnectResolvedProtocol,
  serviceId: string,
  options: HonuaMetadataRequestOptions,
): Promise<HonuaServiceMetadata> {
  return protocol === "geoservices-feature-service"
    ? client.getFeatureServiceMetadata(serviceId, options)
    : client.getMapServiceMetadata(serviceId, options);
}

function getLayerMetadata(
  client: HonuaClient,
  protocol: ConnectResolvedProtocol,
  serviceId: string,
  layerId: number,
  options: HonuaMetadataRequestOptions,
): Promise<HonuaLayerMetadata> {
  return protocol === "geoservices-feature-service"
    ? client.getLayerMetadata(serviceId, layerId, options)
    : client.getMapLayerMetadata(serviceId, layerId, options);
}

function sourceSnapshot(
  target: ConnectTarget,
  metadata: HonuaLayerMetadata,
  evidence: readonly DiscoveryCapabilityEvidence[],
  retrievedAt: string,
  sourceSchemaProjection: ConnectSourceSchemaProjection | undefined,
): ConnectDiscoverySourceSnapshot {
  if (!Number.isInteger(metadata.id) || metadata.id < 0 || typeof metadata.name !== "string" || !metadata.name.trim()) {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices returned invalid layer metadata.");
  }
  const serviceId = target.serviceId;
  if (!serviceId) throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices discovery requires a service id.");
  const fields = Array.isArray(metadata.fields) ? Object.freeze([...metadata.fields]) : undefined;
  const primaryKey = fields?.find((field) => field.type === "esriFieldTypeOID")?.name;
  const schema: SourceSchema | undefined = fields
    ? Object.freeze({ fields, ...(primaryKey ? { primaryKey } : {}) })
    : undefined;
  const schemaV2 = sourceSchemaProjection?.geoServices(metadata, {
    protocol: target.protocol as "geoservices-feature-service" | "geoservices-map-service",
    source: layerUrl(target, metadata.id),
    observedAt: retrievedAt,
  });
  return Object.freeze({
    id: String(metadata.id),
    locator: Object.freeze({ url: target.clientBaseUrl, serviceId, layerId: metadata.id }),
    title: metadata.name,
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(schema ? { schema } : {}),
    ...(schemaV2 ? { schemaV2 } : {}),
    evidence,
  });
}

function layerEvidence(
  target: ConnectTarget,
  metadata: HonuaLayerMetadata,
  retrievedAt: string,
): readonly DiscoveryCapabilityEvidence[] {
  const provenance = Object.freeze([provenanceFor(layerUrl(target, metadata.id), retrievedAt, metadata)]);
  const scope = target.protocol === "geoservices-map-service" ? MAP_LAYER_SCOPE : FEATURE_LAYER_SCOPE;
  const records: DiscoveryCapabilityEvidence[] = [];
  if (typeof metadata.capabilities !== "string" || !metadata.capabilities.trim()) {
    records.push(
      Object.freeze({
        kind: "unavailable" as const,
        scope,
        reason: "Layer metadata did not advertise a GeoServices capabilities value.",
        provenance,
      }),
    );
  } else {
    records.push(
      Object.freeze({
        kind: "metadata" as const,
        capabilities: Object.freeze(
          capabilitiesFromMetadata(target.protocol, metadata).filter((capability) => scope.includes(capability)),
        ),
        scope,
        provenance,
      }),
    );
  }
  if (target.protocol === "geoservices-map-service" && target.layerId !== undefined) {
    records.push(
      Object.freeze({
        kind: "unavailable" as const,
        scope: Object.freeze(["tiles"] as const),
        reason: "A selected MapServer layer document does not report service-level tile cache status.",
        provenance,
      }),
    );
  }
  return Object.freeze(records);
}

const FEATURE_LAYER_SCOPE: readonly Capability[] = Object.freeze([
  ...PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
]);
const MAP_LAYER_SCOPE: readonly Capability[] = Object.freeze(
  [...PROTOCOL_DEFAULT_CAPABILITIES["geoservices-map-service"]].filter((capability) => capability !== "tiles"),
);

const FEATURE_SERVICE_SCOPE: readonly Capability[] = Object.freeze(["queryObjectIds", "applyEdits"]);
const MAP_SERVICE_SCOPE: readonly Capability[] = Object.freeze(["queryObjectIds", "render", "tiles"]);

function serviceCapabilityEvidence(
  target: ConnectTarget,
  metadata: HonuaServiceMetadata,
  retrievedAt: string,
): readonly DiscoveryCapabilityEvidence[] {
  const provenance = Object.freeze([provenanceFor(target.endpoint, retrievedAt, metadata)]);
  const scope = target.protocol === "geoservices-feature-service" ? FEATURE_SERVICE_SCOPE : MAP_SERVICE_SCOPE;
  if (typeof metadata.capabilities !== "string" || !metadata.capabilities.trim()) {
    return Object.freeze([
      Object.freeze({
        kind: "unavailable" as const,
        scope,
        reason: "Service metadata did not advertise a GeoServices capabilities value.",
        provenance,
      }),
    ]);
  }
  return Object.freeze([
    Object.freeze({
      kind: "metadata" as const,
      capabilities: Object.freeze(
        capabilitiesFromMetadata(target.protocol, metadata).filter((capability) => scope.includes(capability)),
      ),
      scope,
      provenance,
    }),
  ]);
}

function capabilitiesFromMetadata(
  protocol: ConnectResolvedProtocol,
  metadata: HonuaLayerMetadata | HonuaServiceMetadata,
): Capability[] {
  const advertised = new Set(
    (metadata.capabilities ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const capabilities = new Set<Capability>();
  if (advertised.has("query")) {
    capabilities.add("queryObjectIds");
    const paginationSupported =
      "advancedQueryCapabilities" in metadata && metadata.advancedQueryCapabilities?.supportsPagination === true;
    // The canonical `query` capability also promises a safe `queryAll()`.
    // A layer that does not explicitly affirm pagination cannot uphold that contract:
    // servers commonly ignore resultOffset and repeat the first page forever.
    // Keep independently safe query operations, but fail closed for canonical
    // query/stream until the contract can represent a single-page-only query.
    if (paginationSupported) {
      capabilities.add("query");
      capabilities.add("stream");
    }
    if (
      !("advancedQueryCapabilities" in metadata) ||
      metadata.advancedQueryCapabilities?.supportsReturningQueryExtent !== false
    ) {
      capabilities.add("queryExtent");
    }
  }
  if (
    metadata.supportsStatistics === true ||
    ("advancedQueryCapabilities" in metadata && metadata.advancedQueryCapabilities?.supportsStatistics === true)
  ) {
    capabilities.add("queryAggregate");
  }
  if (metadata.useStandardizedQueries === true) capabilities.add("sql");
  if ((metadata.supportedQueryFormats ?? "").split(",").some((value) => value.trim().toLowerCase() === "pbf")) {
    capabilities.add("pbf");
  }
  if ("relationships" in metadata && Array.isArray(metadata.relationships) && metadata.relationships.length > 0) {
    capabilities.add("queryRelated");
  }
  if ("supportsAttachments" in metadata && metadata.supportsAttachments === true) capabilities.add("attachments");
  if (protocol === "geoservices-feature-service") {
    if (["create", "update", "delete", "editing"].some((value) => advertised.has(value))) {
      capabilities.add("applyEdits");
    }
  } else if (protocol === "geoservices-map-service") {
    if (advertised.has("map")) capabilities.add("render");
    if ("singleFusedMapCache" in metadata && metadata.singleFusedMapCache === true) capabilities.add("tiles");
  }
  return [...capabilities];
}

function layerUrl(target: ConnectTarget, layerId: number): string {
  return `${target.endpoint.replace(/\/\d+$/, "")}/${layerId}`;
}

function provenanceFor(
  source: string,
  retrievedAt: string,
  value: { readonly cache?: { readonly validator?: { readonly etag?: string; readonly lastModified?: string } } },
): DiscoveryProvenance {
  const validator = value.cache?.validator?.etag ?? value.cache?.validator?.lastModified;
  return Object.freeze({ source, retrievedAt, ...(validator ? { validator } : {}) });
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const output = new Array<U>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(values[index] as T);
    }
  });
  await Promise.all(workers);
  return output;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}
