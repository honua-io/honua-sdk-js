import type { PmtilesDiscoveryMetadata } from "../connect-pmtiles.js";
import type { ConnectCacheStatus, ConnectOptions } from "../connect.js";
import { connect } from "../connect.js";
import type { PmtilesRendererSourceDescriptor } from "./lifecycle.js";
import { HonuaPmtilesLifecycleError, registerPmtilesSource } from "./lifecycle.js";

export interface InspectPmtilesArchiveOptions {
  readonly endpoint: string | URL;
  readonly authorizationScopeFingerprint: string;
  readonly client?: ConnectOptions["client"];
  readonly clientOptions?: ConnectOptions["clientOptions"];
  readonly cache?: ConnectOptions["cache"];
  readonly signal?: AbortSignal;
  readonly limits?: NonNullable<ConnectOptions["pmtiles"]>["limits"];
}

export interface PmtilesArchiveInspection {
  readonly endpoint: string;
  readonly retrievedAt: string;
  readonly cacheStatus: ConnectCacheStatus;
  readonly metadata: PmtilesDiscoveryMetadata;
  readonly rendererSource?: PmtilesRendererSourceDescriptor;
}

/** Inspect one direct PMTiles archive through the authenticated, bounded connect pipeline. */
export async function inspectPmtilesArchive(options: InspectPmtilesArchiveOptions): Promise<PmtilesArchiveInspection> {
  const connection = await connect({
    endpoint: options.endpoint,
    protocol: "pmtiles",
    authorizationScopeFingerprint: options.authorizationScopeFingerprint,
    ...(options.client ? { client: options.client } : {}),
    ...(options.clientOptions ? { clientOptions: options.clientOptions } : {}),
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.limits ? { pmtiles: { limits: options.limits } } : {}),
  });
  const sourceInspection = connection.inspection.sources[0];
  const metadata = sourceInspection?.metadata?.pmtiles;
  if (!metadata) {
    throw new HonuaPmtilesLifecycleError(
      "invalid-response",
      "PMTiles inspection completed without reviewed archive metadata.",
    );
  }
  const endpoint = connection.inspection.endpoint;
  const rendererSource =
    metadata.tileKind === "unknown"
      ? undefined
      : registerPmtilesSource({
          honuaBaseUrl: new URL(endpoint).origin,
          directArchiveUrl: endpoint,
          directTileKind: metadata.tileKind,
          directBounds: metadata.bounds,
          directMinZoom: metadata.minZoom,
          directMaxZoom: metadata.maxZoom,
          ...(metadata.validator ? { directCacheValidator: metadata.validator } : {}),
        });
  return Object.freeze({
    endpoint,
    retrievedAt: sourceInspection?.provenance[0]?.retrievedAt ?? new Date().toISOString(),
    cacheStatus: connection.inspection.cacheStatus,
    metadata,
    ...(rendererSource ? { rendererSource } : {}),
  });
}
