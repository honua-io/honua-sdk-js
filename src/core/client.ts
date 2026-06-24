import type { Client } from "@connectrpc/connect";
import type { FeatureService } from "../gen/honua/v1/feature_service_pb.js";
import {
  HONUA_DEFAULT_METADATA_STALE_IF_ERROR_MS,
  type HonuaCacheValidator,
  type HonuaMetadataRequestOptions,
  createHonuaCacheState,
  honuaCacheValidatorFromHeaders,
  honuaMetadataRequestHeaders,
  isHonuaCacheEntryFresh,
  normalizeHonuaMetadataRequestOptions,
  withHonuaCacheState,
  withoutHonuaCacheState,
} from "./cache-state.js";
import { HonuaAbortError, HonuaHttpError, HonuaNetworkError, HonuaTimeoutError } from "./errors.js";
import { HonuaOdataEntitySet } from "./odata.js";
import { HonuaOgcMaps } from "./ogc-maps.js";
import { HonuaOgcProcesses } from "./ogc-processes.js";
import { HonuaOgcRecords } from "./ogc-records.js";
import { HonuaOgcTiles } from "./ogc-tiles.js";
import { encodeServiceIdPath, stripQuery, trimTrailingSlashes } from "./path-utils.js";
import { decodePbfQueryResponse, isPbfResponse } from "./pbf-decoder.js";
import {
  type HonuaProcessRunner,
  createGeoServicesGpAdapter,
  createGeospatialGrpcProcessAdapter,
  createHonuaProcessRunner,
  createOgcProcessesAdapter,
} from "./process-runner.js";
import type { GeospatialGrpcProcessClient, HonuaProcessAdapter } from "./process-runner.js";
import { HonuaStacSearch } from "./stac.js";
import {
  HonuaFeatureLayer,
  HonuaGeometryService,
  HonuaGeoprocessingService,
  HonuaImageService,
  HonuaMapLayer,
  HonuaMapService,
  HonuaOgcFeatures,
  HonuaService,
} from "./surfaces.js";
import type {
  ApplyEditsRequest,
  ExportMapRequest,
  HonuaApiEnvelope,
  HonuaApplyEditsResponse,
  HonuaAuthCredentials,
  HonuaAuthCredentialsProvider,
  HonuaAuthProvider,
  HonuaAuthRefreshReason,
  HonuaAuthRevocationContext,
  HonuaClientOptions,
  HonuaCompatibilityRequest,
  HonuaErrorContext,
  HonuaExportMapResponse,
  HonuaFeature,
  HonuaFindResponse,
  HonuaIdentifyResponse,
  HonuaLayerMetadata,
  HonuaLegendResponse,
  HonuaOgcCollectionMetadata,
  HonuaOgcCollectionsResponse,
  HonuaOgcConformanceResponse,
  HonuaOgcFeatureCollectionResponse,
  HonuaOgcFeatureResponse,
  HonuaOgcLandingResponse,
  HonuaOgcMapImageResponse,
  HonuaOgcProcessDescription,
  HonuaOgcProcessJobAccepted,
  HonuaOgcProcessJobResults,
  HonuaOgcProcessJobStatus,
  HonuaOgcProcessesResponse,
  HonuaOgcQueryablesResponse,
  HonuaOgcRecordResponse,
  HonuaOgcRecordsResponse,
  HonuaOgcTileMatrixSet,
  HonuaOgcTileMatrixSetsResponse,
  HonuaOgcTileResponse,
  HonuaOgcTilesetMetadata,
  HonuaOgcTilesetsResponse,
  HonuaQueryResponse,
  HonuaRawRequest,
  HonuaRelatedRecordsResponse,
  HonuaRequestContext,
  HonuaRequestInterceptor,
  HonuaRequestMutation,
  HonuaResponseContext,
  HonuaRetryOptions,
  HonuaServerCapabilitiesResponse,
  HonuaServerCompatibility,
  HonuaServerCompatibilityFeature,
  HonuaServerCompatibilityStatus,
  HonuaServiceMetadata,
  HonuaServicesResponse,
  HonuaStacItemCollectionResponse,
  HonuaStacItemResponse,
  HonuaStacLandingResponse,
  HonuaTransport,
  MapFindRequest,
  MapIdentifyRequest,
  MapLayerQueryRequest,
  MapLegendRequest,
  MapRelatedRecordsRequest,
  MigrationInventoryScanRequest,
  MigrationSourceInventoryArtifact,
  OgcCollectionRequest,
  OgcCreateItemRequest,
  OgcDeleteItemRequest,
  OgcItemRequest,
  OgcItemsRequest,
  OgcMapImageRequest,
  OgcMetadataRequest,
  OgcPatchItemRequest,
  OgcProcessExecuteRequest,
  OgcRecordItemRequest,
  OgcRecordRawItemRequest,
  OgcRecordsRawSearchRequest,
  OgcRecordsSearchRequest,
  OgcReplaceItemRequest,
  OgcTileRequest,
  OgcTilesetRequest,
  OgcTilesetsRequest,
  QueryFeaturesRequest,
  QueryMethod,
  QueryRelatedRecordsRequest,
  StacSearchRequest,
} from "./types.js";
import { HonuaWfs } from "./wfs.js";
import { type WmsCapabilities, parseWmsCapabilities } from "./wms-capabilities.js";
import {
  type HonuaWmsFeatureInfoResponse,
  type HonuaWmsImageResponse,
  type HonuaWmtsFeatureInfoResponse,
  type HonuaWmtsTileResponse,
  type WmsFeatureInfoRequest,
  type WmsLegendRequest,
  type WmsMapRequest,
  type WmtsFeatureInfoRequest,
  type WmtsTileRequest,
  wmtsExtensionForFormat,
} from "./wms-types.js";
import { HonuaWms } from "./wms.js";
import { type WmtsCapabilities, parseWmtsCapabilities } from "./wmts-capabilities.js";
import { HonuaWmts } from "./wmts.js";

function normalizeBaseUrl(baseUrl: string): string {
  return trimTrailingSlashes(baseUrl);
}

function normalizePath(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  return path.startsWith("/") ? path : `/${path}`;
}

function isAbsoluteHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function resolveRequestUrl(baseUrl: string, path: string): string {
  if (isAbsoluteHttpUrl(path)) {
    if (!isAbsoluteHttpUrl(baseUrl)) {
      throw new Error("Absolute request URLs are not allowed when baseUrl is relative.");
    }
    const baseOrigin = new URL(baseUrl).origin;
    const requestUrl = new URL(path);
    if (requestUrl.origin !== baseOrigin) {
      throw new Error(`Cross-origin request URL is not allowed: ${path}`);
    }
    return requestUrl.toString();
  }
  return `${baseUrl}${path}`;
}

/**
 * The maximum number of HTTP redirects {@link HonuaClient.fetchWithSafeRedirects}
 * will follow before giving up. Mirrors the conventional browser/undici limit of 20.
 */
const MAX_SAFE_REDIRECTS = 20;

/**
 * HTTP status codes that represent a redirect carrying a `Location` header.
 */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Resolve a redirect `Location` (which may be relative) against the URL that
 * produced the redirect and assert it stays on the configured base origin.
 *
 * The SDK attaches the API key as a custom `X-API-Key` header. The Fetch/undici
 * runtime only strips `Authorization`/`Cookie`/`Host` on a cross-origin redirect,
 * so custom auth headers like `X-API-Key` would otherwise be replayed to an
 * attacker-controlled `Location` host. To prevent that credential disclosure we
 * never auto-follow redirects; we re-run the same origin guard used at request
 * construction and refuse to follow any redirect that leaves the base origin.
 *
 * @throws if the target origin differs from the base origin, or if the
 *   `Location` header is missing/unparsable.
 */
function resolveRedirectUrl(baseUrl: string, fromUrl: string, location: string | null): string {
  if (!location) {
    throw new Error("Redirect response is missing a Location header.");
  }
  let target: URL;
  try {
    target = new URL(location, fromUrl);
  } catch {
    throw new Error(`Redirect response has an invalid Location header: ${location}`);
  }
  // Re-run the base-origin guard against the redirect target so the API key is
  // never forwarded off the configured origin.
  return resolveRequestUrl(baseUrl, target.toString());
}

function normalizeInterceptorRequestUrl(baseUrl: string, url: string): string {
  if (isAbsoluteHttpUrl(url)) {
    return resolveRequestUrl(baseUrl, url);
  }

  if (!isAbsoluteHttpUrl(baseUrl)) {
    return url;
  }

  return resolveRequestUrl(baseUrl, normalizePath(url));
}

function normalizeOutFields(outFields: string | string[] | undefined): string {
  if (outFields === undefined) {
    return "*";
  }
  if (Array.isArray(outFields)) {
    return outFields.length > 0 ? outFields.join(",") : "";
  }
  return outFields;
}

function encodeFormValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function encodeDeletesValue(value: ApplyEditsRequest["deletes"]): string {
  if (Array.isArray(value)) {
    return value.join(",");
  }
  return String(value);
}

function normalizeBBox(bbox: ExportMapRequest["bbox"]): string {
  return Array.isArray(bbox) ? bbox.join(",") : bbox;
}

function normalizeSize(size: ExportMapRequest["size"]): string {
  return Array.isArray(size) ? size.join(",") : size;
}

function normalizeLegendSize(size: NonNullable<MapLegendRequest["size"]>): string {
  if (typeof size === "number") {
    return String(size);
  }
  if (Array.isArray(size)) {
    return size.join(",");
  }
  return size;
}

function normalizeIdentifyGeometry(geometry: MapIdentifyRequest["geometry"]): string {
  return typeof geometry === "string" ? geometry : JSON.stringify(geometry);
}

function normalizeMapExtent(mapExtent: MapIdentifyRequest["mapExtent"]): string {
  return Array.isArray(mapExtent) ? mapExtent.join(",") : mapExtent;
}

function normalizeImageDisplay(imageDisplay: MapIdentifyRequest["imageDisplay"]): string {
  return Array.isArray(imageDisplay) ? imageDisplay.join(",") : imageDisplay;
}

function normalizeSearchFields(searchFields: MapFindRequest["searchFields"]): string {
  if (!searchFields) {
    return "";
  }
  return Array.isArray(searchFields) ? searchFields.join(",") : searchFields;
}

interface NormalizedRetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryStatuses: ReadonlySet<number>;
}

const DEFAULT_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
const DEFAULT_RETRY_METHODS: ReadonlySet<QueryMethod> = new Set(["GET", "PUT", "DELETE"]);
const DEFAULT_AUTH_REFRESH_SKEW_MS = 60_000;
const DEFAULT_METADATA_CACHE_MAX_ENTRIES = 256;
const SUPPORTED_CONTROL_PLANE_API_MAJOR = 1;
const SUPPORTED_CONTROL_PLANE_API_BASE_PATH = "/api/v1/admin";
const MINIMUM_SUPPORTED_SERVER_RELEASE_CHANNEL = "preview";

export const HONUA_MINIMUM_SUPPORTED_SERVER_VERSION = "1.0.0";

interface NormalizedAuthProvider {
  getCredentials: HonuaAuthCredentialsProvider;
  revokeCredentials?: HonuaAuthProvider["revokeCredentials"];
}

interface CachedAuthCredentials {
  credentials: HonuaAuthCredentials;
  expiresAtMs: number | undefined;
}

interface MetadataCacheEntry<T = unknown> {
  body: T;
  cachedAtMs: number;
  keyFingerprint: string;
  validator?: HonuaCacheValidator;
  sourceUpdatedAt?: string;
}

/**
 * The main Honua HTTP/gRPC-Web client.
 *
 * `HonuaClient` is the protocol-aware entry point into the Honua server. It speaks
 * GeoServices (FeatureServer, MapServer, ImageServer, GeometryServer, GPServer),
 * OGC API Features / Tiles / Maps / Processes, STAC, WMS, WMTS, WFS 2.0, and OData v4,
 * with one consistent request/response shape, capability negotiation, optional retries,
 * pluggable auth, and a small in-process metadata cache.
 *
 * For cross-protocol code that does not need to know the underlying service shape,
 * prefer the protocol-neutral {@link createDataset} contract from `@honua/sdk-js/contract`
 * — it wraps this client and exposes a single `Source.query(...)` surface that throws
 * {@link HonuaCapabilityNotSupportedError} when a protocol cannot satisfy the request.
 *
 * @example Basic usage
 * ```ts
 * import { HonuaClient } from "@honua/sdk-js/honua";
 *
 * const client = new HonuaClient({
 *   baseUrl: "https://your-honua-server.example",
 *   apiKey: process.env.HONUA_API_KEY,
 * });
 *
 * const { supported, reasons } = await client.checkCompatibility();
 * if (!supported) {
 *   throw new Error(`Unsupported Honua server: ${reasons.join("; ")}`);
 * }
 *
 * const result = await client.queryFeatures({
 *   serviceId: "natural-earth",
 *   layerId: 0,
 *   where: "1=1",
 *   outFields: ["*"],
 *   returnGeometry: true,
 *   resultRecordCount: 25,
 * });
 *
 * console.log(`Loaded ${result.features?.length ?? 0} features`);
 * ```
 *
 * @example Per-service fluent wrappers
 * ```ts
 * const parcels = client.featureLayer<{ NAME: string }>("parcels", 0);
 * const items = await client.ogcFeatures();
 * const wms = client.wms("usgs-imagery");
 * ```
 *
 * @public
 */
export class HonuaClient {
  /** The minimum Honua server version this SDK is contractually tested against. */
  public static readonly minimumSupportedServerVersion = HONUA_MINIMUM_SUPPORTED_SERVER_VERSION;
  public static readonly minimumSupportedServerReleaseChannel = MINIMUM_SUPPORTED_SERVER_RELEASE_CHANNEL;

  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly defaultHeaders: HeadersInit;
  private readonly authProvider: NormalizedAuthProvider | undefined;
  private readonly authRefreshSkewMs: number;
  private readonly interceptors: readonly HonuaRequestInterceptor[];
  private readonly timeoutMs: number | undefined;
  private readonly retryOptions: NormalizedRetryOptions | undefined;
  private readonly preferBinary: boolean;
  private readonly transport: HonuaTransport;
  private serverCompatibilityCache: HonuaServerCompatibility | undefined;
  private authCredentialsCache: CachedAuthCredentials | undefined;
  private authRefreshPromise: Promise<CachedAuthCredentials | undefined> | undefined;
  private connectClient: Client<typeof FeatureService> | undefined;
  private readonly metadataCache = new Map<string, MetadataCacheEntry>();

  /**
   * Create a new `HonuaClient`.
   *
   * @param options - Connection, auth, transport, retry, and interceptor configuration.
   *   See {@link HonuaClientOptions} for every field and `@example` blocks for common shapes.
   *
   * @example Minimal
   * ```ts
   * const client = new HonuaClient({ baseUrl: "https://your-honua-server.example" });
   * ```
   *
   * @example With API key + retries + timeout
   * ```ts
   * const client = new HonuaClient({
   *   baseUrl: "https://your-honua-server.example",
   *   apiKey: process.env.HONUA_API_KEY,
   *   retry: { maxRetries: 3 },
   *   timeoutMs: 30_000,
   * });
   * ```
   */
  public constructor(options: HonuaClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    // Bind to `globalThis` at assignment: the default browser `fetch` is an
    // unbound `window.fetch`, and invoking it as `this.fetchFn(...)` rebinds
    // its receiver to the client instance, which browsers reject with
    // "TypeError: Illegal invocation". Binding is a no-op for Node's undici
    // fetch and for caller-supplied wrappers (arrow/bound functions ignore it).
    this.fetchFn = (options.fetchFn ?? fetch).bind(globalThis);

    const headers: Record<string, string> = {};
    if (options.apiKey) {
      headers["X-API-Key"] = options.apiKey;
    }
    if (options.bearerToken) {
      headers.Authorization = `Bearer ${options.bearerToken}`;
    }
    this.defaultHeaders = headers;
    this.authProvider = normalizeAuthProvider(options.auth);
    this.authRefreshSkewMs = normalizeAuthRefreshSkewMs(options.authRefreshSkewMs);
    this.interceptors = options.interceptors ?? [];
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    this.retryOptions = normalizeRetryOptions(options.retry);
    this.preferBinary = options.preferBinary === true;
    this.transport = options.transport ?? "rest";

    if (this.transport === "grpc-web") {
      this.initConnectClient();
    }
  }

  private initConnectClient(): void {
    // Dynamic imports are used to avoid bundling Connect dependencies
    // when only the REST transport is used. The imports are resolved
    // at module level since they are static ESM imports.
    import("@connectrpc/connect").then(({ createClient }) =>
      import("@connectrpc/connect-web").then(({ createGrpcWebTransport }) =>
        import("../gen/honua/v1/feature_service_pb.js").then(({ FeatureService }) => {
          const transport = createGrpcWebTransport({
            baseUrl: this.baseUrl,
            fetch: this.fetchFn,
          });
          this.connectClient = createClient(FeatureService, transport);
        }),
      ),
    );
  }

  private async ensureConnectClient(): Promise<Client<typeof FeatureService>> {
    if (this.connectClient) {
      return this.connectClient;
    }
    // If initConnectClient hasn't resolved yet, wait for it
    const { createClient } = await import("@connectrpc/connect");
    const { createGrpcWebTransport } = await import("@connectrpc/connect-web");
    const { FeatureService } = await import("../gen/honua/v1/feature_service_pb.js");
    const transport = createGrpcWebTransport({
      baseUrl: this.baseUrl,
      fetch: this.fetchFn,
    });
    this.connectClient = createClient(FeatureService, transport);
    return this.connectClient;
  }

  /**
   * Perform a fetch that never auto-follows a cross-origin redirect.
   *
   * Browsers/undici forward custom request headers (such as the SDK's
   * `X-API-Key`) across redirects, stripping only `Authorization`/`Cookie`/`Host`
   * cross-origin. To avoid leaking the API key to an attacker-supplied
   * `Location` host, this issues every request with `redirect: "manual"` and
   * only follows a redirect when its target origin still matches the configured
   * base origin (re-running the {@link resolveRequestUrl} origin guard).
   * Cross-origin redirects throw before the credentialed request is replayed.
   */
  private async fetchWithSafeRedirects(url: string, init: RequestInit): Promise<Response> {
    let currentUrl = url;
    let currentInit: RequestInit = init;
    for (let redirects = 0; ; redirects += 1) {
      const response = await this.fetchFn(currentUrl, { ...currentInit, redirect: "manual" });

      // `redirect: "manual"` surfaces redirects as status 3xx with a usable
      // `Location` header (and, in fetch, an "opaqueredirect" type with status 0
      // in some runtimes — treated as a same-origin-unverifiable redirect we
      // must refuse to follow blindly).
      if (response.type === "opaqueredirect") {
        throw new HonuaNetworkError(
          "Refusing to follow an opaque cross-origin redirect; the request's API key would be leaked to the redirect target.",
          undefined,
        );
      }

      if (!REDIRECT_STATUSES.has(response.status)) {
        return response;
      }

      if (redirects >= MAX_SAFE_REDIRECTS) {
        throw new HonuaNetworkError(`Exceeded the maximum of ${MAX_SAFE_REDIRECTS} redirects.`, undefined);
      }

      // Re-validate the redirect target against the base origin. A cross-origin
      // target throws here, so the API key is never replayed off-origin.
      const location = response.headers.get("location");
      const nextUrl = resolveRedirectUrl(this.baseUrl, currentUrl, location);

      // Apply the standard Fetch redirect method/body rewriting so the followed
      // (same-origin) request matches what the runtime would have done natively:
      // 303 always becomes GET; 301/302 turn a non-GET/HEAD into GET. The body
      // is dropped whenever the method changes to GET.
      const method = (currentInit.method ?? "GET").toUpperCase();
      const downgradeToGet =
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD");
      currentInit = downgradeToGet ? { ...currentInit, method: "GET", body: null } : currentInit;
      currentUrl = nextUrl;

      // Drain the redirect body so the underlying connection can be reused.
      await response.body?.cancel().catch(() => undefined);
    }
  }

  private static async loadGrpcAdapter() {
    return import("./grpc-adapter.js");
  }

  public get isGrpcWeb(): boolean {
    return this.transport === "grpc-web";
  }

  /**
   * Normalized base URL the client was constructed with (trailing slashes
   * trimmed). Helpers that build absolute URLs without going through
   * `request()` (e.g. tile URL generators) read this so they produce the
   * same origin and base path the server actually serves from.
   */
  public get serverBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Force-refresh credentials from the configured auth provider. The SDK
   * keeps the result in memory only; callers own durable and secure storage.
   */
  public async refreshAuthCredentials(
    reason: HonuaAuthRefreshReason = "manual",
  ): Promise<HonuaAuthCredentials | undefined> {
    const cached = await this.resolveAuthCredentials({
      forceRefresh: true,
      reason,
    });
    return cached?.credentials;
  }

  /** Drop cached provider credentials without calling a revocation endpoint. */
  public clearAuthCredentials(): void {
    this.authCredentialsCache = undefined;
  }

  /**
   * Revoke the currently cached credentials through the provider, when it
   * exposes a revocation hook, then clear the SDK's in-memory cache.
   */
  public async revokeAuthCredentials(context: HonuaAuthRevocationContext = { reason: "manual" }): Promise<void> {
    const cached = this.authCredentialsCache;
    this.authCredentialsCache = undefined;
    if (cached && this.authProvider?.revokeCredentials) {
      await this.authProvider.revokeCredentials(cached.credentials, context);
    }
  }

  /**
   * Drive a paginated FeatureServer query as an async generator. Each yielded
   * chunk is a `HonuaFeature[]` slice; iteration stops when the server stops
   * advertising `exceededTransferLimit`. Lower-level than
   * `dataset.source(...).queryAll()` but suitable for streaming pipelines that
   * want backpressure between pages.
   *
   * @example
   * ```ts
   * for await (const page of client.queryFeaturesStream({ serviceId: "parcels", layerId: 0, where: "1=1" })) {
   *   process(page);
   * }
   * ```
   */
  public async *queryFeaturesStream(request: QueryFeaturesRequest): AsyncGenerator<HonuaFeature[], void, undefined> {
    const client = await this.ensureConnectClient();
    const grpcAdapter = await HonuaClient.loadGrpcAdapter();
    const protoRequest = grpcAdapter.toProtoQueryRequest(request);
    yield* grpcAdapter.streamProtoPages(client.queryFeaturesStream(protoRequest));
  }

  public service(serviceId: string): HonuaService {
    return new HonuaService({
      client: this,
      serviceId,
    });
  }

  /**
   * Construct a typed wrapper for a single FeatureServer layer.
   *
   * The returned {@link HonuaFeatureLayer} carries the same `serviceId` / `layerId`
   * on every call so you can write `await layer.queryFeatures({ where: "..." })`
   * without restating the address.
   *
   * @typeParam T - The attribute shape of features in this layer.
   *
   * @example
   * ```ts
   * const parcels = client.featureLayer<{ NAME: string; STATUS: string }>("parcels", 0);
   * const { features } = await parcels.queryFeatures({ where: "STATUS = 'ACTIVE'" });
   * ```
   */
  public featureLayer<T = Record<string, unknown>>(serviceId: string, layerId: number): HonuaFeatureLayer<T> {
    return new HonuaFeatureLayer<T>({
      client: this,
      serviceId,
      layerId,
    });
  }

  public mapService(serviceId: string): HonuaMapService {
    return new HonuaMapService({
      client: this,
      serviceId,
    });
  }

  public mapLayer(serviceId: string, layerId: number): HonuaMapLayer {
    return new HonuaMapLayer({
      client: this,
      serviceId,
      layerId,
    });
  }

  /**
   * Construct the OGC API Features client wrapper.
   *
   * Use this to walk collections (`landing()`, `conformance()`, `collections()`),
   * read items (`items()`, `item()`), and apply edits (`create*` / `replace*` /
   * `patch*` / `delete*`) against an OGC API Features endpoint exposed by the
   * Honua server.
   *
   * @example
   * ```ts
   * const features = client.ogcFeatures();
   * const collections = await features.collections();
   * const items = await features.items("parcels", { limit: 100 });
   * ```
   */
  public ogcFeatures(): HonuaOgcFeatures {
    return new HonuaOgcFeatures({
      client: this,
    });
  }

  public ogcTiles(): HonuaOgcTiles {
    return new HonuaOgcTiles({ client: this });
  }

  public ogcMaps(): HonuaOgcMaps {
    return new HonuaOgcMaps({ client: this });
  }

  public ogcRecords(): HonuaOgcRecords {
    return new HonuaOgcRecords({ client: this });
  }

  public wms(serviceId: string): HonuaWms {
    return new HonuaWms({ client: this, serviceId });
  }

  public wmts(serviceId: string): HonuaWmts {
    return new HonuaWmts({ client: this, serviceId });
  }

  public ogcProcesses(): HonuaOgcProcesses {
    return new HonuaOgcProcesses({ client: this });
  }

  public stac(): HonuaStacSearch {
    return new HonuaStacSearch({ client: this });
  }

  public imageService(serviceId: string): HonuaImageService {
    return new HonuaImageService({ client: this, serviceId });
  }

  public geometryService(): HonuaGeometryService {
    return new HonuaGeometryService({ client: this });
  }

  public geoprocessing(serviceId: string, taskName?: string): HonuaGeoprocessingService {
    return new HonuaGeoprocessingService({ client: this, serviceId, taskName });
  }

  public processRunner(adapter: HonuaProcessAdapter): HonuaProcessRunner {
    return createHonuaProcessRunner(adapter);
  }

  public ogcProcessRunner(): HonuaProcessRunner {
    return createHonuaProcessRunner(createOgcProcessesAdapter(this.ogcProcesses()));
  }

  public geoprocessingRunner(serviceId: string, taskName?: string): HonuaProcessRunner {
    return createHonuaProcessRunner(createGeoServicesGpAdapter(this.geoprocessing(serviceId, taskName)));
  }

  public geospatialGrpcProcessRunner(processClient: GeospatialGrpcProcessClient): HonuaProcessRunner {
    return createHonuaProcessRunner(createGeospatialGrpcProcessAdapter(processClient));
  }

  public wfs(endpointUrl = "/wfs", options: { version?: string } = {}): HonuaWfs {
    return new HonuaWfs({ client: this, endpointUrl, version: options.version });
  }

  public odata(entitySet: string, options: { basePath?: string } = {}): HonuaOdataEntitySet {
    return new HonuaOdataEntitySet({ client: this, entitySet, basePath: options.basePath });
  }

  public clearMetadataCache(options: { keyPrefix?: string } = {}): void {
    if (!options.keyPrefix) {
      this.metadataCache.clear();
      return;
    }
    const prefix = `metadata:${options.keyPrefix}`;
    for (const key of this.metadataCache.keys()) {
      if (key.startsWith(prefix)) {
        this.metadataCache.delete(key);
      }
    }
  }

  public async listServices(
    formatOrOptions: "json" | "pjson" | HonuaMetadataRequestOptions = "json",
    options: HonuaMetadataRequestOptions = {},
  ): Promise<HonuaServicesResponse> {
    const format = typeof formatOrOptions === "string" ? formatOrOptions : "json";
    const metadataOptions = typeof formatOrOptions === "string" ? options : formatOrOptions;
    const query = new URLSearchParams({ f: format });
    const path = `/rest/services?${query.toString()}`;
    return this.requestCachedMetadataJson<HonuaServicesResponse>(
      `geoservices:services:${format}`,
      path,
      metadataOptions,
    );
  }

  /**
   * Fetch and parse the server's compatibility contract from `GET /api/v1/admin/capabilities`.
   *
   * The first call populates an in-process cache; subsequent calls return the cached value
   * unless `options.refresh` is `true`. Use {@link HonuaClient.checkCompatibility} instead
   * when you want a non-throwing pass/fail signal with a list of reasons.
   *
   * @throws {@link HonuaError} when the server response cannot be parsed into a valid
   *   compatibility envelope (missing `serverVersion`, `controlPlaneApi`, etc.).
   *
   * @example
   * ```ts
   * const contract = await client.getCompatibility();
   * console.log(contract.serverVersion, contract.releaseChannel);
   * console.log(contract.metadataSchemas);
   * ```
   */
  public async getCompatibility(options: HonuaCompatibilityRequest = {}): Promise<HonuaServerCompatibility> {
    if (!options.refresh && this.serverCompatibilityCache) {
      return this.serverCompatibilityCache;
    }

    const response = (await this.requestJson(
      "GET",
      "/api/v1/admin/capabilities",
      undefined,
      options.signal,
    )) as HonuaApiEnvelope<HonuaServerCapabilitiesResponse>;

    const compatibility = parseCompatibilityEnvelope(response);
    this.serverCompatibilityCache = compatibility;
    return compatibility;
  }

  /**
   * Probe the server's compatibility contract and return a structured pass/fail status.
   *
   * Unlike {@link HonuaClient.getCompatibility}, this method does not throw on transport
   * or parse failures — those are reported as `supported: false` with a human-readable
   * `reasons` entry. Use this at app startup to fail loudly before exercising admin or
   * control-plane flows.
   *
   * @example
   * ```ts
   * const { supported, reasons } = await client.checkCompatibility();
   * if (!supported) {
   *   throw new Error(`Unsupported Honua server: ${reasons.join("; ")}`);
   * }
   * ```
   */
  public async checkCompatibility(options: HonuaCompatibilityRequest = {}): Promise<HonuaServerCompatibilityStatus> {
    try {
      const compatibility = await this.getCompatibility(options);
      const reasons = evaluateCompatibility(compatibility);
      return {
        supported: reasons.length === 0,
        minimumSupportedServerVersion: HonuaClient.minimumSupportedServerVersion,
        compatibility,
        reasons,
      };
    } catch (error) {
      return {
        supported: false,
        minimumSupportedServerVersion: HonuaClient.minimumSupportedServerVersion,
        reasons: [describeCompatibilityError(error)],
      };
    }
  }

  /**
   * Returns `true` if the server's `data.compatibility.features` map advertises the
   * given coarse capability. Use this to gate experimental or admin-only workflows.
   *
   * @example
   * ```ts
   * if (await client.supportsFeature("manifestApply")) {
   *   // safe to call the manifest apply admin endpoint
   * }
   * ```
   */
  public async supportsFeature(
    feature: HonuaServerCompatibilityFeature,
    options: HonuaCompatibilityRequest = {},
  ): Promise<boolean> {
    const compatibility = await this.getCompatibility(options);
    return compatibility.features[feature];
  }

  /**
   * Scan a supported migration source through the admin import scanner.
   *
   * A successful HTTP response means the server returned a deterministic
   * inventory artifact; callers still need to inspect
   * `scanCompleteness.status`, which can be `"failed"` on `200 OK`.
   */
  public async scanMigrationSource(request: MigrationInventoryScanRequest): Promise<MigrationSourceInventoryArtifact> {
    const { signal, exportJson, ...body } = request;
    const path = `/api/v1/admin/import/scan${exportJson ? "?export=json" : ""}`;
    return this.requestJson(
      "POST",
      path,
      {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      signal,
    ) as Promise<MigrationSourceInventoryArtifact>;
  }

  public async request<T = unknown>(request: HonuaRawRequest): Promise<T> {
    const method: QueryMethod = request.method ?? "GET";
    const params = new URLSearchParams();
    params.set("f", request.responseFormat ?? "json");
    if (request.query) {
      for (const [key, value] of Object.entries(request.query)) {
        params.set(key, String(value));
      }
    }

    const normalizedPath = normalizePath(request.path);
    const pathWithQuery = mergePathWithQueryParams(normalizedPath, params);
    return this.requestJson(
      method,
      pathWithQuery,
      {
        headers: request.headers,
        body: request.body,
      },
      request.signal,
    ) as Promise<T>;
  }

  /**
   * Pipeline-aware JSON request that bypasses the GeoServices `f=json`
   * convention used by {@link request}. Adapters whose protocols do not
   * model `f=` (OData, OGC API, …) call this directly so they keep the
   * shared auth / retry / timeout / interceptor pipeline without sending
   * a query parameter the server would reject as `InvalidQueryOption`.
   *
   * Caller-supplied query parameters belong on `path` itself; `init`
   * carries the body, headers, and abort signal. The default `Accept`
   * header is `application/json`; pass an explicit `Accept` in
   * `init.headers` to override.
   */
  public async pipelineRequestJson<T = unknown>(
    method: QueryMethod,
    path: string,
    init?: { headers?: HeadersInit; body?: BodyInit | null },
    signal?: AbortSignal,
  ): Promise<T> {
    return this.requestJson(method, path, init, signal) as Promise<T>;
  }

  private async composeHeaders(...headersList: Array<HeadersInit | undefined>): Promise<Record<string, string>> {
    const authHeaders = await this.resolveAuthHeaders();
    return mergeHeaders(this.defaultHeaders, authHeaders, ...headersList);
  }

  private async resolveAuthHeaders(): Promise<Record<string, string> | undefined> {
    const cached = await this.resolveAuthCredentials({ forceRefresh: false });
    if (!cached) return undefined;
    return authHeadersFromCredentials(cached.credentials);
  }

  private async resolveAuthCredentials(options: {
    forceRefresh: boolean;
    reason?: HonuaAuthRefreshReason;
  }): Promise<CachedAuthCredentials | undefined> {
    if (!this.authProvider) {
      return undefined;
    }

    const cached = this.authCredentialsCache;
    if (!options.forceRefresh && cached && !isAuthCredentialsExpiring(cached, this.authRefreshSkewMs)) {
      return cached;
    }

    if (this.authRefreshPromise) {
      return this.authRefreshPromise;
    }

    const reason = options.reason ?? resolveAuthRefreshReason(cached);
    this.authRefreshPromise = this.loadAuthCredentials(reason, options.forceRefresh, cached?.credentials);
    try {
      return await this.authRefreshPromise;
    } finally {
      this.authRefreshPromise = undefined;
    }
  }

  private async loadAuthCredentials(
    reason: HonuaAuthRefreshReason,
    forceRefresh: boolean,
    previousCredentials: HonuaAuthCredentials | undefined,
  ): Promise<CachedAuthCredentials | undefined> {
    const credentials = normalizeAuthCredentials(
      await this.authProvider?.getCredentials({
        reason,
        forceRefresh,
        ...(previousCredentials ? { previousCredentials } : {}),
      }),
    );

    if (!credentials) {
      this.authCredentialsCache = undefined;
      return undefined;
    }

    const cached = {
      credentials,
      expiresAtMs: normalizeAuthExpiresAtMs(credentials.expiresAt),
    } satisfies CachedAuthCredentials;
    this.authCredentialsCache = cached;
    return cached;
  }

  /**
   * Pipeline-aware request that returns the raw `Response` after the
   * shared auth / retry / timeout / interceptor pipeline finishes
   * successfully. Used by adapters that need to consume non-JSON bodies
   * (OData `$metadata` XML, raw passthrough) without inheriting the
   * `Accept: application/json` default of {@link pipelineRequestJson}.
   *
   * The returned `Response` is unconsumed — the caller picks `.json()`,
   * `.text()`, or `.arrayBuffer()`. Non-2xx responses still throw the
   * normalized `HonuaHttpError` (and trigger retries) so error handling
   * matches every other client method.
   */
  public async pipelineFetch(
    method: QueryMethod,
    path: string,
    init?: RequestInit,
    callerSignal?: AbortSignal,
    options: { okStatuses?: readonly number[] } = {},
  ): Promise<Response> {
    let request: HonuaRequestContext = {
      url: resolveRequestUrl(this.baseUrl, path),
      path,
      method,
      init: {
        method,
        headers: await this.composeHeaders(init?.headers),
        body: init?.body ?? null,
        ...(init?.signal ? { signal: init.signal } : {}),
      },
    };

    request = await this.applyBeforeInterceptors(request);
    const retrySignal = callerSignal ?? request.init.signal ?? undefined;
    let refreshedAuth = false;

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      const timeout = createTimeoutSignal(callerSignal ?? request.init.signal, this.timeoutMs);
      const startTime = performance.now();
      try {
        response = await this.fetchWithSafeRedirects(request.url, {
          ...request.init,
          method: request.method,
          signal: timeout.signal,
        });
      } catch (error) {
        const durationMs = performance.now() - startTime;
        const normalizedError = timeout.didTimeout
          ? new HonuaTimeoutError(this.timeoutMs ?? 0)
          : normalizeNetworkError(error);
        if (this.shouldRetryRequest(request.method, attempt, undefined, normalizedError)) {
          await this.sleepBeforeRetry(attempt, undefined, retrySignal);
          continue;
        }
        await this.applyErrorInterceptors({
          request: cloneRequestContext(request),
          error: normalizedError,
          durationMs,
        });
        throw normalizedError;
      } finally {
        timeout.dispose();
      }
      const durationMs = performance.now() - startTime;

      if (!response.ok && !options.okStatuses?.includes(response.status)) {
        const body = await parseResponseBody(response.clone());
        const httpError = this.toHttpError(response.status, body);
        const authRefreshedRequest = refreshedAuth
          ? undefined
          : await this.refreshReplaySafeRequestAuth(request, response.status);
        if (authRefreshedRequest) {
          request = authRefreshedRequest;
          refreshedAuth = true;
          continue;
        }
        if (this.shouldRetryRequest(request.method, attempt, response.status, httpError)) {
          await this.sleepBeforeRetry(attempt, response, retrySignal);
          continue;
        }
        await this.applyErrorInterceptors({ request: cloneRequestContext(request), error: httpError, durationMs });
        throw httpError;
      }

      try {
        await this.applyAfterInterceptors(cloneRequestContext(request), response, durationMs);
      } catch (error) {
        await this.applyErrorInterceptors({ request: cloneRequestContext(request), error, durationMs });
        throw error;
      }

      return response;
    }
  }

  private async requestCachedMetadataJson<T>(
    cacheKey: string,
    path: string,
    options: HonuaMetadataRequestOptions = {},
  ): Promise<T> {
    const metadataOptions = normalizeHonuaMetadataRequestOptions(options);
    const keyFingerprint = `metadata:${cacheKey}`;
    const cached = this.metadataCache.get(keyFingerprint) as MetadataCacheEntry<T> | undefined;
    const bypass = metadataOptions.cache === "bypass";
    const now = Date.now();
    const freshCachedEntry = cached ? isHonuaCacheEntryFresh(cached.cachedAtMs, now, metadataOptions.ttlMs) : false;

    if (!bypass && !metadataOptions.refresh && cached && freshCachedEntry) {
      return withHonuaCacheState(
        cached.body,
        createMetadataCacheState(cached, "hit", {
          now,
          ttlMs: metadataOptions.ttlMs,
          staleIfErrorMs: metadataOptions.staleIfErrorMs,
        }),
      );
    }

    let request: HonuaRequestContext = {
      url: resolveRequestUrl(this.baseUrl, path),
      path,
      method: "GET",
      init: {
        method: "GET",
        headers: await this.composeHeaders(
          honuaMetadataRequestHeaders({
            accept: "application/json",
            refresh: metadataOptions.refresh || Boolean(cached),
            bypass,
            validator: cached?.validator,
          }),
        ),
      },
    };

    request = await this.applyBeforeInterceptors(request);
    const retrySignal = metadataOptions.signal ?? request.init.signal ?? undefined;
    let refreshedAuth = false;

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      const timeout = createTimeoutSignal(metadataOptions.signal ?? request.init.signal, this.timeoutMs);
      const startTime = performance.now();
      try {
        response = await this.fetchWithSafeRedirects(request.url, {
          ...request.init,
          method: request.method,
          signal: timeout.signal,
        });
      } catch (error) {
        const durationMs = performance.now() - startTime;
        const normalizedError = timeout.didTimeout
          ? new HonuaTimeoutError(this.timeoutMs ?? 0)
          : normalizeNetworkError(error);
        if (this.shouldRetryRequest(request.method, attempt, undefined, normalizedError)) {
          await this.sleepBeforeRetry(attempt, undefined, retrySignal);
          continue;
        }
        const stale = this.staleMetadataFallback(cached, metadataOptions, normalizedError);
        if (stale) return stale;
        await this.applyErrorInterceptors({
          request: cloneRequestContext(request),
          error: normalizedError,
          durationMs,
        });
        throw normalizedError;
      } finally {
        timeout.dispose();
      }
      const durationMs = performance.now() - startTime;

      if (response.status === 304 && cached && !bypass) {
        try {
          await this.applyAfterInterceptors(cloneRequestContext(request), response, durationMs);
        } catch (error) {
          await this.applyErrorInterceptors({ request: cloneRequestContext(request), error, durationMs });
          throw error;
        }
        const updatedEntry: MetadataCacheEntry<T> = {
          ...cached,
          cachedAtMs: Date.now(),
          ...((honuaCacheValidatorFromHeaders(response.headers) ?? cached.validator)
            ? { validator: honuaCacheValidatorFromHeaders(response.headers) ?? cached.validator }
            : {}),
        };
        this.setMetadataCacheEntry(keyFingerprint, updatedEntry);
        return withHonuaCacheState(
          updatedEntry.body,
          createMetadataCacheState(updatedEntry, "refreshed", {
            now: Date.now(),
            ttlMs: metadataOptions.ttlMs,
            staleIfErrorMs: metadataOptions.staleIfErrorMs,
            revalidatedAt: new Date().toISOString(),
          }),
        );
      }

      const body = await parseResponseBody(response.clone());
      if (!response.ok) {
        const httpError = this.toHttpError(response.status, body);
        const authRefreshedRequest = refreshedAuth
          ? undefined
          : await this.refreshReplaySafeRequestAuth(request, response.status);
        if (authRefreshedRequest) {
          request = authRefreshedRequest;
          refreshedAuth = true;
          continue;
        }
        if (this.shouldRetryRequest(request.method, attempt, response.status, httpError)) {
          await this.sleepBeforeRetry(attempt, response, retrySignal);
          continue;
        }
        const stale = this.staleMetadataFallback(cached, metadataOptions, httpError);
        if (stale) return stale;
        await this.applyErrorInterceptors({ request: cloneRequestContext(request), error: httpError, durationMs });
        throw httpError;
      }

      try {
        await this.applyAfterInterceptors(cloneRequestContext(request), response, durationMs);
      } catch (error) {
        await this.applyErrorInterceptors({ request: cloneRequestContext(request), error, durationMs });
        throw error;
      }

      const cleanBody = withoutHonuaCacheState(body) as T;
      const validator = honuaCacheValidatorFromHeaders(response.headers);
      const sourceUpdatedAt = response.headers.get("last-modified") ?? undefined;
      const entry: MetadataCacheEntry<T> = {
        body: cleanBody,
        cachedAtMs: Date.now(),
        keyFingerprint,
        ...(validator ? { validator } : {}),
        ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
      };
      const status = bypass ? "bypass" : cached ? "refreshed" : "miss";
      if (!bypass) {
        this.setMetadataCacheEntry(keyFingerprint, entry);
      }
      return withHonuaCacheState(
        cleanBody,
        createMetadataCacheState(entry, status, {
          now: Date.now(),
          ttlMs: metadataOptions.ttlMs,
          staleIfErrorMs: metadataOptions.staleIfErrorMs,
          ...(status === "refreshed" ? { revalidatedAt: new Date().toISOString() } : {}),
        }),
      );
    }
  }

  private staleMetadataFallback<T>(
    cached: MetadataCacheEntry<T> | undefined,
    options: ReturnType<typeof normalizeHonuaMetadataRequestOptions>,
    error: unknown,
  ): T | undefined {
    if (!cached || options.cache === "bypass" || !options.staleIfError) {
      return undefined;
    }
    const staleIfErrorMs = options.staleIfErrorMs ?? HONUA_DEFAULT_METADATA_STALE_IF_ERROR_MS;
    if (Date.now() - cached.cachedAtMs > staleIfErrorMs) {
      return undefined;
    }
    return withHonuaCacheState(
      cached.body,
      createMetadataCacheState(cached, "stale", {
        now: Date.now(),
        ttlMs: options.ttlMs,
        staleIfErrorMs: options.staleIfErrorMs,
        refreshErrorId: metadataRefreshErrorId(error),
      }),
    );
  }

  private setMetadataCacheEntry<T>(key: string, entry: MetadataCacheEntry<T>): void {
    this.metadataCache.set(key, entry);
    while (this.metadataCache.size > DEFAULT_METADATA_CACHE_MAX_ENTRIES) {
      const oldest = [...this.metadataCache.entries()].sort((a, b) => a[1].cachedAtMs - b[1].cachedAtMs)[0];
      if (!oldest) return;
      this.metadataCache.delete(oldest[0]);
    }
  }

  public async getLayerMetadata(
    serviceId: string,
    layerId: number,
    options: HonuaMetadataRequestOptions = {},
  ): Promise<HonuaLayerMetadata> {
    const query = new URLSearchParams({ f: "json" });
    const path = `/rest/services/${encodeServiceIdPath(serviceId)}/FeatureServer/${layerId}?${query.toString()}`;
    return this.requestCachedMetadataJson<HonuaLayerMetadata>(
      `geoservices-feature:${serviceId}:${layerId}`,
      path,
      options,
    );
  }

  public async getFeatureServiceMetadata(
    serviceId: string,
    options: HonuaMetadataRequestOptions = {},
  ): Promise<HonuaServiceMetadata> {
    const query = new URLSearchParams({ f: "json" });
    const path = `/rest/services/${encodeServiceIdPath(serviceId)}/FeatureServer?${query.toString()}`;
    return this.requestCachedMetadataJson<HonuaServiceMetadata>(
      `geoservices-feature:${serviceId}:service`,
      path,
      options,
    );
  }

  public async getOgcFeaturesLanding(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcLandingResponse>(
      `ogc-features:landing:${params.toString()}`,
      `/ogc/features?${params.toString()}`,
      request,
    );
  }

  public async getOgcFeaturesConformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcConformanceResponse>(
      `ogc-features:conformance:${params.toString()}`,
      `/ogc/features/conformance?${params.toString()}`,
      request,
    );
  }

  public async listOgcCollections(request: OgcMetadataRequest = {}): Promise<HonuaOgcCollectionsResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcCollectionsResponse>(
      `ogc-features:collections:${params.toString()}`,
      `/ogc/features/collections?${params.toString()}`,
      request,
    );
  }

  public async getOgcCollection(request: OgcCollectionRequest): Promise<HonuaOgcCollectionMetadata> {
    const params = createOgcMetadataParams(request);
    const path = `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}`;
    return this.requestCachedMetadataJson<HonuaOgcCollectionMetadata>(
      `ogc-features:collection:${request.collectionId}:${params.toString()}`,
      `${path}?${params.toString()}`,
      request,
    );
  }

  public async getOgcQueryables(request: OgcCollectionRequest): Promise<HonuaOgcQueryablesResponse> {
    const params = createOgcMetadataParams(request);
    const path = `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}/queryables`;
    return this.requestCachedMetadataJson<HonuaOgcQueryablesResponse>(
      `ogc-features:queryables:${request.collectionId}:${params.toString()}`,
      `${path}?${params.toString()}`,
      request,
    );
  }

  public async listOgcItems(request: OgcItemsRequest): Promise<HonuaOgcFeatureCollectionResponse> {
    const params = createOgcMetadataParams(request);
    if (request.limit !== undefined) {
      params.set("limit", String(request.limit));
    }
    if (request.offset !== undefined) {
      params.set("offset", String(request.offset));
    }
    if (request.bbox !== undefined) {
      params.set("bbox", request.bbox);
    }
    if (request.datetime !== undefined) {
      params.set("datetime", request.datetime);
    }
    if (request.filter !== undefined) {
      params.set("filter", request.filter);
    }
    if (request.ids !== undefined) {
      params.set("ids", normalizeCsv(request.ids));
    }
    if (request.properties !== undefined) {
      params.set("properties", normalizeCsv(request.properties));
    }
    if (request.sortby !== undefined) {
      params.set("sortby", request.sortby);
    }
    if (request.crs !== undefined) {
      params.set("crs", request.crs);
    }
    const path = `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}/items`;
    return this.requestJson(
      "GET",
      `${path}?${params.toString()}`,
      undefined,
      request.signal,
    ) as Promise<HonuaOgcFeatureCollectionResponse>;
  }

  public async getOgcItem(request: OgcItemRequest): Promise<HonuaOgcFeatureResponse> {
    const params = createOgcMetadataParams(request);
    if (request.crs !== undefined) {
      params.set("crs", request.crs);
    }
    const path =
      `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}` +
      `/items/${encodeURIComponent(String(request.featureId))}`;
    return this.requestJson(
      "GET",
      `${path}?${params.toString()}`,
      undefined,
      request.signal,
    ) as Promise<HonuaOgcFeatureResponse>;
  }

  public async createOgcItem(request: OgcCreateItemRequest): Promise<HonuaOgcFeatureResponse> {
    const params = createOgcMetadataParams(request);
    const path = `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}/items`;
    return this.requestJson(
      "POST",
      `${path}?${params.toString()}`,
      {
        headers: mergeHeaders({ "Content-Type": "application/geo+json" }, request.headers),
        body: JSON.stringify(request.feature),
      },
      request.signal,
    ) as Promise<HonuaOgcFeatureResponse>;
  }

  public async replaceOgcItem(request: OgcReplaceItemRequest): Promise<HonuaOgcFeatureResponse> {
    const params = createOgcMetadataParams(request);
    if (request.crs !== undefined) {
      params.set("crs", request.crs);
    }
    const path =
      `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}` +
      `/items/${encodeURIComponent(String(request.featureId))}`;
    return this.requestJson(
      "PUT",
      `${path}?${params.toString()}`,
      {
        headers: mergeHeaders({ "Content-Type": "application/geo+json" }, request.headers),
        body: JSON.stringify(request.feature),
      },
      request.signal,
    ) as Promise<HonuaOgcFeatureResponse>;
  }

  public async patchOgcItem(request: OgcPatchItemRequest): Promise<HonuaOgcFeatureResponse> {
    const params = createOgcMetadataParams(request);
    if (request.crs !== undefined) {
      params.set("crs", request.crs);
    }
    const path =
      `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}` +
      `/items/${encodeURIComponent(String(request.featureId))}`;
    return this.requestJson(
      "PATCH",
      `${path}?${params.toString()}`,
      {
        headers: mergeHeaders({ "Content-Type": "application/merge-patch+json" }, request.headers),
        body: JSON.stringify(request.patch),
      },
      request.signal,
    ) as Promise<HonuaOgcFeatureResponse>;
  }

  public async deleteOgcItem(request: OgcDeleteItemRequest): Promise<void> {
    const params = createOgcMetadataParams(request);
    if (request.crs !== undefined) {
      params.set("crs", request.crs);
    }
    const path =
      `/ogc/features/collections/${encodeURIComponent(String(request.collectionId))}` +
      `/items/${encodeURIComponent(String(request.featureId))}`;
    await this.requestJson("DELETE", `${path}?${params.toString()}`, undefined, request.signal);
  }

  // ── OGC API Tiles ───────────────────────────────────────────

  public async getOgcTilesLanding(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcLandingResponse>(
      `ogc-tiles:landing:${params.toString()}`,
      `/ogc/tiles?${params.toString()}`,
      request,
    );
  }

  public async getOgcTilesConformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcConformanceResponse>(
      `ogc-tiles:conformance:${params.toString()}`,
      `/ogc/tiles/conformance?${params.toString()}`,
      request,
    );
  }

  public async listOgcTileMatrixSets(request: OgcMetadataRequest = {}): Promise<HonuaOgcTileMatrixSetsResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcTileMatrixSetsResponse>(
      `ogc-tiles:tile-matrix-sets:${params.toString()}`,
      `/ogc/tiles/tileMatrixSets?${params.toString()}`,
      request,
    );
  }

  public async getOgcTileMatrixSet(
    request: {
      tileMatrixSetId: string;
      responseFormat?: string;
      extraParams?: Record<string, string | number | boolean>;
    } & HonuaMetadataRequestOptions,
  ): Promise<HonuaOgcTileMatrixSet> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcTileMatrixSet>(
      `ogc-tiles:tile-matrix-set:${request.tileMatrixSetId}:${params.toString()}`,
      `/ogc/tiles/tileMatrixSets/${encodeURIComponent(request.tileMatrixSetId)}?${params.toString()}`,
      request,
    );
  }

  public async listOgcCollectionTilesets(request: OgcTilesetsRequest): Promise<HonuaOgcTilesetsResponse> {
    const params = createOgcMetadataParams(request);
    const path = `/ogc/tiles/collections/${encodeURIComponent(String(request.collectionId))}/tiles`;
    return this.requestCachedMetadataJson<HonuaOgcTilesetsResponse>(
      `ogc-tiles:tilesets:${request.collectionId}:${params.toString()}`,
      `${path}?${params.toString()}`,
      request,
    );
  }

  public async getOgcCollectionTileset(request: OgcTilesetRequest): Promise<HonuaOgcTilesetMetadata> {
    const params = createOgcMetadataParams(request);
    const path =
      `/ogc/tiles/collections/${encodeURIComponent(String(request.collectionId))}` +
      `/tiles/${encodeURIComponent(request.tileMatrixSetId)}`;
    return this.requestCachedMetadataJson<HonuaOgcTilesetMetadata>(
      `ogc-tiles:tileset:${request.collectionId}:${request.tileMatrixSetId}:${params.toString()}`,
      `${path}?${params.toString()}`,
      request,
    );
  }

  public async fetchOgcTile(request: OgcTileRequest): Promise<HonuaOgcTileResponse> {
    const params = new URLSearchParams();
    if (request.extraParams) {
      for (const [key, value] of Object.entries(request.extraParams)) {
        params.set(key, String(value));
      }
    }
    const collection = encodeURIComponent(String(request.collectionId));
    const matrixSet = encodeURIComponent(request.tileMatrixSetId);
    const matrix = encodeURIComponent(String(request.tileMatrix));
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const path = `/ogc/tiles/collections/${collection}/tiles/${matrixSet}/${matrix}/${request.tileRow}/${request.tileCol}${query}`;
    return this.requestBytes("GET", path, request.accept, undefined, request.signal);
  }

  // ── OGC API Maps ────────────────────────────────────────────

  public async getOgcMapsLanding(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcLandingResponse>(
      `ogc-maps:landing:${params.toString()}`,
      `/ogc/maps?${params.toString()}`,
      request,
    );
  }

  public async getOgcMapsConformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcConformanceResponse>(
      `ogc-maps:conformance:${params.toString()}`,
      `/ogc/maps/conformance?${params.toString()}`,
      request,
    );
  }

  public async getOgcMapImage(request: OgcMapImageRequest): Promise<HonuaOgcMapImageResponse> {
    const params = serializeOgcMapImageParams(request);
    const collectionPart =
      request.collectionId !== undefined ? `/collections/${encodeURIComponent(String(request.collectionId))}` : "";
    const stylePart = request.styleId ? `/styles/${encodeURIComponent(request.styleId)}` : "";
    const path = `/ogc/maps${collectionPart}${stylePart}/map${params.size > 0 ? `?${params.toString()}` : ""}`;
    const accept = ogcMapAcceptHeader(request.format) ?? "image/png";
    const response = await this.requestBytes("GET", path, accept, undefined, request.signal);
    return { bytes: response.bytes, contentType: response.contentType };
  }

  // ── OGC API Records ────────────────────────────────────────

  public async getOgcRecordsLanding(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcLandingResponse>(
      `ogc-records:landing:${params.toString()}`,
      `/ogc/records?${params.toString()}`,
      request,
    );
  }

  public async getOgcRecordsConformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcConformanceResponse>(
      `ogc-records:conformance:${params.toString()}`,
      `/ogc/records/conformance?${params.toString()}`,
      request,
    );
  }

  public async listOgcRecordCollections(request: OgcMetadataRequest = {}): Promise<HonuaOgcCollectionsResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcCollectionsResponse>(
      `ogc-records:collections:${params.toString()}`,
      `/ogc/records/collections?${params.toString()}`,
      request,
    );
  }

  public async getOgcRecordCollection(request: OgcCollectionRequest): Promise<HonuaOgcCollectionMetadata> {
    const params = createOgcMetadataParams(request);
    const path = `/ogc/records/collections/${encodeURIComponent(String(request.collectionId))}`;
    return this.requestCachedMetadataJson<HonuaOgcCollectionMetadata>(
      `ogc-records:collection:${request.collectionId}:${params.toString()}`,
      `${path}?${params.toString()}`,
      request,
    );
  }

  public async searchOgcRecords(request: OgcRecordsSearchRequest): Promise<HonuaOgcRecordsResponse> {
    return this.requestJson(
      "GET",
      buildOgcRecordsSearchPath(request),
      undefined,
      request.signal,
    ) as Promise<HonuaOgcRecordsResponse>;
  }

  public async getOgcRecord(request: OgcRecordItemRequest): Promise<HonuaOgcRecordResponse> {
    return this.requestJson(
      "GET",
      buildOgcRecordPath(request),
      undefined,
      request.signal,
    ) as Promise<HonuaOgcRecordResponse>;
  }

  public async fetchOgcRecordsRaw(request: OgcRecordsRawSearchRequest): Promise<Response> {
    return this.pipelineFetch(
      "GET",
      buildOgcRecordsSearchPath(request),
      {
        headers: mergeHeaders(
          { Accept: request.accept ?? "application/geo+json, application/json;q=0.9" },
          request.headers,
        ),
      },
      request.signal,
    );
  }

  public async fetchOgcRecordRaw(request: OgcRecordRawItemRequest): Promise<Response> {
    return this.pipelineFetch(
      "GET",
      buildOgcRecordPath(request),
      {
        headers: mergeHeaders(
          { Accept: request.accept ?? "application/geo+json, application/json;q=0.9" },
          request.headers,
        ),
      },
      request.signal,
    );
  }

  // ── WMS 1.3 ─────────────────────────────────────────────────

  /**
   * Fetch and parse a WMS `GetCapabilities` document for the addressed
   * service. The XML body decodes through `requestText`; the parsed
   * shape is the typed `WmsCapabilities` envelope (no XML node leaks
   * through the public surface).
   */
  public async getWmsCapabilities(request: {
    serviceId: string;
    version?: string;
    signal?: AbortSignal;
    extraParams?: Record<string, string | number | boolean>;
  }): Promise<WmsCapabilities> {
    const params = new URLSearchParams();
    params.set("SERVICE", "WMS");
    params.set("REQUEST", "GetCapabilities");
    params.set("VERSION", request.version ?? "1.3.0");
    if (request.extraParams) {
      for (const [key, value] of Object.entries(request.extraParams)) {
        params.set(key, String(value));
      }
    }
    const path = `${wmsBasePath(request.serviceId)}?${params.toString()}`;
    const { text: xml } = await this.requestText("GET", path, {
      accept: "text/xml,application/xml",
      signal: request.signal,
    });
    return parseWmsCapabilities(xml);
  }

  /** Render a WMS `GetMap`. Returns the raw image bytes. */
  public async getWmsMap(request: { serviceId: string } & WmsMapRequest): Promise<HonuaWmsImageResponse> {
    const params = serializeWmsMapParams(request);
    params.set("REQUEST", "GetMap");
    const path = `${wmsBasePath(request.serviceId)}?${params.toString()}`;
    const accept = request.format ?? "image/png";
    const response = await this.requestBytes("GET", path, accept, undefined, request.signal);
    return { bytes: response.bytes, contentType: response.contentType };
  }

  /**
   * Issue a WMS `GetFeatureInfo`. When `INFO_FORMAT=application/json`
   * the JSON body decodes into the canonical `HonuaTypedFeature[]`
   * shape; non-JSON formats round-trip on `bytes` so callers retain the
   * raw payload behind the protocol escape hatch.
   */
  public async getWmsFeatureInfo<T = Record<string, unknown>>(
    request: { serviceId: string } & WmsFeatureInfoRequest,
  ): Promise<HonuaWmsFeatureInfoResponse<T>> {
    const params = serializeWmsMapParams(request);
    params.set("REQUEST", "GetFeatureInfo");
    params.set("QUERY_LAYERS", request.queryLayers.join(","));
    params.set("I", String(Math.trunc(request.i)));
    params.set("J", String(Math.trunc(request.j)));
    const infoFormat = request.infoFormat ?? "application/json";
    params.set("INFO_FORMAT", infoFormat);
    if (request.featureCount !== undefined) {
      params.set("FEATURE_COUNT", String(Math.trunc(request.featureCount)));
    }
    const path = `${wmsBasePath(request.serviceId)}?${params.toString()}`;
    const response = await this.requestBytes("GET", path, infoFormat, undefined, request.signal);
    return decodeWmsFeatureInfoResponse<T>(response.bytes, response.contentType, infoFormat);
  }

  /**
   * Fetch a WMS `GetLegendGraphic`. honua-server does not implement
   * GetLegendGraphic today; callers should branch on
   * `WmsCapabilities.request.getLegendGraphic` before invoking. When
   * the wire returns 5xx the underlying `HonuaHttpError` flows through.
   */
  public async getWmsLegend(request: { serviceId: string } & WmsLegendRequest): Promise<HonuaWmsImageResponse> {
    const params = new URLSearchParams();
    params.set("SERVICE", "WMS");
    params.set("VERSION", "1.3.0");
    params.set("REQUEST", "GetLegendGraphic");
    params.set("LAYER", request.layer);
    if (request.style) params.set("STYLE", request.style);
    const format = request.format ?? "image/png";
    params.set("FORMAT", format);
    if (request.width !== undefined) params.set("WIDTH", String(Math.trunc(request.width)));
    if (request.height !== undefined) params.set("HEIGHT", String(Math.trunc(request.height)));
    if (request.extraParams) {
      for (const [key, value] of Object.entries(request.extraParams)) {
        params.set(key, String(value));
      }
    }
    const path = `${wmsBasePath(request.serviceId)}?${params.toString()}`;
    const response = await this.requestBytes("GET", path, format, undefined, request.signal);
    return { bytes: response.bytes, contentType: response.contentType };
  }

  // ── WMTS 1.0 ────────────────────────────────────────────────

  public async getWmtsCapabilities(request: {
    serviceId: string;
    signal?: AbortSignal;
  }): Promise<WmtsCapabilities> {
    const params = new URLSearchParams();
    params.set("SERVICE", "WMTS");
    params.set("REQUEST", "GetCapabilities");
    params.set("VERSION", "1.0.0");
    const path = `${wmtsBasePath(request.serviceId)}?${params.toString()}`;
    const { text: xml } = await this.requestText("GET", path, {
      accept: "text/xml,application/xml",
      signal: request.signal,
    });
    return parseWmtsCapabilities(xml);
  }

  /**
   * Fetch a single WMTS tile. `mode` selects between KVP
   * (`?REQUEST=GetTile&...`) and the RESTful path
   * (`/{layer}/{style}/{tms}/{z}/{y}/{x}.{ext}`). honua-server
   * advertises both; the SDK defaults to RESTful because the wire path
   * is a single string substitution per tile and skips
   * URLSearchParams serialisation on the hot path.
   */
  public async fetchWmtsTile(request: { serviceId: string } & WmtsTileRequest): Promise<HonuaWmtsTileResponse> {
    const mode: "kvp" | "rest" = request.mode ?? "rest";
    const format = request.format ?? "image/png";
    const style = request.style ?? "default";
    const tileMatrixSet = request.tileMatrixSet ?? "WebMercatorQuad";
    if (mode === "kvp") {
      const params = new URLSearchParams();
      params.set("SERVICE", "WMTS");
      params.set("VERSION", "1.0.0");
      params.set("REQUEST", "GetTile");
      params.set("LAYER", request.layer);
      params.set("STYLE", style);
      params.set("FORMAT", format);
      params.set("TILEMATRIXSET", tileMatrixSet);
      params.set("TILEMATRIX", String(request.tileMatrix));
      params.set("TILEROW", String(request.tileRow));
      params.set("TILECOL", String(request.tileCol));
      if (request.extraParams) {
        for (const [key, value] of Object.entries(request.extraParams)) {
          params.set(key, String(value));
        }
      }
      const path = `${wmtsBasePath(request.serviceId)}?${params.toString()}`;
      return this.requestBytes("GET", path, format, undefined, request.signal);
    }
    const ext = wmtsExtensionForFormat(format);
    const base = wmtsBasePath(request.serviceId);
    const layer = encodeURIComponent(request.layer);
    const styleSeg = encodeURIComponent(style);
    const tmsSeg = encodeURIComponent(tileMatrixSet);
    const tm = encodeURIComponent(String(request.tileMatrix));
    const tr = encodeURIComponent(String(request.tileRow));
    const tc = encodeURIComponent(String(request.tileCol));
    const extra = wmtsRestExtraParamsSuffix(request.extraParams);
    const path = `${base}/${layer}/${styleSeg}/${tmsSeg}/${tm}/${tr}/${tc}.${ext}${extra}`;
    return this.requestBytes("GET", path, format, undefined, request.signal);
  }

  /**
   * WMTS GetFeatureInfo. honua-server accepts both KVP and RESTful
   * routing; mode default mirrors `fetchWmtsTile`.
   */
  public async getWmtsFeatureInfo<T = Record<string, unknown>>(
    request: { serviceId: string } & WmtsFeatureInfoRequest,
  ): Promise<HonuaWmtsFeatureInfoResponse<T>> {
    const mode: "kvp" | "rest" = request.mode ?? "rest";
    const infoFormat = request.infoFormat ?? "application/json";
    const format = request.format ?? "image/png";
    const style = request.style ?? "default";
    const tileMatrixSet = request.tileMatrixSet ?? "WebMercatorQuad";
    if (mode === "kvp") {
      const params = new URLSearchParams();
      params.set("SERVICE", "WMTS");
      params.set("VERSION", "1.0.0");
      params.set("REQUEST", "GetFeatureInfo");
      params.set("LAYER", request.layer);
      params.set("STYLE", style);
      params.set("FORMAT", format);
      params.set("TILEMATRIXSET", tileMatrixSet);
      params.set("TILEMATRIX", String(request.tileMatrix));
      params.set("TILEROW", String(request.tileRow));
      params.set("TILECOL", String(request.tileCol));
      params.set("I", String(Math.trunc(request.i)));
      params.set("J", String(Math.trunc(request.j)));
      params.set("INFOFORMAT", infoFormat);
      if (request.extraParams) {
        for (const [key, value] of Object.entries(request.extraParams)) {
          params.set(key, String(value));
        }
      }
      const path = `${wmtsBasePath(request.serviceId)}?${params.toString()}`;
      const response = await this.requestBytes("GET", path, infoFormat, undefined, request.signal);
      return decodeWmsFeatureInfoResponse<T>(response.bytes, response.contentType, infoFormat);
    }
    const ext = wmtsFeatureInfoExtensionForFormat(infoFormat);
    const base = wmtsBasePath(request.serviceId);
    const layer = encodeURIComponent(request.layer);
    const styleSeg = encodeURIComponent(style);
    const tmsSeg = encodeURIComponent(tileMatrixSet);
    const tm = encodeURIComponent(String(request.tileMatrix));
    const tr = encodeURIComponent(String(request.tileRow));
    const tc = encodeURIComponent(String(request.tileCol));
    const jSeg = encodeURIComponent(String(Math.trunc(request.j)));
    const iSeg = encodeURIComponent(String(Math.trunc(request.i)));
    const extra = wmtsRestExtraParamsSuffix(request.extraParams);
    const path = `${base}/${layer}/${styleSeg}/${tmsSeg}/${tm}/${tr}/${tc}/${jSeg}/${iSeg}.${ext}${extra}`;
    const response = await this.requestBytes("GET", path, infoFormat, undefined, request.signal);
    return decodeWmsFeatureInfoResponse<T>(response.bytes, response.contentType, infoFormat);
  }

  // ── OGC API Processes ───────────────────────────────────────

  public async getOgcProcessesLanding(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcLandingResponse>(
      `ogc-processes:landing:${params.toString()}`,
      `/ogc/processes?${params.toString()}`,
      request,
    );
  }

  public async getOgcProcessesConformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcConformanceResponse>(
      `ogc-processes:conformance:${params.toString()}`,
      `/ogc/processes/conformance?${params.toString()}`,
      request,
    );
  }

  public async listOgcProcesses(request: OgcMetadataRequest = {}): Promise<HonuaOgcProcessesResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcProcessesResponse>(
      `ogc-processes:processes:${params.toString()}`,
      `/ogc/processes/processes?${params.toString()}`,
      request,
    );
  }

  public async getOgcProcess(request: { processId: string } & OgcMetadataRequest): Promise<HonuaOgcProcessDescription> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcProcessDescription>(
      `ogc-processes:process:${request.processId}:${params.toString()}`,
      `/ogc/processes/processes/${encodeURIComponent(request.processId)}?${params.toString()}`,
      request,
    );
  }

  public async executeOgcProcess(request: OgcProcessExecuteRequest): Promise<HonuaOgcProcessJobAccepted> {
    const headers = mergeHeaders(
      { "Content-Type": "application/json", Accept: "application/json" },
      request.headers,
      preferHeaderForExecute(request),
    );
    const path = `/ogc/processes/processes/${encodeURIComponent(request.processId)}/execution`;
    // honua-server only supports `response: "document"` and rejects "raw"
    // with HTTP 501; the SDK pins the supported value here.
    const body = JSON.stringify({
      inputs: request.inputs ?? {},
      outputs: request.outputs,
      response: "document",
    });
    return this.requestJson("POST", path, { headers, body }, request.signal) as Promise<HonuaOgcProcessJobAccepted>;
  }

  public async getOgcProcessJob(request: {
    jobId: string;
    signal?: AbortSignal;
    responseFormat?: string;
    extraParams?: Record<string, string | number | boolean>;
  }): Promise<HonuaOgcProcessJobStatus> {
    const params = createOgcMetadataParams(request);
    return this.requestJson(
      "GET",
      `/ogc/processes/jobs/${encodeURIComponent(request.jobId)}?${params.toString()}`,
      undefined,
      request.signal,
    ) as Promise<HonuaOgcProcessJobStatus>;
  }

  public async getOgcProcessJobResults(request: {
    jobId: string;
    signal?: AbortSignal;
    responseFormat?: string;
    extraParams?: Record<string, string | number | boolean>;
  }): Promise<HonuaOgcProcessJobResults> {
    const params = createOgcMetadataParams(request);
    return this.requestJson(
      "GET",
      `/ogc/processes/jobs/${encodeURIComponent(request.jobId)}/results?${params.toString()}`,
      undefined,
      request.signal,
    ) as Promise<HonuaOgcProcessJobResults>;
  }

  public async cancelOgcProcessJob(request: {
    jobId: string;
    signal?: AbortSignal;
    responseFormat?: string;
    extraParams?: Record<string, string | number | boolean>;
  }): Promise<HonuaOgcProcessJobStatus> {
    const params = createOgcMetadataParams(request);
    return this.requestJson(
      "DELETE",
      `/ogc/processes/jobs/${encodeURIComponent(request.jobId)}?${params.toString()}`,
      undefined,
      request.signal,
    ) as Promise<HonuaOgcProcessJobStatus>;
  }

  // ── STAC API ────────────────────────────────────────────────

  public async getStacLanding(request: OgcMetadataRequest = {}): Promise<HonuaStacLandingResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaStacLandingResponse>(
      `stac:landing:${params.toString()}`,
      `/stac?${params.toString()}`,
      request,
    );
  }

  public async listStacCollections(request: OgcMetadataRequest = {}): Promise<HonuaOgcCollectionsResponse> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcCollectionsResponse>(
      `stac:collections:${params.toString()}`,
      `/stac/collections?${params.toString()}`,
      request,
    );
  }

  public async getStacCollection(request: OgcCollectionRequest): Promise<HonuaOgcCollectionMetadata> {
    const params = createOgcMetadataParams(request);
    return this.requestCachedMetadataJson<HonuaOgcCollectionMetadata>(
      `stac:collection:${request.collectionId}:${params.toString()}`,
      `/stac/collections/${encodeURIComponent(String(request.collectionId))}?${params.toString()}`,
      request,
    );
  }

  public async getStacItem(request: {
    collectionId: string | number;
    itemId: string | number;
    signal?: AbortSignal;
    responseFormat?: string;
    extraParams?: Record<string, string | number | boolean>;
  }): Promise<HonuaStacItemResponse> {
    const params = createOgcMetadataParams(request);
    const path =
      `/stac/collections/${encodeURIComponent(String(request.collectionId))}` +
      `/items/${encodeURIComponent(String(request.itemId))}`;
    return this.requestJson(
      "GET",
      `${path}?${params.toString()}`,
      undefined,
      request.signal,
    ) as Promise<HonuaStacItemResponse>;
  }

  public async searchStac(request: StacSearchRequest = {}): Promise<HonuaStacItemCollectionResponse> {
    if (request.usePost) {
      return this.requestJson(
        "POST",
        "/stac/search",
        {
          headers: mergeHeaders({ "Content-Type": "application/json", Accept: "application/json" }),
          body: JSON.stringify(stacSearchBody(request)),
        },
        request.signal,
      ) as Promise<HonuaStacItemCollectionResponse>;
    }
    const params = serializeStacSearchParams(request);
    return this.requestJson(
      "GET",
      `/stac/search?${params.toString()}`,
      undefined,
      request.signal,
    ) as Promise<HonuaStacItemCollectionResponse>;
  }

  public async getMapServiceMetadata(
    serviceId: string,
    options: HonuaMetadataRequestOptions = {},
  ): Promise<HonuaServiceMetadata> {
    const query = new URLSearchParams({ f: "json" });
    const path = `/rest/services/${encodeServiceIdPath(serviceId)}/MapServer?${query.toString()}`;
    return this.requestCachedMetadataJson<HonuaServiceMetadata>(`geoservices-map:${serviceId}:service`, path, options);
  }

  public async getMapLayerMetadata(
    serviceId: string,
    layerId: number,
    options: HonuaMetadataRequestOptions = {},
  ): Promise<HonuaLayerMetadata> {
    const query = new URLSearchParams({ f: "json" });
    const path = `/rest/services/${encodeServiceIdPath(serviceId)}/MapServer/${layerId}?${query.toString()}`;
    return this.requestCachedMetadataJson<HonuaLayerMetadata>(`geoservices-map:${serviceId}:${layerId}`, path, options);
  }

  /**
   * Run a GeoServices `FeatureServer/query` request against a Honua-hosted layer.
   *
   * This is the canonical low-level read path. It maps directly to the FeatureServer
   * `query` endpoint and accepts the full ArcGIS query shape (`where`, `outFields`,
   * `geometry`, `spatialRel`, `orderByFields`, `resultRecordCount`, `outSr`, ...).
   *
   * For cross-protocol code (OGC, WFS, OData, STAC), prefer the protocol-neutral
   * {@link createDataset} contract — it normalizes capability differences and gives
   * you `Source.query(...)` plus paginated `Source.queryAll(...)` with explicit
   * `exceededTransferLimit` reporting.
   *
   * @example
   * ```ts
   * const { features, exceededTransferLimit } = await client.queryFeatures({
   *   serviceId: "parcels",
   *   layerId: 0,
   *   where: "STATUS = 'ACTIVE'",
   *   outFields: ["OBJECTID", "NAME"],
   *   returnGeometry: true,
   *   outSr: 4326,
   *   resultRecordCount: 500,
   * });
   *
   * if (exceededTransferLimit) {
   *   // re-issue with `resultOffset` or use queryFeaturesStream / dataset.source().queryAll()
   * }
   * ```
   */
  public async queryFeatures(request: QueryFeaturesRequest): Promise<HonuaQueryResponse> {
    if (this.transport === "grpc-web") {
      const client = await this.ensureConnectClient();
      const grpcAdapter = await HonuaClient.loadGrpcAdapter();
      const protoRequest = grpcAdapter.toProtoQueryRequest(request);
      try {
        const response = await client.queryFeatures(protoRequest);
        return grpcAdapter.fromProtoQueryResponse(response) as HonuaQueryResponse;
      } catch (error) {
        throw grpcAdapter.wrapConnectError(error);
      }
    }

    const method: QueryMethod = request.method ?? "GET";
    const usePbf = this.preferBinary && method === "GET";
    const params = new URLSearchParams();
    params.set("f", usePbf ? "pbf" : "json");
    params.set("where", request.where ?? "1=1");
    params.set("outFields", normalizeOutFields(request.outFields));
    params.set("returnGeometry", String(request.returnGeometry ?? true));

    serializeQueryParams(params, request);
    appendQueryExtraParams(params, request);

    const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/FeatureServer/${request.layerId}/query`;

    if (usePbf) {
      return this.requestBinaryWithJsonFallback(
        "GET",
        `${path}?${params.toString()}`,
        params,
        request.signal,
      ) as Promise<HonuaQueryResponse>;
    }

    if (method === "GET") {
      return this.requestJson(
        "GET",
        `${path}?${params.toString()}`,
        undefined,
        request.signal,
      ) as Promise<HonuaQueryResponse>;
    }

    return this.requestJson(
      "POST",
      path,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      },
      request.signal,
    ) as Promise<HonuaQueryResponse>;
  }

  public async queryMapLayer(request: MapLayerQueryRequest): Promise<HonuaQueryResponse> {
    const method: QueryMethod = request.method ?? "GET";
    const params = new URLSearchParams();
    params.set("f", "json");
    params.set("where", request.where ?? "1=1");
    params.set("outFields", normalizeOutFields(request.outFields));
    params.set("returnGeometry", String(request.returnGeometry ?? true));

    serializeQueryParams(params, request);
    appendQueryExtraParams(params, request);

    const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/${request.layerId}/query`;
    if (method === "GET") {
      return this.requestJson(
        "GET",
        `${path}?${params.toString()}`,
        undefined,
        request.signal,
      ) as Promise<HonuaQueryResponse>;
    }

    return this.requestJson(
      "POST",
      path,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      },
      request.signal,
    ) as Promise<HonuaQueryResponse>;
  }

  public async applyEdits(request: ApplyEditsRequest): Promise<HonuaApplyEditsResponse> {
    const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/FeatureServer/${request.layerId}/applyEdits`;
    const params = new URLSearchParams();
    params.set("f", "json");
    params.set("rollbackOnFailure", String(request.rollbackOnFailure ?? true));
    if (request.adds !== undefined) {
      params.set("adds", encodeFormValue(request.adds));
    }
    if (request.updates !== undefined) {
      params.set("updates", encodeFormValue(request.updates));
    }
    if (request.deletes !== undefined) {
      params.set("deletes", encodeDeletesValue(request.deletes));
    }

    return this.requestJson(
      "POST",
      path,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      },
      request.signal,
    ) as Promise<HonuaApplyEditsResponse>;
  }

  public async queryRelatedRecords(request: QueryRelatedRecordsRequest): Promise<HonuaRelatedRecordsResponse> {
    const method: QueryMethod = request.method ?? "GET";
    const params = new URLSearchParams();
    params.set("f", "json");
    params.set("relationshipId", String(request.relationshipId));
    if (request.objectIds !== undefined) {
      params.set(
        "objectIds",
        Array.isArray(request.objectIds) ? request.objectIds.join(",") : String(request.objectIds),
      );
    }
    params.set("where", request.where ?? "1=1");
    params.set("outFields", normalizeOutFields(request.outFields));
    params.set("returnGeometry", String(request.returnGeometry ?? true));

    if (request.extraParams) {
      for (const [key, value] of Object.entries(request.extraParams)) {
        params.set(key, String(value));
      }
    }

    const path =
      `/rest/services/${encodeServiceIdPath(request.serviceId)}` +
      `/FeatureServer/${request.layerId}/queryRelatedRecords`;
    if (method === "GET") {
      return this.requestJson(
        "GET",
        `${path}?${params.toString()}`,
        undefined,
        request.signal,
      ) as Promise<HonuaRelatedRecordsResponse>;
    }

    return this.requestJson(
      "POST",
      path,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      },
      request.signal,
    ) as Promise<HonuaRelatedRecordsResponse>;
  }

  public async queryMapRelatedRecords(request: MapRelatedRecordsRequest): Promise<HonuaRelatedRecordsResponse> {
    const method: QueryMethod = request.method ?? "GET";
    const params = new URLSearchParams();
    params.set("f", "json");
    params.set("relationshipId", String(request.relationshipId));
    if (request.objectIds !== undefined) {
      params.set(
        "objectIds",
        Array.isArray(request.objectIds) ? request.objectIds.join(",") : String(request.objectIds),
      );
    }
    params.set("where", request.where ?? "1=1");
    params.set("outFields", normalizeOutFields(request.outFields));
    params.set("returnGeometry", String(request.returnGeometry ?? true));

    if (request.extraParams) {
      for (const [key, value] of Object.entries(request.extraParams)) {
        params.set(key, String(value));
      }
    }

    const path =
      `/rest/services/${encodeServiceIdPath(request.serviceId)}` + `/MapServer/${request.layerId}/queryRelatedRecords`;
    if (method === "GET") {
      return this.requestJson(
        "GET",
        `${path}?${params.toString()}`,
        undefined,
        request.signal,
      ) as Promise<HonuaRelatedRecordsResponse>;
    }

    return this.requestJson(
      "POST",
      path,
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      },
      request.signal,
    ) as Promise<HonuaRelatedRecordsResponse>;
  }

  public async exportMap(request: ExportMapRequest): Promise<HonuaExportMapResponse> {
    const method: QueryMethod = request.method ?? "GET";
    const params = new URLSearchParams();
    params.set("f", request.responseFormat ?? "json");
    params.set("bbox", normalizeBBox(request.bbox));
    params.set("size", normalizeSize(request.size));
    if (request.format !== undefined) {
      params.set("format", request.format);
    }
    if (request.dpi !== undefined) {
      params.set("dpi", String(request.dpi));
    }
    if (request.transparent !== undefined) {
      params.set("transparent", String(request.transparent));
    }
    if (request.layers !== undefined) {
      params.set("layers", request.layers);
    }
    if (request.bboxSr !== undefined) {
      params.set("bboxSR", String(request.bboxSr));
    }
    if (request.imageSr !== undefined) {
      params.set("imageSR", String(request.imageSr));
    }
    if (request.backgroundColor !== undefined) {
      params.set("backgroundColor", request.backgroundColor);
    }

    if (request.extraParams) {
      for (const [key, value] of Object.entries(request.extraParams)) {
        params.set(key, String(value));
      }
    }

    const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/export`;
    if (method === "GET") {
      return this.requestJson("GET", `${path}?${params.toString()}`) as Promise<HonuaExportMapResponse>;
    }

    return this.requestJson("POST", path, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }) as Promise<HonuaExportMapResponse>;
  }

  public async getMapLegend(request: MapLegendRequest): Promise<HonuaLegendResponse> {
    const params = new URLSearchParams();
    params.set("f", request.responseFormat ?? "json");
    if (request.size !== undefined) {
      params.set("size", normalizeLegendSize(request.size));
    }
    if (request.dynamicLayers !== undefined) {
      params.set("dynamicLayers", request.dynamicLayers);
    }
    if (request.extraParams) {
      for (const [key, value] of Object.entries(request.extraParams)) {
        params.set(key, String(value));
      }
    }

    const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/legend`;
    return this.requestJson("GET", `${path}?${params.toString()}`) as Promise<HonuaLegendResponse>;
  }

  public async identifyMap(request: MapIdentifyRequest): Promise<HonuaIdentifyResponse> {
    const method: QueryMethod = request.method ?? "GET";
    const params = new URLSearchParams();
    params.set("f", request.responseFormat ?? "json");
    params.set("geometry", normalizeIdentifyGeometry(request.geometry));
    params.set("geometryType", request.geometryType ?? "esriGeometryPoint");
    params.set("mapExtent", normalizeMapExtent(request.mapExtent));
    params.set("imageDisplay", normalizeImageDisplay(request.imageDisplay));
    params.set("returnGeometry", String(request.returnGeometry ?? true));
    params.set("tolerance", String(request.tolerance ?? 3));

    if (request.sr !== undefined) {
      params.set("sr", String(request.sr));
    }
    if (request.layers !== undefined) {
      params.set("layers", request.layers);
    }
    if (request.maxAllowableOffset !== undefined) {
      params.set("maxAllowableOffset", String(request.maxAllowableOffset));
    }
    if (request.layerDefs !== undefined) {
      params.set("layerDefs", request.layerDefs);
    }
    if (request.dynamicLayers !== undefined) {
      params.set("dynamicLayers", request.dynamicLayers);
    }
    if (request.time !== undefined) {
      params.set("time", request.time);
    }
    if (request.extraParams) {
      for (const [key, value] of Object.entries(request.extraParams)) {
        params.set(key, String(value));
      }
    }

    const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/identify`;
    if (method === "GET") {
      return this.requestJson("GET", `${path}?${params.toString()}`) as Promise<HonuaIdentifyResponse>;
    }

    return this.requestJson("POST", path, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }) as Promise<HonuaIdentifyResponse>;
  }

  public async findMap(request: MapFindRequest): Promise<HonuaFindResponse> {
    const method: QueryMethod = request.method ?? "GET";
    const params = new URLSearchParams();
    params.set("f", request.responseFormat ?? "json");
    params.set("searchText", request.searchText);
    params.set("contains", String(request.contains ?? true));
    if (request.searchFields !== undefined) {
      params.set("searchFields", normalizeSearchFields(request.searchFields));
    }
    if (request.layers !== undefined) {
      params.set("layers", request.layers);
    }
    if (request.sr !== undefined) {
      params.set("sr", String(request.sr));
    }
    if (request.layerDefs !== undefined) {
      params.set("layerDefs", request.layerDefs);
    }
    if (request.returnGeometry !== undefined) {
      params.set("returnGeometry", String(request.returnGeometry));
    }
    if (request.maxAllowableOffset !== undefined) {
      params.set("maxAllowableOffset", String(request.maxAllowableOffset));
    }
    if (request.dynamicLayers !== undefined) {
      params.set("dynamicLayers", request.dynamicLayers);
    }
    if (request.returnZ !== undefined) {
      params.set("returnZ", String(request.returnZ));
    }
    if (request.returnM !== undefined) {
      params.set("returnM", String(request.returnM));
    }
    if (request.gdbVersion !== undefined) {
      params.set("gdbVersion", request.gdbVersion);
    }
    if (request.time !== undefined) {
      params.set("time", request.time);
    }
    if (request.relationParam !== undefined) {
      params.set("relationParam", request.relationParam);
    }
    if (request.extraParams) {
      for (const [key, value] of Object.entries(request.extraParams)) {
        params.set(key, String(value));
      }
    }

    const path = `/rest/services/${encodeServiceIdPath(request.serviceId)}/MapServer/find`;
    if (method === "GET") {
      return this.requestJson("GET", `${path}?${params.toString()}`) as Promise<HonuaFindResponse>;
    }

    return this.requestJson("POST", path, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    }) as Promise<HonuaFindResponse>;
  }

  private async requestJson(
    method: QueryMethod,
    path: string,
    init?: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    let request: HonuaRequestContext = {
      url: resolveRequestUrl(this.baseUrl, path),
      path,
      method,
      init: {
        method,
        headers: await this.composeHeaders({ Accept: "application/json" }, init?.headers),
        body: init?.body,
      },
    };

    request = await this.applyBeforeInterceptors(request);
    const retrySignal = callerSignal ?? request.init.signal ?? undefined;
    let refreshedAuth = false;

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      const timeout = createTimeoutSignal(callerSignal ?? request.init.signal, this.timeoutMs);
      const startTime = performance.now();
      try {
        response = await this.fetchWithSafeRedirects(request.url, {
          ...request.init,
          method: request.method,
          signal: timeout.signal,
        });
      } catch (error) {
        const durationMs = performance.now() - startTime;
        const normalizedError = timeout.didTimeout
          ? new HonuaTimeoutError(this.timeoutMs ?? 0)
          : normalizeNetworkError(error);
        if (this.shouldRetryRequest(request.method, attempt, undefined, normalizedError)) {
          await this.sleepBeforeRetry(attempt, undefined, retrySignal);
          continue;
        }
        await this.applyErrorInterceptors({
          request: cloneRequestContext(request),
          error: normalizedError,
          durationMs,
        });
        throw normalizedError;
      } finally {
        timeout.dispose();
      }
      const durationMs = performance.now() - startTime;

      const body = await parseResponseBody(response.clone());
      if (!response.ok) {
        const httpError = this.toHttpError(response.status, body);
        const authRefreshedRequest = refreshedAuth
          ? undefined
          : await this.refreshReplaySafeRequestAuth(request, response.status);
        if (authRefreshedRequest) {
          request = authRefreshedRequest;
          refreshedAuth = true;
          continue;
        }
        if (this.shouldRetryRequest(request.method, attempt, response.status, httpError)) {
          await this.sleepBeforeRetry(attempt, response, retrySignal);
          continue;
        }
        await this.applyErrorInterceptors({ request: cloneRequestContext(request), error: httpError, durationMs });
        throw httpError;
      }

      try {
        await this.applyAfterInterceptors(cloneRequestContext(request), response, durationMs);
      } catch (error) {
        await this.applyErrorInterceptors({ request: cloneRequestContext(request), error, durationMs });
        throw error;
      }

      return body;
    }
  }

  /**
   * Request a PBF binary response and decode it. Falls back to JSON on failure.
   */
  private async requestBinaryWithJsonFallback(
    method: QueryMethod,
    path: string,
    params: URLSearchParams,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    let request: HonuaRequestContext = {
      url: resolveRequestUrl(this.baseUrl, path),
      path,
      method,
      init: {
        method,
        headers: await this.composeHeaders({ Accept: "application/x-protobuf, application/json;q=0.9" }),
      },
    };

    request = await this.applyBeforeInterceptors(request);
    const retrySignal = callerSignal ?? request.init.signal ?? undefined;
    let refreshedAuth = false;

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      const timeout = createTimeoutSignal(callerSignal ?? request.init.signal, this.timeoutMs);
      const startTime = performance.now();
      try {
        response = await this.fetchWithSafeRedirects(request.url, {
          ...request.init,
          method: request.method,
          signal: timeout.signal,
        });
      } catch (error) {
        const durationMs = performance.now() - startTime;
        const normalizedError = timeout.didTimeout
          ? new HonuaTimeoutError(this.timeoutMs ?? 0)
          : normalizeNetworkError(error);
        if (this.shouldRetryRequest(request.method, attempt, undefined, normalizedError)) {
          await this.sleepBeforeRetry(attempt, undefined, retrySignal);
          continue;
        }
        await this.applyErrorInterceptors({
          request: cloneRequestContext(request),
          error: normalizedError,
          durationMs,
        });
        throw normalizedError;
      } finally {
        timeout.dispose();
      }
      const durationMs = performance.now() - startTime;

      if (!response.ok) {
        const body = await parseResponseBody(response.clone());
        const httpError = this.toHttpError(response.status, body);
        const authRefreshedRequest = refreshedAuth
          ? undefined
          : await this.refreshReplaySafeRequestAuth(request, response.status);
        if (authRefreshedRequest) {
          request = authRefreshedRequest;
          refreshedAuth = true;
          continue;
        }
        if (this.shouldRetryRequest(request.method, attempt, response.status, httpError)) {
          await this.sleepBeforeRetry(attempt, response, retrySignal);
          continue;
        }
        await this.applyErrorInterceptors({ request: cloneRequestContext(request), error: httpError, durationMs });
        throw httpError;
      }

      try {
        await this.applyAfterInterceptors(cloneRequestContext(request), response, durationMs);
      } catch (error) {
        await this.applyErrorInterceptors({ request: cloneRequestContext(request), error, durationMs });
        throw error;
      }

      // If server returned PBF, decode it
      if (isPbfResponse(response)) {
        try {
          const buffer = await response.arrayBuffer();
          return decodePbfQueryResponse(buffer);
        } catch {
          // PBF decode failed — fall back to JSON request
          params.set("f", "json");
          const jsonPath = `${stripQuery(path)}?${params.toString()}`;
          return this.requestJson("GET", jsonPath, undefined, callerSignal ?? request.init.signal ?? undefined);
        }
      }

      // Server returned JSON despite PBF request (e.g. error or unsupported)
      return parseResponseBody(response);
    }
  }

  /**
   * Fetch a text response (e.g. XML / JSON / plain) with an explicit Accept
   * negotiation. Used by the WFS adapter for `GetCapabilities`,
   * `Transaction` responses, and ExceptionReport bodies, and by the
   * WMS / WMTS Capabilities pipelines. Routes through the same
   * interceptor / retry / abort pipeline as `requestJson` /
   * `requestBytes`, so adapter callers do not need to bypass `HonuaClient`
   * to reach `fetch` directly.
   */
  public async requestText(
    method: QueryMethod,
    path: string,
    options?: { accept?: string; contentType?: string; body?: BodyInit; signal?: AbortSignal },
  ): Promise<{ text: string; contentType: string; status: number }> {
    const acceptHeader = options?.accept ?? "*/*";
    const headers: Record<string, string> = { Accept: acceptHeader };
    if (options?.contentType) headers["Content-Type"] = options.contentType;
    let request: HonuaRequestContext = {
      url: resolveRequestUrl(this.baseUrl, path),
      path,
      method,
      init: {
        method,
        headers: await this.composeHeaders(headers),
        ...(options?.body !== undefined ? { body: options.body } : {}),
      },
    };

    request = await this.applyBeforeInterceptors(request);
    const retrySignal = options?.signal ?? request.init.signal ?? undefined;
    let refreshedAuth = false;

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      const timeout = createTimeoutSignal(options?.signal ?? request.init.signal, this.timeoutMs);
      const startTime = performance.now();
      try {
        response = await this.fetchWithSafeRedirects(request.url, {
          ...request.init,
          method: request.method,
          signal: timeout.signal,
        });
      } catch (error) {
        const durationMs = performance.now() - startTime;
        const normalizedError = timeout.didTimeout
          ? new HonuaTimeoutError(this.timeoutMs ?? 0)
          : normalizeNetworkError(error);
        if (this.shouldRetryRequest(request.method, attempt, undefined, normalizedError)) {
          await this.sleepBeforeRetry(attempt, undefined, retrySignal);
          continue;
        }
        await this.applyErrorInterceptors({
          request: cloneRequestContext(request),
          error: normalizedError,
          durationMs,
        });
        throw normalizedError;
      } finally {
        timeout.dispose();
      }
      const durationMs = performance.now() - startTime;

      const text = await response.clone().text();
      const contentType = response.headers.get("content-type") ?? acceptHeader;
      if (!response.ok) {
        const httpError = this.toHttpError(response.status, text ? { raw: text, contentType } : {});
        const authRefreshedRequest = refreshedAuth
          ? undefined
          : await this.refreshReplaySafeRequestAuth(request, response.status);
        if (authRefreshedRequest) {
          request = authRefreshedRequest;
          refreshedAuth = true;
          continue;
        }
        if (this.shouldRetryRequest(request.method, attempt, response.status, httpError)) {
          await this.sleepBeforeRetry(attempt, response, retrySignal);
          continue;
        }
        await this.applyErrorInterceptors({ request: cloneRequestContext(request), error: httpError, durationMs });
        throw httpError;
      }

      try {
        await this.applyAfterInterceptors(cloneRequestContext(request), response, durationMs);
      } catch (error) {
        await this.applyErrorInterceptors({ request: cloneRequestContext(request), error, durationMs });
        throw error;
      }

      return { text, contentType, status: response.status };
    }
  }

  /**
   * Fetch a binary response (raw bytes plus content type). Used by the
   * OGC API Tiles and OGC API Maps wire methods, both of which negotiate
   * non-JSON output formats. The interceptor / retry / abort plumbing
   * mirrors `requestJson`.
   */
  private async requestBytes(
    method: QueryMethod,
    path: string,
    accept: string | undefined,
    init?: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType: string; empty: boolean }> {
    const acceptHeader = accept ?? "application/octet-stream";
    let request: HonuaRequestContext = {
      url: resolveRequestUrl(this.baseUrl, path),
      path,
      method,
      init: {
        method,
        headers: await this.composeHeaders({ Accept: acceptHeader }, init?.headers),
        body: init?.body,
      },
    };

    request = await this.applyBeforeInterceptors(request);
    const retrySignal = callerSignal ?? request.init.signal ?? undefined;
    let refreshedAuth = false;

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      const timeout = createTimeoutSignal(callerSignal ?? request.init.signal, this.timeoutMs);
      const startTime = performance.now();
      try {
        response = await this.fetchWithSafeRedirects(request.url, {
          ...request.init,
          method: request.method,
          signal: timeout.signal,
        });
      } catch (error) {
        const durationMs = performance.now() - startTime;
        const normalizedError = timeout.didTimeout
          ? new HonuaTimeoutError(this.timeoutMs ?? 0)
          : normalizeNetworkError(error);
        if (this.shouldRetryRequest(request.method, attempt, undefined, normalizedError)) {
          await this.sleepBeforeRetry(attempt, undefined, retrySignal);
          continue;
        }
        await this.applyErrorInterceptors({
          request: cloneRequestContext(request),
          error: normalizedError,
          durationMs,
        });
        throw normalizedError;
      } finally {
        timeout.dispose();
      }
      const durationMs = performance.now() - startTime;

      if (!response.ok) {
        const body = await parseResponseBody(response.clone());
        const httpError = this.toHttpError(response.status, body);
        const authRefreshedRequest = refreshedAuth
          ? undefined
          : await this.refreshReplaySafeRequestAuth(request, response.status);
        if (authRefreshedRequest) {
          request = authRefreshedRequest;
          refreshedAuth = true;
          continue;
        }
        if (this.shouldRetryRequest(request.method, attempt, response.status, httpError)) {
          await this.sleepBeforeRetry(attempt, response, retrySignal);
          continue;
        }
        await this.applyErrorInterceptors({ request: cloneRequestContext(request), error: httpError, durationMs });
        throw httpError;
      }

      try {
        await this.applyAfterInterceptors(cloneRequestContext(request), response, durationMs);
      } catch (error) {
        await this.applyErrorInterceptors({ request: cloneRequestContext(request), error, durationMs });
        throw error;
      }

      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      return {
        bytes,
        contentType: response.headers.get("content-type") ?? acceptHeader,
        empty: response.status === 204 || bytes.byteLength === 0,
      };
    }
  }

  private async applyBeforeInterceptors(request: HonuaRequestContext): Promise<HonuaRequestContext> {
    let next = cloneRequestContext(request);
    next = {
      ...next,
      url: normalizeInterceptorRequestUrl(this.baseUrl, next.url),
    };
    for (const interceptor of this.interceptors) {
      const mutation = await interceptor.before?.(cloneRequestContext(next));
      if (!mutation) {
        continue;
      }
      next = applyRequestMutation(next, mutation);
      next = {
        ...next,
        url: normalizeInterceptorRequestUrl(this.baseUrl, next.url),
      };
    }
    return next;
  }

  private async applyAfterInterceptors(
    request: HonuaRequestContext,
    response: Response,
    durationMs: number,
  ): Promise<void> {
    for (const interceptor of this.interceptors) {
      const context: HonuaResponseContext = {
        request: cloneRequestContext(request),
        response: response.clone(),
        durationMs,
      };
      await interceptor.after?.(context);
    }
  }

  private async applyErrorInterceptors(context: HonuaErrorContext): Promise<void> {
    for (const interceptor of this.interceptors) {
      try {
        await interceptor.error?.(context);
      } catch {
        // Preserve original request failure; interceptor failures should not mask it.
      }
    }
  }

  private async refreshReplaySafeRequestAuth(
    request: HonuaRequestContext,
    statusCode: number,
  ): Promise<HonuaRequestContext | undefined> {
    if (
      (statusCode !== 401 && statusCode !== 403) ||
      !this.authProvider ||
      !DEFAULT_RETRY_METHODS.has(request.method)
    ) {
      return undefined;
    }
    const refreshed = await this.resolveAuthCredentials({ forceRefresh: true, reason: "unauthorized" });
    if (!refreshed) return undefined;
    return {
      ...request,
      init: {
        ...request.init,
        headers: mergeHeaders(request.init.headers, authHeadersFromCredentials(refreshed.credentials)),
      },
    };
  }

  private shouldRetryRequest(
    method: QueryMethod,
    attempt: number,
    statusCode: number | undefined,
    error: unknown,
  ): boolean {
    if (!this.retryOptions || attempt >= this.retryOptions.maxRetries) {
      return false;
    }

    if (!DEFAULT_RETRY_METHODS.has(method)) {
      return false;
    }

    if (error instanceof HonuaAbortError) {
      return false;
    }

    if (statusCode !== undefined) {
      return this.retryOptions.retryStatuses.has(statusCode);
    }

    return error instanceof HonuaNetworkError || error instanceof HonuaTimeoutError;
  }

  private resolveRetryDelayMs(attempt: number, response?: Response): number {
    const retryAfterMs = response ? parseRetryAfterMs(response) : undefined;
    if (retryAfterMs !== undefined) {
      return Math.min(this.retryOptions?.maxDelayMs ?? retryAfterMs, retryAfterMs);
    }
    if (!this.retryOptions) {
      return 0;
    }
    const exponentialDelay = this.retryOptions.baseDelayMs * 2 ** attempt;
    const cappedDelay = Math.min(this.retryOptions.maxDelayMs, exponentialDelay);
    return cappedDelay * (0.5 + Math.random() * 0.5);
  }

  private async sleepBeforeRetry(attempt: number, response: Response | undefined, signal: AbortSignal | undefined) {
    await sleep(this.resolveRetryDelayMs(attempt, response), signal);
  }

  private toHttpError(statusCode: number, body: unknown): HonuaHttpError {
    const fallback = "Request failed";
    if (isObject(body)) {
      const error = body.error;
      if (isObject(error) && typeof error.message === "string") {
        return new HonuaHttpError(statusCode, error.message, body);
      }
      if (typeof body.message === "string") {
        return new HonuaHttpError(statusCode, body.message, body);
      }
      if (typeof body.detail === "string") {
        return new HonuaHttpError(statusCode, body.detail, body);
      }
    }

    return new HonuaHttpError(statusCode, fallback, body);
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCompatibilityEnvelope(payload: unknown): HonuaServerCompatibility {
  if (!isObject(payload)) {
    throw new TypeError("Server capabilities response must be a JSON object.");
  }

  if (payload.success === false) {
    const message = typeof payload.message === "string" ? payload.message : "Server capabilities request failed.";
    throw new Error(message);
  }

  if (!isObject(payload.data)) {
    throw new TypeError("Server capabilities response is missing a data object.");
  }

  return parseCompatibilityContract(payload.data.compatibility);
}

function parseCompatibilityContract(payload: unknown): HonuaServerCompatibility {
  if (!isObject(payload)) {
    throw new TypeError("Server capabilities response is missing data.compatibility.");
  }

  return {
    serverVersion: requireNonEmptyString(payload.serverVersion, "data.compatibility.serverVersion"),
    releaseChannel: requireNonEmptyString(payload.releaseChannel, "data.compatibility.releaseChannel"),
    controlPlaneApi: parseControlPlaneApi(payload.controlPlaneApi),
    metadataSchemas: parseMetadataSchemas(payload.metadataSchemas),
    features: parseCompatibilityFeatures(payload.features),
  };
}

function parseControlPlaneApi(payload: unknown): HonuaServerCompatibility["controlPlaneApi"] {
  if (!isObject(payload)) {
    throw new TypeError("Server capabilities response is missing data.compatibility.controlPlaneApi.");
  }

  return {
    major: requireInteger(payload.major, "data.compatibility.controlPlaneApi.major"),
    basePath: requireNonEmptyString(payload.basePath, "data.compatibility.controlPlaneApi.basePath"),
    deprecated: requireBoolean(payload.deprecated, "data.compatibility.controlPlaneApi.deprecated"),
  };
}

function parseMetadataSchemas(payload: unknown): HonuaServerCompatibility["metadataSchemas"] {
  if (!Array.isArray(payload)) {
    throw new TypeError("Server capabilities response is missing data.compatibility.metadataSchemas.");
  }

  return payload.map((entry, index) => {
    if (!isObject(entry)) {
      throw new TypeError(`Server capabilities response metadataSchemas[${index}] must be an object.`);
    }

    return {
      version: requireNonEmptyString(entry.version, `data.compatibility.metadataSchemas[${index}].version`),
      deprecated: requireBoolean(entry.deprecated, `data.compatibility.metadataSchemas[${index}].deprecated`),
    };
  });
}

function parseCompatibilityFeatures(payload: unknown): HonuaServerCompatibility["features"] {
  if (!isObject(payload)) {
    throw new TypeError("Server capabilities response is missing data.compatibility.features.");
  }

  return {
    metadataResources: requireBoolean(payload.metadataResources, "data.compatibility.features.metadataResources"),
    manifestExport: requireBoolean(payload.manifestExport, "data.compatibility.features.manifestExport"),
    manifestApply: requireBoolean(payload.manifestApply, "data.compatibility.features.manifestApply"),
    manifestDryRun: requireBoolean(payload.manifestDryRun, "data.compatibility.features.manifestDryRun"),
    manifestPrune: requireBoolean(payload.manifestPrune, "data.compatibility.features.manifestPrune"),
  };
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${fieldName} must be a string.`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`${fieldName} must not be empty.`);
  }

  return trimmed;
}

function requireBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${fieldName} must be a boolean.`);
  }
  return value;
}

function requireInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${fieldName} must be an integer.`);
  }
  return value;
}

function evaluateCompatibility(compatibility: HonuaServerCompatibility): string[] {
  const reasons: string[] = [];
  const minimumVersion = parseVersion(HONUA_MINIMUM_SUPPORTED_SERVER_VERSION);
  const serverVersion = parseVersion(compatibility.serverVersion);

  if (!minimumVersion) {
    reasons.push(
      `SDK minimum supported version '${HONUA_MINIMUM_SUPPORTED_SERVER_VERSION}' is not parseable for compatibility checks.`,
    );
    return reasons;
  }

  if (!serverVersion) {
    reasons.push(`Server version '${compatibility.serverVersion}' is not parseable for compatibility checks.`);
  } else if (compareVersions(serverVersion, minimumVersion) < 0) {
    reasons.push(
      `Server version ${compatibility.serverVersion} is older than the minimum supported ${HONUA_MINIMUM_SUPPORTED_SERVER_VERSION}.`,
    );
  }

  if (compatibility.controlPlaneApi.major !== SUPPORTED_CONTROL_PLANE_API_MAJOR) {
    reasons.push(
      `Control-plane API major ${compatibility.controlPlaneApi.major} is unsupported; expected ${SUPPORTED_CONTROL_PLANE_API_MAJOR}.`,
    );
  }

  if (normalizePathValue(compatibility.controlPlaneApi.basePath) !== SUPPORTED_CONTROL_PLANE_API_BASE_PATH) {
    reasons.push(
      `Control-plane API base path ${compatibility.controlPlaneApi.basePath} is unsupported; expected ${SUPPORTED_CONTROL_PLANE_API_BASE_PATH}.`,
    );
  }

  if (compatibility.controlPlaneApi.deprecated) {
    reasons.push(`Control-plane API major ${compatibility.controlPlaneApi.major} is marked deprecated by the server.`);
  }

  const actualReleaseChannelRank = getReleaseChannelRank(compatibility.releaseChannel);
  const minimumReleaseChannelRank = getReleaseChannelRank(MINIMUM_SUPPORTED_SERVER_RELEASE_CHANNEL) ?? 0;
  if (actualReleaseChannelRank === undefined) {
    reasons.push(`Server release channel '${compatibility.releaseChannel}' is not recognized by this SDK baseline.`);
  } else if (actualReleaseChannelRank < minimumReleaseChannelRank) {
    reasons.push(
      `Server release channel '${compatibility.releaseChannel}' is below the minimum supported '${MINIMUM_SUPPORTED_SERVER_RELEASE_CHANNEL}'.`,
    );
  }

  return reasons;
}

interface ParsedVersion {
  readonly numbers: readonly number[];
  readonly prerelease: readonly string[];
}

function parseVersion(version: string): ParsedVersion | undefined {
  const normalized = version.trim().replace(/^v/i, "");
  if (normalized.length === 0) {
    return undefined;
  }

  const coreAndPrerelease = normalized.split("+", 1)[0] ?? normalized;
  const [core, prerelease = ""] = coreAndPrerelease.split("-", 2);
  const numbers = core.split(".").map((segment) => Number.parseInt(segment, 10));
  if (numbers.length === 0 || numbers.some((segment) => !Number.isFinite(segment))) {
    return undefined;
  }

  const prereleaseParts =
    prerelease.length > 0
      ? prerelease
          .split(".")
          .map((segment) => segment.trim())
          .filter((segment) => segment.length > 0)
      : [];

  return {
    numbers,
    prerelease: prereleaseParts,
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.numbers[index] ?? 0;
    const rightPart = right.numbers[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) {
    return 0;
  }
  if (left.prerelease.length === 0) {
    return 1;
  }
  if (right.prerelease.length === 0) {
    return -1;
  }

  const prereleaseLength = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    if (leftPart === rightPart) {
      continue;
    }

    const leftNumeric = Number.parseInt(leftPart, 10);
    const rightNumeric = Number.parseInt(rightPart, 10);
    const leftIsNumeric = String(leftNumeric) === leftPart;
    const rightIsNumeric = String(rightNumeric) === rightPart;

    if (leftIsNumeric && rightIsNumeric) {
      return leftNumeric < rightNumeric ? -1 : 1;
    }
    if (leftIsNumeric) {
      return -1;
    }
    if (rightIsNumeric) {
      return 1;
    }

    return leftPart < rightPart ? -1 : 1;
  }

  return 0;
}

function describeCompatibilityError(error: unknown): string {
  if (error instanceof HonuaHttpError && error.statusCode === 404) {
    return "Server does not expose GET /api/v1/admin/capabilities.";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizePathValue(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return trimTrailingSlashes(prefixed);
}

function getReleaseChannelRank(releaseChannel: string): number | undefined {
  switch (releaseChannel.trim().toLowerCase()) {
    case "nightly":
      return 0;
    case "dev":
      return 1;
    case "alpha":
      return 2;
    case "preview":
      return 3;
    case "beta":
      return 4;
    case "rc":
      return 5;
    case "stable":
      return 6;
    case "lts":
      return 7;
    default:
      return undefined;
  }
}

function applyRequestMutation(request: HonuaRequestContext, mutation: HonuaRequestMutation): HonuaRequestContext {
  const nextInit =
    mutation.init === undefined
      ? request.init
      : {
          ...request.init,
          ...mutation.init,
          headers: mergeHeaders(request.init.headers, mutation.init.headers),
        };

  return {
    url: mutation.url ?? request.url,
    path: request.path,
    method: mutation.method ?? request.method,
    init: {
      ...nextInit,
      method: mutation.method ?? request.method,
    },
  };
}

function cloneRequestContext(request: HonuaRequestContext): HonuaRequestContext {
  return {
    ...request,
    init: {
      ...request.init,
      headers: cloneHeadersInit(request.init.headers),
    },
  };
}

function cloneHeadersInit(headers: HeadersInit | undefined): HeadersInit {
  return mergeHeaders(headers);
}

function mergeHeaders(...headersList: Array<HeadersInit | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const headers of headersList) {
    if (!headers) {
      continue;
    }

    if (headers instanceof Headers) {
      for (const [key, value] of headers.entries()) {
        merged[key] = value;
      }
      continue;
    }

    if (Array.isArray(headers)) {
      for (const [key, value] of headers) {
        merged[key] = value;
      }
      continue;
    }

    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null) {
        continue;
      }
      merged[key] = String(value);
    }
  }
  return merged;
}

function normalizeAuthProvider(auth: HonuaClientOptions["auth"] | undefined): NormalizedAuthProvider | undefined {
  if (!auth) {
    return undefined;
  }
  if (typeof auth === "function") {
    return { getCredentials: auth };
  }
  return {
    getCredentials: (context) => auth.getCredentials(context),
    ...(auth.revokeCredentials ? { revokeCredentials: auth.revokeCredentials.bind(auth) } : {}),
  };
}

function normalizeAuthRefreshSkewMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_AUTH_REFRESH_SKEW_MS;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizeAuthCredentials(
  value: HonuaAuthCredentials | string | null | undefined,
): HonuaAuthCredentials | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? { bearerToken: value } : undefined;
  }
  if (!value) {
    return undefined;
  }
  const credentials: HonuaAuthCredentials = {};
  if (typeof value.apiKey === "string" && value.apiKey.length > 0) {
    credentials.apiKey = value.apiKey;
  }
  if (typeof value.bearerToken === "string" && value.bearerToken.length > 0) {
    credentials.bearerToken = value.bearerToken;
  }
  if (typeof value.authorization === "string" && value.authorization.length > 0) {
    credentials.authorization = value.authorization;
  }
  if (value.expiresAt !== undefined) {
    credentials.expiresAt = value.expiresAt;
  }
  if (!credentials.apiKey && !credentials.bearerToken && !credentials.authorization) {
    return undefined;
  }
  return credentials;
}

function normalizeAuthExpiresAtMs(expiresAt: HonuaAuthCredentials["expiresAt"]): number | undefined {
  if (expiresAt === undefined) {
    return undefined;
  }
  if (expiresAt instanceof Date) {
    return Number.isFinite(expiresAt.getTime()) ? expiresAt.getTime() : undefined;
  }
  if (typeof expiresAt === "number") {
    return Number.isFinite(expiresAt) ? expiresAt : undefined;
  }
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isAuthCredentialsExpiring(cached: CachedAuthCredentials, skewMs: number): boolean {
  if (cached.expiresAtMs === undefined) {
    return false;
  }
  return cached.expiresAtMs - Date.now() <= skewMs;
}

function resolveAuthRefreshReason(cached: CachedAuthCredentials | undefined): HonuaAuthRefreshReason {
  return cached ? "expired" : "initial";
}

function authHeadersFromCredentials(credentials: HonuaAuthCredentials): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (credentials.apiKey) {
    headers["X-API-Key"] = credentials.apiKey;
  }
  if (credentials.authorization) {
    headers.Authorization = credentials.authorization;
  } else if (credentials.bearerToken) {
    headers.Authorization = `Bearer ${credentials.bearerToken}`;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return undefined;
  }
  return Math.max(1, Math.trunc(timeoutMs));
}

function normalizeRetryOptions(options: HonuaRetryOptions | undefined): NormalizedRetryOptions | undefined {
  if (!options) {
    return undefined;
  }

  const maxRetries =
    typeof options.maxRetries === "number" && Number.isFinite(options.maxRetries)
      ? Math.max(0, Math.trunc(options.maxRetries))
      : 0;
  if (maxRetries < 1) {
    return undefined;
  }

  const baseDelayMs =
    typeof options.baseDelayMs === "number" && Number.isFinite(options.baseDelayMs)
      ? Math.max(1, Math.trunc(options.baseDelayMs))
      : 100;
  const maxDelayMs =
    typeof options.maxDelayMs === "number" && Number.isFinite(options.maxDelayMs)
      ? Math.max(baseDelayMs, Math.trunc(options.maxDelayMs))
      : 2_000;
  const retryStatuses = new Set<number>(
    (options.retryStatuses ?? Array.from(DEFAULT_RETRY_STATUSES))
      .map((status) => Math.trunc(status))
      .filter((status) => Number.isFinite(status) && status >= 100 && status <= 599),
  );
  if (retryStatuses.size === 0) {
    for (const status of DEFAULT_RETRY_STATUSES) {
      retryStatuses.add(status);
    }
  }

  return {
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    retryStatuses,
  };
}

function parseRetryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) {
    return undefined;
  }

  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const targetTime = Date.parse(value);
  if (!Number.isFinite(targetTime)) {
    return undefined;
  }
  return Math.max(0, targetTime - Date.now());
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw new HonuaAbortError();
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new HonuaAbortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function normalizeNetworkError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") {
    return new HonuaAbortError();
  }
  if (error instanceof Error) {
    return new HonuaNetworkError(error.message, error);
  }
  return new HonuaNetworkError(String(error), error);
}

function createTimeoutSignal(
  existingSignal: AbortSignal | null | undefined,
  timeoutMs: number | undefined,
): {
  signal: AbortSignal | undefined;
  didTimeout: boolean;
  dispose(): void;
} {
  if (timeoutMs === undefined) {
    return {
      signal: existingSignal ?? undefined,
      didTimeout: false,
      dispose: () => undefined,
    };
  }

  const controller = new AbortController();
  let didTimeout = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  if (existingSignal) {
    if (existingSignal.aborted) {
      controller.abort();
    } else {
      onAbort = () => {
        controller.abort();
      };
      existingSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    get didTimeout() {
      return didTimeout;
    },
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (existingSignal && onAbort) {
        existingSignal.removeEventListener("abort", onAbort);
        onAbort = undefined;
      }
    },
  };
}

function createOgcMetadataParams(request: OgcMetadataRequest): URLSearchParams {
  const params = new URLSearchParams();
  params.set("f", request.responseFormat ?? "json");
  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, String(value));
    }
  }
  return params;
}

function createMetadataCacheState(
  entry: MetadataCacheEntry,
  status: "hit" | "miss" | "stale" | "refreshed" | "bypass",
  options: {
    now: number;
    ttlMs?: number;
    staleIfErrorMs?: number;
    revalidatedAt?: string;
    refreshErrorId?: string;
  },
) {
  return createHonuaCacheState({
    scope: "metadata",
    status,
    keyFingerprint: entry.keyFingerprint,
    ageMs: Math.max(0, options.now - entry.cachedAtMs),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.staleIfErrorMs !== undefined ? { staleIfErrorMs: options.staleIfErrorMs } : {}),
    ...(options.revalidatedAt ? { revalidatedAt: options.revalidatedAt } : {}),
    ...(entry.sourceUpdatedAt ? { sourceUpdatedAt: entry.sourceUpdatedAt } : {}),
    ...(entry.validator ? { validator: entry.validator } : {}),
    ...(options.refreshErrorId ? { refreshErrorId: options.refreshErrorId } : {}),
  });
}

function metadataRefreshErrorId(error: unknown): string {
  if (error instanceof HonuaHttpError) {
    return `http-${error.statusCode}`;
  }
  if (error instanceof HonuaTimeoutError) {
    return "timeout";
  }
  if (error instanceof HonuaNetworkError) {
    return "network";
  }
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return "unknown";
}

function mergePathWithQueryParams(path: string, additionalParams: URLSearchParams): string {
  if (additionalParams.size === 0) {
    return path;
  }

  const hashIndex = path.indexOf("#");
  const hash = hashIndex >= 0 ? path.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
  const queryIndex = withoutHash.indexOf("?");
  const basePath = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const existingQuery = queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "";

  const merged = new URLSearchParams(existingQuery);
  for (const [key, value] of additionalParams.entries()) {
    merged.set(key, value);
  }

  const nextQuery = merged.toString();
  const withQuery = nextQuery.length > 0 ? `${basePath}?${nextQuery}` : basePath;
  return `${withQuery}${hash}`;
}

function serializeQueryParams(params: URLSearchParams, request: QueryFeaturesRequest | MapLayerQueryRequest): void {
  if (request.outSr !== undefined) {
    params.set(
      "outSR",
      typeof request.outSr === "object" && request.outSr !== null
        ? JSON.stringify(request.outSr)
        : String(request.outSr),
    );
  }
  if (request.orderByFields !== undefined) {
    params.set("orderByFields", request.orderByFields);
  }
  if (request.objectIds !== undefined) {
    params.set("objectIds", Array.isArray(request.objectIds) ? request.objectIds.join(",") : String(request.objectIds));
  }
  if (request.geometry !== undefined) {
    params.set(
      "geometry",
      typeof request.geometry === "object" && request.geometry !== null
        ? JSON.stringify(request.geometry)
        : String(request.geometry),
    );
  }
  if (request.geometryType !== undefined) {
    params.set("geometryType", request.geometryType);
  }
  if (request.spatialRel !== undefined) {
    params.set("spatialRel", request.spatialRel);
  }
  if (request.returnDistinctValues !== undefined) {
    params.set("returnDistinctValues", String(request.returnDistinctValues));
  }
  if (request.returnCentroid !== undefined) {
    params.set("returnCentroid", String(request.returnCentroid));
  }
  if (request.groupByFieldsForStatistics !== undefined) {
    params.set("groupByFieldsForStatistics", request.groupByFieldsForStatistics);
  }
  if (request.outStatistics !== undefined) {
    params.set(
      "outStatistics",
      Array.isArray(request.outStatistics) ? JSON.stringify(request.outStatistics) : String(request.outStatistics),
    );
  }
  if (request.resultOffset !== undefined) {
    params.set("resultOffset", String(request.resultOffset));
  }
  if (request.resultRecordCount !== undefined) {
    params.set("resultRecordCount", String(request.resultRecordCount));
  }
}

function appendQueryExtraParams(
  params: URLSearchParams,
  request: Pick<QueryFeaturesRequest | MapLayerQueryRequest, "outSr" | "extraParams">,
): void {
  if (!request.extraParams) {
    return;
  }

  for (const [key, value] of Object.entries(request.extraParams)) {
    if (request.outSr !== undefined && (key === "outSr" || key === "outSR")) {
      continue;
    }
    params.set(key, String(value));
  }
}

function normalizeCsv(value: string | readonly (string | number)[]): string {
  if (typeof value === "string") {
    return value;
  }
  return Array.from(value).join(",");
}

function normalizeStringCsv(value: string | readonly string[]): string {
  return typeof value === "string" ? value : value.join(",");
}

function normalizeRecordsBbox(value: OgcRecordsSearchRequest["bbox"]): string {
  return Array.isArray(value) ? value.join(",") : String(value);
}

function buildOgcRecordsSearchPath(request: OgcRecordsSearchRequest): string {
  const collection = encodeURIComponent(String(request.collectionId));
  const params = serializeOgcRecordsSearchParams(request);
  return `/ogc/records/collections/${collection}/items?${params.toString()}`;
}

function buildOgcRecordPath(request: OgcRecordItemRequest): string {
  const collection = encodeURIComponent(String(request.collectionId));
  const record = encodeURIComponent(String(request.recordId));
  const params = createOgcMetadataParams(request);
  if (request.profile !== undefined) params.set("profile", normalizeStringCsv(request.profile));
  return `/ogc/records/collections/${collection}/items/${record}?${params.toString()}`;
}

function serializeOgcRecordsSearchParams(request: OgcRecordsSearchRequest): URLSearchParams {
  const params = createOgcMetadataParams(request);
  if (request.limit !== undefined) params.set("limit", String(request.limit));
  if (request.offset !== undefined) params.set("offset", String(request.offset));
  if (request.bbox !== undefined) params.set("bbox", normalizeRecordsBbox(request.bbox));
  if (request.datetime !== undefined) params.set("datetime", request.datetime);
  if (request.q !== undefined) params.set("q", normalizeStringCsv(request.q));
  if (request.ids !== undefined) params.set("ids", normalizeCsv(request.ids));
  if (request.type !== undefined) params.set("type", normalizeStringCsv(request.type));
  if (request.externalIds !== undefined) params.set("externalIds", normalizeStringCsv(request.externalIds));
  if (request.filter !== undefined) params.set("filter", request.filter);
  if (request.filterLang !== undefined) params.set("filter-lang", request.filterLang);
  if (request.filterCrs !== undefined) params.set("filter-crs", request.filterCrs);
  if (request.properties !== undefined) params.set("properties", normalizeStringCsv(request.properties));
  if (request.sortby !== undefined) params.set("sortby", request.sortby);
  if (request.profile !== undefined) params.set("profile", normalizeStringCsv(request.profile));
  return params;
}

function serializeOgcMapImageParams(request: OgcMapImageRequest): URLSearchParams {
  const params = new URLSearchParams();
  const f = ogcMapShortFormat(request.format);
  if (f !== undefined) params.set("f", f);
  if (request.width !== undefined) params.set("width", String(request.width));
  if (request.height !== undefined) params.set("height", String(request.height));
  if (request.bbox !== undefined) {
    params.set("bbox", typeof request.bbox === "string" ? request.bbox : request.bbox.join(","));
  }
  if (request.bboxCrs !== undefined) params.set("bbox-crs", request.bboxCrs);
  if (request.crs !== undefined) params.set("crs", request.crs);
  if (request.collections !== undefined && request.collections.length > 0) {
    params.set("collections", request.collections.join(","));
  }
  if (request.transparent !== undefined) params.set("transparent", String(request.transparent));
  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, String(value));
    }
  }
  return params;
}

const OGC_MAP_FORMAT_TO_SHORT: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/jpg", "jpg"],
  ["image/tiff", "tiff"],
  ["image/tif", "tif"],
]);

const OGC_MAP_SHORT_TO_MEDIA: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["tiff", "image/tiff"],
  ["tif", "image/tiff"],
]);

function ogcMapShortFormat(format: string | undefined): string | undefined {
  if (format === undefined) return undefined;
  const lower = format.toLowerCase();
  return OGC_MAP_FORMAT_TO_SHORT.get(lower) ?? lower;
}

function ogcMapAcceptHeader(format: string | undefined): string | undefined {
  if (format === undefined) return undefined;
  const lower = format.toLowerCase();
  return OGC_MAP_SHORT_TO_MEDIA.get(lower) ?? format;
}

/**
 * Build the `Prefer` header for an OGC API Processes execution request.
 * honua-server is async-only: `mode: "async"` sends an explicit
 * `Prefer: respond-async` so OGC-conformance checkers see the header;
 * `mode: "auto"` (or unset) omits it and lets the server default apply.
 */
function preferHeaderForExecute(request: OgcProcessExecuteRequest): { Prefer: string } | undefined {
  if (request.mode === "async") {
    return { Prefer: "respond-async" };
  }
  return undefined;
}

function serializeStacSearchParams(request: StacSearchRequest): URLSearchParams {
  const params = new URLSearchParams();
  if (request.bbox !== undefined) params.set("bbox", request.bbox.join(","));
  if (request.datetime !== undefined) params.set("datetime", request.datetime);
  if (request.ids !== undefined && request.ids.length > 0) params.set("ids", request.ids.join(","));
  if (request.collections !== undefined && request.collections.length > 0) {
    params.set("collections", request.collections.join(","));
  }
  // honua-server accepts `intersects` on GET as a JSON-encoded geometry
  // and `fields` as a CSV with `-` prefix marking excludes (matches
  // STAC Item Search GET conventions and the server's parser).
  if (request.intersects !== undefined) params.set("intersects", JSON.stringify(request.intersects));
  const fields = stacFieldsCsv(request.fields);
  if (fields !== undefined) params.set("fields", fields);
  if (request.filter !== undefined) params.set("filter", request.filter);
  if (request.filterLang !== undefined) params.set("filter-lang", request.filterLang);
  if (request.limit !== undefined) params.set("limit", String(request.limit));
  // honua-server uses numeric `offset` paging on GET. `next` is kept as
  // optional support for STAC servers that advertise an opaque token.
  if (request.offset !== undefined) params.set("offset", String(request.offset));
  if (request.next !== undefined) params.set("next", request.next);
  if (request.sortby !== undefined) params.set("sortby", request.sortby);
  return params;
}

function stacSearchBody(request: StacSearchRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (request.bbox !== undefined) out.bbox = request.bbox;
  if (request.datetime !== undefined) out.datetime = request.datetime;
  if (request.intersects !== undefined) out.intersects = request.intersects;
  if (request.ids !== undefined) out.ids = request.ids;
  if (request.collections !== undefined) out.collections = request.collections;
  if (request.filter !== undefined) out.filter = request.filter;
  if (request.filterLang !== undefined) out["filter-lang"] = request.filterLang;
  if (request.limit !== undefined) out.limit = request.limit;
  if (request.offset !== undefined) out.offset = request.offset;
  if (request.next !== undefined) out.next = request.next;
  if (request.sortby !== undefined) out.sortby = request.sortby;
  if (request.fields !== undefined) out.fields = request.fields;
  return out;
}

function stacFieldsCsv(fields: StacSearchRequest["fields"] | undefined): string | undefined {
  if (!fields) return undefined;
  const parts: string[] = [];
  if (fields.include) {
    for (const f of fields.include) {
      if (typeof f === "string" && f.length > 0) parts.push(f);
    }
  }
  if (fields.exclude) {
    for (const f of fields.exclude) {
      if (typeof f === "string" && f.length > 0) parts.push(`-${f}`);
    }
  }
  return parts.length > 0 ? parts.join(",") : undefined;
}

// ── WMS / WMTS helpers ──────────────────────────────────────────

/** Canonical WMS endpoint path. honua-server publishes both `/rest/services/{id}/MapServer/WMS` and `/ogc/services/{id}/wms`; the SDK targets the GeoServices-aliased path because every Honua deployment exposes it. */
function wmsBasePath(serviceId: string): string {
  return `/rest/services/${encodeServiceIdPath(serviceId)}/MapServer/WMS`;
}

/** Canonical WMTS endpoint path. */
function wmtsBasePath(serviceId: string): string {
  return `/rest/services/${encodeServiceIdPath(serviceId)}/MapServer/WMTS`;
}

/**
 * CRS table for WMS 1.3 axis order. WMS 1.3 honors authority axis order,
 * which means `EPSG:4326` is `(lat, lon)` and `CRS:84` / `EPSG:3857` are
 * `(x, y)`. The `BBOX` envelope tuple supplied by callers is the
 * canonical `[minx, miny, maxx, maxy]`; this map decides whether the
 * tuple is swapped on the wire.
 */
const WMS_AXIS_SWAP_CRS: ReadonlySet<string> = new Set(["EPSG:4326"]);

function serializeWmsMapParams(request: WmsMapRequest & { serviceId: string }): URLSearchParams {
  const params = new URLSearchParams();
  params.set("SERVICE", "WMS");
  params.set("VERSION", "1.3.0");
  params.set("LAYERS", request.layers.join(","));
  params.set("STYLES", request.styles ? request.styles.join(",") : "");
  const crs = request.crs ?? "EPSG:3857";
  params.set("CRS", crs);
  const [minx, miny, maxx, maxy] = request.bbox;
  const wireBbox = WMS_AXIS_SWAP_CRS.has(crs) ? [miny, minx, maxy, maxx] : [minx, miny, maxx, maxy];
  params.set("BBOX", wireBbox.join(","));
  params.set("WIDTH", String(Math.trunc(request.width)));
  params.set("HEIGHT", String(Math.trunc(request.height)));
  params.set("FORMAT", request.format ?? "image/png");
  params.set("TRANSPARENT", String(request.transparent ?? true).toUpperCase());
  if (request.bgcolor !== undefined) params.set("BGCOLOR", request.bgcolor);
  if (request.time !== undefined) params.set("TIME", request.time);
  if (request.elevation !== undefined) params.set("ELEVATION", request.elevation);
  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, String(value));
    }
  }
  return params;
}

function decodeWmsFeatureInfoResponse<T>(
  bytes: Uint8Array,
  contentType: string,
  requestedFormat: string,
): HonuaWmsFeatureInfoResponse<T> {
  const isJson =
    contentType.toLowerCase().includes("application/json") ||
    requestedFormat.toLowerCase().includes("application/json");
  if (!isJson) {
    return { contentType, bytes };
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  if (text.length === 0) {
    return { contentType, features: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Server emitted a non-JSON body despite the JSON Accept; preserve as bytes.
    return { contentType, bytes };
  }
  const features = extractFeatureInfoFeatures<T>(parsed);
  return { contentType, features };
}

function extractFeatureInfoFeatures<T>(parsed: unknown): ReadonlyArray<import("./types.js").HonuaTypedFeature<T>> {
  if (!parsed || typeof parsed !== "object") return [];
  // honua-server emits `{ type: "FeatureInfoResponse", features: [{ layer, attributes }, ...] }`
  // and a fallback GeoJSON `{ type: "FeatureCollection", features: [...] }`; both decode here.
  const obj = parsed as Record<string, unknown>;
  const featuresRaw = Array.isArray(obj.features) ? obj.features : [];
  const out: import("./types.js").HonuaTypedFeature<T>[] = [];
  for (const raw of featuresRaw) {
    if (!raw || typeof raw !== "object") continue;
    const feat = raw as Record<string, unknown>;
    const attributes = (feat.attributes ?? feat.properties ?? {}) as T;
    const geometry = (feat.geometry as Record<string, unknown> | null | undefined) ?? null;
    out.push({ attributes, geometry });
  }
  return out;
}

const WMTS_FEATURE_INFO_FORMAT_TO_EXTENSION: ReadonlyMap<string, string> = new Map([
  ["application/json", "json"],
  ["text/plain", "txt"],
  ["text/html", "html"],
  ["application/geo+json", "geojson"],
]);

function wmtsFeatureInfoExtensionForFormat(format: string): string {
  return WMTS_FEATURE_INFO_FORMAT_TO_EXTENSION.get(format.toLowerCase()) ?? "txt";
}

const WMTS_REST_RESERVED_KEYS: ReadonlySet<string> = new Set([
  "service",
  "version",
  "request",
  "layer",
  "style",
  "format",
  "infoformat",
  "tilematrixset",
  "tilematrix",
  "tilerow",
  "tilecol",
  "i",
  "j",
]);

/**
 * Serialize `extraParams` for the RESTful WMTS routes. Path-encoded WMTS
 * keys take precedence — any extraParams whose key (case-insensitively)
 * matches a path-derived value is dropped so the same URL never carries
 * the value twice. Returns the query-string suffix to append (empty
 * string when there is nothing left after filtering).
 */
function wmtsRestExtraParamsSuffix(extraParams: Record<string, unknown> | undefined): string {
  if (!extraParams) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(extraParams)) {
    if (value === undefined || value === null) continue;
    if (WMTS_REST_RESERVED_KEYS.has(key.toLowerCase())) continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized.length > 0 ? `?${serialized}` : "";
}
