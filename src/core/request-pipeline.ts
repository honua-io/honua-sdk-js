import { HonuaAbortError, HonuaHttpError, HonuaNetworkError, HonuaTimeoutError } from "./errors.js";
import type { HonuaRetryOptions, QueryMethod } from "./types.js";

/**
 * Stateless primitives shared by the {@link HonuaClient} request pipeline.
 *
 * These functions own the retry/backoff math, network-error normalization,
 * timeout-signal composition, and HTTP-error envelope mapping. Extracting them
 * from the client keeps the single shared `executeRequest` attempt loop small
 * and lets the retry/error semantics be unit-tested in isolation.
 */

export interface NormalizedRetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryStatuses: ReadonlySet<number>;
}

export const DEFAULT_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);
export const DEFAULT_RETRY_METHODS: ReadonlySet<QueryMethod> = new Set(["GET", "HEAD", "PUT", "DELETE"]);

export function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) {
    return undefined;
  }
  return Math.max(1, Math.trunc(timeoutMs));
}

export function normalizeRetryOptions(options: HonuaRetryOptions | undefined): NormalizedRetryOptions | undefined {
  if (!options) {
    return undefined;
  }

  const maxRetries =
    typeof options.maxRetries === "number" && Number.isFinite(options.maxRetries)
      ? Math.max(0, Math.trunc(options.maxRetries))
      : 0;
  if (maxRetries < 1) {
    return undefined;
  }

  const baseDelayMs =
    typeof options.baseDelayMs === "number" && Number.isFinite(options.baseDelayMs)
      ? Math.max(1, Math.trunc(options.baseDelayMs))
      : 100;
  const maxDelayMs =
    typeof options.maxDelayMs === "number" && Number.isFinite(options.maxDelayMs)
      ? Math.max(baseDelayMs, Math.trunc(options.maxDelayMs))
      : 2_000;
  const retryStatuses = new Set<number>(
    (options.retryStatuses ?? Array.from(DEFAULT_RETRY_STATUSES))
      .map((status) => Math.trunc(status))
      .filter((status) => Number.isFinite(status) && status >= 100 && status <= 599),
  );
  if (retryStatuses.size === 0) {
    for (const status of DEFAULT_RETRY_STATUSES) {
      retryStatuses.add(status);
    }
  }

  return {
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    retryStatuses,
  };
}

/**
 * Parse a `Retry-After` header value (delta-seconds or HTTP-date) into a delay
 * in milliseconds. Shared by the REST {@link parseRetryAfterMs} response helper
 * and the gRPC-web path, which reads the same header off the Connect error
 * metadata (a `Headers`-shaped object) rather than a `Response`.
 */
export function parseRetryAfterHeaderMs(headers: Pick<Headers, "get">): number | undefined {
  const value = headers.get("retry-after");
  if (!value) {
    return undefined;
  }

  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const targetTime = Date.parse(value);
  if (!Number.isFinite(targetTime)) {
    return undefined;
  }
  return Math.max(0, targetTime - Date.now());
}

export function parseRetryAfterMs(response: Response): number | undefined {
  return parseRetryAfterHeaderMs(response.headers);
}

/**
 * Decide whether a failed attempt should be retried. Idempotent/replay-safe
 * methods (GET/PUT/DELETE) are retried on the configured retry statuses or on
 * transient network/timeout errors; aborts are never retried.
 */
export function shouldRetryRequest(
  retryOptions: NormalizedRetryOptions | undefined,
  method: QueryMethod,
  attempt: number,
  statusCode: number | undefined,
  error: unknown,
): boolean {
  if (!retryOptions || attempt >= retryOptions.maxRetries) {
    return false;
  }

  if (!DEFAULT_RETRY_METHODS.has(method)) {
    return false;
  }

  if (error instanceof HonuaAbortError) {
    return false;
  }

  if (statusCode !== undefined) {
    return retryOptions.retryStatuses.has(statusCode);
  }

  return error instanceof HonuaNetworkError || error instanceof HonuaTimeoutError;
}

/**
 * Resolve the backoff delay before the next attempt. A server `Retry-After`
 * header (capped by `maxDelayMs`) wins; otherwise an exponential backoff with
 * full jitter in the [0.5x, 1x] band is used.
 */
export function resolveRetryDelayMs(
  retryOptions: NormalizedRetryOptions | undefined,
  attempt: number,
  response?: Response,
): number {
  const retryAfterMs = response ? parseRetryAfterMs(response) : undefined;
  if (retryAfterMs !== undefined) {
    return Math.min(retryOptions?.maxDelayMs ?? retryAfterMs, retryAfterMs);
  }
  if (!retryOptions) {
    return 0;
  }
  const exponentialDelay = retryOptions.baseDelayMs * 2 ** attempt;
  const cappedDelay = Math.min(retryOptions.maxDelayMs, exponentialDelay);
  return cappedDelay * (0.5 + Math.random() * 0.5);
}

/**
 * gRPC/Connect numeric status codes that map to the transient REST retry
 * statuses in {@link DEFAULT_RETRY_STATUSES}, so the grpc-web transport retries
 * the same class of transient failures as REST. Mirrors the gRPC retry
 * conventions: `resource_exhausted` (~429), `unavailable` (~502/503),
 * `deadline_exceeded` (~504), and the transient `aborted` concurrency code.
 */
export const DEFAULT_RETRYABLE_GRPC_CODES: ReadonlySet<number> = new Set([
  4, // deadline_exceeded
  8, // resource_exhausted
  10, // aborted
  14, // unavailable
]);

/** Connect/gRPC `canceled` code — caller/abort-driven, never retried. */
const GRPC_CODE_CANCELED = 1;

/**
 * Extract the numeric gRPC/Connect status code off a thrown error (a
 * `ConnectError` carries a numeric `code`). Returns `undefined` for non-Connect
 * errors so callers can treat them as non-retryable.
 */
export function connectErrorCode(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "number"
  ) {
    return (error as { code: number }).code;
  }
  return undefined;
}

/**
 * Decide whether a failed gRPC-web call should be retried. Mirrors
 * {@link shouldRetryRequest} for the Connect transport: retries only the
 * transient {@link DEFAULT_RETRYABLE_GRPC_CODES} while honoring `maxRetries`,
 * and never retries once the call's abort signal has fired (caller abort or the
 * `timeoutMs` deadline) or for the `canceled` code.
 *
 * Replay-safety (unary-only, since server-streaming responses cannot be safely
 * replayed mid-iteration) is enforced by the caller, mirroring the REST
 * {@link DEFAULT_RETRY_METHODS} idempotency gate.
 */
export function shouldRetryGrpcCall(
  retryOptions: NormalizedRetryOptions | undefined,
  attempt: number,
  error: unknown,
  aborted: boolean,
): boolean {
  if (!retryOptions || attempt >= retryOptions.maxRetries) {
    return false;
  }
  if (aborted) {
    return false;
  }
  const code = connectErrorCode(error);
  if (code === undefined || code === GRPC_CODE_CANCELED) {
    return false;
  }
  return DEFAULT_RETRYABLE_GRPC_CODES.has(code);
}

function connectErrorMetadata(error: unknown): Pick<Headers, "get"> | undefined {
  if (typeof error === "object" && error !== null && "metadata" in error) {
    const metadata = (error as { metadata: unknown }).metadata;
    if (metadata && typeof (metadata as { get?: unknown }).get === "function") {
      return metadata as Pick<Headers, "get">;
    }
  }
  return undefined;
}

/**
 * Resolve the backoff delay before the next gRPC-web attempt. Reuses the shared
 * {@link resolveRetryDelayMs} exponential-with-jitter math; a `retry-after`
 * value carried on the Connect error metadata (capped by `maxDelayMs`) wins,
 * mirroring the REST `Retry-After` handling.
 */
export function resolveGrpcRetryDelayMs(
  retryOptions: NormalizedRetryOptions | undefined,
  attempt: number,
  error: unknown,
): number {
  const metadata = connectErrorMetadata(error);
  const retryAfterMs = metadata ? parseRetryAfterHeaderMs(metadata) : undefined;
  if (retryAfterMs !== undefined) {
    return Math.min(retryOptions?.maxDelayMs ?? retryAfterMs, retryAfterMs);
  }
  return resolveRetryDelayMs(retryOptions, attempt);
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw new HonuaAbortError();
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new HonuaAbortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function normalizeNetworkError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") {
    return new HonuaAbortError();
  }
  if (error instanceof Error) {
    return new HonuaNetworkError(error.message, error);
  }
  return new HonuaNetworkError(String(error), error);
}

export interface TimeoutSignal {
  signal: AbortSignal | undefined;
  didTimeout: boolean;
  dispose(): void;
}

export function createTimeoutSignal(
  existingSignal: AbortSignal | null | undefined,
  timeoutMs: number | undefined,
): TimeoutSignal {
  if (timeoutMs === undefined) {
    return {
      signal: existingSignal ?? undefined,
      didTimeout: false,
      dispose: () => undefined,
    };
  }

  const controller = new AbortController();
  let didTimeout = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  if (existingSignal) {
    if (existingSignal.aborted) {
      controller.abort();
    } else {
      onAbort = () => {
        controller.abort();
      };
      existingSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    get didTimeout() {
      return didTimeout;
    },
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (existingSignal && onAbort) {
        existingSignal.removeEventListener("abort", onAbort);
        onAbort = undefined;
      }
    },
  };
}

/**
 * Map a non-OK HTTP response body into a {@link HonuaHttpError}, preferring the
 * server's structured error message (`error.message`, `message`, or `detail`)
 * and falling back to a generic message while preserving the raw body.
 */
export function toHttpError(statusCode: number, body: unknown, responseHeaders?: Headers): HonuaHttpError {
  const options = responseHeaders ? { responseHeaders } : undefined;
  const fallback = "Request failed";
  if (isObject(body)) {
    const error = body.error;
    if (isObject(error) && typeof error.message === "string") {
      return new HonuaHttpError(statusCode, error.message, body, options);
    }
    if (typeof body.message === "string") {
      return new HonuaHttpError(statusCode, body.message, body, options);
    }
    if (typeof body.detail === "string") {
      return new HonuaHttpError(statusCode, body.detail, body, options);
    }
  }

  return new HonuaHttpError(statusCode, fallback, body, options);
}

/** Preserve an HTTP-200 GeoServices error envelope without conflating its code with HTTP status. */
export function toGeoServicesError(
  transportStatus: number,
  body: unknown,
  responseHeaders: Headers,
): HonuaHttpError | undefined {
  if (!isObject(body) || !isObject(body.error)) return undefined;
  const error = body.error;
  const protocolCode = typeof error.code === "number" ? error.code : undefined;
  const message = typeof error.message === "string" ? error.message : "Request failed";
  if (protocolCode === undefined && typeof error.message !== "string") return undefined;
  return new HonuaHttpError(protocolCode ?? transportStatus, message, body, {
    protocolCode,
    transportStatus,
    responseHeaders,
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
