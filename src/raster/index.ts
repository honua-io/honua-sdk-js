/**
 * `@honua/sdk-js/raster` - one bounded raster workflow across direct COG,
 * ImageServer, and explicitly adapted OGC coverage services.
 *
 * Direct COG sessions are returned only after the injected decoder has
 * structurally identified a Cloud Optimized GeoTIFF. A filename suffix is
 * never treated as conformance evidence. Coverage/WCS descriptors are useful
 * for planning immediately, but execution stays fail-closed until a caller
 * supplies an adapter for an advertised operation URL.
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

export type RasterSourceKind = "cog" | "image-server" | "ogc-coverage" | "wcs";
export type RasterMaturity = "supported" | "experimental" | "metadata-only" | "unavailable";
export type RasterOperation = "inspect" | "read-window" | "statistics" | "histogram" | "inspect-value" | "render";
export type RasterExecutionMode = "browser-range" | "worker-decode" | "server-operation" | "unavailable";

export interface RasterCapabilityStatus {
  readonly client: RasterMaturity;
  readonly server: RasterMaturity;
  readonly endToEnd: RasterMaturity;
}

export interface RasterCapabilityRecord extends RasterCapabilityStatus {
  readonly source: RasterSourceKind;
  readonly operations: readonly RasterOperation[];
  readonly note: string;
}

/** Runtime-independent truth table. An injected adapter does not upgrade a built-in claim. */
export const UNIFIED_RASTER_CAPABILITY_MATRIX: Readonly<Record<RasterSourceKind, RasterCapabilityRecord>> = {
  cog: {
    source: "cog",
    client: "experimental",
    server: "unavailable",
    endToEnd: "experimental",
    operations: ["inspect", "read-window", "statistics", "histogram", "inspect-value", "render"],
    note: "Bounded browser range reads with caller-injected structural decoding; no server is required.",
  },
  "image-server": {
    source: "image-server",
    client: "supported",
    server: "supported",
    endToEnd: "supported",
    operations: ["inspect", "read-window", "inspect-value", "render"],
    note: "Uses the existing Honua/GeoServices ImageServer surface and its advertised operations.",
  },
  "ogc-coverage": {
    source: "ogc-coverage",
    client: "metadata-only",
    server: "experimental",
    endToEnd: "unavailable",
    operations: ["inspect"],
    note: "Descriptor and plan only unless an advertised-link coverage executor is supplied.",
  },
  wcs: {
    source: "wcs",
    client: "metadata-only",
    server: "experimental",
    endToEnd: "unavailable",
    operations: ["inspect"],
    note: "Descriptor and plan only unless a capabilities-derived WCS executor is supplied.",
  },
};

/** Vocabulary reserved for later cloud-native discovery; these rows are not executable here. */
export const RASTER_FORMAT_MATURITY = {
  cog: "experimental",
  zarr: "metadata-only",
  netcdf: "metadata-only",
} as const satisfies Readonly<Record<"cog" | "zarr" | "netcdf", RasterMaturity>>;

export interface DirectCogCandidateSource {
  readonly kind: "cog";
  readonly id: string;
  readonly candidate: StacAssetCandidate;
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
  readonly deployment?: "honua" | "arcgis";
}

export interface CoverageRasterSource {
  readonly kind: "ogc-coverage" | "wcs";
  readonly id: string;
  /** Capabilities-advertised operation URL; the SDK never appends a guessed endpoint. */
  readonly endpoint: string;
  readonly coverageId?: string;
}

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
  readonly capability: RasterCapabilityStatus;
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
  readonly bands?: readonly number[];
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

export type RasterWindowResult = RasterDecodedWindowResult | RasterServerImageResult;

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

export interface RasterCoverageExecutionContext {
  readonly signal?: AbortSignal;
  readonly client: HonuaClient;
}

export interface RasterCoverageExecutor {
  inspect(source: CoverageRasterSource, context: RasterCoverageExecutionContext): Promise<RasterInspection>;
  readWindow(
    source: CoverageRasterSource,
    request: RasterWindowRequest,
    context: RasterCoverageExecutionContext,
  ): Promise<RasterWindowResult>;
  inspectValue?(
    source: CoverageRasterSource,
    request: RasterPixelValueRequest,
    context: RasterCoverageExecutionContext,
  ): Promise<RasterPixelValueResult>;
}

export type RasterClientOptions = Omit<HonuaClientOptions, "baseUrl">;

export interface OpenRasterSessionOptions {
  readonly decoderFactory?: CogDecoderFactory;
  readonly limits?: CogTransferLimitOptions;
  readonly decoderExecution?: "main-thread" | "worker";
  readonly cache?: RasterCachePolicy;
  readonly client?: HonuaClient;
  readonly clientOptions?: RasterClientOptions;
  readonly coverageExecutor?: RasterCoverageExecutor;
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
  options: Pick<OpenRasterSessionOptions, "cache" | "decoderExecution" | "coverageExecutor"> = {},
): RasterExecutionPlan {
  const cache = options.cache ?? DEFAULT_CACHE_POLICY;
  const capability = UNIFIED_RASTER_CAPABILITY_MATRIX[source.kind];
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
  const adapted =
    Boolean(options.coverageExecutor) &&
    (operation === "inspect" ||
      operation === "read-window" ||
      (operation === "inspect-value" && typeof options.coverageExecutor?.inspectValue === "function"));
  return {
    sourceId: source.id,
    sourceKind: source.kind,
    operation,
    mode: adapted ? "server-operation" : "unavailable",
    bounded: operation === "read-window" || operation === "render" || operation === "inspect-value",
    decoder: adapted ? "server" : "none",
    cache,
    capability,
    reason: adapted
      ? "A caller-supplied executor owns the capabilities-advertised operation URL."
      : options.coverageExecutor
        ? "The supplied Coverage/WCS executor does not admit this operation."
        : "No built-in Coverage/WCS transport is claimed; supply an advertised-link executor.",
  };
}

export class UnifiedRasterSession {
  readonly source: RasterSourceDescriptor;
  private readonly options: OpenRasterSessionOptions;
  private readonly client: HonuaClient;
  private readonly cog?: StacCogAssetSession;
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

    if (source.kind === "cog") {
      if (!options.decoderFactory) {
        throw new HonuaCapabilityNotSupportedError("cog-decoder", "direct-cog", source.id);
      }
      const candidate = "candidate" in source && source.candidate ? source.candidate : directCandidate(source);
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
    const executor = this.requireCoverageExecutor("inspect");
    const result = await executor.inspect(this.source, { signal: options.signal, client: this.client });
    this.progress("inspect", "completed");
    return result;
  }

  async readWindow(request: RasterWindowRequest, options: CogOperationOptions = {}): Promise<RasterWindowResult> {
    this.assertActive();
    validateBoundedWindow(request);
    this.progress("read-window", "started");
    if (this.source.kind === "cog") {
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
        bands: request.bands,
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
      if (request.space !== "bbox") {
        throw new HonuaCapabilityNotSupportedError("bbox-window", "image-server", this.source.id);
      }
      const response = await this.client.imageService(this.source.serviceId).exportImage({
        bbox: [...request.bbox],
        size: [request.width, request.height],
        bboxSr: request.spatialReference,
        imageSr: request.spatialReference,
        bandIds: request.bands,
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
    const executor = this.requireCoverageExecutor("read-window");
    const result = await executor.readWindow(this.source, request, { signal: options.signal, client: this.client });
    this.progress("read-window", "completed");
    return result;
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
    const executor = this.requireCoverageExecutor("inspect-value");
    if (!executor.inspectValue) {
      throw new HonuaCapabilityNotSupportedError("inspect-value", this.source.kind, this.source.id);
    }
    const result = await executor.inspectValue(this.source, request, { signal: options.signal, client: this.client });
    this.progress("inspect-value", "completed");
    return result;
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
    if (result.kind !== "server-image" || result.request.space !== "bbox") {
      throw new HonuaCapabilityNotSupportedError("encoded-bitmap", this.source.kind, this.source.id);
    }
    return {
      type: "BitmapLayer",
      image: result.href,
      bounds: wgs84Bbox(result.request, this.source.kind, this.source.id),
    };
  }

  legend(style: RasterStyle): readonly RasterLegendEntry[] {
    if (style.kind !== "colormap") return [];
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
    await this.cog?.dispose();
  }

  private requireCog(): StacCogAssetSession {
    if (!this.cog) throw new HonuaCapabilityNotSupportedError("direct-cog", this.source.kind, this.source.id);
    return this.cog;
  }

  private requireCoverageExecutor(operation: RasterOperation): RasterCoverageExecutor {
    const executor = this.options.coverageExecutor;
    if (!executor) throw new HonuaCapabilityNotSupportedError(operation, this.source.kind, this.source.id);
    return executor;
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
  if ("candidate" in source && source.candidate?.href) return source.candidate.href;
  if (typeof source.url === "string") return source.url;
  throw new HonuaCapabilityNotSupportedError("safe-asset-url", "direct-cog", source.id);
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
    return value.replace(/\/+$/, "");
  }
}

function encodeServiceId(serviceId: string): string {
  return serviceId.split("/").map(encodeURIComponent).join("/");
}

export { HonuaCapabilityNotSupportedError } from "../core/errors.js";
export { HonuaCogError } from "../cog/errors.js";
