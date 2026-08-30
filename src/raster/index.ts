/**
 * `@honua/sdk-js/raster` - one bounded raster workflow across direct COG,
 * ImageServer, OGC API Coverages, and WCS 2.0.1 services.
 *
 * Direct COG sessions are returned only after the injected decoder has
 * structurally identified a Cloud Optimized GeoTIFF. A filename suffix is
 * never treated as conformance evidence. Coverage/WCS execution reuses the
 * bounded protocol clients and exact service paths from `@honua/sdk-js/coverages`.
 *
 * @experimental
 * @packageDocumentation
 */

import { type StacCogAssetSession, mountStacCogAssetToMapLibre, openStacCogAsset } from "../cog/index.js";
import type {
  CogBand,
  CogDecoderFactory,
  CogInspection,
  CogMapLibreCoordinates,
  CogOperationOptions,
  CogSampleArray,
  CogTransferLedger,
  CogTransferLimitOptions,
  CogWindowRequest,
  MountStacCogAssetToMapLibreOptions,
  MountedStacCogAssetToMapLibre,
  StacCogAssetToMapLibreMap,
} from "../cog/index.js";
import type { StacAssetCandidate } from "../connect-stac-static.js";
import { HonuaClient } from "../core/client.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import type {
  HonuaClientOptions,
  HonuaExportMapResponse,
  HonuaIdentifyResponse,
  HonuaServiceMetadata,
} from "../core/types.js";
import { coverageToMapLibreImage, createCoverageClient, createWcsClient } from "../coverages/index.js";
import type { CoverageMapLibreImage, CoverageResult } from "../coverages/index.js";
import type { DynamicStacAssetDescriptor } from "../stac/index.js";
import {
  rasterDiscoveryRegistryEntry,
  rasterSessionRegistryEntry,
} from "./source-registry.js";
import type { RasterRegistryMaturity, RasterRegistryServerStatus, RasterSourceIdentity } from "./source-registry.js";

export {
  RASTER_SOURCE_REGISTRY,
  rasterDiscoveryRegistryEntry,
  rasterRegistryEntry,
  rasterSessionRegistryEntry,
} from "./source-registry.js";
export type {
  RasterRegistryDiscoveryKind,
  RasterRegistryMaturity,
  RasterRegistryServerStatus,
  RasterRegistrySessionKind,
  RasterSourceIdentity,
  RasterSourceRegistryEntry,
} from "./source-registry.js";

export type RasterSourceKind = "cog" | "image-server" | "ogc-coverage" | "wcs";
export type RasterMaturity = RasterRegistryMaturity;
export type RasterOperation = "inspect" | "read-window" | "statistics" | "histogram" | "inspect-value" | "render";
export type RasterExecutionMode = "browser-range" | "worker-decode" | "server-operation" | "unavailable";

export interface RasterCapabilityStatus {
  readonly client: RasterMaturity;
  readonly server: RasterRegistryServerStatus;
  readonly endToEnd: RasterMaturity;
}

export interface RasterCapabilityRecord extends RasterCapabilityStatus {
  readonly source: RasterSourceKind;
  readonly identity: RasterSourceIdentity;
  readonly operations: readonly RasterOperation[];
  readonly note: string;
}

/** Runtime-independent truth table. An injected adapter does not upgrade a built-in claim. */
function capabilityRecord(kind: RasterSourceKind, deployment?: "honua" | "arcgis"): RasterCapabilityRecord {
  const entry = rasterSessionRegistryEntry(kind, deployment);
  return Object.freeze({
    source: kind,
    identity: entry.identity,
    client: entry.client,
    server: entry.server,
    endToEnd: entry.endToEnd,
    operations: entry.operations as readonly RasterOperation[],
    note: entry.note,
  });
}

/** Compatibility projection. ImageServer's row is the Honua deployment row; plans use the descriptor's explicit identity. */
export const UNIFIED_RASTER_CAPABILITY_MATRIX: Readonly<Record<RasterSourceKind, RasterCapabilityRecord>> =
  Object.freeze({
    cog: capabilityRecord("cog"),
    "image-server": capabilityRecord("image-server", "honua"),
    "ogc-coverage": capabilityRecord("ogc-coverage"),
    wcs: capabilityRecord("wcs"),
  });

/** Vocabulary reserved for later cloud-native discovery; these rows are not executable here. */
export const RASTER_FORMAT_MATURITY = {
  cog: rasterDiscoveryRegistryEntry("cog").client,
  zarr: rasterDiscoveryRegistryEntry("zarr").client,
  netcdf: rasterDiscoveryRegistryEntry("netcdf").client,
} as const satisfies Readonly<Record<"cog" | "zarr" | "netcdf", RasterMaturity>>;

export interface DirectCogCandidateSource {
  readonly kind: "cog";
  readonly id: string;
  readonly candidate: DynamicStacAssetDescriptor;
  readonly url?: never;
  readonly mediaType?: never;
}

export interface DirectCogUrlSource {
  readonly kind: "cog";
  readonly id: string;
  readonly url: string;
  /** Must explicitly declare the Cloud Optimized GeoTIFF profile. */
  readonly mediaType: string;
  readonly candidate?: never;
}

export type DirectCogRasterSource = DirectCogCandidateSource | DirectCogUrlSource;

export interface ImageServerRasterSource {
  readonly kind: "image-server";
  readonly id: string;
  readonly baseUrl: string;
  readonly serviceId: string;
  /** Explicit source identity; endpoint labels and URL shapes are never used to infer it. */
  readonly deployment: "honua" | "arcgis";
}

export interface OgcCoverageRasterSource {
  readonly kind: "ogc-coverage";
  readonly id: string;
  /** Exact OGC API Coverages service root; the SDK never guesses one. */
  readonly endpoint: string;
  readonly collectionId: string;
}

export interface WcsRasterSource {
  readonly kind: "wcs";
  readonly id: string;
  /** Exact capabilities-derived WCS KVP endpoint. */
  readonly endpoint: string;
  readonly coverageId: string;
  /** Advertised horizontal and vertical axis labels used for exact output sizing. */
  readonly scaleAxes: { readonly width: string; readonly height: string };
}

export type CoverageRasterSource = OgcCoverageRasterSource | WcsRasterSource;
export type RasterSourceDescriptor = DirectCogRasterSource | ImageServerRasterSource | CoverageRasterSource;

export interface RasterCachePolicy {
  readonly mode?: "default" | "reload" | "no-store" | "force-cache";
  readonly key?: string;
}

export interface RasterProgressEvent {
  readonly sourceId: string;
  readonly operation: RasterOperation;
  readonly phase: "started" | "completed";
  readonly requests?: number;
  readonly bytesFetched?: number;
}

export interface RasterExecutionPlan {
  readonly sourceId: string;
  readonly sourceKind: RasterSourceKind;
  readonly operation: RasterOperation;
  readonly mode: RasterExecutionMode;
  readonly bounded: boolean;
  readonly decoder: "main-thread" | "worker" | "server" | "none";
  readonly cache: RasterCachePolicy;
  readonly capability: RasterCapabilityRecord;
  readonly reason: string;
}

export interface RasterPixelWindow {
  readonly space: "pixel";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly outputSize?: readonly [number, number];
  readonly overviewDecimation?: number;
}

export interface RasterBoundingBoxWindow {
  readonly space: "bbox";
  readonly bbox: readonly [number, number, number, number];
  readonly width: number;
  readonly height: number;
  readonly spatialReference?: number | string;
}

export interface RasterStretchStyle {
  readonly kind: "stretch";
  readonly method: "min-max" | "percent-clip" | "standard-deviation";
  readonly minPercent?: number;
  readonly maxPercent?: number;
  readonly standardDeviations?: number;
  readonly gamma?: number;
}

export interface RasterColorMapStyle {
  readonly kind: "colormap";
  readonly stops: readonly {
    readonly value: number;
    readonly color: readonly [number, number, number, number?];
    readonly label?: string;
  }[];
}

export interface RasterHillshadeStyle {
  readonly kind: "hillshade";
  readonly azimuth?: number;
  readonly altitude?: number;
  readonly zFactor?: number;
}

export interface RasterTerrainStyle {
  readonly kind: "terrain";
  readonly exaggeration?: number;
}

export interface RasterMultibandStyle {
  readonly kind: "multiband";
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha?: number;
}

export type RasterStyle =
  | RasterStretchStyle
  | RasterColorMapStyle
  | RasterHillshadeStyle
  | RasterTerrainStyle
  | RasterMultibandStyle;

export type RasterWindowRequest = (RasterPixelWindow | RasterBoundingBoxWindow) & {
  /** One-based numeric band indexes. Coverage/WCS range fields are named separately. */
  readonly bands?: readonly number[];
  /** Protocol range/property names for OGC API Coverages and WCS. */
  readonly rangeFields?: readonly string[];
  readonly noData?: number;
  readonly resampling?: "nearest" | "bilinear";
  readonly style?: RasterStyle;
};

export interface RasterInspection {
  readonly source: RasterSourceDescriptor;
  readonly width?: number;
  readonly height?: number;
  readonly bands?: readonly CogBand[];
  readonly crs?: CogInspection["crs"];
  readonly metadata?: unknown;
  readonly structurallyValidated: boolean;
  readonly transfer?: CogTransferLedger;
}

export interface RasterDecodedWindowResult {
  readonly kind: "decoded-window";
  readonly request: RasterWindowRequest;
  readonly width: number;
  readonly height: number;
  readonly bands: readonly { readonly band: number; readonly values: CogSampleArray }[];
  readonly transfer: CogTransferLedger;
}

export interface RasterServerImageResult {
  readonly kind: "server-image";
  readonly request: RasterWindowRequest;
  readonly href: string;
  readonly width: number;
  readonly height: number;
  readonly response: HonuaExportMapResponse;
}

export interface RasterCoverageImageResult {
  readonly kind: "coverage-image";
  readonly request: RasterWindowRequest;
  readonly width: number;
  readonly height: number;
  readonly response: CoverageResult;
}

export type RasterWindowResult = RasterDecodedWindowResult | RasterServerImageResult | RasterCoverageImageResult;

export interface RasterHistogramBin {
  readonly min: number;
  readonly max: number;
  readonly count: number;
}

export interface RasterBandStatistics {
  readonly band: number;
  readonly count: number;
  readonly noDataCount: number;
  readonly min?: number;
  readonly max?: number;
  readonly mean?: number;
  readonly histogram: readonly RasterHistogramBin[];
}

export interface RasterStatisticsResult {
  readonly window: RasterWindowRequest;
  readonly bands: readonly RasterBandStatistics[];
  readonly transfer: CogTransferLedger;
}

export interface RasterPixelValueRequest {
  readonly space: "pixel" | "coordinate";
  readonly x: number;
  readonly y: number;
  readonly spatialReference?: string | number;
  readonly bands?: readonly number[];
  readonly style?: RasterStyle;
}

export type RasterPixelValueResult =
  | { readonly kind: "decoded-value"; readonly values: readonly { readonly band: number; readonly value: number }[] }
  | { readonly kind: "server-identify"; readonly response: HonuaIdentifyResponse };

export interface RasterLegendEntry {
  readonly label: string;
  readonly value?: number;
  readonly color: readonly [number, number, number, number];
}

export interface RasterMapLibreImageSource {
  readonly type: "image";
  readonly url: string;
  readonly coordinates: CogMapLibreCoordinates;
}

export interface RasterDeckGlBitmapDescriptor {
  readonly type: "BitmapLayer";
  readonly image: string;
  readonly bounds: readonly [number, number, number, number];
}

export type RasterClientOptions = Omit<HonuaClientOptions, "baseUrl">;

export interface OpenRasterSessionOptions {
  readonly decoderFactory?: CogDecoderFactory;
  readonly limits?: CogTransferLimitOptions;
  readonly decoderExecution?: "main-thread" | "worker";
  readonly cache?: RasterCachePolicy;
  readonly client?: HonuaClient;
  readonly clientOptions?: RasterClientOptions;
  readonly onProgress?: (event: RasterProgressEvent) => void;
  readonly signal?: AbortSignal;
}

const DEFAULT_CACHE_POLICY: RasterCachePolicy = { mode: "default" };
const MAX_SERVER_OUTPUT_PIXELS = 16_777_216;

/** Build a direct descriptor only from an explicit COG media-type assertion. */
export function directCogSource(input: {
  readonly id?: string;
  readonly url: string;
  readonly mediaType: string;
}): DirectCogUrlSource {
  if (!isCloudOptimizedGeoTiffMediaType(input.mediaType)) {
    throw new HonuaCapabilityNotSupportedError("structural-cog-inspection", "direct-cog", input.id ?? input.url);
  }
  return { kind: "cog", id: input.id ?? input.url, url: input.url, mediaType: input.mediaType };
}

/** Produce a serializable plan without starting decoder or network work. */
export function planRasterOperation(
  source: RasterSourceDescriptor,
  operation: RasterOperation,
  options: Pick<OpenRasterSessionOptions, "cache" | "decoderExecution"> = {},
): RasterExecutionPlan {
  const cache = options.cache ?? DEFAULT_CACHE_POLICY;
  const capability =
    source.kind === "image-server"
      ? capabilityRecord(source.kind, source.deployment)
      : UNIFIED_RASTER_CAPABILITY_MATRIX[source.kind];
  if (source.kind === "cog") {
    const supported = capability.operations.includes(operation);
    return {
      sourceId: source.id,
      sourceKind: source.kind,
      operation,
      mode: supported ? (options.decoderExecution === "worker" ? "worker-decode" : "browser-range") : "unavailable",
      bounded: true,
      decoder: supported ? (options.decoderExecution ?? "main-thread") : "none",
      cache,
      capability,
      reason: supported
        ? "The decoder can read only the requested byte ranges and pixel window."
        : "The direct COG session does not implement this operation.",
    };
  }
  if (source.kind === "image-server") {
    const supported = capability.operations.includes(operation);
    return {
      sourceId: source.id,
      sourceKind: source.kind,
      operation,
      mode: supported ? "server-operation" : "unavailable",
      bounded: operation !== "inspect",
      decoder: supported ? "server" : "none",
      cache,
      capability,
      reason: supported
        ? "The request maps to a typed ImageServer operation."
        : "ImageServer statistics and histogram endpoints are not claimed by this facade.",
    };
  }
  const supported = capability.operations.includes(operation);
  return {
    sourceId: source.id,
    sourceKind: source.kind,
    operation,
    mode: supported ? "server-operation" : "unavailable",
    bounded: operation === "read-window" || operation === "render" || operation === "inspect-value",
    decoder: supported ? "server" : "none",
    cache,
    capability,
    reason: supported
      ? "The bounded Coverage/WCS client uses the caller-provided service path without URL guessing."
      : "The Coverage/WCS raster facade does not implement this operation.",
  };
}

export class UnifiedRasterSession {
  readonly source: RasterSourceDescriptor;
  private readonly options: OpenRasterSessionOptions;
  private readonly client: HonuaClient;
  private readonly cog?: StacCogAssetSession;
  private readonly coverageClient?: ReturnType<typeof createCoverageClient>;
  private readonly wcsClient?: ReturnType<typeof createWcsClient>;
  private readonly coverageImages = new Set<CoverageMapLibreImage>();
  private disposed = false;

  /** @internal Use openRasterSession so direct COGs pass structural inspection before exposure. */
  public constructor(source: RasterSourceDescriptor, options: OpenRasterSessionOptions) {
    this.source = source;
    this.options = options;
    const endpoint =
      source.kind === "image-server" ? source.baseUrl : source.kind === "cog" ? cogUrl(source) : source.endpoint;
    const clientBaseUrl = source.kind === "image-server" ? source.baseUrl : new URL(endpoint).origin;
    if (source.kind === "image-server" && options.client) {
      assertImageServerClientBaseUrl(options.client, source);
    }
    this.client = options.client ?? new HonuaClient({ ...options.clientOptions, baseUrl: clientBaseUrl });

    if (source.kind === "ogc-coverage") {
      this.coverageClient = createCoverageClient(this.client, { basePath: source.endpoint });
    } else if (source.kind === "wcs") {
      this.wcsClient = createWcsClient(this.client, { basePath: source.endpoint });
    }

    if (source.kind === "cog") {
      if (!options.decoderFactory) {
        throw new HonuaCapabilityNotSupportedError("cog-decoder", "direct-cog", source.id);
      }
      const candidate =
        "candidate" in source && source.candidate ? dynamicStacCandidate(source) : directCandidate(source);
      const cacheMode = options.cache?.mode ?? "default";
      this.cog = openStacCogAsset(candidate, {
        decoderFactory: options.decoderFactory,
        limits: options.limits,
        fetchFn: (input, init) =>
          this.client.pipelineFetch("GET", String(input), { ...init, cache: cacheMode }, init?.signal ?? undefined),
      });
    }
  }

  plan(operation: RasterOperation): RasterExecutionPlan {
    this.assertActive();
    return planRasterOperation(this.source, operation, this.options);
  }

  async inspect(options: CogOperationOptions = {}): Promise<RasterInspection> {
    this.assertActive();
    this.progress("inspect", "started");
    if (this.source.kind === "cog") {
      const inspection = await this.requireCog().inspect(options);
      this.progress("inspect", "completed", inspection.transfer);
      return {
        source: this.source,
        width: inspection.width,
        height: inspection.height,
        bands: inspection.bands,
        crs: inspection.crs,
        structurallyValidated: true,
        transfer: inspection.transfer,
      };
    }
    if (this.source.kind === "image-server") {
      const metadata = await this.client.request<HonuaServiceMetadata>({
        method: "GET",
        path: `/rest/services/${encodeServiceId(this.source.serviceId)}/ImageServer`,
        responseFormat: "json",
        signal: options.signal,
      });
      this.progress("inspect", "completed");
      return { source: this.source, metadata, structurallyValidated: false };
    }
    if (this.source.kind === "ogc-coverage") {
      const [collection, domainSet, rangeType] = await Promise.all([
        this.requireCoverageClient().collection(this.source.collectionId, { signal: options.signal }),
        this.requireCoverageClient().domainSet(this.source.collectionId, { signal: options.signal }),
        this.requireCoverageClient().rangeType(this.source.collectionId, { signal: options.signal }),
      ]);
      this.progress("inspect", "completed");
      return { source: this.source, metadata: { collection, domainSet, rangeType }, structurallyValidated: false };
    }
    const descriptions = await this.requireWcsClient().describeCoverage([this.source.coverageId], {
      signal: options.signal,
    });
    const description = descriptions[0];
    if (!description) {
      throw new HonuaCapabilityNotSupportedError("coverage-description", "wcs", this.source.id);
    }
    this.progress("inspect", "completed");
    return { source: this.source, metadata: description, structurallyValidated: false };
  }

  async readWindow(request: RasterWindowRequest, options: CogOperationOptions = {}): Promise<RasterWindowResult> {
    this.assertActive();
    validateBoundedWindow(request);
    this.progress("read-window", "started");
    if (this.source.kind === "cog") {
      if (request.rangeFields !== undefined) {
        throw new HonuaCapabilityNotSupportedError("named-range-fields", "direct-cog", this.source.id);
      }
      if (request.style !== undefined) {
        throw new HonuaCapabilityNotSupportedError("styled-window", "direct-cog", this.source.id);
      }
      if (request.space !== "pixel") {
        throw new HonuaCapabilityNotSupportedError("pixel-window", "direct-cog", this.source.id);
      }
      const outputSize = request.outputSize;
      const cogRequest: CogWindowRequest = {
        x: request.x,
        y: request.y,
        width: request.width,
        height: request.height,
        bands: oneBasedBands(request.bands, "direct-cog", this.source.id),
        sampling: outputSize
          ? {
              width: outputSize[0],
              height: outputSize[1],
              resampling: request.resampling ?? "nearest",
              overviewDecimation: request.overviewDecimation ?? 1,
            }
          : undefined,
      };
      const result = await this.requireCog().readWindow(cogRequest, options);
      this.progress("read-window", "completed", result.transfer);
      return {
        kind: "decoded-window",
        request,
        width: result.width,
        height: result.height,
        bands: result.bands,
        transfer: result.transfer,
      };
    }
    if (this.source.kind === "image-server") {
      if (request.rangeFields !== undefined) {
        throw new HonuaCapabilityNotSupportedError("named-range-fields", "image-server", this.source.id);
      }
      if (request.space !== "bbox") {
        throw new HonuaCapabilityNotSupportedError("bbox-window", "image-server", this.source.id);
      }
      const response = await this.client.imageService(this.source.serviceId).exportImage({
        bbox: [...request.bbox],
        size: [request.width, request.height],
        bboxSr: request.spatialReference,
        imageSr: request.spatialReference,
        bandIds: imageServerBandIds(request.bands, this.source.id),
        noData: request.noData,
        interpolation: imageServerInterpolation(request.resampling),
        renderingRule: imageServerRenderingRule(request.style),
        format: "png",
        signal: options.signal,
      });
      if (!response.href) {
        throw new HonuaCapabilityNotSupportedError("image-href", "image-server", this.source.id);
      }
      this.progress("read-window", "completed");
      return {
        kind: "server-image",
        request,
        href: response.href,
        width: response.width ?? request.width,
        height: response.height ?? request.height,
        response,
      };
    }
    assertCoverageWindowRequest(request, this.source);
    const crs = coverageCrs(request.spatialReference);
    let response: CoverageResult;
    if (this.source.kind === "ogc-coverage") {
      response = await this.requireCoverageClient().getCoverage(this.source.collectionId, {
        bbox: request.bbox,
        ...(crs ? { bboxCrs: crs, outputCrs: crs } : {}),
        ...(request.rangeFields ? { properties: request.rangeFields } : {}),
        scaleSize: { width: request.width, height: request.height },
        format: "image/png",
        signal: options.signal,
      });
    } else {
      const descriptions = await this.requireWcsClient().describeCoverage([this.source.coverageId], {
        signal: options.signal,
      });
      const description = descriptions[0];
      if (!description) {
        throw new HonuaCapabilityNotSupportedError("coverage-description", "wcs", this.source.id);
      }
      response = await this.requireWcsClient().getCoverage(this.source.coverageId, {
        bbox: request.bbox,
        ...(crs ? { bboxCrs: crs, subsettingCrs: crs, outputCrs: crs } : {}),
        ...(request.rangeFields ? { rangeSubset: request.rangeFields } : {}),
        scaleSize: wcsScaleSize(description.axisLabels, this.source.scaleAxes, request, this.source.id),
        format: "image/png",
        signal: options.signal,
      });
    }
    this.progress("read-window", "completed");
    return { kind: "coverage-image", request, width: request.width, height: request.height, response };
  }

  async statistics(
    request: RasterWindowRequest,
    options: CogOperationOptions & { readonly bins?: number } = {},
  ): Promise<RasterStatisticsResult> {
    if (this.source.kind !== "cog") {
      throw new HonuaCapabilityNotSupportedError("bounded-statistics", this.source.kind, this.source.id);
    }
    this.progress("statistics", "started");
    const result = await this.readWindow(request, options);
    if (result.kind !== "decoded-window") {
      throw new HonuaCapabilityNotSupportedError("client-statistics", this.source.kind, this.source.id);
    }
    const inspection = await this.requireCog().inspect(options);
    const bins = normalizeHistogramBins(options.bins);
    const statistics = result.bands.map((band) => {
      const metadata = inspection.bands.find((candidate) => candidate.index === band.band);
      return statisticsForBand(band.band, band.values, request.noData ?? numericNoData(metadata, this.source.id), bins);
    });
    this.progress("statistics", "completed", result.transfer);
    return { window: request, bands: statistics, transfer: result.transfer };
  }

  async histogram(
    request: RasterWindowRequest,
    options: CogOperationOptions & { readonly bins?: number } = {},
  ): Promise<readonly { readonly band: number; readonly bins: readonly RasterHistogramBin[] }[]> {
    const result = await this.statistics(request, options);
    return result.bands.map((band) => ({ band: band.band, bins: band.histogram }));
  }

  async inspectValue(
    request: RasterPixelValueRequest,
    options: CogOperationOptions = {},
  ): Promise<RasterPixelValueResult> {
    this.assertActive();
    this.progress("inspect-value", "started");
    if (this.source.kind === "cog") {
      if (request.space !== "pixel") {
        throw new HonuaCapabilityNotSupportedError("pixel-coordinate", "direct-cog", this.source.id);
      }
      const window = await this.readWindow(
        {
          space: "pixel",
          x: request.x,
          y: request.y,
          width: 1,
          height: 1,
          bands: request.bands,
          style: request.style,
        },
        options,
      );
      if (window.kind !== "decoded-window") {
        throw new HonuaCapabilityNotSupportedError("decoded-value", "direct-cog", this.source.id);
      }
      this.progress("inspect-value", "completed", window.transfer);
      return {
        kind: "decoded-value",
        values: window.bands.map((band) => ({ band: band.band, value: Number(band.values[0]) })),
      };
    }
    if (this.source.kind === "image-server") {
      if (request.space !== "coordinate") {
        throw new HonuaCapabilityNotSupportedError("map-coordinate", "image-server", this.source.id);
      }
      if (request.bands !== undefined) {
        throw new HonuaCapabilityNotSupportedError("inspect-value-band-selection", "image-server", this.source.id);
      }
      const response = await this.client.imageService(this.source.serviceId).identify({
        geometry: { x: request.x, y: request.y },
        sr: request.spatialReference,
        renderingRule: imageServerRenderingRule(request.style),
        signal: options.signal,
      });
      this.progress("inspect-value", "completed");
      return { kind: "server-identify", response };
    }
    throw new HonuaCapabilityNotSupportedError("inspect-value", this.source.kind, this.source.id);
  }

  mountMapLibre(
    map: StacCogAssetToMapLibreMap,
    options: MountStacCogAssetToMapLibreOptions = {},
  ): MountedStacCogAssetToMapLibre {
    this.assertActive();
    if (this.source.kind !== "cog") {
      throw new HonuaCapabilityNotSupportedError("direct-maplibre-mount", this.source.kind, this.source.id);
    }
    return mountStacCogAssetToMapLibre(map, this.requireCog(), options);
  }

  toMapLibreImageSource(result: RasterWindowResult, coordinates?: CogMapLibreCoordinates): RasterMapLibreImageSource {
    if (result.kind === "coverage-image") {
      if (coordinates !== undefined) {
        throw new HonuaCapabilityNotSupportedError("custom-coverage-coordinates", this.source.kind, this.source.id);
      }
      return this.coverageImage(result).source;
    }
    if (result.kind !== "server-image") {
      throw new HonuaCapabilityNotSupportedError("encoded-image", this.source.kind, this.source.id);
    }
    return {
      type: "image",
      url: result.href,
      coordinates: coordinates
        ? validateMapLibreCoordinates(coordinates, this.source.kind, this.source.id)
        : bboxCoordinates(result.request, this.source.kind, this.source.id),
    };
  }

  toDeckGlBitmap(result: RasterWindowResult): RasterDeckGlBitmapDescriptor {
    if (result.kind === "decoded-window" || result.request.space !== "bbox") {
      throw new HonuaCapabilityNotSupportedError("encoded-bitmap", this.source.kind, this.source.id);
    }
    const image = result.kind === "coverage-image" ? this.coverageImage(result).source.url : result.href;
    return {
      type: "BitmapLayer",
      image,
      bounds: wgs84Bbox(result.request, this.source.kind, this.source.id),
    };
  }

  legend(style: RasterStyle): readonly RasterLegendEntry[] {
    if (style.kind !== "colormap") {
      throw new HonuaCapabilityNotSupportedError("legend", this.source.kind, this.source.id);
    }
    return style.stops.map((stop) => ({
      label: stop.label ?? String(stop.value),
      value: stop.value,
      color: [stop.color[0], stop.color[1], stop.color[2], stop.color[3] ?? 255],
    }));
  }

  transfer(): CogTransferLedger | undefined {
    return this.cog?.transfer();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const image of this.coverageImages) image.dispose();
    this.coverageImages.clear();
    await this.cog?.dispose();
  }

  private requireCog(): StacCogAssetSession {
    if (!this.cog) throw new HonuaCapabilityNotSupportedError("direct-cog", this.source.kind, this.source.id);
    return this.cog;
  }

  private requireCoverageClient(): ReturnType<typeof createCoverageClient> {
    if (!this.coverageClient) {
      throw new HonuaCapabilityNotSupportedError("coverage-client", this.source.kind, this.source.id);
    }
    return this.coverageClient;
  }

  private requireWcsClient(): ReturnType<typeof createWcsClient> {
    if (!this.wcsClient) throw new HonuaCapabilityNotSupportedError("wcs-client", this.source.kind, this.source.id);
    return this.wcsClient;
  }

  private coverageImage(result: RasterCoverageImageResult): CoverageMapLibreImage {
    const image = coverageToMapLibreImage(
      result.response,
      wgs84Bbox(result.request, this.source.kind, this.source.id),
      {
        sourceId: `${this.source.id}-coverage`,
      },
    );
    this.coverageImages.add(image);
    return image;
  }

  private progress(
    operation: RasterOperation,
    phase: RasterProgressEvent["phase"],
    transfer?: CogTransferLedger,
  ): void {
    this.options.onProgress?.({
      sourceId: this.source.id,
      operation,
      phase,
      requests: transfer?.requests,
      bytesFetched: transfer?.bytesFetched,
    });
  }

  private assertActive(): void {
    if (this.disposed) throw new HonuaCapabilityNotSupportedError("active-session", this.source.kind, this.source.id);
  }
}

function imageServerInterpolation(resampling: RasterWindowRequest["resampling"]): string | undefined {
  if (resampling === "nearest") return "RSP_NearestNeighbor";
  if (resampling === "bilinear") return "RSP_BilinearInterpolation";
  return undefined;
}

/** Open a source. Direct COG resolves only after bounded structural validation succeeds. */
export async function openRasterSession(
  source: RasterSourceDescriptor,
  options: OpenRasterSessionOptions = {},
): Promise<UnifiedRasterSession> {
  const session = new UnifiedRasterSession(source, options);
  if (source.kind === "cog") {
    try {
      await session.inspect({ signal: options.signal });
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }
  return session;
}

function cogUrl(source: DirectCogRasterSource): string {
  const sourceId = source.id;
  if ("candidate" in source && source.candidate) return requireDynamicCogHandoff(source).href;
  if (typeof source.url === "string") return source.url;
  throw new HonuaCapabilityNotSupportedError("safe-asset-url", "direct-cog", sourceId);
}

function dynamicStacCandidate(source: DirectCogCandidateSource): StacAssetCandidate {
  const descriptor = source.candidate;
  const handoff = requireDynamicCogHandoff(source);
  return {
    id: `${descriptor.itemId}:${descriptor.key}`,
    state: "classified",
    kind: "cog",
    confidence: "high",
    documentUrl: descriptor.href,
    objectType: "item",
    objectId: descriptor.itemId,
    itemId: descriptor.itemId,
    assetKey: descriptor.key,
    href: handoff.href,
    mediaType: descriptor.mediaType,
    roles: descriptor.roles,
    metadata: {},
    evidence: descriptor.mediaType ? [{ kind: "media-type", value: descriptor.mediaType, supports: ["cog"] }] : [],
    provenance: [],
  };
}

function requireDynamicCogHandoff(
  source: DirectCogCandidateSource,
): Extract<DynamicStacAssetDescriptor["handoff"], { kind: "cog" }> {
  const { candidate } = source;
  if (
    candidate.format !== "cog" ||
    candidate.maturity === "metadata-only" ||
    candidate.maturity === "unavailable" ||
    candidate.handoff?.kind !== "cog"
  ) {
    throw new HonuaCapabilityNotSupportedError("stac-cog-handoff", "stac", source.id);
  }
  return candidate.handoff;
}

function directCandidate(source: DirectCogUrlSource): StacAssetCandidate {
  if (!isCloudOptimizedGeoTiffMediaType(source.mediaType)) {
    throw new HonuaCapabilityNotSupportedError("structural-cog-inspection", "direct-cog", source.id);
  }
  return {
    id: `${source.id}:direct-cog`,
    state: "classified",
    kind: "cog",
    confidence: "high",
    documentUrl: source.url,
    objectType: "item",
    objectId: source.id,
    itemId: source.id,
    assetKey: "data",
    href: source.url,
    mediaType: source.mediaType,
    roles: ["data"],
    metadata: {},
    evidence: [{ kind: "media-type", value: source.mediaType, supports: ["cog"] }],
    provenance: [],
  };
}

function isCloudOptimizedGeoTiffMediaType(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase().replaceAll(" ", "");
  return (
    normalized.startsWith("image/tiff;") &&
    normalized.includes("application=geotiff") &&
    normalized.includes("profile=cloud-optimized")
  );
}

function validateBoundedWindow(request: RasterWindowRequest): void {
  if (
    !Number.isInteger(request.width) ||
    !Number.isInteger(request.height) ||
    request.width <= 0 ||
    request.height <= 0
  ) {
    throw new HonuaCapabilityNotSupportedError("positive-bounded-window", request.space);
  }
  if (request.width * request.height > MAX_SERVER_OUTPUT_PIXELS) {
    throw new HonuaCapabilityNotSupportedError("bounded-window-budget", request.space);
  }
  if (
    request.space === "pixel" &&
    (!Number.isInteger(request.x) || !Number.isInteger(request.y) || request.x < 0 || request.y < 0)
  ) {
    throw new HonuaCapabilityNotSupportedError("non-negative-pixel-window", "direct-cog");
  }
  if (
    request.space === "bbox" &&
    (request.bbox.some((value) => !Number.isFinite(value)) ||
      request.bbox[0] >= request.bbox[2] ||
      request.bbox[1] >= request.bbox[3])
  ) {
    throw new HonuaCapabilityNotSupportedError("ordered-finite-bbox", "server-raster");
  }
}

function oneBasedBands(
  bands: readonly number[] | undefined,
  protocol: RasterSourceKind | "direct-cog",
  sourceId: string,
): readonly number[] | undefined {
  if (bands === undefined) return undefined;
  if (bands.length === 0 || bands.some((band) => !Number.isInteger(band) || band < 1)) {
    throw new HonuaCapabilityNotSupportedError("one-based-band-selection", protocol, sourceId);
  }
  return bands;
}

function imageServerBandIds(bands: readonly number[] | undefined, sourceId: string): readonly number[] | undefined {
  return oneBasedBands(bands, "image-server", sourceId)?.map((band) => band - 1);
}

function assertCoverageWindowRequest(
  request: RasterWindowRequest,
  source: CoverageRasterSource,
): asserts request is RasterBoundingBoxWindow & RasterWindowRequest {
  if (request.space !== "bbox") {
    throw new HonuaCapabilityNotSupportedError("bbox-window", source.kind, source.id);
  }
  if (request.bands !== undefined) {
    throw new HonuaCapabilityNotSupportedError("named-range-fields", source.kind, source.id);
  }
  if (request.rangeFields?.length === 0 || request.rangeFields?.some((field) => field.trim().length === 0)) {
    throw new HonuaCapabilityNotSupportedError("non-empty-range-fields", source.kind, source.id);
  }
  if (request.noData !== undefined) {
    throw new HonuaCapabilityNotSupportedError("request-nodata", source.kind, source.id);
  }
  if (request.style !== undefined) {
    throw new HonuaCapabilityNotSupportedError("styled-window", source.kind, source.id);
  }
  if (request.resampling !== undefined) {
    throw new HonuaCapabilityNotSupportedError("resampled-window", source.kind, source.id);
  }
}

function coverageCrs(spatialReference: string | number | undefined): string | undefined {
  if (typeof spatialReference === "number") return `EPSG:${spatialReference}`;
  return spatialReference;
}

function wcsScaleSize(
  advertisedAxes: readonly string[],
  scaleAxes: WcsRasterSource["scaleAxes"],
  request: RasterBoundingBoxWindow,
  sourceId: string,
): Readonly<Record<string, number>> {
  if (scaleAxes.width === scaleAxes.height) {
    throw new HonuaCapabilityNotSupportedError("distinct-wcs-scale-axes", "wcs", sourceId);
  }
  const selected = new Set([scaleAxes.width, scaleAxes.height]);
  if (!advertisedAxes.includes(scaleAxes.width) || !advertisedAxes.includes(scaleAxes.height)) {
    throw new HonuaCapabilityNotSupportedError("advertised-wcs-scale-axes", "wcs", sourceId);
  }
  return Object.fromEntries(
    advertisedAxes
      .filter((axis) => selected.has(axis))
      .map((axis) => [axis, axis === scaleAxes.width ? request.width : request.height]),
  );
}

function normalizeHistogramBins(value: number | undefined): number {
  if (value === undefined) return 16;
  if (!Number.isInteger(value) || value < 1 || value > 256) {
    throw new HonuaCapabilityNotSupportedError("histogram-bin-budget", "direct-cog");
  }
  return value;
}

function numericNoData(band: CogBand | undefined, sourceId: string): number | undefined {
  if (typeof band?.nodata === "number") return band.nodata;
  if (typeof band?.nodata !== "string") return undefined;
  const value = band.nodata.trim();
  const parsed = value.length > 0 ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new HonuaCapabilityNotSupportedError("numeric-nodata", "direct-cog", sourceId);
  }
  return parsed;
}

function statisticsForBand(
  band: number,
  values: CogSampleArray,
  noData: number | undefined,
  binCount: number,
): RasterBandStatistics {
  const accepted: number[] = [];
  let noDataCount = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const sample of values) {
    const value = Number(sample);
    if (!Number.isFinite(value) || (noData !== undefined && value === noData)) {
      noDataCount += 1;
      continue;
    }
    accepted.push(value);
    sum += value;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (accepted.length === 0) return { band, count: 0, noDataCount, histogram: [] };
  if (max === min) {
    return {
      band,
      count: accepted.length,
      noDataCount,
      min,
      max,
      mean: min,
      histogram: [{ min, max, count: accepted.length }],
    };
  }
  const width = (max - min) / binCount;
  const counts = Array.from({ length: binCount }, () => 0);
  for (const value of accepted) {
    const index = Math.min(binCount - 1, Math.floor((value - min) / width));
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return {
    band,
    count: accepted.length,
    noDataCount,
    min,
    max,
    mean: sum / accepted.length,
    histogram: counts.map((count, index) => ({
      min: min + index * width,
      max: min + (index + 1) * width,
      count,
    })),
  };
}

function imageServerRenderingRule(style: RasterStyle | undefined): Record<string, unknown> | undefined {
  if (!style) return undefined;
  if (style.kind === "terrain") {
    throw new HonuaCapabilityNotSupportedError("terrain-rendering-rule", "image-server");
  }
  if (style.kind === "multiband") {
    return {
      rasterFunction: "CompositeBand",
      rasterFunctionArguments: {
        BandIDs: [style.red, style.green, style.blue, ...(style.alpha === undefined ? [] : [style.alpha])],
      },
    };
  }
  if (style.kind === "hillshade") {
    return {
      rasterFunction: "Hillshade",
      rasterFunctionArguments: {
        Azimuth: style.azimuth ?? 315,
        Altitude: style.altitude ?? 45,
        ZFactor: style.zFactor ?? 1,
      },
    };
  }
  if (style.kind === "colormap") {
    return {
      rasterFunction: "Colormap",
      rasterFunctionArguments: { Colormap: style.stops.map((stop) => [stop.value, ...stop.color]) },
    };
  }
  return {
    rasterFunction: "Stretch",
    rasterFunctionArguments: {
      StretchType: imageServerStretchType(style.method),
      MinPercent: style.minPercent,
      MaxPercent: style.maxPercent,
      NumberOfStandardDeviations: style.standardDeviations,
      Gamma: style.gamma,
    },
  };
}

function imageServerStretchType(method: RasterStretchStyle["method"]): 3 | 5 | 6 {
  if (method === "standard-deviation") return 3;
  if (method === "min-max") return 5;
  return 6;
}

function bboxCoordinates(
  request: RasterWindowRequest,
  sourceKind: RasterSourceKind,
  sourceId: string,
): CogMapLibreCoordinates {
  const [west, south, east, north] = wgs84Bbox(request, sourceKind, sourceId);
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}

function wgs84Bbox(
  request: RasterWindowRequest,
  sourceKind: RasterSourceKind,
  sourceId: string,
): readonly [number, number, number, number] {
  if (request.space !== "bbox") {
    throw new HonuaCapabilityNotSupportedError("bbox-coordinates", "server-raster");
  }
  if (!isWgs84SpatialReference(request.spatialReference)) {
    throw new HonuaCapabilityNotSupportedError("wgs84-presentation-extent", sourceKind, sourceId);
  }
  const [west, south, east, north] = request.bbox;
  if (west < -180 || east > 180 || south < -90 || north > 90) {
    throw new HonuaCapabilityNotSupportedError("wgs84-presentation-extent", sourceKind, sourceId);
  }
  return request.bbox;
}

function isWgs84SpatialReference(spatialReference: string | number | undefined): boolean {
  if (spatialReference === 4326) return true;
  if (typeof spatialReference !== "string") return false;
  const normalized = spatialReference.trim().toLowerCase();
  return (
    normalized === "4326" ||
    normalized === "epsg:4326" ||
    normalized === "crs:84" ||
    normalized === "ogc:crs84" ||
    normalized === "urn:ogc:def:crs:epsg::4326" ||
    normalized === "urn:ogc:def:crs:ogc::crs84" ||
    normalized === "http://www.opengis.net/def/crs/epsg/0/4326" ||
    normalized === "http://www.opengis.net/def/crs/ogc/1.3/crs84"
  );
}

function validateMapLibreCoordinates(
  coordinates: CogMapLibreCoordinates,
  sourceKind: RasterSourceKind,
  sourceId: string,
): CogMapLibreCoordinates {
  if (
    coordinates.some(
      ([longitude, latitude]) =>
        !Number.isFinite(longitude) ||
        !Number.isFinite(latitude) ||
        longitude < -180 ||
        longitude > 180 ||
        latitude < -90 ||
        latitude > 90,
    )
  ) {
    throw new HonuaCapabilityNotSupportedError("wgs84-presentation-coordinates", sourceKind, sourceId);
  }
  return coordinates;
}

function assertImageServerClientBaseUrl(client: HonuaClient, source: ImageServerRasterSource): void {
  if (normalizeClientBaseUrl(client.serverBaseUrl) !== normalizeClientBaseUrl(source.baseUrl)) {
    throw new HonuaCapabilityNotSupportedError("source-client-base-url", "image-server", source.id);
  }
}

function normalizeClientBaseUrl(value: string): string {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    let end = value.length;
    while (end > 0 && value.charCodeAt(end - 1) === 47) {
      end -= 1;
    }
    return value.slice(0, end);
  }
}

function encodeServiceId(serviceId: string): string {
  return serviceId.split("/").map(encodeURIComponent).join("/");
}

export { HonuaCapabilityNotSupportedError } from "../core/errors.js";
export { HonuaCogError } from "../cog/errors.js";
