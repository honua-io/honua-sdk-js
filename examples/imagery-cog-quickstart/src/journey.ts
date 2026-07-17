import {
  type ElevationCoordinate,
  type ElevationProfile,
  type HonuaClient,
  type HonuaStacAsset,
  type HonuaStacItemResponse,
  type HonuaStacRasterBand,
  type StacSearchRequest,
  sampleElevationProfile,
} from "@honua/sdk-js/honua";

const DEFAULT_RANGE_PROBE_BYTES = 64;
const MIN_RANGE_PROBE_BYTES = 4;
const MAX_RANGE_PROBE_BYTES = 64 * 1024;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const MAX_REPORTED_MATCHES = 1_000_000;
const MAX_ASSETS_PER_SCENE = 64;
const DEFAULT_ELEVATION_PATH = "/api/v1/terrain/OahuTerrain/elevation/value";
const DEFAULT_WMS_COMPARISON_PATH = "/rest/services/OahuImagery/MapServer/WMS";
const SUPPORTED_INSPECTION_CRS = new Set([4326, 3857]);
const SUPPORTED_TIFF_MEDIA_TYPES = new Set(["image/tiff", "image/geotiff", "application/geotiff"]);

export type RasterUnsupportedCode = "credentials" | "cors" | "range" | "crs" | "format" | "nodata";

export interface ImageryTerrainSearchRequest {
  readonly collectionId: string;
  readonly bbox: readonly [number, number, number, number];
  readonly datetime: string;
  readonly maxCloudCover: number;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface ImageryTerrainAssetSummary {
  readonly key: string;
  readonly title: string;
  readonly href: string;
  readonly mediaType?: string;
  readonly roles: readonly string[];
}

export interface ImageryTerrainSceneSummary {
  readonly id: string;
  readonly collectionId: string;
  readonly title: string;
  readonly acquiredAt?: string;
  readonly cloudCover?: number;
  readonly footprint: readonly ElevationCoordinate[];
  readonly assets: readonly ImageryTerrainAssetSummary[];
}

export interface ImageryTerrainSearchReceipt {
  readonly sdkSurface: "HonuaClient.stac().search";
  readonly request: Readonly<StacSearchRequest>;
  readonly numberMatched: number;
  readonly scenes: readonly ImageryTerrainSceneSummary[];
}

export interface RasterSelectionIdentity {
  readonly selectionId: string;
  readonly collectionId: string;
  readonly itemId: string;
  readonly assetKey: string;
  readonly assetHref: string;
  readonly acquiredAt?: string;
  readonly version?: string;
}

export interface RasterBandInspection {
  readonly name: string;
  readonly dataType?: string;
  readonly resolutionMeters?: number;
  readonly nodata: number;
}

export interface RasterProvenance {
  readonly provider: string;
  readonly attribution: string;
  readonly license: string;
  readonly checksum?: string;
}

export interface RasterCacheEvidence {
  readonly key: string;
  readonly status: "observed" | "declared" | "unversioned";
  readonly etag?: string;
  readonly checksum?: string;
  readonly cacheControl?: string;
  readonly maxAgeSeconds?: number;
}

export interface RasterRangeEvidence {
  readonly sdkSurface: "HonuaClient.pipelineFetch";
  readonly requested: string;
  readonly contentRange: string;
  readonly bytesReceived: number;
  readonly totalBytes?: number;
  readonly acceptRangesAdvertised: boolean;
  readonly tiffByteOrder: "little-endian" | "big-endian";
}

export interface RasterAssetInspectionReady {
  readonly status: "ready";
  readonly identity: RasterSelectionIdentity;
  readonly mediaType: string;
  readonly crs: string;
  readonly bands: readonly RasterBandInspection[];
  readonly footprint: readonly ElevationCoordinate[];
  readonly provenance: RasterProvenance;
  readonly cache: RasterCacheEvidence;
  readonly range: RasterRangeEvidence;
  readonly comparison: {
    readonly status: "available";
    readonly wmsPath: string;
    readonly note: string;
  };
  readonly limitation: string;
}

export interface RasterAssetInspectionUnsupported {
  readonly status: "unsupported";
  readonly code: RasterUnsupportedCode;
  readonly identity: RasterSelectionIdentity;
  readonly message: string;
}

export interface RasterAssetInspectionCancelled {
  readonly status: "cancelled";
  readonly identity: RasterSelectionIdentity;
  readonly reason: "caller" | "superseded" | "disposed";
}

export type RasterAssetInspectionOutcome =
  | RasterAssetInspectionReady
  | RasterAssetInspectionUnsupported
  | RasterAssetInspectionCancelled;

export interface ElevationProvenance {
  readonly source: string;
  readonly version?: string;
  readonly attribution: string;
  readonly verticalDatum: string;
  readonly resolutionMeters?: number;
  readonly checksum?: string;
}

export interface ElevationCacheEvidence {
  readonly status: "uncached" | "observed" | "revalidated";
  readonly etag?: string;
  readonly cacheControl?: string;
}

export interface ElevationSampleReady {
  readonly status: "ready";
  readonly sdkSurface: "HonuaClient.pipelineRequestJson";
  readonly coordinate: ElevationCoordinate;
  readonly elevationMeters: number;
  readonly provenance: ElevationProvenance;
  readonly cache: ElevationCacheEvidence;
}

export interface ElevationNoDataOutcome {
  readonly status: "unsupported";
  readonly code: "nodata";
  readonly coordinate: ElevationCoordinate;
  readonly message: string;
}

export interface ElevationCancelledOutcome {
  readonly status: "cancelled";
  readonly coordinate: ElevationCoordinate;
}

export type ElevationLookupOutcome = ElevationSampleReady | ElevationNoDataOutcome | ElevationCancelledOutcome;

export interface ElevationProfileReady {
  readonly status: "ready";
  readonly sdkSurface: "sampleElevationProfile + HonuaClient.pipelineRequestJson";
  readonly profile: ElevationProfile;
  readonly provenance: ElevationProvenance;
  readonly cache: ElevationCacheEvidence;
}

export interface ElevationProfileNoDataOutcome {
  readonly status: "unsupported";
  readonly code: "nodata";
  readonly coordinate: ElevationCoordinate;
  readonly message: string;
}

export interface ElevationProfileCancelledOutcome {
  readonly status: "cancelled";
}

export type ElevationProfileOutcome =
  | ElevationProfileReady
  | ElevationProfileNoDataOutcome
  | ElevationProfileCancelledOutcome;

export interface ImageryTerrainResourceSnapshot {
  readonly activeRequests: number;
  readonly activeSelectionId?: string;
  readonly retainedRasterResource?: string;
  readonly disposed: boolean;
}

export interface ImageryTerrainJourneyOptions {
  readonly client: HonuaClient;
  readonly rangeProbeBytes?: number;
  readonly elevationPath?: string;
  readonly wmsComparisonPath?: string;
}

interface RawElevationResponse {
  longitude?: number;
  latitude?: number;
  elevationMeters?: number | null;
  noData?: boolean;
  source?: string;
  version?: string;
  attribution?: string;
  verticalDatum?: string;
  resolutionMeters?: number;
  checksum?: string;
  cache?: {
    status?: string;
    etag?: string;
    cacheControl?: string;
  };
}

interface ParsedAssetMetadata {
  readonly identity: RasterSelectionIdentity;
  readonly requestHref: string;
  readonly credentialBearing: boolean;
  readonly hrefValid: boolean;
  readonly mediaType: string;
  readonly crs?: number;
  readonly crsLabel?: string;
  readonly bands: readonly RasterBandInspection[];
  readonly footprint: readonly ElevationCoordinate[];
  readonly provenance: RasterProvenance;
}

class ElevationNoDataError extends Error {
  public constructor(public readonly coordinate: ElevationCoordinate) {
    super(`No elevation value is available at ${coordinate[0]}, ${coordinate[1]}.`);
  }
}

class BoundedBodyError extends Error {}

/**
 * Headless S1 orchestration for the Imagery and Terrain golden journey.
 *
 * It owns search, bounded header inspection, elevation, and cancellation. The
 * browser composes its ready selection with the opt-in `@honua/sdk-js/cog`
 * session, while ImageServer/WMS remain independent comparison paths.
 */
export class ImageryTerrainJourney {
  readonly #client: HonuaClient;
  readonly #rangeProbeBytes: number;
  readonly #elevationPath: string;
  readonly #wmsComparisonPath: string;
  readonly #items = new Map<string, HonuaStacItemResponse>();
  readonly #ownedControllers = new Set<AbortController>();
  #selectionController: AbortController | undefined;
  #selectionGeneration = 0;
  #activeSelectionId: string | undefined;
  #activeRequests = 0;
  #retainedResource: { selectionId: string; release: () => void } | undefined;
  #disposed = false;

  public constructor(options: ImageryTerrainJourneyOptions) {
    this.#client = options.client;
    this.#rangeProbeBytes = validateRangeProbeBytes(options.rangeProbeBytes ?? DEFAULT_RANGE_PROBE_BYTES);
    this.#elevationPath = options.elevationPath ?? DEFAULT_ELEVATION_PATH;
    this.#wmsComparisonPath = options.wmsComparisonPath ?? DEFAULT_WMS_COMPARISON_PATH;
  }

  public async search(request: ImageryTerrainSearchRequest): Promise<ImageryTerrainSearchReceipt> {
    this.#assertActive();
    const validated = validateSearchRequest(request);
    const owned = this.#ownRequest(request.signal);
    const wireRequest = {
      collections: [validated.collectionId],
      bbox: validated.bbox,
      datetime: validated.datetime,
      filter: `"eo:cloud_cover" <= ${validated.maxCloudCover}`,
      filterLang: "cql2-text",
      limit: validated.limit,
      signal: owned.controller.signal,
    } satisfies StacSearchRequest;

    this.#activeRequests += 1;
    try {
      const response = await this.#client.stac().search(wireRequest);
      if (owned.controller.signal.aborted) throw abortError(owned.controller.signal.reason);
      if (!Array.isArray(response.features))
        throw new TypeError("STAC search returned an invalid features collection.");
      const boundedItems = response.features.slice(0, validated.limit);
      const scenes = boundedItems.map((item) => toSceneSummary(item, this.#client.serverBaseUrl));
      const nextItems = new Map<string, HonuaStacItemResponse>();
      for (const item of boundedItems) nextItems.set(itemId(item), item);
      this.#items.clear();
      for (const [id, item] of nextItems) this.#items.set(id, item);
      return {
        sdkSurface: "HonuaClient.stac().search",
        request: wireRequest,
        numberMatched: boundedMatchCount(response.numberMatched, scenes.length),
        scenes,
      };
    } catch (error) {
      if (owned.controller.signal.aborted) throw abortError(owned.controller.signal.reason);
      throw error;
    } finally {
      this.#activeRequests -= 1;
      owned.release();
    }
  }

  public async inspectAsset(
    itemIdValue: string,
    assetKey: string,
    callerSignal?: AbortSignal,
  ): Promise<RasterAssetInspectionOutcome> {
    this.#assertActive();
    const item = this.#items.get(itemIdValue);
    if (!item) throw new RangeError(`STAC item ${itemIdValue} is not in the current search result.`);
    const asset = item.assets?.[assetKey];
    if (!asset) throw new RangeError(`STAC asset ${itemIdValue}/${assetKey} does not exist.`);

    const metadata = parseAssetMetadata(item, assetKey, asset, this.#client.serverBaseUrl);
    this.#releaseRetainedResource();
    this.#selectionController?.abort("Asset selection was superseded.");
    const generation = ++this.#selectionGeneration;
    const owned = this.#ownRequest(callerSignal);
    const controller = owned.controller;
    this.#selectionController = controller;
    this.#activeSelectionId = metadata.identity.selectionId;
    this.#activeRequests += 1;

    try {
      const localOutcome = validateAssetMetadata(this.#client.serverBaseUrl, metadata);
      if (localOutcome) return localOutcome;

      const rangeHeader = `bytes=0-${this.#rangeProbeBytes - 1}`;
      const response = await this.#client.pipelineFetch(
        "GET",
        metadata.requestHref,
        { headers: { Accept: metadata.mediaType, Range: rangeHeader } },
        controller.signal,
      );

      if (controller.signal.aborted || generation !== this.#selectionGeneration) {
        await cancelResponseBody(response);
        return cancelled(metadata.identity, this.#cancelReason(generation, callerSignal));
      }

      const contentRange = response.headers.get("content-range");
      const acceptRanges = response.headers.get("accept-ranges");
      const parsedContentRange = contentRange ? parseContentRange(contentRange) : undefined;
      if (
        response.status !== 206 ||
        !contentRange ||
        !parsedContentRange ||
        parsedContentRange.start !== 0 ||
        parsedContentRange.end >= this.#rangeProbeBytes
      ) {
        await cancelResponseBody(response);
        return unsupported(
          metadata.identity,
          "range",
          "The asset did not honor the bounded byte-range request with a valid 206 Content-Range response.",
        );
      }

      const expectedBytes = parsedContentRange.end - parsedContentRange.start + 1;
      const bytes = await readBoundedResponseBody(response, expectedBytes);
      if (bytes.byteLength !== expectedBytes) {
        return unsupported(
          metadata.identity,
          "range",
          "The ranged response byte count does not match its Content-Range declaration.",
        );
      }
      const byteOrder = tiffByteOrder(bytes);
      if (!byteOrder) {
        return unsupported(
          metadata.identity,
          "format",
          "The ranged response does not begin with a TIFF byte-order and magic-number signature.",
        );
      }

      const checksum = metadata.provenance.checksum;
      const etag = response.headers.get("etag") ?? undefined;
      const cacheControl = response.headers.get("cache-control") ?? undefined;
      const key = await buildRasterCacheKey(this.#client.serverBaseUrl, metadata.identity, etag, checksum);
      if (controller.signal.aborted || generation !== this.#selectionGeneration) {
        return cancelled(metadata.identity, this.#cancelReason(generation, callerSignal));
      }
      return {
        status: "ready",
        identity: metadata.identity,
        mediaType: metadata.mediaType,
        crs: metadata.crsLabel ?? `EPSG:${metadata.crs}`,
        bands: metadata.bands,
        footprint: metadata.footprint,
        provenance: metadata.provenance,
        cache: {
          key,
          status: etag || cacheControl ? "observed" : checksum ? "declared" : "unversioned",
          ...(etag ? { etag } : {}),
          ...(checksum ? { checksum } : {}),
          ...(cacheControl ? { cacheControl } : {}),
          ...(maxAgeSeconds(cacheControl) !== undefined ? { maxAgeSeconds: maxAgeSeconds(cacheControl) } : {}),
        },
        range: {
          sdkSurface: "HonuaClient.pipelineFetch",
          requested: rangeHeader,
          contentRange,
          bytesReceived: bytes.byteLength,
          totalBytes: parsedContentRange.total,
          acceptRangesAdvertised: acceptRanges?.trim().toLowerCase() === "bytes",
          tiffByteOrder: byteOrder,
        },
        comparison: {
          status: "available",
          wmsPath: this.#wmsComparisonPath,
          note: "Compare the direct COG mount with the independent WMS/ImageServer publication paths.",
        },
        limitation:
          "This receipt proves header/range metadata; the browser records direct decoding and MapLibre mounting separately.",
      };
    } catch (error) {
      if (controller.signal.aborted || generation !== this.#selectionGeneration) {
        return cancelled(metadata.identity, this.#cancelReason(generation, callerSignal));
      }
      return unsupported(
        metadata.identity,
        "range",
        `The bounded range probe failed: ${error instanceof Error ? error.message : "unknown transport error"}`,
      );
    } finally {
      owned.release();
      this.#activeRequests -= 1;
      if (this.#selectionController === controller) this.#selectionController = undefined;
    }
  }

  /**
   * Retain a renderer-owned raster resource for the current ready selection.
   * The journey never creates map/raster resources itself; it only owns the
   * cleanup callback so switching assets and disposal cannot leak them.
   */
  public retainRasterResource(inspection: RasterAssetInspectionReady, release: () => void): void {
    this.#assertActive();
    if (inspection.identity.selectionId !== this.#activeSelectionId) {
      throw new Error("Cannot retain a raster resource for an obsolete asset selection.");
    }
    this.#releaseRetainedResource();
    this.#retainedResource = { selectionId: inspection.identity.selectionId, release: once(release) };
  }

  public async lookupElevation(coordinate: ElevationCoordinate, signal?: AbortSignal): Promise<ElevationLookupOutcome> {
    this.#assertActive();
    validateCoordinate(coordinate, "Elevation coordinate");
    const owned = this.#ownRequest(signal);
    this.#activeRequests += 1;
    try {
      const raw = await this.#requestElevation(coordinate, owned.controller.signal);
      if (raw.noData === true || raw.elevationMeters == null || !Number.isFinite(raw.elevationMeters)) {
        return elevationNoData(coordinate);
      }
      return {
        status: "ready",
        sdkSurface: "HonuaClient.pipelineRequestJson",
        coordinate,
        elevationMeters: raw.elevationMeters,
        provenance: elevationProvenance(raw),
        cache: elevationCache(raw),
      };
    } catch (error) {
      if (owned.controller.signal.aborted) return { status: "cancelled", coordinate };
      throw error;
    } finally {
      this.#activeRequests -= 1;
      owned.release();
    }
  }

  public async sampleProfile(
    line: readonly ElevationCoordinate[],
    options: { readonly sampleCount?: number; readonly signal?: AbortSignal } = {},
  ): Promise<ElevationProfileOutcome> {
    this.#assertActive();
    validateProfileRequest(line, options.sampleCount);
    const owned = this.#ownRequest(options.signal);
    let firstResponse: RawElevationResponse | undefined;
    this.#activeRequests += 1;
    try {
      const profile = await sampleElevationProfile({
        line,
        sampleCount: options.sampleCount,
        sampler: async (coordinate) => {
          const raw = await this.#requestElevation(coordinate, owned.controller.signal);
          firstResponse ??= raw;
          if (raw.noData === true || raw.elevationMeters == null || !Number.isFinite(raw.elevationMeters)) {
            throw new ElevationNoDataError(coordinate);
          }
          return raw.elevationMeters;
        },
      });
      return {
        status: "ready",
        sdkSurface: "sampleElevationProfile + HonuaClient.pipelineRequestJson",
        profile,
        provenance: elevationProvenance(firstResponse ?? {}),
        cache: elevationCache(firstResponse ?? {}),
      };
    } catch (error) {
      if (owned.controller.signal.aborted) return { status: "cancelled" };
      if (error instanceof ElevationNoDataError) {
        return {
          status: "unsupported",
          code: "nodata",
          coordinate: error.coordinate,
          message: error.message,
        };
      }
      throw error;
    } finally {
      this.#activeRequests -= 1;
      owned.release();
    }
  }

  public resources(): ImageryTerrainResourceSnapshot {
    return {
      activeRequests: this.#activeRequests,
      ...(this.#activeSelectionId ? { activeSelectionId: this.#activeSelectionId } : {}),
      ...(this.#retainedResource ? { retainedRasterResource: this.#retainedResource.selectionId } : {}),
      disposed: this.#disposed,
    };
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#selectionGeneration += 1;
    for (const controller of this.#ownedControllers) {
      controller.abort("Imagery and Terrain journey disposed.");
    }
    this.#ownedControllers.clear();
    this.#selectionController = undefined;
    this.#releaseRetainedResource();
    this.#activeSelectionId = undefined;
    this.#items.clear();
  }

  async #requestElevation(coordinate: ElevationCoordinate, signal?: AbortSignal): Promise<RawElevationResponse> {
    const query = new URLSearchParams({
      longitude: String(coordinate[0]),
      latitude: String(coordinate[1]),
      sr: "4326",
      units: "meters",
    });
    return this.#client.pipelineRequestJson<RawElevationResponse>(
      "GET",
      `${this.#elevationPath}?${query.toString()}`,
      undefined,
      signal,
    );
  }

  #ownRequest(callerSignal?: AbortSignal): { controller: AbortController; release: () => void } {
    const controller = new AbortController();
    const unlinkCaller = linkAbortSignal(callerSignal, controller);
    this.#ownedControllers.add(controller);
    return {
      controller,
      release: once(() => {
        unlinkCaller();
        this.#ownedControllers.delete(controller);
      }),
    };
  }

  #releaseRetainedResource(): void {
    const retained = this.#retainedResource;
    this.#retainedResource = undefined;
    retained?.release();
  }

  #cancelReason(generation: number, callerSignal: AbortSignal | undefined): RasterAssetInspectionCancelled["reason"] {
    if (this.#disposed) return "disposed";
    if (generation !== this.#selectionGeneration) return "superseded";
    return callerSignal?.aborted ? "caller" : "superseded";
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("ImageryTerrainJourney has been disposed.");
  }
}

function validateAssetMetadata(
  baseUrl: string,
  metadata: ParsedAssetMetadata,
): RasterAssetInspectionUnsupported | undefined {
  if (!metadata.hrefValid) {
    return unsupported(metadata.identity, "format", "The STAC asset href is not a valid bounded HTTP URL or path.");
  }
  if (metadata.credentialBearing) {
    return unsupported(
      metadata.identity,
      "credentials",
      "Credential-bearing STAC asset URLs are not fetched or exposed by this browser journey; use a same-origin proxy with a credential-free asset path.",
    );
  }
  let resolved: URL;
  try {
    resolved = new URL(metadata.requestHref, baseUrl);
  } catch {
    return unsupported(metadata.identity, "format", "The STAC asset href is not a valid HTTP URL or relative path.");
  }
  const base = new URL(baseUrl);
  if (resolved.origin !== base.origin) {
    return unsupported(
      metadata.identity,
      "cors",
      "Direct cross-origin asset probing is rejected by the HonuaClient same-origin pipeline; route the asset through an explicitly configured same-origin Honua proxy.",
    );
  }
  if (!SUPPORTED_TIFF_MEDIA_TYPES.has(normalizeMediaType(metadata.mediaType))) {
    return unsupported(
      metadata.identity,
      "format",
      `The declared asset format ${metadata.mediaType || "(missing)"} is not a supported GeoTIFF media type.`,
    );
  }
  if (metadata.crs === undefined || !SUPPORTED_INSPECTION_CRS.has(metadata.crs)) {
    return unsupported(
      metadata.identity,
      "crs",
      `The inspection preview supports EPSG:4326 and EPSG:3857; ${metadata.crsLabel ?? "an undeclared CRS"} requires reprojection.`,
    );
  }
  if (metadata.bands.length === 0) {
    return unsupported(
      metadata.identity,
      "nodata",
      "The STAC raster metadata does not declare a finite nodata value for every band.",
    );
  }
  return undefined;
}

function parseAssetMetadata(
  item: HonuaStacItemResponse,
  assetKey: string,
  asset: HonuaStacAsset,
  baseUrl: string,
): ParsedAssetMetadata {
  const properties = item.properties ?? {};
  const id = itemId(item);
  const collectionId = item.collection ?? readString(properties, "collection") ?? "unknown";
  const acquiredAt = readString(properties, "datetime");
  const version = readString(properties, "honua:version") ?? readString(properties, "version");
  const crs = parseEpsg(asset["proj:code"], asset["proj:epsg"]);
  const crsLabel = crs !== undefined ? `EPSG:${crs}` : asset["proj:code"];
  const rawBands = asset["raster:bands"] ?? [];
  const bands = rawBands.every(hasFiniteNodata)
    ? rawBands.map(
        (band, index) =>
          ({
            name: band.name ?? band.common_name ?? `Band ${index + 1}`,
            ...(band.data_type ? { dataType: band.data_type } : {}),
            ...(typeof band.spatial_resolution === "number" ? { resolutionMeters: band.spatial_resolution } : {}),
            nodata: band.nodata,
          }) satisfies RasterBandInspection,
      )
    : [];
  const checksum = asset["file:checksum"] ?? asset["checksum:multihash"];
  const href = assetHrefSafety(asset.href, baseUrl);
  return {
    identity: {
      selectionId: `${collectionId}/${id}/${assetKey}`,
      collectionId,
      itemId: id,
      assetKey,
      assetHref: href.redacted,
      ...(acquiredAt ? { acquiredAt } : {}),
      ...(version ? { version } : {}),
    },
    requestHref: asset.href,
    credentialBearing: href.credentialBearing,
    hrefValid: href.valid,
    mediaType: asset.type ?? "",
    ...(crs !== undefined ? { crs } : {}),
    ...(crsLabel ? { crsLabel } : {}),
    bands,
    footprint: footprint(item),
    provenance: {
      provider: readString(properties, "honua:provider") ?? readString(properties, "platform") ?? "Unknown provider",
      attribution: readString(properties, "honua:attribution") ?? "Attribution not supplied",
      license: readString(properties, "honua:license") ?? readString(properties, "license") ?? "License not supplied",
      ...(typeof checksum === "string" ? { checksum } : {}),
    },
  };
}

function toSceneSummary(item: HonuaStacItemResponse, baseUrl: string): ImageryTerrainSceneSummary {
  const properties = item.properties ?? {};
  const acquiredAt = readString(properties, "datetime");
  const cloudCover = readNumber(properties, "eo:cloud_cover");
  return {
    id: itemId(item),
    collectionId: item.collection ?? readString(properties, "collection") ?? "unknown",
    title: readString(properties, "title") ?? itemId(item),
    ...(acquiredAt ? { acquiredAt } : {}),
    ...(cloudCover !== undefined ? { cloudCover } : {}),
    footprint: footprint(item),
    assets: Object.entries(item.assets ?? {})
      .slice(0, MAX_ASSETS_PER_SCENE)
      .map(([key, asset]) => ({
        key,
        title: asset.title ?? key,
        href: assetHrefSafety(asset.href, baseUrl).redacted,
        ...(asset.type ? { mediaType: asset.type } : {}),
        roles: asset.roles ?? [],
      })),
  };
}

function itemId(item: HonuaStacItemResponse): string {
  if (item.id === undefined) throw new Error("STAC search returned an item without an id.");
  return String(item.id);
}

function footprint(item: HonuaStacItemResponse): readonly ElevationCoordinate[] {
  if (item.geometry?.type === "Polygon") {
    const ring = item.geometry.coordinates[0];
    if (Array.isArray(ring)) {
      return ring.flatMap((position) =>
        Array.isArray(position) && typeof position[0] === "number" && typeof position[1] === "number"
          ? [[position[0], position[1]] as const]
          : [],
      );
    }
  }
  const bbox = item.bbox;
  if (bbox && bbox.length >= 4) {
    const [xmin, ymin, xmax, ymax] = bbox;
    if ([xmin, ymin, xmax, ymax].every((value) => typeof value === "number")) {
      return [
        [xmin as number, ymin as number],
        [xmax as number, ymin as number],
        [xmax as number, ymax as number],
        [xmin as number, ymax as number],
        [xmin as number, ymin as number],
      ];
    }
  }
  return [];
}

function unsupported(
  identity: RasterSelectionIdentity,
  code: RasterUnsupportedCode,
  message: string,
): RasterAssetInspectionUnsupported {
  return { status: "unsupported", code, identity, message };
}

function cancelled(
  identity: RasterSelectionIdentity,
  reason: RasterAssetInspectionCancelled["reason"],
): RasterAssetInspectionCancelled {
  return { status: "cancelled", identity, reason };
}

function elevationNoData(coordinate: ElevationCoordinate): ElevationNoDataOutcome {
  return {
    status: "unsupported",
    code: "nodata",
    coordinate,
    message: `No elevation value is available at ${coordinate[0]}, ${coordinate[1]}.`,
  };
}

function elevationProvenance(raw: RawElevationResponse): ElevationProvenance {
  return {
    source: raw.source ?? "Unknown elevation source",
    ...(raw.version ? { version: raw.version } : {}),
    attribution: raw.attribution ?? "Attribution not supplied",
    verticalDatum: raw.verticalDatum ?? "Unknown vertical datum",
    ...(typeof raw.resolutionMeters === "number" ? { resolutionMeters: raw.resolutionMeters } : {}),
    ...(raw.checksum ? { checksum: raw.checksum } : {}),
  };
}

function elevationCache(raw: RawElevationResponse): ElevationCacheEvidence {
  const declaredStatus = raw.cache?.status?.trim().toLowerCase();
  return {
    status: declaredStatus === "revalidated" ? "revalidated" : raw.cache?.etag ? "observed" : "uncached",
    ...(raw.cache?.etag ? { etag: raw.cache.etag } : {}),
    ...(raw.cache?.cacheControl ? { cacheControl: raw.cache.cacheControl } : {}),
  };
}

function validateRangeProbeBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_RANGE_PROBE_BYTES || value > MAX_RANGE_PROBE_BYTES) {
    throw new RangeError(
      `rangeProbeBytes must be a safe integer from ${MIN_RANGE_PROBE_BYTES} through ${MAX_RANGE_PROBE_BYTES}.`,
    );
  }
  return value;
}

function validateSearchRequest(request: ImageryTerrainSearchRequest): {
  collectionId: string;
  bbox: readonly [number, number, number, number];
  datetime: string;
  maxCloudCover: number;
  limit: number;
} {
  if (!request || typeof request !== "object") throw new TypeError("STAC search request must be an object.");
  if (typeof request.collectionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.collectionId)) {
    throw new RangeError("STAC collectionId must be a bounded identifier without whitespace or query syntax.");
  }
  if (!Array.isArray(request.bbox) || request.bbox.length !== 4 || !request.bbox.every(Number.isFinite)) {
    throw new RangeError("STAC bbox must contain exactly four finite coordinates.");
  }
  const [xmin, ymin, xmax, ymax] = request.bbox;
  if (xmin < -180 || xmax > 180 || ymin < -90 || ymax > 90 || xmin >= xmax || ymin >= ymax) {
    throw new RangeError("STAC bbox must be an ordered WGS84 extent.");
  }
  const datetime = validateDatetimeInterval(request.datetime);
  if (typeof request.maxCloudCover !== "number" || !Number.isFinite(request.maxCloudCover)) {
    throw new RangeError("STAC maxCloudCover must be a finite number.");
  }
  if (request.maxCloudCover < 0 || request.maxCloudCover > 100) {
    throw new RangeError("STAC maxCloudCover must be between 0 and 100.");
  }
  const limit = request.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new RangeError(`STAC limit must be a safe integer from 1 through ${MAX_SEARCH_LIMIT}.`);
  }
  return {
    collectionId: request.collectionId,
    bbox: [xmin, ymin, xmax, ymax],
    datetime,
    maxCloudCover: request.maxCloudCover,
    limit,
  };
}

function validateDatetimeInterval(value: string): string {
  if (typeof value !== "string" || value.length > 80) {
    throw new RangeError("STAC datetime must be a bounded RFC 3339 interval.");
  }
  const parts = value.split("/");
  if (parts.length !== 2 || !parts.every(isValidRfc3339Timestamp)) {
    throw new RangeError("STAC datetime must contain two RFC 3339 timestamps separated by '/'.");
  }
  const [start, end] = parts.map(Date.parse);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new RangeError("STAC datetime interval must contain valid timestamps in ascending order.");
  }
  return value;
}

function isValidRfc3339Timestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
    value,
  );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function boundedMatchCount(value: number | undefined, returned: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < returned) return returned;
  return Math.min(value, MAX_REPORTED_MATCHES);
}

function validateCoordinate(coordinate: ElevationCoordinate, label: string): void {
  if (
    !Array.isArray(coordinate) ||
    coordinate.length !== 2 ||
    !coordinate.every(Number.isFinite) ||
    coordinate[0] < -180 ||
    coordinate[0] > 180 ||
    coordinate[1] < -90 ||
    coordinate[1] > 90
  ) {
    throw new RangeError(`${label} must be a finite WGS84 longitude/latitude pair.`);
  }
}

function validateProfileRequest(line: readonly ElevationCoordinate[], sampleCount: number | undefined): void {
  if (!Array.isArray(line) || line.length < 2 || line.length > 10_000) {
    throw new RangeError("Elevation profile line must contain between 2 and 10,000 coordinates.");
  }
  for (const coordinate of line) validateCoordinate(coordinate, "Elevation profile coordinate");
  if (sampleCount !== undefined && (!Number.isSafeInteger(sampleCount) || sampleCount < 2 || sampleCount > 512)) {
    throw new RangeError("Elevation profile sampleCount must be a safe integer from 2 through 512.");
  }
}

function assetHrefSafety(
  href: string,
  baseUrl: string,
): { redacted: string; credentialBearing: boolean; valid: boolean } {
  if (typeof href !== "string" || href.length === 0 || href.length > 8_192) {
    return { redacted: "invalid-asset-url", credentialBearing: false, valid: false };
  }
  try {
    const resolved = new URL(href, baseUrl);
    const sensitiveKeys = [...resolved.searchParams.keys()].filter(isCredentialQueryKey);
    const credentialBearing = Boolean(
      resolved.username || resolved.password || resolved.hash || sensitiveKeys.length > 0,
    );
    resolved.username = "";
    resolved.password = "";
    resolved.hash = "";
    for (const key of sensitiveKeys) resolved.searchParams.set(key, "[redacted]");
    const absolute = /^[A-Za-z][A-Za-z\d+.-]*:/u.test(href);
    return {
      redacted: absolute ? resolved.toString() : `${resolved.pathname}${resolved.search}`,
      credentialBearing,
      valid: ["http:", "https:"].includes(resolved.protocol),
    };
  } catch {
    return { redacted: "invalid-asset-url", credentialBearing: false, valid: false };
  }
}

function isCredentialQueryKey(key: string): boolean {
  const normalized = key.trim().toLowerCase().replaceAll("-", "_");
  return (
    normalized === "key" ||
    normalized === "sig" ||
    normalized === "sas" ||
    normalized.startsWith("x_amz_") ||
    normalized.startsWith("x_goog_") ||
    /(?:^|_)(?:access|api|auth|bearer|credential|password|private|secret|signature|token)(?:_|$)/u.test(normalized)
  );
}

async function readBoundedResponseBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!/^\d+$/u.test(contentLengthHeader.trim()) || !Number.isSafeInteger(contentLength) || contentLength < 0) {
      await cancelResponseBody(response);
      throw new BoundedBodyError("The ranged response has an invalid Content-Length header.");
    }
    if (contentLength > maximumBytes) {
      await cancelResponseBody(response);
      throw new BoundedBodyError(`The ranged response exceeds the hard ${maximumBytes}-byte body ceiling.`);
    }
  }
  if (!response.body) throw new BoundedBodyError("The ranged response has no readable body.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        try {
          await reader.cancel("Bounded COG range response exceeded its byte ceiling.");
        } catch {
          // A transport abort may close the stream before cancellation settles.
        }
        throw new BoundedBodyError(`The ranged response exceeds the hard ${maximumBytes}-byte body ceiling.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function abortError(reason: unknown): DOMException {
  return new DOMException(typeof reason === "string" ? reason : "The owned request was aborted.", "AbortError");
}

function readString(properties: Record<string, unknown>, key: string): string | undefined {
  const value = properties[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(properties: Record<string, unknown>, key: string): number | undefined {
  const value = properties[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hasFiniteNodata(band: HonuaStacRasterBand): band is HonuaStacRasterBand & { nodata: number } {
  return typeof band.nodata === "number" && Number.isFinite(band.nodata);
}

function parseEpsg(code: string | undefined, legacyEpsg: number | undefined): number | undefined {
  const match = /^EPSG:(\d+)$/i.exec(code ?? "");
  if (match) {
    const value = Number(match[1]);
    if (Number.isInteger(value)) return value;
  }
  return typeof legacyEpsg === "number" && Number.isInteger(legacyEpsg) ? legacyEpsg : undefined;
}

function normalizeMediaType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function tiffByteOrder(bytes: Uint8Array): RasterRangeEvidence["tiffByteOrder"] | undefined {
  if (bytes.length < 4) return undefined;
  if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) return "little-endian";
  if (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a) return "big-endian";
  return undefined;
}

function parseContentRange(contentRange: string): { start: number; end: number; total: number } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || start > end || end >= total) return undefined;
  return { start, end, total };
}

function maxAgeSeconds(cacheControl: string | undefined): number | undefined {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? "");
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

export async function buildRasterCacheKey(
  serviceBaseUrl: string,
  identity: RasterSelectionIdentity,
  etag?: string,
  checksum?: string,
): Promise<string> {
  const service = new URL(serviceBaseUrl);
  const safeServiceOrigin = service.origin;
  const safeAssetLocator = assetHrefSafety(identity.assetHref, `${safeServiceOrigin}/`).redacted;
  const canonicalIdentity = JSON.stringify([
    "honua-raster-cache-v1",
    safeServiceOrigin,
    safeAssetLocator,
    identity.collectionId,
    identity.itemId,
    identity.assetKey,
    identity.version ?? null,
    etag ?? null,
    checksum ?? null,
  ]);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalIdentity));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `raster-v1:sha256:${hex}`;
}

function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  const abort = () => target.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be closed by an abort; cleanup is still complete.
  }
}

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}
