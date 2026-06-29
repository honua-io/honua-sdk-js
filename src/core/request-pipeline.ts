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
export const DEFAULT_RETRY_METHODS: ReadonlySet<QueryMethod> = new Set(["GET", "PUT", "DELETE"]);

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

export function parseRetryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
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
export function toHttpError(statusCode: number, body: unknown): HonuaHttpError {
  const fallback = "Request failed";
  if (isObject(body)) {
    const error = body.error;
    if (isObject(error) && typeof error.message === "string") {
      return new HonuaHttpError(statusCode, error.message, body);
    }
    if (typeof body.message === "string") {
      return new HonuaHttpError(statusCode, body.message, body);
    }
    if (typeof body.detail === "string") {
      return new HonuaHttpError(statusCode, body.detail, body);
    }
  }

  return new HonuaHttpError(statusCode, fallback, body);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
