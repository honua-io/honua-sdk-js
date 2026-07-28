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
import {
  type StacStaticDiscoveryInspection,
  type StacStaticTraversalOptions,
  type StacStaticTraversalPolicy,
  discoverStaticStac,
  fetchStacRootDocument,
  isStaticStacDocument,
  normalizeStacStaticTraversalPolicy,
  stacStaticTraversalPolicyIdentity,
  validateCachedStacStaticInspection,
} from "./connect-stac-static.js";
export type {
  StacAssetCandidate,
  StacAssetCandidateMetadata,
  StacAssetCandidateState,
  StacAssetClassificationEvidence,
  StacAssetConfidence,
  StacAssetKind,
  StacAssetSourceCandidate,
  StacStaticDiagnostic,
  StacStaticDiagnosticCode,
  StacStaticDiscoveryInspection,
  StacStaticObjectSummary,
  StacStaticObjectType,
  StacStaticTraversalOptions,
  StacStaticTraversalPolicy,
} from "./connect-stac-static.js";
import {
  type ConnectTarget,
  discoverGeoServicesImageSources,
  discoverGeoServicesSources,
  resolveConnectTarget,
} from "./connect-geoservices.js";
export type { GeoParquetSourceProfiler } from "./connect-geoparquet.js";
import { discoverGrpcSources } from "./connect-grpc.js";
import { discoverOdataSources } from "./connect-odata.js";
import {
  discoverOgcMapsSources,
  discoverOgcProcessesMetadata,
  discoverOgcRecordsSources,
  discoverOgcTilesSources,
} from "./connect-ogc.js";
import type { OgcProcessesDiscoveryResult } from "./connect-ogc.js";
import {
  PMTILES_RETAINED_METADATA_JSON_BYTES,
  PMTILES_RETAINED_VECTOR_LAYER_ENTRIES,
  PMTILES_RETAINED_VECTOR_LAYER_NODES,
  PMTILES_UNKNOWN_TILE_KIND_REASON,
  PMTILES_VALIDATOR_CODE_UNITS,
  discoverPmtilesSources,
  normalizePmtilesDiscoveryLimits,
  parsePmtilesValidatorIdentity,
  pmtilesDiscoveryPolicyIdentity,
  pmtilesRangesCoverWholeArchive,
  pmtilesVectorLayerStructuralNodes,
} from "./connect-pmtiles.js";
export type {
  OgcProcessDiscoverySummary,
  OgcProcessesDiscoveryResult,
} from "./connect-ogc.js";
import {
  advertisedWmsAxisOrder,
  isAdvertisedWebMercatorCrs,
  mapLibreMatrixSetUnavailableReason,
  mapLibreTileMatrixTemplate,
} from "./connect-raster-evidence.js";
import { canonicalizeUrlQuery, hasCredentialQuery, isCredentialQueryName } from "./connect-url-safety.js";
import { discoverWfsSources } from "./connect-wfs.js";
import { discoverWmsWmtsSources } from "./connect-wms-wmts.js";
import {
  type DiscoveryCacheIdentity,
  type DiscoveryCapabilityEvidence,
  type DiscoveryCapabilityPolicy,
  type DiscoveryCapabilityResolution,
  type DiscoveryDiagnostic,
  type DiscoveryOperationMetadata,
  type DiscoveryProvenance,
  type DiscoverySourceMetadata,
  type SourceDiscoveryInspection,
  createDiscoveryCacheIdentity,
  inspectDiscoveredSource,
  resolveDiscoveryCapabilities,
} from "./contract/discovery.js";
import type { PmtilesArchiveDescription, PmtilesVectorLayerInfo } from "./contract/pmtiles.js";
import type { SourceSchemaV2Envelope } from "./contract/schema-envelope.js";
import type { SchemaIdentity } from "./contract/schema.js";
import { normalizeCapabilityDescriptor } from "./contract/source-capability-support.js";
import { createDatasetWithAdapterSeeds } from "./contract/source.js";
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
  wms(
    metadata: DiscoverySourceMetadata,
    context: ConnectSourceSchemaProjectionContext & { readonly protocol: "wms" },
  ): SourceSchemaV2Envelope;
  wmts(
    metadata: DiscoverySourceMetadata,
    context: ConnectSourceSchemaProjectionContext & { readonly protocol: "wmts" },
  ): SourceSchemaV2Envelope;
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
export const HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION = 7 as const;
/** Adapter version used to invalidate logical discovery identities. */
export const HONUA_CONNECT_ADAPTER_VERSION = "honua-connect@7";
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
  readonly schemaV2State?: SchemaIdentity;
  /** Validated protocol metadata retained for inspection and cache replay. */
  readonly metadata?: DiscoverySourceMetadata;
  readonly evidence?: readonly DiscoveryCapabilityEvidence[];
}

/** Normalized collection extent retained without querying collection items. */
export interface ConnectDiscoveryExtent {
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
  /** Present only for a bounded static Catalog/Collection/Item connection. */
  readonly stacStatic?: StacStaticDiscoveryInspection;
}

export interface ConnectOptions {
  /** OGC API, STAC API, WFS 2.0, WMS/WMTS, or canonical GeoServices URL. */
  readonly endpoint: string | URL;
  /** Protocol hint. `auto` recognizes canonical GeoServices URL structure without probing. */
  readonly protocol: ConnectProtocolHint;
  /** Restrict discovery to one collection while retaining the service root URL. */
  readonly collectionId?: string;
  /** Restrict WFS discovery to one feature type or WMS/WMTS discovery to one named layer. */
  readonly typeName?: string;
  /** Restrict WMS/WMTS discovery to one advertised style. */
  readonly styleId?: string;
  /** Restrict WMTS discovery to one advertised tile matrix set. */
  readonly tileMatrixSetId?: string;
  /** Hard bounds for the one capabilities response; caller values may only lower SDK maxima. */
  readonly capabilitiesLimits?: {
    readonly maxBytes?: number;
    readonly timeoutMs?: number;
  };
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
  /** Bounded direct-PMTiles archive discovery policy. */
  readonly pmtiles?: {
    readonly limits?: {
      /** Physical HTTP attempts, including retries/auth replays; defaults to and cannot exceed 2. */
      readonly maxRequests?: number;
      /** Bytes in any one range; defaults to and cannot exceed 512 KiB. */
      readonly maxRangeBytes?: number;
      /** Reserved bytes across the complete inspection; defaults to and cannot exceed 1 MiB. */
      readonly maxTotalBytes?: number;
      /** Inflated internal directory/metadata bytes; defaults to and cannot exceed 4 MiB. */
      readonly maxDecompressedBytes?: number;
    };
  };
  /** Hard-bounded static-STAC traversal/probe policy. Ignored by STAC API discovery. */
  readonly stac?: StacStaticTraversalOptions;
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
  /** Static object tree and classified asset candidates, when the endpoint is static STAC. */
  readonly stacStatic?: StacStaticDiscoveryInspection;
}

export interface HonuaConnection {
  readonly id: string;
  readonly dataset: Dataset;
  readonly inspection: HonuaConnectionInspection;
  source<T = Record<string, unknown>>(id?: SourceId): CapabilityAwareSource<T>;
}

/** Source-backed protocols with a reviewed top-level {@link connect} discovery adapter. */
export const CONNECT_SOURCE_PROTOCOLS = [
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
] as const satisfies readonly Protocol[];

export type ConnectResolvedProtocol = (typeof CONNECT_SOURCE_PROTOCOLS)[number];

/** Canonical static-format inventory reviewed across connect, STAC, and renderer boundaries. */
export const CONNECT_STATIC_FORMATS = [
  "static-stac",
  "pmtiles",
  "geoparquet",
  "cog",
  "tile-template",
  "geojson",
] as const;

export type ConnectStaticFormat = (typeof CONNECT_STATIC_FORMATS)[number];

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
  const pmtilesAutoEvidence = options.protocol === "auto" && isPmtilesSchemeInput(options.endpoint);
  const endpoint = validateConnectEndpoint(options.endpoint, options.protocol);
  const target = resolveConnectTarget(endpoint, pmtilesAutoEvidence ? "pmtiles" : options.protocol);
  if (target.protocol !== "stac" && options.stac !== undefined) {
    throw new HonuaDiscoveryError("invalid-endpoint", "stac traversal options are only valid for STAC connections.");
  }
  const stacPolicy = target.protocol === "stac" ? normalizeStacStaticTraversalPolicy(options.stac) : undefined;
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
  if (
    target.protocol !== "wfs" &&
    target.protocol !== "wms" &&
    target.protocol !== "wmts" &&
    options.typeName !== undefined
  ) {
    throw new HonuaDiscoveryError("invalid-endpoint", "typeName is only valid for WFS, WMS, or WMTS connections.");
  }
  if (options.typeName !== undefined && (!options.typeName.trim() || options.typeName.trim() !== options.typeName)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "typeName must be a non-empty, trimmed identifier.");
  }
  if (options.styleId !== undefined && target.protocol !== "wms" && target.protocol !== "wmts") {
    throw new HonuaDiscoveryError("invalid-endpoint", "styleId is only valid for WMS or WMTS connections.");
  }
  if (options.styleId !== undefined && (!options.styleId.trim() || options.styleId.trim() !== options.styleId)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "styleId must be a non-empty, trimmed identifier.");
  }
  if (options.tileMatrixSetId !== undefined && target.protocol !== "wmts") {
    throw new HonuaDiscoveryError("invalid-endpoint", "tileMatrixSetId is only valid for WMTS connections.");
  }
  if (
    options.tileMatrixSetId !== undefined &&
    (!options.tileMatrixSetId.trim() || options.tileMatrixSetId.trim() !== options.tileMatrixSetId)
  ) {
    throw new HonuaDiscoveryError("invalid-endpoint", "tileMatrixSetId must be a non-empty, trimmed identifier.");
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
  const pmtilesLimits = normalizePmtilesDiscoveryLimits(options.pmtiles?.limits);
  if (target.protocol !== "pmtiles" && options.pmtiles !== undefined) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "pmtiles discovery options are only valid for PMTiles connections.",
    );
  }

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
    ...(options.styleId ? { styleId: options.styleId } : {}),
    ...(options.tileMatrixSetId ? { tileMatrixSetId: options.tileMatrixSetId } : {}),
    ...(target.serviceId ? { serviceId: target.serviceId } : {}),
    ...(target.layerId !== undefined ? { layerId: target.layerId } : {}),
    ...(assetVariant ? { assetVariant } : {}),
    ...(target.protocol === "pmtiles" ? { profile: pmtilesDiscoveryPolicyIdentity(pmtilesLimits) } : {}),
    ...(stacPolicy ? { profile: stacStaticTraversalPolicyIdentity(stacPolicy) } : {}),
  });
  if (options.client) assertClientEndpoint(options.client, target.clientBaseUrl);
  const cacheContext = Object.freeze({ ...(options.signal ? { signal: options.signal } : {}) });
  let snapshot: ConnectDiscoverySnapshot | undefined;
  let cacheStatus: ConnectCacheStatus = options.cache ? "miss" : "bypass";

  if (options.cache && options.refresh !== true) {
    snapshot = await awaitAbortable(options.cache.get(identity, cacheContext), options.signal);
    throwIfAborted(options.signal);
    if (snapshot) {
      snapshot = await validateSnapshot(
        snapshot,
        identity,
        target,
        options.collectionId,
        options.typeName,
        options.styleId,
        options.tileMatrixSetId,
        sourceSchemaProjection,
        stacPolicy,
        pmtilesLimits,
      );
      cacheStatus = "hit";
    }
  }

  const client = options.client ?? new HonuaClient({ ...options.clientOptions, baseUrl: target.clientBaseUrl });
  if (!snapshot) {
    snapshot =
      target.protocol === "grpc"
        ? await discoverGrpc(client, identity, target, options, sourceSchemaProjection)
        : target.protocol === "ogc-features"
          ? await discoverOgcFeatures(client, identity, options)
          : target.protocol === "stac"
            ? await discoverStac(client, identity, options, stacPolicy!)
            : target.protocol === "wfs"
              ? await discoverWfs(client, identity, options)
              : target.protocol === "odata"
                ? await discoverOdata(client, identity, target, options, sourceSchemaProjection)
                : target.protocol === "geoparquet"
                  ? await discoverGeoParquet(identity, options, sourceSchemaProjection)
                  : target.protocol === "pmtiles"
                    ? await discoverPmtiles(client, identity, options, pmtilesLimits)
                    : target.protocol === "ogc-records"
                      ? await discoverOgcRecords(client, identity, target, options)
                      : target.protocol === "ogc-tiles"
                        ? await discoverOgcTiles(client, identity, target, options)
                        : target.protocol === "ogc-maps"
                          ? await discoverOgcMaps(client, identity, target, options)
                          : target.protocol === "geoservices-image-service"
                            ? await discoverGeoServicesImage(client, identity, target, options)
                            : target.protocol === "wms" || target.protocol === "wmts"
                              ? await discoverWmsWmtsSources(client, identity, target, options, sourceSchemaProjection)
                              : await discoverGeoServices(client, identity, target, options, sourceSchemaProjection);
    if (
      options.cache &&
      (!sourceSchemaProjection ||
        !sourceSchemaProjectionApplies(target.protocol) ||
        snapshot.sources.every((source) => source.schemaV2 !== undefined || source.schemaV2State !== undefined))
    ) {
      // Give caller-owned caches an isolated, deeply frozen serializable
      // observation rather than the adapter's working object graph.
      snapshot = snapshotCacheData(snapshot);
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
        ...(source.schemaV2State
          ? { schemaV2State: source.schemaV2State }
          : source.schemaV2
            ? { schemaV2State: { state: "known" as const, fingerprint: source.schemaV2.fingerprint } }
            : {}),
        ...(source.title ? { attribution: source.title } : {}),
      };
      const discovered = inspectDiscoveredSource(descriptor, resolution);
      const projectedDescriptor = sourceCapabilityProjection
        ? descriptorWithCapabilityProfile(
            discovered.descriptor,
            sourceCapabilityProjection.project(descriptor, resolution, { observedAt: snapshot.retrievedAt }),
          )
        : discovered.descriptor;
      const partialReasons = source.metadata?.partialReasons ?? [];
      const diagnostics =
        partialReasons.length > 0 &&
        !discovered.diagnostics.some((diagnostic) => diagnostic.code === "partial-discovery")
          ? uniqueDiagnostics([
              ...discovered.diagnostics,
              Object.freeze({
                code: "partial-discovery" as const,
                severity: "warning" as const,
                message: `${snapshot.protocol.toUpperCase()} metadata retained ${partialReasons.length} structured partial-discovery reason${partialReasons.length === 1 ? "" : "s"}.`,
              }),
            ])
          : discovered.diagnostics;
      return Object.freeze({
        ...discovered,
        descriptor: projectedDescriptor,
        diagnostics,
        ...(source.metadata || source.crs || source.extent
          ? {
              metadata: Object.freeze({
                ...(source.metadata ?? {}),
                ...(source.crs ? { crs: source.crs } : {}),
                ...(source.extent ? { extent: source.extent } : {}),
              }),
            }
          : {}),
      });
    }),
  );
  const id = options.id?.trim() || identity.endpoint;
  const dataset = createDatasetWithAdapterSeeds(
    {
      id,
      client,
      sources: inspections.map((entry) => entry.descriptor),
      skipCompatibilityCheck: true,
      ...(options.resolveSource ? { resolveSource: options.resolveSource } : {}),
    },
    {
      ...(snapshot.protocol === "pmtiles"
        ? { pmtilesDescriptions: reviewedPmtilesDescriptions(snapshot.sources, identity.endpoint) }
        : {}),
    },
  );
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
    ...(snapshot.stacStatic ? { stacStatic: snapshot.stacStatic } : {}),
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

function isPmtilesSchemeInput(input: string | URL): boolean {
  return input instanceof URL ? input.protocol.toLowerCase() === "pmtiles:" : /^pmtiles:\/\//i.test(input);
}

function connectEndpointText(input: string | URL): string {
  if (!(input instanceof URL) || input.protocol.toLowerCase() !== "pmtiles:") return input.toString();
  const nestedProtocol = input.hostname.toLowerCase();
  if (
    (nestedProtocol !== "http" && nestedProtocol !== "https") ||
    input.username ||
    input.password ||
    input.port ||
    !input.pathname.startsWith("//")
  ) {
    return input.toString();
  }
  return `pmtiles://${nestedProtocol}:${input.pathname}${input.search}${input.hash}`;
}

/** @internal Shared by the kernel authorization gate; not exported from public barrels. */
export function validateConnectEndpoint(input: string | URL, hint: ConnectProtocolHint = "auto"): string {
  let endpoint: URL;
  let raw = connectEndpointText(input);
  if (/^pmtiles:\/\//i.test(raw)) {
    if (hint !== "auto" && hint !== "pmtiles") {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        'A "pmtiles://" asset marker is only valid with protocol "auto" or "pmtiles".',
        { protocol: hint, resolvedProtocol: "pmtiles" },
      );
    }
    raw = raw.slice("pmtiles://".length);
    if (/^pmtiles:\/\//i.test(raw)) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        "PMTiles asset URLs must contain exactly one pmtiles:// marker.",
      );
    }
  }
  try {
    endpoint = new URL(raw);
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
  const rasterServiceQueryIsAllowed = isWmsWmtsServiceQuery(endpoint, hint);
  if (
    endpoint.username ||
    endpoint.password ||
    hasCredentialQuery(endpoint.searchParams) ||
    (endpoint.search && !formatQueryIsRemovable && !rasterServiceQueryIsAllowed) ||
    endpoint.hash
  ) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "connect() endpoints must not contain credentials, identity-bearing query parameters, or fragments; configure authentication through clientOptions.",
    );
  }
  if (formatQueryIsRemovable) endpoint.search = "";
  else if (rasterServiceQueryIsAllowed) canonicalizeUrlQuery(endpoint);
  while (endpoint.pathname.length > 1 && endpoint.pathname.endsWith("/")) {
    endpoint.pathname = endpoint.pathname.slice(0, -1);
  }
  const normalized = endpoint.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function isWmsWmtsServiceQuery(endpoint: URL, hint: ConnectProtocolHint): boolean {
  const params = endpoint.searchParams;
  if (params.size === 0 || (hint !== "auto" && hint !== "wms" && hint !== "wmts")) return false;
  const values = new Map<string, string>();
  for (const [rawName, rawValue] of params) {
    const name = rawName.toLowerCase();
    if (name === "service" || name === "request" || name === "version") {
      if (values.has(name)) return false;
      values.set(name, rawValue);
    }
  }
  const service = values.get("service")?.toLowerCase();
  if (service !== undefined && service !== "wms" && service !== "wmts") return false;
  const pathService = endpoint.pathname.split("/").filter(Boolean).at(-1)?.toLowerCase();
  const hintedService = hint === "wms" || hint === "wmts" ? hint : undefined;
  const structuralService = service === "wms" || service === "wmts" ? service : undefined;
  const endpointService = pathService === "wms" || pathService === "wmts" ? pathService : undefined;
  const protocol = structuralService ?? hintedService ?? endpointService;
  if (protocol !== "wms" && protocol !== "wmts") return false;
  if (structuralService && hintedService && structuralService !== hintedService) return false;
  if (endpointService && hintedService && endpointService !== hintedService) return false;
  const request = values.get("request")?.toLowerCase();
  if (request !== undefined && request !== "getcapabilities") return false;
  const version = values.get("version");
  return version === undefined || (protocol === "wms" ? version === "1.3.0" : version === "1.0.0");
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
  stacPolicy: StacStaticTraversalPolicy,
): Promise<ConnectDiscoverySnapshot> {
  const request: HonuaMetadataRequestOptions = {
    ...options.metadata,
    ...(options.signal ? { signal: options.signal } : {}),
    refresh: options.refresh === true,
  };
  const rootResponse = await fetchStacRootDocument(client, identity.endpoint, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.refresh !== undefined ? { refresh: options.refresh } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
    authorizationScopeDigest: identity.authorizationScopeDigest,
    policy: stacPolicy,
  });
  const landing = rootResponse.value as HonuaStacLandingResponse;
  throwIfAborted(options.signal);
  if (isStaticStacDocument(landing)) {
    const discovered = await discoverStaticStac(client, identity.endpoint, rootResponse, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.refresh !== undefined ? { refresh: options.refresh } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
      authorizationScopeDigest: identity.authorizationScopeDigest,
      policy: stacPolicy,
      ...(options.collectionId ? { collectionId: options.collectionId } : {}),
    });
    return Object.freeze({
      version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
      identityKey: identity.key,
      endpoint: identity.endpoint,
      protocol: "stac",
      retrievedAt: discovered.inspection.root.provenance[0]?.retrievedAt ?? new Date().toISOString(),
      evidence: Object.freeze([]),
      sources: Object.freeze([discovered.source]),
      stacStatic: discovered.inspection,
    });
  }
  if (validateConnectEndpoint(rootResponse.url) !== identity.endpoint) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "A STAC API landing redirect must resolve to the explicitly connected service root.",
    );
  }
  const advertised = validateStacLanding(identity.endpoint, landing);
  const collections = await client.listStacCollections({ ...request, stacBasePath: "" });
  throwIfAborted(options.signal);

  const selected = selectCollections(collections, options.collectionId, "STAC API");
  const retrievedAt = new Date().toISOString();
  const provenance = stacMetadataProvenance(rootResponse.url, rootResponse.validator, retrievedAt, collections);
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

async function discoverGrpc(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  target: ConnectTarget,
  options: ConnectOptions,
  sourceSchemaProjection: ConnectSourceSchemaProjection | undefined,
): Promise<ConnectDiscoverySnapshot> {
  const discovered = await discoverGrpcSources(client, target, options, sourceSchemaProjection);
  return Object.freeze({
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: identity.key,
    endpoint: identity.endpoint,
    protocol: "grpc",
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
  const discovered = await discoverGeoServicesImageSources(client, target, options);
  if (discovered.sources.length === 0) {
    throw new HonuaDiscoveryError(
      "unsupported-protocol",
      "ImageServer metadata did not prove an executable raster-catalog Source; use discoverGeoServices() for imagery service and operation discovery.",
      { endpoint: identity.endpoint, protocol: target.protocol },
    );
  }
  return Object.freeze({
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: identity.key,
    endpoint: identity.endpoint,
    protocol: "geoservices-image-service",
    retrievedAt: discovered.retrievedAt,
    evidence: discovered.evidence,
    sources: discovered.sources,
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

async function discoverPmtiles(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  options: ConnectOptions,
  limits: ReturnType<typeof normalizePmtilesDiscoveryLimits>,
): Promise<ConnectDiscoverySnapshot> {
  const discovered = await awaitAbortable(discoverPmtilesSources(client, identity, options, limits), options.signal);
  return Object.freeze({
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: identity.key,
    endpoint: identity.endpoint,
    protocol: "pmtiles",
    retrievedAt: discovered.retrievedAt,
    evidence: discovered.evidence,
    sources: discovered.sources,
  });
}

function reviewedPmtilesDescriptions(
  sources: readonly ConnectDiscoverySourceSnapshot[],
  endpoint: string,
): ReadonlyMap<SourceId, PmtilesArchiveDescription> {
  return new Map(
    sources.map((source) => {
      const pmtiles = source.metadata?.pmtiles;
      if (!pmtiles) {
        throw new HonuaDiscoveryError(
          "invalid-endpoint",
          "Reviewed PMTiles discovery did not retain its bounded archive description.",
        );
      }
      const vectorLayers = Object.freeze(pmtiles.vectorLayers.map((layer) => Object.freeze({ ...layer })));
      const metadata = parseReviewedPmtilesMetadata(pmtiles.metadataJson);
      return [
        source.id,
        Object.freeze({
          url: endpoint,
          specVersion: pmtiles.specVersion,
          tileKind: pmtiles.tileKind,
          bounds: pmtiles.bounds,
          minZoom: pmtiles.minZoom,
          maxZoom: pmtiles.maxZoom,
          center: pmtiles.center,
          vectorLayers,
          ...(pmtiles.attribution ? { attribution: pmtiles.attribution } : {}),
          metadata,
        }),
      ] as const;
    }),
  );
}

function parseReviewedPmtilesMetadata(value: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isPlainObject(parsed)) throw new TypeError("metadata is not an object");
    return Object.freeze(parsed);
  } catch (cause) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "Reviewed PMTiles discovery did not retain a valid raw metadata document.",
      {},
      { cause },
    );
  }
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
  if (
    !isPlainObject(landing) ||
    !Array.isArray(landing.conformsTo) ||
    landing.conformsTo.some((entry) => typeof entry !== "string")
  ) {
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

function immutableStrings(values: unknown, label: string): readonly string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) {
    throw new HonuaDiscoveryError("invalid-endpoint", `${label} must contain non-empty strings.`);
  }
  return Object.freeze([...values] as string[]);
}

function immutableString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HonuaDiscoveryError("invalid-endpoint", `${label} must be a non-empty string.`);
  }
  return value;
}

function stacMetadataProvenance(
  landingSource: string,
  landingValidator: string | undefined,
  retrievedAt: string,
  collections: HonuaOgcCollectionsResponse,
): readonly DiscoveryProvenance[] {
  const collectionsValidator = collections.cache?.validator?.etag ?? collections.cache?.validator?.lastModified;
  return Object.freeze([
    Object.freeze({ source: landingSource, retrievedAt, ...(landingValidator ? { validator: landingValidator } : {}) }),
    Object.freeze({
      source: `${landingSource}/collections`,
      retrievedAt,
      ...(collectionsValidator ? { validator: collectionsValidator } : {}),
    }),
  ]);
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

async function validateSnapshot(
  value: ConnectDiscoverySnapshot,
  identity: DiscoveryCacheIdentity,
  target: ConnectTarget,
  collectionId: string | undefined,
  typeName: string | undefined,
  styleId: string | undefined,
  tileMatrixSetId: string | undefined,
  sourceSchemaProjection: ConnectSourceSchemaProjection | undefined,
  stacPolicy: StacStaticTraversalPolicy | undefined,
  pmtilesLimits: ReturnType<typeof normalizePmtilesDiscoveryLimits>,
): Promise<ConnectDiscoverySnapshot> {
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
  if (target.protocol === "pmtiles") {
    assertCachedKeys(
      owned as unknown as Record<string, unknown>,
      ["version", "identityKey", "endpoint", "protocol", "retrievedAt", "evidence", "sources"],
      "PMTiles discovery snapshot",
    );
    const retrievedTimestamp = Date.parse(owned.retrievedAt);
    if (!Number.isFinite(retrievedTimestamp) || new Date(retrievedTimestamp).toISOString() !== owned.retrievedAt) {
      cacheMetadataError("Cached PMTiles retrieval time must be a canonical ISO-8601 timestamp.");
    }
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
    validateSnapshotLocator(source.id, source.locator, target, owned.stacStatic !== undefined, stacPolicy);
    if (source.schema?.fields !== undefined && !Array.isArray(source.schema.fields)) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached source schema fields must be an array.");
    }
    let schemaV2: SourceSchemaV2Envelope | undefined;
    const schemaV2State = source.schemaV2State;
    if (source.schemaV2 !== undefined) {
      if (!sourceSchemaProjection || !projectionApplies) {
        throw new HonuaDiscoveryError(
          "invalid-discovery-cache",
          "Cached source schemaV2 requires the focused source-schema connection path.",
        );
      }
      if (schemaV2State?.state === "unavailable") {
        throw new HonuaDiscoveryError(
          "invalid-discovery-cache",
          "Cached source cannot carry both schemaV2 and an unavailable schemaV2State.",
        );
      }
      if (schemaV2State?.state === "known" && schemaV2State.fingerprint !== schemaV2.fingerprint) {
        throw new HonuaDiscoveryError(
          "invalid-discovery-cache",
          "Cached source schemaV2State does not match its schemaV2 fingerprint.",
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
    } else if (projectionApplies && schemaV2State?.state !== "unavailable") {
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
    if ((target.protocol === "wms" || target.protocol === "wmts") && source.metadata === undefined) {
      throw new HonuaDiscoveryError(
        "invalid-discovery-cache",
        `Cached ${target.protocol.toUpperCase()} source lacks discovery metadata.`,
      );
    }
    const metadata =
      source.metadata !== undefined
        ? validateCachedDiscoveryMetadata(
            source.metadata,
            target.endpoint,
            target.protocol === "pmtiles" ? pmtilesLimits : undefined,
          )
        : undefined;
    const extent = source.extent !== undefined ? validateCachedDiscoveryExtent(source.extent) : undefined;
    if (metadata && (target.protocol === "wms" || target.protocol === "wmts")) {
      validateCachedRasterMetadataBinding(source.locator, metadata, target.protocol, sourceEvidence ?? sharedEvidence);
    }
    if (target.protocol === "pmtiles") {
      if (!sourceEvidence || !source.evidence) {
        cacheMetadataError("Cached PMTiles source must retain its source-bound capability evidence.");
      }
      validateCachedPmtilesBinding(source, extent, metadata, sourceEvidence);
      const validator = metadata?.pmtiles?.validator;
      const supported = metadata?.pmtiles?.tileKind !== "unknown";
      validateCachedPmtilesEvidence(owned.evidence, target.endpoint, owned.retrievedAt, validator, supported);
      validateCachedPmtilesEvidence(source.evidence, target.endpoint, owned.retrievedAt, validator, supported);
    }
    return Object.freeze({
      id: source.id,
      locator: freezeCachedLocator(source.locator, stacPolicy),
      ...(source.title ? { title: source.title } : {}),
      ...(source.description ? { description: source.description } : {}),
      ...(source.crs ? { crs: immutableStrings(source.crs, "Cached source crs") } : {}),
      ...(extent ? { extent } : {}),
      ...(metadata ? { metadata } : {}),
      ...(source.schema
        ? {
            schema: Object.freeze({
              ...source.schema,
              ...(source.schema.fields ? { fields: Object.freeze([...source.schema.fields]) } : {}),
            }),
          }
        : {}),
      ...(schemaV2 ? { schemaV2 } : {}),
      ...(schemaV2State ? { schemaV2State } : {}),
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
    throw new HonuaDiscoveryError(
      "invalid-discovery-cache",
      "Discovery cache snapshot does not match the selected type/layer.",
      {
        typeName,
      },
    );
  }
  if (styleId && (sources.length !== 1 || sources[0]?.locator.styleId !== styleId)) {
    throw new HonuaDiscoveryError(
      "invalid-discovery-cache",
      "Discovery cache snapshot does not match the selected style.",
      {
        styleId,
      },
    );
  }
  if (tileMatrixSetId && (sources.length !== 1 || sources[0]?.locator.tileMatrixSetId !== tileMatrixSetId)) {
    throw new HonuaDiscoveryError(
      "invalid-discovery-cache",
      "Discovery cache snapshot does not match the selected tile matrix set.",
      { tileMatrixSetId },
    );
  }
  let stacStatic: StacStaticDiscoveryInspection | undefined;
  if (owned.stacStatic !== undefined) {
    if (target.protocol !== "stac" || !stacPolicy) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Static STAC cache details require a STAC target.");
    }
    stacStatic = await validateCachedStacStaticInspection(owned.stacStatic, identity.endpoint, stacPolicy);
    if (sources.length !== 1 || sources[0]?.locator.layout !== "stac-static") {
      throw new HonuaDiscoveryError(
        "invalid-discovery-cache",
        "Static STAC cache details require exactly one static STAC source.",
      );
    }
    const expectedObject = collectionId
      ? stacStatic.documents.find((document) => document.type === "collection" && document.id === collectionId)
      : stacStatic.root;
    const expectedCollectionId =
      expectedObject?.type === "collection" ? expectedObject.id : expectedObject?.collectionId;
    if (
      !expectedObject ||
      sources[0]?.id !== expectedObject.id ||
      sources[0]?.locator.collectionId !== expectedCollectionId
    ) {
      throw new HonuaDiscoveryError(
        "invalid-discovery-cache",
        "Cached static STAC source identity is not bound to its traversed root or selected collection.",
      );
    }
  } else if (sources.some((source) => source.locator.layout === "stac-static")) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached static STAC source is missing its tree binding.");
  }
  return Object.freeze({
    ...owned,
    evidence: sharedEvidence,
    sources: Object.freeze(sources),
    ...(stacStatic ? { stacStatic } : {}),
  });
}

function sourceSchemaProjectionApplies(protocol: ConnectResolvedProtocol): boolean {
  return (
    protocol === "odata" ||
    protocol === "geoparquet" ||
    protocol === "wms" ||
    protocol === "wmts" ||
    protocol === "geoservices-feature-service" ||
    protocol === "geoservices-map-service" ||
    // gRPC FeatureServer discovery routes through the geoservices projection and emits a
    // schemaV2 payload; it must be projection-applicable so cache writes and reads agree
    // (otherwise the first gRPC schema discovery caches an entry every later read rejects).
    protocol === "grpc"
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

function validateSnapshotLocator(
  sourceId: string,
  locator: SourceLocator,
  target: ConnectTarget,
  staticStac: boolean,
  stacPolicy: StacStaticTraversalPolicy | undefined,
): void {
  if (target.protocol === "ogc-features" || target.protocol === "stac") {
    const expectedLayout = target.protocol === "stac" ? (staticStac ? "stac-static" : "stac-api") : "ogc-api";
    if (target.protocol === "stac" && staticStac) {
      if (
        locator.url !== target.endpoint ||
        locator.layout !== expectedLayout ||
        !sourceId ||
        !stacPolicy ||
        !sameStacLocatorPolicy(locator.stacStatic, stacPolicy)
      ) {
        throw new HonuaDiscoveryError(
          "invalid-discovery-cache",
          "Cached static STAC source locator does not match the endpoint.",
        );
      }
      return;
    }
    if (
      locator.url !== target.endpoint ||
      locator.layout !== expectedLayout ||
      locator.stacStatic !== undefined ||
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
  if (target.protocol === "wms" || target.protocol === "wmts") {
    assertCachedKeys(
      locator as unknown as Record<string, unknown>,
      ["url", "serviceId", "typeName", "styleId", "tileMatrixSetId", "raster"],
      `${target.protocol.toUpperCase()} source locator`,
    );
    if (locator.url !== target.endpoint || locator.typeName !== sourceId) {
      throw new HonuaDiscoveryError(
        "invalid-discovery-cache",
        `Cached ${target.protocol.toUpperCase()} source locator does not match the service endpoint.`,
      );
    }
    if (locator.serviceId !== target.serviceId) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached raster-service id does not match the endpoint.");
    }
    if (
      locator.styleId !== undefined &&
      (typeof locator.styleId !== "string" || !locator.styleId || locator.styleId.trim() !== locator.styleId)
    ) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached raster style id is invalid.");
    }
    if (target.protocol === "wms" && locator.tileMatrixSetId !== undefined) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached WMS locator contains WMTS metadata.");
    }
    if (
      target.protocol === "wmts" &&
      locator.tileMatrixSetId !== undefined &&
      (typeof locator.tileMatrixSetId !== "string" ||
        !locator.tileMatrixSetId ||
        locator.tileMatrixSetId.trim() !== locator.tileMatrixSetId)
    ) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached WMTS tile matrix set id is invalid.");
    }
    validateCachedRasterLocatorBinding(locator.raster, target.protocol, target.endpoint);
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
  if (target.protocol === "pmtiles") {
    assertCachedKeys(locator as unknown as Record<string, unknown>, ["url", "sourceType"], "PMTiles source locator");
    if (
      locator.url !== target.endpoint ||
      sourceId !== "pmtiles" ||
      (locator.sourceType !== undefined && locator.sourceType !== "vector" && locator.sourceType !== "raster")
    ) {
      throw new HonuaDiscoveryError(
        "invalid-discovery-cache",
        "Cached PMTiles source locator does not match the asset endpoint.",
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
    if (
      locator.url !== target.clientBaseUrl ||
      locator.serviceId !== target.serviceId ||
      locator.layerId !== undefined ||
      sourceId !== target.serviceId
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

function sameStacLocatorPolicy(value: SourceLocator["stacStatic"], expected: StacStaticTraversalPolicy): boolean {
  return (
    value !== undefined &&
    value.maxDocuments === expected.maxDocuments &&
    value.maxDepth === expected.maxDepth &&
    value.maxLinksPerDocument === expected.maxLinksPerDocument &&
    value.maxAssets === expected.maxAssets &&
    value.maxAssetProbes === expected.maxAssetProbes &&
    value.maxDocumentBytes === expected.maxDocumentBytes
  );
}

function freezeCachedLocator(locator: SourceLocator, stacPolicy?: StacStaticTraversalPolicy): SourceLocator {
  const raster = locator.raster ? Object.freeze({ ...locator.raster }) : undefined;
  return Object.freeze({
    ...locator,
    ...(locator.layout === "stac-static" && stacPolicy ? { stacStatic: stacPolicy } : {}),
    ...(raster ? { raster } : {}),
  });
}

function validateCachedRasterMetadataBinding(
  locator: SourceLocator,
  metadata: DiscoverySourceMetadata,
  protocol: "wms" | "wmts",
  evidence: readonly DiscoveryCapabilityEvidence[],
): void {
  const expectedVersion = protocol === "wms" ? "1.3.0" : "1.0.0";
  if (metadata.protocolVersion !== expectedVersion) {
    cacheMetadataError(`Cached ${protocol.toUpperCase()} metadata version is not ${expectedVersion}.`);
  }
  const styleIds = metadata.styles?.map((style) => style.id) ?? [];
  if (new Set(styleIds).size !== styleIds.length) {
    cacheMetadataError(`Cached ${protocol.toUpperCase()} style identifiers must be unique.`);
  }
  if (locator.styleId !== undefined && !styleIds.includes(locator.styleId)) {
    cacheMetadataError(`Cached ${protocol.toUpperCase()} locator style was not advertised.`);
  }
  const matrixSetIds = metadata.tileMatrixSets?.map((matrixSet) => matrixSet.id) ?? [];
  if (new Set(matrixSetIds).size !== matrixSetIds.length) {
    cacheMetadataError("Cached WMTS tile matrix set identifiers must be unique.");
  }
  if (locator.tileMatrixSetId !== undefined && !matrixSetIds.includes(locator.tileMatrixSetId)) {
    cacheMetadataError("Cached WMTS locator tile matrix set was not advertised.");
  }
  const resolved = resolveDiscoveryCapabilities(protocol, evidence).capabilities;
  if (protocol === "wms") {
    const render = metadata.operations?.render?.available === true;
    const query = metadata.operations?.featureInfo?.available === true;
    if (render !== resolved.has("render") || render !== resolved.has("tiles") || query !== resolved.has("query")) {
      cacheMetadataError("Cached WMS operations contradict cached capability evidence.");
    }
    validateCachedExecutableRasterBinding(locator, metadata.operations?.render, render);
    validateCachedWmsAxisOrders(metadata);
    if (render && !metadata.crs?.some(isAdvertisedWebMercatorCrs)) {
      cacheMetadataError("Cached executable WMS source does not advertise an exact EPSG:3857 CRS.");
    }
    if (locator.raster && !metadata.formats?.render?.includes(locator.raster.format)) {
      cacheMetadataError("Cached WMS raster format was not advertised by GetMap metadata.");
    }
  } else {
    const tiles = metadata.operations?.tiles?.available === true;
    if (tiles !== resolved.has("render") || tiles !== resolved.has("tiles")) {
      cacheMetadataError("Cached WMTS tile operation contradicts cached capability evidence.");
    }
    validateCachedExecutableRasterBinding(locator, metadata.operations?.tiles, tiles);
    if (tiles) {
      validateCachedTileMatrixBinding(locator, metadata);
      if (locator.raster && !metadata.formats?.render?.includes(locator.raster.format)) {
        cacheMetadataError("Cached WMTS raster format was not advertised by layer metadata.");
      }
    }
    validateCachedTemplateOperation(metadata.operations?.tiles, ["TileMatrix", "TileRow", "TileCol"], "tile");
    validateCachedTemplateOperation(
      metadata.operations?.featureInfo,
      ["TileMatrix", "TileRow", "TileCol", "I", "J"],
      "FeatureInfo",
    );
  }
}

function validateCachedPmtilesBinding(
  source: ConnectDiscoverySourceSnapshot,
  sourceExtent: ConnectDiscoveryExtent | undefined,
  metadata: DiscoverySourceMetadata | undefined,
  evidence: readonly DiscoveryCapabilityEvidence[],
): void {
  assertCachedKeys(
    source as unknown as Record<string, unknown>,
    ["id", "locator", "title", "description", "crs", "extent", "schema", "schemaV2", "metadata", "evidence"],
    "PMTiles source",
  );
  const pmtiles = metadata?.pmtiles;
  if (!pmtiles) cacheMetadataError("Cached PMTiles source lacks bounded archive metadata.");
  const expectedSourceType =
    pmtiles.tileKind === "mvt" ? "vector" : pmtiles.tileKind === "unknown" ? undefined : "raster";
  if (source.locator.sourceType !== expectedSourceType) {
    cacheMetadataError("Cached PMTiles source type contradicts its archive tile kind.");
  }
  const tiles = resolveDiscoveryCapabilities("pmtiles", evidence).capabilities.has("tiles");
  if (tiles !== (pmtiles.tileKind !== "unknown")) {
    cacheMetadataError("Cached PMTiles tile capability contradicts its archive tile kind.");
  }
  if (source.title !== pmtiles.attribution) {
    cacheMetadataError("Cached PMTiles source attribution contradicts its raw archive metadata.");
  }
  if (
    source.description !== undefined ||
    source.crs !== undefined ||
    source.schema !== undefined ||
    source.schemaV2 !== undefined
  ) {
    cacheMetadataError("Cached PMTiles source contains a projection that direct archive discovery never emits.");
  }
  if (
    metadata.crs !== undefined ||
    metadata.protocolVersion !== undefined ||
    metadata.formats !== undefined ||
    metadata.styles !== undefined ||
    metadata.dimensions !== undefined ||
    metadata.operations !== undefined ||
    metadata.axisOrders !== undefined ||
    metadata.tileMatrixSets !== undefined
  ) {
    cacheMetadataError("Cached PMTiles metadata contains a projection that direct archive discovery never emits.");
  }
  validateCachedPmtilesExtentShape(source.extent, "source");
  validateCachedPmtilesExtentShape(source.metadata?.extent, "metadata");
  validateCachedPmtilesExtentBinding(sourceExtent, pmtiles.bounds, "source");
  validateCachedPmtilesExtentBinding(metadata.extent, pmtiles.bounds, "metadata");
  const partialReasonsMatch =
    pmtiles.tileKind === "unknown"
      ? metadata.partialReasons?.length === 1 && metadata.partialReasons[0] === PMTILES_UNKNOWN_TILE_KIND_REASON
      : metadata.partialReasons === undefined;
  if (!partialReasonsMatch) {
    cacheMetadataError("Cached PMTiles partial-discovery reasons contradict its archive tile kind.");
  }
}

function validateCachedPmtilesExtentShape(value: unknown, label: string): void {
  if (!isPlainObject(value)) {
    cacheMetadataError(`Cached PMTiles ${label} extent must be an object.`);
  }
  assertCachedKeys(value, ["spatial", "temporal"], `PMTiles ${label} extent`);
  if (!isPlainObject(value.spatial)) {
    cacheMetadataError(`Cached PMTiles ${label} spatial extent must be an object.`);
  }
  assertCachedKeys(value.spatial, ["bbox", "crs"], `PMTiles ${label} spatial extent`);
}

function validateCachedPmtilesExtentBinding(
  extent: ConnectDiscoveryExtent | undefined,
  bounds: readonly [number, number, number, number],
  label: string,
): void {
  const bbox = extent?.spatial?.bbox;
  if (
    extent === undefined ||
    extent.temporal !== undefined ||
    extent.spatial?.crs !== "OGC:CRS84" ||
    bbox?.length !== 1 ||
    bbox[0]?.length !== 4 ||
    bbox[0].some((value, index) => value !== bounds[index])
  ) {
    cacheMetadataError(`Cached PMTiles ${label} extent contradicts its reviewed OGC:CRS84 archive bounds.`);
  }
}

function validateCachedPmtilesEvidence(
  evidence: readonly DiscoveryCapabilityEvidence[],
  endpoint: string,
  retrievedAt: string,
  validator: string | undefined,
  supported: boolean,
): void {
  if (evidence.length !== 1) {
    cacheMetadataError("Cached PMTiles capability evidence must contain exactly one archive metadata record.");
  }
  const record = evidence[0];
  if (!record || !isPlainObject(record)) {
    cacheMetadataError("Cached PMTiles capability evidence must be an object.");
  }
  assertCachedKeys(record, ["kind", "capabilities", "scope", "provenance"], "PMTiles capability evidence");
  const expectedCapabilities = supported ? ["tiles"] : [];
  if (
    record.kind !== "metadata" ||
    !sameExactStringArray(record.capabilities, expectedCapabilities) ||
    !sameExactStringArray(record.scope, ["tiles"]) ||
    record.provenance?.length !== 1
  ) {
    cacheMetadataError("Cached PMTiles capability evidence contradicts direct archive discovery.");
  }
  const provenance = record.provenance[0];
  if (!isPlainObject(provenance)) {
    cacheMetadataError("Cached PMTiles capability provenance must be an object.");
  }
  assertCachedKeys(provenance, ["source", "retrievedAt", "validator"], "PMTiles capability provenance");
  if (provenance.source !== endpoint || provenance.retrievedAt !== retrievedAt || provenance.validator !== validator) {
    cacheMetadataError(
      "Cached PMTiles provenance does not bind to the archive endpoint, retrieval time, and validator.",
    );
  }
}

function sameExactStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
  );
}

function cachedPmtilesValidator(value: unknown, label: string): string {
  const validator = cachedBoundedString(value, label, PMTILES_VALIDATOR_CODE_UNITS);
  const parsed = parsePmtilesValidatorIdentity(validator);
  if (!parsed || parsed.identity !== validator) {
    cacheMetadataError(`Cached PMTiles ${label} is not a strong ETag or canonical Last-Modified validator.`);
  }
  return validator;
}

function validateCachedRasterLocatorBinding(
  value: SourceLocator["raster"],
  protocol: "wms" | "wmts",
  endpoint: string,
): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) cacheMetadataError("Cached raster binding must be an object.");
  if (protocol === "wms") {
    assertCachedKeys(value, ["kind", "url", "format"], "WMS raster binding");
    if (value.kind !== "wms-kvp") cacheMetadataError("Cached WMS raster binding kind is invalid.");
  } else {
    assertCachedKeys(value, ["kind", "url", "format", "tileMatrixTemplate"], "WMTS raster binding");
    if (value.kind !== "wmts-kvp" && value.kind !== "wmts-template") {
      cacheMetadataError("Cached WMTS raster binding kind is invalid.");
    }
    if (
      typeof value.tileMatrixTemplate !== "string" ||
      !/^[A-Za-z0-9_.:-]{0,128}\{z\}$/.test(value.tileMatrixTemplate)
    ) {
      cacheMetadataError("Cached WMTS tile-matrix template is invalid.");
    }
    if (
      value.kind === "wmts-template" &&
      (typeof value.url !== "string" ||
        !["TileMatrix", "TileRow", "TileCol"].every((name) => value.url.includes(`{${name}}`)))
    ) {
      cacheMetadataError("Cached WMTS ResourceURL binding lacks required placeholders.");
    }
  }
  validateCachedMetadataUrl(value.url, "raster binding", endpoint);
  immutableString(value.format, "Cached raster binding format");
}

function validateCachedExecutableRasterBinding(
  locator: SourceLocator,
  operation: DiscoveryOperationMetadata | undefined,
  available: boolean,
): void {
  const binding = locator.raster;
  if (available !== (binding !== undefined)) {
    cacheMetadataError("Cached raster capability and executable binding contradict each other.");
  }
  if (!binding) return;
  if (!operation?.urls.includes(binding.url) || !operation.formats.includes(binding.format)) {
    cacheMetadataError("Cached raster binding was not present in the reviewed operation metadata.");
  }
}

function validateCachedTileMatrixBinding(locator: SourceLocator, metadata: DiscoverySourceMetadata): void {
  const binding = locator.raster;
  if (!binding || binding.kind === "wms-kvp") return;
  const matrixSet = metadata.tileMatrixSets?.find((candidate) => candidate.id === locator.tileMatrixSetId);
  if (
    !matrixSet ||
    mapLibreMatrixSetUnavailableReason(matrixSet) !== undefined ||
    mapLibreTileMatrixTemplate(matrixSet.matrices.map((matrix) => matrix.id)) !== binding.tileMatrixTemplate
  ) {
    cacheMetadataError("Cached WMTS raster binding does not match a proven GoogleMapsCompatible tile matrix set.");
  }
}

function validateCachedWmsAxisOrders(metadata: DiscoverySourceMetadata): void {
  const crs = metadata.crs ?? [];
  const axes = metadata.axisOrders ?? [];
  const axisCrs = axes.map((axis) => axis.crs);
  if (axes.length !== crs.length || new Set(axisCrs).size !== axisCrs.length) {
    cacheMetadataError("Cached WMS axis metadata must contain exactly one entry per advertised CRS.");
  }
  for (const advertised of crs) {
    const axis = axes.find((candidate) => candidate.crs === advertised);
    if (!axis || axis.order !== advertisedWmsAxisOrder(advertised)) {
      cacheMetadataError("Cached WMS axis metadata contradicts the advertised CRS identifiers.");
    }
  }
}

function validateCachedTemplateOperation(
  operation: DiscoveryOperationMetadata | undefined,
  required: readonly string[],
  label: string,
): void {
  if (!operation?.methods.includes("TEMPLATE")) return;
  const templates = operation.urls.filter((url) => url.includes("{") || url.includes("}"));
  if (
    templates.length === 0 ||
    templates.some((template) => required.some((placeholder) => !template.includes(`{${placeholder}}`)))
  ) {
    cacheMetadataError(`Cached WMTS ${label} template lacks required placeholders.`);
  }
}

function validateCachedDiscoveryExtent(extent: unknown): ConnectDiscoveryExtent {
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

function validateCachedDiscoveryMetadata(
  value: DiscoverySourceMetadata,
  endpoint: string,
  pmtilesLimits?: ReturnType<typeof normalizePmtilesDiscoveryLimits>,
): DiscoverySourceMetadata {
  if (!isPlainObject(value)) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached source metadata must be an object.");
  }
  assertCachedKeys(
    value,
    [
      "crs",
      "extent",
      "protocolVersion",
      "formats",
      "styles",
      "dimensions",
      "operations",
      "axisOrders",
      "tileMatrixSets",
      "pmtiles",
      "partialReasons",
    ],
    "source metadata",
  );
  const crs = value.crs !== undefined ? immutableStrings(value.crs, "Cached source metadata crs") : undefined;
  const extent = value.extent !== undefined ? validateCachedDiscoveryExtent(value.extent) : undefined;
  const protocolVersion =
    value.protocolVersion !== undefined
      ? immutableString(value.protocolVersion, "Cached source metadata protocolVersion")
      : undefined;
  const formats = value.formats !== undefined ? validateCachedFormats(value.formats) : undefined;
  const styles =
    value.styles !== undefined
      ? Object.freeze(
          checkedArray(value.styles, "Cached source metadata styles", 512).map((style) => {
            if (!isPlainObject(style)) cacheMetadataError("Cached source style must be an object.");
            assertCachedKeys(style, ["id", "title", "isDefault", "legendUrl", "legendFormat"], "source style");
            if (typeof style.isDefault !== "boolean")
              cacheMetadataError("Cached source style isDefault must be boolean.");
            return Object.freeze({
              id: immutableString(style.id, "Cached source style id"),
              ...(style.title !== undefined
                ? { title: immutableString(style.title, "Cached source style title") }
                : {}),
              isDefault: style.isDefault,
              ...(style.legendUrl !== undefined
                ? { legendUrl: validateCachedMetadataUrl(style.legendUrl, "style legend", endpoint) }
                : {}),
              ...(style.legendFormat !== undefined
                ? { legendFormat: immutableString(style.legendFormat, "Cached source style legendFormat") }
                : {}),
            });
          }),
        )
      : undefined;
  const dimensions =
    value.dimensions !== undefined
      ? Object.freeze(
          checkedArray(value.dimensions, "Cached source metadata dimensions", 512).map((dimension) => {
            if (!isPlainObject(dimension)) cacheMetadataError("Cached source dimension must be an object.");
            assertCachedKeys(dimension, ["id", "units", "default", "current", "values"], "source dimension");
            if (dimension.current !== undefined && typeof dimension.current !== "boolean") {
              cacheMetadataError("Cached source dimension current must be boolean.");
            }
            return Object.freeze({
              id: immutableString(dimension.id, "Cached source dimension id"),
              ...(dimension.units !== undefined
                ? { units: immutableString(dimension.units, "Cached source dimension units") }
                : {}),
              ...(dimension.default !== undefined
                ? { default: immutableString(dimension.default, "Cached source dimension default") }
                : {}),
              ...(dimension.current !== undefined ? { current: dimension.current } : {}),
              values: immutableStrings(
                checkedArray(dimension.values, "Cached source dimension values", 10_000),
                "Cached source dimension values",
              ),
            });
          }),
        )
      : undefined;
  const operations = value.operations !== undefined ? validateCachedOperations(value.operations, endpoint) : undefined;
  const axisOrders =
    value.axisOrders !== undefined
      ? Object.freeze(
          checkedArray(value.axisOrders, "Cached source metadata axisOrders", 512).map((axis) => {
            if (!isPlainObject(axis)) cacheMetadataError("Cached axis order must be an object.");
            assertCachedKeys(axis, ["crs", "order"], "axis order");
            if (axis.order !== "xy" && axis.order !== "yx" && axis.order !== "unknown") {
              cacheMetadataError("Cached axis order is invalid.");
            }
            return Object.freeze({ crs: immutableString(axis.crs, "Cached axis order crs"), order: axis.order });
          }),
        )
      : undefined;
  const tileMatrixSets =
    value.tileMatrixSets !== undefined
      ? Object.freeze(
          checkedArray(value.tileMatrixSets, "Cached source metadata tileMatrixSets", 256).map((matrixSet) => {
            if (!isPlainObject(matrixSet)) cacheMetadataError("Cached tile matrix set must be an object.");
            assertCachedKeys(matrixSet, ["id", "crs", "wellKnownScaleSet", "matrices"], "tile matrix set");
            const matrices = Object.freeze(
              checkedArray(matrixSet.matrices, "Cached tile matrix set matrices", 2048).map((matrix) => {
                if (!isPlainObject(matrix)) cacheMetadataError("Cached tile matrix must be an object.");
                assertCachedKeys(
                  matrix,
                  ["id", "scaleDenominator", "matrixWidth", "matrixHeight", "tileWidth", "tileHeight", "topLeftCorner"],
                  "tile matrix",
                );
                const topLeftCorner = checkedArray(matrix.topLeftCorner, "Cached tile matrix topLeftCorner", 2);
                if (
                  topLeftCorner.length !== 2 ||
                  topLeftCorner.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
                ) {
                  cacheMetadataError("Cached tile matrix topLeftCorner must contain two finite numbers.");
                }
                for (const key of [
                  "scaleDenominator",
                  "matrixWidth",
                  "matrixHeight",
                  "tileWidth",
                  "tileHeight",
                ] as const) {
                  if (typeof matrix[key] !== "number" || !Number.isFinite(matrix[key]) || matrix[key] <= 0) {
                    cacheMetadataError(`Cached tile matrix ${key} must be a positive finite number.`);
                  }
                }
                return Object.freeze({
                  id: immutableString(matrix.id, "Cached tile matrix id"),
                  scaleDenominator: positiveCachedNumber(matrix.scaleDenominator, "scaleDenominator"),
                  matrixWidth: positiveCachedInteger(matrix.matrixWidth, "matrixWidth"),
                  matrixHeight: positiveCachedInteger(matrix.matrixHeight, "matrixHeight"),
                  tileWidth: positiveCachedInteger(matrix.tileWidth, "tileWidth"),
                  tileHeight: positiveCachedInteger(matrix.tileHeight, "tileHeight"),
                  topLeftCorner: Object.freeze([topLeftCorner[0] as number, topLeftCorner[1] as number] as const),
                });
              }),
            );
            return Object.freeze({
              id: immutableString(matrixSet.id, "Cached tile matrix set id"),
              ...(matrixSet.crs !== undefined
                ? { crs: immutableString(matrixSet.crs, "Cached tile matrix set crs") }
                : {}),
              ...(matrixSet.wellKnownScaleSet !== undefined
                ? {
                    wellKnownScaleSet: immutableString(
                      matrixSet.wellKnownScaleSet,
                      "Cached tile matrix set wellKnownScaleSet",
                    ),
                  }
                : {}),
              matrices,
            });
          }),
        )
      : undefined;
  const pmtiles = value.pmtiles !== undefined ? validateCachedPmtilesMetadata(value.pmtiles, pmtilesLimits) : undefined;
  const partialReasons =
    value.partialReasons !== undefined
      ? immutableStrings(
          checkedArray(value.partialReasons, "Cached source metadata partialReasons", 512),
          "Cached source metadata partialReasons",
        )
      : undefined;
  return Object.freeze({
    ...(crs ? { crs } : {}),
    ...(extent ? { extent } : {}),
    ...(protocolVersion ? { protocolVersion } : {}),
    ...(formats ? { formats } : {}),
    ...(styles ? { styles } : {}),
    ...(dimensions ? { dimensions } : {}),
    ...(operations ? { operations } : {}),
    ...(axisOrders ? { axisOrders } : {}),
    ...(tileMatrixSets ? { tileMatrixSets } : {}),
    ...(pmtiles ? { pmtiles } : {}),
    ...(partialReasons ? { partialReasons } : {}),
  });
}

function validateCachedPmtilesMetadata(
  value: unknown,
  limits: ReturnType<typeof normalizePmtilesDiscoveryLimits> | undefined,
): NonNullable<DiscoverySourceMetadata["pmtiles"]> {
  if (!isPlainObject(value)) cacheMetadataError("Cached PMTiles metadata must be an object.");
  if (!limits) cacheMetadataError("Cached PMTiles metadata is present outside a PMTiles discovery boundary.");
  assertCachedKeys(
    value,
    [
      "specVersion",
      "tileKind",
      "bounds",
      "minZoom",
      "maxZoom",
      "center",
      "vectorLayers",
      "attribution",
      "metadataJson",
      "validator",
      "transfer",
    ],
    "PMTiles metadata",
  );
  if (value.specVersion !== 3) cacheMetadataError("Cached PMTiles specVersion must be 3.");
  const tileKinds = ["mvt", "png", "jpeg", "webp", "avif", "unknown"] as const;
  if (!tileKinds.includes(value.tileKind as (typeof tileKinds)[number])) {
    cacheMetadataError("Cached PMTiles tileKind is invalid.");
  }
  const bounds = cachedFiniteTuple(value.bounds, 4, "bounds");
  if (
    bounds[0]! < -180 ||
    bounds[2]! > 180 ||
    bounds[1]! < -90 ||
    bounds[3]! > 90 ||
    bounds[0]! > bounds[2]! ||
    bounds[1]! > bounds[3]!
  ) {
    cacheMetadataError("Cached PMTiles bounds are outside OGC:CRS84.");
  }
  const minZoom = cachedZoom(value.minZoom, "minZoom");
  const maxZoom = cachedZoom(value.maxZoom, "maxZoom");
  if (minZoom > maxZoom) cacheMetadataError("Cached PMTiles minZoom exceeds maxZoom.");
  const center = cachedFiniteTuple(value.center, 3, "center");
  if (
    center[0]! < -180 ||
    center[0]! > 180 ||
    center[1]! < -90 ||
    center[1]! > 90 ||
    !Number.isInteger(center[2]) ||
    center[2]! < 0 ||
    center[2]! > 255
  ) {
    cacheMetadataError(
      "Cached PMTiles center must contain bounded longitude/latitude and an unsigned 8-bit display zoom.",
    );
  }
  const vectorLayers = Object.freeze(
    checkedArray(value.vectorLayers, "Cached PMTiles vectorLayers", PMTILES_RETAINED_VECTOR_LAYER_ENTRIES).map(
      (layer) => {
        if (!isPlainObject(layer)) cacheMetadataError("Cached PMTiles vector layer must be an object.");
        assertCachedKeys(layer, ["id", "description", "minZoom", "maxZoom", "fields"], "PMTiles vector layer");
        let fields: Readonly<Record<string, string>> | undefined;
        if (layer.fields !== undefined) {
          if (!isPlainObject(layer.fields) || Object.keys(layer.fields).length > 4096) {
            cacheMetadataError("Cached PMTiles vector layer fields must be a bounded object.");
          }
          fields = Object.freeze(
            Object.fromEntries(
              Object.entries(layer.fields).map(([name, type]) => {
                if (typeof type !== "string" || !type || type.length > 1024 || !name || name.length > 1024) {
                  cacheMetadataError("Cached PMTiles vector layer field is invalid.");
                }
                return [name, type];
              }),
            ),
          );
        }
        const layerMinZoom =
          layer.minZoom !== undefined ? cachedZoom(layer.minZoom, "vector layer minZoom") : undefined;
        const layerMaxZoom =
          layer.maxZoom !== undefined ? cachedZoom(layer.maxZoom, "vector layer maxZoom") : undefined;
        if (layerMinZoom !== undefined && layerMaxZoom !== undefined && layerMinZoom > layerMaxZoom) {
          cacheMetadataError("Cached PMTiles vector layer minZoom exceeds maxZoom.");
        }
        return Object.freeze({
          id: cachedBoundedString(layer.id, "vector layer id", 1024),
          ...(layer.description !== undefined
            ? { description: cachedBoundedString(layer.description, "vector layer description", 4096) }
            : {}),
          ...(layerMinZoom !== undefined ? { minZoom: layerMinZoom } : {}),
          ...(layerMaxZoom !== undefined ? { maxZoom: layerMaxZoom } : {}),
          ...(fields ? { fields } : {}),
        });
      },
    ),
  );
  if (pmtilesVectorLayerStructuralNodes(vectorLayers) > PMTILES_RETAINED_VECTOR_LAYER_NODES) {
    cacheMetadataError("Cached PMTiles normalized vector-layer metadata exceeds its retained-structure ceiling.");
  }
  const attribution =
    value.attribution !== undefined ? cachedBoundedString(value.attribution, "attribution", 4096) : undefined;
  if (!isPlainObject(value.transfer)) cacheMetadataError("Cached PMTiles transfer evidence must be an object.");
  assertCachedKeys(
    value.transfer,
    ["requests", "bytesFetched", "decompressedBytes", "ranges"],
    "PMTiles transfer evidence",
  );
  const requests = positiveCachedInteger(value.transfer.requests, "PMTiles requests");
  if (requests > limits.maxRequests) cacheMetadataError("Cached PMTiles transfer exceeds its request-policy ceiling.");
  const bytesFetched = positiveCachedInteger(value.transfer.bytesFetched, "PMTiles bytesFetched");
  if (bytesFetched > limits.maxTotalBytes) {
    cacheMetadataError("Cached PMTiles transfer exceeds its total-byte policy ceiling.");
  }
  const decompressedBytes = nonNegativeCachedInteger(value.transfer.decompressedBytes, "PMTiles decompressedBytes");
  if (decompressedBytes > limits.maxDecompressedBytes) {
    cacheMetadataError("Cached PMTiles transfer exceeds its decompression-policy ceiling.");
  }
  const retainedMetadata = validateCachedPmtilesMetadataJson(value.metadataJson, decompressedBytes);
  validateCachedPmtilesMetadataBinding(retainedMetadata.parsed, attribution, vectorLayers);
  let archiveLength: number | undefined;
  let rangeValidator: string | undefined;
  let rangeValidatorObserved = false;
  const priorPhysicalRanges: Array<{ readonly offset: number; readonly length: number }> = [];
  const ranges = Object.freeze(
    checkedArray(value.transfer.ranges, "Cached PMTiles transfer ranges", limits.maxRequests).map((range, index) => {
      if (!isPlainObject(range)) cacheMetadataError("Cached PMTiles range evidence must be an object.");
      assertCachedKeys(
        range,
        ["offset", "length", "bytesReceived", "status", "contentRange", "validator"],
        "PMTiles range evidence",
      );
      if (
        !Number.isSafeInteger(range.offset) ||
        (range.offset as number) < 0 ||
        !Number.isSafeInteger(range.length) ||
        (range.length as number) <= 0 ||
        (range.length as number) > limits.maxRangeBytes ||
        range.bytesReceived !== range.length ||
        range.status !== 206
      ) {
        cacheMetadataError("Cached PMTiles range evidence is invalid.");
      }
      const offset = range.offset as number;
      const length = range.length as number;
      if (!Number.isSafeInteger(offset + length - 1)) {
        cacheMetadataError("Cached PMTiles range offset and length overflow.");
      }
      const parsed = cachedPmtilesContentRange(range.contentRange);
      if (
        parsed.start !== offset ||
        parsed.end !== offset + length - 1 ||
        parsed.total <= parsed.end ||
        (parsed.start === 0 && parsed.end + 1 === parsed.total)
      ) {
        cacheMetadataError("Cached PMTiles Content-Range does not bind to its partial range ledger.");
      }
      if (index === 0 && (offset !== 0 || length !== 16_384)) {
        cacheMetadataError("Cached PMTiles evidence must begin with the exact 0-16383 header range.");
      }
      if (
        priorPhysicalRanges.some((prior) => prior.offset <= offset && prior.offset + prior.length >= offset + length)
      ) {
        cacheMetadataError("Cached PMTiles range evidence includes an impossible fully covered physical request.");
      }
      priorPhysicalRanges.push({ offset, length });
      if (archiveLength !== undefined && archiveLength !== parsed.total) {
        cacheMetadataError("Cached PMTiles ranges disagree on archive length.");
      }
      archiveLength = parsed.total;
      const validator =
        range.validator !== undefined ? cachedPmtilesValidator(range.validator, "range validator") : undefined;
      if (rangeValidatorObserved && validator !== rangeValidator) {
        cacheMetadataError("Cached PMTiles ranges disagree on archive validator.");
      }
      rangeValidatorObserved = true;
      rangeValidator = validator;
      return Object.freeze({
        offset,
        length,
        bytesReceived: range.bytesReceived as number,
        status: 206 as const,
        contentRange: cachedBoundedString(range.contentRange, "range contentRange", 256),
        ...(validator !== undefined ? { validator } : {}),
      });
    }),
  );
  if (ranges.length !== requests || ranges.reduce((sum, range) => sum + range.bytesReceived, 0) !== bytesFetched) {
    cacheMetadataError("Cached PMTiles transfer totals do not match its range ledger.");
  }
  if (archiveLength !== undefined && pmtilesRangesCoverWholeArchive(ranges, archiveLength)) {
    cacheMetadataError("Cached PMTiles transfer evidence collectively materializes the complete archive.");
  }
  if (ranges.length > 1 && rangeValidator === undefined) {
    cacheMetadataError(
      "Cached multi-range PMTiles evidence requires a strong ETag or canonical Last-Modified validator.",
    );
  }
  const validator = value.validator !== undefined ? cachedPmtilesValidator(value.validator, "validator") : undefined;
  if (validator !== rangeValidator) {
    cacheMetadataError("Cached PMTiles archive validator disagrees with its range ledger.");
  }
  return Object.freeze({
    specVersion: 3,
    tileKind: value.tileKind as NonNullable<DiscoverySourceMetadata["pmtiles"]>["tileKind"],
    bounds: Object.freeze(bounds as [number, number, number, number]),
    minZoom,
    maxZoom,
    center: Object.freeze(center as [number, number, number]),
    vectorLayers,
    ...(attribution !== undefined ? { attribution } : {}),
    metadataJson: retainedMetadata.json,
    ...(validator !== undefined ? { validator } : {}),
    transfer: Object.freeze({ requests, bytesFetched, decompressedBytes, ranges }),
  });
}

function validateCachedPmtilesMetadataJson(
  value: unknown,
  maximumBytes: number,
): { readonly json: string; readonly parsed: Record<string, unknown> } {
  if (
    typeof value !== "string" ||
    value.length > MAX_CACHE_SNAPSHOT_SINGLE_STRING_CODE_UNITS ||
    new TextEncoder().encode(value).byteLength > Math.min(maximumBytes, PMTILES_RETAINED_METADATA_JSON_BYTES)
  ) {
    cacheMetadataError("Cached PMTiles raw metadata must be bounded JSON text.");
  }
  let parsed: unknown;
  let canonical: string | undefined;
  try {
    parsed = JSON.parse(value);
    canonical = JSON.stringify(parsed);
  } catch {
    cacheMetadataError("Cached PMTiles raw metadata is not valid JSON.");
  }
  if (!isPlainObject(parsed) || canonical !== value) {
    cacheMetadataError("Cached PMTiles raw metadata must be a canonical JSON object.");
  }
  return Object.freeze({ json: value, parsed });
}

function validateCachedPmtilesMetadataBinding(
  metadata: Readonly<Record<string, unknown>>,
  attribution: string | undefined,
  vectorLayers: readonly PmtilesVectorLayerInfo[],
): void {
  const rawAttribution =
    typeof metadata.attribution === "string" && metadata.attribution.length > 0 ? metadata.attribution : undefined;
  if (rawAttribution !== attribution) {
    cacheMetadataError("Cached PMTiles raw attribution contradicts its normalized metadata.");
  }

  const rawLayers = Array.isArray(metadata.vector_layers) ? metadata.vector_layers : [];
  if (rawLayers.length > PMTILES_RETAINED_VECTOR_LAYER_ENTRIES) {
    cacheMetadataError("Cached PMTiles raw metadata contains too many vector layers.");
  }
  const projected: Array<{
    id: string;
    description?: string;
    minZoom?: number;
    maxZoom?: number;
    fields?: Record<string, string>;
  }> = [];
  for (const entry of rawLayers) {
    if (!isPlainObject(entry) || typeof entry.id !== "string" || entry.id.length === 0) continue;
    const layer: {
      id: string;
      description?: string;
      minZoom?: number;
      maxZoom?: number;
      fields?: Record<string, string>;
    } = { id: entry.id };
    if (typeof entry.description === "string" && entry.description.length > 0) {
      layer.description = entry.description;
    }
    if (typeof entry.minzoom === "number") layer.minZoom = entry.minzoom;
    if (typeof entry.maxzoom === "number") layer.maxZoom = entry.maxzoom;
    if (entry.fields !== undefined && typeof entry.fields === "object" && entry.fields !== null) {
      const fields = Object.entries(entry.fields);
      if (fields.some(([, type]) => typeof type !== "string")) {
        cacheMetadataError("Cached PMTiles raw vector-layer fields contradict normalized metadata.");
      }
      layer.fields = Object.fromEntries(fields) as Record<string, string>;
    }
    projected.push(layer);
  }
  if (JSON.stringify(projected) !== JSON.stringify(vectorLayers)) {
    cacheMetadataError("Cached PMTiles raw vector layers contradict normalized metadata.");
  }
}

function cachedPmtilesContentRange(value: unknown): { start: number; end: number; total: number } {
  const text = cachedBoundedString(value, "range contentRange", 256);
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(text);
  if (!match) cacheMetadataError("Cached PMTiles Content-Range is invalid.");
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= 0
  ) {
    cacheMetadataError("Cached PMTiles Content-Range is invalid.");
  }
  return { start, end, total };
}

function cachedFiniteTuple(value: unknown, length: number, label: string): number[] {
  const values = checkedArray(value, `Cached PMTiles ${label}`, length);
  if (values.length !== length || values.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    cacheMetadataError(`Cached PMTiles ${label} must contain ${length} finite numbers.`);
  }
  return [...values] as number[];
}

function cachedZoom(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 30) {
    cacheMetadataError(`Cached PMTiles ${label} must be an integer from 0 through 30.`);
  }
  return value as number;
}

function cachedBoundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum) {
    cacheMetadataError(`Cached PMTiles ${label} must contain 1-${maximum} characters.`);
  }
  return value;
}

function validateCachedFormats(value: unknown) {
  if (!isPlainObject(value)) cacheMetadataError("Cached source formats must be an object.");
  assertCachedKeys(value, ["render", "featureInfo", "legend"], "source formats");
  return Object.freeze({
    ...(value.render !== undefined ? { render: immutableStrings(value.render, "Cached render formats") } : {}),
    ...(value.featureInfo !== undefined
      ? { featureInfo: immutableStrings(value.featureInfo, "Cached featureInfo formats") }
      : {}),
    ...(value.legend !== undefined ? { legend: immutableStrings(value.legend, "Cached legend formats") } : {}),
  });
}

function validateCachedOperations(value: unknown, endpoint: string) {
  if (!isPlainObject(value)) cacheMetadataError("Cached source operations must be an object.");
  assertCachedKeys(value, ["render", "tiles", "featureInfo", "legend"], "source operations");
  const operation = (entry: unknown, label: string) => {
    if (!isPlainObject(entry)) cacheMetadataError(`Cached ${label} operation must be an object.`);
    assertCachedKeys(entry, ["available", "methods", "urls", "formats", "reason"], `${label} operation`);
    if (typeof entry.available !== "boolean")
      cacheMetadataError(`Cached ${label} operation available must be boolean.`);
    const methods = checkedArray(entry.methods, `Cached ${label} operation methods`, 3);
    if (methods.some((method) => method !== "GET" && method !== "POST" && method !== "TEMPLATE")) {
      cacheMetadataError(`Cached ${label} operation method is invalid.`);
    }
    const urls = checkedArray(entry.urls, `Cached ${label} operation urls`, 16).map((url) =>
      validateCachedMetadataUrl(url, `${label} operation`, endpoint),
    );
    const formats = immutableStrings(
      checkedArray(entry.formats, `Cached ${label} operation formats`, 128),
      `Cached ${label} operation formats`,
    );
    if (entry.reason !== undefined && (typeof entry.reason !== "string" || !entry.reason.trim())) {
      cacheMetadataError(`Cached ${label} operation reason is invalid.`);
    }
    if (entry.available && (urls.length === 0 || formats.length === 0 || methods.length === 0)) {
      cacheMetadataError(`Cached available ${label} operation lacks a URL, method, or format.`);
    }
    if (methods.includes("TEMPLATE") && !urls.some((url) => url.includes("{") && url.includes("}"))) {
      cacheMetadataError(`Cached ${label} template operation lacks placeholders.`);
    }
    return Object.freeze({
      available: entry.available,
      methods: Object.freeze([...methods] as Array<"GET" | "POST" | "TEMPLATE">),
      urls: Object.freeze(urls),
      formats,
      ...(entry.reason ? { reason: entry.reason } : {}),
    });
  };
  return Object.freeze({
    ...(value.render !== undefined ? { render: operation(value.render, "render") } : {}),
    ...(value.tiles !== undefined ? { tiles: operation(value.tiles, "tiles") } : {}),
    ...(value.featureInfo !== undefined ? { featureInfo: operation(value.featureInfo, "featureInfo") } : {}),
    ...(value.legend !== undefined ? { legend: operation(value.legend, "legend") } : {}),
  });
}

function checkedArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    cacheMetadataError(`${label} must be an array with at most ${maximum} entries.`);
  }
  return value;
}

function positiveCachedNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    cacheMetadataError(`Cached tile matrix ${label} must be a positive finite number.`);
  }
  return value;
}

function positiveCachedInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    cacheMetadataError(`Cached tile matrix ${label} must be a positive safe integer.`);
  }
  return value as number;
}

function nonNegativeCachedInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    cacheMetadataError(`Cached ${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function validateCachedMetadataUrl(value: unknown, label: string, endpoint: string): string {
  if (typeof value !== "string" || !value.trim()) cacheMetadataError(`Cached ${label} URL must be a string.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    cacheMetadataError(`Cached ${label} URL must be absolute.`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    cacheMetadataError(`Cached ${label} URL is unsafe.`);
  }
  if (parsed.origin !== new URL(endpoint).origin) {
    cacheMetadataError(`Cached ${label} URL must remain on the discovery endpoint origin.`);
  }
  for (const name of parsed.searchParams.keys()) {
    if (isCredentialQueryName(name)) {
      cacheMetadataError(`Cached ${label} URL contains credential-bearing query state.`);
    }
  }
  canonicalizeUrlQuery(parsed);
  return parsed.toString().replace(/%7B([A-Za-z_][A-Za-z0-9_.:-]{0,127})%7D/gi, (_match, name: string) => `{${name}}`);
}

function assertCachedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    cacheMetadataError(`Cached ${label} contains unknown fields.`);
  }
}

function cacheMetadataError(message: string): never {
  throw new HonuaDiscoveryError("invalid-discovery-cache", message);
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
