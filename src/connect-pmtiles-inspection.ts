/** Focused PMTiles discovery orchestration shared by connect() and /pmtiles. */

import {
  MAX_CACHE_SNAPSHOT_SINGLE_STRING_CODE_UNITS,
  snapshotCacheData,
  validateCachedEvidence,
} from "./connect-cache-data.js";
import {
  HONUA_CONNECT_ADAPTER_VERSION,
  HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
  HONUA_CONNECT_PROJECTION_VERSION,
} from "./connect-constants.js";
import { assertClientEndpoint, awaitAbortable, validateConnectEndpoint } from "./connect-endpoint.js";
import { resolveConnectTarget } from "./connect-geoservices.js";
import {
  PMTILES_RETAINED_METADATA_JSON_BYTES,
  PMTILES_RETAINED_VECTOR_LAYER_ENTRIES,
  PMTILES_RETAINED_VECTOR_LAYER_NODES,
  PMTILES_UNKNOWN_TILE_KIND_REASON,
  PMTILES_VALIDATOR_CODE_UNITS,
  type PmtilesDiscoveryLimits,
  type PmtilesDiscoveryMetadata,
  discoverPmtilesSources,
  normalizePmtilesDiscoveryLimits,
  parsePmtilesValidatorIdentity,
  pmtilesDiscoveryPolicyIdentity,
  pmtilesRangesCoverWholeArchive,
  pmtilesVectorLayerStructuralNodes,
} from "./connect-pmtiles.js";
import type {
  ConnectCacheStatus,
  ConnectDiscoveryExtent,
  ConnectDiscoverySnapshot,
  ConnectDiscoverySourceSnapshot,
  ConnectOptions,
  ConnectSourceSchemaProjection,
} from "./connect.js";
import type {
  DiscoveryCacheIdentity,
  DiscoveryCapabilityEvidence,
  DiscoverySourceMetadata,
} from "./contract/discovery.js";
import { createDiscoveryCacheIdentity, resolveDiscoveryCapabilities } from "./contract/discovery.js";
import type { PmtilesVectorLayerInfo } from "./contract/pmtiles.js";
import type { SchemaIdentity } from "./contract/schema.js";
import { parseSchemaIdentity } from "./contract/schema.js";
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

function validateCachedPmtilesSnapshot(
  value: ConnectDiscoverySnapshot,
  identity: DiscoveryCacheIdentity,
  limits: PmtilesDiscoveryLimits,
  sourceSchemaProjection: ConnectSourceSchemaProjection | undefined,
): ConnectDiscoverySnapshot {
  const owned = snapshotCacheData(value);
  if (
    owned.version !== HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION ||
    owned.identityKey !== identity.key ||
    owned.endpoint !== identity.endpoint ||
    owned.protocol !== "pmtiles" ||
    typeof owned.retrievedAt !== "string" ||
    !owned.retrievedAt ||
    !Array.isArray(owned.evidence) ||
    !Array.isArray(owned.sources) ||
    owned.sources.length !== 1
  ) {
    throw new HonuaDiscoveryError("invalid-discovery-cache", "Discovery cache returned an incompatible snapshot.", {
      expectedVersion: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
      expectedIdentityKey: identity.key,
    });
  }
  assertCachedKeys(
    owned as unknown as Record<string, unknown>,
    ["version", "identityKey", "endpoint", "protocol", "retrievedAt", "evidence", "sources"],
    "PMTiles discovery snapshot",
  );
  const retrievedTimestamp = Date.parse(owned.retrievedAt);
  if (!Number.isFinite(retrievedTimestamp) || new Date(retrievedTimestamp).toISOString() !== owned.retrievedAt) {
    cacheMetadataError("Cached PMTiles retrieval time must be a canonical ISO-8601 timestamp.");
  }
  const sharedEvidence = validateCachedEvidence("pmtiles", owned.evidence, true);
  const source = validateCachedPmtilesSource(
    owned.sources[0]!,
    identity.endpoint,
    owned.retrievedAt,
    owned.evidence,
    limits,
    sourceSchemaProjection,
  );
  return Object.freeze({ ...owned, evidence: sharedEvidence, sources: Object.freeze([source]) });
}

function validateCachedPmtilesSource(
  source: ConnectDiscoverySourceSnapshot,
  endpoint: string,
  retrievedAt: string,
  rawSharedEvidence: readonly DiscoveryCapabilityEvidence[],
  limits: PmtilesDiscoveryLimits,
  sourceSchemaProjection: ConnectSourceSchemaProjection | undefined,
): ConnectDiscoverySourceSnapshot {
  if (!source || typeof source.id !== "string" || !source.id || !isPlainObject(source.locator)) {
    cacheMetadataError("Discovery cache contains an invalid source.");
  }
  assertCachedKeys(
    source as unknown as Record<string, unknown>,
    [
      "id",
      "locator",
      "title",
      "description",
      "crs",
      "extent",
      "schema",
      "schemaV2",
      "schemaV2State",
      "metadata",
      "evidence",
    ],
    "PMTiles source",
  );
  assertCachedKeys(
    source.locator as unknown as Record<string, unknown>,
    ["url", "sourceType"],
    "PMTiles source locator",
  );
  if (
    source.locator.url !== endpoint ||
    source.id !== "pmtiles" ||
    (source.locator.sourceType !== undefined &&
      source.locator.sourceType !== "vector" &&
      source.locator.sourceType !== "raster")
  ) {
    cacheMetadataError("Cached PMTiles source locator does not match the asset endpoint.");
  }
  let schemaV2State: SchemaIdentity | undefined;
  if (source.schemaV2State !== undefined) {
    try {
      schemaV2State = parseSchemaIdentity(source.schemaV2State);
    } catch (cause) {
      throw new HonuaDiscoveryError("invalid-discovery-cache", "Cached source schemaV2State is invalid.", undefined, {
        cause,
      });
    }
  }
  if (source.schemaV2 !== undefined) {
    cacheMetadataError("Cached PMTiles source contains a projection that direct archive discovery never emits.");
  }
  if (sourceSchemaProjection && schemaV2State?.state !== "unavailable") {
    cacheMetadataError("Focused discovery cache source is missing its unavailable schemaV2 state.");
  }
  if (source.evidence === undefined || !Array.isArray(source.evidence) || source.evidence.length === 0) {
    cacheMetadataError("Cached PMTiles source must retain its source-bound capability evidence.");
  }
  const sourceEvidence = validateCachedEvidence("pmtiles", source.evidence, false);
  const metadata = validateCachedPmtilesSourceMetadata(source.metadata, limits);
  const pmtiles = metadata.pmtiles!;
  const sourceExtent = validateCachedPmtilesExtent(source.extent, pmtiles.bounds, "source");
  const expectedSourceType =
    pmtiles.tileKind === "mvt" ? "vector" : pmtiles.tileKind === "unknown" ? undefined : "raster";
  if (source.locator.sourceType !== expectedSourceType) {
    cacheMetadataError("Cached PMTiles source type contradicts its archive tile kind.");
  }
  const tiles = resolveDiscoveryCapabilities("pmtiles", sourceEvidence).capabilities.has("tiles");
  if (tiles !== (pmtiles.tileKind !== "unknown")) {
    cacheMetadataError("Cached PMTiles tile capability contradicts its archive tile kind.");
  }
  if (source.title !== pmtiles.attribution) {
    cacheMetadataError("Cached PMTiles source attribution contradicts its raw archive metadata.");
  }
  if (source.description !== undefined || source.crs !== undefined || source.schema !== undefined) {
    cacheMetadataError("Cached PMTiles source contains a projection that direct archive discovery never emits.");
  }
  const validator = pmtiles.validator;
  const supported = pmtiles.tileKind !== "unknown";
  validateCachedPmtilesEvidence(rawSharedEvidence, endpoint, retrievedAt, validator, supported);
  validateCachedPmtilesEvidence(source.evidence, endpoint, retrievedAt, validator, supported);
  return Object.freeze({
    id: source.id,
    locator: Object.freeze({ url: endpoint, ...(expectedSourceType ? { sourceType: expectedSourceType } : {}) }),
    ...(source.title ? { title: source.title } : {}),
    extent: sourceExtent,
    metadata,
    ...(schemaV2State ? { schemaV2State } : {}),
    evidence: sourceEvidence,
  });
}

function validateCachedPmtilesSourceMetadata(
  value: DiscoverySourceMetadata | undefined,
  limits: PmtilesDiscoveryLimits,
): DiscoverySourceMetadata & { readonly pmtiles: PmtilesDiscoveryMetadata } {
  if (!isPlainObject(value)) cacheMetadataError("Cached PMTiles source lacks bounded archive metadata.");
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
  if (
    value.crs !== undefined ||
    value.protocolVersion !== undefined ||
    value.formats !== undefined ||
    value.styles !== undefined ||
    value.dimensions !== undefined ||
    value.operations !== undefined ||
    value.axisOrders !== undefined ||
    value.tileMatrixSets !== undefined
  ) {
    cacheMetadataError("Cached PMTiles metadata contains a projection that direct archive discovery never emits.");
  }
  const pmtiles = validateCachedPmtilesMetadata(value.pmtiles, limits);
  const extent = validateCachedPmtilesExtent(value.extent, pmtiles.bounds, "metadata");
  let partialReasons: readonly string[] | undefined;
  if (value.partialReasons !== undefined) {
    const reasons = checkedArray(value.partialReasons, "Cached source metadata partialReasons", 512);
    if (reasons.some((entry) => typeof entry !== "string" || !entry)) {
      cacheMetadataError("Cached source metadata partialReasons must contain strings.");
    }
    partialReasons = Object.freeze([...reasons] as string[]);
  }
  const partialReasonsMatch =
    pmtiles.tileKind === "unknown"
      ? partialReasons?.length === 1 && partialReasons[0] === PMTILES_UNKNOWN_TILE_KIND_REASON
      : partialReasons === undefined;
  if (!partialReasonsMatch) {
    cacheMetadataError("Cached PMTiles partial-discovery reasons contradict its archive tile kind.");
  }
  return Object.freeze({ extent, pmtiles, ...(partialReasons ? { partialReasons } : {}) });
}

function validateCachedPmtilesExtent(
  value: unknown,
  bounds: readonly [number, number, number, number],
  label: string,
): ConnectDiscoveryExtent {
  if (!isPlainObject(value)) cacheMetadataError(`Cached PMTiles ${label} extent must be an object.`);
  assertCachedKeys(value, ["spatial", "temporal"], `PMTiles ${label} extent`);
  if (!isPlainObject(value.spatial)) cacheMetadataError(`Cached PMTiles ${label} spatial extent must be an object.`);
  assertCachedKeys(value.spatial, ["bbox", "crs"], `PMTiles ${label} spatial extent`);
  const bbox = value.spatial.bbox;
  if (
    value.temporal !== undefined ||
    value.spatial.crs !== "OGC:CRS84" ||
    !Array.isArray(bbox) ||
    bbox.length !== 1 ||
    !Array.isArray(bbox[0]) ||
    bbox[0].length !== 4 ||
    bbox[0].some((entry, index) => entry !== bounds[index])
  ) {
    cacheMetadataError(`Cached PMTiles ${label} extent contradicts its reviewed OGC:CRS84 archive bounds.`);
  }
  return Object.freeze({
    spatial: Object.freeze({ bbox: Object.freeze([Object.freeze([...bounds])]), crs: "OGC:CRS84" }),
  });
}

function validateCachedPmtilesMetadata(value: unknown, limits: PmtilesDiscoveryLimits): PmtilesDiscoveryMetadata {
  if (!isPlainObject(value)) cacheMetadataError("Cached PMTiles metadata must be an object.");
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
  if (!tileKinds.includes(value.tileKind as (typeof tileKinds)[number]))
    cacheMetadataError("Cached PMTiles tileKind is invalid.");
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
          if (!isPlainObject(layer.fields) || Object.keys(layer.fields).length > 4096)
            cacheMetadataError("Cached PMTiles vector layer fields must be a bounded object.");
          fields = Object.freeze(
            Object.fromEntries(
              Object.entries(layer.fields).map(([name, type]) => {
                if (typeof type !== "string" || !type || type.length > 1024 || !name || name.length > 1024)
                  cacheMetadataError("Cached PMTiles vector layer field is invalid.");
                return [name, type];
              }),
            ),
          );
        }
        const layerMinZoom =
          layer.minZoom !== undefined ? cachedZoom(layer.minZoom, "vector layer minZoom") : undefined;
        const layerMaxZoom =
          layer.maxZoom !== undefined ? cachedZoom(layer.maxZoom, "vector layer maxZoom") : undefined;
        if (layerMinZoom !== undefined && layerMaxZoom !== undefined && layerMinZoom > layerMaxZoom)
          cacheMetadataError("Cached PMTiles vector layer minZoom exceeds maxZoom.");
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
  if (pmtilesVectorLayerStructuralNodes(vectorLayers) > PMTILES_RETAINED_VECTOR_LAYER_NODES)
    cacheMetadataError("Cached PMTiles normalized vector-layer metadata exceeds its retained-structure ceiling.");
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
  if (bytesFetched > limits.maxTotalBytes)
    cacheMetadataError("Cached PMTiles transfer exceeds its total-byte policy ceiling.");
  const decompressedBytes = nonNegativeCachedInteger(value.transfer.decompressedBytes, "PMTiles decompressedBytes");
  if (decompressedBytes > limits.maxDecompressedBytes)
    cacheMetadataError("Cached PMTiles transfer exceeds its decompression-policy ceiling.");
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
      )
        cacheMetadataError("Cached PMTiles range evidence is invalid.");
      const offset = range.offset as number;
      const length = range.length as number;
      if (!Number.isSafeInteger(offset + length - 1))
        cacheMetadataError("Cached PMTiles range offset and length overflow.");
      const parsed = cachedPmtilesContentRange(range.contentRange);
      if (
        parsed.start !== offset ||
        parsed.end !== offset + length - 1 ||
        parsed.total <= parsed.end ||
        (parsed.start === 0 && parsed.end + 1 === parsed.total)
      )
        cacheMetadataError("Cached PMTiles Content-Range does not bind to its partial range ledger.");
      if (index === 0 && (offset !== 0 || length !== 16_384))
        cacheMetadataError("Cached PMTiles evidence must begin with the exact 0-16383 header range.");
      if (priorPhysicalRanges.some((prior) => prior.offset <= offset && prior.offset + prior.length >= offset + length))
        cacheMetadataError("Cached PMTiles range evidence includes an impossible fully covered physical request.");
      priorPhysicalRanges.push({ offset, length });
      if (archiveLength !== undefined && archiveLength !== parsed.total)
        cacheMetadataError("Cached PMTiles ranges disagree on archive length.");
      archiveLength = parsed.total;
      const validator =
        range.validator !== undefined ? cachedPmtilesValidator(range.validator, "range validator") : undefined;
      if (rangeValidatorObserved && validator !== rangeValidator)
        cacheMetadataError("Cached PMTiles ranges disagree on archive validator.");
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
  if (ranges.length !== requests || ranges.reduce((sum, range) => sum + range.bytesReceived, 0) !== bytesFetched)
    cacheMetadataError("Cached PMTiles transfer totals do not match its range ledger.");
  if (archiveLength !== undefined && pmtilesRangesCoverWholeArchive(ranges, archiveLength))
    cacheMetadataError("Cached PMTiles transfer evidence collectively materializes the complete archive.");
  if (ranges.length > 1 && rangeValidator === undefined)
    cacheMetadataError(
      "Cached multi-range PMTiles evidence requires a strong ETag or canonical Last-Modified validator.",
    );
  const validator = value.validator !== undefined ? cachedPmtilesValidator(value.validator, "validator") : undefined;
  if (validator !== rangeValidator)
    cacheMetadataError("Cached PMTiles archive validator disagrees with its range ledger.");
  return Object.freeze({
    specVersion: 3,
    tileKind: value.tileKind as PmtilesDiscoveryMetadata["tileKind"],
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
  )
    cacheMetadataError("Cached PMTiles raw metadata must be bounded JSON text.");
  let parsed: unknown;
  let canonical: string | undefined;
  try {
    parsed = JSON.parse(value);
    canonical = JSON.stringify(parsed);
  } catch {
    cacheMetadataError("Cached PMTiles raw metadata is not valid JSON.");
  }
  if (!isPlainObject(parsed) || canonical !== value)
    cacheMetadataError("Cached PMTiles raw metadata must be a canonical JSON object.");
  return Object.freeze({ json: value, parsed });
}

function validateCachedPmtilesMetadataBinding(
  metadata: Readonly<Record<string, unknown>>,
  attribution: string | undefined,
  vectorLayers: readonly PmtilesVectorLayerInfo[],
): void {
  const rawAttribution =
    typeof metadata.attribution === "string" && metadata.attribution.length > 0 ? metadata.attribution : undefined;
  if (rawAttribution !== attribution)
    cacheMetadataError("Cached PMTiles raw attribution contradicts its normalized metadata.");
  const rawLayers = Array.isArray(metadata.vector_layers) ? metadata.vector_layers : [];
  if (rawLayers.length > PMTILES_RETAINED_VECTOR_LAYER_ENTRIES)
    cacheMetadataError("Cached PMTiles raw metadata contains too many vector layers.");
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
    if (typeof entry.description === "string" && entry.description.length > 0) layer.description = entry.description;
    if (typeof entry.minzoom === "number") layer.minZoom = entry.minzoom;
    if (typeof entry.maxzoom === "number") layer.maxZoom = entry.maxzoom;
    if (entry.fields !== undefined && typeof entry.fields === "object" && entry.fields !== null) {
      const fields = Object.entries(entry.fields);
      if (fields.some(([, type]) => typeof type !== "string"))
        cacheMetadataError("Cached PMTiles raw vector-layer fields contradict normalized metadata.");
      layer.fields = Object.fromEntries(fields) as Record<string, string>;
    }
    projected.push(layer);
  }
  if (JSON.stringify(projected) !== JSON.stringify(vectorLayers))
    cacheMetadataError("Cached PMTiles raw vector layers contradict normalized metadata.");
}

function validateCachedPmtilesEvidence(
  evidence: readonly DiscoveryCapabilityEvidence[],
  endpoint: string,
  retrievedAt: string,
  validator: string | undefined,
  supported: boolean,
): void {
  if (evidence.length !== 1)
    cacheMetadataError("Cached PMTiles capability evidence must contain exactly one archive metadata record.");
  const record = evidence[0];
  if (!record || !isPlainObject(record)) cacheMetadataError("Cached PMTiles capability evidence must be an object.");
  assertCachedKeys(record, ["kind", "capabilities", "scope", "provenance"], "PMTiles capability evidence");
  const expectedCapabilities = supported ? ["tiles"] : [];
  if (
    record.kind !== "metadata" ||
    !sameExactStringArray(record.capabilities, expectedCapabilities) ||
    !sameExactStringArray(record.scope, ["tiles"]) ||
    record.provenance?.length !== 1
  )
    cacheMetadataError("Cached PMTiles capability evidence contradicts direct archive discovery.");
  const provenance = record.provenance[0];
  if (!isPlainObject(provenance)) cacheMetadataError("Cached PMTiles capability provenance must be an object.");
  assertCachedKeys(provenance, ["source", "retrievedAt", "validator"], "PMTiles capability provenance");
  if (provenance.source !== endpoint || provenance.retrievedAt !== retrievedAt || provenance.validator !== validator)
    cacheMetadataError(
      "Cached PMTiles provenance does not bind to the archive endpoint, retrieval time, and validator.",
    );
}

function sameExactStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
  );
}

function cachedPmtilesValidator(value: unknown, label: string): string {
  const validator = cachedBoundedString(value, label, PMTILES_VALIDATOR_CODE_UNITS);
  const parsed = parsePmtilesValidatorIdentity(validator);
  if (!parsed || parsed.identity !== validator)
    cacheMetadataError(`Cached PMTiles ${label} is not a strong ETag or canonical Last-Modified validator.`);
  return validator;
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
  )
    cacheMetadataError("Cached PMTiles Content-Range is invalid.");
  return { start, end, total };
}

function cachedFiniteTuple(value: unknown, length: number, label: string): number[] {
  const values = checkedArray(value, `Cached PMTiles ${label}`, length);
  if (values.length !== length || values.some((entry) => typeof entry !== "number" || !Number.isFinite(entry)))
    cacheMetadataError(`Cached PMTiles ${label} must contain ${length} finite numbers.`);
  return [...values] as number[];
}

function cachedZoom(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 30)
    cacheMetadataError(`Cached PMTiles ${label} must be an integer from 0 through 30.`);
  return value as number;
}

function cachedBoundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum)
    cacheMetadataError(`Cached PMTiles ${label} must contain 1-${maximum} characters.`);
  return value;
}

function checkedArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    cacheMetadataError(`${label} must be an array with at most ${maximum} entries.`);
  return value;
}

function positiveCachedInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    cacheMetadataError(`Cached tile matrix ${label} must be a positive safe integer.`);
  return value as number;
}

function nonNegativeCachedInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    cacheMetadataError(`Cached ${label} must be a non-negative safe integer.`);
  return value as number;
}

function assertCachedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key)))
    cacheMetadataError(`Cached ${label} contains unknown fields.`);
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
