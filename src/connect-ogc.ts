/** Internal raw OGC API Records metadata projection for connect(). */

import type { ConnectDiscoverySourceSnapshot, ConnectOptions } from "./connect.js";
import type {
  DiscoveryCacheIdentity,
  DiscoveryCapabilityEvidence,
  DiscoveryDiagnostic,
  DiscoveryProvenance,
} from "./contract/discovery.js";
import { type Capability, PROTOCOL_DEFAULT_CAPABILITIES, type SourceLocator } from "./contract/types.js";
import type { HonuaMetadataRequestOptions } from "./core/cache-state.js";
import type { HonuaClient } from "./core/client.js";
import { HonuaAbortError, HonuaDiscoveryError } from "./core/errors.js";
import { negotiateOgcCapabilities } from "./core/ogc-conformance.js";
import { findOgcLink, ogcApiFeaturesLayout } from "./core/ogc-endpoint-layout.js";
import type {
  HonuaOgcCollectionSummary,
  HonuaOgcCollectionsResponse,
  HonuaOgcConformanceResponse,
  HonuaOgcLandingResponse,
  HonuaOgcProcessSummary,
  HonuaOgcProcessesResponse,
  OgcEndpointLayout,
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

// ── Raw OGC API Tiles / Maps (render-only) discovery ────────────

/** OGC API Tiles' render-only adapter surface (`render`, `tiles`). */
const TILES_ADAPTER_SCOPE: readonly Capability[] = Object.freeze([...PROTOCOL_DEFAULT_CAPABILITIES["ogc-tiles"]]);
/** OGC API Maps' render-only adapter surface (`render`). */
const MAPS_ADAPTER_SCOPE: readonly Capability[] = Object.freeze([...PROTOCOL_DEFAULT_CAPABILITIES["ogc-maps"]]);

export interface OgcRenderDiscoveryResult {
  readonly retrievedAt: string;
  readonly evidence: readonly DiscoveryCapabilityEvidence[];
  readonly sources: readonly ConnectDiscoverySourceSnapshot[];
}

/**
 * Discover a raw (third-party) OGC API Tiles service and project every
 * advertised data collection into a reviewed render-only tileset source.
 *
 * Threads the discovered service-root `basePath` through the Tiles wire
 * methods the same way OGC API Records threads its root, so exactly the same
 * reviewed `Source` executes whether the tiles are served by the Honua facade
 * (`/ogc/tiles`) or a third-party root. Performs three bounded metadata
 * requests — landing, conformance, and the OGC API Common collections list —
 * and derives effective capabilities only from advertised conformance
 * intersected against the render-only Tiles adapter surface (`render`,
 * `tiles`); a service that advertises no Tiles conformance discovers a
 * structured `not-advertised` decision rather than an adapter default.
 */
export async function discoverOgcTilesSources(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  clientBaseUrl: string,
  basePath: string,
  options: ConnectOptions,
): Promise<OgcRenderDiscoveryResult> {
  const request = renderMetadataRequest(options);
  const landing = await client.getOgcTilesLanding({ ...request, basePath });
  throwIfAborted(options.signal);
  validateOgcCollectionsLanding(landing, "OGC API Tiles");
  const [conformance, collections] = await Promise.all([
    client.getOgcTilesConformance({ ...request, basePath }),
    client.listOgcCollections({ ...request, layout: ogcCollectionsLayout(basePath) }),
  ]);
  throwIfAborted(options.signal);
  return projectRenderSources(
    "ogc-tiles",
    TILES_ADAPTER_SCOPE,
    identity.endpoint,
    clientBaseUrl,
    basePath,
    landing,
    conformance,
    collections,
    "OGC API Tiles",
  );
}

/**
 * Discover a raw (third-party) OGC API Maps service and project every
 * advertised data collection into a reviewed render-only map-image source.
 * Mirrors {@link discoverOgcTilesSources}: three bounded metadata requests
 * (landing, conformance, collections) via the shared `basePath` seam, with
 * effective capabilities derived only from advertised Maps conformance
 * intersected against the render-only Maps adapter surface (`render`).
 */
export async function discoverOgcMapsSources(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  clientBaseUrl: string,
  basePath: string,
  options: ConnectOptions,
): Promise<OgcRenderDiscoveryResult> {
  const request = renderMetadataRequest(options);
  const landing = await client.getOgcMapsLanding({ ...request, basePath });
  throwIfAborted(options.signal);
  validateOgcCollectionsLanding(landing, "OGC API Maps");
  const [conformance, collections] = await Promise.all([
    client.getOgcMapsConformance({ ...request, basePath }),
    client.listOgcCollections({ ...request, layout: ogcCollectionsLayout(basePath) }),
  ]);
  throwIfAborted(options.signal);
  return projectRenderSources(
    "ogc-maps",
    MAPS_ADAPTER_SCOPE,
    identity.endpoint,
    clientBaseUrl,
    basePath,
    landing,
    conformance,
    collections,
    "OGC API Maps",
  );
}

function renderMetadataRequest(options: ConnectOptions): HonuaMetadataRequestOptions {
  return {
    ...options.metadata,
    ...(options.signal ? { signal: options.signal } : {}),
    refresh: options.refresh === true,
  };
}

/**
 * Build a relative OGC API Common collections layout rooted at the raw
 * `basePath` so the origin-bound client resolves `${basePath}/collections`
 * (the collections resource the render services advertise via the landing
 * `data` link) instead of the `/ogc/features` facade.
 */
function ogcCollectionsLayout(basePath: string): OgcEndpointLayout {
  return ogcApiFeaturesLayout({
    landingUrl: basePath,
    collectionsUrl: `${basePath}/collections`,
    conformanceUrl: `${basePath}/conformance`,
  });
}

function projectRenderSources(
  protocol: "ogc-tiles" | "ogc-maps",
  scope: readonly Capability[],
  root: string,
  clientBaseUrl: string,
  basePath: string,
  landing: HonuaOgcLandingResponse,
  conformance: HonuaOgcConformanceResponse,
  collections: HonuaOgcCollectionsResponse,
  family: string,
): OgcRenderDiscoveryResult {
  const catalogs = selectOgcCollections(collections, family);
  const retrievedAt = new Date().toISOString();
  const provenance = collectionsMetadataProvenance(root, retrievedAt, landing, conformance, collections);
  const advertised = [...negotiateOgcCapabilities(protocol, conformance)].filter((capability) =>
    scope.includes(capability),
  );
  const evidence: readonly DiscoveryCapabilityEvidence[] = Object.freeze([
    Object.freeze({
      kind: "metadata" as const,
      capabilities: Object.freeze(advertised),
      scope,
      provenance,
    }),
  ]);
  const sources = catalogs.map((catalog) => ogcCollectionSourceSnapshot(clientBaseUrl, basePath, catalog));
  return Object.freeze({ retrievedAt, evidence, sources: Object.freeze(sources) });
}

function validateOgcCollectionsLanding(landing: HonuaOgcLandingResponse, family: string): void {
  if (!landing || typeof landing !== "object") {
    throw new HonuaDiscoveryError("invalid-endpoint", `${family} landing metadata is not an object.`);
  }
  if (landing.links !== undefined && !Array.isArray(landing.links)) {
    throw new HonuaDiscoveryError("invalid-endpoint", `${family} landing links must be an array.`);
  }
  // OGC API Common requires a landing page that advertises a data (collections)
  // link; without it the target is not a discoverable render service root.
  if (!findOgcLink(landing.links, "data")) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `${family} discovery requires a landing page advertising a collections data link.`,
    );
  }
}

function selectOgcCollections(
  response: HonuaOgcCollectionsResponse,
  family: string,
): readonly HonuaOgcCollectionSummary[] {
  if (!Array.isArray(response.collections) || response.collections.length === 0) {
    throw new HonuaDiscoveryError("invalid-endpoint", `${family} discovery returned no collections.`);
  }
  const seen = new Set<string>();
  for (const collection of response.collections) {
    if (typeof collection.id !== "string" || collection.id.length === 0 || seen.has(collection.id)) {
      throw new HonuaDiscoveryError("invalid-endpoint", `${family} collection identifiers must be unique strings.`, {
        collectionId: collection.id,
      });
    }
    seen.add(collection.id);
  }
  return response.collections;
}

function ogcCollectionSourceSnapshot(
  clientBaseUrl: string,
  basePath: string,
  collection: HonuaOgcCollectionSummary,
): ConnectDiscoverySourceSnapshot {
  const locator: SourceLocator = Object.freeze({
    url: clientBaseUrl,
    basePath,
    collectionId: collection.id,
  });
  return Object.freeze({
    id: collection.id,
    locator,
    ...(collection.title ? { title: collection.title } : {}),
    ...(collection.description ? { description: collection.description } : {}),
    ...(collection.crs ? { crs: Object.freeze([...collection.crs]) } : {}),
  });
}

function collectionsMetadataProvenance(
  root: string,
  retrievedAt: string,
  landing: HonuaOgcLandingResponse,
  conformance: HonuaOgcConformanceResponse,
  collections: HonuaOgcCollectionsResponse,
): readonly DiscoveryProvenance[] {
  return Object.freeze(
    [
      { source: root, value: landing as CacheCarrier },
      { source: `${root}/conformance`, value: conformance as CacheCarrier },
      { source: `${root}/collections`, value: collections as CacheCarrier },
    ].map(({ source, value }) => {
      const validator = value.cache?.validator?.etag ?? value.cache?.validator?.lastModified;
      return Object.freeze({ source, retrievedAt, ...(validator ? { validator } : {}) });
    }),
  );
}

// ── Raw OGC API Processes (capability/metadata) discovery ───────

/**
 * A discovered OGC API Processes process. Processes is deliberately NOT a
 * Source-backed protocol: a process is an invocable operation, not a queryable
 * dataset, so it never becomes a `connect()` `Source`. `discoverOgcProcesses`
 * surfaces the service's advertised process list and effective `processes`
 * capability as a metadata result instead.
 */
export interface OgcProcessDiscoverySummary {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly version?: string;
}

/** Result of raw OGC API Processes capability/metadata discovery. */
export interface OgcProcessesDiscoveryResult {
  readonly endpoint: string;
  /**
   * Service-root path prefix the endpoint is mounted under (`""` for an
   * origin-rooted service). Pass it to `client.ogcProcesses({ basePath })` so
   * describe / execute / job routes resolve against the discovered root rather
   * than the Honua facade prefix.
   */
  readonly basePath: string;
  readonly retrievedAt: string;
  /**
   * Conformance classes the service advertised, verbatim. Hand the whole
   * discovery result to `client.ogcProcesses({ basePath, conformance })` so
   * execution and dismissal are gated on the server's own declaration.
   */
  readonly conformsTo: readonly string[];
  /** Effective capabilities intersected from advertised conformance (`processes` or empty). */
  readonly capabilities: readonly Capability[];
  readonly processes: readonly OgcProcessDiscoverySummary[];
  readonly evidence: readonly DiscoveryCapabilityEvidence[];
  readonly provenance: readonly DiscoveryProvenance[];
  readonly diagnostics: readonly DiscoveryDiagnostic[];
}

/** OGC API Processes capability surface (`processes`). */
const PROCESSES_ADAPTER_SCOPE: readonly Capability[] = Object.freeze(["processes"]);

/**
 * Discover a raw (third-party) OGC API Processes service as a
 * capability/metadata result — never a `Source`. Performs three bounded
 * metadata requests (landing, conformance, process list) through the
 * `basePath` seam and reports the advertised process list plus the effective
 * `processes` capability intersected from conformance. A service that
 * advertises no Processes conformance reports an empty capability set with a
 * structured `discovery-unavailable` diagnostic rather than inventing support.
 */
export async function discoverOgcProcessesMetadata(
  client: HonuaClient,
  endpoint: string,
  basePath: string,
  options: {
    readonly signal?: AbortSignal;
    readonly refresh?: boolean;
    readonly metadata?: Omit<HonuaMetadataRequestOptions, "signal" | "refresh">;
  },
): Promise<OgcProcessesDiscoveryResult> {
  const request: HonuaMetadataRequestOptions = {
    ...options.metadata,
    ...(options.signal ? { signal: options.signal } : {}),
    refresh: options.refresh === true,
  };
  const landing = await client.getOgcProcessesLanding({ ...request, basePath });
  throwIfAborted(options.signal);
  validateProcessesLanding(landing);
  const [conformance, processes] = await Promise.all([
    client.getOgcProcessesConformance({ ...request, basePath }),
    client.listOgcProcesses({ ...request, basePath }),
  ]);
  throwIfAborted(options.signal);

  const summaries = selectProcesses(processes);
  const retrievedAt = new Date().toISOString();
  const provenance: readonly DiscoveryProvenance[] = Object.freeze(
    [
      { source: endpoint, value: landing as CacheCarrier },
      { source: `${endpoint}/conformance`, value: conformance as CacheCarrier },
      { source: `${endpoint}/processes`, value: processes as CacheCarrier },
    ].map(({ source, value }) => {
      const validator = value.cache?.validator?.etag ?? value.cache?.validator?.lastModified;
      return Object.freeze({ source, retrievedAt, ...(validator ? { validator } : {}) });
    }),
  );
  const capabilities = [...negotiateOgcCapabilities("ogc-processes", conformance)].filter((capability) =>
    PROCESSES_ADAPTER_SCOPE.includes(capability),
  );
  const evidence: readonly DiscoveryCapabilityEvidence[] = Object.freeze([
    Object.freeze({
      kind: "metadata" as const,
      capabilities: Object.freeze([...capabilities]),
      scope: PROCESSES_ADAPTER_SCOPE,
      provenance,
    }),
  ]);
  const diagnostics: readonly DiscoveryDiagnostic[] =
    capabilities.length === 0
      ? Object.freeze([
          Object.freeze({
            code: "discovery-unavailable" as const,
            severity: "warning" as const,
            message:
              "OGC API Processes core conformance was not advertised; the processes capability could not be confirmed from metadata.",
            capabilities: PROCESSES_ADAPTER_SCOPE,
          }),
        ])
      : Object.freeze([]);
  return Object.freeze({
    endpoint,
    basePath,
    retrievedAt,
    conformsTo: Object.freeze(
      Array.isArray(conformance?.conformsTo) ? conformance.conformsTo.filter((uri) => typeof uri === "string") : [],
    ),
    capabilities: Object.freeze([...capabilities]),
    processes: Object.freeze(summaries),
    evidence,
    provenance,
    diagnostics,
  });
}

function validateProcessesLanding(landing: HonuaOgcLandingResponse): void {
  if (!landing || typeof landing !== "object") {
    throw new HonuaDiscoveryError("invalid-endpoint", "OGC API Processes landing metadata is not an object.");
  }
  if (landing.links !== undefined && !Array.isArray(landing.links)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "OGC API Processes landing links must be an array.");
  }
  // OGC API Processes Requirement 1 mandates a landing page that advertises a
  // `processes` link; without it the target is not a discoverable Processes
  // service root.
  if (!findOgcLink(landing.links, "processes")) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "OGC API Processes discovery requires a landing page advertising a processes link.",
    );
  }
}

function selectProcesses(response: HonuaOgcProcessesResponse): readonly OgcProcessDiscoverySummary[] {
  // A conformant Processes deployment may advertise an empty catalog
  // (`{ processes: [] }`); that is a valid discovery result — return the empty
  // list and let capabilities/diagnostics stand. Only a missing / non-array
  // `processes` member (or a malformed entry, below) is an invalid endpoint.
  if (!Array.isArray(response.processes)) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "OGC API Processes discovery response is missing a processes list.",
    );
  }
  const seen = new Set<string>();
  return Object.freeze(
    response.processes.map((process: HonuaOgcProcessSummary) => {
      if (typeof process.id !== "string" || process.id.length === 0 || seen.has(process.id)) {
        throw new HonuaDiscoveryError("invalid-endpoint", "OGC API Processes identifiers must be unique strings.", {
          processId: process.id,
        });
      }
      seen.add(process.id);
      return Object.freeze({
        id: process.id,
        ...(process.title ? { title: process.title } : {}),
        ...(process.description ? { description: process.description } : {}),
        ...(process.version ? { version: process.version } : {}),
      });
    }),
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}
