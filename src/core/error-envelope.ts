/**
 * Shared, serialization-safe error contract for public Honua SDK failures.
 *
 * Error instances retain their original `message`, `cause`, and legacy detail
 * fields for local debugging. Use {@link serializeHonuaError} at telemetry or
 * process boundaries: it emits only registered classifications and sanitized
 * context, never messages, stacks, response bodies, or cause payloads.
 */

export const HONUA_ERROR_KIND = "honua.sdk.error.v1" as const;

export type HonuaErrorDomain = "core" | "discovery" | "query" | "map" | "runtime";

export type HonuaErrorCategory =
  | "authentication"
  | "cancellation"
  | "capability"
  | "internal"
  | "network"
  | "protocol"
  | "timeout"
  | "validation";

export interface HonuaErrorCodeDescriptor {
  readonly domain: HonuaErrorDomain;
  readonly category: HonuaErrorCategory;
  readonly retryable: boolean;
  readonly summary: string;
}

/**
 * Canonical public code registry. Object keys make duplicate codes a compile
 * error; the base constructor rejects codes absent from this registry.
 */
export const HONUA_ERROR_CODE_REGISTRY = Object.freeze({
  "core.http.transient": classification("core", "protocol", true, "Retryable HTTP response failure"),
  "core.http.rejected": classification("core", "protocol", false, "Non-retryable HTTP response failure"),
  "core.timeout": classification("core", "timeout", true, "Request deadline elapsed"),
  "core.network": classification("core", "network", true, "Network transport failure"),
  "core.cancelled": classification("core", "cancellation", false, "Caller cancelled the operation"),
  "core.grpc.transient": classification("core", "protocol", true, "Retryable gRPC-Web transport failure"),
  "core.grpc.rejected": classification("core", "protocol", false, "Non-retryable gRPC-Web transport failure"),
  "core.auth.interaction-required": classification(
    "core",
    "authentication",
    false,
    "Interactive authentication is required",
  ),
  "core.auth.refresh-failed": classification("core", "authentication", true, "Credential refresh failed transiently"),
  "core.auth.invalid-grant": classification(
    "core",
    "authentication",
    false,
    "Authorization grant is invalid or expired",
  ),
  "core.capability-not-supported": classification(
    "core",
    "capability",
    false,
    "Requested source capability is unavailable",
  ),
  "core.exploration-context": classification("core", "validation", false, "Exploration context operation is invalid"),
  "core.wfs-exception": classification("core", "protocol", false, "WFS exception report"),
  "core.job-failed": classification("core", "protocol", false, "Remote job reached a failed terminal state"),
  "core.wms-capabilities-parse": classification("core", "protocol", false, "WMS capabilities document is invalid"),
  "core.wmts-capabilities-parse": classification("core", "protocol", false, "WMTS capabilities document is invalid"),
  "discovery.ambiguous-protocol": classification(
    "discovery",
    "validation",
    false,
    "Multiple protocols match the endpoint",
  ),
  "discovery.ambiguous-source": classification(
    "discovery",
    "validation",
    false,
    "Multiple sources match the selection",
  ),
  "discovery.invalid-endpoint": classification("discovery", "validation", false, "Discovery endpoint is invalid"),
  "discovery.invalid-cache-identity": classification(
    "discovery",
    "validation",
    false,
    "Discovery cache identity is invalid",
  ),
  "discovery.invalid-discovery-cache": classification(
    "discovery",
    "validation",
    false,
    "Discovery cache entry is invalid",
  ),
  "discovery.invalid-capability": classification(
    "discovery",
    "validation",
    false,
    "Discovered capability evidence is invalid",
  ),
  "discovery.unsupported-protocol": classification(
    "discovery",
    "capability",
    false,
    "Endpoint protocol is unsupported",
  ),
  "discovery.protocol-mismatch": classification(
    "discovery",
    "validation",
    false,
    "Endpoint protocol conflicts with its hint",
  ),
  "query.planning.invalid-query": classification("query", "validation", false, "Query is invalid"),
  "query.planning.unsupported-compiler": classification(
    "query",
    "capability",
    false,
    "No compiler supports the source protocol",
  ),
  "query.planning.unsupported-query": classification(
    "query",
    "capability",
    false,
    "Query cannot be represented by the compiler",
  ),
  "query.planning.capability-not-supported": classification(
    "query",
    "capability",
    false,
    "Query requires an unavailable capability",
  ),
  "query.planning.fallback-disabled": classification(
    "query",
    "capability",
    false,
    "Required local fallback is disabled",
  ),
  "query.planning.unsafe-materialization": classification(
    "query",
    "validation",
    false,
    "Planned local materialization exceeds its safety bound",
  ),
  "query.execution.invalid-plan": classification("query", "validation", false, "Query plan is invalid"),
  "query.execution.plan-context-mismatch": classification(
    "query",
    "validation",
    false,
    "Execution context does not match the accepted query plan",
  ),
  "query.execution.unsafe-materialization": classification(
    "query",
    "validation",
    false,
    "Query execution exceeded its materialization bound",
  ),
  "map.source-adapter.disposed": classification("map", "validation", false, "Map source adapter is disposed"),
  "map.source-adapter.source-conflict": classification(
    "map",
    "validation",
    false,
    "Map source identifier already exists",
  ),
  "map.source-adapter.layer-conflict": classification(
    "map",
    "validation",
    false,
    "Map layer identifier already exists",
  ),
  "map.source-adapter.unsupported-plan": classification(
    "map",
    "capability",
    false,
    "Query plan cannot be rendered by the source adapter",
  ),
  "map.source-adapter.invalid-option": classification(
    "map",
    "validation",
    false,
    "Map source adapter option is invalid",
  ),
  "map.source-adapter.map-mutation-failed": classification("map", "internal", false, "Renderer mutation failed"),
  "map.data-bridge.invalid-option": classification("map", "validation", false, "Data-to-map option is invalid"),
  "map.data-bridge.disposed": classification("map", "validation", false, "Data-to-map bridge is disposed"),
  "map.data-bridge.source-conflict": classification(
    "map",
    "validation",
    false,
    "Data-to-map source identifier already exists",
  ),
  "map.data-bridge.layer-conflict": classification(
    "map",
    "validation",
    false,
    "Data-to-map layer identifier already exists",
  ),
  "map.data-bridge.map-mutation-failed": classification(
    "map",
    "internal",
    false,
    "Data-to-map renderer mutation failed",
  ),
  "map.data-bridge.interaction-unsupported": classification(
    "map",
    "capability",
    false,
    "Renderer interaction is unsupported",
  ),
  "map.data-bridge.filter-unsupported": classification(
    "map",
    "capability",
    false,
    "Renderer filter mutation is unsupported",
  ),
  "map.automatic-strategy.no-eligible-strategy": classification(
    "map",
    "capability",
    false,
    "No exact map source strategy is eligible",
  ),
  "map.automatic-strategy.stale-plan": classification("map", "validation", false, "Map strategy plan is stale"),
  "map.automatic-strategy.source-conflict": classification(
    "map",
    "validation",
    false,
    "Automatic strategy source identifier already exists",
  ),
  "map.automatic-strategy.layer-conflict": classification(
    "map",
    "validation",
    false,
    "Automatic strategy layer identifier already exists",
  ),
  "map.automatic-strategy.map-mutation-failed": classification(
    "map",
    "internal",
    false,
    "Automatic strategy renderer mutation failed",
  ),
  "map.automatic-strategy.cancelled": classification(
    "map",
    "cancellation",
    false,
    "Automatic map strategy was cancelled",
  ),
  "map.automatic-strategy.disposed": classification("map", "validation", false, "Automatic map strategy is disposed"),
  "map.raster-strategy.unsupported-strategy": classification(
    "map",
    "capability",
    false,
    "Raster strategy is unsupported",
  ),
  "map.raster-strategy.capability-mismatch": classification(
    "map",
    "capability",
    false,
    "Raster source lacks a required capability",
  ),
  "map.raster-strategy.missing-metadata": classification(
    "map",
    "validation",
    false,
    "Raster source metadata is incomplete",
  ),
  "map.raster-strategy.invalid-option": classification("map", "validation", false, "Raster option is invalid"),
  "map.raster-strategy.source-conflict": classification(
    "map",
    "validation",
    false,
    "Raster source identifier already exists",
  ),
  "map.raster-strategy.layer-conflict": classification(
    "map",
    "validation",
    false,
    "Raster layer identifier already exists",
  ),
  "map.raster-strategy.map-mutation-failed": classification(
    "map",
    "internal",
    false,
    "Raster renderer mutation failed",
  ),
  "map.automatic-integration.disposed": classification(
    "map",
    "validation",
    false,
    "Automatic map integration is disposed",
  ),
  "map.automatic-integration.invalid-target": classification(
    "map",
    "validation",
    false,
    "Automatic map integration target is invalid",
  ),
  "map.temporal-playback.invalid-option": classification(
    "map",
    "validation",
    false,
    "Temporal playback option is invalid",
  ),
  "runtime.map-package.fetch": classification("runtime", "network", true, "Map package fetch failed"),
  "runtime.map-package.load": classification("runtime", "internal", false, "Map package load failed"),
  "runtime.map-package.validate": classification("runtime", "validation", false, "Map package validation failed"),
  "runtime.map-package.update": classification("runtime", "internal", false, "Map package update failed"),
  "runtime.map-package.style-compose": classification(
    "runtime",
    "validation",
    false,
    "Map package style composition failed",
  ),
  "runtime.map-package.source-bind": classification("runtime", "internal", false, "Map package source binding failed"),
  "runtime.map-package.view": classification("runtime", "internal", false, "Renderer view mutation failed"),
  "runtime.map-package.popup": classification("runtime", "validation", false, "Popup binding failed"),
  "runtime.map-package.dispose": classification("runtime", "internal", true, "Runtime disposal failed"),
  "runtime.diagnostic": classification("runtime", "validation", false, "Runtime validation diagnostic"),
  "runtime.query-tiles.transient": classification("runtime", "protocol", true, "Retryable query-tile response failure"),
  "runtime.query-tiles.rejected": classification(
    "runtime",
    "protocol",
    false,
    "Non-retryable query-tile response failure",
  ),
} as const satisfies Record<string, HonuaErrorCodeDescriptor>);

export type HonuaErrorCode = keyof typeof HONUA_ERROR_CODE_REGISTRY;

export type HonuaErrorEnvelopeContextValue =
  | null
  | boolean
  | number
  | string
  | readonly HonuaErrorEnvelopeContextValue[]
  | { readonly [key: string]: HonuaErrorEnvelopeContextValue };

export type HonuaErrorEnvelopeContext = Readonly<Record<string, HonuaErrorEnvelopeContextValue>>;

export interface HonuaErrorMetadata {
  readonly operationId?: string;
  readonly requestId?: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface HonuaErrorOptions extends ErrorOptions, HonuaErrorMetadata {}

export interface SerializedHonuaError {
  readonly kind: typeof HONUA_ERROR_KIND;
  readonly name: string;
  readonly domain: HonuaErrorDomain;
  readonly code: HonuaErrorCode;
  readonly category: HonuaErrorCategory;
  readonly retryable: boolean;
  readonly operationId?: string;
  readonly requestId?: string;
  readonly context: HonuaErrorEnvelopeContext;
  readonly cause?: SerializedHonuaErrorCause;
}

export interface SerializedHonuaErrorCause {
  readonly name: string;
  readonly domain?: HonuaErrorDomain;
  readonly code?: HonuaErrorCode;
  readonly category?: HonuaErrorCategory;
  readonly retryable?: boolean;
}

/** Base class for every migrated public SDK error. */
export abstract class HonuaSdkError extends Error {
  public readonly kind = HONUA_ERROR_KIND;
  public readonly domain: HonuaErrorDomain;
  /** Globally unique registry code. Legacy subclasses may retain a separate `.code`. */
  public readonly sdkCode: HonuaErrorCode;
  public readonly category: HonuaErrorCategory;
  public readonly retryable: boolean;
  public readonly operationId: string | undefined;
  public readonly requestId: string | undefined;
  public readonly context: HonuaErrorEnvelopeContext;

  protected constructor(code: HonuaErrorCode, message: string, options: HonuaErrorOptions = {}) {
    const descriptor = errorCodeDescriptor(code);
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "HonuaSdkError";
    this.domain = descriptor.domain;
    this.sdkCode = code;
    this.category = descriptor.category;
    this.retryable = descriptor.retryable;
    this.operationId = sanitizeIdentifier(options.operationId);
    this.requestId = sanitizeIdentifier(options.requestId);
    this.context = sanitizeHonuaErrorContext(options.context);
  }

  /** Safe JSON projection. Raw messages, stacks, details, bodies, and causes are intentionally omitted. */
  public toJSON(): SerializedHonuaError {
    return serializeHonuaError(this);
  }
}

/** Cross-realm type guard backed by the public tag and registered code. */
export function isHonuaSdkError(error: unknown): error is HonuaSdkError {
  try {
    if (!isRecord(error) || Array.isArray(error)) return false;
    const kind = ownDataProperty(error, "kind");
    const sdkCode = ownDataProperty(error, "sdkCode");
    if (kind !== HONUA_ERROR_KIND || typeof sdkCode !== "string" || !isHonuaErrorCode(sdkCode)) return false;
    const descriptor = HONUA_ERROR_CODE_REGISTRY[sdkCode];
    const context = ownDataProperty(error, "context");
    const name = ownDataProperty(error, "name");
    return (
      ownDataProperty(error, "domain") === descriptor.domain &&
      ownDataProperty(error, "retryable") === descriptor.retryable &&
      ownDataProperty(error, "category") === descriptor.category &&
      typeof name === "string" &&
      isRecord(context) &&
      !Array.isArray(context)
    );
  } catch {
    return false;
  }
}

/** Serialize a tagged SDK error without crossing its redaction boundary. */
export function serializeHonuaError(error: HonuaSdkError): SerializedHonuaError {
  const sdkCode = ownDataProperty(error, "sdkCode");
  if (typeof sdkCode !== "string" || !isHonuaErrorCode(sdkCode)) {
    throw new TypeError("Cannot serialize an SDK error with an unregistered code");
  }
  const descriptor = HONUA_ERROR_CODE_REGISTRY[sdkCode];
  const cause = serializeCause(ownDataProperty(error, "cause"));
  const operationId = sanitizeIdentifier(asOptionalString(ownDataProperty(error, "operationId")));
  const requestId = sanitizeIdentifier(asOptionalString(ownDataProperty(error, "requestId")));
  const context = ownDataProperty(error, "context");
  return {
    kind: HONUA_ERROR_KIND,
    name: sanitizeErrorName(ownDataProperty(error, "name")),
    domain: descriptor.domain,
    code: sdkCode,
    category: descriptor.category,
    retryable: descriptor.retryable,
    ...(operationId ? { operationId } : {}),
    ...(requestId ? { requestId } : {}),
    context: isRecord(context) && !Array.isArray(context) ? sanitizeHonuaErrorContext(context) : emptyContext(),
    ...(cause ? { cause } : {}),
  };
}

/** Redact structured context before it is stored on an SDK error. */
export function sanitizeHonuaErrorContext(context?: Readonly<Record<string, unknown>>): HonuaErrorEnvelopeContext {
  if (!context) return emptyContext();
  try {
    const seen = new WeakSet<object>();
    const sanitized = sanitizeRecord(context, seen, 0);
    return Object.freeze(sanitized);
  } catch {
    return frozenRecord("value", "[UNSERIALIZABLE]");
  }
}

/** Merge context inputs without invoking enumerable accessors or honoring prototype-manipulation keys. */
export function mergeHonuaErrorContext(
  ...contexts: readonly (Readonly<Record<string, unknown>> | undefined)[]
): Readonly<Record<string, unknown>> {
  const merged = Object.create(null) as Record<string, unknown>;
  let unsafeKeyCount = 0;
  for (const context of contexts) {
    if (!context) continue;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(context))) {
      if (!descriptor.enumerable) continue;
      if (UNSAFE_PROPERTY_KEY.test(key)) {
        unsafeKeyCount += 1;
        continue;
      }
      merged[key] = "value" in descriptor ? descriptor.value : "[ACCESSOR]";
    }
  }
  if (unsafeKeyCount > 0) merged.__redacted_keys__ = unsafeKeyCount;
  return merged;
}

export function isHonuaErrorCode(code: string): code is HonuaErrorCode {
  return Object.hasOwn(HONUA_ERROR_CODE_REGISTRY, code);
}

function classification(
  domain: HonuaErrorDomain,
  category: HonuaErrorCategory,
  retryable: boolean,
  summary: string,
): HonuaErrorCodeDescriptor {
  return Object.freeze({ domain, category, retryable, summary });
}

function errorCodeDescriptor(code: string): HonuaErrorCodeDescriptor {
  if (!isHonuaErrorCode(code)) throw new TypeError(`Unregistered Honua SDK error code: ${code}`);
  return HONUA_ERROR_CODE_REGISTRY[code];
}

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const MAX_DEPTH = 6;
const MAX_PROPERTIES = 100;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 2_048;
const SENSITIVE_KEY =
  /(?:authorization|proxy-authorization|cookie|set-cookie|credential|password|passwd|secret|token|api[-_]?key|access[-_]?key|access[-_]?id|signature|cursor|resume[-_]?token|where|filter|query|sql|cql|body|payload|form|parameters?)/i;
const URL_KEY = /(?:url|uri|href|endpoint|location)$/i;

function sanitizeRecord(
  value: Readonly<Record<string, unknown>>,
  seen: WeakSet<object>,
  depth: number,
): Record<string, HonuaErrorEnvelopeContextValue> {
  if (depth >= MAX_DEPTH) return frozenRecord("value", TRUNCATED);
  if (seen.has(value)) return frozenRecord("value", "[CIRCULAR]");
  seen.add(value);
  const output = Object.create(null) as Record<string, HonuaErrorEnvelopeContextValue>;
  const descriptors = Object.entries(Object.getOwnPropertyDescriptors(value))
    .filter(([, descriptor]) => descriptor.enumerable)
    .slice(0, MAX_PROPERTIES);
  let unsafeKeyCount = 0;
  for (const [key, descriptor] of descriptors) {
    if (UNSAFE_PROPERTY_KEY.test(key)) {
      unsafeKeyCount += 1;
      continue;
    }
    const item = "value" in descriptor ? descriptor.value : "[ACCESSOR]";
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeValue(item, key, seen, depth + 1);
  }
  if (unsafeKeyCount > 0) output.__redacted_keys__ = unsafeKeyCount;
  if (Reflect.ownKeys(value).length > descriptors.length) output.__truncated__ = TRUNCATED;
  seen.delete(value);
  return Object.freeze(output);
}

function sanitizeValue(
  value: unknown,
  key: string,
  seen: WeakSet<object>,
  depth: number,
): HonuaErrorEnvelopeContextValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return sanitizeString(value, URL_KEY.test(key));
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[UNDEFINED]";
  if (typeof value === "function" || typeof value === "symbol") return "[UNSERIALIZABLE]";
  if (value instanceof Error) return frozenRecord("name", errorNameWithoutGetters(value));
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[BINARY]";
  if (value instanceof Date) {
    const time = Date.prototype.getTime.call(value);
    return Number.isNaN(time) ? "[INVALID_DATE]" : Date.prototype.toISOString.call(value);
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return TRUNCATED;
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const result = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, key, seen, depth + 1)) as HonuaErrorEnvelopeContextValue[];
    if (value.length > result.length) result.push(TRUNCATED);
    seen.delete(value);
    return Object.freeze(result);
  }
  if (isRecord(value)) return sanitizeRecord(value, seen, depth);
  return "[UNSERIALIZABLE]";
}

function sanitizeString(value: string, urlExpected: boolean): string {
  const bounded = value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}` : value;
  if (urlExpected || /^https?:\/\//i.test(bounded)) {
    try {
      const url = new URL(bounded);
      url.username = "";
      url.password = "";
      for (const key of [...url.searchParams.keys()]) {
        if (isSensitiveQueryParameter(key)) url.searchParams.set(key, REDACTED);
      }
      url.hash = "";
      return url.toString();
    } catch {
      if (urlExpected) return REDACTED;
    }
  }
  return bounded
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(
      /\b(access_token|refresh_token|api[-_]?key|password|passwd|secret|token|cursor|resume[-_]?token)\s*[:=]\s*([^\s,;&]+)/gi,
      (_match, name: string) => `${name}=${REDACTED}`,
    );
}

function sanitizeIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) ? value : REDACTED;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function serializeCause(cause: unknown): SerializedHonuaErrorCause | undefined {
  if (cause === undefined) return undefined;
  if (isHonuaSdkError(cause)) {
    const sdkCode = ownDataProperty(cause, "sdkCode");
    if (typeof sdkCode !== "string" || !isHonuaErrorCode(sdkCode)) return { name: "Error" };
    const descriptor = HONUA_ERROR_CODE_REGISTRY[sdkCode];
    return {
      name: sanitizeErrorName(ownDataProperty(cause, "name")),
      domain: descriptor.domain,
      code: sdkCode,
      category: descriptor.category,
      retryable: descriptor.retryable,
    };
  }
  if (cause instanceof Error) return { name: errorNameWithoutGetters(cause) };
  return { name: typeof cause };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function ownDataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function sanitizeErrorName(value: unknown): string {
  return typeof value === "string" && SAFE_ERROR_NAMES.has(value) ? value : "Error";
}

function errorNameWithoutGetters(error: Error): string {
  try {
    const ownName = ownDataProperty(error, "name");
    if (typeof ownName === "string") return sanitizeErrorName(ownName);
    const prototype = Object.getPrototypeOf(error) as object | null;
    return prototype ? sanitizeErrorName(ownDataProperty(prototype, "name")) : "Error";
  } catch {
    return "Error";
  }
}

function isSensitiveQueryParameter(key: string): boolean {
  const normalized = key.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
  return (
    normalized === "key" ||
    /(?:accesstoken|refreshtoken|securitytoken|accesskeyid|accessid|credential|authorization|apikey|signature|password|passwd|secret|cursor|resumetoken|continuationtoken|filter|where|query|sql|cql|auth|sig)$/.test(
      normalized,
    )
  );
}

const UNSAFE_PROPERTY_KEY = /^(?:__proto__|prototype|constructor)$/;
const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "ConnectError",
  "DOMException",
  "Error",
  "EvalError",
  "HonuaAbortError",
  "HonuaAuthError",
  "HonuaAutomaticMapLibreIntegrationError",
  "HonuaAutomaticMapLibreStrategyError",
  "HonuaCapabilityNotSupportedError",
  "HonuaDataToMapBridgeError",
  "HonuaDiscoveryError",
  "HonuaExplorationContextError",
  "HonuaGrpcError",
  "HonuaHttpError",
  "HonuaJobFailedError",
  "HonuaMapLibreRasterStrategyError",
  "HonuaMapLibreSourceAdapterError",
  "HonuaMapPackageError",
  "HonuaNetworkError",
  "HonuaQueryPlanExecutionError",
  "HonuaQueryPlanningError",
  "HonuaRuntimeDiagnosticError",
  "HonuaSdkError",
  "HonuaTemporalPlaybackError",
  "HonuaTimeoutError",
  "HonuaWfsExceptionError",
  "HonuaWmsCapabilitiesParseError",
  "HonuaWmtsCapabilitiesParseError",
  "NetworkError",
  "QueryTileServerResponseError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
]);

function emptyContext(): HonuaErrorEnvelopeContext {
  return Object.freeze(Object.create(null) as Record<string, HonuaErrorEnvelopeContextValue>);
}

function frozenRecord(
  key: string,
  value: HonuaErrorEnvelopeContextValue,
): Record<string, HonuaErrorEnvelopeContextValue> {
  const record = Object.create(null) as Record<string, HonuaErrorEnvelopeContextValue>;
  record[key] = value;
  return Object.freeze(record);
}
