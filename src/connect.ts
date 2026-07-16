/**
 * Explicit, fail-closed connection discovery facade.
 *
 * Automatic detection is deliberately structural: canonical GeoServices
 * FeatureServer and MapServer URLs are recognized without trial requests.
 * Ambiguous URLs still require an explicit protocol. No endpoint is probed as
 * a different protocol when discovery fails.
 *
 * @experimental
 */

import {
  type GeoParquetSourceProfile,
  type GeoParquetSourceProfiler,
  discoverGeoParquetSources,
} from "./connect-geoparquet.js";
import { type ConnectTarget, discoverGeoServicesSources, resolveConnectTarget } from "./connect-geoservices.js";
import { discoverGeoServicesWithClient } from "./geoservices-discovery.js";
import { normalizeGeoServicesEndpoint } from "./geoservices-endpoint.js";
export { discoverGeoServices } from "./geoservices-discovery.js";
export type {
  GeoServicesAuthenticationDescriptor,
  GeoServicesAuthenticationRequirement,
  GeoServicesCrsDescriptor,
  GeoServicesDiscoveryDiagnostic,
  GeoServicesDiscoveryDiagnosticCode,
  GeoServicesDiscoveryOptions,
  GeoServicesDiscoveryResult,
  GeoServicesDiscoveryState,
  GeoServicesFormatDescriptor,
  GeoServicesLimitDescriptor,
  GeoServicesOperationAvailability,
  GeoServicesOperationDescriptor,
  GeoServicesOperationExecution,
  GeoServicesServiceDescriptor,
} from "./geoservices-discovery.js";
export type { GeoServicesServiceKind, GeoServicesServiceProtocol } from "./geoservices-endpoint.js";
export type { GeoParquetSourceProfiler } from "./connect-geoparquet.js";
import { discoverOdataSources } from "./connect-odata.js";
import {
  discoverOgcMapsSources,
  discoverOgcProcessesMetadata,
  discoverOgcRecordsSources,
  discoverOgcTilesSources,
} from "./connect-ogc.js";
import type { OgcProcessesDiscoveryResult } from "./connect-ogc.js";
export type {
  OgcProcessDiscoverySummary,
  OgcProcessesDiscoveryResult,
} from "./connect-ogc.js";
import { discoverWfsSources } from "./connect-wfs.js";
import {
  type DiscoveryCacheIdentity,
  type DiscoveryCapabilityEvidence,
  type DiscoveryCapabilityPolicy,
  type DiscoveryCapabilityResolution,
  type DiscoveryDiagnostic,
  type DiscoveryProvenance,
  type SourceDiscoveryInspection,
  createDiscoveryCacheIdentity,
  inspectDiscoveredSource,
  resolveDiscoveryCapabilities,
} from "./contract/discovery.js";
import type { SourceSchemaV2Envelope } from "./contract/schema-envelope.js";
import { normalizeCapabilityDescriptor } from "./contract/source-capability-support.js";
import { createDataset } from "./contract/source.js";
import type {
  CapabilityAwareSource,
  Dataset,
  Protocol,
  SourceDescriptor,
  SourceId,
  SourceLocator,
  SourceResolver,
  SourceSchema,
} from "./contract/types.js";
import type { HonuaMetadataRequestOptions } from "./core/cache-state.js";
import { HonuaClient } from "./core/client.js";
import { HonuaAbortError, HonuaDiscoveryError } from "./core/errors.js";
import type { HonuaOdataMetadata } from "./core/odata.js";
import { negotiateOgcCapabilities } from "./core/ogc-conformance.js";
import { findOgcLink, ogcApiFeaturesLayout } from "./core/ogc-endpoint-layout.js";
import type {
  HonuaClientOptions,
  HonuaLayerMetadata,
  HonuaOgcCollectionSummary,
  HonuaOgcCollectionsResponse,
  HonuaOgcConformanceResponse,
  HonuaOgcLandingResponse,
  HonuaStacLandingResponse,
  OgcEndpointLayout,
} from "./core/types.js";
import type { CapabilityProfile } from "./source-capability-types.js";

export interface ConnectSourceSchemaProjectionContext {
  readonly source: string;
  readonly observedAt?: string;
  readonly validator?:
    | { readonly kind: "etag"; readonly value: string }
    | { readonly kind: "last-modified"; readonly value: string }
    | { readonly kind: "version"; readonly value: string };
}

/**
 * Internal opt-in seam used by the focused `./source-schema` entrypoint.
 * A projector returns `undefined` only when the protocol does not advertise a
 * field inventory. Invalid advertised metadata and projection failures throw.
 */
export interface ConnectSourceSchemaProjection {
  readonly cacheIdentity: string;
  parseCached(value: unknown): SourceSchemaV2Envelope;
  geoServices(
    metadata: HonuaLayerMetadata,
    context: ConnectSourceSchemaProjectionContext & {
      readonly protocol: "geoservices-feature-service" | "geoservices-map-service";
    },
  ): SourceSchemaV2Envelope | undefined;
  odata(
    metadata: HonuaOdataMetadata,
    entitySet: string,
    context: ConnectSourceSchemaProjectionContext,
  ): SourceSchemaV2Envelope | undefined;
  geoParquet(
    profile: GeoParquetSourceProfile,
    context: ConnectSourceSchemaProjectionContext,
  ): SourceSchemaV2Envelope | undefined;
}

export interface ConnectSourceCapabilityProjectionContext {
  /** Retrieval instant of the raw discovery snapshot, including cache hits. */
  readonly observedAt: string;
}

/**
 * Internal opt-in seam used by the focused capability-discovery entrypoint.
 * The projection runs after raw discovery evidence has been validated and
 * policy-resolved, and its evaluated profile is never written to the raw
 * discovery cache.
 */
export interface ConnectSourceCapabilityProjection {
  readonly cacheIdentity: string;
  project(
    descriptor: SourceDescriptor,
    resolution: DiscoveryCapabilityResolution,
    context: ConnectSourceCapabilityProjectionContext,
  ): CapabilityProfile;
}

/** Schema version for values stored through {@link ConnectDiscoveryCache}. */
export const HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION = 5 as const;
/** Adapter version used to invalidate logical discovery identities. */
export const HONUA_CONNECT_ADAPTER_VERSION = "honua-connect@5";
/** Normalized facade projection version used to invalidate cached snapshots. */
export const HONUA_CONNECT_PROJECTION_VERSION = "honua-connect-source-descriptor@3";

export type ConnectProtocolHint = Protocol | "auto";
export type ConnectCacheStatus = "bypass" | "hit" | "miss" | "refreshed";

export interface ConnectDiscoveryCacheContext {
  readonly signal?: AbortSignal;
}

/**
 * Caller-owned cache seam. Values are versioned raw discovery observations;
 * capability policy is reapplied after every read.
 */
export interface ConnectDiscoveryCache {
  get(
    identity: DiscoveryCacheIdentity,
    context: ConnectDiscoveryCacheContext,
  ): ConnectDiscoverySnapshot | undefined | Promise<ConnectDiscoverySnapshot | undefined>;
  set(
    identity: DiscoveryCacheIdentity,
    snapshot: ConnectDiscoverySnapshot,
    context: ConnectDiscoveryCacheContext,
  ): void | Promise<void>;
}

export interface ConnectDiscoverySourceSnapshot {
  readonly id: string;
  readonly locator: SourceLocator;
  readonly title?: string;
  readonly description?: string;
  readonly crs?: readonly string[];
  readonly extent?: ConnectDiscoveryExtent;
  readonly schema?: SourceSchema;
  /** Lightweight identity envelope for an opt-in v2 schema cache payload. */
  readonly schemaV2?: SourceSchemaV2Envelope;
  readonly evidence?: readonly DiscoveryCapabilityEvidence[];
}

/** Normalized collection extent retained without querying collection items. */
interface ConnectDiscoveryExtent {
  readonly spatial?: {
    readonly bbox: readonly (readonly number[])[];
    readonly crs?: string;
  };
  readonly temporal?: {
    readonly interval: readonly (readonly (string | null)[])[];
    readonly trs?: string;
  };
}

/** Serializable, versioned observation persisted through a discovery cache. */
export interface ConnectDiscoverySnapshot {
  readonly version: typeof HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION;
  readonly identityKey: string;
  readonly endpoint: string;
  readonly protocol: ConnectResolvedProtocol;
  readonly retrievedAt: string;
  readonly evidence: readonly DiscoveryCapabilityEvidence[];
  readonly sources: readonly ConnectDiscoverySourceSnapshot[];
}

export interface ConnectOptions {
  /** OGC API, STAC API, WFS 2.0, or canonical GeoServices service/layer URL. */
  readonly endpoint: string | URL;
  /** Protocol hint. `auto` recognizes canonical GeoServices URL structure without probing. */
  readonly protocol: ConnectProtocolHint;
  /** Restrict discovery to one collection while retaining the service root URL. */
  readonly collectionId?: string;
  /** Restrict WFS discovery to one advertised namespace-qualified feature type. */
  readonly typeName?: string;
  /** Optional dataset id; defaults to the redacted normalized endpoint. */
  readonly id?: string;
  /** Stable ACL/audience fingerprint. Never pass a bearer token or API key. */
  readonly authorizationScopeFingerprint: string;
  /** Existing client configured for the endpoint's service root, useful for persistent metadata validators. */
  readonly client?: HonuaClient;
  /** Auth, retry, timeout, interceptor, and fetch options for an owned client. */
  readonly clientOptions?: Omit<HonuaClientOptions, "baseUrl">;
  readonly capabilityPolicy?: DiscoveryCapabilityPolicy;
  readonly cache?: ConnectDiscoveryCache;
  /** Skip a caller cache read and revalidate metadata through the protocol adapter. */
  readonly refresh?: boolean;
  readonly signal?: AbortSignal;
  readonly metadata?: Omit<HonuaMetadataRequestOptions, "signal" | "refresh">;
  /**
   * Resolver for descriptors the built-in resolvers do not handle. Required to
   * execute a discovered `geoparquet` source through `connection.source()`
   * (pass `geoparquetResolver()` from `@honua/sdk-js/geoparquet`); the DuckDB
   * engine must never enter the connect static graph, so it is injected here.
   */
  readonly resolveSource?: SourceResolver;
  /** GeoParquet / static-file discovery inputs; required for `protocol: "geoparquet"`. */
  readonly geoparquet?: {
    /**
     * Footer / `geo` metadata reader. `GeoparquetRuntime` (from
     * `@honua/sdk-js/geoparquet`) satisfies this interface via its `profile()`
     * method, so one runtime can both discover and execute.
     */
    readonly profiler: GeoParquetSourceProfiler;
    /** Additional Parquet files unioned with the endpoint via `read_parquet([...])`. */
    readonly urls?: readonly string[];
    /** Explicit geometry column name (overrides GeoParquet metadata detection). */
    readonly geometryColumn?: string;
  };
}

export interface HonuaConnectionInspection {
  readonly id: string;
  readonly endpoint: string;
  readonly protocol: ConnectResolvedProtocol;
  readonly defaultSourceId?: SourceId;
  readonly sources: readonly SourceDiscoveryInspection[];
  readonly diagnostics: readonly DiscoveryDiagnostic[];
  readonly cacheIdentity: DiscoveryCacheIdentity;
  readonly cacheStatus: ConnectCacheStatus;
}

export interface HonuaConnection {
  readonly id: string;
  readonly dataset: Dataset;
  readonly inspection: HonuaConnectionInspection;
  source<T = Record<string, unknown>>(id?: SourceId): CapabilityAwareSource<T>;
}

/** Source-backed protocols with a reviewed top-level {@link connect} discovery adapter. */
export const CONNECT_SOURCE_PROTOCOLS = [
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
] as const satisfies readonly Protocol[];

export type ConnectResolvedProtocol = (typeof CONNECT_SOURCE_PROTOCOLS)[number];

/**
 * Discover an explicitly identified endpoint and return reviewed descriptors.
 *
 * `auto` uses canonical URL structure only; it never sends trial requests to
 * guess a protocol and never falls back to another authenticated endpoint
 * layout. Unsupported or ambiguous hints fail before client/auth or cache
 * hooks are invoked.
 *
 * @experimental
 */
export async function connect(options: ConnectOptions): Promise<HonuaConnection> {
  return connectWithSourceSchemaProjection(options);
}

/** @internal Focused source-schema entrypoint hook; not exported from root barrels. */
export async function connectWithSourceSchemaProjection(
  options: ConnectOptions,
  sourceSchemaProjection?: ConnectSourceSchemaProjection,
  sourceCapabilityProjection?: ConnectSourceCapabilityProjection,
): Promise<HonuaConnection> {
  throwIfAborted(options.signal);
  const endpoint = validateConnectEndpoint(options.endpoint);
  const target = resolveConnectTarget(endpoint, options.protocol);
  if (
    options.collectionId !== undefined &&
    (typeof options.collectionId !== "string" ||
      !options.collectionId.trim() ||
      options.collectionId.trim() !== options.collectionId)
  ) {
    throw new HonuaDiscoveryError("invalid-endpoint", "collectionId must be a non-empty, trimmed identifier.");
  }
  if (target.protocol !== "ogc-features" && target.protocol !== "stac" && options.collectionId !== undefined) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "collectionId is only valid for OGC API Features or STAC API connections; select a GeoServices layer in the endpoint URL.",
    );
  }
  if (target.protocol !== "wfs" && options.typeName !== undefined) {
    throw new HonuaDiscoveryError("invalid-endpoint", "typeName is only valid for WFS connections.");
  }
  if (options.typeName !== undefined && (!options.typeName.trim() || options.typeName.trim() !== options.typeName)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "WFS typeName must be a non-empty, trimmed identifier.");
  }
  if (options.client && options.clientOptions) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Pass either client or clientOptions to connect(), not both.");
  }
  if (sourceCapabilityProjection && !sourceSchemaProjection) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "Capability-aware discovery requires the focused SourceSchemaV2 projection for source identity binding.",
    );
  }

  // GeoParquet's discovered profile/locator depends on inputs beyond the
  // endpoint URL (the additional file set and geometry-column override), so
  // fold a stable digest of them into the cache identity — otherwise distinct
  // inputs for the same primary asset URL would collide on one cached snapshot.
  const assetVariant = geoParquetAssetVariant(target.protocol, options.geoparquet);

  const focusedProjectionIdentity = [sourceSchemaProjection?.cacheIdentity, sourceCapabilityProjection?.cacheIdentity]
    .filter((value): value is string => value !== undefined)
    .join(":");
  const identity = await createDiscoveryCacheIdentity({
    endpoint: target.endpoint,
    protocol: target.protocol,
    authorizationScopeFingerprint: options.authorizationScopeFingerprint,
    adapterVersion: focusedProjectionIdentity
      ? `${HONUA_CONNECT_ADAPTER_VERSION}:${focusedProjectionIdentity}`
      : HONUA_CONNECT_ADAPTER_VERSION,
    projectionVersion: focusedProjectionIdentity
      ? `${HONUA_CONNECT_PROJECTION_VERSION}:${focusedProjectionIdentity}`
      : HONUA_CONNECT_PROJECTION_VERSION,
    ...(options.collectionId ? { collectionId: options.collectionId } : {}),
    ...(options.typeName ? { typeName: options.typeName } : {}),
    ...(target.serviceId ? { serviceId: target.serviceId } : {}),
    ...(target.layerId !== undefined ? { layerId: target.layerId } : {}),
    ...(assetVariant ? { assetVariant } : {}),
  });
  if (options.client) assertClientEndpoint(options.client, target.clientBaseUrl);
  const cacheContext = Object.freeze({ ...(options.signal ? { signal: options.signal } : {}) });
  let snapshot: ConnectDiscoverySnapshot | undefined;
  let cacheStatus: ConnectCacheStatus = options.cache ? "miss" : "bypass";

  if (options.cache && options.refresh !== true) {
    snapshot = await awaitAbortable(options.cache.get(identity, cacheContext), options.signal);
    throwIfAborted(options.signal);
    if (snapshot) {
      snapshot = validateSnapshot(
        snapshot,
        identity,
        target,
        options.collectionId,
        options.typeName,
        sourceSchemaProjection,
      );
      cacheStatus = "hit";
    }
  }

  const client = options.client ?? new HonuaClient({ ...options.clientOptions, baseUrl: target.clientBaseUrl });
  if (!snapshot) {
    snapshot =
      target.protocol === "ogc-features"
        ? await discoverOgcFeatures(client, identity, options)
        : target.protocol === "stac"
          ? await discoverStac(client, identity, options)
          : target.protocol === "wfs"
            ? await discoverWfs(client, identity, options)
            : target.protocol === "odata"
              ? await discoverOdata(client, identity, target, options, sourceSchemaProjection)
              : target.protocol === "geoparquet"
                ? await discoverGeoParquet(identity, options, sourceSchemaProjection)
                : target.protocol === "ogc-records"
                  ? await discoverOgcRecords(client, identity, target, options)
                  : target.protocol === "ogc-tiles"
                    ? await discoverOgcTiles(client, identity, target, options)
                    : target.protocol === "ogc-maps"
                      ? await discoverOgcMaps(client, identity, target, options)
                      : target.protocol === "geoservices-image-service"
                        ? await discoverGeoServicesImage(client, identity, target, options)
                        : await discoverGeoServices(client, identity, target, options, sourceSchemaProjection);
    if (
      options.cache &&
      (!sourceSchemaProjection ||
        !sourceSchemaProjectionApplies(target.protocol) ||
        snapshot.sources.every((source) => source.schemaV2 !== undefined))
    ) {
      await awaitAbortable(options.cache.set(identity, snapshot, cacheContext), options.signal);
      throwIfAborted(options.signal);
    }
    cacheStatus = options.refresh === true ? "refreshed" : cacheStatus;
  }

  const inspections = Object.freeze(
    snapshot.sources.map((source) => {
      const resolution = resolveDiscoveryCapabilities(
        snapshot.protocol,
        source.evidence ?? snapshot.evidence,
        options.capabilityPolicy,
      );
      const descriptor: SourceDescriptor = {
        id: source.id,
        protocol: snapshot.protocol,
        locator: source.locator,
        capabilities: resolution.capabilities,
        ...(source.schema ? { schema: source.schema } : {}),
        ...(source.schemaV2 ? { schemaV2: source.schemaV2 } : {}),
        ...(source.title ? { attribution: source.title } : {}),
      };
      const discovered = inspectDiscoveredSource(descriptor, resolution);
      const projectedDescriptor = sourceCapabilityProjection
        ? descriptorWithCapabilityProfile(
            discovered.descriptor,
            sourceCapabilityProjection.project(descriptor, resolution, { observedAt: snapshot.retrievedAt }),
          )
        : discovered.descriptor;
      return Object.freeze({
        ...discovered,
        descriptor: projectedDescriptor,
        ...(source.crs || source.extent
          ? {
              metadata: Object.freeze({
                ...(source.crs ? { crs: source.crs } : {}),
                ...(source.extent ? { extent: source.extent } : {}),
              }),
            }
          : {}),
      });
    }),
  );
  const id = options.id?.trim() || identity.endpoint;
  const dataset = createDataset({
    id,
    client,
    sources: inspections.map((entry) => entry.descriptor),
    skipCompatibilityCheck: true,
    ...(options.resolveSource ? { resolveSource: options.resolveSource } : {}),
  });
  const defaultSourceId = inspections.length === 1 ? inspections[0]?.descriptor.id : undefined;
  const inspection: HonuaConnectionInspection = Object.freeze({
    id,
    endpoint: identity.endpoint,
    protocol: snapshot.protocol,
    ...(defaultSourceId ? { defaultSourceId } : {}),
    sources: inspections,
    diagnostics: uniqueDiagnostics(inspections.flatMap((entry) => [...entry.diagnostics])),
    cacheIdentity: identity,
    cacheStatus,
  });

  return Object.freeze({
    id,
    dataset,
    inspection,
    source<T = Record<string, unknown>>(sourceId?: SourceId): CapabilityAwareSource<T> {
      const resolvedId = sourceId ?? defaultSourceId;
      if (!resolvedId) {
        throw new HonuaDiscoveryError(
          "ambiguous-source",
          `Connection has ${inspections.length} sources; pass one of: ${inspections
            .map((entry) => entry.descriptor.id)
            .join(", ")}.`,
          { sourceIds: inspections.map((entry) => entry.descriptor.id) },
        );
      }
      const source = dataset.source<T>(resolvedId);
      if (!source) {
        throw new HonuaDiscoveryError("ambiguous-source", `Unknown source "${resolvedId}".`, {
          sourceId: resolvedId,
          sourceIds: dataset.sourceIds(),
        });
      }
      return source;
    },
  });
}

function descriptorWithCapabilityProfile(
  descriptor: SourceDescriptor,
  capabilityProfile: CapabilityProfile,
): SourceDescriptor {
  return Object.freeze(normalizeCapabilityDescriptor({ ...descriptor, capabilityProfile }));
}

/** Options for {@link discoverOgcProcesses}. */
export interface OgcProcessesDiscoveryOptions {
  /** OGC API Processes service root URL (facade or third-party). */
  readonly endpoint: string | URL;
  /** Existing client bound to the endpoint origin (mutually exclusive with clientOptions). */
  readonly client?: HonuaClient;
  /** Auth, retry, timeout, interceptor, and fetch options for an owned client. */
  readonly clientOptions?: Omit<HonuaClientOptions, "baseUrl">;
  readonly signal?: AbortSignal;
  /** Skip a metadata cache read and revalidate through the protocol adapter. */
  readonly refresh?: boolean;
  readonly metadata?: Omit<HonuaMetadataRequestOptions, "signal" | "refresh">;
}

/**
 * Discover a raw (third-party) OGC API Processes service as a
 * capability/metadata result.
 *
 * OGC API Processes is deliberately **not** a Source-backed protocol: a process
 * is an invocable operation, not a queryable dataset, so it never becomes a
 * `connect()` `Source`. This function is the raw-Processes counterpart to
 * `connect()` — it threads the discovered service-root path through the
 * Processes wire methods (the same `basePath` seam the Tiles / Maps / Records
 * adapters use), performs three bounded metadata requests (landing,
 * conformance, process list), and returns the advertised process list plus the
 * effective `processes` capability intersected from conformance. A service that
 * advertises no Processes conformance reports an empty capability set with a
 * structured diagnostic rather than inventing support.
 *
 * @experimental
 */
export async function discoverOgcProcesses(
  options: OgcProcessesDiscoveryOptions,
): Promise<OgcProcessesDiscoveryResult> {
  throwIfAborted(options.signal);
  const endpoint = validateConnectEndpoint(options.endpoint);
  if (options.client && options.clientOptions) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "Pass either client or clientOptions to discoverOgcProcesses(), not both.",
    );
  }
  const url = new URL(endpoint);
  // A raw OGC API Processes service root is mounted under a path (or at the
  // origin). Bind the client to the origin and carry the service-root prefix so
  // landing / conformance / process-list requests resolve against the same
  // advertised layout — identical to the raw OGC Records / Tiles / Maps seam.
  const basePath = url.pathname && url.pathname !== "/" ? url.pathname : "";
  const clientBaseUrl = url.origin;
  if (options.client) assertClientEndpoint(options.client, clientBaseUrl);
  const client = options.client ?? new HonuaClient({ ...options.clientOptions, baseUrl: clientBaseUrl });
  return discoverOgcProcessesMetadata(client, endpoint, basePath, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.refresh !== undefined ? { refresh: options.refresh } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
}

/**
 * Deterministic per-asset discriminator for GeoParquet discovery: the sorted
 * additional file set plus any geometry-column override. Returns `undefined`
 * for other protocols or when no discriminating input is present so the cache
 * key is unchanged for the common single-file case.
 */
function geoParquetAssetVariant(
  protocol: ConnectResolvedProtocol,
  geoparquet: ConnectOptions["geoparquet"],
): string | undefined {
  if (protocol !== "geoparquet" || !geoparquet) return undefined;
  const urls = Array.isArray(geoparquet.urls) ? [...geoparquet.urls].sort() : [];
  const geometryColumn = geoparquet.geometryColumn ?? "";
  if (urls.length === 0 && geometryColumn === "") return undefined;
  return JSON.stringify({ urls, geometryColumn });
}

function validateConnectEndpoint(input: string | URL): string {
  let endpoint: URL;
  try {
    endpoint = new URL(input.toString());
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", "connect() endpoints must be absolute HTTP(S) URLs.");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new HonuaDiscoveryError("invalid-endpoint", "connect() endpoints must use HTTP or HTTPS.");
  }
  const formatQueryIsRemovable =
    endpoint.searchParams.size > 0 &&
    [...endpoint.searchParams].every(
      ([name, value]) =>
        (name.toLowerCase() === "f" || name.toLowerCase() === "format") &&
        (value.toLowerCase() === "json" || value.toLowerCase() === "pjson"),
    );
  if (endpoint.username || endpoint.password || (endpoint.search && !formatQueryIsRemovable) || endpoint.hash) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "connect() endpoints must not contain credentials, identity-bearing query parameters, or fragments; configure authentication through clientOptions.",
    );
  }
  if (formatQueryIsRemovable) endpoint.search = "";
  while (endpoint.pathname.length > 1 && endpoint.pathname.endsWith("/")) {
    endpoint.pathname = endpoint.pathname.slice(0, -1);
  }
  const normalized = endpoint.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function assertClientEndpoint(client: HonuaClient, endpoint: string): void {
  const clientEndpoint = validateConnectEndpoint(client.serverBaseUrl);
  if (clientEndpoint !== endpoint) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "The injected HonuaClient base URL must exactly match the connect() endpoint.",
      { endpoint, clientEndpoint },
    );
  }
}

function awaitAbortable<T>(value: T | Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const pending = Promise.resolve(value);
  if (!signal) return pending;
  if (signal.aborted) {
    void pending.catch(() => undefined);
    throw new HonuaAbortError();
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(new HonuaAbortError()));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function discoverOgcFeatures(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  options: ConnectOptions,
): Promise<ConnectDiscoverySnapshot> {
  const request: HonuaMetadataRequestOptions = {
    ...options.metadata,
    ...(options.signal ? { signal: options.signal } : {}),
    refresh: options.refresh === true,
  };
  const initialLayout = layoutFromEndpoint(identity.endpoint);
  const landing = await client.getOgcFeaturesLanding({ ...request, layout: initialLayout });
  const layout = layoutFromLanding(identity.endpoint, landing);
  const [conformance, collections] = await Promise.all([
    client.getOgcFeaturesConformance({ ...request, layout }),
    client.listOgcCollections({ ...request, layout }),
  ]);
  throwIfAborted(options.signal);

  const selected = selectCollections(collections, options.collectionId);
  const retrievedAt = new Date().toISOString();
  const provenance = metadataProvenance(layout, retrievedAt, landing, conformance, collections);
  const advertised = [...negotiateOgcCapabilities("ogc-features", conformance)];
  const evidence: readonly DiscoveryCapabilityEvidence[] = Object.freeze([
    Object.freeze({ kind: "metadata" as const, capabilities: Object.freeze(advertised), provenance }),
  ]);
  return Object.freeze({
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: identity.key,
    endpoint: identity.endpoint,
    protocol: "ogc-features",
    retrievedAt,
    evidence,
    sources: Object.freeze(selected.map((source) => discoveredOgcSourceSnapshot(identity.endpoint, source))),
  });
}

async function discoverStac(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  options: ConnectOptions,
): Promise<ConnectDiscoverySnapshot> {
  const request: HonuaMetadataRequestOptions = {
    ...options.metadata,
    ...(options.signal ? { signal: options.signal } : {}),
    refresh: options.refresh === true,
  };
  const landing = await client.getStacLanding({ ...request, stacBasePath: "" });
  throwIfAborted(options.signal);
  const advertised = validateStacLanding(identity.endpoint, landing);
  const collections = await client.listStacCollections({ ...request, stacBasePath: "" });
  throwIfAborted(options.signal);

  const selected = selectCollections(collections, options.collectionId, "STAC API");
  const retrievedAt = new Date().toISOString();
  const provenance = stacMetadataProvenance(identity.endpoint, retrievedAt, landing, collections);
  const capabilities = advertised.itemSearch
    ? Object.freeze(["query", "queryObjectIds", "stream"] as const)
    : Object.freeze([]);
  const evidence: readonly DiscoveryCapabilityEvidence[] = Object.freeze([
    Object.freeze({
      kind: "metadata" as const,
      capabilities,
      scope: Object.freeze(["query", "queryObjectIds", "stream"] as const),
      provenance,
    }),
  ]);
  return Object.freeze({
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: identity.key,
    endpoint: identity.endpoint,
    protocol: "stac",
    retrievedAt,
    evidence,
    sources: Object.freeze(selected.map((source) => discoveredStacSourceSnapshot(identity.endpoint, source))),
  });
}

async function discoverGeoServices(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  target: ConnectTarget,
  options: ConnectOptions,
  sourceSchemaProjection: ConnectSourceSchemaProjection | undefined,
): Promise<ConnectDiscoverySnapshot> {
  const discovered = await discoverGeoServicesSources(client, target, options, sourceSchemaProjection);
  return Object.freeze({
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: identity.key,
    endpoint: identity.endpoint,
    protocol: target.protocol,
    retrievedAt: discovered.retrievedAt,
    evidence: Object.freeze([]),
    sources: discovered.sources,
  });
}

async function discoverGeoServicesImage(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  target: ConnectTarget,
  options: ConnectOptions,
): Promise<ConnectDiscoverySnapshot> {
  const classified = normalizeGeoServicesEndpoint(target.endpoint);
  const discovered = await discoverGeoServicesWithClient(client, classified, options);
  return Object.freeze({
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: identity.key,
    endpoint: identity.endpoint,
    protocol: "geoservices-image-service",
    retrievedAt: discovered.retrievedAt,
    evidence: discovered.evidence,
    sources: discovered.sourceSnapshots,
  });
}

async function discoverWfs(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  options: ConnectOptions,
): Promise<ConnectDiscoverySnapshot> {
  const discovered = await discoverWfsSources(client, identity, options);
  return Object.freeze({
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: identity.key,
    endpoint: identity.endpoint,
    protocol: "wfs",
    retrievedAt: discovered.retrievedAt,
    evidence: discovered.evidence,
    sources: discovered.sources,
  });
}

async function discoverOdata(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  target: ConnectTarget,
  options: ConnectOptions,
  sourceSchemaProjection: ConnectSourceSchemaProjection | undefined,
): Promise<ConnectDiscoverySnapshot> {
  const discovered = await discoverOdataSources(
    client,
    identity,
    target.odataBasePath ?? "/odata",
    options,
    sourceSchemaProjection,
  );
  return Object.freeze({
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: identity.key,
    endpoint: identity.endpoint,
    protocol: "odata",
    retrievedAt: discovered.retrievedAt,
    evidence: discovered.evidence,
    sources: discovered.sources,
  });
}

async function discoverOgcRecords(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  target: ConnectTarget,
  options: ConnectOptions,
): Promise<ConnectDiscoverySnapshot> {
  const discovered = await discoverOgcRecordsSources(
    client,
    identity,
    target.clientBaseUrl,
    target.ogcBasePath ?? "",
    options,
  );
  return Object.freeze({
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: identity.key,
    endpoint: identity.endpoint,
    protocol: "ogc-records",
    retrievedAt: discovered.retrievedAt,
    evidence: discovered.evidence,
    sources: discovered.sources,
  });
}

async function discoverOgcTiles(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  target: ConnectTarget,
  options: ConnectOptions,
): Promise<ConnectDiscoverySnapshot> {
  const discovered = await discoverOgcTilesSources(
    client,
    identity,
    target.clientBaseUrl,
    target.ogcBasePath ?? "",
    options,
  );
  return Object.freeze({
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: identity.key,
    endpoint: identity.endpoint,
    protocol: "ogc-tiles",
    retrievedAt: discovered.retrievedAt,
    evidence: discovered.evidence,
    sources: discovered.sources,
  });
}

async function discoverOgcMaps(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  target: ConnectTarget,
  options: ConnectOptions,
): Promise<ConnectDiscoverySnapshot> {
  const discovered = await discoverOgcMapsSources(
    client,
    identity,
    target.clientBaseUrl,
    target.ogcBasePath ?? "",
    options,
  );
  return Object.freeze({
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: identity.key,
    endpoint: identity.endpoint,
    protocol: "ogc-maps",
    retrievedAt: discovered.retrievedAt,
    evidence: discovered.evidence,
    sources: discovered.sources,
  });
}

async function discoverGeoParquet(
  identity: DiscoveryCacheIdentity,
  options: ConnectOptions,
  sourceSchemaProjection: ConnectSourceSchemaProjection | undefined,
): Promise<ConnectDiscoverySnapshot> {
  const profiler = options.geoparquet?.profiler;
  if (!profiler) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "GeoParquet discovery requires a footer metadata reader; pass geoparquet.profiler (for example a GeoparquetRuntime from @honua/sdk-js/geoparquet).",
    );
  }
  const discovered = await discoverGeoParquetSources(profiler, identity, options, sourceSchemaProjection);
  return Object.freeze({
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: identity.key,
    endpoint: identity.endpoint,
    protocol: "geoparquet",
    retrievedAt: discovered.retrievedAt,
    evidence: discovered.evidence,
    sources: discovered.sources,
  });
}

function layoutFromEndpoint(endpoint: string): OgcEndpointLayout {
  const root = endpoint.replace(/\/+$/, "");
  return ogcApiFeaturesLayout({
    landingUrl: root,
    collectionsUrl: `${root}/collections`,
    conformanceUrl: `${root}/conformance`,
  });
}

function layoutFromLanding(endpoint: string, landing: HonuaOgcLandingResponse): OgcEndpointLayout {
  const root = endpoint.replace(/\/+$/, "");
  return ogcApiFeaturesLayout({
    landingUrl: root,
    collectionsUrl: resolveAdvertisedUrl(findOgcLink(landing.links, "data"), root, "collections"),
    conformanceUrl: resolveAdvertisedUrl(findOgcLink(landing.links, "conformance"), root, "conformance"),
  });
}

function resolveAdvertisedUrl(href: string | undefined, endpoint: string, fallback: string): string {
  if (!href) return `${endpoint}/${fallback}`;
  try {
    const resolved = new URL(href, endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
    if (resolved.username || resolved.password) {
      throw new HonuaDiscoveryError("invalid-endpoint", `OGC ${fallback} links must not contain credentials.`);
    }
    const queryNames = [...resolved.searchParams.keys()].map((name) => name.toLowerCase());
    if (queryNames.some((name) => name !== "f" && name !== "format")) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `OGC ${fallback} links may only carry a removable format query parameter.`,
        { href },
      );
    }
    resolved.search = "";
    resolved.hash = "";
    return resolved.toString();
  } catch (cause) {
    if (cause instanceof HonuaDiscoveryError) throw cause;
    throw new HonuaDiscoveryError("invalid-endpoint", `OGC landing page contains an invalid ${fallback} link.`, {
      href,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function selectCollections(
  response: HonuaOgcCollectionsResponse,
  collectionId: string | undefined,
  family = "OGC API Features",
): readonly HonuaOgcCollectionSummary[] {
  if (!Array.isArray(response.collections) || response.collections.length === 0) {
    throw new HonuaDiscoveryError("invalid-endpoint", `${family} discovery returned no collections.`);
  }
  const seen = new Set<string>();
  for (const collection of response.collections) {
    if (typeof collection.id !== "string" || collection.id.length === 0 || seen.has(collection.id)) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        "OGC collection identifiers must be unique non-empty strings.",
        {
          collectionId: collection.id,
        },
      );
    }
    seen.add(collection.id);
  }
  if (!collectionId) return response.collections;
  const selected = response.collections.find((collection) => collection.id === collectionId);
  if (!selected) {
    throw new HonuaDiscoveryError("ambiguous-source", `Collection "${collectionId}" was not advertised.`, {
      collectionId,
      sourceIds: response.collections.map((collection) => collection.id),
    });
  }
  return [selected];
}

function validateStacLanding(endpoint: string, landing: HonuaStacLandingResponse): { readonly itemSearch: boolean } {
  if (!Array.isArray(landing.conformsTo) || landing.conformsTo.some((entry) => typeof entry !== "string")) {
    throw new HonuaDiscoveryError("invalid-endpoint", "STAC API landing metadata must contain a conformsTo array.");
  }
  if (landing.links !== undefined && !Array.isArray(landing.links)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "STAC API landing links must be an array.");
  }
  if (
    landing.links?.some((link) => !isPlainObject(link) || typeof link.rel !== "string" || typeof link.href !== "string")
  ) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "STAC API landing links must contain string rel and href values.",
    );
  }
  const core = landing.conformsTo.some((entry) => isStacApiConformance(entry, "core"));
  const itemSearch = landing.conformsTo.some((entry) => isStacApiConformance(entry, "item-search"));
  const searchLinks = (landing.links ?? []).filter((link) => link.rel?.toLowerCase() === "search");
  const dataLinks = (landing.links ?? []).filter((link) => link.rel?.toLowerCase() === "data");
  if (!core) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "STAC API discovery requires exact STAC API Core 1.0.0 conformance.",
    );
  }
  if (dataLinks.length === 0) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "STAC API Core discovery requires an advertised collections data link.",
    );
  }
  for (const link of dataLinks) validateStacOperationLink(endpoint, link.href, "collections");
  if (itemSearch && searchLinks.length === 0) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "STAC API item-search conformance requires an advertised search link.",
    );
  }
  for (const link of searchLinks) validateStacOperationLink(endpoint, link.href, "search");
  return Object.freeze({ itemSearch });
}

function isStacApiConformance(value: string, conformance: "core" | "item-search"): boolean {
  try {
    const uri = new URL(value);
    return (
      uri.protocol === "https:" &&
      uri.origin === "https://api.stacspec.org" &&
      uri.username === "" &&
      uri.password === "" &&
      uri.search === "" &&
      uri.hash === "" &&
      uri.pathname.replace(/\/+$/, "") === `/v1.0.0/${conformance}`
    );
  } catch {
    return false;
  }
}

function validateStacOperationLink(endpoint: string, href: string, operation: "search" | "collections"): void {
  let resolved: URL;
  try {
    resolved = new URL(href, endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", `STAC API contains an invalid ${operation} link.`);
  }
  const root = new URL(endpoint);
  const expectedPath = `${root.pathname.replace(/\/+$/, "")}/${operation}`;
  if (
    resolved.origin !== root.origin ||
    resolved.username ||
    resolved.password ||
    resolved.search ||
    resolved.hash ||
    resolved.pathname.replace(/\/+$/, "") !== expectedPath
  ) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `STAC API ${operation} link must resolve to the credential-free operation under the connected service root.`,
    );
  }
}

function discoveredStacSourceSnapshot(
  endpoint: string,
  source: HonuaOgcCollectionSummary,
): ConnectDiscoverySourceSnapshot {
  return Object.freeze({
    id: source.id,
    locator: Object.freeze({ url: endpoint, collectionId: source.id, layout: "stac-api" as const }),
    ...(source.title ? { title: source.title } : {}),
    ...(source.description ? { description: source.description } : {}),
    ...(source.crs ? { crs: immutableStrings(source.crs, "STAC collection crs") } : {}),
    ...(source.extent ? { extent: normalizeCollectionExtent(source.extent) } : {}),
  });
}

function normalizeCollectionExtent(source: {
  readonly spatial?: { readonly bbox?: readonly (readonly number[])[]; readonly crs?: string };
  readonly temporal?: {
    readonly interval?: readonly (readonly (string | null)[])[];
    readonly trs?: string;
  };
}): ConnectDiscoveryExtent {
  const spatial = source.spatial?.bbox;
  const temporal = source.temporal?.interval;
  if (spatial !== undefined && (!Array.isArray(spatial) || spatial.some((bbox) => !validBbox(bbox)))) {
    throw new HonuaDiscoveryError("invalid-endpoint", "STAC collection spatial extent contains an invalid bbox.");
  }
  if (
    temporal !== undefined &&
    (!Array.isArray(temporal) ||
      temporal.some(
        (interval) =>
          !Array.isArray(interval) ||
          interval.length !== 2 ||
          interval.some((value) => value !== null && (typeof value !== "string" || Number.isNaN(Date.parse(value)))),
      ))
  ) {
    throw new HonuaDiscoveryError("invalid-endpoint", "STAC collection temporal extent contains an invalid interval.");
  }
  return Object.freeze({
    ...(spatial
      ? {
          spatial: Object.freeze({
            bbox: Object.freeze(spatial.map((bbox) => Object.freeze([...bbox]))),
            ...(source.spatial?.crs
              ? { crs: immutableString(source.spatial.crs, "STAC collection spatial extent crs") }
              : {}),
          }),
        }
      : {}),
    ...(temporal
      ? {
          temporal: Object.freeze({
            interval: Object.freeze(temporal.map((interval) => Object.freeze([...interval]))),
            ...(source.temporal?.trs
              ? { trs: immutableString(source.temporal.trs, "STAC collection temporal extent trs") }
              : {}),
          }),
        }
      : {}),
  });
}

function validBbox(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    (value.length === 4 || value.length === 6) &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry)) &&
    value[0]! <= value[value.length / 2]! &&
    value[1]! <= value[value.length / 2 + 1]! &&
    (value.length === 4 || value[2]! <= value[5]!)
  );
}

function immutableStrings(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) {
    throw new HonuaDiscoveryError("invalid-endpoint", `${label} must contain non-empty strings.`);
  }
  return Object.freeze([...values]);
}

function immutableString(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HonuaDiscoveryError("invalid-endpoint", `${label} must be a non-empty string.`);
  }
  return value;
}

function stacMetadataProvenance(
  endpoint: string,
  retrievedAt: string,
  landing: HonuaStacLandingResponse,
  collections: HonuaOgcCollectionsResponse,
): readonly DiscoveryProvenance[] {
  return Object.freeze(
    [
      { source: endpoint, value: landing },
      { source: `${endpoint}/collections`, value: collections },
    ].map(({ source, value }) => {
      const validator = value.cache?.validator?.etag ?? value.cache?.validator?.lastModified;
      return Object.freeze({ source, retrievedAt, ...(validator ? { validator } : {}) });
    }),
  );
}

function discoveredOgcSourceSnapshot(
  endpoint: string,
  source: HonuaOgcCollectionSummary,
): ConnectDiscoverySourceSnapshot {
  return Object.freeze({
    id: source.id,
    locator: Object.freeze({ url: endpoint, collectionId: source.id, layout: "ogc-api" as const }),
    ...(source.title ? { title: source.title } : {}),
    ...(source.description ? { description: source.description } : {}),
    ...(source.crs ? { crs: Object.freeze([...source.crs]) } : {}),
  });
}

function metadataProvenance(
  layout: OgcEndpointLayout,
  retrievedAt: string,
  ...values: Array<{
    readonly cache?: { readonly validator?: { readonly etag?: string; readonly lastModified?: string } };
  }>
): readonly DiscoveryProvenance[] {
  const names = [layout.landing(), layout.conformance(), layout.collections()];
  return Object.freeze(
    values.map((value, index) => {
      const validator = value.cache?.validator?.etag ?? value.cache?.validator?.lastModified;
      return Object.freeze({
        source: names[index] ?? layout.landing(),
        retrievedAt,
        ...(validator ? { validator } : {}),
      });
    }),
  );
}

function validateSnapshot(
  value: ConnectDiscoverySnapshot,
  identity: DiscoveryCacheIdentity,
  target: ConnectTarget,
  collectionId: string | undefined,
  typeName: string | undefined,
  sourceSchemaProjection: ConnectSourceSchemaProjection | undefined,
): ConnectDiscoverySnapshot {
  const projectionApplies = Boolean(sourceSchemaProjection && sourceSchemaProjectionApplies(target.protocol));
  const owned = snapshotCacheData(value);
  if (
    owned.version !== HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION ||
    owned.identityKey !== identity.key ||
    owned.endpoint !== identity.endpoint ||
    owned.protocol !== target.protocol ||
    typeof owned.retrievedAt !== "string" ||
    !owned.retrievedAt ||
    !Array.isArray(owned.evidence) ||
    !Array.isArray(owned.sources) ||
    owned.sources.length === 0
  ) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Discovery cache returned an incompatible snapshot.", {
      expectedVersion: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
      expectedIdentityKey: identity.key,
    });
  }
  const sharedEvidence = validateCachedEvidence(target.protocol, owned.evidence, true);
  const sourceIds = new Set<string>();
  const sources = owned.sources.map((source) => {
    if (!source || typeof source.id !== "string" || !source.id || !isPlainObject(source.locator)) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Discovery cache contains an invalid source.");
    }
    if (sourceIds.has(source.id)) {
      throw new HonuaDiscoveryError(
        "invalid-discovery-cache",
        "Discovery cache source identifiers must be unique non-empty strings.",
      );
    }
    sourceIds.add(source.id);
    validateSnapshotLocator(source.id, source.locator, target);
    if (source.schema?.fields !== undefined && !Array.isArray(source.schema.fields)) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached source schema fields must be an array.");
    }
    let schemaV2: SourceSchemaV2Envelope | undefined;
    if (source.schemaV2 !== undefined) {
      if (!sourceSchemaProjection || !projectionApplies) {
        throw new HonuaDiscoveryError(
          "invalid-discovery-cache",
          "Cached source schemaV2 requires the focused source-schema connection path.",
        );
      }
      try {
        schemaV2 = sourceSchemaProjection.parseCached(source.schemaV2);
      } catch (cause) {
        throw new HonuaDiscoveryError(
          "invalid-discovery-cache",
          "Cached source schemaV2 is invalid or its fingerprint has drifted.",
          undefined,
          { cause },
        );
      }
    } else if (projectionApplies) {
      throw new HonuaDiscoveryError(
        "invalid-discovery-cache",
        "Focused discovery cache source is missing its validated schemaV2 payload.",
      );
    }
    if (source.evidence !== undefined && (!Array.isArray(source.evidence) || source.evidence.length === 0)) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached source evidence must be a non-empty array.");
    }
    if (source.evidence === undefined && sharedEvidence.length === 0) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached source has no capability evidence.");
    }
    const sourceEvidence = source.evidence
      ? validateCachedEvidence(target.protocol, source.evidence, false)
      : undefined;
    return Object.freeze({
      id: source.id,
      locator: Object.freeze({ ...source.locator }),
      ...(source.title ? { title: source.title } : {}),
      ...(source.description ? { description: source.description } : {}),
      ...(source.crs ? { crs: immutableStrings(source.crs, "Cached source crs") } : {}),
      ...(source.extent ? { extent: validateCachedDiscoveryExtent(source.extent) } : {}),
      ...(source.schema
        ? {
            schema: Object.freeze({
              ...source.schema,
              ...(source.schema.fields ? { fields: Object.freeze([...source.schema.fields]) } : {}),
            }),
          }
        : {}),
      ...(schemaV2 ? { schemaV2 } : {}),
      ...(sourceEvidence ? { evidence: sourceEvidence } : {}),
    });
  });
  if (collectionId && (sources.length !== 1 || String(sources[0]?.locator.collectionId ?? "") !== collectionId)) {
    throw new HonuaDiscoveryError(
      "invalid-discovery-cache",
      "Discovery cache snapshot does not match the requested collection.",
      { collectionId },
    );
  }
  if (typeName && (sources.length !== 1 || String(sources[0]?.locator.typeName ?? "") !== typeName)) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Discovery cache snapshot does not match the WFS type.", {
      typeName,
    });
  }
  return Object.freeze({ ...owned, evidence: sharedEvidence, sources: Object.freeze(sources) });
}

function sourceSchemaProjectionApplies(protocol: ConnectResolvedProtocol): boolean {
  return (
    protocol === "odata" ||
    protocol === "geoparquet" ||
    protocol === "geoservices-feature-service" ||
    protocol === "geoservices-map-service"
  );
}

function snapshotCacheData(value: unknown): ConnectDiscoverySnapshot {
  try {
    const cloned = cloneCacheData(value, "$", new Set(), { nodes: 0, properties: 0, stringCodeUnits: 0 }, 0);
    if (!isPlainObject(cloned)) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Discovery cache snapshot must be a plain object.");
    }
    return cloned as unknown as ConnectDiscoverySnapshot;
  } catch (cause) {
    if (cause instanceof HonuaDiscoveryError && cause.code === "invalid-discovery-cache") throw cause;
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Discovery cache contains unsafe or invalid data.");
  }
}

const MAX_CACHE_SNAPSHOT_DEPTH = 32;
const MAX_CACHE_SNAPSHOT_NODES = 10_000;
const MAX_CACHE_SNAPSHOT_PROPERTIES = 20_000;
const MAX_CACHE_SNAPSHOT_ARRAY_LENGTH = 10_000;
const MAX_CACHE_SNAPSHOT_STRING_CODE_UNITS = 4_000_000;
const MAX_CACHE_SNAPSHOT_SINGLE_STRING_CODE_UNITS = 1_000_000;

interface CacheCloneBudget {
  nodes: number;
  properties: number;
  stringCodeUnits: number;
}

function cloneCacheData(
  value: unknown,
  path: string,
  seen: Set<object>,
  budget: CacheCloneBudget,
  depth: number,
): unknown {
  if (depth > MAX_CACHE_SNAPSHOT_DEPTH) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached snapshot exceeds the maximum nesting depth.");
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_CACHE_SNAPSHOT_NODES) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached snapshot exceeds the maximum node count.");
  }
  if (typeof value === "string") {
    consumeCacheStringBudget(value, budget);
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") {
    throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached value at ${path} is not serializable data.`);
  }
  if (seen.has(value)) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached value at ${path} contains a cycle.`);
  }
  seen.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === "symbol")) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached value at ${path} contains symbol keys.`);
    }
    budget.properties += keys.length;
    if (budget.properties > MAX_CACHE_SNAPSHOT_PROPERTIES) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached snapshot exceeds the maximum property count.");
    }
    for (const key of keys as string[]) consumeCacheStringBudget(key, budget);
    if (Array.isArray(value)) {
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || "get" in lengthDescriptor || !Number.isSafeInteger(lengthDescriptor.value)) {
        throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached array at ${path} has an invalid length.`);
      }
      const length = lengthDescriptor.value as number;
      if (length > MAX_CACHE_SNAPSHOT_ARRAY_LENGTH) {
        throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached snapshot exceeds the maximum array length.");
      }
      const out: unknown[] = [];
      const stringKeys = keys.filter((key): key is string => typeof key === "string");
      const numericKeys = stringKeys.filter((key) => /^(0|[1-9]\d*)$/.test(key));
      if (numericKeys.length !== length) {
        throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached array at ${path} must be dense data.`);
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || "get" in descriptor || !descriptor.enumerable) {
          throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached array at ${path} must be dense data.`);
        }
        out.push(cloneCacheData(descriptor.value, `${path}[${index}]`, seen, budget, depth + 1));
      }
      const extra = stringKeys.filter((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key));
      if (extra.length > 0) {
        throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached array at ${path} has extra properties.`);
      }
      return Object.freeze(out);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached value at ${path} must be a plain object.`);
    }
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor) {
        throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached property ${path}.${key} is unstable.`);
      }
      if ("get" in descriptor || !descriptor.enumerable) {
        throw new HonuaDiscoveryError("invalid-discovery-cache", `Cached property ${path}.${key} must be data.`);
      }
      out[key] = cloneCacheData(descriptor.value, `${path}.${key}`, seen, budget, depth + 1);
    }
    return Object.freeze(out);
  } finally {
    seen.delete(value);
  }
}

function consumeCacheStringBudget(value: string, budget: CacheCloneBudget): void {
  if (value.length > MAX_CACHE_SNAPSHOT_SINGLE_STRING_CODE_UNITS) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached snapshot contains an oversized string.");
  }
  budget.stringCodeUnits += value.length;
  if (budget.stringCodeUnits > MAX_CACHE_SNAPSHOT_STRING_CODE_UNITS) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached snapshot exceeds the total string-size limit.");
  }
}

function validateCachedEvidence(
  protocol: ConnectResolvedProtocol,
  evidence: readonly DiscoveryCapabilityEvidence[],
  allowEmpty: boolean,
): readonly DiscoveryCapabilityEvidence[] {
  if (!Array.isArray(evidence) || (!allowEmpty && evidence.length === 0)) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached capability evidence is invalid.");
  }
  if (evidence.length === 0) return Object.freeze([]);
  for (const record of evidence) {
    if (!isPlainObject(record)) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached capability evidence must contain objects.");
    }
    if (
      (record.kind === "inferred" || record.kind === "unavailable") &&
      (typeof record.reason !== "string" || !record.reason.trim())
    ) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached capability evidence reason is invalid.");
    }
    if (record.provenance !== undefined && !Array.isArray(record.provenance)) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached capability provenance must be an array.");
    }
    for (const provenance of record.provenance ?? []) {
      if (
        !isPlainObject(provenance) ||
        typeof provenance.source !== "string" ||
        !provenance.source.trim() ||
        (provenance.retrievedAt !== undefined && typeof provenance.retrievedAt !== "string") ||
        (provenance.validator !== undefined && typeof provenance.validator !== "string")
      ) {
        throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached capability provenance is invalid.");
      }
    }
  }
  try {
    return resolveDiscoveryCapabilities(protocol, evidence).evidence;
  } catch (cause) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached capability evidence is invalid.", {
      cause: cause instanceof Error ? cause.message : "invalid evidence",
    });
  }
}

function validateSnapshotLocator(sourceId: string, locator: SourceLocator, target: ConnectTarget): void {
  if (target.protocol === "ogc-features" || target.protocol === "stac") {
    const expectedLayout = target.protocol === "stac" ? "stac-api" : "ogc-api";
    if (
      locator.url !== target.endpoint ||
      locator.layout !== expectedLayout ||
      typeof locator.collectionId !== "string" ||
      !locator.collectionId ||
      sourceId !== locator.collectionId
    ) {
      throw new HonuaDiscoveryError(
        "invalid-discovery-cache",
        `Cached ${target.protocol === "stac" ? "STAC" : "OGC"} source locator does not match the endpoint.`,
      );
    }
    return;
  }
  if (target.protocol === "wfs") {
    if (
      locator.url !== target.endpoint ||
      typeof locator.typeName !== "string" ||
      !locator.typeName ||
      sourceId !== locator.typeName
    ) {
      throw new HonuaDiscoveryError(
        "invalid-discovery-cache",
        "Cached WFS source locator does not match the endpoint.",
      );
    }
    return;
  }
  if (target.protocol === "odata") {
    if (
      locator.url !== target.endpoint ||
      typeof locator.entitySet !== "string" ||
      !locator.entitySet ||
      sourceId !== locator.entitySet
    ) {
      throw new HonuaDiscoveryError(
        "invalid-discovery-cache",
        "Cached OData source locator does not match the endpoint.",
      );
    }
    return;
  }
  if (target.protocol === "geoparquet") {
    if (locator.url !== target.endpoint || typeof sourceId !== "string" || !sourceId) {
      throw new HonuaDiscoveryError(
        "invalid-discovery-cache",
        "Cached GeoParquet source locator does not match the asset endpoint.",
      );
    }
    return;
  }
  if (target.protocol === "ogc-records" || target.protocol === "ogc-tiles" || target.protocol === "ogc-maps") {
    if (
      locator.url !== target.clientBaseUrl ||
      locator.basePath !== (target.ogcBasePath ?? "") ||
      typeof locator.collectionId !== "string" ||
      !locator.collectionId ||
      sourceId !== locator.collectionId
    ) {
      const family =
        target.protocol === "ogc-records"
          ? "OGC API Records"
          : target.protocol === "ogc-tiles"
            ? "OGC API Tiles"
            : "OGC API Maps";
      throw new HonuaDiscoveryError(
        "invalid-discovery-cache",
        `Cached ${family} source locator does not match the service endpoint.`,
      );
    }
    return;
  }
  if (target.protocol === "geoservices-image-service") {
    const expectedSourceId = target.layerId === undefined ? target.serviceId : String(target.layerId);
    if (
      locator.url !== target.clientBaseUrl ||
      locator.serviceId !== target.serviceId ||
      locator.layerId !== target.layerId ||
      sourceId !== expectedSourceId
    ) {
      throw new HonuaDiscoveryError(
        "invalid-discovery-cache",
        "Cached ImageServer source locator does not match the service endpoint.",
      );
    }
    return;
  }
  if (
    locator.url !== target.clientBaseUrl ||
    locator.serviceId !== target.serviceId ||
    !Number.isInteger(locator.layerId) ||
    sourceId !== String(locator.layerId) ||
    (target.layerId !== undefined && locator.layerId !== target.layerId)
  ) {
    throw new HonuaDiscoveryError(
      "invalid-discovery-cache",
      "Cached GeoServices source locator does not match the service endpoint.",
    );
  }
}

function validateCachedDiscoveryExtent(extent: ConnectDiscoveryExtent): ConnectDiscoveryExtent {
  if (!isPlainObject(extent)) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached source extent must be an object.");
  }
  if (
    (extent.spatial !== undefined && (!isPlainObject(extent.spatial) || !Array.isArray(extent.spatial.bbox))) ||
    (extent.temporal !== undefined && (!isPlainObject(extent.temporal) || !Array.isArray(extent.temporal.interval)))
  ) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached source extent structure is invalid.");
  }
  try {
    return normalizeCollectionExtent(extent);
  } catch (cause) {
    if (cause instanceof HonuaDiscoveryError) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached source extent is invalid.", {
        cause: cause.message,
      });
    }
    throw cause;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}

function uniqueDiagnostics(values: readonly DiscoveryDiagnostic[]): readonly DiscoveryDiagnostic[] {
  const seen = new Set<string>();
  return Object.freeze(
    values.filter((value) => {
      const key = `${value.code}\u0000${value.message}\u0000${value.capabilities?.join(",") ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}
