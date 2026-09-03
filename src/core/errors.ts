/**
 * Tagged hierarchy for the migrated Honua SDK error domains. The common
 * `isHonuaError(error)` guard also recognizes migrated query, map, runtime,
 * realtime, offline, and plugin subclasses. See
 * [`docs/errors.md`](../../docs/errors.md) for exact coverage, residual domains,
 * recovery hints, and the retryability classification.
 *
 * @example
 * ```ts
 * import {
 *   HonuaHttpError,
 *   HonuaTimeoutError,
 *   HonuaCapabilityNotSupportedError,
 *   isHonuaError,
 * } from "@honua/sdk-js";
 *
 * try {
 *   await dataset.source("parcels")!.queryAll({ pagination: { limit: 100 } });
 * } catch (error) {
 *   if (!isHonuaError(error)) throw error;
 *   if (error instanceof HonuaCapabilityNotSupportedError) return fallback();
 *   if (error instanceof HonuaHttpError && error.statusCode === 401) {
 *     await refreshCredentials();
 *     return retry();
 *   }
 *   if (error instanceof HonuaTimeoutError) return notifyUser("Server slow");
 *   throw error;
 * }
 * ```
 *
 * @packageDocumentation
 */

import {
  type HonuaErrorMetadata,
  type HonuaErrorOptions,
  type HonuaFailureKind,
  type HonuaFieldFailure,
  type HonuaProtocolMetadata,
  HonuaSdkError,
  type HonuaTerminalFailureReceipt,
  isHonuaSdkError,
  mergeHonuaErrorContext,
} from "./error-envelope.js";

export type { HonuaFailureKind, HonuaFieldFailure, HonuaProtocolMetadata, HonuaTerminalFailureReceipt };

export interface HonuaHttpErrorOptions extends HonuaErrorOptions {
  readonly responseHeaders?: Pick<Headers, "entries" | "get"> | Readonly<Record<string, string | readonly string[]>>;
  readonly protocolCode?: number | string;
  readonly transportStatus?: number;
}

export interface HonuaGrpcErrorOptions extends HonuaErrorOptions {
  readonly initialMetadata?: unknown;
  readonly trailingMetadata?: unknown;
}

export type HonuaDiscoveryErrorCode =
  | "ambiguous-protocol"
  | "ambiguous-source"
  | "invalid-cloud-native-input"
  | "invalid-cloud-native-manifest"
  | "invalid-endpoint"
  | "invalid-cache-identity"
  | "invalid-discovery-cache"
  | "invalid-capability"
  | "cloud-native-operation-unavailable"
  | "unsupported-protocol"
  | "protocol-mismatch";

/** Discovery input, metadata, or cache identity is invalid or inconsistent. */
export class HonuaDiscoveryError extends HonuaSdkError {
  public constructor(
    public readonly code: HonuaDiscoveryErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options: HonuaErrorOptions = {},
  ) {
    super(`discovery.${code}`, message, {
      ...options,
      context: mergeHonuaErrorContext(detail, options.context),
    });
    this.name = "HonuaDiscoveryError";
  }
}

/** Stable reason codes for geometry inputs that cannot be classified safely. */
export type HonuaGeometryErrorCode = "unknown-geometry" | "malformed-geometry";

/**
 * Thrown when a geometry cannot be classified without guessing. The structured
 * `code` and `detail` fields let callers distinguish an unsupported shape from
 * a recognized-but-malformed Esri geometry without parsing the message.
 */
export class HonuaGeometryError extends HonuaSdkError {
  public constructor(
    public readonly code: HonuaGeometryErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options: HonuaErrorOptions = {},
  ) {
    super(`core.geometry.${code}`, message, {
      ...options,
      context: mergeHonuaErrorContext(detail, options.context),
    });
    this.name = "HonuaGeometryError";
  }
}

/**
 * Thrown when the server returns a non-2xx HTTP status. Branch on
 * `.statusCode` to decide recovery: refresh credentials on 401/403, respect
 * `Retry-After` on 429, back off on 5xx, etc.
 *
 * @see [`docs/errors.md`](../../docs/errors.md)
 */
export class HonuaHttpError extends HonuaSdkError {
  public readonly statusCode: number;
  public readonly body: unknown;
  public readonly receipt: HonuaTerminalFailureReceipt;

  public constructor(statusCode: number, message: string, body: unknown, options: HonuaHttpErrorOptions = {}) {
    const receipt = httpFailureReceipt(statusCode, body, options);
    super(receipt.retryable ? "core.http.transient" : "core.http.rejected", `HTTP ${statusCode}: ${message}`, {
      ...options,
      requestId: options.requestId ?? receipt.correlationId,
      terminalReceipt: receipt,
      context: mergeHonuaErrorContext(options.context, { statusCode }),
    });
    this.name = "HonuaHttpError";
    this.statusCode = statusCode;
    this.body = body;
    this.receipt = receipt;
  }
}

/** Thrown when a request exceeds the configured timeout. */
export class HonuaTimeoutError extends HonuaSdkError {
  public readonly timeoutMs: number;

  public constructor(timeoutMs: number, options: HonuaErrorOptions = {}) {
    super("core.timeout", `Request timed out after ${timeoutMs}ms`, {
      ...options,
      context: mergeHonuaErrorContext(options.context, { timeoutMs }),
    });
    this.name = "HonuaTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown when a network-level failure occurs (DNS, connection refused, etc.). */
export class HonuaNetworkError extends HonuaSdkError {
  public override readonly cause: unknown;

  public constructor(message: string, cause: unknown, metadata: HonuaErrorMetadata = {}) {
    super("core.network", message, { ...metadata, cause });
    this.name = "HonuaNetworkError";
    this.cause = cause;
  }
}

/** Thrown when a request is aborted via a caller-provided AbortSignal. */
export class HonuaAbortError extends HonuaSdkError {
  public constructor(message = "Request was aborted", options: HonuaErrorOptions = {}) {
    super("core.cancelled", message, options);
    this.name = "HonuaAbortError";
  }
}

/** Thrown when a gRPC-Web request fails, wrapping the underlying ConnectError. */
export class HonuaGrpcError extends HonuaSdkError {
  public readonly details: unknown;
  public readonly receipt: HonuaTerminalFailureReceipt;

  public constructor(
    public readonly code: number,
    message: string,
    details?: unknown,
    options: HonuaGrpcErrorOptions = {},
  ) {
    const receipt = grpcFailureReceipt(code, details, options);
    super(receipt.retryable ? "core.grpc.transient" : "core.grpc.rejected", message, {
      ...options,
      requestId: options.requestId ?? receipt.correlationId,
      terminalReceipt: receipt,
      context: mergeHonuaErrorContext(options.context, { grpcCode: code }),
    });
    this.name = "HonuaGrpcError";
    this.details = details;
    this.receipt = receipt;
  }
}

/**
 * Thrown when a `Source` is asked to perform an operation that the underlying
 * protocol or server does not support and the active capability policy is
 * `strict`. The `capability` field names the missing capability so callers can
 * decide whether to swap protocols, fall back to a degraded strategy, or
 * surface the limitation to the user.
 */
export class HonuaCapabilityNotSupportedError extends HonuaSdkError {
  public readonly capability: string;
  public readonly protocol: string;
  public readonly sourceId: string | undefined;

  public constructor(capability: string, protocol: string, sourceId?: string, options: HonuaErrorOptions = {}) {
    const message = sourceId
      ? `Capability "${capability}" is not supported by protocol "${protocol}" on source "${sourceId}"`
      : `Capability "${capability}" is not supported by protocol "${protocol}"`;
    super("core.capability-not-supported", message, {
      ...options,
      context: mergeHonuaErrorContext(options.context, { capability, protocol, sourceId }),
    });
    this.name = "HonuaCapabilityNotSupportedError";
    this.capability = capability;
    this.protocol = protocol;
    this.sourceId = sourceId;
  }
}

/**
 * Cause codes for {@link HonuaAuthError}. They classify *why* an auth flow
 * could not produce a usable credential so callers can branch without parsing
 * message strings:
 *
 * - `interaction_required` — no cached credential and no way to obtain one
 *   silently (no refresh token, or the refresh token is gone). The app must
 *   start an interactive sign-in (`oauth2(...).signIn()`).
 * - `refresh_failed` — a silent refresh attempt failed for a transient reason
 *   (network/5xx/timeout at the token endpoint). Retrying later may succeed.
 * - `invalid_grant` — the authorization server rejected the grant
 *   (`error: "invalid_grant"`): the refresh token or authorization code is
 *   expired/revoked/invalid. The stored credential is cleared and interactive
 *   sign-in is required.
 */
export type HonuaAuthErrorCode = "interaction_required" | "refresh_failed" | "invalid_grant";

/**
 * Thrown by the auth providers (`oauth2`, `clientCredentials`, …) when a
 * credential cannot be produced. Branch on `.code` (see {@link HonuaAuthErrorCode})
 * to decide whether to start interactive sign-in, retry the refresh later, or
 * surface the failure to the user. The underlying transport/parse failure, when
 * present, is preserved on `.cause`.
 *
 * @see [`docs/errors.md`](../../docs/errors.md)
 */
export class HonuaAuthError extends HonuaSdkError {
  public override readonly cause: unknown;

  public constructor(
    public readonly code: HonuaAuthErrorCode,
    message: string,
    options: HonuaErrorOptions = {},
  ) {
    super(AUTH_ERROR_CODES[code], message, options);
    this.name = "HonuaAuthError";
    this.cause = options.cause;
  }
}

/**
 * Thrown when an `ExplorationContext` operation is invalid — for example,
 * dispatching an intent against a context that has been disposed, restoring
 * an incompatible snapshot, or binding a view that requests a slice that is
 * not exposed by the current dataset.
 */
export class HonuaExplorationContextError extends HonuaSdkError {
  public constructor(
    public readonly code: string,
    message: string,
    options: HonuaErrorOptions = {},
  ) {
    super("core.exploration-context", message, {
      ...options,
      context: mergeHonuaErrorContext(options.context, { reason: code }),
    });
    this.name = "HonuaExplorationContextError";
  }
}

/**
 * Thrown when a WFS server replies with an `ows:ExceptionReport`. Carries the
 * structured exception metadata so callers can distinguish capability misses
 * (for example `OperationProcessingFailed`, `InvalidParameterValue`) from
 * transport / timeout failures. The XML payload is consumed by
 * `src/core/wfs-capabilities.ts`; raw access lives behind the `protocol("wfs")`
 * escape hatch.
 */
export class HonuaWfsExceptionError extends HonuaSdkError {
  public readonly exceptionCode: string;
  public readonly locator: string | undefined;

  public constructor(exceptionCode: string, message: string, locator?: string, options: HonuaErrorOptions = {}) {
    const formattedMessage = locator
      ? `WFS ExceptionReport ${exceptionCode} (${locator}): ${message}`
      : `WFS ExceptionReport ${exceptionCode}: ${message}`;
    super("core.wfs-exception", formattedMessage, {
      ...options,
      context: mergeHonuaErrorContext(options.context, { exceptionCode, locator }),
    });
    this.name = "HonuaWfsExceptionError";
    this.exceptionCode = exceptionCode;
    this.locator = locator;
  }
}

/** Any public SDK error participating in the tagged envelope. */
export type HonuaError = HonuaSdkError;

/** Type guard that narrows any value to one of the Honua SDK error types. */
export function isHonuaError(error: unknown): error is HonuaError {
  return isHonuaSdkError(error);
}

const HTTP_RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const GRPC_RETRYABLE_CODES = new Set([4, 8, 10, 14]);
const AUTH_ERROR_CODES = {
  interaction_required: "core.auth.interaction-required",
  refresh_failed: "core.auth.refresh-failed",
  invalid_grant: "core.auth.invalid-grant",
} as const satisfies Record<HonuaAuthErrorCode, `core.auth.${string}`>;

function httpFailureReceipt(
  statusCode: number,
  body: unknown,
  options: HonuaHttpErrorOptions,
): HonuaTerminalFailureReceipt {
  const root = isObject(body) ? body : undefined;
  const protocolError = root && isObject(root.error) ? root.error : undefined;
  const source = protocolError ?? root;
  const protocolCode = options.protocolCode ?? scalarCode(protocolError?.code);
  const classificationCode = typeof protocolCode === "number" ? protocolCode : statusCode;
  const metadata = metadataRecord(options.responseHeaders);
  const bodyKind = stringValue(source?.kind);
  const kind = isFailureKind(bodyKind) ? bodyKind : failureKindForHttp(classificationCode, statusCode);
  const code =
    stringValue(source?.machineCode) ?? stringValue(source?.code) ?? stringValue(root?.code) ?? defaultCode(kind);
  const explicitRetryable = booleanValue(source?.retryable) ?? booleanValue(root?.retryable);
  const retryAfterSeconds = numberValue(source?.retryAfterSeconds) ?? numberValue(root?.retryAfterSeconds);
  const headerDelay = parseRetryAfter(metadataGetter(options.responseHeaders));
  const correlationId =
    stringValue(source?.correlationId) ??
    stringValue(root?.correlationId) ??
    firstMetadata(metadata, "x-correlation-id", "honua-request-id", "x-request-id", "honua-correlation-id");
  const fieldErrors = parseFieldFailures(source?.errors ?? root?.errors);
  return freezeReceipt({
    transportStatus: options.transportStatus ?? statusCode,
    ...(protocolCode !== undefined ? { protocolCode } : {}),
    kind,
    ...(code ? { code } : {}),
    retryable:
      explicitRetryable ??
      (HTTP_RETRYABLE_STATUSES.has(classificationCode) ||
        HTTP_RETRYABLE_STATUSES.has(options.transportStatus ?? statusCode)),
    ...(retryAfterSeconds !== undefined
      ? { retryAfterMs: Math.max(0, retryAfterSeconds * 1_000) }
      : headerDelay !== undefined
        ? { retryAfterMs: headerDelay }
        : {}),
    ...(correlationId ? { correlationId } : {}),
    fieldErrors,
    protocolMetadata: { initial: metadata, trailing: emptyMetadata() },
  });
}

function grpcFailureReceipt(
  code: number,
  details: unknown,
  options: HonuaGrpcErrorOptions,
): HonuaTerminalFailureReceipt {
  const initial = metadataRecord(options.initialMetadata);
  const trailing = metadataRecord(options.trailingMetadata);
  const declaredMachineCode = firstMetadata(trailing, "honua-error-code") ?? firstMetadata(initial, "honua-error-code");
  const declaredKind = firstMetadata(trailing, "honua-error-kind") ?? firstMetadata(initial, "honua-error-kind");
  const kind = isFailureKind(declaredKind) ? declaredKind : failureKindForGrpc(code);
  const machineCode = declaredMachineCode ?? defaultCode(kind);
  const declaredRetryable =
    firstMetadata(trailing, "honua-retryable", "honua-error-retryable") ??
    firstMetadata(initial, "honua-retryable", "honua-error-retryable");
  const retryAfterMs = parseRetryAfter(metadataGetterFromRecords(trailing, initial));
  const correlationId =
    firstMetadata(trailing, "x-correlation-id", "honua-request-id", "x-request-id", "honua-correlation-id") ??
    firstMetadata(initial, "x-correlation-id", "honua-request-id", "x-request-id", "honua-correlation-id");
  const encodedErrors = firstMetadata(trailing, "honua-error-details") ?? firstMetadata(initial, "honua-error-details");
  return freezeReceipt({
    protocolCode: code,
    kind,
    code: machineCode,
    retryable: parseBoolean(declaredRetryable) ?? GRPC_RETRYABLE_CODES.has(code),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(correlationId ? { correlationId } : {}),
    fieldErrors: parseEncodedFieldFailures(encodedErrors, details),
    protocolMetadata: { initial, trailing },
  });
}

function failureKindForHttp(code: number, transportStatus: number): HonuaFailureKind {
  if (code === 401 || code === 498 || code === 499) return "authentication";
  if (code === 403) return "authorization";
  if (code === 404) return "not-found";
  if (code === 400 || code === 422) return "validation";
  if (code === 409 || code === 412 || code === 428) return "conflict";
  if (code === 429) return "throttled";
  if (HTTP_RETRYABLE_STATUSES.has(code) || transportStatus >= 500) return "unavailable";
  return "unknown";
}

function failureKindForGrpc(code: number): HonuaFailureKind {
  if (code === 16) return "authentication";
  if (code === 7) return "authorization";
  if (code === 5) return "not-found";
  if (code === 3) return "validation";
  if (code === 10 || code === 6) return "conflict";
  if (code === 8) return "throttled";
  if (GRPC_RETRYABLE_CODES.has(code)) return "unavailable";
  return "unknown";
}

function defaultCode(kind: HonuaFailureKind): string {
  return {
    authentication: "authentication_required",
    authorization: "permission_denied",
    "not-found": "resource_not_found",
    validation: "validation_failed",
    conflict: "resource_conflict",
    throttled: "rate_limit_exceeded",
    unavailable: "service_unavailable",
    unknown: "unknown_failure",
  }[kind];
}

function metadataRecord(value: unknown): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, readonly string[]> = Object.create(null);
  const add = (key: string, item: unknown) => {
    const normalized = key.toLowerCase();
    if (SENSITIVE_METADATA_KEYS.has(normalized)) return;
    const values = Array.isArray(item)
      ? item.filter((entry): entry is string => typeof entry === "string")
      : [String(item)];
    if (values.length > 0) result[normalized] = Object.freeze(values.slice(0, 20));
  };
  if (value && typeof (value as { entries?: unknown }).entries === "function") {
    for (const [key, item] of (value as { entries(): IterableIterator<[string, string]> }).entries()) add(key, item);
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) add(key, item);
  }
  return Object.freeze(result);
}

function metadataGetter(value: HonuaHttpErrorOptions["responseHeaders"]): Pick<Headers, "get"> {
  if (value && typeof (value as { get?: unknown }).get === "function") return value as Pick<Headers, "get">;
  return metadataGetterFromRecords(metadataRecord(value));
}

function metadataGetterFromRecords(
  ...records: readonly Readonly<Record<string, readonly string[]>>[]
): Pick<Headers, "get"> {
  return {
    get(name: string) {
      for (const record of records) {
        const value = firstMetadata(record, name);
        if (value) return value;
      }
      return null;
    },
  };
}

function firstMetadata(
  record: Readonly<Record<string, readonly string[]>>,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key.toLowerCase()]?.[0];
    if (value) return value;
  }
  return undefined;
}

function parseRetryAfter(headers: Pick<Headers, "get">): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const target = Date.parse(value);
  return Number.isFinite(target) ? Math.max(0, target - Date.now()) : undefined;
}

function parseEncodedFieldFailures(encoded: string | undefined, details: unknown): readonly HonuaFieldFailure[] {
  if (encoded) {
    try {
      return parseFieldFailures(JSON.parse(encoded) as unknown);
    } catch {
      return [];
    }
  }
  return parseFieldFailures(details);
}

function parseFieldFailures(value: unknown): readonly HonuaFieldFailure[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.filter(isObject).map((item) => {
      const code = stringValue(item.code);
      const severity = stringValue(item.severity);
      const path = stringValue(item.path);
      const fieldId = stringValue(item.fieldId);
      const itemIndex = numberValue(item.itemIndex);
      const message = stringValue(item.message);
      return Object.freeze({
        ...(code ? { code } : {}),
        ...(severity ? { severity } : {}),
        ...(path ? { path } : {}),
        ...(fieldId ? { fieldId } : {}),
        ...(itemIndex !== undefined ? { itemIndex } : {}),
        ...(message ? { message } : {}),
      });
    }),
  );
}

function freezeReceipt(receipt: HonuaTerminalFailureReceipt): HonuaTerminalFailureReceipt {
  return Object.freeze({
    ...receipt,
    fieldErrors: Object.freeze([...receipt.fieldErrors]),
    protocolMetadata: Object.freeze({
      initial: receipt.protocolMetadata.initial,
      trailing: receipt.protocolMetadata.trailing,
    }),
  });
}

function emptyMetadata(): Readonly<Record<string, readonly string[]>> {
  return Object.freeze(Object.create(null) as Record<string, readonly string[]>);
}

function scalarCode(value: unknown): number | string | undefined {
  return typeof value === "number" || typeof value === "string" ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isFailureKind(value: string | undefined): value is HonuaFailureKind {
  return value !== undefined && FAILURE_KINDS.has(value as HonuaFailureKind);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FAILURE_KINDS = new Set<HonuaFailureKind>([
  "authentication",
  "authorization",
  "not-found",
  "validation",
  "conflict",
  "throttled",
  "unavailable",
  "unknown",
]);
const SENSITIVE_METADATA_KEYS = new Set(["authorization", "cookie", "set-cookie", "x-api-key"]);
