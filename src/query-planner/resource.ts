import { HonuaAbortError } from "../core/errors.js";
import { canonicalStringify, sha256, toJsonValue } from "./canonical.js";
import { HonuaQueryPlanExecutionError } from "./types.js";

/** Discriminant for versioned, serializable query resource handles. */
export const QUERY_RESOURCE_HANDLE_KIND = "honua.query-resource" as const;

/** First opaque query resource handle format. */
export const QUERY_RESOURCE_HANDLE_VERSION = "1.0" as const;

const DEFAULT_MAX_ENTRIES = 256;
const HARD_MAX_ENTRIES = 4_096;
const MAX_SOURCE_COUNT = 64;
const MAX_SOURCE_BYTES = 16_384;
const MAX_TOTAL_SOURCE_BYTES = 131_072;
const MAX_RESOLVER_LENGTH = 255;
const MAX_IDENTITY_LENGTH = 256;

const EXTENSION_IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*\.)+[a-z0-9][a-z0-9_-]*$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:~-]*$/;
const AUTHORIZATION_CONTEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/~-]*$/;
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;

const INVALID_HANDLE_MESSAGE = "GeoParquet resource handle is invalid";
const RESOURCE_UNAVAILABLE_MESSAGE = "GeoParquet resource is unavailable";
const RESOURCE_EXPIRED_MESSAGE = "GeoParquet resource authorization has expired";
const RESOLUTION_FAILED_MESSAGE = "GeoParquet resource resolution failed";
const INVALID_REGISTRY_OPTIONS_MESSAGE = "GeoParquet resource registry options are invalid";
const INVALID_REGISTRATION_MESSAGE = "GeoParquet resource registration is invalid";

/** Credential-free resolver identity embedded in a GeoParquet resource handle. */
export interface GeoParquetResolverResourceReferenceV1 {
  readonly kind: "resolver";
  /** Canonical lowercase reverse-DNS resolver identifier. */
  readonly resolver: string;
  /** Stable logical resource id. It must never be derived from a credential. */
  readonly id: string;
}

/**
 * Serializable identity for a GeoParquet resource whose private locator is
 * supplied only at execution time.
 */
export interface GeoParquetResourceHandleV1 {
  readonly kind: typeof QUERY_RESOURCE_HANDLE_KIND;
  readonly version: typeof QUERY_RESOURCE_HANDLE_VERSION;
  readonly protocol: "geoparquet";
  readonly resource: GeoParquetResolverResourceReferenceV1;
  /** Stable, non-secret authorization partition id; never a token or credential. */
  readonly authorizationContextId: string;
  /** Data revision/validator identity. Credential rotation must not change it. */
  readonly resourceVersion?: string;
}

/** Ephemeral raw GeoParquet addressing returned at the trusted execution boundary. */
export interface ResolvedGeoParquetResource {
  /**
   * One to 64 values, each at most 16 KiB UTF-8 and at most 128 KiB in
   * aggregate. Never persist, log, fingerprint, or place them in a query plan.
   */
  readonly sources: readonly string[];
}

/** Per-execution authorization and cancellation state supplied to a resolver. */
export interface GeoParquetResourceResolutionContext {
  /** Must exactly match the stable, non-secret partition id in the handle. */
  readonly authorizationContextId: string;
  readonly signal?: AbortSignal;
}

/** Injected, lifecycle-scoped GeoParquet locator resolver. */
export type GeoParquetResourceResolver = (
  handle: GeoParquetResourceHandleV1,
  context: GeoParquetResourceResolutionContext,
) => ResolvedGeoParquetResource | Promise<ResolvedGeoParquetResource>;

/** Input used to register or atomically replace one private resource locator. */
export interface RegisterGeoParquetResourceInput {
  readonly id: string;
  readonly authorizationContextId: string;
  readonly resourceVersion?: string;
  /** Private addressing subject to the same fixed bounds as resolved sources. */
  readonly sources: readonly string[];
  /** Private Unix epoch deadline in milliseconds; expiry occurs at `now >= expiresAt`. */
  readonly expiresAt?: number;
}

/** Options for an ephemeral, in-memory resolver registry. */
export interface GeoParquetResourceRegistryOptions {
  /** Canonical lowercase reverse-DNS resolver identifier embedded in handles. */
  readonly resolver: string;
  /** May tighten, but never raise, the SDK's hard 4,096-entry ceiling. */
  readonly maxEntries?: number;
  /** Injectable finite Unix epoch millisecond clock for lifecycle control and tests. */
  readonly now?: () => number;
}

/**
 * Lifecycle-scoped private resource registry. This is isolation, not encrypted
 * storage: call `dispose()` when the owning client/session ends.
 */
export interface GeoParquetResourceRegistry {
  register(input: RegisterGeoParquetResourceInput): GeoParquetResourceHandleV1;
  readonly resolver: GeoParquetResourceResolver;
  /** Idempotently removes a handle without revealing whether it existed. */
  revoke(handle: GeoParquetResourceHandleV1): void;
  /** Idempotently clears every private locator and closes the registry. */
  dispose(): void;
}

interface ActiveResourceEntry {
  readonly state: "active";
  readonly sources: readonly string[];
  readonly expiresAt?: number;
}

interface ExpiredResourceEntry {
  readonly state: "expired";
}

type ResourceEntry = ActiveResourceEntry | ExpiredResourceEntry;

const EXPIRED_ENTRY: ExpiredResourceEntry = Object.freeze({ state: "expired" });

/** Parse an exact v1 handle without invoking accessors or retaining rejected input. */
export function parseGeoParquetResourceHandle(value: unknown): GeoParquetResourceHandleV1 {
  const parsed = inspectRecord(
    value,
    ["kind", "version", "protocol", "resource", "authorizationContextId"],
    ["resourceVersion"],
  );
  if (!parsed) throw invalidHandle();

  const resource = inspectRecord(parsed.get("resource"), ["kind", "resolver", "id"]);
  const resolver = resource?.get("resolver");
  const id = resource?.get("id");
  const authorizationContextId = parsed.get("authorizationContextId");
  const resourceVersion = parsed.get("resourceVersion");
  const hasResourceVersion = parsed.has("resourceVersion");
  if (
    parsed.get("kind") !== QUERY_RESOURCE_HANDLE_KIND ||
    parsed.get("version") !== QUERY_RESOURCE_HANDLE_VERSION ||
    parsed.get("protocol") !== "geoparquet" ||
    resource?.get("kind") !== "resolver" ||
    !isResolverIdentifier(resolver) ||
    !isResourceIdentity(id) ||
    !isAuthorizationContextId(authorizationContextId)
  ) {
    throw invalidHandle();
  }
  let normalizedResourceVersion: string | undefined;
  if (hasResourceVersion) {
    if (!isResourceIdentity(resourceVersion)) throw invalidHandle();
    normalizedResourceVersion = resourceVersion;
  }

  return freezeHandle({
    resource: { resolver, id },
    authorizationContextId,
    ...(normalizedResourceVersion !== undefined ? { resourceVersion: normalizedResourceVersion } : {}),
  });
}

/** Stable credential-free fingerprint for plan/cache identity. */
export function hashGeoParquetResourceHandle(value: unknown): `sha256:${string}` {
  const handle = parseGeoParquetResourceHandle(value);
  return sha256(canonicalStringify(toJsonValue(handle)));
}

/**
 * Resolve a handle through an injected resolver after enforcing scope,
 * cancellation, output bounds, and fixed-message error redaction.
 */
export async function resolveGeoParquetResource(
  value: unknown,
  resolver: GeoParquetResourceResolver,
  context: GeoParquetResourceResolutionContext,
): Promise<ResolvedGeoParquetResource> {
  const handle = parseGeoParquetResourceHandle(value);
  const safeContext = parseResolutionContext(context);
  if (typeof resolver !== "function") throw resolutionFailed();
  if (isSignalAborted(safeContext.signal)) throw new HonuaAbortError();
  if (safeContext.authorizationContextId !== handle.authorizationContextId) throw resourceUnavailable();

  let pending: ResolvedGeoParquetResource | Promise<ResolvedGeoParquetResource>;
  try {
    pending = resolver(handle, safeContext);
  } catch (error) {
    throw normalizeResolverFailure(error, safeContext.signal);
  }

  let resolved: ResolvedGeoParquetResource;
  try {
    resolved = await awaitAbortable(pending, safeContext.signal);
  } catch (error) {
    throw normalizeResolverFailure(error, safeContext.signal);
  }
  const output = inspectRecord(resolved, ["sources"]);
  const sources = output ? copyBoundedSources(output.get("sources")) : undefined;
  if (!sources) throw resolutionFailed();
  return Object.freeze({ sources });
}

/** Create a bounded in-memory registry for private, rotation-friendly locators. */
export function createGeoParquetResourceRegistry(
  options: GeoParquetResourceRegistryOptions,
): GeoParquetResourceRegistry {
  const parsedOptions = inspectRecord(options, ["resolver"], ["maxEntries", "now"]);
  const resolverId = parsedOptions?.get("resolver");
  const configuredMaxEntries = parsedOptions?.get("maxEntries");
  const configuredNow = parsedOptions?.get("now");
  if (
    !parsedOptions ||
    !isResolverIdentifier(resolverId) ||
    (configuredMaxEntries !== undefined && !isMaxEntries(configuredMaxEntries)) ||
    (configuredNow !== undefined && !isClock(configuredNow))
  ) {
    throw new TypeError(INVALID_REGISTRY_OPTIONS_MESSAGE);
  }

  const maxEntries = configuredMaxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = configuredNow ?? Date.now;
  const entries = new Map<string, ResourceEntry>();
  let disposed = false;
  let readingClock = false;

  const readCurrentTime = (): number => {
    if (readingClock) throw resolutionFailed();
    readingClock = true;
    try {
      return readClock(now);
    } finally {
      readingClock = false;
    }
  };

  const resolver: GeoParquetResourceResolver = (handleValue, contextValue) => {
    const handle = parseGeoParquetResourceHandle(handleValue);
    const context = parseResolutionContext(contextValue);
    if (isSignalAborted(context.signal)) throw new HonuaAbortError();
    if (
      context.authorizationContextId !== handle.authorizationContextId ||
      handle.resource.resolver !== resolverId ||
      disposed
    ) {
      throw resourceUnavailable();
    }
    const key = resourceKey(handle);
    const entry = entries.get(key);
    if (!entry) throw resourceUnavailable();
    if (entry.state === "expired") throw resourceExpired();
    if (entry.expiresAt !== undefined) {
      const currentTime = readCurrentTime();
      if (disposed || entries.get(key) !== entry) throw resourceUnavailable();
      if (currentTime >= entry.expiresAt) {
        entries.set(key, EXPIRED_ENTRY);
        throw resourceExpired();
      }
    }
    return Object.freeze({ sources: entry.sources });
  };

  const registry: GeoParquetResourceRegistry = {
    register(input) {
      if (disposed) throw resourceUnavailable();
      const registration = parseRegistration(input);
      const handle = freezeHandle({
        resource: { resolver: resolverId, id: registration.id },
        authorizationContextId: registration.authorizationContextId,
        ...(registration.resourceVersion !== undefined ? { resourceVersion: registration.resourceVersion } : {}),
      });
      const key = resourceKey(handle);
      if (!entries.has(key) && entries.size >= maxEntries) reclaimExpiredEntries(entries, maxEntries);
      if (!entries.has(key) && entries.size >= maxEntries && hasExpiringEntries(entries)) {
        const snapshot = [...entries.entries()];
        const currentTime = readCurrentTime();
        if (disposed || !entriesMatchSnapshot(entries, snapshot)) throw resourceUnavailable();
        reclaimExpiredEntries(entries, maxEntries, currentTime);
      }
      if (!entries.has(key) && entries.size >= maxEntries) throw resourceUnavailable();
      entries.set(
        key,
        Object.freeze({
          state: "active",
          sources: registration.sources,
          ...(registration.expiresAt !== undefined ? { expiresAt: registration.expiresAt } : {}),
        }),
      );
      return handle;
    },
    resolver,
    revoke(handleValue) {
      const handle = parseGeoParquetResourceHandle(handleValue);
      if (handle.resource.resolver === resolverId) entries.delete(resourceKey(handle));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      entries.clear();
    },
  };
  return Object.freeze(registry);
}

function parseRegistration(input: RegisterGeoParquetResourceInput): {
  readonly id: string;
  readonly authorizationContextId: string;
  readonly resourceVersion?: string;
  readonly sources: readonly string[];
  readonly expiresAt?: number;
} {
  const parsed = inspectRecord(input, ["id", "authorizationContextId", "sources"], ["resourceVersion", "expiresAt"]);
  const id = parsed?.get("id");
  const authorizationContextId = parsed?.get("authorizationContextId");
  const resourceVersion = parsed?.get("resourceVersion");
  const expiresAt = parsed?.get("expiresAt");
  const sources = parsed ? copyBoundedSources(parsed.get("sources")) : undefined;
  if (
    !parsed ||
    !isResourceIdentity(id) ||
    !isAuthorizationContextId(authorizationContextId) ||
    (resourceVersion !== undefined && !isResourceIdentity(resourceVersion)) ||
    (expiresAt !== undefined && !isEpochMilliseconds(expiresAt)) ||
    !sources
  ) {
    throw new TypeError(INVALID_REGISTRATION_MESSAGE);
  }
  return {
    id,
    authorizationContextId,
    ...(resourceVersion !== undefined ? { resourceVersion } : {}),
    sources,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

function parseResolutionContext(value: unknown): GeoParquetResourceResolutionContext {
  const parsed = inspectRecord(value, ["authorizationContextId"], ["signal"]);
  const authorizationContextId = parsed?.get("authorizationContextId");
  const signal = parsed?.get("signal");
  if (
    !parsed ||
    !isAuthorizationContextId(authorizationContextId) ||
    (signal !== undefined && !isAbortSignal(signal))
  ) {
    throw resourceUnavailable();
  }
  return Object.freeze({
    authorizationContextId,
    ...(signal !== undefined ? { signal } : {}),
  });
}

function freezeHandle(input: {
  readonly resource: { readonly resolver: string; readonly id: string };
  readonly authorizationContextId: string;
  readonly resourceVersion?: string;
}): GeoParquetResourceHandleV1 {
  const resource = Object.freeze({
    kind: "resolver" as const,
    resolver: input.resource.resolver,
    id: input.resource.id,
  });
  return Object.freeze({
    kind: QUERY_RESOURCE_HANDLE_KIND,
    version: QUERY_RESOURCE_HANDLE_VERSION,
    protocol: "geoparquet" as const,
    resource,
    authorizationContextId: input.authorizationContextId,
    ...(input.resourceVersion !== undefined ? { resourceVersion: input.resourceVersion } : {}),
  });
}

function resourceKey(handle: GeoParquetResourceHandleV1): string {
  return canonicalStringify(
    toJsonValue([
      handle.resource.resolver,
      handle.resource.id,
      handle.authorizationContextId,
      handle.resourceVersion ?? null,
    ]),
  );
}

function reclaimExpiredEntries(entries: Map<string, ResourceEntry>, maxEntries: number, currentTime?: number): void {
  for (const [key, entry] of entries) {
    if (
      entry.state === "expired" ||
      (currentTime !== undefined && entry.expiresAt !== undefined && currentTime >= entry.expiresAt)
    ) {
      entries.delete(key);
    }
    if (entries.size < maxEntries) return;
  }
}

function hasExpiringEntries(entries: ReadonlyMap<string, ResourceEntry>): boolean {
  for (const entry of entries.values()) {
    if (entry.state === "active" && entry.expiresAt !== undefined) return true;
  }
  return false;
}

function entriesMatchSnapshot(
  entries: ReadonlyMap<string, ResourceEntry>,
  snapshot: readonly (readonly [string, ResourceEntry])[],
): boolean {
  return entries.size === snapshot.length && snapshot.every(([key, entry]) => entries.get(key) === entry);
}

function inspectRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): ReadonlyMap<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return undefined;
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    if (keys.length < requiredKeys.length || keys.length > allowed.size) return undefined;
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return undefined;
    const result = new Map<string, unknown>();
    for (const key of requiredKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
      result.set(key, descriptor.value);
    }
    for (const key of optionalKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      if (!descriptor.enumerable || !("value" in descriptor)) return undefined;
      result.set(key, descriptor.value);
    }
    return result;
  } catch {
    return undefined;
  }
}

function copyBoundedSources(value: unknown): readonly string[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > MAX_SOURCE_COUNT) {
      return undefined;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string")) return undefined;
    if (keys.some((key) => typeof key === "string" && key !== "length" && !isArrayIndex(key, length))) {
      return undefined;
    }

    let totalBytes = 0;
    const copy: string[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
      const source = descriptor.value;
      if (
        typeof source !== "string" ||
        source.length === 0 ||
        source.length > MAX_SOURCE_BYTES ||
        containsControlCharacter(source)
      ) {
        return undefined;
      }
      const bytes = new TextEncoder().encode(source).byteLength;
      if (bytes > MAX_SOURCE_BYTES) return undefined;
      totalBytes += bytes;
      if (totalBytes > MAX_TOTAL_SOURCE_BYTES) return undefined;
      copy.push(source);
    }
    return Object.freeze(copy);
  } catch {
    return undefined;
  }
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isResolverIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_RESOLVER_LENGTH && EXTENSION_IDENTIFIER_PATTERN.test(value);
}

function isResourceIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_IDENTITY_LENGTH &&
    RESOURCE_ID_PATTERN.test(value) &&
    !JWT_SHAPE.test(value)
  );
}

function isAuthorizationContextId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_IDENTITY_LENGTH &&
    AUTHORIZATION_CONTEXT_PATTERN.test(value) &&
    !value.endsWith("/") &&
    !value.includes("//") &&
    !value.split("/").some((segment) => segment === "." || segment === "..") &&
    !JWT_SHAPE.test(value)
  );
}

function isMaxEntries(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= HARD_MAX_ENTRIES;
}

function isClock(value: unknown): value is () => number {
  return typeof value === "function";
}

function isEpochMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      typeof (value as AbortSignal).aborted === "boolean" &&
      typeof (value as AbortSignal).addEventListener === "function" &&
      typeof (value as AbortSignal).removeEventListener === "function"
    );
  } catch {
    return false;
  }
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  try {
    return signal?.aborted === true;
  } catch {
    throw resolutionFailed();
  }
}

function readClock(now: () => number): number {
  try {
    const value = now();
    if (!isEpochMilliseconds(value)) throw resolutionFailed();
    return value;
  } catch {
    throw resolutionFailed();
  }
}

function awaitAbortable<T>(value: T | Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const pending = Promise.resolve(value);
  if (!signal) return pending;
  if (isSignalAborted(signal)) {
    void pending.catch(() => undefined);
    throw new HonuaAbortError();
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      try {
        signal.removeEventListener("abort", abort);
      } catch {
        // The fixed failure below retains no foreign signal data.
      }
      callback();
    };
    const abort = () => finish(() => reject(new HonuaAbortError()));
    try {
      signal.addEventListener("abort", abort, { once: true });
    } catch {
      void pending.catch(() => undefined);
      finish(() => reject(resolutionFailed()));
      return;
    }
    try {
      if (isSignalAborted(signal)) {
        abort();
        void pending.catch(() => undefined);
        return;
      }
    } catch (error) {
      void pending.catch(() => undefined);
      finish(() => reject(error));
      return;
    }
    pending.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function normalizeResolverFailure(error: unknown, signal: AbortSignal | undefined): Error {
  if (isSignalAborted(signal)) return new HonuaAbortError();
  try {
    if (error instanceof HonuaQueryPlanExecutionError) {
      const code = ownDataProperty(error, "code");
      if (code === "resource-unavailable") return resourceUnavailable();
      if (code === "resource-expired") return resourceExpired();
    }
  } catch {
    // Proxy and cross-realm failures are projected to the same fixed error.
  }
  return resolutionFailed();
}

function ownDataProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function invalidHandle(): HonuaQueryPlanExecutionError {
  return new HonuaQueryPlanExecutionError("invalid-resource-handle", INVALID_HANDLE_MESSAGE);
}

function resourceUnavailable(): HonuaQueryPlanExecutionError {
  return new HonuaQueryPlanExecutionError("resource-unavailable", RESOURCE_UNAVAILABLE_MESSAGE);
}

function resourceExpired(): HonuaQueryPlanExecutionError {
  return new HonuaQueryPlanExecutionError("resource-expired", RESOURCE_EXPIRED_MESSAGE);
}

function resolutionFailed(): HonuaQueryPlanExecutionError {
  return new HonuaQueryPlanExecutionError("resource-resolution-failed", RESOLUTION_FAILED_MESSAGE);
}
