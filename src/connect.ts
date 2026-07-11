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

import { type ConnectTarget, discoverGeoServicesSources, resolveConnectTarget } from "./connect-geoservices.js";
import {
  type DiscoveryCacheIdentity,
  type DiscoveryCapabilityEvidence,
  type DiscoveryCapabilityPolicy,
  type DiscoveryDiagnostic,
  type DiscoveryProvenance,
  type SourceDiscoveryInspection,
  createDiscoveryCacheIdentity,
  inspectDiscoveredSource,
  resolveDiscoveryCapabilities,
} from "./contract/discovery.js";
import { createDataset } from "./contract/source.js";
import type {
  Dataset,
  Protocol,
  Source,
  SourceDescriptor,
  SourceId,
  SourceLocator,
  SourceSchema,
} from "./contract/types.js";
import type { HonuaMetadataRequestOptions } from "./core/cache-state.js";
import { HonuaClient } from "./core/client.js";
import { HonuaAbortError, HonuaDiscoveryError } from "./core/errors.js";
import { negotiateOgcCapabilities } from "./core/ogc-conformance.js";
import { findOgcLink, ogcApiFeaturesLayout } from "./core/ogc-endpoint-layout.js";
import type {
  HonuaClientOptions,
  HonuaOgcCollectionSummary,
  HonuaOgcCollectionsResponse,
  HonuaOgcConformanceResponse,
  HonuaOgcLandingResponse,
  OgcEndpointLayout,
} from "./core/types.js";

/** Schema version for values stored through {@link ConnectDiscoveryCache}. */
export const HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION = 2 as const;
/** Adapter version used to invalidate logical discovery identities. */
export const HONUA_CONNECT_ADAPTER_VERSION = "honua-connect@2";
/** Normalized facade projection version used to invalidate cached snapshots. */
export const HONUA_CONNECT_PROJECTION_VERSION = "honua-connect-source-descriptor@1";

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
  readonly schema?: SourceSchema;
  readonly evidence?: readonly DiscoveryCapabilityEvidence[];
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
  /** OGC API landing page or canonical GeoServices service/layer URL. */
  readonly endpoint: string | URL;
  /** Protocol hint. `auto` recognizes canonical GeoServices URL structure without probing. */
  readonly protocol: ConnectProtocolHint;
  /** Restrict discovery to one collection while retaining the service root URL. */
  readonly collectionId?: string;
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
  source<T = Record<string, unknown>>(id?: SourceId): Source<T>;
}

export type ConnectResolvedProtocol = "ogc-features" | "geoservices-feature-service" | "geoservices-map-service";

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
  throwIfAborted(options.signal);
  const endpoint = validateConnectEndpoint(options.endpoint);
  const target = resolveConnectTarget(endpoint, options.protocol);
  if (target.protocol !== "ogc-features" && options.collectionId !== undefined) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "collectionId is only valid for OGC API Features connections; select a GeoServices layer in the endpoint URL.",
    );
  }
  if (options.client && options.clientOptions) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Pass either client or clientOptions to connect(), not both.");
  }

  const identity = await createDiscoveryCacheIdentity({
    endpoint: target.endpoint,
    protocol: target.protocol,
    authorizationScopeFingerprint: options.authorizationScopeFingerprint,
    adapterVersion: HONUA_CONNECT_ADAPTER_VERSION,
    projectionVersion: HONUA_CONNECT_PROJECTION_VERSION,
    ...(options.collectionId ? { collectionId: options.collectionId } : {}),
    ...(target.serviceId ? { serviceId: target.serviceId } : {}),
    ...(target.layerId !== undefined ? { layerId: target.layerId } : {}),
  });
  if (options.client) assertClientEndpoint(options.client, target.clientBaseUrl);
  const cacheContext = Object.freeze({ ...(options.signal ? { signal: options.signal } : {}) });
  let snapshot: ConnectDiscoverySnapshot | undefined;
  let cacheStatus: ConnectCacheStatus = options.cache ? "miss" : "bypass";

  if (options.cache && options.refresh !== true) {
    snapshot = await awaitAbortable(options.cache.get(identity, cacheContext), options.signal);
    throwIfAborted(options.signal);
    if (snapshot) {
      snapshot = validateSnapshot(snapshot, identity, target, options.collectionId);
      cacheStatus = "hit";
    }
  }

  const client = options.client ?? new HonuaClient({ ...options.clientOptions, baseUrl: target.clientBaseUrl });
  if (!snapshot) {
    snapshot =
      target.protocol === "ogc-features"
        ? await discoverOgcFeatures(client, identity, options)
        : await discoverGeoServices(client, identity, target, options);
    if (options.cache) {
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
        ...(source.title ? { attribution: source.title } : {}),
      };
      return inspectDiscoveredSource(descriptor, resolution);
    }),
  );
  const id = options.id?.trim() || identity.endpoint;
  const dataset = createDataset({
    id,
    client,
    sources: inspections.map((entry) => entry.descriptor),
    skipCompatibilityCheck: true,
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
    source<T = Record<string, unknown>>(sourceId?: SourceId): Source<T> {
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

async function discoverGeoServices(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  target: ConnectTarget,
  options: ConnectOptions,
): Promise<ConnectDiscoverySnapshot> {
  const discovered = await discoverGeoServicesSources(client, target, options);
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
): readonly HonuaOgcCollectionSummary[] {
  if (!Array.isArray(response.collections) || response.collections.length === 0) {
    throw new HonuaDiscoveryError("invalid-endpoint", "OGC API Features discovery returned no collections.");
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
): ConnectDiscoverySnapshot {
  if (
    value?.version !== HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION ||
    value.identityKey !== identity.key ||
    value.endpoint !== identity.endpoint ||
    value.protocol !== target.protocol ||
    !Array.isArray(value.evidence) ||
    !Array.isArray(value.sources) ||
    value.sources.length === 0
  ) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Discovery cache returned an incompatible snapshot.", {
      expectedVersion: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
      expectedIdentityKey: identity.key,
    });
  }
  const sourceIds = new Set<string>();
  const sources = value.sources.map((source) => {
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
    if (source.evidence !== undefined && (!Array.isArray(source.evidence) || source.evidence.length === 0)) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached source evidence must be a non-empty array.");
    }
    if (source.evidence === undefined && value.evidence.length === 0) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached source has no capability evidence.");
    }
    return Object.freeze({
      id: source.id,
      locator: Object.freeze({ ...source.locator }),
      ...(source.title ? { title: source.title } : {}),
      ...(source.description ? { description: source.description } : {}),
      ...(source.crs ? { crs: Object.freeze([...source.crs]) } : {}),
      ...(source.schema
        ? {
            schema: Object.freeze({
              ...source.schema,
              ...(source.schema.fields ? { fields: Object.freeze([...source.schema.fields]) } : {}),
            }),
          }
        : {}),
      ...(source.evidence ? { evidence: Object.freeze([...source.evidence]) } : {}),
    });
  });
  if (collectionId && (sources.length !== 1 || String(sources[0]?.locator.collectionId ?? "") !== collectionId)) {
    throw new HonuaDiscoveryError(
      "invalid-discovery-cache",
      "Discovery cache snapshot does not match the requested collection.",
      { collectionId },
    );
  }
  return Object.freeze({ ...value, evidence: Object.freeze([...value.evidence]), sources: Object.freeze(sources) });
}

function validateSnapshotLocator(sourceId: string, locator: SourceLocator, target: ConnectTarget): void {
  if (target.protocol === "ogc-features") {
    if (
      locator.url !== target.endpoint ||
      locator.layout !== "ogc-api" ||
      typeof locator.collectionId !== "string" ||
      !locator.collectionId ||
      sourceId !== locator.collectionId
    ) {
      throw new HonuaDiscoveryError(
        "invalid-discovery-cache",
        "Cached OGC source locator does not match the endpoint.",
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
