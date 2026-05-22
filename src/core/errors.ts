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
  | HonuaCapabilityNotSupportedError
  | HonuaExplorationContextError
  | HonuaWfsExceptionError
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
    error instanceof HonuaCapabilityNotSupportedError ||
    error instanceof HonuaExplorationContextError ||
    error instanceof HonuaWfsExceptionError ||
    error instanceof HonuaWmsCapabilitiesParseError ||
    error instanceof HonuaWmtsCapabilitiesParseError
  );
}
