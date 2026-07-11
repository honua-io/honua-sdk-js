/**
 * Explicit, fail-closed connection discovery facade.
 *
 * This is a bounded first facade slice: callers must name a protocol and the
 * only built-in discovery adapter currently reviewed here is OGC API Features.
 * No endpoint is probed as a different protocol when discovery fails.
 *
 * @experimental
 */

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
import type { Dataset, Protocol, Source, SourceDescriptor, SourceId } from "./contract/types.js";
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
export const HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION = 1 as const;
/** Adapter version used to invalidate logical discovery identities. */
export const HONUA_CONNECT_ADAPTER_VERSION = "honua-connect-ogc-features@1";
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
  readonly collectionId: string;
  readonly title?: string;
  readonly description?: string;
  readonly crs?: readonly string[];
}

/** Serializable, versioned observation persisted through a discovery cache. */
export interface ConnectDiscoverySnapshot {
  readonly version: typeof HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION;
  readonly identityKey: string;
  readonly endpoint: string;
  readonly protocol: "ogc-features";
  readonly retrievedAt: string;
  readonly evidence: readonly DiscoveryCapabilityEvidence[];
  readonly sources: readonly ConnectDiscoverySourceSnapshot[];
}

export interface ConnectOptions {
  /** OGC API landing-page URL. */
  readonly endpoint: string | URL;
  /** Required protocol hint. `auto` fails without performing network probes. */
  readonly protocol: ConnectProtocolHint;
  /** Restrict discovery to one collection while retaining the service root URL. */
  readonly collectionId?: string;
  /** Optional dataset id; defaults to the redacted normalized endpoint. */
  readonly id?: string;
  /** Stable ACL/audience fingerprint. Never pass a bearer token or API key. */
  readonly authorizationScopeFingerprint: string;
  /** Existing client configured for `endpoint`, useful for persistent metadata validators. */
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
  readonly protocol: "ogc-features";
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

/**
 * Discover an explicitly identified endpoint and return reviewed descriptors.
 *
 * This function never guesses a protocol and never falls back to another
 * authenticated endpoint layout. Unsupported hints fail before client/auth or
 * cache hooks are invoked.
 *
 * @experimental
 */
export async function connect(options: ConnectOptions): Promise<HonuaConnection> {
  assertExplicitSupportedProtocol(options.protocol);
  throwIfAborted(options.signal);
  const endpoint = validateConnectEndpoint(options.endpoint);
  if (options.client && options.clientOptions) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Pass either client or clientOptions to connect(), not both.");
  }

  const identity = await createDiscoveryCacheIdentity({
    endpoint,
    protocol: options.protocol,
    authorizationScopeFingerprint: options.authorizationScopeFingerprint,
    adapterVersion: HONUA_CONNECT_ADAPTER_VERSION,
    projectionVersion: HONUA_CONNECT_PROJECTION_VERSION,
    ...(options.collectionId ? { collectionId: options.collectionId } : {}),
  });
  if (options.client) assertClientEndpoint(options.client, identity.endpoint);
  const cacheContext = Object.freeze({ ...(options.signal ? { signal: options.signal } : {}) });
  let snapshot: ConnectDiscoverySnapshot | undefined;
  let cacheStatus: ConnectCacheStatus = options.cache ? "miss" : "bypass";

  if (options.cache && options.refresh !== true) {
    snapshot = await awaitAbortable(options.cache.get(identity, cacheContext), options.signal);
    throwIfAborted(options.signal);
    if (snapshot) {
      snapshot = validateSnapshot(snapshot, identity, options.collectionId);
      cacheStatus = "hit";
    }
  }

  const client = options.client ?? new HonuaClient({ ...options.clientOptions, baseUrl: identity.endpoint });
  if (!snapshot) {
    snapshot = await discoverOgcFeatures(client, identity, options);
    if (options.cache) {
      await awaitAbortable(options.cache.set(identity, snapshot, cacheContext), options.signal);
      throwIfAborted(options.signal);
    }
    cacheStatus = options.refresh === true ? "refreshed" : cacheStatus;
  }

  const resolution = resolveDiscoveryCapabilities("ogc-features", snapshot.evidence, options.capabilityPolicy);
  const inspections = Object.freeze(
    snapshot.sources.map((source) => {
      const descriptor: SourceDescriptor = {
        id: source.id,
        protocol: "ogc-features",
        locator: {
          url: identity.endpoint,
          collectionId: source.collectionId,
          layout: "ogc-api",
        },
        capabilities: resolution.capabilities,
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
    protocol: "ogc-features",
    ...(defaultSourceId ? { defaultSourceId } : {}),
    sources: inspections,
    diagnostics: Object.freeze([...resolution.diagnostics]),
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

function assertExplicitSupportedProtocol(protocol: ConnectProtocolHint): asserts protocol is "ogc-features" {
  if (protocol === "auto") {
    throw new HonuaDiscoveryError(
      "ambiguous-protocol",
      "connect() requires an explicit protocol hint; automatic authenticated endpoint probing is disabled.",
      { supportedProtocols: ["ogc-features"] },
    );
  }
  if (protocol !== "ogc-features") {
    throw new HonuaDiscoveryError(
      "unsupported-protocol",
      `connect() does not yet include a reviewed discovery adapter for "${String(protocol)}".`,
      { protocol, supportedProtocols: ["ogc-features"] },
    );
  }
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
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "connect() endpoints must not contain credentials, query parameters, or fragments; configure authentication through clientOptions.",
    );
  }
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
    sources: Object.freeze(selected.map(discoveredSourceSnapshot)),
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

function discoveredSourceSnapshot(source: HonuaOgcCollectionSummary): ConnectDiscoverySourceSnapshot {
  return Object.freeze({
    id: source.id,
    collectionId: source.id,
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
  collectionId: string | undefined,
): ConnectDiscoverySnapshot {
  if (
    value?.version !== HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION ||
    value.identityKey !== identity.key ||
    value.endpoint !== identity.endpoint ||
    value.protocol !== "ogc-features" ||
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
  const collectionIds = new Set<string>();
  const sources = value.sources.map((source) => {
    if (!source || typeof source.id !== "string" || typeof source.collectionId !== "string") {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Discovery cache contains an invalid source.");
    }
    if (!source.id || !source.collectionId || sourceIds.has(source.id) || collectionIds.has(source.collectionId)) {
      throw new HonuaDiscoveryError(
        "invalid-discovery-cache",
        "Discovery cache source identifiers must be unique non-empty strings.",
      );
    }
    sourceIds.add(source.id);
    collectionIds.add(source.collectionId);
    return Object.freeze({
      id: source.id,
      collectionId: source.collectionId,
      ...(source.title ? { title: source.title } : {}),
      ...(source.description ? { description: source.description } : {}),
      ...(source.crs ? { crs: Object.freeze([...source.crs]) } : {}),
    });
  });
  if (collectionId && (sources.length !== 1 || sources[0]?.collectionId !== collectionId)) {
    throw new HonuaDiscoveryError(
      "invalid-discovery-cache",
      "Discovery cache snapshot does not match the requested collection.",
      { collectionId },
    );
  }
  return Object.freeze({ ...value, evidence: Object.freeze([...value.evidence]), sources: Object.freeze(sources) });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}
