import { honuaCacheValidatorFromHeaders } from "../core/cache-state.js";
import type { HonuaClient } from "../core/client.js";
import { HonuaHttpError } from "../core/errors.js";
import type { QueryMethod } from "../core/types.js";
import type { HonuaMapPackage } from "../runtime/index.js";
import {
  HONUA_CONTROL_PLANE_BASE_PATH,
  type HonuaApiToken,
  type HonuaApiTokenCreateRequest,
  type HonuaConnectionSummary,
  type HonuaControlPlaneCapability,
  type HonuaControlPlaneJob,
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
      okStatuses: request.okStatuses,
    });
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
          headers: jsonHeaders(options.headers),
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
      const response = await this.#client.pipelineFetch(
        "GET",
        this.resolvePath(withListQuery(path, options)),
        { headers: listHeaders(options) },
        options.signal,
      );
      const value = normalizePage<T>(await readJson(response), response);
      return supported(value);
    } catch (error) {
      return unsupportedFromError(capability, error);
    }
  }

  public resolvePath(path: string): string {
    if (path.startsWith("http://") || path.startsWith("https://")) return path;
    const normalized = path.startsWith("/") ? path : `/${path}`;
    if (normalized === this.#basePath || normalized.startsWith(`${this.#basePath}/`)) return normalized;
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
    return this.#controlPlane.requestPage("imports", "/imports/jobs", options);
  }

  public create(
    request: HonuaImportCreateRequest,
    options: HonuaControlPlaneRequestOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaControlPlaneJob>> {
    return this.#controlPlane.requestJson("imports", "POST", "/imports", request, options);
  }

  public getJob(
    jobId: string,
    options: HonuaControlPlaneRequestOptions = {},
  ): Promise<HonuaControlPlaneResult<HonuaControlPlaneJob>> {
    return this.#controlPlane.requestJson(
      "imports",
      "GET",
      `/imports/jobs/${encodeURIComponent(jobId)}`,
      undefined,
      options,
    );
  }

  public job(jobId: string): HonuaControlPlaneJobHandle {
    return new HonuaControlPlaneJobHandle(this.#controlPlane, "imports", `/imports/jobs/${encodeURIComponent(jobId)}`);
  }
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
    return this.#controlPlane.requestJson(this.#capability, "GET", this.#path, undefined, options);
  }
}

function supported<T>(value: T): HonuaControlPlaneResult<T> {
  return { supported: true, value };
}

function unsupportedFromError<T>(capability: HonuaControlPlaneCapability, error: unknown): HonuaControlPlaneResult<T> {
  if (error instanceof HonuaHttpError && (error.statusCode === 404 || error.statusCode === 501)) {
    const problem = toProblemDetails(error.body);
    return {
      supported: false,
      capability,
      statusCode: error.statusCode,
      reason:
        problem?.detail ??
        problem?.title ??
        `Control-plane capability "${capability}" is not exposed by this deployment.`,
      ...(problem ? { problem } : {}),
    };
  }
  throw error;
}

function normalizeBasePath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.replace(/\/+$/, "");
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

function jsonHeaders(headers: HeadersInit | undefined): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...headersToRecord(headers),
  };
}

function listHeaders(options: HonuaControlPlaneListOptions): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...headersToRecord(options.headers),
  };
  if (options.refresh || options.validator?.etag) headers["If-None-Match"] = options.validator?.etag ?? "";
  if (options.refresh || options.validator?.lastModified)
    headers["If-Modified-Since"] = options.validator?.lastModified ?? "";
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

function normalizePage<T>(body: unknown, response: Response): HonuaControlPlanePage<T> {
  const value = isRecord(body) ? body : {};
  const items = (Array.isArray(value.items) ? value.items : Array.isArray(value.data) ? value.data : []) as T[];
  const pagination = isRecord(value.pagination) ? value.pagination : value;
  const validator = honuaCacheValidatorFromHeaders(response.headers);
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
