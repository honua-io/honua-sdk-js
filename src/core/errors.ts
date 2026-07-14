/**
 * Tagged hierarchy for the migrated Honua SDK error domains. The common
 * `isHonuaError(error)` guard also recognizes migrated query, map, runtime, and
 * realtime subclasses. See [`docs/errors.md`](../../docs/errors.md) for exact
 * coverage, residual domains, recovery hints, and the retryability
 * classification.
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
 *   await dataset.source("parcels")!.queryAll({ where: "1=1" });
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
  HonuaSdkError,
  isHonuaSdkError,
  mergeHonuaErrorContext,
} from "./error-envelope.js";

export type HonuaDiscoveryErrorCode =
  | "ambiguous-protocol"
  | "ambiguous-source"
  | "invalid-endpoint"
  | "invalid-cache-identity"
  | "invalid-discovery-cache"
  | "invalid-capability"
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

  public constructor(statusCode: number, message: string, body: unknown, options: HonuaErrorOptions = {}) {
    super(
      HTTP_RETRYABLE_STATUSES.has(statusCode) ? "core.http.transient" : "core.http.rejected",
      `HTTP ${statusCode}: ${message}`,
      {
        ...options,
        context: mergeHonuaErrorContext(options.context, { statusCode }),
      },
    );
    this.name = "HonuaHttpError";
    this.statusCode = statusCode;
    this.body = body;
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

  public constructor(
    public readonly code: number,
    message: string,
    details?: unknown,
    options: HonuaErrorOptions = {},
  ) {
    super(GRPC_RETRYABLE_CODES.has(code) ? "core.grpc.transient" : "core.grpc.rejected", message, {
      ...options,
      context: mergeHonuaErrorContext(options.context, { grpcCode: code }),
    });
    this.name = "HonuaGrpcError";
    this.details = details;
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
const GRPC_RETRYABLE_CODES = new Set([4, 8, 10, 13, 14]);
const AUTH_ERROR_CODES = {
  interaction_required: "core.auth.interaction-required",
  refresh_failed: "core.auth.refresh-failed",
  invalid_grant: "core.auth.invalid-grant",
} as const satisfies Record<HonuaAuthErrorCode, `core.auth.${string}`>;
