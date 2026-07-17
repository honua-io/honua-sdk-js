/**
 * Tree-shakeable base for the shared, serialization-safe Honua SDK error contract.
 *
 * Error instances retain their original `message`, `cause`, and legacy detail
 * fields for local debugging. Use {@link serializeHonuaError} at telemetry or
 * process boundaries: it emits only registered classifications and sanitized
 * context, never messages, stacks, response bodies, or cause payloads.
 */

import type { HonuaErrorRuntimeClassificationFor } from "./error-classifications.js";
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

type MutableSerializedHonuaError = { -readonly [Key in keyof SerializedHonuaError]: SerializedHonuaError[Key] };

/** @internal Classification carried by a leaf error without retaining the global registry. */
export type HonuaErrorRuntimeClassification = readonly [
  domain: HonuaErrorDomain,
  category: HonuaErrorCategory,
  retryable: boolean,
];

type HonuaRegisteredLeafErrorName =
  | "HonuaAbortError"
  | "HonuaAuthError"
  | "HonuaAutomaticMapLibreIntegrationError"
  | "HonuaAutomaticMapLibreStrategyError"
  | "HonuaCapabilityNotSupportedError"
  | "HonuaDataToMapBridgeError"
  | "HonuaDiscoveryError"
  | "HonuaExplorationContextError"
  | "HonuaGeometryError"
  | "HonuaGrpcError"
  | "HonuaHttpError"
  | "HonuaJobFailedError"
  | "HonuaMapLibreRasterStrategyError"
  | "HonuaMapLibreSourceAdapterError"
  | "HonuaMapPackageError"
  | "HonuaNetworkError"
  | "HonuaOfflineRegionError"
  | "HonuaPluginRegistryError"
  | "HonuaQueryPlanExecutionError"
  | "HonuaQueryPlanningError"
  | "HonuaRealtimeResumeError"
  | "HonuaReplicaSyncError"
  | "HonuaRuntimeDiagnosticError"
  | "HonuaSdkError"
  | "HonuaTemporalPlaybackError"
  | "HonuaTimeoutError"
  | "HonuaWfsExceptionError"
  | "HonuaWmsCapabilitiesParseError"
  | "HonuaWmtsCapabilitiesParseError"
  | "QueryTileServerResponseError";

const ERROR_CLASSIFICATION = Symbol();
type ClassifiedHonuaErrorOptions = HonuaErrorOptions & {
  readonly [ERROR_CLASSIFICATION]: readonly [
    source: object,
    code: HonuaErrorCode,
    name: HonuaRegisteredLeafErrorName,
    domain: HonuaErrorDomain,
    category: HonuaErrorCategory,
    retryable: boolean,
    context: HonuaErrorEnvelopeContext,
  ];
};
const LOCAL_ERRORS = new WeakMap<HonuaSdkError, HonuaRegisteredLeafErrorName>();

/** @internal Attach a leaf-owned classification without changing the public constructor contract. */
export function withHonuaErrorClassification<Code extends HonuaErrorCode>(
  options: HonuaErrorOptions | HonuaErrorMetadata,
  code: Code,
  name: HonuaRegisteredLeafErrorName,
  domain: HonuaErrorRuntimeClassificationFor<NoInfer<Code>>[0],
  category: HonuaErrorRuntimeClassificationFor<NoInfer<Code>>[1],
  retryable: HonuaErrorRuntimeClassificationFor<NoInfer<Code>>[2],
  context: Readonly<Record<string, unknown>> | undefined = ownHonuaErrorContext(options),
): HonuaErrorOptions {
  return classifiedOptions(options, code, name, domain, category, retryable, sanitizeCompactHonuaErrorContext(context));
}

/** @internal Attach a classification with the complete structured context sanitizer. */
export function withStructuredHonuaErrorClassification<Code extends HonuaErrorCode>(
  options: HonuaErrorOptions,
  code: Code,
  name: HonuaRegisteredLeafErrorName,
  domain: HonuaErrorRuntimeClassificationFor<NoInfer<Code>>[0],
  category: HonuaErrorRuntimeClassificationFor<NoInfer<Code>>[1],
  retryable: HonuaErrorRuntimeClassificationFor<NoInfer<Code>>[2],
  context: Readonly<Record<string, unknown>> | undefined = ownHonuaErrorContext(options),
): HonuaErrorOptions {
  return classifiedOptions(options, code, name, domain, category, retryable, sanitizeHonuaErrorContext(context));
}

/** @internal Attach a classification with the fixed safe reason context used by closed error-code unions. */
export function withHonuaErrorReasonClassification<Code extends HonuaErrorCode>(
  options: ErrorOptions,
  code: Code,
  name: HonuaRegisteredLeafErrorName,
  domain: HonuaErrorRuntimeClassificationFor<NoInfer<Code>>[0],
  category: HonuaErrorRuntimeClassificationFor<NoInfer<Code>>[1],
  retryable: HonuaErrorRuntimeClassificationFor<NoInfer<Code>>[2],
  reasonCode: string,
): HonuaErrorOptions {
  const context = Object.create(null) as Record<string, string>;
  context.reasonCode = reasonCode;
  return classifiedOptions(options, code, name, domain, category, retryable, Object.freeze(context));
}

/** Base class for every migrated public SDK error. */
export abstract class HonuaSdkError extends Error {
  public declare readonly kind: "honua.sdk.error.v1";
  public declare readonly domain: HonuaErrorDomain;
  /** Globally unique registry code. Legacy subclasses may retain a separate `.code`. */
  public declare readonly sdkCode: HonuaErrorCode;
  public declare readonly category: HonuaErrorCategory;
  public declare readonly retryable: boolean;
  public declare readonly operationId: string | undefined;
  public declare readonly requestId: string | undefined;
  public declare readonly context: HonuaErrorEnvelopeContext;

  protected constructor(code: HonuaErrorCode, message: string, options: HonuaErrorOptions = {}) {
    const classification = (options as Partial<ClassifiedHonuaErrorOptions>)[ERROR_CLASSIFICATION];
    if (!classification || classification[1] !== code) throw new TypeError("Invalid Honua error classification");
    const [source, , name, domain, category, retryable, context] = classification;
    const cause = Object.getOwnPropertyDescriptor(source, "cause");
    super(message, cause && "value" in cause ? { cause: cause.value } : undefined);
    this.kind = HONUA_ERROR_KIND;
    this.name = name;
    for (const [key, value] of Object.entries({
      domain,
      sdkCode: code,
      category,
      retryable,
      operationId: sanitizeIdentifier(ownDataProperty(source, "operationId")),
      requestId: sanitizeIdentifier(ownDataProperty(source, "requestId")),
      context,
    })) {
      Object.defineProperty(this, key, { value, enumerable: true });
    }
    LOCAL_ERRORS.set(this, name);
  }

  /** Safe JSON projection. Raw messages, stacks, details, bodies, and causes are intentionally omitted. */
  public toJSON(): SerializedHonuaError {
    return serializeLocalHonuaError(this) as SerializedHonuaError;
  }
}

/** Leaf-local guard. The public envelope exports the full cross-realm registry guard. */
export function isHonuaSdkError(error: unknown): error is HonuaSdkError {
  return isLocalHonuaSdkError(error);
}

/** @internal True only for an error constructed by this SDK instance. */
export function isLocalHonuaSdkError(error: unknown): error is HonuaSdkError {
  return LOCAL_ERRORS.has(error as HonuaSdkError);
}

/** @internal Serialize an instance authenticated by this module's private WeakSet. */
export function serializeLocalHonuaError(error: HonuaSdkError): SerializedHonuaError | undefined {
  const registeredName = LOCAL_ERRORS.get(error);
  if (!registeredName) return undefined;
  const cause = serializeLocalCause(ownDataProperty(error, "cause"));
  const serialized: MutableSerializedHonuaError = {
    kind: HONUA_ERROR_KIND,
    name: leafErrorName(ownDataProperty(error, "name"), registeredName),
    domain: error.domain,
    code: error.sdkCode,
    category: error.category,
    retryable: error.retryable,
    context: error.context,
  };
  if (error.operationId) serialized.operationId = error.operationId;
  if (error.requestId) serialized.requestId = error.requestId;
  if (cause) serialized.cause = cause;
  return serialized;
}

function classifiedOptions(
  options: object,
  code: HonuaErrorCode,
  name: HonuaRegisteredLeafErrorName,
  domain: HonuaErrorDomain,
  category: HonuaErrorCategory,
  retryable: boolean,
  context: HonuaErrorEnvelopeContext,
): HonuaErrorOptions {
  return {
    [ERROR_CLASSIFICATION]: [options, code, name, domain, category, retryable, context],
  } as ClassifiedHonuaErrorOptions;
}

/** Compact leaf-owned sanitizer; keep behavior aligned with {@link sanitizeHonuaErrorContext}. */
function sanitizeCompactHonuaErrorContext(context?: Readonly<Record<string, unknown>>): HonuaErrorEnvelopeContext {
  if (!context) return emptyContext();
  try {
    return sanitizeCompactValue(context, new WeakSet(), 0) as HonuaErrorEnvelopeContext;
  } catch {
    return emptyContext();
  }
}

function sanitizeCompactValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  urlExpected = false,
): HonuaErrorEnvelopeContextValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return sanitizeString(value, urlExpected);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "undefined") return "[UNDEFINED]";
  if (typeof value === "function" || typeof value === "symbol") return "[UNSERIALIZABLE]";
  if (value instanceof Error) {
    const registeredName = LOCAL_ERRORS.get(value as HonuaSdkError);
    const errorName = ownDataProperty(value, "name") ?? ownDataProperty(Object.getPrototypeOf(value) as object, "name");
    return Object.freeze({ name: leafErrorName(errorName, registeredName) });
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[BINARY]";
  if (value instanceof Date) {
    const time = Date.prototype.getTime.call(value);
    return Number.isNaN(time) ? "[INVALID_DATE]" : Date.prototype.toISOString.call(value);
  }
  if (depth >= 6) return TRUNCATED;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  let output: HonuaErrorEnvelopeContextValue[] | Record<string, HonuaErrorEnvelopeContextValue>;
  if (Array.isArray(value)) {
    const length = ownDataProperty(value, "length") as number;
    output = Array.from({ length: Math.min(length, 100) }, (_, index) =>
      sanitizeCompactValue(ownDataProperty(value, index, "[ACCESSOR]"), seen, depth + 1, urlExpected),
    );
    if (length > 100) output.push(TRUNCATED);
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
        : sanitizeCompactValue(ownDataProperty(value, key), seen, depth + 1, URL_KEY.test(key));
    }
  }
  seen.delete(value);
  return Object.freeze(output);
}

const LEAF_SENSITIVE_KEY =
  /auth|cookie|credent|passw|secret|token|api.?key|access.?(key|id)|signat|cursor|filter|where|query|[sc]ql|body|payload|form|parameters?|path|directory|file.*ur[il]|^key$|^sig$/i;

function leafErrorName(value: unknown, registeredName?: HonuaRegisteredLeafErrorName): string {
  if (registeredName && registeredName !== "HonuaGeometryError" && value === registeredName) return registeredName;
  return typeof value === "string" && NATIVE_ERROR_NAME.test(value) ? value : "Error";
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
    for (const key of Object.keys(context)) {
      if (UNSAFE_PROPERTY_KEY.test(key)) {
        unsafeKeyCount += 1;
        continue;
      }
      merged[key] = ownDataProperty(context, key, "[ACCESSOR]");
    }
  }
  if (unsafeKeyCount > 0) merged.__redacted_keys__ = unsafeKeyCount;
  return merged;
}

/** @internal True only for a valid tagged retryable network or timeout classification. */
export function isRetryableNetworkOrTimeoutHonuaError(error: unknown): boolean {
  try {
    if (!isRecord(error) || Array.isArray(error)) return false;
    const name = ownDataProperty(error, "name");
    const sdkCode = ownDataProperty(error, "sdkCode");
    const domain = ownDataProperty(error, "domain");
    const category = ownDataProperty(error, "category");
    const context = ownDataProperty(error, "context");
    if (
      typeof name !== "string" ||
      typeof sdkCode !== "string" ||
      typeof domain !== "string" ||
      typeof category !== "string" ||
      !isPlainHonuaErrorContext(context)
    ) {
      return false;
    }
    return (
      ownDataProperty(error, "kind") === HONUA_ERROR_KIND &&
      ownDataProperty(error, "retryable") === true &&
      RETRYABLE_NETWORK_OR_TIMEOUT_KEYS.has(`${domain}/${category}/${sdkCode}`)
    );
  } catch {
    return false;
  }
}

/** @internal Accept ordinary contexts from this realm or another realm without admitting class instances. */
export function isPlainHonuaErrorContext(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || Object.getPrototypeOf(prototype) === null;
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
const URL_KEY = /(url|uri|href|endpoint|location)$/i;

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
    const length = ownDataProperty(value, "length") as number;
    const result = Array.from({ length: Math.min(length, MAX_ARRAY_ITEMS) }, (_, index) =>
      sanitizeValue(ownDataProperty(value, index, "[ACCESSOR]"), key, seen, depth + 1),
    );
    if (length > result.length) result.push(TRUNCATED);
    seen.delete(value);
    return Object.freeze(result);
  }
  if (isRecord(value)) return sanitizeRecord(value, seen, depth);
  return "[UNSERIALIZABLE]";
}

function sanitizeString(value: string, urlExpected?: boolean): string {
  const bounded = value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}${TRUNCATED}` : value;
  if (urlExpected || /^https?:\/\//i.test(bounded)) {
    try {
      const url = new URL(bounded);
      url.username = url.password = url.hash = "";
      for (const key of url.searchParams.keys()) {
        if (LEAF_SENSITIVE_KEY.test(key)) url.searchParams.set(key, REDACTED);
      }
      return url.href;
    } catch {
      if (urlExpected) return REDACTED;
    }
  }
  return bounded
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b([\w-]+)\s*[:=]\s*[^\s,;&]+/g, (match, name: string) =>
      LEAF_SENSITIVE_KEY.test(name) ? `${name}=${REDACTED}` : match,
    );
}

/** @internal */
export function sanitizeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) ? value : REDACTED;
}

function serializeLocalCause(cause: unknown): SerializedHonuaErrorCause | undefined {
  if (cause === undefined) return undefined;
  try {
    const registeredName = LOCAL_ERRORS.get(cause as HonuaSdkError);
    if (registeredName) {
      const localCause = cause as HonuaSdkError;
      return {
        name: leafErrorName(ownDataProperty(localCause, "name"), registeredName),
        domain: localCause.domain,
        code: localCause.sdkCode,
        category: localCause.category,
        retryable: localCause.retryable,
      };
    }
    if (cause instanceof Error) {
      if (ownDataProperty(cause, "kind") === HONUA_ERROR_KIND) return { name: "Error" };
      return {
        name: leafErrorName(
          ownDataProperty(cause, "name") ?? ownDataProperty(Object.getPrototypeOf(cause) as object, "name"),
        ),
      };
    }
    return { name: typeof cause };
  } catch {
    return { name: "Error" };
  }
}

/** @internal */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** @internal */
export function ownDataProperty(value: object, key: PropertyKey, accessor?: unknown): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : accessor;
}

/** @internal Read only an own data-property context from caller options. */
export function ownHonuaErrorContext(options: object): Readonly<Record<string, unknown>> | undefined {
  const context = ownDataProperty(options, "context");
  return context !== null && typeof context === "object" && !Array.isArray(context)
    ? (context as Readonly<Record<string, unknown>>)
    : undefined;
}

/** @internal Add an explicit cause without spreading caller metadata. */
export function honuaErrorOptionsWithCause(options: HonuaErrorMetadata, cause: unknown): HonuaErrorOptions {
  return {
    cause,
    operationId: ownDataProperty(options, "operationId") as string | undefined,
    requestId: ownDataProperty(options, "requestId") as string | undefined,
    context: ownHonuaErrorContext(options),
  };
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

const UNSAFE_PROPERTY_KEY = /^(__proto__|prototype|constructor)$/;
const NATIVE_ERROR_NAME =
  /^((Abort|Aggregate|Connect|Eval|Network|Range|Reference|Syntax|Timeout|Type|URI)?Error|DOMException)$/;
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
