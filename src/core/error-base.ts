/**
 * Tree-shakeable base for the shared, serialization-safe Honua SDK error contract.
 *
 * Error instances retain their original `message`, `cause`, and legacy detail
 * fields for local debugging. Use {@link serializeHonuaError} at telemetry or
 * process boundaries: it emits only registered classifications and sanitized
 * context, never messages, stacks, response bodies, or cause payloads.
 */

import type { HonuaErrorCategory, HonuaErrorCode, HonuaErrorDomain } from "./error-code-registry.js";

export type {
  HonuaErrorCategory,
  HonuaErrorCode,
  HonuaErrorCodeDescriptor,
  HonuaErrorDomain,
} from "./error-code-registry.js";

export const HONUA_ERROR_KIND = "honua.sdk.error.v1" as const;

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

/** @internal Classification carried by a leaf error without retaining the global registry. */
export type HonuaErrorRuntimeClassification = readonly [
  domain: HonuaErrorDomain,
  category: HonuaErrorCategory,
  retryable: boolean,
];

const ERROR_CLASSIFICATION = Symbol();
const ERROR_CLASSIFICATION_PROOF = Symbol.for("honua.ec");
type ClassifiedHonuaErrorOptions = HonuaErrorOptions & {
  readonly [ERROR_CLASSIFICATION]: HonuaErrorRuntimeClassification;
};
const LOCAL_ERRORS = new WeakSet<HonuaSdkError>();

/** @internal Attach a leaf-owned classification without changing the public constructor contract. */
export function withHonuaErrorClassification(
  options: HonuaErrorOptions,
  domain: HonuaErrorDomain,
  category: HonuaErrorCategory,
  retryable: boolean,
): HonuaErrorOptions {
  return {
    ...options,
    context: sanitizeCompactHonuaErrorContext(options.context),
    [ERROR_CLASSIFICATION]: [domain, category, retryable],
  } as ClassifiedHonuaErrorOptions;
}

/** @internal Attach a classification with the complete structured context sanitizer. */
export function withStructuredHonuaErrorClassification(
  options: HonuaErrorOptions,
  domain: HonuaErrorDomain,
  category: HonuaErrorCategory,
  retryable: boolean,
): HonuaErrorOptions {
  return classifiedOptions(options, domain, category, retryable, sanitizeHonuaErrorContext(options.context));
}

/** @internal Attach a classification with the fixed safe reason context used by closed error-code unions. */
export function withHonuaErrorReasonClassification(
  options: ErrorOptions,
  domain: HonuaErrorDomain,
  category: HonuaErrorCategory,
  retryable: boolean,
  reasonCode: string,
): HonuaErrorOptions {
  const context = Object.create(null) as Record<string, string>;
  context.reasonCode = reasonCode;
  return classifiedOptions(options, domain, category, retryable, Object.freeze(context));
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
    const classification = (options as Partial<ClassifiedHonuaErrorOptions>)[ERROR_CLASSIFICATION];
    if (!classification) throw new TypeError(`Unregistered Honua SDK error code: ${code}`);
    const [domain, category, retryable] = classification;
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "HonuaSdkError";
    this.domain = domain;
    this.sdkCode = code;
    this.category = category;
    this.retryable = retryable;
    this.operationId = sanitizeIdentifier(options.operationId);
    this.requestId = sanitizeIdentifier(options.requestId);
    this.context = options.context as HonuaErrorEnvelopeContext;
    Object.defineProperty(this, ERROR_CLASSIFICATION_PROOF, {
      value: [code, domain, category, retryable].join(),
    });
    for (const key of ["domain", "sdkCode", "category", "retryable", "operationId", "requestId", "context"]) {
      Object.defineProperty(this, key, { configurable: false, writable: false });
    }
    LOCAL_ERRORS.add(this);
  }

  /** Safe JSON projection. Raw messages, stacks, details, bodies, and causes are intentionally omitted. */
  public toJSON(): SerializedHonuaError {
    return serializeLocalHonuaError(this);
  }
}

/** Leaf-local guard. The public envelope exports the full cross-realm registry guard. */
export function isHonuaSdkError(error: unknown): error is HonuaSdkError {
  return isLocalHonuaSdkError(error);
}

/** @internal True only for an error constructed by this SDK instance. */
export function isLocalHonuaSdkError(error: unknown): error is HonuaSdkError {
  return typeof error === "object" && error !== null && LOCAL_ERRORS.has(error as HonuaSdkError);
}

function serializeLocalHonuaError(error: HonuaSdkError): SerializedHonuaError {
  if (!LOCAL_ERRORS.has(error)) throw new TypeError("Cannot serialize an SDK error with an unregistered code");
  const cause = serializeLocalCause(ownDataProperty(error, "cause"));
  return {
    kind: HONUA_ERROR_KIND,
    name: leafErrorName(ownDataProperty(error, "name")),
    domain: error.domain,
    code: error.sdkCode,
    category: error.category,
    retryable: error.retryable,
    ...(error.operationId ? { operationId: error.operationId } : {}),
    ...(error.requestId ? { requestId: error.requestId } : {}),
    context: error.context,
    ...(cause ? { cause } : {}),
  };
}

/**
 * Conservative leaf-only context projection. It preserves bounded JSON-safe
 * diagnostics needed by geometry and map workflows without retaining the full
 * serializer, while redacting richer or credential-bearing values.
 */
function classifiedOptions(
  options: ErrorOptions,
  domain: HonuaErrorDomain,
  category: HonuaErrorCategory,
  retryable: boolean,
  context: HonuaErrorEnvelopeContext,
): HonuaErrorOptions {
  return { ...options, context, [ERROR_CLASSIFICATION]: [domain, category, retryable] } as ClassifiedHonuaErrorOptions;
}

function sanitizeCompactHonuaErrorContext(context?: Readonly<Record<string, unknown>>): HonuaErrorEnvelopeContext {
  if (!context) return emptyContext();
  try {
    return sanitizeCompactValue(context, new WeakSet(), 0) as HonuaErrorEnvelopeContext;
  } catch {
    return emptyContext();
  }
}

function sanitizeCompactValue(value: unknown, seen: WeakSet<object>, depth: number): HonuaErrorEnvelopeContextValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    const bounded = value.length > 2_048 ? `${value.slice(0, 2_048)}[TRUNCATED]` : value;
    return /bearer|credent|passw|secret|token|signat|(api|access).?key|[?&]key=/i.test(bounded) ? REDACTED : bounded;
  }
  if (depth >= 6) return TRUNCATED;
  if (typeof value !== "object") return REDACTED;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  let output: HonuaErrorEnvelopeContextValue[] | Record<string, HonuaErrorEnvelopeContextValue>;
  if (Array.isArray(value)) {
    output = value.slice(0, 100).map((item) => sanitizeCompactValue(item, seen, depth + 1));
    if (value.length > 100) output.push(TRUNCATED);
  } else {
    output = Object.create(null) as Record<string, HonuaErrorEnvelopeContextValue>;
    let count = 0;
    for (const key of Object.keys(value)) {
      if (count++ === 100) {
        output.__truncated__ = TRUNCATED;
        break;
      }
      if (UNSAFE_PROPERTY_KEY.test(key)) continue;
      output[key] = LEAF_SENSITIVE_KEY.test(key)
        ? REDACTED
        : sanitizeCompactValue(ownDataProperty(value, key), seen, depth + 1);
    }
  }
  seen.delete(value);
  return Object.freeze(output);
}

function leafErrorName(value: unknown): string {
  // Preserve the legacy full serializer's deliberate allowlist boundary.
  return typeof value === "string" && /^(?:Honua(?!GeometryError$)\w{1,64}|QueryTileServerResponse)Error$/.test(value)
    ? value
    : "Error";
}

const LEAF_SENSITIVE_KEY =
  /auth|cookie|credent|passw|secret|token|(api|access).?key|signat|cursor|filter|query|body|payload|path|ur[il]|href|endpoint|location|^key$/i;

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
    for (const key of Object.keys(context)) {
      if (UNSAFE_PROPERTY_KEY.test(key)) {
        unsafeKeyCount += 1;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(context, key);
      merged[key] = descriptor && "value" in descriptor ? descriptor.value : "[ACCESSOR]";
    }
  }
  if (unsafeKeyCount > 0) merged.__redacted_keys__ = unsafeKeyCount;
  return merged;
}

/** @internal True only for a valid tagged retryable network or timeout classification. */
export function isRetryableNetworkOrTimeoutHonuaError(error: unknown): boolean {
  try {
    if (!isRecord(error) || Array.isArray(error)) return false;
    const sdkCode = ownDataProperty(error, "sdkCode");
    const domain = ownDataProperty(error, "domain");
    const category = ownDataProperty(error, "category");
    if (typeof sdkCode !== "string" || typeof domain !== "string" || typeof category !== "string") return false;
    return (
      ownDataProperty(error, "kind") === HONUA_ERROR_KIND &&
      ownDataProperty(error, "retryable") === true &&
      isRecord(ownDataProperty(error, "context")) &&
      RETRYABLE_NETWORK_OR_TIMEOUT_KEYS.has(`${domain}/${category}/${sdkCode}`)
    );
  } catch {
    return false;
  }
}

const RETRYABLE_NETWORK_OR_TIMEOUT_KEYS = new Set([
  "core/timeout/core.timeout",
  "core/network/core.network",
  "runtime/network/runtime.map-package.fetch",
  "realtime/network/realtime.transport.reconnectable",
  "offline/network/offline.transport.transient",
]);

const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const MAX_DEPTH = 6;
const MAX_PROPERTIES = 100;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 2_048;
const SENSITIVE_KEY =
  /(?:authorization|proxy-authorization|cookie|set-cookie|credential|password|passwd|secret|token|api[-_]?key|access[-_]?key|access[-_]?id|signature|cursor|resume[-_]?token|where|filter|query|sql|cql|body|payload|form|parameters?)/i;
const STORAGE_LOCATOR_KEY =
  /^(?:local[-_]?storage|storage|cache(?:[-_]?file)?|file|filesystem)[-_]?(?:path|directory|url|uri|location)$/i;
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
    output[key] =
      SENSITIVE_KEY.test(key) || STORAGE_LOCATOR_KEY.test(key) ? REDACTED : sanitizeValue(item, key, seen, depth + 1);
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

/** @internal */
export function sanitizeIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) ? value : REDACTED;
}

/** @internal */
export function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function serializeLocalCause(cause: unknown): SerializedHonuaErrorCause | undefined {
  if (cause === undefined) return undefined;
  try {
    const classification = leafCauseClassification(cause);
    if (classification) {
      const [code, domain, category, retryable] = classification;
      return {
        name: leafErrorName(ownDataProperty(cause as object, "name")),
        domain,
        code,
        category,
        retryable,
      };
    }
    if (cause instanceof Error) return { name: "Error" };
    return { name: typeof cause };
  } catch {
    return { name: "Error" };
  }
}

function leafCauseClassification(
  cause: unknown,
): readonly [HonuaErrorCode, HonuaErrorDomain, HonuaErrorCategory, boolean] | undefined {
  if (
    cause === null ||
    typeof cause !== "object" ||
    Array.isArray(cause) ||
    ownDataProperty(cause, "kind") !== HONUA_ERROR_KIND
  )
    return undefined;
  const code = ownDataProperty(cause, "sdkCode");
  const domain = ownDataProperty(cause, "domain");
  const category = ownDataProperty(cause, "category");
  const retryable = ownDataProperty(cause, "retryable");
  if (
    typeof code !== "string" ||
    typeof domain !== "string" ||
    typeof category !== "string" ||
    typeof retryable !== "boolean" ||
    ownDataProperty(cause, ERROR_CLASSIFICATION_PROOF) !== [code, domain, category, retryable].join()
  ) {
    return undefined;
  }
  return [code, domain, category, retryable] as readonly [
    HonuaErrorCode,
    HonuaErrorDomain,
    HonuaErrorCategory,
    boolean,
  ];
}

/** @internal */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** @internal */
export function ownDataProperty(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** @internal */
export function sanitizeErrorName(value: unknown): string {
  return typeof value === "string" && SAFE_ERROR_NAMES.has(value) ? value : "Error";
}

/** @internal */
export function errorNameWithoutGetters(error: Error): string {
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
  "HonuaOfflineRegionError",
  "HonuaPluginRegistryError",
  "HonuaQueryPlanExecutionError",
  "HonuaQueryPlanningError",
  "HonuaRealtimeResumeError",
  "HonuaReplicaSyncError",
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

/** @internal */
export function emptyContext(): HonuaErrorEnvelopeContext {
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
