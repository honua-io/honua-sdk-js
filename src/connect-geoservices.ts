/** Internal GeoServices URL classification and metadata projection for connect(). */

import { canonicalizeUrlQuery, deleteQueryNames } from "./connect-url-safety.js";
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
import type { HonuaFieldInfo, HonuaLayerMetadata, HonuaServiceMetadata } from "./core/types.js";
import { parseGeoServicesEndpoint } from "./geoservices-endpoint.js";
import { type GeoServicesMetadataRequestOptions, getGeoServicesMetadata } from "./geoservices-metadata.js";

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
  readonly metadata?: GeoServicesMetadataRequestOptions;
  readonly refresh?: boolean;
  readonly signal?: AbortSignal;
}

export interface GeoServicesDiscoveryResult {
  readonly retrievedAt: string;
  readonly sources: readonly ConnectDiscoverySourceSnapshot[];
}

/** @internal Raw ImageServer discovery evidence used by the richer service projection. */
export interface GeoServicesImageSourceDiscoveryResult extends GeoServicesDiscoveryResult {
  readonly evidence: readonly DiscoveryCapabilityEvidence[];
  readonly metadataSource: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly securedStatusCode?: number;
}

export function resolveConnectTarget(endpoint: string, hint: ConnectProtocolHint): ConnectTarget {
  const rasterService = parseWmsWmtsTarget(endpoint, hint);
  // A path such as `/MapServer/WMS` overlaps the GeoServices grammar. Resolve
  // the stricter raster service shape first so it cannot be interpreted as a
  // MapServer layer locator.
  const classifiedGeoServices = rasterService ? undefined : parseGeoServicesEndpoint(endpoint);
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
    if (rasterService) return rasterService;
    if (geoservices) return geoservices;
    if (classifiedGeoServices) {
      throw new HonuaDiscoveryError(
        "unsupported-protocol",
        `GeoServices ${classifiedGeoServices.serviceKind} services are not Source-backed by connect(); use discoverGeoServices() for service and operation discovery.`,
        {
          endpoint: classifiedGeoServices.endpoint,
          resolvedProtocol: classifiedGeoServices.protocol,
          serviceKind: classifiedGeoServices.serviceKind,
        },
      );
    }
    if (hasTiffLikePath(endpoint)) {
      throw directCogClassificationError(endpoint, hint);
    }
    throw new HonuaDiscoveryError(
      "ambiguous-protocol",
      'connect() could not determine the protocol from the URL without probing. Pass an explicit protocol hint; for PMTiles, a "pmtiles://https://..." marker is strong auto evidence.',
      {
        autoDetectedLayouts: [
          "*/rest/services/*/FeatureServer[/layer]",
          "*/rest/services/*/MapServer[/layer]",
          "*/rest/services/*/ImageServer",
          "pmtiles://https://*/asset",
        ],
        supportedProtocols: [
          "grpc",
          "ogc-features",
          "stac",
          "wfs",
          "odata",
          "pmtiles",
          "geoparquet",
          "ogc-records",
          "ogc-tiles",
          "ogc-maps",
          "wms",
          "wmts",
          "geoservices-feature-service",
          "geoservices-map-service",
          "geoservices-image-service",
        ],
      },
    );
  }
  if (hint === "wms" || hint === "wmts") {
    if (geoservices) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `The canonical GeoServices URL resolves to "${geoservices.protocol}", not "${hint}".`,
        { endpoint, protocol: hint, resolvedProtocol: geoservices.protocol },
      );
    }
    if (!rasterService) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `The endpoint cannot be normalized as a ${hint.toUpperCase()} service URL.`,
        { protocol: hint },
      );
    }
    return rasterService;
  }
  if (hint === "ogc-features" || hint === "stac") {
    if (classifiedGeoServices) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `The canonical GeoServices URL resolves to "${classifiedGeoServices.protocol}", not "${hint}".`,
        { endpoint, protocol: hint, resolvedProtocol: classifiedGeoServices.protocol },
      );
    }
    return { endpoint, clientBaseUrl: endpoint, protocol: hint };
  }
  if (hint === "wfs") {
    if (classifiedGeoServices) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `The canonical GeoServices URL resolves to "${classifiedGeoServices.protocol}", not "wfs".`,
        { endpoint, protocol: hint, resolvedProtocol: classifiedGeoServices.protocol },
      );
    }
    return { endpoint, clientBaseUrl: endpoint, protocol: hint };
  }
  if (hint === "odata") {
    if (classifiedGeoServices) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `The canonical GeoServices URL resolves to "${classifiedGeoServices.protocol}", not "odata".`,
        { endpoint, protocol: hint, resolvedProtocol: classifiedGeoServices.protocol },
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
    if (classifiedGeoServices) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `The canonical GeoServices URL resolves to "${classifiedGeoServices.protocol}", not "geoparquet".`,
        { endpoint, protocol: hint, resolvedProtocol: classifiedGeoServices.protocol },
      );
    }
    // A GeoParquet asset is a static file (or hive-partitioned glob) addressed
    // directly; discovery reads its footer, so the client base URL is only the
    // asset origin and is never used for feature queries.
    return { endpoint, clientBaseUrl: new URL(endpoint).origin, protocol: "geoparquet" };
  }
  if (hint === "pmtiles") {
    if (classifiedGeoServices) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `The canonical GeoServices URL resolves to "${classifiedGeoServices.protocol}", not "pmtiles".`,
        { endpoint, protocol: hint, resolvedProtocol: classifiedGeoServices.protocol },
      );
    }
    return { endpoint, clientBaseUrl: new URL(endpoint).origin, protocol: "pmtiles" };
  }
  if ((hint as string) === "cog" || (hint as string) === "geotiff") {
    throw directCogClassificationError(endpoint, hint);
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
    if (classifiedGeoServices) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `The canonical GeoServices URL resolves to "${classifiedGeoServices.protocol}", not "${hint}".`,
        { endpoint, protocol: hint, resolvedProtocol: classifiedGeoServices.protocol },
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
  if (hint === "grpc") {
    // Honua's gRPC FeatureService facade is a transport-selectable fast path
    // over the same canonical FeatureServer semantics; `auto` never infers
    // it (the identical URL is ambiguous between REST and gRPC transport
    // intent), and MapServer / ImageServer have no gRPC query surface, so
    // only an explicit "grpc" hint against a canonical FeatureServer URL
    // resolves here.
    if (!geoservices || geoservices.protocol !== "geoservices-feature-service") {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        'The endpoint is not a canonical FeatureServer URL required for Honua gRPC discovery ("protocol: \\"grpc\\"" only supports FeatureServer semantics).',
        { endpoint, protocol: hint, resolvedProtocol: geoservices?.protocol },
      );
    }
    return {
      endpoint: geoservices.endpoint,
      clientBaseUrl: geoservices.clientBaseUrl,
      protocol: "grpc",
      serviceId: geoservices.serviceId,
      ...(geoservices.layerId !== undefined ? { layerId: geoservices.layerId } : {}),
    };
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
  if (hint === "geoservices-geometry-service" || hint === "geoservices-gp-service") {
    if (!classifiedGeoServices || classifiedGeoServices.protocol !== hint) {
      const expected = hint === "geoservices-geometry-service" ? "GeometryServer" : "GPServer";
      throw new HonuaDiscoveryError("invalid-endpoint", `The endpoint is not a canonical ${expected} URL.`, {
        endpoint,
        protocol: hint,
      });
    }
    throw new HonuaDiscoveryError(
      "unsupported-protocol",
      `${classifiedGeoServices.serviceKind} services are operation-shaped, not Source-backed; use discoverGeoServices().`,
      { endpoint: classifiedGeoServices.endpoint, protocol: hint },
    );
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
        "pmtiles",
        "geoparquet",
        "ogc-records",
        "ogc-tiles",
        "ogc-maps",
        "wms",
        "wmts",
        "geoservices-feature-service",
        "geoservices-map-service",
        "geoservices-image-service",
      ],
    },
  );
}

function hasTiffLikePath(endpoint: string): boolean {
  return /\.tiff?$/i.test(new URL(endpoint).pathname);
}

function directCogClassificationError(endpoint: string, hint: ConnectProtocolHint): HonuaDiscoveryError {
  return new HonuaDiscoveryError(
    "unsupported-protocol",
    "A direct TIFF URL is not sufficient COG evidence. Classify the asset through explicit static STAC metadata, then open the resulting COG candidate with @honua/sdk-js/cog.",
    {
      endpoint,
      protocol: hint,
      discoveryDisposition: "stac-classified",
      directInput: "unsupported-unclassified",
      requiredWorkflow: "connect-static-stac",
      alternateProtocolProbing: false,
    },
  );
}

function parseWmsWmtsTarget(endpoint: string, hint: ConnectProtocolHint): ConnectTarget | undefined {
  const parsed = new URL(endpoint);
  const serviceValues = [...parsed.searchParams]
    .filter(([name]) => name.toLowerCase() === "service")
    .map(([, value]) => value.toLowerCase());
  if (serviceValues.length > 1) {
    throw new HonuaDiscoveryError("invalid-endpoint", "WMS/WMTS endpoints must identify SERVICE at most once.", {
      endpoint: redactedRasterEndpoint(parsed),
    });
  }
  const queryService = serviceValues[0];
  const pathSegment = parsed.pathname.split("/").filter(Boolean).at(-1)?.toLowerCase();
  const pathService = pathSegment === "wms" || pathSegment === "wmts" ? pathSegment : undefined;
  if (queryService && queryService !== "wms" && queryService !== "wmts") return undefined;
  if (queryService && pathService && queryService !== pathService) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "Raster endpoint path and SERVICE query identify different protocols.",
      {
        endpoint: redactedRasterEndpoint(parsed),
        pathProtocol: pathService,
        queryProtocol: queryService,
      },
    );
  }
  const structural = queryService ?? pathService;
  const requested = hint === "wms" || hint === "wmts" ? hint : undefined;
  const protocol = requested ?? (hint === "auto" ? structural : undefined);
  if (protocol !== "wms" && protocol !== "wmts") return undefined;
  if (structural && structural !== protocol) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `The endpoint identifies ${structural.toUpperCase()}, not ${protocol.toUpperCase()}.`,
      { endpoint: redactedRasterEndpoint(parsed), protocol, advertisedService: structural },
    );
  }
  deleteQueryNames(parsed, new Set(["service", "request", "version"]));
  canonicalizeUrlQuery(parsed);
  parsed.hash = "";
  while (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) parsed.pathname = parsed.pathname.slice(0, -1);
  const normalized = parsed.toString().replace(/\/$/, "");
  const serviceId = parseRasterServiceId(parsed.pathname, protocol);
  return {
    endpoint: normalized,
    clientBaseUrl: parsed.origin,
    protocol,
    ...(serviceId ? { serviceId } : {}),
  };
}

function parseRasterServiceId(pathname: string, protocol: "wms" | "wmts"): string | undefined {
  const match = /^\/(?:[^/]+\/)*rest\/services\/(.+)\/MapServer\/(WMS|WMTS)$/i.exec(pathname);
  if (!match || match[2]?.toLowerCase() !== protocol) return undefined;
  try {
    const segments = match[1]!.split("/").map(decodeURIComponent);
    return segments.every((segment) => segment && segment !== "." && segment !== "..") ? segments.join("/") : undefined;
  } catch {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `${protocol.toUpperCase()} service path contains invalid encoding.`,
    );
  }
}

function redactedRasterEndpoint(endpoint: URL): string {
  const copy = new URL(endpoint);
  copy.search = "";
  return copy.toString();
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

/**
 * Discover an ImageServer raster-catalog Source only when metadata proves the
 * existing adapter can uphold the canonical query/queryAll contract.
 *
 * @internal
 */
export async function discoverGeoServicesImageSources(
  client: HonuaClient,
  target: ConnectTarget,
  options: GeoServicesDiscoveryOptions,
  sourceSchemaProjection?: ConnectSourceSchemaProjection,
): Promise<GeoServicesImageSourceDiscoveryResult> {
  if (target.protocol !== "geoservices-image-service" || !target.serviceId) {
    throw new HonuaDiscoveryError("invalid-endpoint", "ImageServer discovery requires an image service id.");
  }
  const retrievedAt = new Date().toISOString();
  const outcome = await getGeoServicesMetadata(client, target.clientBaseUrl, target.endpoint, options);
  throwIfAborted(options.signal);
  const provenance = Object.freeze([Object.freeze({ source: outcome.source, retrievedAt })]);
  if (outcome.kind === "secured") {
    const evidence: readonly DiscoveryCapabilityEvidence[] = Object.freeze([
      Object.freeze({
        kind: "unavailable" as const,
        scope: IMAGE_SERVICE_SCOPE,
        reason: `ImageServer metadata requires authorization (status ${outcome.statusCode}); no capabilities were inferred.`,
        provenance,
      }),
    ]);
    return Object.freeze({
      retrievedAt,
      sources: Object.freeze([]),
      evidence,
      metadataSource: outcome.source,
      securedStatusCode: outcome.statusCode,
    });
  }

  const evidence = imageCapabilityEvidence(outcome.value, target.endpoint, provenance);
  const source = imageSourceExecutable(outcome.value, target.endpoint)
    ? imageSourceSnapshot(target, outcome.value, evidence, sourceSchemaProjection)
    : undefined;
  return Object.freeze({
    retrievedAt,
    sources: Object.freeze(source ? [source] : []),
    evidence,
    metadataSource: outcome.source,
    metadata: outcome.value,
  });
}

function imageSourceExecutable(metadata: Readonly<Record<string, unknown>>, serviceUrl: string): boolean {
  const advertised = imageCapabilityTokens(metadata);
  const operations = imageOperationNames(metadata, serviceUrl);
  const advanced = readImageOwn(metadata, "advancedQueryCapabilities");
  if (advanced !== undefined && !isImageRecord(advanced)) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "ImageServer advancedQueryCapabilities metadata must be an object.",
    );
  }
  const queryAdvertised = executableImageQueryAdvertised(advertised, operations);
  return queryAdvertised && readImageOwn(advanced ?? Object.freeze({}), "supportsPagination") === true;
}

function imageSourceSnapshot(
  target: ConnectTarget,
  metadata: Readonly<Record<string, unknown>>,
  evidence: readonly DiscoveryCapabilityEvidence[],
  sourceSchemaProjection?: ConnectSourceSchemaProjection,
): ConnectDiscoverySourceSnapshot {
  const serviceId = target.serviceId;
  if (!serviceId) throw new HonuaDiscoveryError("invalid-endpoint", "ImageServer discovery requires a service id.");
  const schema = imageSourceSchema(metadata);
  const title = readImageString(metadata, "name") ?? serviceId.split("/").at(-1) ?? serviceId;
  const description = readImageString(metadata, "serviceDescription") ?? readImageString(metadata, "description");
  const schemaV2 = sourceSchemaProjection?.geoservicesImage(metadata, {
    source: target.endpoint,
    protocol: "geoservices-image-service",
  });
  return Object.freeze({
    id: serviceId,
    locator: Object.freeze({ url: target.clientBaseUrl, serviceId }),
    title,
    ...(description ? { description } : {}),
    ...(schemaV2 ? { schemaV2 } : {}),
    ...(schema ? { schema } : {}),
    evidence,
  });
}

function imageCapabilityEvidence(
  metadata: Readonly<Record<string, unknown>>,
  serviceUrl: string,
  provenance: readonly DiscoveryProvenance[],
): readonly DiscoveryCapabilityEvidence[] {
  const advertised = imageCapabilityTokens(metadata);
  const operations = imageOperationNames(metadata, serviceUrl);
  const advancedValue = readImageOwn(metadata, "advancedQueryCapabilities");
  if (advancedValue !== undefined && !isImageRecord(advancedValue)) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "ImageServer advancedQueryCapabilities metadata must be an object.",
    );
  }
  const tileInfo = readImageOwn(metadata, "tileInfo");
  if (tileInfo !== undefined && !isImageRecord(tileInfo)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "ImageServer tileInfo metadata must be an object.");
  }
  const capabilities: Capability[] = [];
  const queryAdvertised = executableImageQueryAdvertised(advertised, operations);
  if (queryAdvertised) {
    const supportsReturningQueryExtent = advancedValue
      ? readImageOwn(advancedValue, "supportsReturningQueryExtent")
      : undefined;
    if (supportsReturningQueryExtent !== undefined && typeof supportsReturningQueryExtent !== "boolean") {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        "ImageServer supportsReturningQueryExtent metadata must be boolean.",
      );
    }
    capabilities.push("queryObjectIds");
    if (supportsReturningQueryExtent !== false) capabilities.push("queryExtent");
    if (advancedValue && readImageOwn(advancedValue, "supportsPagination") === true) capabilities.push("query");
  }
  if (advertised.has("image") || operations.names.has("exportimage")) capabilities.push("image", "render");
  if (tileInfo || operations.names.has("tile")) capabilities.push("tiles");
  if (advertised.size === 0 && !operations.present && !tileInfo) {
    return Object.freeze([
      Object.freeze({
        kind: "unavailable" as const,
        scope: IMAGE_SERVICE_SCOPE,
        reason: "ImageServer metadata did not advertise capabilities, operations, or tile metadata.",
        provenance,
      }),
    ]);
  }
  return Object.freeze([
    Object.freeze({
      kind: "metadata" as const,
      capabilities: Object.freeze([...new Set(capabilities)]),
      scope: IMAGE_SERVICE_SCOPE,
      provenance,
    }),
  ]);
}

function imageCapabilityTokens(metadata: Readonly<Record<string, unknown>>): ReadonlySet<string> {
  const raw = readImageOwn(metadata, "capabilities");
  if (raw === undefined) return new Set();
  if (typeof raw !== "string") {
    throw new HonuaDiscoveryError("invalid-endpoint", "ImageServer capabilities metadata must be a string.");
  }
  const trimmed = raw.trim();
  if (!trimmed) return new Set();
  return new Set(
    boundedImageString(trimmed, "capabilities")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function imageOperationNames(
  metadata: Readonly<Record<string, unknown>>,
  serviceUrl: string,
): {
  readonly names: ReadonlySet<string>;
  readonly present: boolean;
  readonly queryExecutable: boolean;
} {
  const names = new Set<string>();
  let present = false;
  let queryExecutable = false;
  for (const key of ["supportedOperations", "operations"] as const) {
    const raw = readImageOwn(metadata, key);
    if (raw === undefined) continue;
    present = true;
    if (!Array.isArray(raw) || raw.length > 1_000) {
      throw new HonuaDiscoveryError("invalid-endpoint", `ImageServer ${key} metadata must be a bounded array.`);
    }
    for (const entry of raw) {
      const object = typeof entry === "string" ? undefined : requireImageRecord(entry, `${key} operation`);
      const value =
        typeof entry === "string"
          ? boundedImageString(entry, `${key} operation`)
          : (readImageString(object as Readonly<Record<string, unknown>>, "name") ??
            readImageString(object as Readonly<Record<string, unknown>>, "id"));
      if (!value) throw new HonuaDiscoveryError("invalid-endpoint", `ImageServer ${key} operation is missing a name.`);
      const name = value.toLowerCase().replace(/[^a-z0-9]/g, "");
      names.add(name);
      if (name === "query") {
        queryExecutable =
          canonicalImageQueryHref(serviceUrl, object) && imageOperationSupportsGet(object, `${key} query operation`);
      }
    }
  }
  return { names, present, queryExecutable };
}

function executableImageQueryAdvertised(
  advertised: ReadonlySet<string>,
  operations: ReturnType<typeof imageOperationNames>,
): boolean {
  if (operations.names.has("query")) return operations.queryExecutable;
  return advertised.has("catalog") || advertised.has("query");
}

function canonicalImageQueryHref(
  serviceUrl: string,
  operation: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const advertised = operation ? (readImageString(operation, "href") ?? readImageString(operation, "url")) : undefined;
  let resolved: URL;
  try {
    resolved = new URL(advertised ?? "query", `${serviceUrl.replace(/\/$/, "")}/`);
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", "ImageServer metadata contains an invalid query URL.");
  }
  const root = new URL(serviceUrl);
  const removableFormat = [...resolved.searchParams].every(
    ([name, value]) =>
      (name.toLowerCase() === "f" || name.toLowerCase() === "format") &&
      (value.toLowerCase() === "json" || value.toLowerCase() === "pjson"),
  );
  if (
    resolved.origin !== root.origin ||
    resolved.username ||
    resolved.password ||
    resolved.hash ||
    (resolved.search && !removableFormat) ||
    (resolved.pathname !== root.pathname && !resolved.pathname.startsWith(`${root.pathname.replace(/\/$/, "")}/`))
  ) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "ImageServer query URLs must stay within the credential-free service root.",
    );
  }
  resolved.search = "";
  const canonical = new URL("query", `${serviceUrl.replace(/\/$/, "")}/`);
  return resolved.toString().replace(/\/$/, "") === canonical.toString().replace(/\/$/, "");
}

function imageOperationSupportsGet(operation: Readonly<Record<string, unknown>> | undefined, label: string): boolean {
  if (!operation) return true;
  const raw = readImageOwn(operation, "methods");
  if (raw === undefined) return true;
  if (!Array.isArray(raw) || raw.length > 16) {
    throw new HonuaDiscoveryError("invalid-endpoint", `ImageServer ${label} methods must be a bounded array.`);
  }
  const methods = raw.map((value) => {
    if (typeof value !== "string" || !["GET", "POST"].includes(value.toUpperCase())) {
      throw new HonuaDiscoveryError("invalid-endpoint", "ImageServer operation methods may contain only GET or POST.");
    }
    return value.toUpperCase();
  });
  return methods.includes("GET");
}

function imageSourceSchema(metadata: Readonly<Record<string, unknown>>): SourceSchema | undefined {
  const raw = readImageOwn(metadata, "fields");
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 10_000) {
    throw new HonuaDiscoveryError("invalid-endpoint", "ImageServer fields metadata must be a bounded array.");
  }
  const fields: HonuaFieldInfo[] = raw.map((entry) => {
    const field = requireImageRecord(entry, "ImageServer field");
    const name = readImageString(field, "name");
    const type = readImageString(field, "type");
    if (!name || !type) throw new HonuaDiscoveryError("invalid-endpoint", "ImageServer fields require name and type.");
    const lengthValue = readImageOwn(field, "length");
    if (lengthValue !== undefined && (!Number.isSafeInteger(lengthValue) || (lengthValue as number) < 0)) {
      throw new HonuaDiscoveryError("invalid-endpoint", "ImageServer field length must be a non-negative integer.");
    }
    const nullable = readImageOwn(field, "nullable");
    const editable = readImageOwn(field, "editable");
    if (nullable !== undefined && typeof nullable !== "boolean") {
      throw new HonuaDiscoveryError("invalid-endpoint", "ImageServer field nullable must be boolean.");
    }
    if (editable !== undefined && typeof editable !== "boolean") {
      throw new HonuaDiscoveryError("invalid-endpoint", "ImageServer field editable must be boolean.");
    }
    const alias = readImageString(field, "alias");
    return Object.freeze({
      name,
      type,
      ...(alias ? { alias } : {}),
      ...(lengthValue !== undefined ? { length: lengthValue as number } : {}),
      ...(nullable !== undefined ? { nullable } : {}),
      ...(editable !== undefined ? { editable } : {}),
    });
  });
  const primaryKey = readImageString(metadata, "objectIdField") ?? readImageString(metadata, "objectIdFieldName");
  return Object.freeze({ fields: Object.freeze(fields), ...(primaryKey ? { primaryKey } : {}) });
}

function requireImageRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isImageRecord(value)) throw new HonuaDiscoveryError("invalid-endpoint", `${label} must be an object.`);
  return value;
}

function isImageRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readImageOwn(record: Readonly<Record<string, unknown>>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if ("get" in descriptor) {
    throw new HonuaDiscoveryError("invalid-endpoint", `ImageServer metadata property "${key}" must be data.`);
  }
  return descriptor.value;
}

function readImageString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = readImageOwn(record, key);
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new HonuaDiscoveryError("invalid-endpoint", `ImageServer metadata property "${key}" must be a string.`);
  }
  return boundedImageString(value, key);
}

function boundedImageString(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 16_384) {
    throw new HonuaDiscoveryError("invalid-endpoint", `ImageServer ${label} must be a bounded non-empty string.`);
  }
  return trimmed;
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
const IMAGE_SERVICE_SCOPE: readonly Capability[] = Object.freeze([
  "query",
  "queryExtent",
  "queryObjectIds",
  "image",
  "render",
  "tiles",
]);

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

/**
 * @internal Shared with the Honua gRPC discovery adapter (`connect-grpc.ts`)
 * so a `protocol: "grpc"` descriptor's capability truth is derived through
 * the exact same algorithm as raw GeoServices REST discovery — parity by
 * construction rather than by a second hand-maintained implementation.
 */
export function capabilitiesFromMetadata(
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
  const hasAttachments =
    "hasAttachments" in metadata
      ? metadata.hasAttachments === true
      : "supportsAttachments" in metadata && metadata.supportsAttachments === true;
  if (hasAttachments) capabilities.add("attachments");
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

/** @internal Shared with `connect-grpc.ts`; see {@link capabilitiesFromMetadata}. */
export function layerUrl(target: ConnectTarget, layerId: number): string {
  return `${target.endpoint.replace(/\/\d+$/, "")}/${layerId}`;
}

/** @internal Shared with `connect-grpc.ts`; see {@link capabilitiesFromMetadata}. */
export function provenanceFor(
  source: string,
  retrievedAt: string,
  value: { readonly cache?: { readonly validator?: { readonly etag?: string; readonly lastModified?: string } } },
): DiscoveryProvenance {
  const validator = value.cache?.validator?.etag ?? value.cache?.validator?.lastModified;
  return Object.freeze({ source, retrievedAt, ...(validator ? { validator } : {}) });
}

/** @internal Shared with `connect-grpc.ts`; see {@link capabilitiesFromMetadata}. */
export async function mapWithConcurrency<T, U>(
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
