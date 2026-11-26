import { HonuaAbortError, HonuaNetworkError, HonuaTimeoutError } from "../core/errors.js";
import { encodePathSegment, trimTrailingSlashes } from "../core/path-utils.js";
import {
  DEFAULT_RETRY_METHODS,
  type NormalizedRetryOptions,
  createTimeoutSignal,
  isAuthRefreshStatus,
  normalizeNetworkError,
  normalizeRetryOptions,
  normalizeTimeoutMs,
  resolveRetryDelayMs,
  shouldRetryRequest,
  sleep,
  toHttpError,
} from "../core/request-pipeline.js";
import type {
  HonuaAuthCredentials,
  HonuaAuthCredentialsProvider,
  HonuaAuthProvider,
  HonuaRetryOptions,
  QueryMethod,
} from "../core/types.js";
import { mergeHeaders } from "../core/wire-shared.js";
import type { operations } from "./generated/admin-api.js";
import { ADMIN_API_BASE_PATH, ADMIN_OPERATIONS, type AdminOperationId } from "./generated/admin-operations.js";

const ADMIN_REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const ADMIN_MAX_REDIRECTS = 20;
const DEFAULT_ADMIN_TIMEOUT_MS = 30_000;
const DEFAULT_ADMIN_MAX_RETRIES = 2;

type Operation<Id extends AdminOperationId> = operations[Id];
type OperationParameters<Id extends AdminOperationId> = Operation<Id> extends {
  parameters: infer Parameters;
}
  ? Parameters
  : never;
type ParameterValue<
  Id extends AdminOperationId,
  Kind extends "header" | "path" | "query",
> = OperationParameters<Id> extends { [Key in Kind]?: infer Value } ? Exclude<Value, undefined> : never;
type RequiredRequestBody<Id extends AdminOperationId> = Operation<Id> extends {
  requestBody: infer RequestBody;
}
  ? RequestBody
  : never;
type OptionalRequestBody<Id extends AdminOperationId> = Operation<Id> extends {
  requestBody?: infer RequestBody;
}
  ? Exclude<RequestBody, undefined>
  : never;
type RequestBodyContent<RequestBody> = RequestBody extends { content: infer Content } ? Content : never;
type ContentValue<Content> = Content extends Record<PropertyKey, unknown> ? Content[keyof Content] : never;

export type AdminOperationRequestBody<Id extends AdminOperationId> = ContentValue<
  RequestBodyContent<RequiredRequestBody<Id> | OptionalRequestBody<Id>>
>;
export type AdminOperationContentType<Id extends AdminOperationId> = Extract<
  keyof RequestBodyContent<RequiredRequestBody<Id> | OptionalRequestBody<Id>>,
  string
>;

type OptionalField<Name extends string, Value> = [Value] extends [never]
  ? { readonly [Key in Name]?: never }
  : { readonly [Key in Name]?: Value };
type RequiredField<Name extends string, Value> = [Value] extends [never]
  ? { readonly [Key in Name]?: never }
  : { readonly [Key in Name]: Value };
type BodyField<Id extends AdminOperationId> = [RequiredRequestBody<Id>] extends [never]
  ? [OptionalRequestBody<Id>] extends [never]
    ? { readonly body?: never; readonly contentType?: never }
    : {
        readonly body?: AdminOperationRequestBody<Id>;
        readonly contentType?: AdminOperationContentType<Id>;
      }
  : {
      readonly body: AdminOperationRequestBody<Id>;
      readonly contentType?: AdminOperationContentType<Id>;
    };

export type AdminOperationRequest<Id extends AdminOperationId> = RequiredField<"path", ParameterValue<Id, "path">> &
  OptionalField<"query", ParameterValue<Id, "query">> &
  OptionalField<"headers", ParameterValue<Id, "header"> & HeadersInit> &
  BodyField<Id> & {
    readonly signal?: AbortSignal;
  };

type SuccessStatus<Status> = Status extends number
  ? `${Status}` extends `2${string}`
    ? Status
    : never
  : Status extends `${2}${string}`
    ? Status
    : never;
type ResponseContent<Response> = Response extends { content: infer Content } ? ContentValue<Content> : undefined;
type SuccessResponsePayload<Responses> = {
  [Status in keyof Responses]: SuccessStatus<Status> extends never ? never : ResponseContent<Responses[Status]>;
}[keyof Responses];

export type AdminOperationResponse<Id extends AdminOperationId> = Operation<Id> extends {
  responses: infer Responses;
}
  ? SuccessResponsePayload<Responses>
  : never;

export interface AdminClientOptions {
  readonly baseUrl: string;
  /** Scoped API key; sent as `X-API-Key`. */
  readonly apiKey?: string;
  /** Root/admin key. Takes precedence over `apiKey`. */
  readonly adminKey?: string;
  /** Bearer token (OIDC / operator token); sent as `Authorization: Bearer <token>`. */
  readonly bearerToken?: string;
  /** Pluggable auth provider for OIDC / rotating credentials. */
  readonly auth?: HonuaAuthProvider | HonuaAuthCredentialsProvider;
  readonly basePath?: string;
  readonly fetchFn?: typeof fetch;
  readonly headers?: HeadersInit;
  /** Per-attempt timeout in milliseconds. Defaults to 30000. */
  readonly timeoutMs?: number;
  /** Retry policy for transient failures (honors `Honua-Retryable` and `Retry-After`). */
  readonly retry?: HonuaRetryOptions;
}

export interface AdminOperationResult<Id extends AdminOperationId> {
  readonly operationId: Id;
  readonly data: AdminOperationResponse<Id>;
  readonly response: Response;
}

export class HonuaAdminApiError extends Error {
  public readonly operationId: AdminOperationId;
  public readonly statusCode: number;
  public readonly body: unknown;

  public constructor(operationId: AdminOperationId, response: Response, body: unknown) {
    const detail = structuredErrorDetail(body);
    super(`Admin operation ${operationId} failed with HTTP ${response.status}.${detail ? ` ${detail}` : ""}`);
    this.name = "HonuaAdminApiError";
    this.operationId = operationId;
    this.statusCode = response.status;
    this.body = body;
  }
}

function structuredErrorDetail(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const detail = [record.detail, record.message, record.title].find(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  if (detail) return detail;
  if (record.errors !== undefined) {
    try {
      return JSON.stringify(record.errors);
    } catch {
      return "The server returned structured validation errors.";
    }
  }
  return undefined;
}

class AdminRedirectPolicyError extends HonuaNetworkError {
  public constructor(message: string) {
    super(message, undefined);
  }
}

/**
 * Complete generated Admin REST client. Curated clients may wrap this surface,
 * but every operation in the pinned OpenAPI contract remains callable here.
 */
export class HonuaAdminClient {
  readonly #baseUrl: string;
  readonly #baseOrigin: string;
  readonly #basePath: string;
  readonly #fetch: typeof fetch;
  readonly #baseHeaders: Record<string, string>;
  readonly #credential: string | undefined;
  readonly #bearerToken: string | undefined;
  readonly #auth: HonuaAuthProvider | undefined;
  readonly #timeoutMs: number | undefined;
  readonly #retryOptions: NormalizedRetryOptions | undefined;

  public constructor(options: AdminClientOptions) {
    assertAdminBaseUrl(options.baseUrl);
    const baseUrl = new URL(options.baseUrl);
    this.#baseUrl = baseUrl.toString().replace(/\/+$/, "");
    this.#baseOrigin = baseUrl.origin;
    this.#basePath = normalizeBasePath(options.basePath ?? ADMIN_API_BASE_PATH);
    const fetchFn = options.fetchFn;
    this.#fetch = fetchFn ? (input, init) => fetchFn(input, init) : globalThis.fetch.bind(globalThis);
    this.#baseHeaders = mergeHeaders(options.headers);
    this.#credential = options.adminKey ?? options.apiKey;
    this.#bearerToken = options.bearerToken;
    this.#auth = normalizeAdminAuth(options.auth);
    this.#timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? DEFAULT_ADMIN_TIMEOUT_MS);
    this.#retryOptions = normalizeRetryOptions(options.retry ?? { maxRetries: DEFAULT_ADMIN_MAX_RETRIES });
  }

  public async call<Id extends AdminOperationId>(
    operationId: Id,
    request: AdminOperationRequest<Id>,
  ): Promise<AdminOperationResult<Id>> {
    const descriptor = ADMIN_OPERATIONS[operationId];
    const path = interpolatePath(descriptor.path, request.path as Record<string, unknown> | undefined);
    const url = new URL(`${this.#baseUrl}${this.#basePath}${path}`);
    appendQuery(url, request.query as Record<string, unknown> | undefined);

    const authHeaders = await this.#resolveAuthHeaders(false);
    const headers = new Headers(this.#composeHeaders(request.headers as HeadersInit | undefined, authHeaders));
    const body = encodeBody(
      request.body,
      request.contentType as string | undefined,
      headers,
      descriptor.requestContentTypes,
    );
    const method = descriptor.method as QueryMethod;
    return this.#executeWithRetry({
      operationId,
      method,
      url: url.toString(),
      headers,
      body,
      signal: request.signal,
    });
  }

  #composeHeaders(
    perCallHeaders: HeadersInit | undefined,
    providerHeaders: Record<string, string> | undefined,
  ): Record<string, string> {
    const enforced: Record<string, string> = {};
    if (this.#credential) enforced["X-API-Key"] = this.#credential;
    if (this.#bearerToken) enforced.Authorization = `Bearer ${this.#bearerToken}`;
    return mergeHeaders(this.#baseHeaders, perCallHeaders, providerHeaders, enforced);
  }

  async #resolveAuthHeaders(forceRefresh: boolean): Promise<Record<string, string> | undefined> {
    if (!this.#auth) return undefined;
    const raw = await this.#auth.getCredentials({
      reason: forceRefresh ? "unauthorized" : "initial",
      forceRefresh,
    });
    return adminAuthHeadersFromResult(raw);
  }

  async #tryRefreshHeaders(headers: Headers, statusCode: number, method: QueryMethod): Promise<Headers | undefined> {
    if (!this.#auth || !isAuthRefreshStatus(statusCode) || !DEFAULT_RETRY_METHODS.has(method)) {
      return undefined;
    }
    const refreshed = await this.#resolveAuthHeaders(true);
    return refreshed ? new Headers(mergeHeaders(headers, refreshed)) : undefined;
  }

  async #executeWithRetry<Id extends AdminOperationId>(spec: {
    readonly operationId: Id;
    readonly method: QueryMethod;
    readonly url: string;
    readonly headers: Headers;
    readonly body: BodyInit | null;
    readonly signal?: AbortSignal;
  }): Promise<AdminOperationResult<Id>> {
    let headers = spec.headers;
    let refreshedAuth = false;
    for (let attempt = 0; ; attempt += 1) {
      const attemptOutcome = await this.#runAttempt({ ...spec, headers, attempt });
      if (attemptOutcome.kind === "retry") continue;
      const { response } = attemptOutcome;
      const data = await readResponse(response);
      if (response.ok) return { operationId: spec.operationId, data: data as AdminOperationResponse<Id>, response };

      const refreshedHeaders = refreshedAuth
        ? undefined
        : await this.#tryRefreshHeaders(headers, response.status, spec.method);
      if (refreshedHeaders) {
        headers = refreshedHeaders;
        refreshedAuth = true;
        continue;
      }
      const httpError = toHttpError(response.status, data, response.headers);
      if (shouldRetryRequest(this.#retryOptions, spec.method, attempt, response.status, httpError)) {
        await sleep(resolveRetryDelayMs(this.#retryOptions, attempt, response), spec.signal);
        continue;
      }
      throw new HonuaAdminApiError(spec.operationId, response, data);
    }
  }

  async #runAttempt(spec: {
    readonly method: QueryMethod;
    readonly url: string;
    readonly headers: Headers;
    readonly body: BodyInit | null;
    readonly signal?: AbortSignal;
    readonly attempt: number;
  }): Promise<{ readonly kind: "response"; readonly response: Response } | { readonly kind: "retry" }> {
    const timeout = createTimeoutSignal(spec.signal, this.#timeoutMs);
    try {
      const response = await this.#fetchWithSafeRedirects(spec.url, {
        method: spec.method,
        headers: spec.headers,
        body: spec.body,
        signal: timeout.signal,
      });
      return { kind: "response", response };
    } catch (error) {
      if (error instanceof AdminRedirectPolicyError) throw error;
      const normalized = timeout.didTimeout
        ? new HonuaTimeoutError(this.#timeoutMs ?? 0)
        : error instanceof HonuaAbortError || error instanceof HonuaTimeoutError || error instanceof HonuaNetworkError
          ? error
          : normalizeNetworkError(error);
      if (shouldRetryRequest(this.#retryOptions, spec.method, spec.attempt, undefined, normalized)) {
        await sleep(resolveRetryDelayMs(this.#retryOptions, spec.attempt), spec.signal);
        return { kind: "retry" };
      }
      throw normalized;
    } finally {
      timeout.dispose();
    }
  }

  async #fetchWithSafeRedirects(url: string, init: RequestInit): Promise<Response> {
    let currentUrl = url;
    let currentInit: RequestInit = init;
    for (let redirects = 0; ; redirects += 1) {
      const response = await this.#fetch(currentUrl, { ...currentInit, redirect: "manual" });

      if (response.type === "opaqueredirect") {
        throw new AdminRedirectPolicyError(
          "Refusing to follow an opaque cross-origin redirect; admin credentials would be leaked to the redirect target.",
        );
      }

      if (!ADMIN_REDIRECT_STATUSES.has(response.status)) {
        return response;
      }

      if (redirects >= ADMIN_MAX_REDIRECTS) {
        throw new AdminRedirectPolicyError(`Exceeded the maximum of ${ADMIN_MAX_REDIRECTS} redirects.`);
      }

      const target = await this.#resolveSameOriginRedirect(response, currentUrl);
      const method = (currentInit.method ?? "GET").toUpperCase();
      const downgradeToGet =
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD");
      currentInit = downgradeToGet ? { ...currentInit, method: "GET", body: null } : currentInit;
      currentUrl = target.toString();
      await response.body?.cancel().catch(() => undefined);
    }
  }

  async #resolveSameOriginRedirect(response: Response, currentUrl: string): Promise<URL> {
    const location = response.headers.get("location");
    if (!location) {
      throw new AdminRedirectPolicyError("Redirect response is missing a Location header.");
    }
    let target: URL;
    try {
      target = new URL(location, currentUrl);
    } catch {
      throw new AdminRedirectPolicyError(`Redirect response has an invalid Location header: ${location}`);
    }
    if (target.origin !== this.#baseOrigin) {
      await response.body?.cancel().catch(() => undefined);
      throw new AdminRedirectPolicyError(
        `Refusing to follow a cross-origin redirect to ${target.origin}; admin credentials would be leaked.`,
      );
    }
    return target;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function createHonuaAdminClient(options: AdminClientOptions): HonuaAdminClient {
  return new HonuaAdminClient(options);
}

/** Enforce the admin credential transport policy for command-layer requests. */
export function assertAdminBaseUrl(baseUrl: string): void {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Admin client baseUrl must use http or https.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Admin client baseUrl must not include credentials, query parameters, or a fragment.");
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("Admin client requires HTTPS except for exact loopback HTTP development endpoints.");
  }
}

function normalizeBasePath(value: string): string {
  const rooted = value.startsWith("/") ? value : `/${value}`;
  return trimTrailingSlashes(rooted);
}

function interpolatePath(template: string, parameters: Record<string, unknown> | undefined): string {
  const used = new Set<string>();
  const path = template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = parameters?.[name];
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing required admin path parameter: ${name}`);
    }
    used.add(name);
    return encodePathSegment(String(value));
  });
  for (const name of Object.keys(parameters ?? {})) {
    if (!used.has(name)) throw new Error(`Unknown admin path parameter for ${template}: ${name}`);
  }
  return path;
}

function appendQuery(url: URL, query: Record<string, unknown> | undefined): void {
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(name, String(item));
    } else {
      url.searchParams.set(name, String(value));
    }
  }
}

function normalizeAdminAuth(
  auth: HonuaAuthProvider | HonuaAuthCredentialsProvider | undefined,
): HonuaAuthProvider | undefined {
  if (!auth) return undefined;
  return typeof auth === "function" ? { getCredentials: auth } : auth;
}

function adminAuthHeadersFromResult(
  raw: HonuaAuthCredentials | string | null | undefined,
): Record<string, string> | undefined {
  if (typeof raw === "string") {
    return raw.length > 0 ? { Authorization: `Bearer ${raw}` } : undefined;
  }
  if (!raw) return undefined;
  const headers: Record<string, string> = {};
  if (typeof raw.apiKey === "string" && raw.apiKey.length > 0) headers["X-API-Key"] = raw.apiKey;
  if (typeof raw.authorization === "string" && raw.authorization.length > 0) {
    headers.Authorization = raw.authorization;
  } else if (typeof raw.bearerToken === "string" && raw.bearerToken.length > 0) {
    headers.Authorization = `Bearer ${raw.bearerToken}`;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function encodeBody(
  value: unknown,
  contentType: string | undefined,
  headers: Headers,
  declaredContentTypes: readonly string[],
): BodyInit | null {
  if (value === undefined) return null;
  const selected = contentType ?? defaultRequestContentType(declaredContentTypes);
  if (selected === "multipart/form-data") return toFormData(value);
  headers.set("Content-Type", selected);
  if (selected.includes("json")) return JSON.stringify(value);
  if (
    typeof value === "string" ||
    value instanceof Uint8Array ||
    value instanceof Blob ||
    value instanceof FormData ||
    value instanceof URLSearchParams
  ) {
    return value as BodyInit;
  }
  return String(value);
}

function defaultRequestContentType(declaredContentTypes: readonly string[]): string {
  if (declaredContentTypes.includes("application/json")) return "application/json";
  return declaredContentTypes[0] ?? "application/json";
}

function toFormData(value: unknown): FormData {
  if (value instanceof FormData) return value;
  if (typeof value !== "object" || value === null) throw new Error("multipart/form-data body must be an object.");
  const form = new FormData();
  for (const [name, field] of Object.entries(value)) {
    if (field === undefined || field === null) continue;
    if (Array.isArray(field)) {
      for (const item of field) form.append(name, formValue(item));
    } else {
      form.append(name, formValue(field));
    }
  }
  return form;
}

function formValue(value: unknown): string | Blob {
  if (value instanceof Blob) return value;
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function readResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) return response.json();
  if (contentType.startsWith("text/") || contentType.includes("xml")) return response.text();
  return response.arrayBuffer();
}
