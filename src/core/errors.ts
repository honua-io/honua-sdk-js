/**
 * Honua SDK error hierarchy. Every error thrown by `@honua/sdk-js` is an
 * instance of one of the classes in this file plus the runtime-type guard
 * `isHonuaError(error)`. See [`docs/errors.md`](../../docs/errors.md) for the
 * full reference table including recovery hints and the retry-policy mapping.
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

import { HonuaJobFailedError } from "./ogc-processes.js";
import { HonuaWmsCapabilitiesParseError } from "./wms-capabilities.js";
import { HonuaWmtsCapabilitiesParseError } from "./wmts-capabilities.js";

/**
 * Thrown when the server returns a non-2xx HTTP status. Branch on
 * `.statusCode` to decide recovery: refresh credentials on 401/403, respect
 * `Retry-After` on 429, back off on 5xx, etc.
 *
 * @see [`docs/errors.md`](../../docs/errors.md)
 */
export class HonuaHttpError extends Error {
  public readonly statusCode: number;
  public readonly body: unknown;

  public constructor(statusCode: number, message: string, body: unknown) {
    super(`HTTP ${statusCode}: ${message}`);
    this.name = "HonuaHttpError";
    this.statusCode = statusCode;
    this.body = body;
  }
}

/** Thrown when a request exceeds the configured timeout. */
export class HonuaTimeoutError extends Error {
  public readonly timeoutMs: number;

  public constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "HonuaTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Thrown when a network-level failure occurs (DNS, connection refused, etc.). */
export class HonuaNetworkError extends Error {
  public override readonly cause: unknown;

  public constructor(message: string, cause: unknown) {
    super(message);
    this.name = "HonuaNetworkError";
    this.cause = cause;
  }
}

/** Thrown when a request is aborted via a caller-provided AbortSignal. */
export class HonuaAbortError extends Error {
  public constructor(message = "Request was aborted") {
    super(message);
    this.name = "HonuaAbortError";
  }
}

/** Thrown when a gRPC-Web request fails, wrapping the underlying ConnectError. */
export class HonuaGrpcError extends Error {
  public readonly code: number;
  public readonly details: unknown;

  public constructor(code: number, message: string, details?: unknown) {
    super(message);
    this.name = "HonuaGrpcError";
    this.code = code;
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
export class HonuaCapabilityNotSupportedError extends Error {
  public readonly capability: string;
  public readonly protocol: string;
  public readonly sourceId: string | undefined;

  public constructor(capability: string, protocol: string, sourceId?: string) {
    super(
      sourceId
        ? `Capability "${capability}" is not supported by protocol "${protocol}" on source "${sourceId}"`
        : `Capability "${capability}" is not supported by protocol "${protocol}"`,
    );
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
export class HonuaAuthError extends Error {
  public readonly code: HonuaAuthErrorCode;
  public override readonly cause: unknown;

  public constructor(code: HonuaAuthErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = "HonuaAuthError";
    this.code = code;
    this.cause = options.cause;
  }
}

/**
 * Thrown when an `ExplorationContext` operation is invalid — for example,
 * dispatching an intent against a context that has been disposed, restoring
 * an incompatible snapshot, or binding a view that requests a slice that is
 * not exposed by the current dataset.
 */
export class HonuaExplorationContextError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "HonuaExplorationContextError";
    this.code = code;
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
export class HonuaWfsExceptionError extends Error {
  public readonly exceptionCode: string;
  public readonly locator: string | undefined;

  public constructor(exceptionCode: string, message: string, locator?: string) {
    super(
      locator
        ? `WFS ExceptionReport ${exceptionCode} (${locator}): ${message}`
        : `WFS ExceptionReport ${exceptionCode}: ${message}`,
    );
    this.name = "HonuaWfsExceptionError";
    this.exceptionCode = exceptionCode;
    this.locator = locator;
  }
}

/** All Honua SDK error types that can be discriminated with `instanceof`. */
export type HonuaError =
  | HonuaHttpError
  | HonuaTimeoutError
  | HonuaNetworkError
  | HonuaAbortError
  | HonuaGrpcError
  | HonuaAuthError
  | HonuaCapabilityNotSupportedError
  | HonuaExplorationContextError
  | HonuaWfsExceptionError
  | HonuaJobFailedError
  | HonuaWmsCapabilitiesParseError
  | HonuaWmtsCapabilitiesParseError;

/** Type guard that narrows any value to one of the Honua SDK error types. */
export function isHonuaError(error: unknown): error is HonuaError {
  return (
    error instanceof HonuaHttpError ||
    error instanceof HonuaTimeoutError ||
    error instanceof HonuaNetworkError ||
    error instanceof HonuaAbortError ||
    error instanceof HonuaGrpcError ||
    error instanceof HonuaAuthError ||
    error instanceof HonuaCapabilityNotSupportedError ||
    error instanceof HonuaExplorationContextError ||
    error instanceof HonuaWfsExceptionError ||
    error instanceof HonuaJobFailedError ||
    error instanceof HonuaWmsCapabilitiesParseError ||
    error instanceof HonuaWmtsCapabilitiesParseError
  );
}
