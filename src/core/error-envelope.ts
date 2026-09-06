/**
 * Shared, serialization-safe error contract for public Honua SDK failures.
 *
 * Error instances retain their original `message`, `cause`, and legacy detail
 * fields for local debugging. Use {@link serializeHonuaError} at telemetry or
 * process boundaries: it emits only registered classifications and sanitized
 * context, never messages, stacks, response bodies, or cause payloads.
 */

import { HONUA_ERROR_RUNTIME_CLASSIFICATIONS, type HonuaErrorRuntimeClassification } from "./error-classifications.js";
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
  readonly terminalReceipt?: HonuaTerminalFailureReceipt;
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
  readonly receipt?: HonuaTerminalFailureReceipt;
  readonly context: HonuaErrorEnvelopeContext;
  readonly cause?: SerializedHonuaErrorCause;
}

/** Stable failure classes shared by HTTP, GeoServices, and gRPC terminal receipts. */
export type HonuaFailureKind =
  | "authentication"
  | "authorization"
  | "not-found"
  | "validation"
  | "conflict"
  | "throttled"
  | "unavailable"
  | "unknown";

/** One field- or item-addressable server rejection. */
export interface HonuaFieldFailure {
  readonly code?: string;
  readonly severity?: string;
  readonly path?: string;
  readonly fieldId?: string;
  readonly itemIndex?: number;
  readonly message?: string;
}

/** Protocol-native metadata retained at a terminal transport boundary. */
export interface HonuaProtocolMetadata {
  readonly initial: Readonly<Record<string, readonly string[]>>;
  readonly trailing: Readonly<Record<string, readonly string[]>>;
}

/** Machine-actionable receipt exposed by every remote terminal SDK error. */
export interface HonuaTerminalFailureReceipt {
  readonly transportStatus?: number;
  readonly protocolCode?: number | string;
  readonly kind: HonuaFailureKind;
  readonly code?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly correlationId?: string;
  readonly fieldErrors: readonly HonuaFieldFailure[];
  readonly protocolMetadata: HonuaProtocolMetadata;
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
  public readonly terminalReceipt: HonuaTerminalFailureReceipt | undefined;
  public readonly context: HonuaErrorEnvelopeContext;

  protected constructor(code: HonuaErrorCode, message: string, options: HonuaErrorOptions = {}) {
    const [domain, category, retryable] = errorCodeClassification(code);
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "HonuaSdkError";
    this.domain = domain;
    this.sdkCode = code;
    this.category = category;
    this.retryable = retryable;
    this.operationId = sanitizeIdentifier(options.operationId);
    this.requestId = sanitizeIdentifier(options.requestId);
    this.terminalReceipt = options.terminalReceipt;
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
    const [domain, category, retryable] = HONUA_ERROR_RUNTIME_CLASSIFICATIONS[sdkCode];
    const context = ownDataProperty(error, "context");
    const name = ownDataProperty(error, "name");
    return (
      ownDataProperty(error, "domain") === domain &&
      ownDataProperty(error, "retryable") === retryable &&
      ownDataProperty(error, "category") === category &&
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
  const [domain, category, retryable] = HONUA_ERROR_RUNTIME_CLASSIFICATIONS[sdkCode];
  const cause = serializeCause(ownDataProperty(error, "cause"));
  const operationId = sanitizeIdentifier(asOptionalString(ownDataProperty(error, "operationId")));
  const requestId = sanitizeIdentifier(asOptionalString(ownDataProperty(error, "requestId")));
  const receipt = ownDataProperty(error, "terminalReceipt");
  const context = ownDataProperty(error, "context");
  return {
    kind: HONUA_ERROR_KIND,
    name: sanitizeErrorName(ownDataProperty(error, "name")),
    domain,
    code: sdkCode,
    category,
    retryable,
    ...(operationId ? { operationId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(isTerminalFailureReceipt(receipt) ? { receipt } : {}),
    context: isRecord(context) && !Array.isArray(context) ? sanitizeHonuaErrorContext(context) : emptyContext(),
    ...(cause ? { cause } : {}),
  };
}

function isTerminalFailureReceipt(value: unknown): value is HonuaTerminalFailureReceipt {
  return (
    isRecord(value) &&
    typeof ownDataProperty(value, "kind") === "string" &&
    typeof ownDataProperty(value, "retryable") === "boolean" &&
    Array.isArray(ownDataProperty(value, "fieldErrors")) &&
    isRecord(ownDataProperty(value, "protocolMetadata"))
  );
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
  return Object.hasOwn(HONUA_ERROR_RUNTIME_CLASSIFICATIONS, code);
}

/** @internal True only for a valid tagged retryable network or timeout classification. */
export function isRetryableNetworkOrTimeoutHonuaError(error: unknown): boolean {
  try {
    if (!isHonuaSdkError(error)) return false;
    const sdkCode = ownDataProperty(error, "sdkCode");
    if (typeof sdkCode !== "string" || !isHonuaErrorCode(sdkCode)) return false;
    const [, category, retryable] = HONUA_ERROR_RUNTIME_CLASSIFICATIONS[sdkCode];
    return retryable && (category === "network" || category === "timeout");
  } catch {
    return false;
  }
}

function errorCodeClassification(code: string): HonuaErrorRuntimeClassification {
  if (!isHonuaErrorCode(code)) throw new TypeError(`Unregistered Honua SDK error code: ${code}`);
  return HONUA_ERROR_RUNTIME_CLASSIFICATIONS[code];
}

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

function sanitizeIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) ? value : REDACTED;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function serializeCause(cause: unknown): SerializedHonuaErrorCause | undefined {
  if (cause === undefined) return undefined;
  try {
    if (isHonuaSdkError(cause)) {
      const sdkCode = ownDataProperty(cause, "sdkCode");
      if (typeof sdkCode !== "string" || !isHonuaErrorCode(sdkCode)) return { name: "Error" };
      const [domain, category, retryable] = HONUA_ERROR_RUNTIME_CLASSIFICATIONS[sdkCode];
      return {
        name: sanitizeErrorName(ownDataProperty(cause, "name")),
        domain,
        code: sdkCode,
        category,
        retryable,
      };
    }
    if (cause instanceof Error) return { name: errorNameWithoutGetters(cause) };
    return { name: typeof cause };
  } catch {
    return { name: "Error" };
  }
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
  "HonuaAgentExecutionError",
  "HonuaAgentSafetyError",
  "HonuaAgentToolError",
  "HonuaAuthError",
  "HonuaAutomaticMapLibreIntegrationError",
  "HonuaAutomaticMapLibreStrategyError",
  "HonuaCapabilityNotSupportedError",
  "HonuaDataToMapBridgeError",
  "HonuaDiscoveryError",
  "HonuaExplorationContextError",
  "HonuaGeneratedAppError",
  "HonuaGrpcError",
  "HonuaHttpError",
  "HonuaJobFailedError",
  "HonuaMapLibreRasterStrategyError",
  "HonuaMapLibreSourceAdapterError",
  "HonuaMapPackageError",
  "HonuaNetworkError",
  "HonuaOfflineRegionError",
  "HonuaOfflineEditQueueError",
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
  "HonuaWfsProtocolError",
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
