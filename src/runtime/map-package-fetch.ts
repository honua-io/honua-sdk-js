import type { HonuaCacheValidator } from "../core/cache-state.js";
import { honuaCacheValidatorFromHeaders } from "../core/cache-state.js";
import type { HonuaClient } from "../core/client.js";
import { HonuaMapPackageError } from "./errors.js";
import { type LoadMapPackageOptions, loadMapPackage } from "./load-package.js";
import {
  type HonuaMapPackageDiagnostic,
  hasMapPackageDiagnosticErrors,
  validateMapPackage,
} from "./map-package-validation.js";
import type { HonuaMapPackage, HonuaMapPackageStyleRef, HonuaStyleRefBody } from "./map-package.js";
import type { HonuaMapRuntime, MaplibreMap } from "./runtime.js";
import type { StyleRefResolver } from "./style-compose.js";

export const DEFAULT_MAP_PACKAGE_PATH_PREFIX = "/api/v1/map-packages";

export type MapPackageLocator =
  | string
  | {
      readonly id?: string;
      readonly packageId?: string;
      readonly path?: string;
      readonly url?: string;
      readonly href?: string;
    };

export type MapPackagePathResolver = (packageId: string) => string;

export interface FetchMapPackageOptions {
  readonly client: HonuaClient;
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
  /**
   * Override id-to-path resolution. The default is
   * `/api/v1/map-packages/{encodeURIComponent(id)}`.
   */
  readonly resolvePath?: MapPackagePathResolver;
  /** In-memory response cache. Omit for a per-client default; pass `false` to bypass SDK validators. */
  readonly cache?: MapPackageFetchCache | false;
  /** Resolve out-of-band style refs and inline successful bodies into the returned package. */
  readonly resolveStyleRef?: StyleRefResolver;
  /** Treat unresolved style refs as validation errors instead of warnings. */
  readonly requireStyleRefResolution?: boolean;
  /** Emit a stale-package warning when the package timestamp is older than this many ms. */
  readonly maxAgeMs?: number;
  readonly now?: number | Date;
  /** Return invalid packages with diagnostics instead of throwing `HonuaMapPackageError`. */
  readonly allowInvalid?: boolean;
}

export interface MapPackageFetchCacheEntry {
  readonly mapPackage: HonuaMapPackage;
  readonly validator?: HonuaCacheValidator;
  readonly cachedAtMs: number;
  readonly sourceUpdatedAt?: string;
  readonly fingerprint: string;
}

export type MapPackageFetchCache = Map<string, MapPackageFetchCacheEntry>;

export type MapPackageFetchCacheStatus = "miss" | "refreshed" | "not-modified" | "bypass";

export interface MapPackageFetchCacheState {
  readonly status: MapPackageFetchCacheStatus;
  readonly key: string;
  readonly validator?: HonuaCacheValidator;
  readonly sourceUpdatedAt?: string;
  readonly fetchedAt: string;
  readonly revalidatedAt?: string;
}

export interface FetchMapPackageResult {
  readonly mapPackage: HonuaMapPackage;
  readonly diagnostics: readonly HonuaMapPackageDiagnostic[];
  readonly cache: MapPackageFetchCacheState;
}

export interface LoadMapPackageFromIdOptions extends LoadMapPackageOptions {
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
  readonly resolvePath?: MapPackagePathResolver;
  readonly cache?: MapPackageFetchCache | false;
  readonly requireStyleRefResolution?: boolean;
  readonly maxAgeMs?: number;
  readonly now?: number | Date;
  readonly allowInvalid?: boolean;
}

export interface LoadMapPackageFromIdResult {
  readonly runtime: HonuaMapRuntime;
  readonly mapPackage: HonuaMapPackage;
  readonly diagnostics: readonly HonuaMapPackageDiagnostic[];
  readonly cache: MapPackageFetchCacheState;
}

const defaultCaches = new WeakMap<HonuaClient, MapPackageFetchCache>();

export async function fetchMapPackage(
  locator: MapPackageLocator,
  options: FetchMapPackageOptions,
): Promise<FetchMapPackageResult> {
  const path = resolveMapPackagePath(locator, options.resolvePath);
  const cache = resolveCache(options.client, options.cache);
  const cached = cache?.get(path);
  const headers = buildFetchHeaders(options.headers, cached?.validator);

  const response = await options.client.pipelineFetch(
    "GET",
    path,
    { headers },
    options.signal,
    cached ? { okStatuses: [304] } : {},
  );

  if (response.status === 304) {
    if (!cached) {
      throw new HonuaMapPackageError("MapPackage fetch returned 304 without an SDK cache entry", {
        stage: "fetch",
        detail: { path },
      });
    }
    return buildFetchResult(cached.mapPackage, path, "not-modified", {
      validator: honuaCacheValidatorFromHeaders(response.headers) ?? cached.validator,
      sourceUpdatedAt: response.headers.get("last-modified") ?? cached.sourceUpdatedAt,
      revalidatedAt: new Date().toISOString(),
      options,
    });
  }

  const body = await parseJsonBody(response, path);
  const rawPackage = unwrapMapPackageEnvelope(body);
  const resolved = await resolveMapPackageStyleRefs(rawPackage, {
    resolveStyleRef: options.resolveStyleRef,
    requireStyleRefResolution: options.requireStyleRefResolution === true,
  });
  const mapPackage = resolved.mapPackage;
  const validation = validateMapPackage(mapPackage, {
    maxAgeMs: options.maxAgeMs,
    now: options.now,
  });
  const diagnostics = [...resolved.diagnostics, ...validation.diagnostics];

  if (hasMapPackageDiagnosticErrors(diagnostics) && options.allowInvalid !== true) {
    throw new HonuaMapPackageError("MapPackage validation failed", {
      packageId: packageIdFromUnknown(mapPackage),
      stage: "validate",
      detail: { diagnostics, path },
    });
  }

  const validator = honuaCacheValidatorFromHeaders(response.headers);
  const sourceUpdatedAt = response.headers.get("last-modified") ?? undefined;
  const status: MapPackageFetchCacheStatus = cache ? (cached ? "refreshed" : "miss") : "bypass";
  const entry: MapPackageFetchCacheEntry = {
    mapPackage: mapPackage as HonuaMapPackage,
    cachedAtMs: Date.now(),
    fingerprint: stableFingerprint(mapPackage),
    ...(validator ? { validator } : {}),
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
  };
  if (cache) cache.set(path, entry);

  return {
    mapPackage: mapPackage as HonuaMapPackage,
    diagnostics,
    cache: {
      status,
      key: path,
      ...(validator ? { validator } : {}),
      ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
      fetchedAt: new Date(entry.cachedAtMs).toISOString(),
    },
  };
}

export async function loadMapPackageFromId(
  locator: MapPackageLocator,
  map: MaplibreMap,
  options: LoadMapPackageFromIdOptions,
): Promise<LoadMapPackageFromIdResult> {
  const fetched = await fetchMapPackage(locator, {
    client: options.client,
    signal: options.signal,
    headers: options.headers,
    resolvePath: options.resolvePath,
    cache: options.cache,
    resolveStyleRef: options.resolveStyleRef,
    requireStyleRefResolution: options.requireStyleRefResolution ?? true,
    maxAgeMs: options.maxAgeMs,
    now: options.now,
    allowInvalid: options.allowInvalid,
  });
  const runtime = await loadMapPackage(fetched.mapPackage, map, options);
  return {
    runtime,
    mapPackage: fetched.mapPackage,
    diagnostics: fetched.diagnostics,
    cache: fetched.cache,
  };
}

export function resolveMapPackagePath(locator: MapPackageLocator, resolvePath?: MapPackagePathResolver): string {
  if (typeof locator === "string") {
    return resolveStringLocator(locator, resolvePath);
  }
  const direct = locator.path ?? locator.url ?? locator.href;
  if (direct) return direct;
  const id = locator.packageId ?? locator.id;
  if (!id) {
    throw new HonuaMapPackageError("MapPackage locator requires id, packageId, path, url, or href", {
      stage: "fetch",
      detail: { locator },
    });
  }
  return (resolvePath ?? defaultMapPackagePath)(id);
}

export function defaultMapPackagePath(packageId: string): string {
  return `${DEFAULT_MAP_PACKAGE_PATH_PREFIX}/${encodeURIComponent(packageId)}`;
}

export function mapPackageFingerprint(pkg: HonuaMapPackage): string {
  return stableFingerprint(pkg);
}

async function resolveMapPackageStyleRefs(
  value: unknown,
  options: {
    readonly resolveStyleRef?: StyleRefResolver;
    readonly requireStyleRefResolution: boolean;
  },
): Promise<{ mapPackage: unknown; diagnostics: readonly HonuaMapPackageDiagnostic[] }> {
  if (!isRecord(value) || !Array.isArray(value.styleRefs) || value.styleRefs.length === 0) {
    return { mapPackage: value, diagnostics: [] };
  }

  const diagnostics: HonuaMapPackageDiagnostic[] = [];
  const packageId = typeof value.mapPackageId === "string" ? value.mapPackageId : undefined;
  const nextRefs: HonuaMapPackageStyleRef[] = [];
  let changed = false;

  for (let i = 0; i < value.styleRefs.length; i += 1) {
    const ref = value.styleRefs[i];
    if (!isRecord(ref)) {
      nextRefs.push(ref as HonuaMapPackageStyleRef);
      continue;
    }
    if (isRecord(ref.body)) {
      nextRefs.push(ref as unknown as HonuaMapPackageStyleRef);
      continue;
    }

    const styleId = typeof ref.styleId === "string" ? ref.styleId : "";
    if (!options.resolveStyleRef) {
      diagnostics.push({
        code: "style-ref-unresolved",
        severity: options.requireStyleRefResolution ? "error" : "warning",
        message: `StyleRef "${styleId || i}" has no inline body and no resolver was provided.`,
        ...(packageId ? { packageId } : {}),
        path: `styleRefs[${i}].body`,
        detail: { styleId: ref.styleId, presetId: ref.presetId },
      });
      nextRefs.push(ref as unknown as HonuaMapPackageStyleRef);
      continue;
    }

    try {
      const body = await options.resolveStyleRef(styleId, typeof ref.presetId === "string" ? ref.presetId : undefined);
      if (!isRecord(body)) {
        diagnostics.push({
          code: "style-ref-resolution-failed",
          severity: "error",
          message: `StyleRef "${styleId || i}" resolver returned a non-object body.`,
          ...(packageId ? { packageId } : {}),
          path: `styleRefs[${i}].body`,
          detail: { styleId, presetId: ref.presetId },
        });
        nextRefs.push(ref as unknown as HonuaMapPackageStyleRef);
        continue;
      }
      changed = true;
      nextRefs.push({
        ...(ref as unknown as HonuaMapPackageStyleRef),
        body: body as HonuaStyleRefBody,
      });
    } catch (cause) {
      diagnostics.push({
        code: "style-ref-resolution-failed",
        severity: "error",
        message: `StyleRef "${styleId || i}" could not be resolved.`,
        ...(packageId ? { packageId } : {}),
        path: `styleRefs[${i}].body`,
        detail: { styleId, presetId: ref.presetId, error: errorMessage(cause) },
      });
      nextRefs.push(ref as unknown as HonuaMapPackageStyleRef);
    }
  }

  return {
    mapPackage: changed ? { ...value, styleRefs: nextRefs } : value,
    diagnostics,
  };
}

function buildFetchResult(
  mapPackage: HonuaMapPackage,
  path: string,
  status: MapPackageFetchCacheStatus,
  input: {
    readonly validator?: HonuaCacheValidator;
    readonly sourceUpdatedAt?: string;
    readonly revalidatedAt?: string;
    readonly options: FetchMapPackageOptions;
  },
): FetchMapPackageResult {
  const validation = validateMapPackage(mapPackage, {
    maxAgeMs: input.options.maxAgeMs,
    now: input.options.now,
  });
  if (hasMapPackageDiagnosticErrors(validation.diagnostics) && input.options.allowInvalid !== true) {
    throw new HonuaMapPackageError("MapPackage validation failed", {
      packageId: mapPackage.mapPackageId,
      stage: "validate",
      detail: { diagnostics: validation.diagnostics, path },
    });
  }
  return {
    mapPackage,
    diagnostics: validation.diagnostics,
    cache: {
      status,
      key: path,
      ...(input.validator ? { validator: input.validator } : {}),
      ...(input.sourceUpdatedAt ? { sourceUpdatedAt: input.sourceUpdatedAt } : {}),
      fetchedAt: new Date().toISOString(),
      ...(input.revalidatedAt ? { revalidatedAt: input.revalidatedAt } : {}),
    },
  };
}

function buildFetchHeaders(headers: HeadersInit | undefined, validator: HonuaCacheValidator | undefined): Headers {
  const out = new Headers(headers);
  if (!out.has("Accept")) out.set("Accept", "application/json");
  if (validator?.etag) out.set("If-None-Match", validator.etag);
  if (validator?.lastModified) out.set("If-Modified-Since", validator.lastModified);
  if (validator?.etag || validator?.lastModified) {
    out.set("Cache-Control", "no-cache");
  }
  return out;
}

function resolveCache(
  client: HonuaClient,
  cache: MapPackageFetchCache | false | undefined,
): MapPackageFetchCache | undefined {
  if (cache === false) return undefined;
  if (cache) return cache;
  const existing = defaultCaches.get(client);
  if (existing) return existing;
  const next: MapPackageFetchCache = new Map();
  defaultCaches.set(client, next);
  return next;
}

function resolveStringLocator(locator: string, resolvePath: MapPackagePathResolver | undefined): string {
  if (locator.startsWith("/") || locator.startsWith("http://") || locator.startsWith("https://")) return locator;
  const honuaPackagePrefix = "honua://map-packages/";
  if (locator.startsWith(honuaPackagePrefix)) {
    return (resolvePath ?? defaultMapPackagePath)(decodeURIComponent(locator.slice(honuaPackagePrefix.length)));
  }
  return (resolvePath ?? defaultMapPackagePath)(locator);
}

async function parseJsonBody(response: Response, path: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new HonuaMapPackageError("MapPackage fetch response was not valid JSON", {
      stage: "fetch",
      detail: { path },
      cause,
    });
  }
}

function unwrapMapPackageEnvelope(body: unknown): unknown {
  if (!isRecord(body)) return body;
  if (typeof body.mapPackageId === "string" || typeof body.format === "string") return body;
  const direct = body.mapPackage ?? body.package;
  if (isRecord(direct)) return direct;
  if (isRecord(body.data)) return unwrapMapPackageEnvelope(body.data);
  return body;
}

function stableFingerprint(value: unknown): string {
  return JSON.stringify(value, stableObjectKeys);
}

function stableObjectKeys(_key: string, value: unknown): unknown {
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = value[key];
  }
  return out;
}

function packageIdFromUnknown(value: unknown): string | undefined {
  return isRecord(value) && typeof value.mapPackageId === "string" ? value.mapPackageId : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
