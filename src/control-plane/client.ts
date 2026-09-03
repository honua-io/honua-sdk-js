import { honuaCacheValidatorFromHeaders } from "../core/cache-state.js";
import type { HonuaClient } from "../core/client.js";
import { HonuaHttpError } from "../core/errors.js";
import { trimTrailingSlashes } from "../core/path-utils.js";
import type { QueryMethod } from "../core/types.js";
import type { HonuaMapPackage } from "../runtime/index.js";
import type { StudioCapabilityManifest } from "../studio/capability-manifest.js";
import {
  HONUA_CAPABILITY_MANIFEST_PATH,
  HONUA_CONTROL_PLANE_BASE_PATH,
  type HonuaApiToken,
  type HonuaApiTokenCreateRequest,
  type HonuaCapabilityManifestOptions,
  type HonuaConnectionSummary,
  type HonuaControlPlaneCapability,
  type HonuaControlPlaneJob,
  type HonuaControlPlaneJobStatus,
  type HonuaControlPlaneListOptions,
  type HonuaControlPlanePage,
  type HonuaControlPlaneRawRequest,
  type HonuaControlPlaneRequestOptions,
  type HonuaControlPlaneResult,
  type HonuaCreateHostedMapRequest,
  type HonuaHostedMap,
  type HonuaHostedMapSummary,
  type HonuaImportCreateRequest,
  type HonuaMapPackageSummary,
  type HonuaProblemDetails,
  type HonuaPublishMapPackageRequest,
  type HonuaPublishMapPackageResponse,
  type HonuaShareRequest,
  type HonuaShareResponse,
  type HonuaUpdateHostedMapRequest,
  type HonuaWorkspaceSummary,
} from "./types.js";

export interface HonuaControlPlaneClientOptions {
  readonly client: HonuaClient;
  readonly basePath?: string;
}

export function createHonuaControlPlane(options: HonuaControlPlaneClientOptions): HonuaControlPlaneClient {
  return new HonuaControlPlaneClient(options);
}

export class HonuaControlPlaneClient {
  readonly #client: HonuaClient;
  readonly #basePath: string;

  public readonly hostedMaps: HonuaHostedMapsClient;
  public readonly packages: HonuaMapPackagesClient;
  public readonly imports: HonuaImportsClient;
  public readonly tokens: HonuaApiTokensClient;
  public readonly workspaces: HonuaWorkspacesClient;
  public readonly connections: HonuaConnectionsClient;
  public readonly sharing: HonuaSharingClient;

  public constructor(options: HonuaControlPlaneClientOptions) {
    this.#client = options.client;
    this.#basePath = normalizeBasePath(options.basePath ?? HONUA_CONTROL_PLANE_BASE_PATH);
    this.hostedMaps = new HonuaHostedMapsClient(this);
    this.packages = new HonuaMapPackagesClient(this);
    this.imports = new HonuaImportsClient(this);
    this.tokens = new HonuaApiTokensClient(this);
    this.workspaces = new HonuaWorkspacesClient(this);
    this.connections = new HonuaConnectionsClient(this);
    this.sharing = new HonuaSharingClient(this);
  }

  public get basePath(): string {
    return this.#basePath;
  }

  public async raw<T = unknown>(request: HonuaControlPlaneRawRequest): Promise<HonuaControlPlaneResult<T>> {
    return this.requestJson<T>("raw", request.method ?? "GET", request.path, request.body, {
      signal: request.signal,
      headers: request.headers,
      idempotencyKey: request.idempotencyKey,
      ifMatch: request.ifMatch,
      okStatuses: request.okStatuses,
    });
  }

  /**
   * Fetch the server capability manifest (`honua.capability_manifest.v1`) from
   * `GET /api/v1/capabilities/manifest`, optionally scoped to an `environment`
   * and/or `workspaceId`. Lets a client gate UI and tool exposure on what the
   * connected server actually supports. Returns an unsupported result when the
   * deployment predates the manifest endpoint (404/501). Mirrors the
   * honua-sdk-dotnet `HonuaCapabilityManifestClient.GetManifestAsync`.
   */
  public async getCapabilityManifest(
    options: HonuaCapabilityManifestOptions = {},
  ): Promise<HonuaControlPlaneResult<StudioCapabilityManifest>> {
    const { environment, workspaceId, ...requestOptions } = options;
    return this.requestJson<StudioCapabilityManifest>(
      "capabilities",
      "GET",
      withManifestQuery(HONUA_CAPABILITY_MANIFEST_PATH, environment, workspaceId),
      undefined,
      requestOptions,
    );
  }

  public async requestJson<T>(
    capability: HonuaControlPlaneCapability,
    method: QueryMethod,
    path: string,
    body?: unknown,
    options: HonuaControlPlaneRequestOptions & { okStatuses?: readonly number[] } = {},
  ): Promise<HonuaControlPlaneResult<T>> {
    try {
      const response = await this.#client.pipelineFetch(
        method,
        this.resolvePath(path),
        {
          headers: jsonHeaders(options),
          body: body === undefined ? null : JSON.stringify(body),
        },
        options.signal,
        options.okStatuses ? { okStatuses: options.okStatuses } : {},
      );
      if (response.status === 204) return supported(undefined as T);
      const value = (await readJson(response)) as T;
      return supported(value);
    } catch (error) {
      return unsupportedFromError(capability, error);
    }
  }

  public async requestPage<T>(
    capability: HonuaControlPlaneCapability,
    path: string,
    options: HonuaControlPlaneListOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaControlPlanePage<T>>> {
    try {
      const hasValidator = Boolean(options.validator?.etag || options.validator?.lastModified);
      const response = await this.#client.pipelineFetch(
        "GET",
        this.resolvePath(withListQuery(path, options)),
        { headers: listHeaders(options) },
        options.signal,
        { okStatuses: hasValidator ? [304, 404, 501] : [404, 501] },
      );
      if (response.status === 404 || response.status === 501) {
        return unsupportedFromStatus(capability, response.status, await readJson(response));
      }
      const value = normalizePage<T>(response.status === 304 ? undefined : await readJson(response), response, {
        fallbackValidator: options.validator,
      });
      return supported(value);
    } catch (error) {
      return unsupportedFromError(capability, error);
    }
  }

  public resolvePath(path: string): string {
    if (path.startsWith("http://") || path.startsWith("https://")) return path;
    const normalized = path.startsWith("/") ? path : `/${path}`;
    if (normalized === this.#basePath || normalized.startsWith(`${this.#basePath}/`)) return normalized;
    // Server-wide, already-rooted API paths (e.g. the capability manifest at
    // /api/v1/capabilities/manifest) are used verbatim rather than nested under
    // the admin base path.
    if (normalized.startsWith("/api/")) return normalized;
    return `${this.#basePath}${normalized}`;
  }
}

export class HonuaHostedMapsClient {
  readonly #controlPlane: HonuaControlPlaneClient;

  public constructor(controlPlane: HonuaControlPlaneClient) {
    this.#controlPlane = controlPlane;
  }

  public list(
    options: HonuaControlPlaneListOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaControlPlanePage<HonuaHostedMapSummary>>> {
    return this.#controlPlane.requestPage("hosted-maps", "/maps", options);
  }

  public get(
    mapId: string,
    options: HonuaControlPlaneRequestOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaHostedMap>> {
    return this.#controlPlane.requestJson(
      "hosted-maps",
      "GET",
      `/maps/${encodeURIComponent(mapId)}`,
      undefined,
      options,
    );
  }

  public create(
    request: HonuaCreateHostedMapRequest,
    options: HonuaControlPlaneRequestOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaHostedMap>> {
    return this.#controlPlane.requestJson("hosted-maps", "POST", "/maps", request, options);
  }

  public update(
    mapId: string,
    request: HonuaUpdateHostedMapRequest,
    options: HonuaControlPlaneRequestOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaHostedMap>> {
    const { ifMatch, ...body } = request;
    return this.#controlPlane.requestJson("hosted-maps", "PATCH", `/maps/${encodeURIComponent(mapId)}`, body, {
      ...options,
      headers: withIfMatch(options.headers, ifMatch),
    });
  }

  public async getPackage(
    mapId: string,
    options: HonuaControlPlaneRequestOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaMapPackage>> {
    return this.#controlPlane.requestJson(
      "map-packages",
      "GET",
      `/maps/${encodeURIComponent(mapId)}/package`,
      undefined,
      options,
    );
  }

  public async getPackageLocator(
    mapId: string,
    options: HonuaControlPlaneRequestOptions = {},
  ): Promise<HonuaControlPlaneResult<{ readonly path: string }>> {
    const result = await this.get(mapId, options);
    if (!result.supported) return result;
    const href = result.value.links?.mapPackage;
    return supported({ path: href ?? this.#controlPlane.resolvePath(`/maps/${encodeURIComponent(mapId)}/package`) });
  }
}

export class HonuaMapPackagesClient {
  readonly #controlPlane: HonuaControlPlaneClient;

  public constructor(controlPlane: HonuaControlPlaneClient) {
    this.#controlPlane = controlPlane;
  }

  public list(
    options: HonuaControlPlaneListOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaControlPlanePage<HonuaMapPackageSummary>>> {
    return this.#controlPlane.requestPage("map-packages", "/packages", options);
  }

  public get(
    packageId: string,
    options: HonuaControlPlaneRequestOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaMapPackage>> {
    return this.#controlPlane.requestJson(
      "map-packages",
      "GET",
      `/packages/${encodeURIComponent(packageId)}`,
      undefined,
      options,
    );
  }

  public publish(
    request: HonuaPublishMapPackageRequest,
    options: HonuaControlPlaneRequestOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaPublishMapPackageResponse>> {
    const { ifMatch, ...body } = request;
    return this.#controlPlane.requestJson("map-packages", "POST", "/packages", body, {
      ...options,
      headers: withIfMatch(options.headers, ifMatch),
    });
  }

  public locator(packageId: string): { readonly path: string } {
    return { path: this.#controlPlane.resolvePath(`/packages/${encodeURIComponent(packageId)}`) };
  }
}

export class HonuaImportsClient {
  readonly #controlPlane: HonuaControlPlaneClient;

  public constructor(controlPlane: HonuaControlPlaneClient) {
    this.#controlPlane = controlPlane;
  }

  public listJobs(
    options: HonuaControlPlaneListOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaControlPlanePage<HonuaControlPlaneJob>>> {
    return this.#controlPlane.requestPage<HonuaImportJobResponse>("imports", "/import/jobs", options).then((result) =>
      result.supported
        ? {
            supported: true,
            value: {
              ...result.value,
              items: result.value.items.map(normalizeImportJob),
            },
          }
        : result,
    );
  }

  public create(
    request: HonuaImportCreateRequest,
    options: HonuaControlPlaneRequestOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaControlPlaneJob>> {
    const fileName = stringOption(request.options, "fileName") ?? fileNameFromUrl(request.sourceUrl);
    const tableName = stringOption(request.options, "tableName") ?? slug(request.title ?? fileName ?? "imported_data");
    const body = {
      sourceUrl: request.sourceUrl,
      fileName: fileName ?? "import.geojson",
      tableName,
      targetSchema: stringOption(request.options, "targetSchema"),
      sourceSrid: numberOption(request.options, "sourceSrid"),
      targetSrid: numberOption(request.options, "targetSrid") ?? 4326,
      overwriteExisting: booleanOption(request.options, "overwriteExisting") ?? false,
      forceBackground: true,
      trackProgress: true,
    };
    return this.#controlPlane
      .requestJson<HonuaImportJobResponse>("imports", "POST", "/import/upload-url", body, options)
      .then((result) => (result.supported ? { supported: true, value: normalizeImportJob(result.value) } : result));
  }

  public getJob(
    jobId: string,
    options: HonuaControlPlaneRequestOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaControlPlaneJob>> {
    return this.#controlPlane
      .requestJson<HonuaImportJobResponse>(
        "imports",
        "GET",
        `/import/jobs/${encodeURIComponent(jobId)}`,
        undefined,
        options,
      )
      .then((result) => (result.supported ? { supported: true, value: normalizeImportJob(result.value) } : result));
  }

  public job(jobId: string): HonuaControlPlaneJobHandle {
    return new HonuaControlPlaneJobHandle(this.#controlPlane, "imports", `/import/jobs/${encodeURIComponent(jobId)}`);
  }
}

interface HonuaImportJobResponse {
  readonly jobId?: string;
  readonly statusUrl?: string;
  readonly cancelUrl?: string;
  readonly id?: string;
  readonly status?: string;
}

function normalizeImportJob(value: HonuaImportJobResponse): HonuaControlPlaneJob {
  const id = value.id ?? value.jobId;
  if (!id) throw new Error("Import response did not contain a job identifier.");
  return {
    id,
    type: "import",
    status: (value.status ?? "queued").toLowerCase() as HonuaControlPlaneJobStatus,
    links: {
      ...(value.statusUrl ? { self: value.statusUrl } : {}),
      ...(value.cancelUrl ? { cancel: value.cancelUrl } : {}),
    },
  };
}

function stringOption(options: Record<string, unknown> | undefined, key: string): string | undefined {
  return typeof options?.[key] === "string" ? (options[key] as string) : undefined;
}

function numberOption(options: Record<string, unknown> | undefined, key: string): number | undefined {
  return typeof options?.[key] === "number" ? (options[key] as number) : undefined;
}

function booleanOption(options: Record<string, unknown> | undefined, key: string): boolean | undefined {
  return typeof options?.[key] === "boolean" ? (options[key] as boolean) : undefined;
}

function fileNameFromUrl(sourceUrl: string | undefined): string | undefined {
  if (!sourceUrl) return undefined;
  try {
    const name = new URL(sourceUrl).pathname.split("/").pop();
    return name || undefined;
  } catch {
    return undefined;
  }
}

function slug(value: string): string {
  const normalized = Array.from(value.trim(), (character) => {
    const code = character.charCodeAt(0);
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
      ? character
      : "_";
  }).join("");
  let start = 0;
  while (start < normalized.length && normalized[start] === "_") start += 1;
  let end = normalized.length;
  while (end > start && normalized[end - 1] === "_") end -= 1;
  return normalized.slice(start, end) || "imported_data";
}

export class HonuaApiTokensClient {
  readonly #controlPlane: HonuaControlPlaneClient;

  public constructor(controlPlane: HonuaControlPlaneClient) {
    this.#controlPlane = controlPlane;
  }

  public list(
    options: HonuaControlPlaneListOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaControlPlanePage<HonuaApiToken>>> {
    return this.#controlPlane.requestPage<HonuaApiToken>("api-tokens", "/tokens", options).then(redactPageResult);
  }

  public create(
    request: HonuaApiTokenCreateRequest,
    options: HonuaControlPlaneRequestOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaApiToken>> {
    return this.#controlPlane
      .requestJson<HonuaApiToken>("api-tokens", "POST", "/tokens", request, options)
      .then(redactTokenResult);
  }

  public revoke(
    tokenId: string,
    options: HonuaControlPlaneRequestOptions = {},
  ): Promise<HonuaControlPlaneResult<void>> {
    return this.#controlPlane.requestJson(
      "api-tokens",
      "DELETE",
      `/tokens/${encodeURIComponent(tokenId)}`,
      undefined,
      options,
    );
  }
}

export class HonuaWorkspacesClient {
  readonly #controlPlane: HonuaControlPlaneClient;

  public constructor(controlPlane: HonuaControlPlaneClient) {
    this.#controlPlane = controlPlane;
  }

  public list(
    options: HonuaControlPlaneListOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaControlPlanePage<HonuaWorkspaceSummary>>> {
    return this.#controlPlane.requestPage("workspaces", "/workspaces", options);
  }
}

export class HonuaConnectionsClient {
  readonly #controlPlane: HonuaControlPlaneClient;

  public constructor(controlPlane: HonuaControlPlaneClient) {
    this.#controlPlane = controlPlane;
  }

  public list(
    options: HonuaControlPlaneListOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaControlPlanePage<HonuaConnectionSummary>>> {
    return this.#controlPlane
      .requestPage<HonuaConnectionSummary>("connections", "/connections", options)
      .then(redactPageResult);
  }
}

export class HonuaSharingClient {
  readonly #controlPlane: HonuaControlPlaneClient;

  public constructor(controlPlane: HonuaControlPlaneClient) {
    this.#controlPlane = controlPlane;
  }

  public updateMapSharing(
    mapId: string,
    request: HonuaShareRequest,
    options: HonuaControlPlaneRequestOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaShareResponse>> {
    const { ifMatch, ...body } = request;
    return this.#controlPlane.requestJson("sharing", "PUT", `/maps/${encodeURIComponent(mapId)}/sharing`, body, {
      ...options,
      headers: withIfMatch(options.headers, ifMatch),
    });
  }
}

export class HonuaControlPlaneJobHandle {
  readonly #controlPlane: HonuaControlPlaneClient;
  readonly #capability: HonuaControlPlaneCapability;
  readonly #path: string;

  public constructor(controlPlane: HonuaControlPlaneClient, capability: HonuaControlPlaneCapability, path: string) {
    this.#controlPlane = controlPlane;
    this.#capability = capability;
    this.#path = path;
  }

  public poll(options: HonuaControlPlaneRequestOptions = {}): Promise<HonuaControlPlaneResult<HonuaControlPlaneJob>> {
    return this.#controlPlane
      .requestJson<HonuaControlPlaneJob>(this.#capability, "GET", this.#path, undefined, options)
      .then((result) =>
        this.#capability === "imports" && result.supported
          ? { supported: true, value: normalizeImportJob(result.value) }
          : result,
      );
  }
}

function supported<T>(value: T): HonuaControlPlaneResult<T> {
  return { supported: true, value };
}

function unsupportedFromError<T>(capability: HonuaControlPlaneCapability, error: unknown): HonuaControlPlaneResult<T> {
  if (error instanceof HonuaHttpError && (error.statusCode === 404 || error.statusCode === 501)) {
    return unsupportedFromStatus(capability, error.statusCode, error.body);
  }
  throw error;
}

function unsupportedFromStatus<T>(
  capability: HonuaControlPlaneCapability,
  statusCode: number,
  body: unknown,
): HonuaControlPlaneResult<T> {
  const problem = toProblemDetails(body);
  return {
    supported: false,
    capability,
    statusCode,
    reason:
      problem?.detail ??
      problem?.title ??
      `Control-plane capability "${capability}" is not exposed by this deployment.`,
    ...(problem ? { problem } : {}),
  };
}

function normalizeBasePath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return trimTrailingSlashes(normalized);
}

function withListQuery(path: string, options: HonuaControlPlaneListOptions): string {
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.workspaceId) params.set("workspaceId", options.workspaceId);
  if (options.q) params.set("q", options.q);
  if (options.includeDeleted !== undefined) params.set("includeDeleted", String(options.includeDeleted));
  const query = params.toString();
  return query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;
}

function withManifestQuery(path: string, environment?: string, workspaceId?: string): string {
  const params = new URLSearchParams();
  if (environment) params.set("environment", environment);
  if (workspaceId) params.set("workspaceId", workspaceId);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * Base JSON headers plus the concurrency/idempotency options every request
 * option bag can carry.
 *
 * The option-level `idempotencyKey`/`ifMatch` are applied **after** raw
 * `headers`, so a raw `Idempotency-Key`/`If-Match` entry cannot silently
 * replace the value the caller passed as an option — the command layer records
 * that value on its receipt, and a receipt that disagrees with the wire is
 * worse than no receipt. Per-request `ifMatch` on a resource-client method is
 * folded into `headers` by {@link withIfMatch} and still applies whenever the
 * option-level shorthand is absent, which is every existing call site.
 */
function jsonHeaders(options: HonuaControlPlaneRequestOptions): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...headersToRecord(options.headers),
    ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    ...(options.ifMatch ? { "If-Match": options.ifMatch } : {}),
  };
}

function listHeaders(options: HonuaControlPlaneListOptions): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...headersToRecord(options.headers),
    ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    ...(options.ifMatch ? { "If-Match": options.ifMatch } : {}),
  };
  if (options.validator?.etag) headers["If-None-Match"] = options.validator.etag;
  if (options.validator?.lastModified) headers["If-Modified-Since"] = options.validator.lastModified;
  return headers;
}

function withIfMatch(headers: HeadersInit | undefined, ifMatch: string | undefined): HeadersInit | undefined {
  if (!ifMatch) return headers;
  return { ...headersToRecord(headers), "If-Match": ifMatch };
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  return JSON.parse(text);
}

function normalizePage<T>(
  body: unknown,
  response: Response,
  options: { readonly fallbackValidator?: HonuaControlPlaneListOptions["validator"] } = {},
): HonuaControlPlanePage<T> {
  const value = isRecord(body) ? body : {};
  const items = (Array.isArray(value.items) ? value.items : Array.isArray(value.data) ? value.data : []) as T[];
  const pagination = isRecord(value.pagination) ? value.pagination : value;
  const validator = honuaCacheValidatorFromHeaders(response.headers) ?? options.fallbackValidator;
  const sourceUpdatedAt = response.headers.get("last-modified") ?? undefined;
  return {
    items,
    pagination: {
      nextCursor: stringValue(pagination.nextCursor ?? pagination.next),
      previousCursor: stringValue(pagination.previousCursor ?? pagination.previous),
      limit: numberValue(pagination.limit),
      total: numberValue(pagination.total),
    },
    ...(validator ? { validator } : {}),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
  };
}

function toProblemDetails(body: unknown): HonuaProblemDetails | undefined {
  if (!isRecord(body)) return undefined;
  const candidate = isRecord(body.problem) ? body.problem : body;
  return candidate as HonuaProblemDetails;
}

function redactPageResult<T extends Record<string, unknown>>(
  result: HonuaControlPlaneResult<HonuaControlPlanePage<T>>,
): HonuaControlPlaneResult<HonuaControlPlanePage<T>> {
  if (!result.supported) return result;
  return {
    supported: true,
    value: {
      ...result.value,
      items: result.value.items.map(redactSecrets),
    },
  };
}

function redactTokenResult(result: HonuaControlPlaneResult<HonuaApiToken>): HonuaControlPlaneResult<HonuaApiToken> {
  if (!result.supported) return result;
  return { supported: true, value: redactSecrets(result.value) as HonuaApiToken };
}

function redactSecrets<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = { ...value };
  for (const key of ["value", "secret", "password", "token"]) {
    if (typeof out[key] === "string") out[key] = "[REDACTED]";
  }
  return out as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
