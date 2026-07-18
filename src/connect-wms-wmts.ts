/** Internal fail-closed WMS/WMTS metadata discovery for connect(). */

import type { ConnectTarget } from "./connect-geoservices.js";
import {
  advertisedWmsAxisOrder,
  isAdvertisedWebMercatorCrs,
  mapLibreMatrixSetUnavailableReason,
  mapLibreTileMatrixTemplate,
} from "./connect-raster-evidence.js";
import { canonicalizeUrlQuery, hasCredentialQuery, isCredentialQueryName } from "./connect-url-safety.js";
import type {
  ConnectDiscoverySnapshot,
  ConnectDiscoverySourceSnapshot,
  ConnectOptions,
  ConnectSourceSchemaProjection,
} from "./connect.js";
import { HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION } from "./connect.js";
import type {
  DiscoveryAxisOrderMetadata,
  DiscoveryCacheIdentity,
  DiscoveryCapabilityEvidence,
  DiscoveryDimensionMetadata,
  DiscoveryOperationMetadata,
  DiscoveryProvenance,
  DiscoverySourceMetadata,
  DiscoveryStyleMetadata,
  DiscoveryTileMatrixSetMetadata,
} from "./contract/discovery.js";
import type { Capability, RasterRequestBinding, SourceLocator } from "./contract/types.js";
import {
  HONUA_DEFAULT_METADATA_STALE_IF_ERROR_MS,
  type HonuaCacheValidator,
  honuaCacheValidatorFromHeaders,
  honuaMetadataRequestHeaders,
  isHonuaCacheEntryFresh,
  normalizeHonuaMetadataRequestOptions,
} from "./core/cache-state.js";
import { OGC_CAPABILITIES_XML_LIMITS } from "./core/capabilities-xml.js";
import type { HonuaClient } from "./core/client.js";
import {
  HonuaAbortError,
  HonuaDiscoveryError,
  HonuaHttpError,
  HonuaNetworkError,
  HonuaTimeoutError,
} from "./core/errors.js";
import {
  type WmsCapabilities,
  type WmsCapabilityLayer,
  type WmsCapabilityOperation,
  parseWmsCapabilities,
} from "./core/wms-capabilities.js";
import {
  type WmtsCapabilities,
  type WmtsCapabilityLayer,
  type WmtsCapabilityOperation,
  type WmtsCapabilityResourceUrl,
  type WmtsCapabilityTileMatrixSet,
  isWmtsCapabilityTileMatrixSetComplete,
  parseWmtsCapabilities,
} from "./core/wmts-capabilities.js";

export const CONNECT_CAPABILITIES_MAX_BYTES = OGC_CAPABILITIES_XML_LIMITS.maxBytes;
export const CONNECT_CAPABILITIES_TIMEOUT_MS = 30_000;

const SUPPORTED_IMAGE_FORMATS = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const SUPPORTED_FEATURE_INFO_FORMATS = new Set([
  "application/json",
  "application/geo+json",
  "application/vnd.geo+json",
]);
interface CachedCapabilities {
  readonly xml: string;
  readonly cachedAtMs: number;
  readonly validator?: HonuaCacheValidator;
}

interface CapabilitiesDocument<T> {
  readonly value: T;
  readonly source: string;
  readonly retrievedAt: string;
  readonly validator?: HonuaCacheValidator;
}

const MAX_CAPABILITIES_CACHE_ENTRIES = 32;
const capabilitiesCache = new WeakMap<HonuaClient, Map<string, CachedCapabilities>>();

export async function discoverWmsWmtsSources(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  target: ConnectTarget,
  options: ConnectOptions,
  sourceSchemaProjection?: ConnectSourceSchemaProjection,
): Promise<ConnectDiscoverySnapshot> {
  if (target.protocol !== "wms" && target.protocol !== "wmts") {
    throw new HonuaDiscoveryError("protocol-mismatch", "WMS/WMTS discovery received a different protocol target.");
  }
  const document = await fetchCapabilities(client, identity, target, options);
  const sources =
    target.protocol === "wms"
      ? projectWms(document as CapabilitiesDocument<WmsCapabilities>, identity, target, options, sourceSchemaProjection)
      : projectWmts(
          document as CapabilitiesDocument<WmtsCapabilities>,
          identity,
          target,
          options,
          sourceSchemaProjection,
        );
  return Object.freeze({
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: identity.key,
    endpoint: identity.endpoint,
    protocol: target.protocol,
    retrievedAt: document.retrievedAt,
    evidence: Object.freeze([]),
    sources: Object.freeze(sources),
  });
}

async function fetchCapabilities(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  target: ConnectTarget,
  options: ConnectOptions,
): Promise<CapabilitiesDocument<WmsCapabilities | WmtsCapabilities>> {
  const protocol = target.protocol as "wms" | "wmts";
  const version = protocol === "wms" ? "1.3.0" : "1.0.0";
  const source = capabilitiesUrl(target.endpoint, protocol, version);
  const metadata = normalizeHonuaMetadataRequestOptions(options.metadata);
  const maxBytes = boundedLimit(
    options.capabilitiesLimits?.maxBytes,
    CONNECT_CAPABILITIES_MAX_BYTES,
    "capabilitiesLimits.maxBytes",
  );
  const timeoutMs = boundedLimit(
    options.capabilitiesLimits?.timeoutMs,
    CONNECT_CAPABILITIES_TIMEOUT_MS,
    "capabilitiesLimits.timeoutMs",
  );
  const cacheKey = `${protocol}:${source}:${identity.authorizationScopeDigest}`;
  const cache = cacheFor(client);
  // Bypass is a complete read/write bypass: no freshness hit, validator, or
  // stale-if-error fallback may observe an SDK-local entry.
  const candidate = metadata.cache === "bypass" ? undefined : cache.get(cacheKey);
  // A tighter caller limit is an admission boundary even when an earlier call
  // populated the shared client cache under the default ceiling. Treat an
  // oversized entry as absent so it cannot be returned, conditionally
  // revalidated, or used as stale-if-error metadata for this call.
  const cached = candidate && utf8Length(candidate.xml) <= maxBytes ? candidate : undefined;
  const now = Date.now();
  if (
    metadata.cache !== "bypass" &&
    options.refresh !== true &&
    !metadata.refresh &&
    cached &&
    isHonuaCacheEntryFresh(cached.cachedAtMs, now, metadata.ttlMs)
  ) {
    return parsedDocument(protocol, cached.xml, source, new Date(cached.cachedAtMs).toISOString(), cached.validator);
  }

  const deadline = discoveryDeadline(options.signal, timeoutMs);
  try {
    try {
      const headers = honuaMetadataRequestHeaders({
        accept: "text/xml,application/xml,application/vnd.ogc.wms_xml",
        refresh: options.refresh === true || metadata.refresh || Boolean(cached),
        bypass: metadata.cache === "bypass",
        validator: cached?.validator,
      });
      const response = await client.pipelineFetch("GET", source, { headers }, deadline.signal, {
        okStatuses: [304],
      });
      if (response.status === 206 || response.headers.has("content-range")) {
        await response.body?.cancel().catch(() => undefined);
        throw new HonuaDiscoveryError(
          "invalid-endpoint",
          `${protocol.toUpperCase()} GetCapabilities must return a complete representation, not an HTTP range.`,
          { statusCode: response.status },
        );
      }
      if (response.status !== 200 && response.status !== 304) {
        await response.body?.cancel().catch(() => undefined);
        throw new HonuaDiscoveryError(
          "invalid-endpoint",
          `${protocol.toUpperCase()} GetCapabilities returned unexpected successful status ${response.status}.`,
          { statusCode: response.status },
        );
      }
      if (response.status === 304) {
        await response.body?.cancel().catch(() => undefined);
        if (!cached || metadata.cache === "bypass") {
          throw new HonuaDiscoveryError(
            "invalid-endpoint",
            `${protocol.toUpperCase()} returned 304 without cached metadata.`,
          );
        }
        const validator = mergeCacheValidators(cached.validator, honuaCacheValidatorFromHeaders(response.headers));
        const refreshed = immutableCachedCapabilities({
          ...cached,
          cachedAtMs: Date.now(),
          ...(validator ? { validator } : {}),
        });
        const document = parsedDocument(
          protocol,
          refreshed.xml,
          source,
          new Date(refreshed.cachedAtMs).toISOString(),
          validator,
        );
        setCachedCapabilities(cache, cacheKey, refreshed);
        return document;
      }
      try {
        assertXmlContentType(response.headers.get("content-type"), protocol);
      } catch (cause) {
        await response.body?.cancel().catch(() => undefined);
        throw cause;
      }
      const xml = await readBoundedText(response, maxBytes, deadline.signal, protocol);
      if (deadline.timedOut()) throw new HonuaTimeoutError(timeoutMs);
      if (options.signal?.aborted) throw new HonuaAbortError();
      const validator = honuaCacheValidatorFromHeaders(response.headers);
      const entry = immutableCachedCapabilities({
        xml,
        cachedAtMs: Date.now(),
        ...(validator ? { validator } : {}),
      });
      const document = parsedDocument(protocol, xml, source, new Date(entry.cachedAtMs).toISOString(), validator);
      if (metadata.cache !== "bypass" && !capabilitiesContainUnsafeUrls(protocol, document.value, source)) {
        setCachedCapabilities(cache, cacheKey, entry);
      }
      return document;
    } catch (cause) {
      const normalized = normalizeCapabilitiesFailure(cause, deadline.timedOut(), options.signal, timeoutMs, protocol);
      const stale = staleFallback(cached, metadata.staleIfError, metadata.staleIfErrorMs, normalized);
      if (stale) {
        return parsedDocument(protocol, stale.xml, source, new Date(stale.cachedAtMs).toISOString(), stale.validator);
      }
      throw normalized;
    }
  } finally {
    deadline.dispose();
  }
}

function parsedDocument(
  protocol: "wms" | "wmts",
  xml: string,
  source: string,
  retrievedAt: string,
  validator: CachedCapabilities["validator"],
): CapabilitiesDocument<WmsCapabilities | WmtsCapabilities> {
  let value: WmsCapabilities | WmtsCapabilities;
  try {
    value = protocol === "wms" ? parseWmsCapabilities(xml) : parseWmtsCapabilities(xml);
  } catch (cause) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `${protocol.toUpperCase()} GetCapabilities metadata could not be parsed.`,
      { protocol },
      { cause },
    );
  }
  return Object.freeze({
    value,
    source,
    retrievedAt,
    ...(validator ? { validator: Object.freeze({ ...validator }) } : {}),
  });
}

function projectWms(
  document: CapabilitiesDocument<WmsCapabilities>,
  identity: DiscoveryCacheIdentity,
  target: ConnectTarget,
  options: ConnectOptions,
  sourceSchemaProjection: ConnectSourceSchemaProjection | undefined,
): readonly ConnectDiscoverySourceSnapshot[] {
  const capabilities = document.value;
  if (capabilities.version !== "1.3.0") {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `WMS discovery requires version 1.3.0; received ${capabilities.version || "no version"}.`,
      { expectedVersion: "1.3.0", receivedVersion: capabilities.version },
    );
  }
  const layers = selectUniqueWmsLayers(capabilities, options.typeName);
  const operationResults = new Map(
    capabilities.request.operations.map((operation) => [
      operation.name,
      validatedWmsOperation(operation, identity.endpoint),
    ]),
  );
  const capabilitiesProvenance = provenance(document);
  return layers.map((layer) => {
    const partialReasons: string[] = [...capabilities.warnings];
    const map = operationResults.get("GetMap");
    const featureInfo = operationResults.get("GetFeatureInfo");
    const legend = operationResults.get("GetLegendGraphic");
    partialReasons.push(...(map?.reasons ?? []), ...(featureInfo?.reasons ?? []), ...(legend?.reasons ?? []));
    const styles = validateWmsStyles(layer, identity.endpoint, partialReasons);
    const selectedStyle = selectStyle(styles, options.styleId, layer.name, "WMS", false);
    const mapFormat = preferredFormat(capabilities.formats.map, SUPPORTED_IMAGE_FORMATS);
    const featureInfoFormat = preferredFormat(capabilities.formats.featureInfo, SUPPORTED_FEATURE_INFO_FORMATS);
    const renderReason = wmsRenderUnavailableReason(layer, map, mapFormat);
    const advertisedQueryReason = wmsQueryUnavailableReason(layer, featureInfo, featureInfoFormat);
    const queryReason =
      advertisedQueryReason ??
      (target.serviceId
        ? undefined
        : "Raw WMS GetFeatureInfo requires a Honua service binding for the existing canonical query adapter.");
    const legendReason = wmsLegendUnavailableReason(legend, capabilities.formats.legend);
    if (renderReason) partialReasons.push(renderReason);
    if (layer.queryable && queryReason) partialReasons.push(queryReason);
    if (legendReason && legend !== undefined) partialReasons.push(legendReason);
    const renderAvailable = renderReason === undefined;
    const queryAvailable = queryReason === undefined;
    const raster =
      renderAvailable && mapFormat && map?.getUrls[0]
        ? (Object.freeze({
            kind: "wms-kvp",
            url: map.getUrls[0],
            format: mapFormat,
          }) satisfies RasterRequestBinding)
        : undefined;
    const capabilitiesEnabled: Capability[] = [
      ...(renderAvailable ? (["render", "tiles"] as const) : []),
      ...(queryAvailable ? (["query"] as const) : []),
    ];
    const evidence: DiscoveryCapabilityEvidence[] = [
      Object.freeze({
        kind: "metadata" as const,
        capabilities: Object.freeze(capabilitiesEnabled),
        scope: Object.freeze(["render", "tiles", "query"] as const),
        provenance: capabilitiesProvenance,
      }),
      ...unsafeOperationEvidence(map, ["render", "tiles"], capabilitiesProvenance),
      ...(layer.queryable ? unsafeOperationEvidence(featureInfo, ["query"], capabilitiesProvenance) : []),
    ];
    const metadata = wmsMetadata(
      capabilities,
      layer,
      styles,
      map,
      featureInfo,
      legend,
      renderAvailable,
      queryAvailable,
      renderReason,
      queryReason,
      legendReason,
      partialReasons,
    );
    const locator: SourceLocator = Object.freeze({
      url: identity.endpoint,
      ...(target.serviceId ? { serviceId: target.serviceId } : {}),
      typeName: layer.name,
      ...(selectedStyle ? { styleId: selectedStyle.id } : {}),
      ...(raster ? { raster } : {}),
    });
    const schemaV2 = sourceSchemaProjection?.wms(metadata, {
      source: document.source,
      observedAt: document.retrievedAt,
      ...schemaValidator(document.validator),
      protocol: "wms",
    });
    return Object.freeze({
      id: layer.name,
      locator,
      ...(layer.title ? { title: layer.title } : {}),
      ...(layer.abstract ? { description: layer.abstract } : {}),
      ...(layer.crs.length > 0 ? { crs: Object.freeze([...layer.crs]) } : {}),
      ...(metadata.extent ? { extent: metadata.extent } : {}),
      ...(schemaV2 ? { schemaV2 } : {}),
      metadata,
      evidence: Object.freeze(evidence),
    });
  });
}

function projectWmts(
  document: CapabilitiesDocument<WmtsCapabilities>,
  identity: DiscoveryCacheIdentity,
  target: ConnectTarget,
  options: ConnectOptions,
  sourceSchemaProjection: ConnectSourceSchemaProjection | undefined,
): readonly ConnectDiscoverySourceSnapshot[] {
  const capabilities = document.value;
  if (capabilities.version !== "1.0.0") {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `WMTS discovery requires version 1.0.0; received ${capabilities.version || "no version"}.`,
      { expectedVersion: "1.0.0", receivedVersion: capabilities.version },
    );
  }
  const layers = selectUniqueWmtsLayers(capabilities, options.typeName);
  const getTile = validatedWmtsOperation(operation(capabilities.operations, "GetTile"), identity.endpoint, "GetTile");
  const getFeatureInfo = validatedWmtsOperation(
    operation(capabilities.operations, "GetFeatureInfo"),
    identity.endpoint,
    "GetFeatureInfo",
  );
  const capabilitiesProvenance = provenance(document);
  const matrixSets = uniqueMatrixSets(capabilities.tileMatrixSets);
  return layers.map((layer) => {
    const partialReasons = [...capabilities.warnings, ...getTile.reasons, ...getFeatureInfo.reasons];
    const styles = validateWmtsStyles(layer, identity.endpoint, partialReasons);
    const selectedStyle = selectStyle(styles, options.styleId, layer.identifier, "WMTS", true);
    const selectedMatrixSet = selectMatrixSet(layer, matrixSets, options.tileMatrixSetId, partialReasons);
    const linkedMatrixSets = linkedMatrixSetsForLayer(layer, matrixSets);
    const format = preferredFormat(layer.formats, SUPPORTED_IMAGE_FORMATS);
    const tileResource = preferredResource(
      layer.resourceTemplates,
      format,
      identity.endpoint,
      "WMTS tile",
      ["TileMatrix", "TileRow", "TileCol"],
      partialReasons,
    );
    const infoFormat = preferredFormat(layer.infoFormats, SUPPORTED_FEATURE_INFO_FORMATS);
    const featureInfoResource = preferredResource(
      layer.featureInfoTemplates,
      infoFormat,
      identity.endpoint,
      "WMTS FeatureInfo",
      ["TileMatrix", "TileRow", "TileCol", "I", "J"],
      partialReasons,
    );
    const advertisedTileReason = wmtsTileUnavailableReason(
      selectedStyle,
      selectedMatrixSet,
      format,
      getTile,
      tileResource,
    );
    const rasterResult =
      advertisedTileReason === undefined && selectedMatrixSet && format
        ? wmtsRasterBinding(selectedMatrixSet, format, getTile, tileResource)
        : undefined;
    const tileReason = advertisedTileReason ?? rasterResult?.reason;
    const featureInfoReason = wmtsFeatureInfoUnavailableReason(
      selectedStyle,
      selectedMatrixSet,
      infoFormat,
      getFeatureInfo,
      featureInfoResource,
    );
    if (tileReason) partialReasons.push(tileReason);
    if (featureInfoReason && (layer.infoFormats.length > 0 || layer.featureInfoTemplates.length > 0)) {
      partialReasons.push(featureInfoReason);
    }
    const tileAvailable = tileReason === undefined;
    const featureInfoAvailable = featureInfoReason === undefined;
    const evidence: DiscoveryCapabilityEvidence[] = [
      Object.freeze({
        kind: "metadata" as const,
        capabilities: Object.freeze(tileAvailable ? (["render", "tiles"] as const) : []),
        scope: Object.freeze(["render", "tiles"] as const),
        provenance: capabilitiesProvenance,
      }),
      ...(!tileResource ? unsafeOperationEvidence(getTile, ["render", "tiles"], capabilitiesProvenance) : []),
    ];
    const metadata = wmtsMetadata(
      capabilities,
      layer,
      styles,
      selectedMatrixSet,
      linkedMatrixSets,
      getTile,
      getFeatureInfo,
      tileResource,
      featureInfoResource,
      tileAvailable,
      featureInfoAvailable,
      tileReason,
      featureInfoReason,
      partialReasons,
    );
    const locator: SourceLocator = Object.freeze({
      url: identity.endpoint,
      ...(target.serviceId ? { serviceId: target.serviceId } : {}),
      typeName: layer.identifier,
      ...(selectedStyle ? { styleId: selectedStyle.id } : {}),
      ...(selectedMatrixSet ? { tileMatrixSetId: selectedMatrixSet.identifier } : {}),
      ...(rasterResult?.binding ? { raster: rasterResult.binding } : {}),
    });
    const schemaV2 = sourceSchemaProjection?.wmts(metadata, {
      source: document.source,
      observedAt: document.retrievedAt,
      ...schemaValidator(document.validator),
      protocol: "wmts",
    });
    return Object.freeze({
      id: layer.identifier,
      locator,
      ...(layer.title ? { title: layer.title } : {}),
      ...(layer.abstract ? { description: layer.abstract } : {}),
      ...(selectedMatrixSet?.supportedCrs ? { crs: Object.freeze([selectedMatrixSet.supportedCrs]) } : {}),
      ...(metadata.extent ? { extent: metadata.extent } : {}),
      ...(schemaV2 ? { schemaV2 } : {}),
      metadata,
      evidence: Object.freeze(evidence),
    });
  });
}

interface ValidatedOperation {
  readonly getUrls: readonly string[];
  readonly postUrls: readonly string[];
  readonly methods: readonly ("GET" | "POST")[];
  readonly reasons: readonly string[];
}

function validatedWmsOperation(operation: WmsCapabilityOperation, endpoint: string): ValidatedOperation {
  const get = validatedUrls(operation.getUrls, endpoint, `WMS ${operation.name} GET`);
  const post = validatedUrls(operation.postUrls, endpoint, `WMS ${operation.name} POST`);
  return Object.freeze({
    getUrls: get.urls,
    postUrls: post.urls,
    methods: Object.freeze([
      ...(get.urls.length > 0 ? (["GET"] as const) : []),
      ...(post.urls.length > 0 ? (["POST"] as const) : []),
    ]),
    reasons: Object.freeze(unique([...get.reasons, ...post.reasons])),
  });
}

function validatedWmtsOperation(
  operation: WmtsCapabilityOperation | undefined,
  endpoint: string,
  name: string,
): ValidatedOperation {
  if (!operation) {
    return Object.freeze({
      getUrls: Object.freeze([]),
      postUrls: Object.freeze([]),
      methods: Object.freeze([]),
      reasons: Object.freeze([]),
    });
  }
  const get = validatedUrls(operation.getUrls, endpoint, `WMTS ${name} GET`);
  const post = validatedUrls(operation.postUrls, endpoint, `WMTS ${name} POST`);
  return Object.freeze({
    getUrls: get.urls,
    postUrls: post.urls,
    methods: Object.freeze([
      ...(get.urls.length > 0 ? (["GET"] as const) : []),
      ...(post.urls.length > 0 ? (["POST"] as const) : []),
    ]),
    reasons: Object.freeze(unique([...get.reasons, ...post.reasons])),
  });
}

function validatedUrls(
  advertised: readonly string[],
  endpoint: string,
  label: string,
): { readonly urls: readonly string[]; readonly reasons: readonly string[] } {
  const urls: string[] = [];
  const reasons: string[] = [];
  for (const raw of advertised) {
    const safe = safeAdvertisedUrl(raw, endpoint, label);
    if (safe.ok) urls.push(safe.url);
    else reasons.push(safe.reason);
  }
  return Object.freeze({ urls: Object.freeze(unique(urls)), reasons: Object.freeze(unique(reasons)) });
}

function unsafeOperationEvidence(
  operation: ValidatedOperation | undefined,
  scope: readonly Capability[],
  provenance: readonly DiscoveryProvenance[],
): readonly DiscoveryCapabilityEvidence[] {
  if (!operation || operation.getUrls.length > 0 || operation.reasons.length === 0) return Object.freeze([]);
  return Object.freeze([
    Object.freeze({
      kind: "unavailable" as const,
      scope: Object.freeze([...scope]),
      reason: operation.reasons.join(" "),
      provenance,
    }),
  ]);
}

function wmsRenderUnavailableReason(
  layer: WmsCapabilityLayer,
  operation: ValidatedOperation | undefined,
  format: string | undefined,
): string | undefined {
  if (!operation) return "WMS GetMap was not advertised.";
  if (operation.getUrls.length === 0) {
    return operation.postUrls.length > 0
      ? "WMS GetMap advertises POST but no safe GET URL supported by the current raster adapter."
      : "WMS GetMap did not advertise a safe GET URL.";
  }
  if (!format) return "WMS GetMap advertises no supported image format.";
  if (!layer.crs.some(isAdvertisedWebMercatorCrs)) {
    return "WMS layer does not advertise an exact EPSG:3857 CRS required by the current MapLibre raster adapter.";
  }
  return undefined;
}

function wmsQueryUnavailableReason(
  layer: WmsCapabilityLayer,
  operation: ValidatedOperation | undefined,
  format: string | undefined,
): string | undefined {
  if (!layer.queryable) return "The WMS layer is not queryable.";
  if (!operation) return "WMS GetFeatureInfo was not advertised.";
  if (operation.getUrls.length === 0) return "WMS GetFeatureInfo did not advertise a safe GET URL.";
  if (!format) return "WMS GetFeatureInfo advertises no supported JSON feature format.";
  return undefined;
}

function wmsLegendUnavailableReason(
  operation: ValidatedOperation | undefined,
  formats: readonly string[],
): string | undefined {
  if (!operation) return "WMS GetLegendGraphic was not advertised.";
  if (operation.getUrls.length === 0) return "WMS GetLegendGraphic did not advertise a safe GET URL.";
  if (formats.length === 0) return "WMS GetLegendGraphic advertises no output format.";
  return undefined;
}

function wmtsTileUnavailableReason(
  style: DiscoveryStyleMetadata | undefined,
  matrixSet: WmtsCapabilityTileMatrixSet | undefined,
  format: string | undefined,
  operation: ValidatedOperation,
  template: string | undefined,
): string | undefined {
  if (!style) return "WMTS tile discovery requires one explicit or uniquely default style.";
  if (!matrixSet) return "WMTS tile discovery found no linked tile matrix set.";
  if (!format) return "WMTS layer advertises no supported image format.";
  if (operation.getUrls.length === 0 && !template) {
    return "WMTS layer advertises no safe GetTile GET URL or valid REST template.";
  }
  return undefined;
}

function wmtsRasterBinding(
  matrixSet: WmtsCapabilityTileMatrixSet,
  format: string,
  operation: ValidatedOperation,
  template: string | undefined,
): { readonly binding?: RasterRequestBinding; readonly reason?: string } {
  const matrixEvidence = liveTileMatrixEvidence(matrixSet);
  const matrixReason = mapLibreMatrixSetUnavailableReason(matrixEvidence);
  if (matrixReason) return Object.freeze({ reason: matrixReason });
  const tileMatrixTemplate = mapLibreTileMatrixTemplate(matrixSet.matrices.map((matrix) => matrix.identifier));
  if (!tileMatrixTemplate) return Object.freeze({ reason: "WMTS tile matrix identifiers are not executable." });
  if (template) {
    const variables = templateVariables(template);
    const supportedVariables = new Set(["Layer", "Style", "TileMatrixSet", "TileMatrix", "TileRow", "TileCol"]);
    if (variables.ok && [...variables.values].every((variable) => supportedVariables.has(variable))) {
      return Object.freeze({
        binding: Object.freeze({
          kind: "wmts-template",
          url: template,
          format,
          tileMatrixTemplate,
        }),
      });
    }
    if (operation.getUrls.length === 0) {
      return Object.freeze({
        reason: `WMTS ResourceURL for tile matrix set "${matrixSet.identifier}" contains dimensions the existing raster adapter cannot bind.`,
      });
    }
  }
  const url = operation.getUrls[0];
  if (!url) {
    return Object.freeze({
      reason: "WMTS GetTile has no reviewed GET binding for the existing raster adapter.",
    });
  }
  return Object.freeze({
    binding: Object.freeze({
      kind: "wmts-kvp",
      url,
      format,
      tileMatrixTemplate,
    }),
  });
}

function wmtsFeatureInfoUnavailableReason(
  style: DiscoveryStyleMetadata | undefined,
  matrixSet: WmtsCapabilityTileMatrixSet | undefined,
  format: string | undefined,
  operation: ValidatedOperation,
  template: string | undefined,
): string | undefined {
  if (!style) return "WMTS FeatureInfo requires one explicit or uniquely default style.";
  if (!matrixSet) return "WMTS FeatureInfo found no linked tile matrix set.";
  if (!format) return "WMTS layer advertises no supported JSON FeatureInfo format.";
  if (operation.getUrls.length === 0 && !template) {
    return "WMTS layer advertises no safe GetFeatureInfo GET URL or valid REST template.";
  }
  return undefined;
}

function safeAdvertisedUrl(
  raw: string,
  endpoint: string,
  label: string,
): { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string } {
  let resolved: URL;
  try {
    resolved = new URL(raw, endpoint);
  } catch {
    return { ok: false, reason: `${label} advertised an invalid URL.` };
  }
  const endpointUrl = new URL(endpoint);
  if (
    (resolved.protocol !== "https:" && resolved.protocol !== "http:") ||
    resolved.origin !== endpointUrl.origin ||
    resolved.username ||
    resolved.password ||
    resolved.hash
  ) {
    return {
      ok: false,
      reason: `${label} URL must use HTTP(S), remain same-origin, and contain no credentials or fragment.`,
    };
  }
  for (const name of resolved.searchParams.keys()) {
    if (isCredentialQueryName(name)) {
      return { ok: false, reason: `${label} URL contains a credential-bearing query parameter.` };
    }
  }
  canonicalizeUrlQuery(resolved);
  return { ok: true, url: resolved.toString() };
}

function capabilitiesContainUnsafeUrls(
  protocol: "wms" | "wmts",
  capabilities: WmsCapabilities | WmtsCapabilities,
  source: string,
): boolean {
  if (protocol === "wms") {
    const wms = capabilities as WmsCapabilities;
    const operationUrls = wms.request.operations.flatMap((operation) => [...operation.getUrls, ...operation.postUrls]);
    const layerUrls: string[] = [];
    const layers = [...wms.layers];
    while (layers.length > 0) {
      const layer = layers.shift()!;
      layers.unshift(...layer.children);
      layerUrls.push(...layer.styles.flatMap((style) => style.legendUrl ?? []));
    }
    return [...operationUrls, ...layerUrls].some((url) => advertisedUrlIsUnsafe(url, source));
  }
  const wmts = capabilities as WmtsCapabilities;
  const operationUrls = wmts.operations.flatMap((operation) => [...operation.getUrls, ...operation.postUrls]);
  const layerUrls = wmts.layers.flatMap((layer) => [
    ...layer.styles.flatMap((style) => style.legendUrl ?? []),
    ...layer.resourceTemplates.map((resource) => resource.template),
    ...layer.featureInfoTemplates.map((resource) => resource.template),
  ]);
  return [...operationUrls, ...layerUrls].some((url) => advertisedUrlIsUnsafe(url, source));
}

function advertisedUrlIsUnsafe(raw: string, source: string): boolean {
  try {
    const parsed = new URL(raw, source);
    const capabilities = new URL(source);
    return Boolean(
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
        parsed.origin !== capabilities.origin ||
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        hasCredentialQuery(parsed.searchParams),
    );
  } catch {
    // An unparseable advertised URL cannot be proven safe. Keep it out of the
    // SDK-local raw XML cache even though projection will already reject it as
    // an executable operation.
    return true;
  }
}

function wmsMetadata(
  capabilities: WmsCapabilities,
  layer: WmsCapabilityLayer,
  styles: readonly DiscoveryStyleMetadata[],
  map: ValidatedOperation | undefined,
  featureInfo: ValidatedOperation | undefined,
  legend: ValidatedOperation | undefined,
  renderAvailable: boolean,
  queryAvailable: boolean,
  renderReason: string | undefined,
  queryReason: string | undefined,
  legendReason: string | undefined,
  partialReasons: readonly string[],
): DiscoverySourceMetadata {
  const crs = Object.freeze([...layer.crs]);
  const extent = wmsExtent(layer);
  return Object.freeze({
    ...(crs.length > 0 ? { crs } : {}),
    ...(extent ? { extent } : {}),
    protocolVersion: capabilities.version,
    formats: Object.freeze({
      render: Object.freeze([...capabilities.formats.map]),
      featureInfo: Object.freeze([...capabilities.formats.featureInfo]),
      legend: Object.freeze([...capabilities.formats.legend]),
    }),
    styles: Object.freeze(styles),
    dimensions: Object.freeze(
      layer.dimensions.map(
        (dimension): DiscoveryDimensionMetadata =>
          Object.freeze({
            id: dimension.name,
            ...(dimension.units ? { units: dimension.units } : {}),
            ...(dimension.default ? { default: dimension.default } : {}),
            values: Object.freeze([...dimension.values]),
          }),
      ),
    ),
    operations: Object.freeze({
      render: operationMetadata(
        renderAvailable,
        map,
        capabilities.formats.map,
        renderReason ?? "WMS GetMap is unavailable.",
      ),
      featureInfo: operationMetadata(
        queryAvailable,
        featureInfo,
        capabilities.formats.featureInfo,
        queryReason ?? "WMS GetFeatureInfo is unavailable.",
      ),
      legend: operationMetadata(
        legendReason === undefined,
        legend,
        capabilities.formats.legend,
        legendReason ?? "WMS GetLegendGraphic is unavailable.",
      ),
    }),
    axisOrders: Object.freeze(
      layer.crs.map((crs): DiscoveryAxisOrderMetadata => Object.freeze({ crs, order: advertisedWmsAxisOrder(crs) })),
    ),
    ...(partialReasons.length > 0 ? { partialReasons: Object.freeze(unique(partialReasons)) } : {}),
  });
}

function wmtsMetadata(
  capabilities: WmtsCapabilities,
  layer: WmtsCapabilityLayer,
  styles: readonly DiscoveryStyleMetadata[],
  selectedMatrixSet: WmtsCapabilityTileMatrixSet | undefined,
  linkedMatrixSets: readonly WmtsCapabilityTileMatrixSet[],
  getTile: ValidatedOperation,
  getFeatureInfo: ValidatedOperation,
  tileResource: string | undefined,
  featureInfoResource: string | undefined,
  tileAvailable: boolean,
  featureInfoAvailable: boolean,
  tileReason: string | undefined,
  featureInfoReason: string | undefined,
  partialReasons: readonly string[],
): DiscoverySourceMetadata {
  const extent = layer.bbox
    ? Object.freeze({
        spatial: Object.freeze({
          bbox: Object.freeze([Object.freeze([layer.bbox.west, layer.bbox.south, layer.bbox.east, layer.bbox.north])]),
          crs: "OGC:CRS84",
        }),
      })
    : undefined;
  const matrixMetadata = Object.freeze(linkedMatrixSets.map(tileMatrixMetadata));
  const crs = Object.freeze(unique(linkedMatrixSets.flatMap((matrixSet) => matrixSet.supportedCrs ?? [])));
  return Object.freeze({
    ...(crs.length > 0 ? { crs } : {}),
    ...(extent ? { extent } : {}),
    protocolVersion: capabilities.version,
    formats: Object.freeze({
      render: Object.freeze([...layer.formats]),
      featureInfo: Object.freeze([...layer.infoFormats]),
    }),
    styles: Object.freeze(styles),
    dimensions: Object.freeze(
      layer.dimensions.map(
        (dimension): DiscoveryDimensionMetadata =>
          Object.freeze({
            id: dimension.identifier,
            ...(dimension.default ? { default: dimension.default } : {}),
            current: dimension.current,
            values: Object.freeze([...dimension.values]),
          }),
      ),
    ),
    operations: Object.freeze({
      tiles: operationMetadata(
        tileAvailable,
        getTile,
        layer.formats,
        tileReason ?? "WMTS GetTile is unavailable.",
        tileResource,
      ),
      featureInfo: operationMetadata(
        featureInfoAvailable,
        getFeatureInfo,
        layer.infoFormats,
        featureInfoReason ?? "WMTS GetFeatureInfo is unavailable.",
        featureInfoResource,
      ),
    }),
    tileMatrixSets: matrixMetadata,
    ...(partialReasons.length > 0 ? { partialReasons: Object.freeze(unique(partialReasons)) } : {}),
  });
}

function operationMetadata(
  available: boolean,
  operation: ValidatedOperation | undefined,
  formats: readonly string[],
  reason: string,
  template?: string,
): DiscoveryOperationMetadata {
  const urls = Object.freeze(
    unique([...(operation?.getUrls ?? []), ...(operation?.postUrls ?? []), ...(template ? [template] : [])]),
  );
  const methods = Object.freeze(unique([...(operation?.methods ?? []), ...(template ? (["TEMPLATE"] as const) : [])]));
  return Object.freeze({
    available,
    methods,
    urls,
    formats: Object.freeze([...formats]),
    ...(!available ? { reason } : {}),
  });
}

function wmsExtent(layer: WmsCapabilityLayer): DiscoverySourceMetadata["extent"] | undefined {
  const bbox = layer.bbox.find((candidate) => candidate.crs === "CRS:84");
  if (!bbox) return undefined;
  return Object.freeze({
    spatial: Object.freeze({
      bbox: Object.freeze([Object.freeze([bbox.minx, bbox.miny, bbox.maxx, bbox.maxy])]),
      crs: "OGC:CRS84",
    }),
  });
}

function validateWmsStyles(
  layer: WmsCapabilityLayer,
  endpoint: string,
  partialReasons: string[],
): readonly DiscoveryStyleMetadata[] {
  const seen = new Set<string>();
  const styles: DiscoveryStyleMetadata[] = [];
  for (const style of layer.styles) {
    if (seen.has(style.name)) {
      partialReasons.push(`WMS layer "${layer.name}" repeats style "${style.name}"; later metadata was ignored.`);
      continue;
    }
    seen.add(style.name);
    let legendUrl: string | undefined;
    if (style.legendUrl) {
      const safe = safeAdvertisedUrl(style.legendUrl, endpoint, `WMS style "${style.name}" legend`);
      if (safe.ok) legendUrl = safe.url;
      else partialReasons.push(safe.reason);
    }
    styles.push(
      Object.freeze({
        id: style.name,
        ...(style.title ? { title: style.title } : {}),
        // WMS uses an empty STYLES value for the layer-defined default;
        // named Style entries are alternatives, not an ordered default list.
        isDefault: false,
        ...(legendUrl ? { legendUrl } : {}),
        ...(style.legendFormat ? { legendFormat: style.legendFormat } : {}),
      }),
    );
  }
  return Object.freeze(styles);
}

function validateWmtsStyles(
  layer: WmtsCapabilityLayer,
  endpoint: string,
  partialReasons: string[],
): readonly DiscoveryStyleMetadata[] {
  const seen = new Set<string>();
  const styles: DiscoveryStyleMetadata[] = [];
  for (const style of layer.styles) {
    if (seen.has(style.identifier)) {
      partialReasons.push(
        `WMTS layer "${layer.identifier}" repeats style "${style.identifier}"; later metadata was ignored.`,
      );
      continue;
    }
    seen.add(style.identifier);
    let legendUrl: string | undefined;
    if (style.legendUrl) {
      const safe = safeAdvertisedUrl(style.legendUrl, endpoint, `WMTS style "${style.identifier}" legend`);
      if (safe.ok) legendUrl = safe.url;
      else partialReasons.push(safe.reason);
    }
    styles.push(
      Object.freeze({
        id: style.identifier,
        ...(style.title ? { title: style.title } : {}),
        isDefault: style.isDefault,
        ...(legendUrl ? { legendUrl } : {}),
        ...(style.legendFormat ? { legendFormat: style.legendFormat } : {}),
      }),
    );
  }
  if (styles.filter((style) => style.isDefault).length > 1) {
    partialReasons.push(`WMTS layer "${layer.identifier}" advertises multiple default styles.`);
  } else if (styles.length === 0) {
    partialReasons.push(`WMTS layer "${layer.identifier}" advertises no styles.`);
  } else if (!styles.some((style) => style.isDefault)) {
    partialReasons.push(`WMTS layer "${layer.identifier}" advertises no default style.`);
  }
  return Object.freeze(styles);
}

function selectStyle(
  styles: readonly DiscoveryStyleMetadata[],
  selected: string | undefined,
  layer: string,
  family: "WMS" | "WMTS",
  requireDefault: boolean,
): DiscoveryStyleMetadata | undefined {
  if (selected) {
    const match = styles.find((style) => style.id === selected);
    if (!match) {
      throw new HonuaDiscoveryError(
        "ambiguous-source",
        `${family} style "${selected}" was not advertised by layer "${layer}".`,
        {
          typeName: layer,
          styleId: selected,
          styleIds: styles.map((style) => style.id),
        },
      );
    }
    return match;
  }
  if (!requireDefault) return undefined;
  const defaults = styles.filter((style) => style.isDefault);
  return defaults.length === 1 ? defaults[0] : undefined;
}

function selectMatrixSet(
  layer: WmtsCapabilityLayer,
  matrixSets: ReadonlyMap<string, WmtsCapabilityTileMatrixSet>,
  selected: string | undefined,
  partialReasons: string[],
): WmtsCapabilityTileMatrixSet | undefined {
  const ids = unique(layer.tileMatrixSetIds);
  if (selected && !ids.includes(selected)) {
    throw new HonuaDiscoveryError(
      "ambiguous-source",
      `WMTS tile matrix set "${selected}" was not linked by layer "${layer.identifier}".`,
      { typeName: layer.identifier, tileMatrixSetId: selected, tileMatrixSetIds: ids },
    );
  }
  if (selected) {
    const matrixSet = matrixSets.get(selected);
    if (matrixSet) return matrixSet;
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `WMTS layer "${layer.identifier}" references missing tile matrix set "${selected}".`,
      { typeName: layer.identifier, tileMatrixSetId: selected },
    );
  }
  let fallback: WmtsCapabilityTileMatrixSet | undefined;
  for (const id of ids) {
    const matrixSet = matrixSets.get(id);
    if (matrixSet) {
      fallback ??= matrixSet;
      if (mapLibreMatrixSetUnavailableReason(liveTileMatrixEvidence(matrixSet)) === undefined) return matrixSet;
      continue;
    }
    partialReasons.push(`WMTS layer "${layer.identifier}" references missing tile matrix set "${id}".`);
  }
  return fallback;
}

function linkedMatrixSetsForLayer(
  layer: WmtsCapabilityLayer,
  matrixSets: ReadonlyMap<string, WmtsCapabilityTileMatrixSet>,
): readonly WmtsCapabilityTileMatrixSet[] {
  return Object.freeze(
    unique(layer.tileMatrixSetIds).flatMap((identifier) => {
      const matrixSet = matrixSets.get(identifier);
      return matrixSet ? [matrixSet] : [];
    }),
  );
}

function tileMatrixMetadata(matrixSet: WmtsCapabilityTileMatrixSet): DiscoveryTileMatrixSetMetadata {
  return Object.freeze({
    id: matrixSet.identifier,
    ...(matrixSet.supportedCrs ? { crs: matrixSet.supportedCrs } : {}),
    ...(matrixSet.wellKnownScaleSet ? { wellKnownScaleSet: matrixSet.wellKnownScaleSet } : {}),
    matrices: Object.freeze(
      matrixSet.matrices.map((matrix) =>
        Object.freeze({
          id: matrix.identifier,
          scaleDenominator: matrix.scaleDenominator,
          matrixWidth: matrix.matrixWidth,
          matrixHeight: matrix.matrixHeight,
          tileWidth: matrix.tileWidth,
          tileHeight: matrix.tileHeight,
          topLeftCorner: Object.freeze([...matrix.topLeftCorner] as [number, number]),
        }),
      ),
    ),
  });
}

function liveTileMatrixEvidence(matrixSet: WmtsCapabilityTileMatrixSet) {
  return Object.freeze({
    ...tileMatrixMetadata(matrixSet),
    complete: isWmtsCapabilityTileMatrixSetComplete(matrixSet),
  });
}

function preferredResource(
  resources: readonly WmtsCapabilityResourceUrl[],
  format: string | undefined,
  endpoint: string,
  label: string,
  requiredPlaceholders: readonly string[],
  partialReasons: string[],
): string | undefined {
  const candidates = format
    ? resources.filter((resource) => resource.format.toLowerCase() === format.toLowerCase())
    : resources;
  for (const resource of candidates) {
    const safe = safeAdvertisedUrl(resource.template, endpoint, `${label} template`);
    if (!safe.ok) {
      partialReasons.push(safe.reason);
      continue;
    }
    const template = restoreTemplatePlaceholders(safe.url);
    const variables = templateVariables(template);
    if (!variables.ok) {
      partialReasons.push(`${label} template contains malformed placeholders.`);
      continue;
    }
    const missing = requiredPlaceholders.filter((placeholder) => !variables.values.has(placeholder));
    if (missing.length > 0) {
      partialReasons.push(`${label} template is missing required placeholders: ${missing.join(", ")}.`);
      continue;
    }
    return template;
  }
  return undefined;
}

function restoreTemplatePlaceholders(value: string): string {
  return value.replace(/%7B([A-Za-z_][A-Za-z0-9_.:-]{0,127})%7D/gi, (_match, name: string) => `{${name}}`);
}

function templateVariables(
  value: string,
): { readonly ok: true; readonly values: ReadonlySet<string> } | { readonly ok: false } {
  const variables = new Set<string>();
  const withoutVariables = value.replace(/\{([A-Za-z_][A-Za-z0-9_.:-]{0,127})\}/g, (_match, name: string) => {
    variables.add(name);
    return "";
  });
  return withoutVariables.includes("{") || withoutVariables.includes("}")
    ? { ok: false }
    : { ok: true, values: variables };
}

function preferredFormat(values: readonly string[], supported: ReadonlySet<string>): string | undefined {
  return values.find((value) => supported.has(value.toLowerCase()));
}

function selectUniqueWmsLayers(
  capabilities: WmsCapabilities,
  selected: string | undefined,
): readonly WmsCapabilityLayer[] {
  const all: WmsCapabilityLayer[] = [];
  const stack = [...capabilities.layers];
  const names = new Set<string>();
  while (stack.length > 0) {
    const layer = stack.shift()!;
    stack.unshift(...layer.children);
    if (!layer.name) continue;
    if (names.has(layer.name)) {
      throw new HonuaDiscoveryError("invalid-endpoint", `WMS layer names must be unique; repeated "${layer.name}".`);
    }
    names.add(layer.name);
    all.push(layer);
  }
  if (all.length === 0)
    throw new HonuaDiscoveryError("invalid-endpoint", "WMS GetCapabilities advertised no named layers.");
  if (!selected) return Object.freeze(all);
  const layer = all.find((candidate) => candidate.name === selected);
  if (!layer) {
    throw new HonuaDiscoveryError("ambiguous-source", `WMS layer "${selected}" was not advertised.`, {
      typeName: selected,
      sourceIds: all.map((candidate) => candidate.name),
    });
  }
  return Object.freeze([layer]);
}

function selectUniqueWmtsLayers(
  capabilities: WmtsCapabilities,
  selected: string | undefined,
): readonly WmtsCapabilityLayer[] {
  const names = new Set<string>();
  for (const layer of capabilities.layers) {
    if (!layer.identifier || names.has(layer.identifier)) {
      throw new HonuaDiscoveryError("invalid-endpoint", "WMTS layer identifiers must be unique non-empty strings.", {
        typeName: layer.identifier,
      });
    }
    names.add(layer.identifier);
  }
  if (capabilities.layers.length === 0) {
    throw new HonuaDiscoveryError("invalid-endpoint", "WMTS GetCapabilities advertised no layers.");
  }
  if (!selected) return capabilities.layers;
  const layer = capabilities.layers.find((candidate) => candidate.identifier === selected);
  if (!layer) {
    throw new HonuaDiscoveryError("ambiguous-source", `WMTS layer "${selected}" was not advertised.`, {
      typeName: selected,
      sourceIds: capabilities.layers.map((candidate) => candidate.identifier),
    });
  }
  return Object.freeze([layer]);
}

function uniqueMatrixSets(
  values: readonly WmtsCapabilityTileMatrixSet[],
): ReadonlyMap<string, WmtsCapabilityTileMatrixSet> {
  const result = new Map<string, WmtsCapabilityTileMatrixSet>();
  for (const value of values) {
    if (result.has(value.identifier)) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `WMTS tile matrix set identifiers must be unique; repeated "${value.identifier}".`,
      );
    }
    result.set(value.identifier, value);
  }
  return result;
}

function operation(values: readonly WmtsCapabilityOperation[], name: string): WmtsCapabilityOperation | undefined {
  const matches = values.filter((candidate) => candidate.name === name);
  if (matches.length > 1) {
    throw new HonuaDiscoveryError("invalid-endpoint", `WMTS repeats ${name} operation metadata.`);
  }
  return matches[0];
}

function capabilitiesUrl(endpoint: string, protocol: "wms" | "wmts", version: string): string {
  const url = new URL(endpoint);
  url.searchParams.set("SERVICE", protocol.toUpperCase());
  url.searchParams.set("REQUEST", "GetCapabilities");
  url.searchParams.set("VERSION", version);
  canonicalizeUrlQuery(url);
  return url.toString();
}

function provenance(document: CapabilitiesDocument<unknown>): readonly DiscoveryProvenance[] {
  const validator = document.validator?.etag ?? document.validator?.lastModified;
  return Object.freeze([
    Object.freeze({
      source: document.source,
      retrievedAt: document.retrievedAt,
      ...(validator ? { validator } : {}),
    }),
  ]);
}

function schemaValidator(
  validator: HonuaCacheValidator | undefined,
): { readonly validator: { readonly kind: "etag" | "last-modified"; readonly value: string } } | Record<string, never> {
  if (validator?.etag) return { validator: { kind: "etag", value: validator.etag } };
  if (validator?.lastModified) {
    return { validator: { kind: "last-modified", value: validator.lastModified } };
  }
  return {};
}

function mergeCacheValidators(
  cached: HonuaCacheValidator | undefined,
  observed: HonuaCacheValidator | undefined,
): HonuaCacheValidator | undefined {
  const etag = observed?.etag ?? cached?.etag;
  const lastModified = observed?.lastModified ?? cached?.lastModified;
  return etag || lastModified
    ? Object.freeze({ ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) })
    : undefined;
}

function cacheFor(client: HonuaClient): Map<string, CachedCapabilities> {
  let cache = capabilitiesCache.get(client);
  if (!cache) {
    cache = new Map();
    capabilitiesCache.set(client, cache);
  }
  return cache;
}

function setCachedCapabilities(cache: Map<string, CachedCapabilities>, key: string, value: CachedCapabilities): void {
  const owned = immutableCachedCapabilities(value);
  cache.delete(key);
  cache.set(key, owned);
  while (cache.size > MAX_CAPABILITIES_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function immutableCachedCapabilities(value: CachedCapabilities): CachedCapabilities {
  return Object.freeze({
    xml: value.xml,
    cachedAtMs: value.cachedAtMs,
    ...(value.validator ? { validator: Object.freeze({ ...value.validator }) } : {}),
  });
}

function normalizeCapabilitiesFailure(
  cause: unknown,
  timedOut: boolean,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
  protocol: "wms" | "wmts",
): unknown {
  if (timedOut) return new HonuaTimeoutError(timeoutMs, { cause });
  if (callerSignal?.aborted) return new HonuaAbortError("Request was aborted", { cause });
  if (
    cause instanceof HonuaDiscoveryError ||
    cause instanceof HonuaHttpError ||
    cause instanceof HonuaNetworkError ||
    cause instanceof HonuaTimeoutError ||
    cause instanceof HonuaAbortError
  ) {
    return cause;
  }
  return new HonuaNetworkError(`${protocol.toUpperCase()} GetCapabilities response failed while streaming.`, cause);
}

function staleFallback(
  cached: CachedCapabilities | undefined,
  allowed: boolean,
  staleIfErrorMs: number | undefined,
  cause: unknown,
): CachedCapabilities | undefined {
  if (!cached || !allowed || !transientFailure(cause)) return undefined;
  const limit = staleIfErrorMs ?? HONUA_DEFAULT_METADATA_STALE_IF_ERROR_MS;
  return Date.now() - cached.cachedAtMs <= limit ? cached : undefined;
}

function transientFailure(cause: unknown): boolean {
  return (
    (cause instanceof HonuaNetworkError && !/redirect|credential|origin/i.test(cause.message)) ||
    cause instanceof HonuaTimeoutError ||
    (cause instanceof HonuaHttpError && (cause.statusCode === 429 || cause.statusCode >= 500))
  );
}

function boundedLimit(value: number | undefined, maximum: number, label: string): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `${label} must be a positive safe integer no greater than ${maximum}.`,
    );
  }
  return value;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertXmlContentType(value: string | null, protocol: "wms" | "wmts"): void {
  if (!value) return;
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  if (mediaType !== "text/xml" && mediaType !== "application/xml" && mediaType !== "application/vnd.ogc.wms_xml") {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `${protocol.toUpperCase()} GetCapabilities returned unsupported content type "${mediaType}".`,
      { contentType: mediaType },
    );
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  protocol: "wms" | "wmts",
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      await response.body?.cancel().catch(() => undefined);
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `${protocol.toUpperCase()} returned an invalid Content-Length.`,
      );
    }
    if (length > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `${protocol.toUpperCase()} GetCapabilities exceeds the ${maxBytes}-byte response limit.`,
        { maxBytes, contentLength: length },
      );
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new HonuaAbortError();
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HonuaDiscoveryError(
          "invalid-endpoint",
          `${protocol.toUpperCase()} GetCapabilities exceeds the ${maxBytes}-byte response limit.`,
          { maxBytes },
        );
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `${protocol.toUpperCase()} GetCapabilities is not valid UTF-8 XML.`,
      undefined,
      { cause },
    );
  }
}

function discoveryDeadline(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timeout = false;
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  if (caller?.aborted) controller.abort();
  else caller?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", abort);
    },
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
