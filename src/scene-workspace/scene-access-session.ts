/**
 * Host-bound protected-scene asset session with access-envelope acquisition,
 * strict origin/path credential scoping, single-flight refresh, and a
 * credential-safe Cesium resource factory.
 *
 * Credentials remain strictly in closure memory: snapshots, diagnostics,
 * errors, and `toJSON()` / `toString()` never expose token values.
 *
 * @experimental Held back from the beta `@honua/app-platform/scene-workspace`
 *   tier while server-attached protected-scene contracts mature.
 * @module
 */

import type { SceneDiscoveryRequestExecutor } from "./scene-discovery.js";

/** Transport used to carry the short-lived scene access token on asset requests. */
export type SceneAccessCredentialTransport = "header" | "query";

/** Lifecycle state of a protected-scene asset session. */
export type SceneAccessSessionStatus = "idle" | "active" | "refreshing" | "expired" | "disposed";

/** Failure codes raised by {@link HonuaSceneAccessSessionError}. */
export type SceneAccessSessionErrorCode =
  | "invalid-affordance"
  | "scope-violation"
  | "cross-origin-denied"
  | "redirect-denied"
  | "method-denied"
  | "expired"
  | "unauthorized"
  | "forbidden"
  | "disposed"
  | "refresh-failed";

/** Credential-free POST acquisition affordance advertised by scene resolution. */
export interface SceneAccessAffordance {
  readonly method: "POST";
  /** Relative or absolute path for envelope acquisition (e.g. `/scenes/{id}/access-envelope`). */
  readonly path: string;
  /** Authorized asset origin (`https://host[:port]`). */
  readonly origin?: string;
  /** Authorized asset path prefix (e.g. `/scenes/downtown/`). */
  readonly pathPrefix?: string;
  /** Expected credential transport (`header` or `query`). */
  readonly transport?: SceneAccessCredentialTransport;
  /** Header name when `transport` is `header`. Defaults to `X-Honua-Token`. */
  readonly headerName?: string;
  /** Query parameter name when `transport` is `query`. Defaults to `token`. */
  readonly queryParam?: string;
  /** Whether same-scope redirects may carry credentials. Defaults to `false`. */
  readonly allowRedirects?: boolean;
}

/** Explicit credential scope bound to a single scene origin and path prefix. */
export interface SceneAccessScope {
  readonly origin: string;
  readonly pathPrefix: string;
  readonly allowedMethods: readonly string[];
  readonly transport: SceneAccessCredentialTransport;
  readonly headerName?: string;
  readonly queryParam?: string;
  readonly allowRedirects: boolean;
}

/** Raw envelope shape returned by the server POST acquisition route. */
export interface SceneAccessEnvelopePayload {
  readonly sceneId: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly refreshAfter: string;
  readonly contractVersion: "2026-08-v1";
  readonly allowedMethods: readonly string[];
  readonly assetScopes: readonly {
    readonly scheme: string;
    readonly host: string;
    readonly port: number;
    readonly pathPrefix: string;
  }[];
  readonly transports: readonly {
    readonly kind: SceneAccessCredentialTransport;
    readonly name: string;
    readonly valueTemplate: string;
    readonly preferred: boolean;
  }[];
}

/** Credential-free, serializable snapshot of a protected-scene asset session. */
export interface SceneAccessSessionSnapshot {
  readonly sceneId: string;
  readonly status: SceneAccessSessionStatus;
  readonly origin: string;
  readonly pathPrefix: string;
  readonly transport: SceneAccessCredentialTransport;
  readonly allowedMethods: readonly string[];
  readonly expiresAt?: string;
  readonly refreshAfter?: string;
  readonly refreshCount: number;
  readonly generation: number;
}

/** Asset request passed to {@link SceneProtectedAssetSession.authorizeRequest} or `fetchAsset`. */
export interface SceneAssetResourceRequest {
  readonly url: string;
  readonly method?: "GET" | "HEAD";
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** Runtime-only Cesium `Resource` descriptor carrying scoped credentials. */
export interface CesiumResourceDescriptor {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly queryParameters?: Readonly<Record<string, string>>;
}

/** Options for {@link createProtectedSceneAssetSession}. */
export interface CreateProtectedSceneAssetSessionOptions {
  readonly sceneId: string;
  readonly affordance: SceneAccessAffordance;
  /** Authenticated SDK request executor used for the envelope POST. */
  readonly execute: SceneDiscoveryRequestExecutor;
  /** Fetch implementation for asset requests (defaults to `globalThis.fetch`). */
  readonly fetchFn?: typeof fetch;
  /** Deterministic clock returning epoch milliseconds (defaults to `Date.now`). */
  readonly now?: () => number;
  /** Optional hook notified on credential-free status transitions. */
  readonly onSnapshot?: (snapshot: SceneAccessSessionSnapshot) => void;
}

/** Host-bound protected-scene asset session. */
export interface SceneProtectedAssetSession {
  readonly sceneId: string;
  snapshot(): SceneAccessSessionSnapshot;
  isUrlInScope(url: string): boolean;
  ensureAccess(options?: {
    readonly forceRefresh?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<SceneAccessSessionSnapshot>;
  authorizeRequest(request: SceneAssetResourceRequest): Promise<CesiumResourceDescriptor>;
  fetchAsset(request: SceneAssetResourceRequest): Promise<Response>;
  createCesiumResourceFactory(options?: {
    readonly baseUrl?: string;
  }): (resourceUrl: string, signal?: AbortSignal) => Promise<CesiumResourceDescriptor>;
  dispose(): void;
  toJSON(): SceneAccessSessionSnapshot;
  toString(): string;
}

const DEFAULT_HEADER_NAME = "X-Honua-Token";
const DEFAULT_QUERY_PARAM = "token";
const DEFAULT_ALLOWED_METHODS: readonly string[] = ["GET", "HEAD"];
const MAX_REDIRECT_HOPS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Typed error raised by protected-scene asset sessions; never embeds tokens. */
export class HonuaSceneAccessSessionError extends Error {
  public readonly code: SceneAccessSessionErrorCode;
  public readonly statusCode?: number;

  public constructor(
    code: SceneAccessSessionErrorCode,
    message: string,
    options: { readonly statusCode?: number; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HonuaSceneAccessSessionError";
    this.code = code;
    this.statusCode = options.statusCode;
  }
}

interface ActiveEnvelope {
  readonly token: string;
  readonly expiresAtIso: string;
  readonly expiresAtMs: number;
  readonly refreshAfterIso: string;
  readonly refreshAfterMs: number;
  readonly scope: SceneAccessScope;
}

/**
 * Create a host-bound protected-scene asset session.
 *
 * Acquires short-lived envelopes via the caller's authenticated pipeline,
 * enforces origin/path-prefix scope on every asset fetch, deduplicates
 * concurrent refreshes, and refuses cross-origin credential leaks.
 */
export function createProtectedSceneAssetSession(
  options: CreateProtectedSceneAssetSessionOptions,
): SceneProtectedAssetSession {
  const sceneId = requireNonEmpty(options.sceneId, "invalid-affordance", "sceneId must be a non-empty string.");
  const initialScope = parseInitialScope(options.affordance);
  const affordancePath = validateAffordancePath(options.affordance);
  const now = options.now ?? (() => Date.now());
  const fetchFn = options.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  let active: ActiveEnvelope | undefined;
  let currentScope: SceneAccessScope = initialScope;
  let status: SceneAccessSessionStatus = "idle";
  let refreshCount = 0;
  let generation = 0;
  let inFlightRefresh: Promise<ActiveEnvelope> | undefined;
  let lifecycleController = new AbortController();

  const buildSnapshot = (): SceneAccessSessionSnapshot => {
    const computedStatus = resolveCurrentStatus(status, active, now());
    return Object.freeze({
      sceneId,
      status: computedStatus,
      origin: currentScope.origin,
      pathPrefix: currentScope.pathPrefix,
      transport: currentScope.transport,
      allowedMethods: Object.freeze([...currentScope.allowedMethods]),
      ...(active ? { expiresAt: active.expiresAtIso, refreshAfter: active.refreshAfterIso } : {}),
      refreshCount,
      generation,
    });
  };

  const notifySnapshot = (): void => {
    options.onSnapshot?.(buildSnapshot());
  };

  const isDisposed = (): boolean => status === "disposed";

  const ensureNotDisposed = (): void => {
    if (isDisposed()) {
      throw new HonuaSceneAccessSessionError("disposed", `Protected scene session for "${sceneId}" has been disposed.`);
    }
  };

  const acquireEnvelope = (signal?: AbortSignal): Promise<ActiveEnvelope> => {
    if (inFlightRefresh) {
      return awaitWithSignal(inFlightRefresh, signal);
    }
    const previousStatus = status;
    status = "refreshing";

    const task = Promise.resolve().then(async (): Promise<ActiveEnvelope> => {
      try {
        ensureNotDisposed();
        const raw = await options.execute<unknown>("POST", affordancePath, undefined, lifecycleController.signal);
        ensureNotDisposed();
        const parsed = parseEnvelopePayload(raw, {
          expectedSceneId: sceneId,
          baseScope: initialScope,
          timestamp: now(),
          expectedTransport: options.affordance.transport,
        });
        active = parsed;
        currentScope = parsed.scope;
        refreshCount += 1;
        generation += 1;
        status = "active";
        notifySnapshot();
        return parsed;
      } catch (cause) {
        if (!isDisposed()) {
          status = previousStatus === "active" && active && now() < active.expiresAtMs ? "active" : "expired";
          notifySnapshot();
        }
        throw classifyAcquisitionError(cause, active?.token);
      } finally {
        inFlightRefresh = undefined;
      }
    });

    inFlightRefresh = task;
    notifySnapshot();
    return awaitWithSignal(task, signal);
  };

  const ensureLiveEnvelope = async (
    requestOptions: { readonly forceRefresh?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<ActiveEnvelope> => {
    ensureNotDisposed();
    requestOptions.signal?.throwIfAborted();
    const timestamp = now();
    const needsAcquisition =
      requestOptions.forceRefresh === true ||
      active === undefined ||
      timestamp >= active.refreshAfterMs ||
      timestamp >= active.expiresAtMs;
    if (!needsAcquisition && active) {
      return active;
    }
    return acquireEnvelope(requestOptions.signal);
  };

  const assertRequestInScope = (rawUrl: string, method: string, scope: SceneAccessScope): URL => {
    const parsedUrl = parseHttpUrl(rawUrl, "scope-violation");
    if (parsedUrl.origin !== scope.origin) {
      throw new HonuaSceneAccessSessionError(
        "cross-origin-denied",
        `Refused to attach scene credentials to cross-origin URL "${parsedUrl.origin}".`,
      );
    }
    if (!isPathWithinPrefix(parsedUrl.pathname, scope.pathPrefix)) {
      throw new HonuaSceneAccessSessionError(
        "scope-violation",
        `URL path "${parsedUrl.pathname}" is outside authorized prefix "${scope.pathPrefix}".`,
      );
    }
    const normalizedMethod = method.toUpperCase();
    if (!scope.allowedMethods.includes(normalizedMethod)) {
      throw new HonuaSceneAccessSessionError(
        "method-denied",
        `HTTP method "${normalizedMethod}" is not permitted by the scene access envelope.`,
      );
    }
    return parsedUrl;
  };

  const buildAuthorizedDescriptor = (
    parsedUrl: URL,
    envelope: ActiveEnvelope,
    callerHeaders?: Readonly<Record<string, string>>,
  ): CesiumResourceDescriptor => {
    const cleanUrl = stripQueryParam(parsedUrl, envelope.scope.queryParam ?? DEFAULT_QUERY_PARAM);
    if (envelope.scope.transport === "query") {
      const paramName = envelope.scope.queryParam ?? DEFAULT_QUERY_PARAM;
      return {
        url: cleanUrl,
        ...(callerHeaders ? { headers: { ...callerHeaders } } : {}),
        queryParameters: { [paramName]: envelope.token },
      };
    }
    const headerName = envelope.scope.headerName ?? DEFAULT_HEADER_NAME;
    return {
      url: cleanUrl,
      headers: { ...callerHeaders, [headerName]: envelope.token },
    };
  };

  const executeSingleFetch = async (
    request: SceneAssetResourceRequest,
    envelope: ActiveEnvelope,
  ): Promise<Response> => {
    const method = (request.method ?? "GET").toUpperCase();
    const sessionSignal = lifecycleController.signal;
    const signal = request.signal ? AbortSignal.any([sessionSignal, request.signal]) : sessionSignal;
    let targetUrl = assertRequestInScope(request.url, method, envelope.scope);

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      const descriptor = buildAuthorizedDescriptor(targetUrl, envelope, request.headers);
      const wireUrl = appendDescriptorQuery(descriptor);
      const response = await fetchFn(wireUrl, {
        method,
        headers: descriptor.headers,
        redirect: "manual",
        signal,
      });
      if (response.type === "opaqueredirect") {
        throw new HonuaSceneAccessSessionError(
          "redirect-denied",
          "Redirect target is unavailable to the scene session.",
        );
      }
      if (!REDIRECT_STATUSES.has(response.status)) {
        return response;
      }
      if (!envelope.scope.allowRedirects || hop === MAX_REDIRECT_HOPS) {
        throw new HonuaSceneAccessSessionError(
          "redirect-denied",
          "Redirect refused to prevent scene credential forwarding.",
          { statusCode: response.status },
        );
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new HonuaSceneAccessSessionError("redirect-denied", "Redirect response omitted Location header.", {
          statusCode: response.status,
        });
      }
      const nextUrl = new URL(location, targetUrl);
      targetUrl = assertRequestInScope(nextUrl.toString(), method, envelope.scope);
    }
    throw new HonuaSceneAccessSessionError("redirect-denied", "Maximum redirect depth exceeded.");
  };

  const session: SceneProtectedAssetSession = {
    sceneId,
    snapshot: buildSnapshot,
    isUrlInScope(url: string): boolean {
      if (status === "disposed") return false;
      try {
        const parsed = parseHttpUrl(url, "scope-violation");
        return parsed.origin === currentScope.origin && isPathWithinPrefix(parsed.pathname, currentScope.pathPrefix);
      } catch {
        return false;
      }
    },
    async ensureAccess(ensureOptions = {}) {
      await ensureLiveEnvelope(ensureOptions);
      return buildSnapshot();
    },
    async authorizeRequest(request: SceneAssetResourceRequest): Promise<CesiumResourceDescriptor> {
      const envelope = await ensureLiveEnvelope({ signal: request.signal });
      const method = (request.method ?? "GET").toUpperCase();
      const parsedUrl = assertRequestInScope(request.url, method, envelope.scope);
      return buildAuthorizedDescriptor(parsedUrl, envelope, request.headers);
    },
    async fetchAsset(request: SceneAssetResourceRequest): Promise<Response> {
      const envelope = await ensureLiveEnvelope({ signal: request.signal });
      const firstResponse = await executeSingleFetch(request, envelope);
      if (firstResponse.status === 403) {
        throw new HonuaSceneAccessSessionError("forbidden", `Access forbidden for protected scene "${sceneId}".`, {
          statusCode: 403,
        });
      }
      if (firstResponse.status !== 401) {
        return firstResponse;
      }
      const rotated = await ensureLiveEnvelope({ forceRefresh: active === envelope, signal: request.signal });
      const retryResponse = await executeSingleFetch(request, rotated);
      if (retryResponse.status === 401) {
        throw new HonuaSceneAccessSessionError(
          "unauthorized",
          `Protected scene "${sceneId}" rejected credentials after envelope refresh.`,
          { statusCode: 401 },
        );
      }
      if (retryResponse.status === 403) {
        throw new HonuaSceneAccessSessionError("forbidden", `Access forbidden for protected scene "${sceneId}".`, {
          statusCode: 403,
        });
      }
      return retryResponse;
    },
    createCesiumResourceFactory(factoryOptions = {}) {
      const base = factoryOptions.baseUrl ?? `${currentScope.origin}${currentScope.pathPrefix}`;
      return async (resourceUrl: string, signal?: AbortSignal): Promise<CesiumResourceDescriptor> => {
        const resolved = new URL(resourceUrl, base).toString();
        return session.authorizeRequest({ url: resolved, method: "GET", signal });
      };
    },
    dispose(): void {
      if (status === "disposed") return;
      status = "disposed";
      active = undefined;
      inFlightRefresh = undefined;
      lifecycleController.abort();
      lifecycleController = new AbortController();
      notifySnapshot();
    },
    toJSON(): SceneAccessSessionSnapshot {
      return buildSnapshot();
    },
    toString(): string {
      const snap = buildSnapshot();
      return `SceneProtectedAssetSession { sceneId=${snap.sceneId}, status=${snap.status}, origin=${snap.origin}, pathPrefix=${snap.pathPrefix}, token=[redacted] }`;
    },
  };

  return session;
}

function requireNonEmpty(value: unknown, code: SceneAccessSessionErrorCode, message: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HonuaSceneAccessSessionError(code, message);
  }
  return value.trim();
}

function validateAffordancePath(affordance: SceneAccessAffordance): string {
  if (!affordance || affordance.method !== "POST") {
    throw new HonuaSceneAccessSessionError("invalid-affordance", "Access affordance must declare method POST.");
  }
  return requireNonEmpty(affordance.path, "invalid-affordance", "Access affordance must declare a non-empty path.");
}

function parseInitialScope(affordance: SceneAccessAffordance): SceneAccessScope {
  if (!affordance || typeof affordance !== "object") {
    throw new HonuaSceneAccessSessionError("invalid-affordance", "Access affordance must be an object.");
  }
  const rawOrigin = requireNonEmpty(
    affordance.origin,
    "invalid-affordance",
    "Access affordance must declare an explicit asset origin.",
  );
  const originUrl = parseHttpUrl(rawOrigin, "invalid-affordance");
  const pathPrefix = normalizePathPrefix(
    requireNonEmpty(
      affordance.pathPrefix,
      "invalid-affordance",
      "Access affordance must declare an explicit asset pathPrefix.",
    ),
  );
  const transport = affordance.transport ?? "header";
  if (transport !== "header" && transport !== "query") {
    throw new HonuaSceneAccessSessionError(
      "invalid-affordance",
      `Unsupported credential transport "${String(transport)}".`,
    );
  }
  return {
    origin: originUrl.origin,
    pathPrefix,
    allowedMethods: [...DEFAULT_ALLOWED_METHODS],
    transport,
    headerName: affordance.headerName ?? DEFAULT_HEADER_NAME,
    queryParam: affordance.queryParam ?? DEFAULT_QUERY_PARAM,
    allowRedirects: affordance.allowRedirects === true,
  };
}

function parseEnvelopePayload(
  raw: unknown,
  context: {
    expectedSceneId: string;
    baseScope: SceneAccessScope;
    timestamp: number;
    expectedTransport?: SceneAccessCredentialTransport;
  },
): ActiveEnvelope {
  const { expectedSceneId, baseScope, timestamp, expectedTransport } = context;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HonuaSceneAccessSessionError("refresh-failed", "Access envelope response must be a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  const token = requireNonEmpty(record.token, "refresh-failed", "Access envelope response is missing a token.");
  const responseSceneId = record.sceneId;
  if (responseSceneId !== expectedSceneId) {
    throw new HonuaSceneAccessSessionError(
      "scope-violation",
      "Access envelope scene ID does not match the requested scene.",
    );
  }
  const expiresAtIso = requireNonEmpty(record.expiresAt, "refresh-failed", "Access envelope is missing expiresAt.");
  const refreshAfterIso = requireNonEmpty(
    record.refreshAfter,
    "refresh-failed",
    "Access envelope is missing refreshAfter.",
  );
  const expiresAtMs = Date.parse(expiresAtIso);
  const refreshAfterMs = Date.parse(refreshAfterIso);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(refreshAfterMs)) {
    throw new HonuaSceneAccessSessionError(
      "refresh-failed",
      "Access envelope timestamps must be valid ISO-8601 values.",
    );
  }
  if (expiresAtMs <= timestamp || refreshAfterMs >= expiresAtMs) {
    throw new HonuaSceneAccessSessionError(
      "refresh-failed",
      "Access envelope must be unexpired and refreshable before expiration.",
    );
  }
  const scope = narrowScope(baseScope, record, expectedTransport);
  return { token, expiresAtIso, expiresAtMs, refreshAfterIso, refreshAfterMs, scope };
}

function narrowScope(
  baseScope: SceneAccessScope,
  record: Record<string, unknown>,
  expectedTransport?: SceneAccessCredentialTransport,
): SceneAccessScope {
  if (
    record.contractVersion !== "2026-08-v1" ||
    !Array.isArray(record.allowedMethods) ||
    !Array.isArray(record.assetScopes) ||
    !Array.isArray(record.transports)
  ) {
    throw new HonuaSceneAccessSessionError("refresh-failed", "Unsupported scene access envelope contract.");
  }
  const advertisedMethods = record.allowedMethods;
  const allowedMethods = baseScope.allowedMethods.filter((method) => advertisedMethods.includes(method));
  const callerOrigin = new URL(baseScope.origin);
  const callerPort = Number(callerOrigin.port || (callerOrigin.protocol === "https:" ? 443 : 80));
  let pathPrefix: string | undefined;
  for (const scope of record.assetScopes) {
    if (
      scope?.scheme !== callerOrigin.protocol.slice(0, -1) ||
      typeof scope.host !== "string" ||
      scope.host.toLowerCase() !== callerOrigin.hostname.toLowerCase() ||
      scope.port !== callerPort ||
      typeof scope.pathPrefix !== "string"
    )
      continue;
    const prefix = normalizePathPrefix(scope.pathPrefix);
    const intersection = isPathWithinPrefix(baseScope.pathPrefix, prefix)
      ? baseScope.pathPrefix
      : isPathWithinPrefix(prefix, baseScope.pathPrefix)
        ? prefix
        : undefined;
    if (intersection && (pathPrefix === undefined || intersection.length < pathPrefix.length)) {
      pathPrefix = intersection;
    }
  }
  if (pathPrefix === undefined) {
    throw new HonuaSceneAccessSessionError("scope-violation", "Envelope has no asset scope matching the scene.");
  }

  const transports = record.transports.filter(
    (transport) =>
      (transport?.kind === "header" || transport?.kind === "query") &&
      (expectedTransport === undefined || transport.kind === expectedTransport) &&
      typeof transport.name === "string" &&
      /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(transport.name) &&
      transport.valueTemplate === "{token}",
  );
  const transport = transports.find((item) => item.preferred === true) ?? transports[0];
  if (!transport) {
    throw new HonuaSceneAccessSessionError("refresh-failed", "Envelope has no supported credential transport.");
  }
  return {
    ...baseScope,
    pathPrefix,
    allowedMethods,
    transport: transport.kind,
    ...(transport.kind === "header" ? { headerName: transport.name } : { queryParam: transport.name }),
  };
}

function parseHttpUrl(rawUrl: string, code: SceneAccessSessionErrorCode): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HonuaSceneAccessSessionError(code, `Invalid scene asset URL "${rawUrl}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HonuaSceneAccessSessionError(code, `Unsupported URL protocol "${parsed.protocol}".`);
  }
  return parsed;
}

function normalizePathPrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (!trimmed.startsWith("/") || !isUnambiguousAssetPath(trimmed)) {
    throw new HonuaSceneAccessSessionError("invalid-affordance", `Invalid asset pathPrefix "${prefix}".`);
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function isUnambiguousAssetPath(pathname: string): boolean {
  // Avoid percent-encoded traversal and separators that intermediaries may decode.
  return !pathname.includes("..") && !pathname.includes("\\") && !/%(?:25|2e|2f|5c)/i.test(pathname);
}

function isPathWithinPrefix(pathname: string, normalizedPrefix: string): boolean {
  if (!isUnambiguousAssetPath(pathname)) return false;
  const barePrefix = normalizedPrefix.endsWith("/") ? normalizedPrefix.slice(0, -1) : normalizedPrefix;
  return pathname === barePrefix || pathname.startsWith(normalizedPrefix);
}

function stripQueryParam(url: URL, paramName: string): string {
  const copy = new URL(url.toString());
  copy.searchParams.delete(paramName);
  return copy.toString();
}

function appendDescriptorQuery(descriptor: CesiumResourceDescriptor): string {
  if (!descriptor.queryParameters) return descriptor.url;
  const url = new URL(descriptor.url);
  for (const [key, value] of Object.entries(descriptor.queryParameters)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function resolveCurrentStatus(
  status: SceneAccessSessionStatus,
  active: ActiveEnvelope | undefined,
  timestamp: number,
): SceneAccessSessionStatus {
  if (status === "disposed" || status === "refreshing") return status;
  if (!active) return "idle";
  return timestamp >= active.expiresAtMs ? "expired" : "active";
}

function classifyAcquisitionError(cause: unknown, secretToken?: string): HonuaSceneAccessSessionError {
  if (cause instanceof HonuaSceneAccessSessionError) return cause;
  const statusCode =
    cause &&
    typeof cause === "object" &&
    "statusCode" in cause &&
    typeof (cause as { statusCode: unknown }).statusCode === "number"
      ? (cause as { statusCode: number }).statusCode
      : undefined;
  const rawMessage = cause instanceof Error ? cause.message : "Failed to acquire scene access envelope.";
  const safeMessage = secretToken ? rawMessage.replaceAll(secretToken, "[redacted]") : rawMessage;
  if (statusCode === 401) {
    return new HonuaSceneAccessSessionError("unauthorized", safeMessage, { statusCode: 401 });
  }
  if (statusCode === 403) {
    return new HonuaSceneAccessSessionError("forbidden", safeMessage, { statusCode: 403 });
  }
  return new HonuaSceneAccessSessionError("refresh-failed", safeMessage, { statusCode });
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
