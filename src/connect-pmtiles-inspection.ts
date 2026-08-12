/** Focused PMTiles discovery orchestration for the /pmtiles entrypoint. */
import { snapshotCacheData } from "./connect-cache-data.js";
import {
  HONUA_CONNECT_ADAPTER_VERSION,
  HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
  HONUA_CONNECT_PROJECTION_VERSION,
} from "./connect-constants.js";
import { assertClientEndpoint, awaitAbortable, validateConnectEndpoint } from "./connect-endpoint.js";
import { resolveConnectTarget } from "./connect-geoservices.js";
import { validateCachedPmtilesSnapshot } from "./connect-pmtiles-cache-validation.js";
import {
  type PmtilesDiscoveryLimits,
  discoverPmtilesSources,
  normalizePmtilesDiscoveryLimits,
  pmtilesDiscoveryPolicyIdentity,
} from "./connect-pmtiles.js";
import type {
  ConnectCacheStatus,
  ConnectDiscoverySnapshot,
  ConnectOptions,
  ConnectSourceSchemaProjection,
} from "./connect.js";
import type { DiscoveryCacheIdentity } from "./contract/discovery.js";
import { createDiscoveryCacheIdentity } from "./contract/discovery.js";
import { HonuaClient } from "./core/client.js";
import { HonuaAbortError, HonuaDiscoveryError } from "./core/errors.js";

export interface FocusedPmtilesDiscoveryContext {
  readonly limits?: PmtilesDiscoveryLimits;
  readonly projectionIdentity?: string;
  readonly sourceSchemaProjection?: ConnectSourceSchemaProjection;
}

export interface FocusedPmtilesDiscoveryResult {
  readonly client: HonuaClient;
  readonly identity: DiscoveryCacheIdentity;
  readonly snapshot: ConnectDiscoverySnapshot;
  readonly cacheStatus: ConnectCacheStatus;
  readonly limits: PmtilesDiscoveryLimits;
}

/** Resolve one PMTiles archive without retaining the all-protocol connect dispatcher. */
export async function inspectPmtilesDiscovery(
  options: ConnectOptions,
  context: FocusedPmtilesDiscoveryContext = {},
): Promise<FocusedPmtilesDiscoveryResult> {
  throwIfAborted(options.signal);
  if (options.client && options.clientOptions) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Pass either client or clientOptions to connect(), not both.");
  }
  const endpoint = validateConnectEndpoint(options.endpoint, "pmtiles");
  const target = resolveConnectTarget(endpoint, "pmtiles");
  const limits = context.limits ?? normalizePmtilesDiscoveryLimits(options.pmtiles?.limits);
  const projectionIdentity = context.projectionIdentity ?? "";
  const identity = await createDiscoveryCacheIdentity({
    endpoint: target.endpoint,
    protocol: "pmtiles",
    authorizationScopeFingerprint: options.authorizationScopeFingerprint,
    adapterVersion: projectionIdentity
      ? `${HONUA_CONNECT_ADAPTER_VERSION}:${projectionIdentity}`
      : HONUA_CONNECT_ADAPTER_VERSION,
    projectionVersion: projectionIdentity
      ? `${HONUA_CONNECT_PROJECTION_VERSION}:${projectionIdentity}`
      : HONUA_CONNECT_PROJECTION_VERSION,
    profile: pmtilesDiscoveryPolicyIdentity(limits),
  });
  if (options.client) assertClientEndpoint(options.client, target.clientBaseUrl);
  const cacheContext = Object.freeze({ ...(options.signal ? { signal: options.signal } : {}) });
  let snapshot: ConnectDiscoverySnapshot | undefined;
  let cacheStatus: ConnectCacheStatus = options.cache ? "miss" : "bypass";

  if (options.cache && options.refresh !== true) {
    snapshot = await awaitAbortable(options.cache.get(identity, cacheContext), options.signal);
    throwIfAborted(options.signal);
    if (snapshot) {
      snapshot = validateCachedPmtilesSnapshot(snapshot, identity, limits, context.sourceSchemaProjection);
      cacheStatus = "hit";
    }
  }

  const client = options.client ?? new HonuaClient({ ...options.clientOptions, baseUrl: target.clientBaseUrl });
  if (!snapshot) {
    const discovered = await awaitAbortable(
      discoverPmtilesSources(client, identity, options, limits, context.sourceSchemaProjection),
      options.signal,
    );
    snapshot = Object.freeze({
      version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
      identityKey: identity.key,
      endpoint: identity.endpoint,
      protocol: "pmtiles" as const,
      retrievedAt: discovered.retrievedAt,
      evidence: discovered.evidence,
      sources: discovered.sources,
    });
    if (
      options.cache &&
      (!context.sourceSchemaProjection ||
        snapshot.sources.every((source) => source.schemaV2 !== undefined || source.schemaV2State !== undefined))
    ) {
      snapshot = snapshotCacheData(snapshot);
      await awaitAbortable(options.cache.set(identity, snapshot, cacheContext), options.signal);
      throwIfAborted(options.signal);
    }
    cacheStatus = options.refresh === true ? "refreshed" : cacheStatus;
  }

  return Object.freeze({ client, identity, snapshot, cacheStatus, limits });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}
