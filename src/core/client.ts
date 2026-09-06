import type { Client, Interceptor } from "@connectrpc/connect";
import type { FeatureService } from "../gen/geospatial/v1/feature_service_pb.js";
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
import {
  HONUA_MINIMUM_SUPPORTED_SERVER_VERSION,
  MINIMUM_SUPPORTED_SERVER_RELEASE_CHANNEL,
  describeCompatibilityError,
  evaluateCompatibility,
  parseCompatibilityEnvelope,
} from "./compatibility.js";
import { HonuaAbortError, HonuaHttpError, HonuaNetworkError, HonuaTimeoutError } from "./errors.js";
import {
  applyEdits,
  exportMap,
  findMap,
  getFeatureServiceMetadata,
  getLayerMetadata,
  getMapLayerMetadata,
  getMapLegend,
  getMapServiceMetadata,
  identifyMap,
  listServices,
  queryFeaturesRest,
  queryMapLayer,
  queryMapRelatedRecords,
  queryRelatedRecords,
} from "./geoservices.js";
import { HonuaOdataEntitySet } from "./odata.js";
import { type OgcApiLayoutMode, honuaFacadeFeaturesLayout, resolveOgcEndpointLayout } from "./ogc-endpoint-layout.js";
import {
  createOgcItem,
  deleteOgcItem,
  getOgcCollection,
  getOgcFeaturesConformance,
  getOgcFeaturesLanding,
  getOgcItem,
  getOgcQueryables,
  listOgcCollections,
  listOgcItems,
  patchOgcItem,
  replaceOgcItem,
} from "./ogc-features.js";
import { HonuaOgcMaps, getOgcMapImage, getOgcMapsConformance, getOgcMapsLanding } from "./ogc-maps.js";
import type { HonuaOgcProcessesOptions } from "./ogc-processes.js";
import {
  HonuaOgcProcesses,
  cancelOgcProcessJob,
  executeOgcProcess,
  getOgcProcess,
  getOgcProcessJob,
  getOgcProcessJobResults,
  getOgcProcessesConformance,
  getOgcProcessesLanding,
  listOgcProcesses,
} from "./ogc-processes.js";
import {
  HonuaOgcRecords,
  fetchOgcRecordRaw,
  fetchOgcRecordsRaw,
  getOgcRecord,
  getOgcRecordCollection,
  getOgcRecordsConformance,
  getOgcRecordsLanding,
  listOgcRecordCollections,
  searchOgcRecords,
} from "./ogc-records.js";
import {
  HonuaOgcTiles,
  fetchOgcTile,
  getOgcCollectionTileset,
  getOgcTileMatrixSet,
  getOgcTilesConformance,
  getOgcTilesLanding,
  listOgcCollectionTilesets,
  listOgcTileMatrixSets,
} from "./ogc-tiles.js";
import { stripQuery, trimTrailingSlashes } from "./path-utils.js";
import { decodePbfQueryResponse, isPbfResponse } from "./pbf-decoder.js";
import {
  type HonuaProcessRunner,
  createGeoServicesGpAdapter,
  createGeospatialGrpcProcessAdapter,
  createHonuaProcessRunner,
  createOgcProcessesAdapter,
} from "./process-runner.js";
import type { GeospatialGrpcProcessClient, HonuaProcessAdapter } from "./process-runner.js";
import type { HonuaProtocolTransport } from "./protocol-transport.js";
import {
  DEFAULT_RETRY_METHODS,
  type NormalizedRetryOptions,
  createTimeoutSignal,
  normalizeNetworkError,
  normalizeRetryOptions,
  normalizeTimeoutMs,
  resolveGrpcRetryDelayMs,
  resolveRetryDelayMs,
  shouldRetryGrpcCall,
  shouldRetryRequest,
  sleep,
  toGeoServicesError,
  toHttpError,
} from "./request-pipeline.js";
import {
  HonuaStacSearch,
  getStacCollection,
  getStacItem,
  getStacLanding,
  listStacCollections,
  searchStac,
} from "./stac.js";
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
  OgcEndpointLayout,
  OgcItemRequest,
  OgcItemsRequest,
  OgcMapImageRequest,
  OgcMetadataRequest,
  OgcPatchItemRequest,
  OgcProcessExecuteRequest,
  OgcProcessJobRequest,
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
import { mergeHeaders } from "./wire-shared.js";
import type { WmsCapabilities } from "./wms-capabilities.js";
import type {
  HonuaWmsFeatureInfoResponse,
  HonuaWmsImageResponse,
  HonuaWmtsFeatureInfoResponse,
  HonuaWmtsTileResponse,
  WmsFeatureInfoRequest,
  WmsLegendRequest,
  WmsMapRequest,
  WmtsFeatureInfoRequest,
  WmtsTileRequest,
} from "./wms-types.js";
import { HonuaWms, getWmsCapabilities, getWmsFeatureInfo, getWmsLegend, getWmsMap } from "./wms.js";
import type { WmtsCapabilities } from "./wmts-capabilities.js";
import { HonuaWmts, fetchWmtsTile, getWmtsCapabilities, getWmtsFeatureInfo } from "./wmts.js";

// Re-exported so the long-standing `@honua/sdk-js` public export path
// (`export { HONUA_MINIMUM_SUPPORTED_SERVER_VERSION } from "./core/client.js"`)
// is preserved now that the constant lives in the compatibility module.
export { HONUA_MINIMUM_SUPPORTED_SERVER_VERSION } from "./compatibility.js";

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

const DEFAULT_AUTH_REFRESH_SKEW_MS = 60_000;
const DEFAULT_METADATA_CACHE_MAX_ENTRIES = 256;

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
  /**
   * Low-level transport handed to the per-protocol wire modules. Binds the
   * client's private request primitives so each protocol family builds its own
   * URLs/params/parsing without reaching into the client.
   */
  private readonly protocolTransport: HonuaProtocolTransport;
  private serverCompatibilityCache: HonuaServerCompatibility | undefined;
  private authCredentialsCache: CachedAuthCredentials | undefined;
  private authRefreshPromise: Promise<CachedAuthCredentials | undefined> | undefined;
  private connectClient: Client<typeof FeatureService> | undefined;
  private connectClientPromise: Promise<Client<typeof FeatureService>> | undefined;
  private readonly metadataCache = new Map<string, MetadataCacheEntry>();
  private readonly ogcLayoutCache = new Map<OgcApiLayoutMode, Promise<OgcEndpointLayout>>();
  private readonly wfsRootCache = new Map<string, HonuaWfs>();

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
    this.protocolTransport = {
      baseUrl: this.baseUrl,
      requestJson: <T = unknown>(method: QueryMethod, path: string, init?: RequestInit, signal?: AbortSignal) =>
        this.requestJson(method, path, init, signal) as Promise<T>,
      requestText: (method, path, requestTextOptions) => this.requestText(method, path, requestTextOptions),
      requestBytes: (method, path, accept, init, signal) => this.requestBytes(method, path, accept, init, signal),
      requestCachedMetadataJson: <T>(cacheKey: string, path: string, metadataOptions?: HonuaMetadataRequestOptions) =>
        this.requestCachedMetadataJson<T>(cacheKey, path, metadataOptions),
      pipelineFetch: (method, path, init, callerSignal, pipelineOptions) =>
        this.pipelineFetch(method, path, init, callerSignal, pipelineOptions),
      requestBinaryWithJsonFallback: <T = unknown>(
        method: QueryMethod,
        path: string,
        params: URLSearchParams,
        signal?: AbortSignal,
      ) => this.requestBinaryWithJsonFallback(method, path, params, signal) as Promise<T>,
    };
  }

  /**
   * Connect interceptor that injects the same credentials the REST pipeline
   * uses (`apiKey`/`bearerToken` from {@link defaultHeaders} plus any provider
   * credentials resolved via {@link resolveAuthHeaders}) onto every gRPC-web
   * call. Without it the advertised `transport: "grpc-web"` path would send
   * every RPC unauthenticated.
   */
  private buildConnectAuthInterceptor(): Interceptor {
    return (next) => async (req) => {
      const headers = await this.composeHeaders();
      for (const [key, value] of Object.entries(headers)) {
        req.header.set(key, value);
      }
      return next(req);
    };
  }

  /**
   * Connect interceptor that applies the SDK's configured `retry` policy to
   * gRPC-web calls, mirroring the REST request pipeline. It retries only
   * replay-safe **unary** calls (server-streaming responses cannot be safely
   * replayed mid-iteration, the gRPC analog of the REST
   * {@link DEFAULT_RETRY_METHODS} idempotency gate) on the transient
   * {@link shouldRetryGrpcCall} status codes, backing off with the shared
   * exponential-with-jitter math (honoring any `retry-after` metadata) and
   * stopping immediately once the call's abort signal fires (caller abort or the
   * `timeoutMs` deadline). It wraps the auth interceptor so each attempt
   * re-resolves fresh credentials.
   */
  private buildConnectRetryInterceptor(): Interceptor {
    return (next) => async (req) => {
      // Only retry replay-safe unary calls; mirror REST idempotency scoping.
      if (req.stream || !this.retryOptions) {
        return next(req);
      }
      const retryOptions = this.retryOptions;
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await next(req);
        } catch (error) {
          const aborted = req.signal?.aborted === true;
          if (!shouldRetryGrpcCall(retryOptions, attempt, error, aborted)) {
            throw error;
          }
          await sleep(resolveGrpcRetryDelayMs(retryOptions, attempt, error), req.signal);
        }
      }
    };
  }

  /**
   * Shared gRPC-web transport options. The auth interceptor mirrors the REST
   * credential pipeline, the retry interceptor (when `retry` is configured)
   * applies the same retry/backoff policy as REST, and `defaultTimeoutMs`
   * honors the documented `timeoutMs` contract on every RPC (per-call abort
   * signals are threaded by the individual RPC methods).
   */
  private connectTransportOptions(): {
    baseUrl: string;
    fetch: typeof fetch;
    interceptors: Interceptor[];
    defaultTimeoutMs?: number;
  } {
    // Order matters: the retry interceptor must wrap the auth interceptor so
    // every replayed attempt re-runs auth and re-resolves credential headers.
    const interceptors: Interceptor[] = [this.buildConnectAuthInterceptor()];
    if (this.retryOptions) {
      interceptors.unshift(this.buildConnectRetryInterceptor());
    }
    return {
      baseUrl: this.baseUrl,
      fetch: this.fetchFn,
      interceptors,
      ...(this.timeoutMs !== undefined ? { defaultTimeoutMs: this.timeoutMs } : {}),
    };
  }

  private async ensureConnectClient(): Promise<Client<typeof FeatureService>> {
    if (this.connectClient) {
      return this.connectClient;
    }

    // Keep optional Connect peers out of the module graph until the first
    // gRPC operation is actually awaited. Caching the in-flight promise also
    // prevents concurrent first calls from constructing competing clients.
    let initPromise = this.connectClientPromise;
    if (!initPromise) {
      initPromise = Promise.all([
        import("@connectrpc/connect"),
        import("@connectrpc/connect-web"),
        import("../gen/geospatial/v1/feature_service_pb.js"),
      ]).then(([{ createClient }, { createGrpcWebTransport }, { FeatureService }]) => {
        const transport = createGrpcWebTransport(this.connectTransportOptions());
        this.connectClient = createClient(FeatureService, transport);
        return this.connectClient;
      });
      this.connectClientPromise = initPromise;
    }

    try {
      return await initPromise;
    } catch (error) {
      // A transient module-loader failure must not poison every later call.
      if (this.connectClientPromise === initPromise) {
        this.connectClientPromise = undefined;
      }
      throw error;
    }
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
  private async fetchWithSafeRedirects(
    url: string,
    init: RequestInit,
    redirectPolicy: "safe-follow" | "error" | "manual" = "safe-follow",
  ): Promise<Response> {
    let currentUrl = url;
    let currentInit: RequestInit = init;
    for (let redirects = 0; ; redirects += 1) {
      const response = await this.fetchFn(currentUrl, {
        ...currentInit,
        redirect: redirectPolicy === "error" ? "error" : "manual",
      });

      if (redirectPolicy === "error") {
        if (
          response.type === "opaqueredirect" ||
          response.redirected ||
          REDIRECT_STATUSES.has(response.status) ||
          (response.url !== "" && response.url !== currentUrl)
        ) {
          await response.body?.cancel().catch(() => undefined);
          throw new HonuaNetworkError("Redirects are not allowed for this bounded request.", undefined);
        }
        return response;
      }

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

      if (!REDIRECT_STATUSES.has(response.status)) return response;

      // Some bounded metadata callers need the untouched 3xx response so
      // their protocol facade can preserve its typed redirect diagnostic.
      // Credentials are still never replayed because fetch remains manual.
      if (redirectPolicy === "manual") return response;

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

  /**
   * Resolve the auth headers the client would attach to an outgoing request
   * right now, refreshing provider credentials first if they are expiring.
   *
   * Transports that build their own connection outside the REST/gRPC pipeline —
   * notably realtime SSE streams, which must re-authenticate on every
   * (re)connect so a refreshed token is picked up after a drop — call this per
   * connect to obtain fresh credentials. Returns an empty object when no
   * credentials are configured.
   */
  public async getAuthHeaders(): Promise<Record<string, string>> {
    return this.composeHeaders();
  }

  /**
   * Resolve just the current bearer/authorization token value (without the
   * `Bearer ` scheme prefix when a plain bearer token is configured), or
   * `undefined` if none. Convenience for realtime transports that must carry the
   * token as a query parameter (native `EventSource` cannot set headers).
   */
  public async getAuthToken(): Promise<string | undefined> {
    const headers = await this.composeHeaders();
    const authorization = headers.Authorization ?? headers.authorization;
    if (authorization) {
      return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : authorization;
    }
    return headers["X-API-Key"] ?? headers["x-api-key"];
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
    yield* grpcAdapter.streamProtoPages(
      client.queryFeaturesStream(protoRequest, request.signal ? { signal: request.signal } : undefined),
    );
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

  /**
   * Construct the OGC API Processes client wrapper.
   *
   * `basePath` pins every describe / execute / job route to a raw third-party
   * service root (as discovered by `discoverOgcProcesses()`); omitting it uses
   * the Honua facade prefix `/ogc/processes`. Pass the discovery result (or a
   * `/conformance` response) as `conformance` — and optionally
   * `capabilityPolicy: "strict"` — to gate execution and dismissal against what
   * the server actually declares.
   */
  public ogcProcesses(options: Omit<HonuaOgcProcessesOptions, "client"> = {}): HonuaOgcProcesses {
    return new HonuaOgcProcesses({ ...options, client: this });
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

  public ogcProcessRunner(options: Omit<HonuaOgcProcessesOptions, "client"> = {}): HonuaProcessRunner {
    return createHonuaProcessRunner(createOgcProcessesAdapter(this.ogcProcesses(options)));
  }

  public geoprocessingRunner(serviceId: string, taskName?: string): HonuaProcessRunner {
    return createHonuaProcessRunner(createGeoServicesGpAdapter(this.geoprocessing(serviceId, taskName)));
  }

  public geospatialGrpcProcessRunner(processClient: GeospatialGrpcProcessClient): HonuaProcessRunner {
    return createHonuaProcessRunner(createGeospatialGrpcProcessAdapter(processClient));
  }

  public wfs(endpointUrl = "/wfs", options: { version?: string } = {}): HonuaWfs {
    const version = options.version ?? "2.0.0";
    const key = `${endpointUrl}\u0000${version}`;
    const cached = this.wfsRootCache.get(key);
    if (cached) return cached;
    const root = new HonuaWfs({ client: this, endpointUrl, version });
    this.wfsRootCache.set(key, root);
    return root;
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
    return listServices(this.protocolTransport, format, metadataOptions);
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
    options: {
      okStatuses?: readonly number[];
      redirect?: "safe-follow" | "error" | "manual";
      discardErrorBody?: boolean;
      /**
       * Builds the body retained by `HonuaHttpError` for unsuccessful
       * responses. Bounded protocol clients use this hook to consume failure
       * bodies under the same byte ceiling as successful responses.
       */
      errorBody?: (response: Response, deadlineSignal: AbortSignal | undefined) => Promise<unknown>;
      /**
       * Invoked immediately before every physical fetch attempt, including
       * retry and replay-safe authentication attempts. Bounded callers use
       * this guard to reserve request and byte budgets before network I/O.
       */
      beforeAttempt?: (request: Readonly<HonuaRequestContext>, attempt: number) => void | Promise<void>;
      /**
       * Invoked before credential refresh or retry backoff can lead to another
       * physical request. Single-attempt binary lanes throw here so a response
       * that cannot be replayed never waits on work whose only purpose is replay.
       */
      beforeReplay?: (
        request: Readonly<HonuaRequestContext>,
        statusCode: number | undefined,
        reason: "authentication" | "retry",
      ) => void | Promise<void>;
      /**
       * Validate and replace a successful response before `after`
       * interceptors run. The callback remains inside the request timeout and
       * receives its combined caller/deadline signal. Bounded binary lanes use
       * this to consume the network stream under a hard ceiling, then return
       * an in-memory response that interceptors may inspect safely.
       */
      prepareResponse?: (response: Response, deadlineSignal: AbortSignal | undefined) => Promise<Response>;
    } = {},
  ): Promise<Response> {
    const request: HonuaRequestContext = {
      url: resolveRequestUrl(this.baseUrl, path),
      path,
      method,
      init: {
        ...init,
        method,
        headers: await this.composeHeaders(init?.headers),
        body: init?.body ?? null,
        ...(init?.signal ? { signal: init.signal } : {}),
      },
    };

    return this.executeRequest<Response>(request, {
      callerSignal,
      ...(options.okStatuses ? { okStatuses: options.okStatuses } : {}),
      ...(options.redirect ? { redirect: options.redirect } : {}),
      ...(options.beforeAttempt ? { beforeAttempt: options.beforeAttempt } : {}),
      ...(options.beforeReplay ? { beforeReplay: options.beforeReplay } : {}),
      ...(options.prepareResponse || options.errorBody ? { deadlineThroughFinalize: true } : {}),
      ...(options.errorBody
        ? { errorBody: options.errorBody }
        : options.discardErrorBody
          ? {
              errorBody: (response: Response) => {
                void response.body?.cancel().catch(() => undefined);
                return Promise.resolve({});
              },
            }
          : {}),
      finalize: async (response, _durationMs, _request, runAfter, deadlineSignal) => {
        const candidate = options.prepareResponse ? await options.prepareResponse(response, deadlineSignal) : response;
        const prepared = candidate === response ? response : preserveResponseSemantics(candidate, response);
        await runAfter(prepared);
        return prepared;
      },
    });
  }

  private async requestCachedMetadataJson<T>(
    cacheKey: string,
    path: string,
    options: HonuaMetadataRequestOptions = {},
  ): Promise<T> {
    const metadataOptions = normalizeHonuaMetadataRequestOptions(options);
    // A byte-bounded trust boundary must never reuse an entry populated by an
    // unbounded or more-permissive request. Partitioning preserves normal cache
    // reuse for callers that share the same ceiling without retaining bodies
    // that were admitted under different limits.
    const keyFingerprint = `metadata:${cacheKey}${
      metadataOptions.maxResponseBytes === undefined ? "" : `:max-response-bytes:${metadataOptions.maxResponseBytes}`
    }`;
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

    const request: HonuaRequestContext = {
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

    return this.executeRequest<T>(request, {
      callerSignal: metadataOptions.signal,
      // stale-if-error fallback on a terminal network or HTTP failure.
      onTerminalError: (error) => this.staleMetadataFallback(cached, metadataOptions, error),
      // 304 Not Modified: revalidate the cached entry without re-parsing a body.
      shortCircuit: async (response, _durationMs, _currentRequest, runAfter) => {
        if (response.status !== 304 || !cached || bypass) {
          return undefined;
        }
        await runAfter();
        const updatedEntry: MetadataCacheEntry<T> = {
          ...cached,
          cachedAtMs: Date.now(),
          ...((honuaCacheValidatorFromHeaders(response.headers) ?? cached.validator)
            ? { validator: honuaCacheValidatorFromHeaders(response.headers) ?? cached.validator }
            : {}),
        };
        this.setMetadataCacheEntry(keyFingerprint, updatedEntry);
        return {
          value: withHonuaCacheState(
            updatedEntry.body,
            createMetadataCacheState(updatedEntry, "refreshed", {
              now: Date.now(),
              ttlMs: metadataOptions.ttlMs,
              staleIfErrorMs: metadataOptions.staleIfErrorMs,
              revalidatedAt: new Date().toISOString(),
            }),
          ),
        };
      },
      finalize: async (response, durationMs, currentRequest, runAfter) => {
        const body = await parseResponseBody(
          this.hasAfterInterceptors() ? response.clone() : response,
          metadataOptions.maxResponseBytes,
        );

        // GeoServices reports metadata failures (layer not found, invalid token
        // => code 499, …) as HTTP 200 with a top-level `{error}` envelope.
        // Detect it before caching so a transient auth/permission error is never
        // persisted as "valid" metadata for the cache TTL and surfaced
        // downstream as `undefined` field access instead of a HonuaHttpError.
        const envelopeError = toGeoServicesError(response.status, body, response.headers);
        if (envelopeError) {
          const stale = this.staleMetadataFallback(cached, metadataOptions, envelopeError);
          if (stale) return stale;
          await this.applyErrorInterceptors({
            request: cloneRequestContext(currentRequest),
            error: envelopeError,
            durationMs,
          });
          throw envelopeError;
        }

        await runAfter();

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
      },
    });
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
    return getLayerMetadata(this.protocolTransport, serviceId, layerId, options);
  }

  public async getFeatureServiceMetadata(
    serviceId: string,
    options: HonuaMetadataRequestOptions = {},
  ): Promise<HonuaServiceMetadata> {
    return getFeatureServiceMetadata(this.protocolTransport, serviceId, options);
  }

  /**
   * Resolve (and memoize) the OGC API Features endpoint layout for the
   * given discovery `mode`. `honua-facade` (default) returns the fixed
   * `/ogc/features/...` fast path with no network access; `ogc-api` and
   * `auto` discover the layout from the server's landing page per OGC API
   * - Common so the same typed surface works against pygeoapi / ldproxy /
   * GeoServer. Discovery is cached per mode for the life of the client
   * (the layout is a function of the fixed `baseUrl`).
   */
  public resolveOgcFeaturesLayout(mode: OgcApiLayoutMode = "honua-facade"): Promise<OgcEndpointLayout> {
    if (mode === "honua-facade") return Promise.resolve(honuaFacadeFeaturesLayout());
    let cached = this.ogcLayoutCache.get(mode);
    if (!cached) {
      cached = resolveOgcEndpointLayout(this.protocolTransport, mode).catch((err) => {
        // Allow a later retry after a transient discovery failure.
        this.ogcLayoutCache.delete(mode);
        throw err;
      });
      this.ogcLayoutCache.set(mode, cached);
    }
    return cached;
  }

  public async getOgcFeaturesLanding(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    return getOgcFeaturesLanding(this.protocolTransport, request);
  }

  public async getOgcFeaturesConformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    return getOgcFeaturesConformance(this.protocolTransport, request);
  }

  public async listOgcCollections(request: OgcMetadataRequest = {}): Promise<HonuaOgcCollectionsResponse> {
    return listOgcCollections(this.protocolTransport, request);
  }

  public async getOgcCollection(request: OgcCollectionRequest): Promise<HonuaOgcCollectionMetadata> {
    return getOgcCollection(this.protocolTransport, request);
  }

  public async getOgcQueryables(request: OgcCollectionRequest): Promise<HonuaOgcQueryablesResponse> {
    return getOgcQueryables(this.protocolTransport, request);
  }

  public async listOgcItems(request: OgcItemsRequest): Promise<HonuaOgcFeatureCollectionResponse> {
    return listOgcItems(this.protocolTransport, request);
  }

  public async getOgcItem(request: OgcItemRequest): Promise<HonuaOgcFeatureResponse> {
    return getOgcItem(this.protocolTransport, request);
  }

  public async createOgcItem(request: OgcCreateItemRequest): Promise<HonuaOgcFeatureResponse> {
    return createOgcItem(this.protocolTransport, request);
  }

  public async replaceOgcItem(request: OgcReplaceItemRequest): Promise<HonuaOgcFeatureResponse> {
    return replaceOgcItem(this.protocolTransport, request);
  }

  public async patchOgcItem(request: OgcPatchItemRequest): Promise<HonuaOgcFeatureResponse> {
    return patchOgcItem(this.protocolTransport, request);
  }

  public async deleteOgcItem(request: OgcDeleteItemRequest): Promise<void> {
    await deleteOgcItem(this.protocolTransport, request);
  }

  // ── OGC API Tiles ───────────────────────────────────────────

  public async getOgcTilesLanding(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    return getOgcTilesLanding(this.protocolTransport, request);
  }

  public async getOgcTilesConformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    return getOgcTilesConformance(this.protocolTransport, request);
  }

  public async listOgcTileMatrixSets(request: OgcMetadataRequest = {}): Promise<HonuaOgcTileMatrixSetsResponse> {
    return listOgcTileMatrixSets(this.protocolTransport, request);
  }

  public async getOgcTileMatrixSet(
    request: {
      tileMatrixSetId: string;
      responseFormat?: string;
      extraParams?: Record<string, string | number | boolean>;
    } & HonuaMetadataRequestOptions,
  ): Promise<HonuaOgcTileMatrixSet> {
    return getOgcTileMatrixSet(this.protocolTransport, request);
  }

  public async listOgcCollectionTilesets(request: OgcTilesetsRequest): Promise<HonuaOgcTilesetsResponse> {
    return listOgcCollectionTilesets(this.protocolTransport, request);
  }

  public async getOgcCollectionTileset(request: OgcTilesetRequest): Promise<HonuaOgcTilesetMetadata> {
    return getOgcCollectionTileset(this.protocolTransport, request);
  }

  public async fetchOgcTile(request: OgcTileRequest): Promise<HonuaOgcTileResponse> {
    return fetchOgcTile(this.protocolTransport, request);
  }

  // ── OGC API Maps ────────────────────────────────────────────

  public async getOgcMapsLanding(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    return getOgcMapsLanding(this.protocolTransport, request);
  }

  public async getOgcMapsConformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    return getOgcMapsConformance(this.protocolTransport, request);
  }

  public async getOgcMapImage(request: OgcMapImageRequest): Promise<HonuaOgcMapImageResponse> {
    return getOgcMapImage(this.protocolTransport, request);
  }

  // ── OGC API Records ────────────────────────────────────────

  public async getOgcRecordsLanding(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    return getOgcRecordsLanding(this.protocolTransport, request);
  }

  public async getOgcRecordsConformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    return getOgcRecordsConformance(this.protocolTransport, request);
  }

  public async listOgcRecordCollections(request: OgcMetadataRequest = {}): Promise<HonuaOgcCollectionsResponse> {
    return listOgcRecordCollections(this.protocolTransport, request);
  }

  public async getOgcRecordCollection(request: OgcCollectionRequest): Promise<HonuaOgcCollectionMetadata> {
    return getOgcRecordCollection(this.protocolTransport, request);
  }

  public async searchOgcRecords(request: OgcRecordsSearchRequest): Promise<HonuaOgcRecordsResponse> {
    return searchOgcRecords(this.protocolTransport, request);
  }

  public async getOgcRecord(request: OgcRecordItemRequest): Promise<HonuaOgcRecordResponse> {
    return getOgcRecord(this.protocolTransport, request);
  }

  public async fetchOgcRecordsRaw(request: OgcRecordsRawSearchRequest): Promise<Response> {
    return fetchOgcRecordsRaw(this.protocolTransport, request);
  }

  public async fetchOgcRecordRaw(request: OgcRecordRawItemRequest): Promise<Response> {
    return fetchOgcRecordRaw(this.protocolTransport, request);
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
    return getWmsCapabilities(this.protocolTransport, request);
  }

  /** Render a WMS `GetMap`. Returns the raw image bytes. */
  public async getWmsMap(request: { serviceId: string } & WmsMapRequest): Promise<HonuaWmsImageResponse> {
    return getWmsMap(this.protocolTransport, request);
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
    return getWmsFeatureInfo<T>(this.protocolTransport, request);
  }

  /**
   * Fetch a WMS `GetLegendGraphic`. honua-server does not implement
   * GetLegendGraphic today; callers should branch on
   * `WmsCapabilities.request.getLegendGraphic` before invoking. When
   * the wire returns 5xx the underlying `HonuaHttpError` flows through.
   */
  public async getWmsLegend(request: { serviceId: string } & WmsLegendRequest): Promise<HonuaWmsImageResponse> {
    return getWmsLegend(this.protocolTransport, request);
  }

  // ── WMTS 1.0 ────────────────────────────────────────────────

  public async getWmtsCapabilities(request: {
    serviceId: string;
    signal?: AbortSignal;
  }): Promise<WmtsCapabilities> {
    return getWmtsCapabilities(this.protocolTransport, request);
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
    return fetchWmtsTile(this.protocolTransport, request);
  }

  /**
   * WMTS GetFeatureInfo. honua-server accepts both KVP and RESTful
   * routing; mode default mirrors `fetchWmtsTile`.
   */
  public async getWmtsFeatureInfo<T = Record<string, unknown>>(
    request: { serviceId: string } & WmtsFeatureInfoRequest,
  ): Promise<HonuaWmtsFeatureInfoResponse<T>> {
    return getWmtsFeatureInfo<T>(this.protocolTransport, request);
  }

  // ── OGC API Processes ───────────────────────────────────────

  public async getOgcProcessesLanding(request: OgcMetadataRequest = {}): Promise<HonuaOgcLandingResponse> {
    return getOgcProcessesLanding(this.protocolTransport, request);
  }

  public async getOgcProcessesConformance(request: OgcMetadataRequest = {}): Promise<HonuaOgcConformanceResponse> {
    return getOgcProcessesConformance(this.protocolTransport, request);
  }

  public async listOgcProcesses(request: OgcMetadataRequest = {}): Promise<HonuaOgcProcessesResponse> {
    return listOgcProcesses(this.protocolTransport, request);
  }

  public async getOgcProcess(request: { processId: string } & OgcMetadataRequest): Promise<HonuaOgcProcessDescription> {
    return getOgcProcess(this.protocolTransport, request);
  }

  public async executeOgcProcess(request: OgcProcessExecuteRequest): Promise<HonuaOgcProcessJobAccepted> {
    return executeOgcProcess(this.protocolTransport, request);
  }

  public async getOgcProcessJob(request: OgcProcessJobRequest): Promise<HonuaOgcProcessJobStatus> {
    return getOgcProcessJob(this.protocolTransport, request);
  }

  public async getOgcProcessJobResults(request: OgcProcessJobRequest): Promise<HonuaOgcProcessJobResults> {
    return getOgcProcessJobResults(this.protocolTransport, request);
  }

  public async cancelOgcProcessJob(request: OgcProcessJobRequest): Promise<HonuaOgcProcessJobStatus> {
    return cancelOgcProcessJob(this.protocolTransport, request);
  }

  // ── STAC API ────────────────────────────────────────────────

  public async getStacLanding(request: OgcMetadataRequest = {}): Promise<HonuaStacLandingResponse> {
    return getStacLanding(this.protocolTransport, request);
  }

  public async listStacCollections(request: OgcMetadataRequest = {}): Promise<HonuaOgcCollectionsResponse> {
    return listStacCollections(this.protocolTransport, request);
  }

  public async getStacCollection(request: OgcCollectionRequest): Promise<HonuaOgcCollectionMetadata> {
    return getStacCollection(this.protocolTransport, request);
  }

  public async getStacItem(request: {
    collectionId: string | number;
    itemId: string | number;
    signal?: AbortSignal;
    responseFormat?: string;
    extraParams?: Record<string, string | number | boolean>;
  }): Promise<HonuaStacItemResponse> {
    return getStacItem(this.protocolTransport, request);
  }

  public async searchStac(request: StacSearchRequest = {}): Promise<HonuaStacItemCollectionResponse> {
    return searchStac(this.protocolTransport, request);
  }

  public async getMapServiceMetadata(
    serviceId: string,
    options: HonuaMetadataRequestOptions = {},
  ): Promise<HonuaServiceMetadata> {
    return getMapServiceMetadata(this.protocolTransport, serviceId, options);
  }

  public async getMapLayerMetadata(
    serviceId: string,
    layerId: number,
    options: HonuaMetadataRequestOptions = {},
  ): Promise<HonuaLayerMetadata> {
    return getMapLayerMetadata(this.protocolTransport, serviceId, layerId, options);
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
        const response = await client.queryFeatures(
          protoRequest,
          request.signal ? { signal: request.signal } : undefined,
        );
        return grpcAdapter.fromProtoQueryResponse(response) as HonuaQueryResponse;
      } catch (error) {
        throw grpcAdapter.wrapConnectError(error);
      }
    }

    return queryFeaturesRest(this.protocolTransport, request, this.preferBinary);
  }

  public async queryMapLayer(request: MapLayerQueryRequest): Promise<HonuaQueryResponse> {
    return queryMapLayer(this.protocolTransport, request);
  }

  public async applyEdits(request: ApplyEditsRequest): Promise<HonuaApplyEditsResponse> {
    return applyEdits(this.protocolTransport, request);
  }

  public async queryRelatedRecords(request: QueryRelatedRecordsRequest): Promise<HonuaRelatedRecordsResponse> {
    return queryRelatedRecords(this.protocolTransport, request);
  }

  public async queryMapRelatedRecords(request: MapRelatedRecordsRequest): Promise<HonuaRelatedRecordsResponse> {
    return queryMapRelatedRecords(this.protocolTransport, request);
  }

  public async exportMap(request: ExportMapRequest): Promise<HonuaExportMapResponse> {
    return exportMap(this.protocolTransport, request);
  }

  public async getMapLegend(request: MapLegendRequest): Promise<HonuaLegendResponse> {
    return getMapLegend(this.protocolTransport, request);
  }

  public async identifyMap(request: MapIdentifyRequest): Promise<HonuaIdentifyResponse> {
    return identifyMap(this.protocolTransport, request);
  }

  public async findMap(request: MapFindRequest): Promise<HonuaFindResponse> {
    return findMap(this.protocolTransport, request);
  }

  private async requestJson(
    method: QueryMethod,
    path: string,
    init?: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const request: HonuaRequestContext = {
      url: resolveRequestUrl(this.baseUrl, path),
      path,
      method,
      init: {
        method,
        headers: await this.composeHeaders({ Accept: "application/json" }, init?.headers),
        body: init?.body,
      },
    };

    return this.executeRequest<unknown>(request, {
      callerSignal,
      finalize: async (response, durationMs, currentRequest, runAfter) => {
        // Parse the original body directly when no after-interceptor will read
        // it; only clone when an interceptor needs an independent copy.
        const body = await parseResponseBody(this.hasAfterInterceptors() ? response.clone() : response);

        // GeoServices/Esri services return HTTP 200 with a top-level `{error}`
        // envelope on failure (bad WHERE, invalid outFields, edit failures, …).
        // Surface these through the unified error model instead of handing the
        // failure envelope back as a "successful" response object.
        const envelopeError = toGeoServicesError(response.status, body, response.headers);
        if (envelopeError) {
          await this.applyErrorInterceptors({
            request: cloneRequestContext(currentRequest),
            error: envelopeError,
            durationMs,
          });
          throw envelopeError;
        }

        await runAfter();
        return body;
      },
    });
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
    const request: HonuaRequestContext = {
      url: resolveRequestUrl(this.baseUrl, path),
      path,
      method,
      init: {
        method,
        headers: await this.composeHeaders({ Accept: "application/x-protobuf, application/json;q=0.9" }),
      },
    };

    return this.executeRequest<unknown>(request, {
      callerSignal,
      finalize: async (response, durationMs, currentRequest, runAfter) => {
        await runAfter();

        // If the server returned PBF, decode it; on decode failure (including
        // Z/M geometry the fast path can't handle) retry as f=json.
        if (isPbfResponse(response)) {
          try {
            const buffer = await response.arrayBuffer();
            return decodePbfQueryResponse(buffer);
          } catch {
            params.set("f", "json");
            const jsonPath = `${stripQuery(path)}?${params.toString()}`;
            return this.requestJson(
              "GET",
              jsonPath,
              undefined,
              callerSignal ?? currentRequest.init.signal ?? undefined,
            );
          }
        }

        // Server returned JSON despite the PBF request (e.g. error or
        // unsupported). GeoServices reports query failures (bad WHERE, invalid
        // outFields, expired token => code 498/499) as HTTP 200 application/json
        // even when f=pbf was requested. Detect the `{error}` envelope here so
        // preferBinary callers throw a normalized HonuaHttpError exactly like
        // the JSON path instead of receiving the failure envelope as success.
        const body = await parseResponseBody(response);
        const envelopeError = toGeoServicesError(response.status, body, response.headers);
        if (envelopeError) {
          await this.applyErrorInterceptors({
            request: cloneRequestContext(currentRequest),
            error: envelopeError,
            durationMs,
          });
          throw envelopeError;
        }
        return body;
      },
    });
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
    options?: {
      accept?: string;
      contentType?: string;
      body?: BodyInit;
      signal?: AbortSignal;
      /** Maximum response-body bytes accepted before text decoding/parsing. */
      maxResponseBytes?: number;
    },
  ): Promise<{ text: string; contentType: string; status: number }> {
    if (
      options?.maxResponseBytes !== undefined &&
      (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0)
    ) {
      throw new TypeError("maxResponseBytes must be a positive safe integer.");
    }
    const acceptHeader = options?.accept ?? "*/*";
    const headers: Record<string, string> = { Accept: acceptHeader };
    if (options?.contentType) headers["Content-Type"] = options.contentType;
    const request: HonuaRequestContext = {
      url: resolveRequestUrl(this.baseUrl, path),
      path,
      method,
      init: {
        method,
        headers: await this.composeHeaders(headers),
        ...(options?.body !== undefined ? { body: options.body } : {}),
      },
    };

    return this.executeRequest<{ text: string; contentType: string; status: number }>(request, {
      callerSignal: options?.signal,
      deadlineThroughFinalize: options?.maxResponseBytes !== undefined,
      errorBody: async (response, deadlineSignal) => {
        const clone = response.clone();
        const text =
          options?.maxResponseBytes === undefined
            ? await clone.text()
            : new TextDecoder().decode(await readBoundedResponseBytes(clone, options.maxResponseBytes, deadlineSignal));
        const contentType = response.headers.get("content-type") ?? acceptHeader;
        return text ? { raw: text, contentType } : {};
      },
      finalize: async (response, _durationMs, _request, runAfter, deadlineSignal) => {
        if (options?.maxResponseBytes === undefined) {
          await runAfter();
          const text = await response.text();
          const contentType = response.headers.get("content-type") ?? acceptHeader;
          return { text, contentType, status: response.status };
        }
        const bytes = await readBoundedResponseBytes(response, options.maxResponseBytes, deadlineSignal);
        const prepared = preserveResponseSemantics(bufferedResponse(response, bytes), response);
        await runAfter(prepared);
        const text = new TextDecoder().decode(bytes);
        const contentType = response.headers.get("content-type") ?? acceptHeader;
        return { text, contentType, status: response.status };
      },
    });
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
    const request: HonuaRequestContext = {
      url: resolveRequestUrl(this.baseUrl, path),
      path,
      method,
      init: {
        method,
        headers: await this.composeHeaders({ Accept: acceptHeader }, init?.headers),
        body: init?.body,
      },
    };

    return this.executeRequest<{ bytes: Uint8Array; contentType: string; empty: boolean }>(request, {
      callerSignal,
      finalize: async (response, _durationMs, _request, runAfter) => {
        await runAfter();
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        return {
          bytes,
          contentType: response.headers.get("content-type") ?? acceptHeader,
          empty: response.status === 204 || bytes.byteLength === 0,
        };
      },
    });
  }

  /**
   * Single owner of the HTTP attempt loop shared by every typed request
   * wrapper: before-interceptors, per-attempt timeout, network-error
   * normalization + retry, replay-safe auth refresh, HTTP-status retry, and the
   * after/error-interceptor calls. The previous implementation copy-pasted this
   * loop across six methods (pipelineFetch / requestCachedMetadataJson /
   * requestJson / requestBinaryWithJsonFallback / requestText / requestBytes),
   * and the copies had drifted in signal, okStatuses, and 304 handling — the
   * exact surface where an auth-replay / retry regression can appear in one
   * transport but not the others.
   *
   * Wrappers supply only what differs:
   * - `finalize` turns a successful `Response` into the wrapper's `T`. It is
   *   handed a `runAfter` thunk so it controls *when* after-interceptors fire
   *   (e.g. before vs. after a GeoServices error-envelope check) and can parse
   *   the original body without a defensive clone (see `hasAfterInterceptors`).
   * - `shortCircuit` (optional) inspects the response before the ok/!ok split,
   *   e.g. a metadata `304 Not Modified`.
   * - `okStatuses` (optional) treats specific non-2xx statuses as success.
   * - `errorBody` (optional) builds the body fed to `toHttpError` on failure.
   * - `onTerminalError` (optional) yields a fallback value instead of throwing
   *   on a terminal network/HTTP error, e.g. stale-if-error metadata.
   */
  private async executeRequest<T>(
    initialRequest: HonuaRequestContext,
    options: {
      callerSignal?: AbortSignal;
      okStatuses?: readonly number[];
      redirect?: "safe-follow" | "error" | "manual";
      beforeAttempt?: (request: Readonly<HonuaRequestContext>, attempt: number) => void | Promise<void>;
      beforeReplay?: (
        request: Readonly<HonuaRequestContext>,
        statusCode: number | undefined,
        reason: "authentication" | "retry",
      ) => void | Promise<void>;
      deadlineThroughFinalize?: boolean;
      errorBody?: (response: Response, deadlineSignal: AbortSignal | undefined) => Promise<unknown>;
      shortCircuit?: (
        response: Response,
        durationMs: number,
        request: HonuaRequestContext,
        runAfter: (preparedResponse?: Response) => Promise<void>,
      ) => Promise<{ value: T } | undefined>;
      onTerminalError?: (error: unknown) => T | undefined;
      finalize: (
        response: Response,
        durationMs: number,
        request: HonuaRequestContext,
        runAfter: (preparedResponse?: Response) => Promise<void>,
        deadlineSignal: AbortSignal | undefined,
      ) => Promise<T>;
    },
  ): Promise<T> {
    let request = await this.applyBeforeInterceptors(initialRequest);
    const retrySignal = options.callerSignal ?? request.init.signal ?? undefined;
    let refreshedAuth = false;

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      await options.beforeAttempt?.(cloneRequestContext(request), attempt);
      const timeout = createTimeoutSignal(options.callerSignal ?? request.init.signal, this.timeoutMs);
      const startTime = performance.now();
      let fetchCompleted = false;
      try {
        response = await this.fetchWithSafeRedirects(
          request.url,
          {
            ...request.init,
            method: request.method,
            signal: timeout.signal,
          },
          options.redirect,
        );
        fetchCompleted = true;
      } catch (error) {
        const durationMs = performance.now() - startTime;
        const normalizedError = timeout.didTimeout
          ? new HonuaTimeoutError(this.timeoutMs ?? 0)
          : normalizeNetworkError(error);
        if (shouldRetryRequest(this.retryOptions, request.method, attempt, undefined, normalizedError)) {
          await options.beforeReplay?.(cloneRequestContext(request), undefined, "retry");
          await this.sleepBeforeRetry(attempt, undefined, retrySignal);
          continue;
        }
        const fallback = options.onTerminalError?.(normalizedError);
        if (fallback !== undefined) return fallback;
        await this.applyErrorInterceptors({
          request: cloneRequestContext(request),
          error: normalizedError,
          durationMs,
        });
        throw normalizedError;
      } finally {
        if (!fetchCompleted || !options.deadlineThroughFinalize) timeout.dispose();
      }
      const durationMs = performance.now() - startTime;
      const currentRequest = request;
      let terminalErrorNotification:
        | {
            readonly completion: Promise<void>;
          }
        | undefined;
      const beginTerminalErrorNotification = (
        error: unknown,
        errorDurationMs: number,
      ): { readonly claimed: boolean; readonly completion: Promise<void> } => {
        if (terminalErrorNotification) {
          return { claimed: false, completion: terminalErrorNotification.completion };
        }
        const completion = this.applyErrorInterceptorsConcurrently({
          request: cloneRequestContext(currentRequest),
          error,
          durationMs: errorDurationMs,
        });
        terminalErrorNotification = { completion };
        return { claimed: true, completion };
      };
      const awaitDeadlineOwned = async <R>(operation: Promise<R>): Promise<R> => {
        const owned = operation.catch(async (error: unknown) => {
          const notification = beginTerminalErrorNotification(error, performance.now() - startTime);
          if (notification.claimed) {
            await notification.completion;
          }
          throw error;
        });
        return await awaitAbortable(owned, timeout.signal);
      };
      const runAfter = async (preparedResponse: Response = response): Promise<void> => {
        try {
          await this.applyAfterInterceptors(
            cloneRequestContext(currentRequest),
            preparedResponse,
            durationMs,
            options.deadlineThroughFinalize ? timeout.signal : undefined,
          );
        } catch (error) {
          if (options.deadlineThroughFinalize) throw error;
          await this.applyErrorInterceptors({ request: cloneRequestContext(currentRequest), error, durationMs });
          throw error;
        }
      };

      try {
        if (options.shortCircuit) {
          const shorted = await options.shortCircuit(response, durationMs, currentRequest, runAfter);
          if (shorted) return shorted.value;
        }

        if (!response.ok && !options.okStatuses?.includes(response.status)) {
          const body = options.errorBody
            ? await options.errorBody(response, options.deadlineThroughFinalize ? timeout.signal : undefined)
            : await parseResponseBody(response.clone());
          const httpError = toHttpError(response.status, body, response.headers);
          if (
            !refreshedAuth &&
            (response.status === 401 || response.status === 403) &&
            this.authProvider &&
            DEFAULT_RETRY_METHODS.has(request.method)
          ) {
            await options.beforeReplay?.(cloneRequestContext(request), response.status, "authentication");
          }
          const authRefreshedRequest = refreshedAuth
            ? undefined
            : await this.refreshReplaySafeRequestAuth(request, response.status);
          if (authRefreshedRequest) {
            request = authRefreshedRequest;
            refreshedAuth = true;
            continue;
          }
          if (shouldRetryRequest(this.retryOptions, request.method, attempt, response.status, httpError)) {
            await options.beforeReplay?.(cloneRequestContext(request), response.status, "retry");
            await this.sleepBeforeRetry(attempt, response, retrySignal);
            continue;
          }
          const fallback = options.onTerminalError?.(httpError);
          if (fallback !== undefined) return fallback;
          if (options.deadlineThroughFinalize) {
            return await awaitDeadlineOwned<T>(Promise.reject(httpError));
          }
          await this.applyErrorInterceptors({ request: cloneRequestContext(request), error: httpError, durationMs });
          throw httpError;
        }

        const finalized = options.finalize(response, durationMs, currentRequest, runAfter, timeout.signal);
        return await (options.deadlineThroughFinalize ? awaitDeadlineOwned(finalized) : finalized);
      } catch (error) {
        if (!options.deadlineThroughFinalize || !timeout.signal?.aborted) throw error;
        const terminalError = timeout.didTimeout ? new HonuaTimeoutError(this.timeoutMs ?? 0) : new HonuaAbortError();
        beginTerminalErrorNotification(terminalError, performance.now() - startTime);
        throw terminalError;
      } finally {
        if (options.deadlineThroughFinalize) timeout.dispose();
      }
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
    deadlineSignal?: AbortSignal,
  ): Promise<void> {
    for (const interceptor of this.interceptors) {
      // Only clone the response for interceptors that actually inspect it. This
      // keeps the no-after-interceptor hot path free of `Response.clone()` (so
      // typed wrappers can parse the original body directly) and avoids cloning
      // for `before`/`error`-only interceptors.
      if (!interceptor.after) {
        continue;
      }
      if (deadlineSignal?.aborted) throw new HonuaAbortError();
      const context: HonuaResponseContext = {
        request: cloneRequestContext(request),
        response: response.clone(),
        durationMs,
      };
      await interceptor.after(context);
      if (deadlineSignal?.aborted) throw new HonuaAbortError();
    }
  }

  /** Whether any registered interceptor inspects responses (`after` hook). */
  private hasAfterInterceptors(): boolean {
    return this.interceptors.some((interceptor) => interceptor.after !== undefined);
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

  /**
   * Start every terminal error hook independently so one nonsettling hook
   * cannot prevent later hooks from observing the same failure. Each hook is
   * contained so a detached deadline notification can never reject unhandled.
   */
  private async applyErrorInterceptorsConcurrently(context: HonuaErrorContext): Promise<void> {
    await Promise.all(
      this.interceptors.map(async (interceptor) => {
        try {
          await interceptor.error?.(context);
        } catch {
          // Preserve the terminal request failure; interceptor failures should not mask it.
        }
      }),
    );
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

  private async sleepBeforeRetry(attempt: number, response: Response | undefined, signal: AbortSignal | undefined) {
    await sleep(resolveRetryDelayMs(this.retryOptions, attempt, response), signal);
  }
}

/**
 * Detect a GeoServices/Esri error envelope returned on an HTTP 2xx response.
 *
 * GeoServices services (FeatureServer/MapServer/GeocodeServer/…) report
 * operation failures as HTTP 200 with a body of the shape
 * `{ error: { code, message, ... } }`. Without this guard such failures are
 * cast verbatim to the success response type and surface downstream as empty
 * results or confusing `undefined` access. Returns a normalized
 * {@link HonuaHttpError} when the envelope is present, otherwise `undefined`.
 */
async function parseResponseBody(response: Response, maxResponseBytes?: number): Promise<unknown> {
  const text =
    maxResponseBytes === undefined
      ? await response.text()
      : new TextDecoder().decode(await readBoundedResponseBytes(response, maxResponseBytes));
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

async function readBoundedResponseBytes(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw new HonuaAbortError();
  }
  const advertised = response.headers.get("content-length");
  if (advertised !== null) {
    const length = Number(advertised);
    if (Number.isFinite(length) && length > maximum) {
      void response.body?.cancel().catch(() => undefined);
      throw new HonuaNetworkError(`Response body exceeds the configured ${maximum}-byte limit.`, undefined);
    }
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new HonuaAbortError();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new HonuaAbortError();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        void reader.cancel().catch(() => undefined);
        throw new HonuaNetworkError(`Response body exceeds the configured ${maximum}-byte limit.`, undefined);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (signal?.aborted) throw new HonuaAbortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
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

function bufferedResponse(source: Response, bytes: Uint8Array): Response {
  const body = source.status === 204 || source.status === 205 || source.status === 304 ? null : bytes.slice();
  return new Response(body, {
    status: source.status,
    statusText: source.statusText,
    headers: source.headers,
  });
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

function awaitAbortable<T>(value: T | Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const pending = Promise.resolve(value);
  if (!signal) return pending;
  if (signal.aborted) {
    void pending.catch(() => undefined);
    return Promise.reject(new HonuaAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(new HonuaAbortError()));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

interface PreservedResponseSemantics {
  readonly url: string;
  readonly type: Response["type"];
  readonly redirected: boolean;
}

/**
 * A response prepared under a tighter body boundary still represents the same
 * physical fetch. Preserve the fetch-owned semantic properties for public
 * interceptors and for every defensive clone they receive.
 */
function preserveResponseSemantics(response: Response, source: Response): Response {
  return decorateResponseSemantics(
    response,
    Object.freeze({
      url: source.url,
      type: source.type,
      redirected: source.redirected,
    }),
  );
}

function decorateResponseSemantics(response: Response, semantics: PreservedResponseSemantics): Response {
  const nativeClone = response.clone.bind(response);
  Object.defineProperties(response, {
    url: { configurable: true, value: semantics.url },
    type: { configurable: true, value: semantics.type },
    redirected: { configurable: true, value: semantics.redirected },
    clone: {
      configurable: true,
      value: () => decorateResponseSemantics(nativeClone(), semantics),
    },
  });
  return response;
}

function cloneHeadersInit(headers: HeadersInit | undefined): HeadersInit {
  return mergeHeaders(headers);
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
