export type HonuaCacheScope = "metadata" | "materialized-result";

export type HonuaCacheStatus = "hit" | "miss" | "stale" | "refreshed" | "bypass";

export type HonuaCacheReadMode = "default" | "bypass";

export interface HonuaCacheValidator {
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface HonuaCacheState {
  readonly scope: HonuaCacheScope;
  readonly status: HonuaCacheStatus;
  readonly keyFingerprint: string;
  readonly ageMs?: number;
  readonly ttlMs?: number;
  readonly staleIfErrorMs?: number;
  readonly revalidatedAt?: string;
  readonly sourceUpdatedAt?: string;
  readonly validator?: HonuaCacheValidator;
  readonly invalidationReason?: string;
  readonly refreshErrorId?: string;
}

export interface HonuaMetadataRequestOptions {
  readonly signal?: AbortSignal;
  /**
   * Revalidate even when an SDK-local metadata entry is present. Adapters send
   * conditional validators when available and report `refreshed` on success.
   */
  readonly refresh?: boolean;
  /**
   * `default` reads and writes the adapter metadata cache. `bypass` skips cache
   * lookup and write-through for endpoints that support SDK-local caching.
   */
  readonly cache?: HonuaCacheReadMode;
  /**
   * Allow a cached metadata entry to be returned as `stale` when refresh fails.
   * Defaults to `true`; ignored when no cached metadata entry exists.
   */
  readonly staleIfError?: boolean;
  /** Optional freshness budget surfaced to callers in `HonuaCacheState`. */
  readonly ttlMs?: number;
  /** Optional stale fallback window surfaced to callers in `HonuaCacheState`. */
  readonly staleIfErrorMs?: number;
  /**
   * Maximum decoded response-body bytes accepted before metadata parsing.
   * Adapters that consume bounded discovery documents set this explicitly so
   * a missing or dishonest `Content-Length` cannot turn metadata discovery
   * into an unbounded allocation. The limit is enforced while streaming the
   * body, not only from response headers.
   */
  readonly maxResponseBytes?: number;
}

export interface NormalizedHonuaMetadataRequestOptions {
  readonly signal?: AbortSignal;
  readonly refresh: boolean;
  readonly cache: HonuaCacheReadMode;
  readonly staleIfError: boolean;
  readonly ttlMs?: number;
  readonly staleIfErrorMs?: number;
  readonly maxResponseBytes?: number;
}

export const HONUA_DEFAULT_METADATA_CACHE_TTL_MS = 5 * 60 * 1000;
export const HONUA_DEFAULT_METADATA_STALE_IF_ERROR_MS = 60 * 60 * 1000;

export interface HonuaCacheStateInit {
  readonly scope: HonuaCacheScope;
  readonly status: HonuaCacheStatus;
  readonly keyFingerprint: string;
  readonly ageMs?: number;
  readonly ttlMs?: number;
  readonly staleIfErrorMs?: number;
  readonly revalidatedAt?: string;
  readonly sourceUpdatedAt?: string;
  readonly validator?: HonuaCacheValidator;
  readonly invalidationReason?: string;
  readonly refreshErrorId?: string;
}

export function createHonuaCacheState(init: HonuaCacheStateInit): HonuaCacheState {
  return {
    scope: init.scope,
    status: init.status,
    keyFingerprint: init.keyFingerprint,
    ...(init.ageMs !== undefined ? { ageMs: Math.max(0, Math.trunc(init.ageMs)) } : {}),
    ...(init.ttlMs !== undefined ? { ttlMs: Math.max(0, Math.trunc(init.ttlMs)) } : {}),
    ...(init.staleIfErrorMs !== undefined ? { staleIfErrorMs: Math.max(0, Math.trunc(init.staleIfErrorMs)) } : {}),
    ...(init.revalidatedAt ? { revalidatedAt: init.revalidatedAt } : {}),
    ...(init.sourceUpdatedAt ? { sourceUpdatedAt: init.sourceUpdatedAt } : {}),
    ...(hasHonuaCacheValidator(init.validator) ? { validator: init.validator } : {}),
    ...(init.invalidationReason ? { invalidationReason: init.invalidationReason } : {}),
    ...(init.refreshErrorId ? { refreshErrorId: init.refreshErrorId } : {}),
  };
}

export function normalizeHonuaMetadataRequestOptions(
  options: HonuaMetadataRequestOptions = {},
): NormalizedHonuaMetadataRequestOptions {
  const ttlMs = normalizeNonNegativeInteger(options.ttlMs) ?? HONUA_DEFAULT_METADATA_CACHE_TTL_MS;
  const staleIfErrorMs =
    normalizeNonNegativeInteger(options.staleIfErrorMs) ?? HONUA_DEFAULT_METADATA_STALE_IF_ERROR_MS;
  const maxResponseBytes = normalizeMaximumResponseBytes(options.maxResponseBytes);
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    refresh: options.refresh === true,
    cache: options.cache === "bypass" ? "bypass" : "default",
    staleIfError: options.staleIfError !== false,
    ttlMs,
    staleIfErrorMs,
    ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
  };
}

export function isHonuaCacheEntryFresh(cachedAtMs: number, now: number, ttlMs: number | undefined): boolean {
  return ttlMs === undefined || Math.max(0, now - cachedAtMs) < ttlMs;
}

export function isHonuaCacheStatus(value: unknown): value is HonuaCacheStatus {
  return value === "hit" || value === "miss" || value === "stale" || value === "refreshed" || value === "bypass";
}

export function honuaCacheValidatorFromHeaders(headers: Headers): HonuaCacheValidator | undefined {
  const etag = headers.get("etag") ?? undefined;
  const lastModified = headers.get("last-modified") ?? undefined;
  return hasHonuaCacheValidator({ etag, lastModified })
    ? { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) }
    : undefined;
}

export function honuaMetadataRequestHeaders(options: {
  readonly accept?: string;
  readonly refresh?: boolean;
  readonly bypass?: boolean;
  readonly validator?: HonuaCacheValidator;
}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: options.accept ?? "application/json",
  };

  if (options.bypass) {
    headers["Cache-Control"] = "no-store";
    headers.Pragma = "no-cache";
    return headers;
  }

  if (options.refresh) {
    headers["Cache-Control"] = "no-cache";
    if (options.validator?.etag) {
      headers["If-None-Match"] = options.validator.etag;
    }
    if (options.validator?.lastModified) {
      headers["If-Modified-Since"] = options.validator.lastModified;
    }
  }

  return headers;
}

export function withHonuaCacheState<T>(value: T, cache: HonuaCacheState): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  return {
    ...(value as Record<string, unknown>),
    cache,
  } as T;
}

export function withoutHonuaCacheState<T>(value: T): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const { cache: _cache, ...rest } = value as Record<string, unknown>;
  return rest as T;
}

function hasHonuaCacheValidator(value: HonuaCacheValidator | undefined): value is HonuaCacheValidator {
  return Boolean(value?.etag || value?.lastModified);
}

function normalizeNonNegativeInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
}

function normalizeMaximumResponseBytes(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("maxResponseBytes must be a positive safe integer.");
  }
  return value;
}
