/**
 * Normalized discovery for Honua deployments and direct cloud-native assets.
 *
 * The returned document is data-only and can be serialized for build-time
 * source selection, diagnostics, or a source-picker UI. Discovery follows
 * links advertised by the deployment manifest and never probes derived source
 * endpoints.
 *
 * @experimental
 * @packageDocumentation
 */

import {
  HonuaAbortError,
  HonuaDiscoveryError,
  HonuaHttpError,
  HonuaNetworkError,
  isHonuaError,
} from "../core/errors.js";
import type {
  HonuaAuthCredentials,
  HonuaAuthCredentialsProvider,
  HonuaAuthProvider,
  HonuaRequestContext,
  HonuaRequestInterceptor,
} from "../core/types.js";
import { rasterDiscoveryRegistryEntry } from "../raster/source-registry.js";

export const HONUA_CLOUD_NATIVE_DISCOVERY_FORMAT = "honua.cloud-native-discovery.v1";
export const HONUA_CLOUD_NATIVE_DISCOVERY_SCHEMA_VERSION = "1.0.0";
export const HONUA_DEMO_SERVICES_MANIFEST_PATH = "demo-services.v1.json";
const MAX_CLOUD_NATIVE_MANIFEST_BYTES = 1_048_576;
const MAX_CLOUD_NATIVE_MANIFEST_SERVICES = 1_000;
const MAX_CLOUD_NATIVE_MANIFEST_REDIRECTS = 20;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export const CLOUD_NATIVE_SOURCE_KINDS = [
  "cog",
  "stac",
  "pmtiles",
  "geoparquet",
  "geoarrow",
  "ogc-coverages",
  "wcs",
  "zarr",
  "netcdf",
] as const;

export type CloudNativeSourceKind = (typeof CLOUD_NATIVE_SOURCE_KINDS)[number];
export type CloudNativeDirectAssetFormat = "cog" | "pmtiles" | "geoparquet" | "geoarrow" | "zarr" | "netcdf";
export type CloudNativeMaturity = "supported" | "experimental" | "metadata-only" | "unavailable";
export type CloudNativeDeliveryStatus = CloudNativeMaturity | "not-applicable";
export type CloudNativeOperation =
  | "discover"
  | "inspect-metadata"
  | "search"
  | "read-ranges"
  | "query"
  | "render"
  | "read-coverage";

export interface CloudNativeCapabilityStatus {
  readonly client: CloudNativeMaturity;
  readonly server: CloudNativeDeliveryStatus;
  readonly endToEnd: CloudNativeMaturity;
}

export interface CloudNativeCapabilityDescriptor {
  readonly kind: CloudNativeSourceKind;
  readonly maturity: CloudNativeMaturity;
  readonly status: CloudNativeCapabilityStatus;
  readonly advertised: boolean;
  readonly sourceCount: number;
}

export interface CloudNativeDiscoveryEvidence {
  readonly type: "manifest-link" | "declared-format" | "url-suffix";
  readonly value: string;
}

export interface CloudNativeAssetLocator {
  readonly type: "asset";
  readonly href: string;
}

export interface CloudNativeApiLocator {
  readonly type: "api";
  readonly href: string;
}

export interface CloudNativeStacLocator {
  readonly type: "stac-api";
  readonly rootHref: string;
  readonly collectionsHref?: string;
  readonly searchHref?: string;
}

interface CloudNativeSourceDescriptorBase<
  Kind extends CloudNativeSourceKind,
  Locator extends CloudNativeAssetLocator | CloudNativeApiLocator | CloudNativeStacLocator,
> {
  readonly kind: Kind;
  readonly id: string;
  readonly title?: string;
  readonly origin: "honua-deployment" | "direct-asset";
  readonly maturity: CloudNativeMaturity;
  readonly status: CloudNativeCapabilityStatus;
  readonly operations: readonly CloudNativeOperation[];
  readonly locator: Locator;
  readonly evidence: readonly CloudNativeDiscoveryEvidence[];
}

export type CloudNativeAssetSourceDescriptor = CloudNativeSourceDescriptorBase<
  "cog" | "pmtiles" | "geoparquet" | "geoarrow" | "zarr" | "netcdf",
  CloudNativeAssetLocator
>;

export type CloudNativeStacSourceDescriptor = CloudNativeSourceDescriptorBase<"stac", CloudNativeStacLocator>;

export type CloudNativeCoverageSourceDescriptor = CloudNativeSourceDescriptorBase<
  "ogc-coverages" | "wcs",
  CloudNativeApiLocator
>;

export type CloudNativeSourceDescriptor =
  | CloudNativeAssetSourceDescriptor
  | CloudNativeStacSourceDescriptor
  | CloudNativeCoverageSourceDescriptor;

export interface HonuaDeploymentDiscoveryInput {
  readonly type: "honua-deployment";
  readonly baseUrl: string;
  /** Overrides the standard manifest URL. Relative values resolve from baseUrl. */
  readonly manifestUrl?: string;
}

export interface DirectCloudNativeAssetDiscoveryInput {
  readonly type: "direct-asset";
  readonly url: string;
  /** Required when the URL suffix does not identify a safe format candidate. */
  readonly format?: CloudNativeDirectAssetFormat;
}

export type CloudNativeDiscoveryInput = string | HonuaDeploymentDiscoveryInput | DirectCloudNativeAssetDiscoveryInput;

export interface CloudNativeDiscoveryOptions {
  readonly signal?: AbortSignal;
  readonly fetchFn?: typeof fetch;
  readonly apiKey?: string;
  readonly bearerToken?: string;
  readonly auth?: HonuaAuthProvider | HonuaAuthCredentialsProvider;
  readonly interceptors?: readonly HonuaRequestInterceptor[];
}

export interface CloudNativeDiscoveryDocument {
  readonly format: typeof HONUA_CLOUD_NATIVE_DISCOVERY_FORMAT;
  readonly schemaVersion: typeof HONUA_CLOUD_NATIVE_DISCOVERY_SCHEMA_VERSION;
  readonly input:
    | { readonly type: "honua-deployment"; readonly url: string }
    | { readonly type: "direct-asset"; readonly url: string };
  readonly manifest?: {
    readonly url: string;
    readonly format: string;
    readonly schemaVersion: string;
  };
  readonly capabilities: readonly CloudNativeCapabilityDescriptor[];
  readonly sources: readonly CloudNativeSourceDescriptor[];
}

export type CloudNativeDiscoveryErrorCode =
  | "invalid-cloud-native-input"
  | "invalid-cloud-native-manifest"
  | "cloud-native-operation-unavailable";

/** Typed validation and local capability-gate failure. */
export class HonuaCloudNativeDiscoveryError extends HonuaDiscoveryError {
  public constructor(
    public override readonly code: CloudNativeDiscoveryErrorCode,
    message: string,
    detail?: Readonly<Record<string, unknown>>,
    options: { cause?: unknown } = {},
  ) {
    super(code, message, detail, options);
    this.name = "HonuaCloudNativeDiscoveryError";
  }
}

export interface AssertCloudNativeOperationOptions {
  /** Explicitly opts into an operation whose client contract is experimental. */
  readonly allowExperimental?: boolean;
}

/**
 * Fails locally when an operation is absent, unavailable, or experimental
 * without an explicit opt-in. No network request is performed.
 */
export function assertCloudNativeOperation(
  source: CloudNativeSourceDescriptor,
  operation: CloudNativeOperation,
  options: AssertCloudNativeOperationOptions = {},
): void {
  if (!source.operations.includes(operation)) {
    throw operationError(source, operation, "The source does not advertise this operation.");
  }
  if (source.maturity === "unavailable") {
    throw operationError(source, operation, "The end-to-end operation is unavailable.");
  }
  if (source.maturity === "experimental" && !options.allowExperimental) {
    throw operationError(source, operation, "Experimental operations require allowExperimental: true.");
  }
  if (source.maturity === "metadata-only" && operation !== "inspect-metadata" && operation !== "discover") {
    throw operationError(source, operation, "This source currently exposes metadata only.");
  }
}

/** Discover an authoritative Honua manifest or normalize a direct asset URL. */
export async function discoverCloudNativeSources(
  input: CloudNativeDiscoveryInput,
  options: CloudNativeDiscoveryOptions = {},
): Promise<CloudNativeDiscoveryDocument> {
  if (options.signal?.aborted) throw new HonuaAbortError();
  const normalized = normalizeInput(input);
  if (normalized.type === "direct-asset") return directAssetDocument(normalized.url, normalized.format);

  const manifest = await requestManifest(normalized.manifestUrl, options);
  return deploymentDocument(normalized.baseUrl, normalized.manifestUrl, manifest);
}

/** Deterministic JSON serialization for cache keys, fixtures, and diagnostics. */
export function serializeCloudNativeDiscovery(document: CloudNativeDiscoveryDocument, space = 2): string {
  return JSON.stringify(sortJson(document), null, Math.max(0, Math.min(10, Math.trunc(space))));
}

/** Parses and validates the version envelope of a serialized discovery document. */
export function parseCloudNativeDiscovery(serialized: string): CloudNativeDiscoveryDocument {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (cause) {
    throw new HonuaCloudNativeDiscoveryError(
      "invalid-cloud-native-manifest",
      "Cloud-native discovery JSON is malformed.",
      undefined,
      { cause },
    );
  }
  if (
    !isRecord(value) ||
    value.format !== HONUA_CLOUD_NATIVE_DISCOVERY_FORMAT ||
    value.schemaVersion !== HONUA_CLOUD_NATIVE_DISCOVERY_SCHEMA_VERSION ||
    !isRecord(value.input) ||
    !Array.isArray(value.capabilities) ||
    !Array.isArray(value.sources)
  ) {
    throw new HonuaCloudNativeDiscoveryError(
      "invalid-cloud-native-manifest",
      "Cloud-native discovery JSON does not match the v1 envelope.",
    );
  }
  return value as unknown as CloudNativeDiscoveryDocument;
}

interface NormalizedDeploymentInput {
  readonly type: "honua-deployment";
  readonly baseUrl: string;
  readonly manifestUrl: string;
}

interface NormalizedDirectInput {
  readonly type: "direct-asset";
  readonly url: string;
  readonly format: CloudNativeDirectAssetFormat;
}

function normalizeInput(input: CloudNativeDiscoveryInput): NormalizedDeploymentInput | NormalizedDirectInput {
  if (typeof input === "string") {
    const url = normalizeHttpUrl(input, "input URL");
    const format = inferDirectFormat(url);
    if (format) return { type: "direct-asset", url, format };
    if (hasTiffSuffix(url)) {
      throw new HonuaCloudNativeDiscoveryError(
        "invalid-cloud-native-input",
        "A TIFF filename does not prove that the asset is cloud optimized. Pass an explicit direct-asset format.",
        { url },
      );
    }
    if (new URL(url).pathname.endsWith(`/${HONUA_DEMO_SERVICES_MANIFEST_PATH}`)) {
      return {
        type: "honua-deployment",
        baseUrl: new URL(".", url).href,
        manifestUrl: url,
      };
    }
    const baseUrl = ensureDirectoryUrl(url);
    return {
      type: "honua-deployment",
      baseUrl,
      manifestUrl: new URL(HONUA_DEMO_SERVICES_MANIFEST_PATH, baseUrl).href,
    };
  }

  if (input.type === "direct-asset") {
    const url = normalizeHttpUrl(input.url, "direct asset URL");
    const format = input.format ?? inferDirectFormat(url);
    if (!format) {
      throw new HonuaCloudNativeDiscoveryError(
        "invalid-cloud-native-input",
        "The direct asset format is ambiguous. Pass an explicit format.",
        { url },
      );
    }
    return { type: "direct-asset", url, format };
  }

  const baseUrl = ensureDirectoryUrl(normalizeHttpUrl(input.baseUrl, "Honua base URL"));
  const manifestUrl = input.manifestUrl
    ? normalizeHttpUrl(new URL(input.manifestUrl, baseUrl).href, "Honua manifest URL")
    : new URL(HONUA_DEMO_SERVICES_MANIFEST_PATH, baseUrl).href;
  return { type: "honua-deployment", baseUrl, manifestUrl };
}

function directAssetDocument(url: string, format: CloudNativeDirectAssetFormat): CloudNativeDiscoveryDocument {
  const evidenceType = inferDirectFormat(url) === format ? "url-suffix" : "declared-format";
  const capability = capabilityFor(format, "direct-asset", true, 1);
  const source: CloudNativeAssetSourceDescriptor = {
    kind: format,
    id: `direct:${format}`,
    origin: "direct-asset",
    maturity: capability.maturity,
    status: capability.status,
    operations: operationsFor(format),
    locator: { type: "asset", href: url },
    evidence: [{ type: evidenceType, value: evidenceType === "url-suffix" ? new URL(url).pathname : format }],
  };
  return {
    format: HONUA_CLOUD_NATIVE_DISCOVERY_FORMAT,
    schemaVersion: HONUA_CLOUD_NATIVE_DISCOVERY_SCHEMA_VERSION,
    input: { type: "direct-asset", url },
    capabilities: CLOUD_NATIVE_SOURCE_KINDS.map((kind) =>
      kind === format ? capability : capabilityFor(kind, "direct-asset", false, 0),
    ),
    sources: [source],
  };
}

function deploymentDocument(
  requestedBaseUrl: string,
  manifestUrl: string,
  value: unknown,
): CloudNativeDiscoveryDocument {
  if (!isRecord(value) || !Array.isArray(value.services)) {
    throw new HonuaCloudNativeDiscoveryError(
      "invalid-cloud-native-manifest",
      "The Honua deployment manifest must contain a services array.",
      { manifestUrl },
    );
  }
  if (value.services.length > MAX_CLOUD_NATIVE_MANIFEST_SERVICES) {
    throw new HonuaCloudNativeDiscoveryError(
      "invalid-cloud-native-manifest",
      `The Honua deployment manifest exceeds the ${MAX_CLOUD_NATIVE_MANIFEST_SERVICES}-service limit.`,
      { manifestUrl, serviceCount: value.services.length },
    );
  }
  const format = stringValue(value.format);
  const schemaVersion = stringValue(value.schemaVersion);
  if (!format || !schemaVersion) {
    throw new HonuaCloudNativeDiscoveryError(
      "invalid-cloud-native-manifest",
      "The Honua deployment manifest must declare format and schemaVersion.",
      { manifestUrl },
    );
  }

  const advertisedBase = stringValue(value.baseUrl);
  const baseUrl = advertisedBase
    ? ensureDirectoryUrl(normalizeHttpUrl(new URL(advertisedBase, requestedBaseUrl).href, "manifest baseUrl"))
    : requestedBaseUrl;
  const sources: CloudNativeSourceDescriptor[] = [];

  for (const [index, rawService] of value.services.entries()) {
    if (!isRecord(rawService) || !isRecord(rawService.protocols)) continue;
    const serviceId = stringValue(rawService.id) ?? `service-${index + 1}`;
    const title = stringValue(rawService.title) ?? stringValue(rawService.name);
    for (const kind of CLOUD_NATIVE_SOURCE_KINDS) {
      const protocol = findProtocol(rawService.protocols, kind);
      if (protocol === undefined) continue;
      const locator = locatorFromProtocol(kind, protocol, baseUrl);
      if (!locator) continue;
      const status = capabilityFor(kind, "honua-deployment", true, 1);
      const common = {
        id: `${serviceId}:${kind}`,
        ...(title ? { title } : {}),
        origin: "honua-deployment" as const,
        maturity: status.maturity,
        status: status.status,
        operations: operationsFor(kind, locator),
        evidence: [{ type: "manifest-link" as const, value: locatorHref(locator) }],
      };
      if (kind === "stac" && locator.type === "stac-api") {
        sources.push({ kind, ...common, locator });
      } else if ((kind === "ogc-coverages" || kind === "wcs") && locator.type === "api") {
        sources.push({ kind, ...common, locator });
      } else if (
        (kind === "cog" ||
          kind === "pmtiles" ||
          kind === "geoparquet" ||
          kind === "geoarrow" ||
          kind === "zarr" ||
          kind === "netcdf") &&
        locator.type === "asset"
      ) {
        sources.push({ kind, ...common, locator });
      }
    }
  }

  sources.sort((left, right) => left.id.localeCompare(right.id));
  return {
    format: HONUA_CLOUD_NATIVE_DISCOVERY_FORMAT,
    schemaVersion: HONUA_CLOUD_NATIVE_DISCOVERY_SCHEMA_VERSION,
    input: { type: "honua-deployment", url: requestedBaseUrl },
    manifest: { url: manifestUrl, format, schemaVersion },
    capabilities: CLOUD_NATIVE_SOURCE_KINDS.map((kind) => {
      const count = sources.filter((source) => source.kind === kind).length;
      return capabilityFor(kind, "honua-deployment", count > 0, count);
    }),
    sources,
  };
}

function capabilityFor(
  kind: CloudNativeSourceKind,
  origin: "honua-deployment" | "direct-asset",
  advertised: boolean,
  sourceCount: number,
): CloudNativeCapabilityDescriptor {
  const registry = RASTER_DISCOVERY_KINDS.has(kind as RasterDiscoveryKind)
    ? rasterDiscoveryRegistryEntry(kind as RasterDiscoveryKind)
    : undefined;
  const client = registry?.client ?? CLIENT_MATURITY[kind];
  const server =
    origin === "direct-asset"
      ? "not-applicable"
      : advertised
        ? (registry?.server ?? SERVER_MATURITY[kind])
        : "unavailable";
  const endToEnd = !advertised
    ? "unavailable"
    : (registry?.endToEnd ?? (origin === "direct-asset" ? client : weakerMaturity(client, server)));
  return { kind, maturity: endToEnd, status: { client, server, endToEnd }, advertised, sourceCount };
}

function weakerMaturity(client: CloudNativeMaturity, server: CloudNativeDeliveryStatus): CloudNativeMaturity {
  if (server === "not-applicable") return client;
  return MATURITY_RANK[client] <= MATURITY_RANK[server] ? client : server;
}

function operationsFor(
  kind: CloudNativeSourceKind,
  locator?: CloudNativeAssetLocator | CloudNativeApiLocator | CloudNativeStacLocator,
): readonly CloudNativeOperation[] {
  if (RASTER_DISCOVERY_KINDS.has(kind as RasterDiscoveryKind)) {
    return rasterDiscoveryRegistryEntry(kind as RasterDiscoveryKind)
      .discoveryOperations as readonly CloudNativeOperation[];
  }
  switch (kind) {
    case "stac":
      return locator?.type === "stac-api" && locator.searchHref
        ? ["discover", "inspect-metadata", "search"]
        : ["discover", "inspect-metadata"];
    case "pmtiles":
      return ["discover", "inspect-metadata", "read-ranges", "render"];
    case "geoparquet":
      return ["discover", "inspect-metadata", "query", "render"];
    case "geoarrow":
      return ["discover", "inspect-metadata"];
  }
  throw new Error(`Cloud-native source kind ${kind} has no canonical operation registry entry`);
}

function findProtocol(protocols: Record<string, unknown>, kind: CloudNativeSourceKind): unknown {
  for (const key of PROTOCOL_KEYS[kind]) {
    if (protocols[key] !== undefined) return protocols[key];
  }
  return undefined;
}

function locatorFromProtocol(
  kind: CloudNativeSourceKind,
  protocol: unknown,
  baseUrl: string,
): CloudNativeAssetLocator | CloudNativeApiLocator | CloudNativeStacLocator | undefined {
  const record = isRecord(protocol) ? protocol : undefined;
  const rawHref = typeof protocol === "string" ? protocol : firstString(record, "href", "url", "path", "endpoint");
  if (!rawHref) return undefined;
  const href = resolveManifestHref(rawHref, baseUrl);
  if (kind === "stac") {
    const collections = firstString(record, "collectionsHref", "collectionsUrl", "collectionsPath");
    const search = firstString(record, "searchHref", "searchUrl", "searchPath");
    return {
      type: "stac-api",
      rootHref: href,
      ...(collections ? { collectionsHref: resolveManifestHref(collections, baseUrl) } : {}),
      ...(search ? { searchHref: resolveManifestHref(search, baseUrl) } : {}),
    };
  }
  if (kind === "ogc-coverages" || kind === "wcs") return { type: "api", href };
  return { type: "asset", href };
}

async function requestManifest(url: string, options: CloudNativeDiscoveryOptions): Promise<unknown> {
  const credentials = await resolveCredentials(options, "initial", false);
  const headers = new Headers({ Accept: "application/json" });
  if (options.apiKey) headers.set("X-API-Key", options.apiKey);
  if (options.bearerToken) headers.set("Authorization", `Bearer ${options.bearerToken}`);
  applyCredentials(headers, credentials);

  let context: HonuaRequestContext = {
    url,
    path: `${new URL(url).pathname}${new URL(url).search}`,
    method: "GET",
    init: { method: "GET", headers, ...(options.signal ? { signal: options.signal } : {}) },
  };
  const startedAt = Date.now();
  try {
    for (const interceptor of options.interceptors ?? []) {
      const mutation = await interceptor.before?.(cloneRequestContext(context));
      if (!mutation) continue;
      const nextUrl = mutation.url ?? context.url;
      const nextMethod = mutation.method ?? context.method;
      const nextInit =
        mutation.init === undefined
          ? context.init
          : {
              ...context.init,
              ...mutation.init,
              headers: mergeHeaders(context.init.headers, mutation.init.headers),
            };
      context = {
        url: nextUrl,
        path: `${new URL(nextUrl).pathname}${new URL(nextUrl).search}`,
        method: nextMethod,
        init: {
          ...nextInit,
          method: nextMethod,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      };
    }
    if (options.signal?.aborted) throw new HonuaAbortError();
    const fetchFn = options.fetchFn ?? fetch;
    let response = await fetchManifestWithSafeRedirects(fetchFn, context.url, context.init);
    if ((response.status === 401 || response.status === 403) && options.auth) {
      const refreshed = await resolveCredentials(options, "unauthorized", true, credentials);
      if (refreshed) {
        const refreshedHeaders = new Headers(context.init.headers);
        applyCredentials(refreshedHeaders, refreshed);
        context = { ...context, init: { ...context.init, headers: refreshedHeaders } };
        response = await fetchManifestWithSafeRedirects(fetchFn, context.url, context.init);
      }
    }
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      const body = await readBoundedResponseText(response, MAX_CLOUD_NATIVE_MANIFEST_BYTES, options.signal);
      throw new HonuaHttpError(response.status, response.statusText || "Manifest request failed", body);
    }
    const interceptorResponse = (options.interceptors ?? []).some((interceptor) => interceptor.after)
      ? response.clone()
      : undefined;
    let manifest: unknown;
    try {
      const text = await readBoundedResponseText(response, MAX_CLOUD_NATIVE_MANIFEST_BYTES, options.signal);
      manifest = JSON.parse(text) as unknown;
    } catch (cause) {
      if (isHonuaError(cause)) throw cause;
      throw new HonuaCloudNativeDiscoveryError(
        "invalid-cloud-native-manifest",
        "The Honua deployment manifest response is not valid JSON.",
        { url: context.url },
        { cause },
      );
    }
    for (const interceptor of options.interceptors ?? []) {
      await interceptor.after?.({
        request: cloneRequestContext(context),
        response: interceptorResponse?.clone() ?? response.clone(),
        durationMs,
      });
    }
    return manifest;
  } catch (cause) {
    const error = normalizeRequestError(cause, options.signal, context.url);
    await Promise.allSettled(
      (options.interceptors ?? []).map((interceptor) =>
        interceptor.error?.({ request: cloneRequestContext(context), error, durationMs: Date.now() - startedAt }),
      ),
    );
    throw error;
  }
}

async function fetchManifestWithSafeRedirects(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let currentUrl = url;
  const allowedOrigin = new URL(url).origin;
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchFn(currentUrl, { ...init, redirect: "manual" });
    if (response.type === "opaqueredirect") {
      throw new HonuaNetworkError(
        "Refusing to follow an opaque redirect because deployment credentials could be leaked.",
        undefined,
      );
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    if (redirects >= MAX_CLOUD_NATIVE_MANIFEST_REDIRECTS) {
      await response.body?.cancel().catch(() => undefined);
      throw new HonuaNetworkError(
        `Exceeded the maximum of ${MAX_CLOUD_NATIVE_MANIFEST_REDIRECTS} manifest redirects.`,
        undefined,
      );
    }

    const location = response.headers.get("location");
    let target: URL;
    try {
      if (!location) throw new Error("missing Location header");
      target = new URL(location, currentUrl);
    } catch (cause) {
      await response.body?.cancel().catch(() => undefined);
      throw new HonuaNetworkError("Manifest redirect has an invalid Location header.", cause);
    }
    if (target.origin !== allowedOrigin) {
      await response.body?.cancel().catch(() => undefined);
      throw new HonuaNetworkError(
        `Refusing to follow a cross-origin manifest redirect to ${target.origin}; deployment credentials would be leaked.`,
        undefined,
      );
    }
    await response.body?.cancel().catch(() => undefined);
    currentUrl = target.href;
  }
}

async function resolveCredentials(
  options: CloudNativeDiscoveryOptions,
  reason: "initial" | "unauthorized",
  forceRefresh: boolean,
  previousCredentials?: HonuaAuthCredentials,
): Promise<HonuaAuthCredentials | undefined> {
  if (!options.auth) return undefined;
  const context = { reason, forceRefresh, ...(previousCredentials ? { previousCredentials } : {}) };
  const result = await (typeof options.auth === "function"
    ? options.auth(context)
    : options.auth.getCredentials(context));
  if (typeof result === "string") return { bearerToken: result };
  return result ?? undefined;
}

function applyCredentials(headers: Headers, credentials: HonuaAuthCredentials | undefined): void {
  if (!credentials) return;
  if (credentials.apiKey) headers.set("X-API-Key", credentials.apiKey);
  if (credentials.authorization) headers.set("Authorization", credentials.authorization);
  else if (credentials.bearerToken) headers.set("Authorization", `Bearer ${credentials.bearerToken}`);
}

function normalizeRequestError(cause: unknown, signal: AbortSignal | undefined, url: string): unknown {
  if (isHonuaError(cause)) return cause;
  if (signal?.aborted || (cause instanceof DOMException && cause.name === "AbortError")) return new HonuaAbortError();
  return new HonuaNetworkError(`Cloud-native deployment discovery failed for ${url}.`, cause);
}

function cloneRequestContext(context: HonuaRequestContext): HonuaRequestContext {
  return { ...context, init: { ...context.init, headers: new Headers(context.init.headers) } };
}

function mergeHeaders(...sources: Array<HeadersInit | undefined>): Headers {
  const merged = new Headers();
  for (const source of sources) {
    if (!source) continue;
    new Headers(source).forEach((value, key) => merged.set(key, value));
  }
  return merged;
}

async function readBoundedResponseText(response: Response, maximum: number, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    void response.body?.cancel().catch(() => undefined);
    throw new HonuaAbortError();
  }
  const advertised = response.headers.get("content-length");
  if (advertised !== null) {
    const length = Number(advertised);
    if (Number.isFinite(length) && length > maximum) {
      void response.body?.cancel().catch(() => undefined);
      throw new HonuaCloudNativeDiscoveryError(
        "invalid-cloud-native-manifest",
        `The Honua deployment manifest exceeds the ${maximum}-byte response limit.`,
      );
    }
  }
  if (!response.body) return "";

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
        throw new HonuaCloudNativeDiscoveryError(
          "invalid-cloud-native-manifest",
          `The Honua deployment manifest exceeds the ${maximum}-byte response limit.`,
        );
      }
      chunks.push(value);
    }
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
  return new TextDecoder().decode(bytes);
}

function operationError(
  source: CloudNativeSourceDescriptor,
  operation: CloudNativeOperation,
  reason: string,
): HonuaCloudNativeDiscoveryError {
  return new HonuaCloudNativeDiscoveryError(
    "cloud-native-operation-unavailable",
    `${reason} (${source.kind}:${operation})`,
    { sourceId: source.id, kind: source.kind, operation, maturity: source.maturity, status: source.status },
  );
}

function inferDirectFormat(url: string): CloudNativeDirectAssetFormat | undefined {
  const path = new URL(url).pathname.toLowerCase().replace(/\/$/, "");
  if (path.endsWith(".pmtiles")) return "pmtiles";
  if (path.endsWith(".parquet")) return "geoparquet";
  if (path.endsWith(".arrow") || path.endsWith(".feather")) return "geoarrow";
  if (path.endsWith(".zarr")) return "zarr";
  if (path.endsWith(".nc") || path.endsWith(".nc4") || path.endsWith(".netcdf")) return "netcdf";
  return undefined;
}

function hasTiffSuffix(url: string): boolean {
  const path = new URL(url).pathname.toLowerCase().replace(/\/$/, "");
  return path.endsWith(".tif") || path.endsWith(".tiff");
}

function normalizeHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new HonuaCloudNativeDiscoveryError(
      "invalid-cloud-native-input",
      `${label} must be an absolute HTTP(S) URL.`,
      { value },
      { cause },
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HonuaCloudNativeDiscoveryError("invalid-cloud-native-input", `${label} must use HTTP or HTTPS.`, {
      value,
      protocol: url.protocol,
    });
  }
  url.hash = "";
  return url.href;
}

function ensureDirectoryUrl(value: string): string {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

function resolveManifestHref(value: string, baseUrl: string): string {
  return normalizeHttpUrl(new URL(value, baseUrl).href, "manifest link");
}

function locatorHref(locator: CloudNativeAssetLocator | CloudNativeApiLocator | CloudNativeStacLocator): string {
  return locator.type === "stac-api" ? locator.rootHref : locator.href;
}

function firstString(record: Record<string, unknown> | undefined, ...keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

const CLIENT_MATURITY = {
  cog: "experimental",
  stac: "supported",
  pmtiles: "supported",
  geoparquet: "experimental",
  geoarrow: "metadata-only",
  "ogc-coverages": "experimental",
  wcs: "experimental",
  zarr: "experimental",
  netcdf: "unavailable",
} as const satisfies Record<CloudNativeSourceKind, CloudNativeMaturity>;

const SERVER_MATURITY = {
  cog: "supported",
  stac: "supported",
  pmtiles: "supported",
  geoparquet: "supported",
  geoarrow: "experimental",
  "ogc-coverages": "supported",
  wcs: "supported",
  zarr: "experimental",
  netcdf: "metadata-only",
} as const satisfies Record<CloudNativeSourceKind, CloudNativeMaturity>;

const MATURITY_RANK = {
  unavailable: 0,
  "metadata-only": 1,
  experimental: 2,
  supported: 3,
} as const satisfies Record<CloudNativeMaturity, number>;

const PROTOCOL_KEYS = {
  cog: ["cog"],
  stac: ["stac"],
  pmtiles: ["pmtiles"],
  geoparquet: ["geoparquet", "geoParquet"],
  geoarrow: ["geoarrow", "geoArrow"],
  "ogc-coverages": ["ogcCoverages", "ogcApiCoverages"],
  wcs: ["wcs"],
  zarr: ["zarr"],
  netcdf: ["netcdf", "netCdf"],
} as const satisfies Record<CloudNativeSourceKind, readonly string[]>;

type RasterDiscoveryKind = "cog" | "ogc-coverages" | "wcs" | "zarr" | "netcdf";
const RASTER_DISCOVERY_KINDS: ReadonlySet<RasterDiscoveryKind> = new Set([
  "cog",
  "ogc-coverages",
  "wcs",
  "zarr",
  "netcdf",
]);
