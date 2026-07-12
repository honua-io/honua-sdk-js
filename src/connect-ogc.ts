/** Internal raw OGC API Records metadata projection for connect(). */

import type { ConnectDiscoverySourceSnapshot, ConnectOptions } from "./connect.js";
import type { DiscoveryCacheIdentity, DiscoveryCapabilityEvidence, DiscoveryProvenance } from "./contract/discovery.js";
import { type Capability, PROTOCOL_DEFAULT_CAPABILITIES, type SourceLocator } from "./contract/types.js";
import type { HonuaMetadataRequestOptions } from "./core/cache-state.js";
import type { HonuaClient } from "./core/client.js";
import { HonuaAbortError, HonuaDiscoveryError } from "./core/errors.js";
import { negotiateOgcCapabilities } from "./core/ogc-conformance.js";
import { findOgcLink } from "./core/ogc-endpoint-layout.js";
import type {
  HonuaOgcCollectionSummary,
  HonuaOgcCollectionsResponse,
  HonuaOgcConformanceResponse,
  HonuaOgcLandingResponse,
} from "./core/types.js";

/**
 * OGC API Records' canonical adapter surface. Discovery evidence is scoped to
 * this set so `resolveDiscoveryCapabilities` intersects advertised conformance
 * against the exact operations the OGC Records `Source` adapter can implement.
 */
const RECORDS_ADAPTER_SCOPE: readonly Capability[] = Object.freeze([...PROTOCOL_DEFAULT_CAPABILITIES["ogc-records"]]);

export interface OgcRecordsDiscoveryResult {
  readonly retrievedAt: string;
  readonly evidence: readonly DiscoveryCapabilityEvidence[];
  readonly sources: readonly ConnectDiscoverySourceSnapshot[];
}

/**
 * Discover a raw (third-party) OGC API Records catalog service.
 *
 * Threads the discovered service-root `basePath` through the Records wire
 * methods the way OGC API Features threads its endpoint layout, so exactly the
 * same reviewed `Source` executes whether the catalog is served by the Honua
 * facade (`/ogc/records`) or a third-party root. Performs three metadata
 * requests — landing, conformance, and the catalog list — and projects every
 * advertised catalog collection into a reviewed source snapshot. Effective
 * capabilities come only from the advertised conformance classes intersected
 * against the adapter surface; a service that advertises no Records query
 * conformance discovers a structured `not-advertised` decision rather than an
 * adapter default.
 */
export async function discoverOgcRecordsSources(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  clientBaseUrl: string,
  basePath: string,
  options: ConnectOptions,
): Promise<OgcRecordsDiscoveryResult> {
  const request: HonuaMetadataRequestOptions = {
    ...options.metadata,
    ...(options.signal ? { signal: options.signal } : {}),
    refresh: options.refresh === true,
  };

  const landing = await client.getOgcRecordsLanding({ ...request, basePath });
  throwIfAborted(options.signal);
  validateRecordsLanding(landing);
  const [conformance, collections] = await Promise.all([
    client.getOgcRecordsConformance({ ...request, basePath }),
    client.listOgcRecordCollections({ ...request, basePath }),
  ]);
  throwIfAborted(options.signal);

  const catalogs = selectRecordCatalogs(collections);
  const retrievedAt = new Date().toISOString();
  const root = `${identity.endpoint}`;
  const provenance: readonly DiscoveryProvenance[] = Object.freeze(
    [
      { source: root, value: landing as CacheCarrier },
      { source: `${root}/conformance`, value: conformance as CacheCarrier },
      { source: `${root}/collections`, value: collections as CacheCarrier },
    ].map(({ source, value }) => {
      const validator = value.cache?.validator?.etag ?? value.cache?.validator?.lastModified;
      return Object.freeze({ source, retrievedAt, ...(validator ? { validator } : {}) });
    }),
  );

  const advertised = [...negotiateOgcCapabilities("ogc-records", conformance)].filter((capability) =>
    RECORDS_ADAPTER_SCOPE.includes(capability),
  );
  const evidence: readonly DiscoveryCapabilityEvidence[] = Object.freeze([
    Object.freeze({
      kind: "metadata" as const,
      capabilities: Object.freeze(advertised),
      scope: RECORDS_ADAPTER_SCOPE,
      provenance,
    }),
  ]);

  const sources = catalogs.map((catalog) => recordsSourceSnapshot(clientBaseUrl, basePath, catalog));
  return Object.freeze({ retrievedAt, evidence, sources: Object.freeze(sources) });
}

interface CacheCarrier {
  readonly cache?: { readonly validator?: { readonly etag?: string; readonly lastModified?: string } };
}

function validateRecordsLanding(landing: HonuaOgcLandingResponse): void {
  if (!landing || typeof landing !== "object") {
    throw new HonuaDiscoveryError("invalid-endpoint", "OGC API Records landing metadata is not an object.");
  }
  if (landing.links !== undefined && !Array.isArray(landing.links)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "OGC API Records landing links must be an array.");
  }
  // OGC API Common requires a landing page that advertises a data (collections)
  // link; without it the target is not a discoverable Records service root.
  if (!findOgcLink(landing.links, "data")) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "OGC API Records discovery requires a landing page advertising a collections data link.",
    );
  }
}

function selectRecordCatalogs(response: HonuaOgcCollectionsResponse): readonly HonuaOgcCollectionSummary[] {
  if (!Array.isArray(response.collections) || response.collections.length === 0) {
    throw new HonuaDiscoveryError("invalid-endpoint", "OGC API Records discovery returned no catalog collections.");
  }
  const seen = new Set<string>();
  for (const collection of response.collections) {
    if (typeof collection.id !== "string" || collection.id.length === 0 || seen.has(collection.id)) {
      throw new HonuaDiscoveryError("invalid-endpoint", "OGC API Records catalog identifiers must be unique strings.", {
        collectionId: collection.id,
      });
    }
    seen.add(collection.id);
  }
  return response.collections;
}

function recordsSourceSnapshot(
  clientBaseUrl: string,
  basePath: string,
  catalog: HonuaOgcCollectionSummary,
): ConnectDiscoverySourceSnapshot {
  const locator: SourceLocator = Object.freeze({
    url: clientBaseUrl,
    basePath,
    collectionId: catalog.id,
  });
  return Object.freeze({
    id: catalog.id,
    locator,
    ...(catalog.title ? { title: catalog.title } : {}),
    ...(catalog.description ? { description: catalog.description } : {}),
    ...(catalog.crs ? { crs: Object.freeze([...catalog.crs]) } : {}),
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}
