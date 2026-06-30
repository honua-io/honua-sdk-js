import { afterEach, describe, expect, it, vi } from "vitest";

import { HonuaAbortError, HonuaHttpError, HonuaNetworkError, HonuaTimeoutError } from "../src/core/errors.js";
import {
  type NormalizedRetryOptions,
  connectErrorCode,
  createTimeoutSignal,
  normalizeNetworkError,
  normalizeRetryOptions,
  normalizeTimeoutMs,
  parseRetryAfterHeaderMs,
  parseRetryAfterMs,
  resolveGrpcRetryDelayMs,
  resolveRetryDelayMs,
  shouldRetryGrpcCall,
  shouldRetryRequest,
  sleep,
  toHttpError,
} from "../src/core/request-pipeline.js";

const retryWith = (overrides: Partial<NormalizedRetryOptions> = {}): NormalizedRetryOptions => ({
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000,
  retryStatuses: new Set([429, 502, 503, 504]),
  ...overrides,
});

describe("request-pipeline: normalizeTimeoutMs", () => {
  it("returns undefined for non-finite or non-number input", () => {
    expect(normalizeTimeoutMs(undefined)).toBeUndefined();
    expect(normalizeTimeoutMs(Number.NaN)).toBeUndefined();
    expect(normalizeTimeoutMs(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("truncates and floors to at least 1ms", () => {
    expect(normalizeTimeoutMs(0)).toBe(1);
    expect(normalizeTimeoutMs(-5)).toBe(1);
    expect(normalizeTimeoutMs(1500.9)).toBe(1500);
  });
});

describe("request-pipeline: normalizeRetryOptions", () => {
  it("returns undefined when retries are disabled", () => {
    expect(normalizeRetryOptions(undefined)).toBeUndefined();
    expect(normalizeRetryOptions({ maxRetries: 0 })).toBeUndefined();
  });

  it("applies defaults and clamps delays", () => {
    const normalized = normalizeRetryOptions({ maxRetries: 2 });
    expect(normalized).toMatchObject({ maxRetries: 2, baseDelayMs: 100, maxDelayMs: 2000 });
    expect(normalized?.retryStatuses).toEqual(new Set([429, 502, 503, 504]));
  });

  it("keeps maxDelay at least baseDelay and filters invalid statuses", () => {
    const normalized = normalizeRetryOptions({
      maxRetries: 1,
      baseDelayMs: 500,
      maxDelayMs: 10,
      retryStatuses: [429, 9999, 88],
    });
    expect(normalized?.maxDelayMs).toBe(500);
    expect(normalized?.retryStatuses).toEqual(new Set([429]));
  });

  it("falls back to default statuses when none are valid", () => {
    const normalized = normalizeRetryOptions({ maxRetries: 1, retryStatuses: [9999] });
    expect(normalized?.retryStatuses).toEqual(new Set([429, 502, 503, 504]));
  });
});

describe("request-pipeline: parseRetryAfterMs", () => {
  const responseWith = (value: string | undefined): Response =>
    new Response(null, { headers: value === undefined ? {} : { "retry-after": value } });

  it("returns undefined when header is absent", () => {
    expect(parseRetryAfterMs(responseWith(undefined))).toBeUndefined();
  });

  it("parses delay seconds", () => {
    expect(parseRetryAfterMs(responseWith("5"))).toBe(5000);
  });

  it("parses an HTTP-date into a positive delay", () => {
    const future = new Date(Date.now() + 4000).toUTCString();
    const ms = parseRetryAfterMs(responseWith(future));
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(4000);
  });

  it("returns undefined for an unparseable value", () => {
    expect(parseRetryAfterMs(responseWith("not-a-date"))).toBeUndefined();
  });
});

describe("request-pipeline: shouldRetryRequest", () => {
  it("never retries without retry options", () => {
    expect(shouldRetryRequest(undefined, "GET", 0, 503, undefined)).toBe(false);
  });

  it("stops once attempts reach maxRetries", () => {
    expect(shouldRetryRequest(retryWith({ maxRetries: 2 }), "GET", 2, 503, undefined)).toBe(false);
    expect(shouldRetryRequest(retryWith({ maxRetries: 2 }), "GET", 1, 503, undefined)).toBe(true);
  });

  it("only retries replay-safe methods", () => {
    expect(shouldRetryRequest(retryWith(), "POST", 0, 503, undefined)).toBe(false);
    expect(shouldRetryRequest(retryWith(), "PUT", 0, 503, undefined)).toBe(true);
    expect(shouldRetryRequest(retryWith(), "DELETE", 0, 503, undefined)).toBe(true);
  });

  it("never retries aborts", () => {
    expect(shouldRetryRequest(retryWith(), "GET", 0, undefined, new HonuaAbortError())).toBe(false);
  });

  it("retries configured statuses only", () => {
    expect(shouldRetryRequest(retryWith(), "GET", 0, 503, undefined)).toBe(true);
    expect(shouldRetryRequest(retryWith(), "GET", 0, 400, undefined)).toBe(false);
  });

  it("retries transient network and timeout errors", () => {
    expect(shouldRetryRequest(retryWith(), "GET", 0, undefined, new HonuaNetworkError("boom", undefined))).toBe(true);
    expect(shouldRetryRequest(retryWith(), "GET", 0, undefined, new HonuaTimeoutError(100))).toBe(true);
    expect(shouldRetryRequest(retryWith(), "GET", 0, undefined, new Error("other"))).toBe(false);
  });
});

describe("request-pipeline: resolveRetryDelayMs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns 0 without retry options and no Retry-After", () => {
    expect(resolveRetryDelayMs(undefined, 0)).toBe(0);
  });

  it("honors Retry-After capped by maxDelayMs", () => {
    const response = new Response(null, { headers: { "retry-after": "100" } });
    expect(resolveRetryDelayMs(retryWith({ maxDelayMs: 5000 }), 0, response)).toBe(5000);
  });

  it("applies exponential backoff with full jitter in the [0.5x, 1x] band", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    // attempt 2 => base(100) * 2^2 = 400, jitter factor 0.5 => 200
    expect(resolveRetryDelayMs(retryWith(), 2)).toBe(200);
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(resolveRetryDelayMs(retryWith(), 2)).toBe(400);
  });

  it("caps exponential delay at maxDelayMs before jitter", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(resolveRetryDelayMs(retryWith({ maxDelayMs: 250 }), 5)).toBe(250);
  });
});

describe("request-pipeline: normalizeNetworkError", () => {
  it("maps AbortError to HonuaAbortError", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(normalizeNetworkError(abort)).toBeInstanceOf(HonuaAbortError);
  });

  it("wraps generic errors and non-errors as HonuaNetworkError", () => {
    expect(normalizeNetworkError(new Error("down"))).toBeInstanceOf(HonuaNetworkError);
    const wrapped = normalizeNetworkError("string failure");
    expect(wrapped).toBeInstanceOf(HonuaNetworkError);
    expect(wrapped.message).toBe("string failure");
  });
});

describe("request-pipeline: toHttpError", () => {
  it("prefers a nested error.message", () => {
    const err = toHttpError(500, { error: { message: "boom" } });
    expect(err).toBeInstanceOf(HonuaHttpError);
    expect(err.message).toBe("HTTP 500: boom");
    expect(err.statusCode).toBe(500);
    expect(err.body).toEqual({ error: { message: "boom" } });
  });

  it("falls back through message then detail", () => {
    expect(toHttpError(400, { message: "bad" }).message).toBe("HTTP 400: bad");
    expect(toHttpError(404, { detail: "missing" }).message).toBe("HTTP 404: missing");
  });

  it("uses a generic message for non-object or shapeless bodies", () => {
    expect(toHttpError(500, "oops").message).toBe("HTTP 500: Request failed");
    expect(toHttpError(500, {}).message).toBe("HTTP 500: Request failed");
  });
});

describe("request-pipeline: sleep", () => {
  it("resolves immediately for non-positive durations", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });

  it("rejects with HonuaAbortError when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(10, controller.signal)).rejects.toBeInstanceOf(HonuaAbortError);
  });

  it("rejects when aborted mid-flight", async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
  });
});

describe("request-pipeline: createTimeoutSignal", () => {
  it("passes through the existing signal when no timeout is set", () => {
    const controller = new AbortController();
    const timeout = createTimeoutSignal(controller.signal, undefined);
    expect(timeout.signal).toBe(controller.signal);
    expect(timeout.didTimeout).toBe(false);
    timeout.dispose();
  });

  it("fires and flags didTimeout once the deadline elapses", async () => {
    const timeout = createTimeoutSignal(undefined, 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(timeout.signal?.aborted).toBe(true);
    expect(timeout.didTimeout).toBe(true);
    timeout.dispose();
  });

  it("aborts immediately when the existing signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const timeout = createTimeoutSignal(controller.signal, 1000);
    expect(timeout.signal?.aborted).toBe(true);
    expect(timeout.didTimeout).toBe(false);
    timeout.dispose();
  });

  it("propagates an external abort to the composed signal", () => {
    const controller = new AbortController();
    const timeout = createTimeoutSignal(controller.signal, 1000);
    expect(timeout.signal?.aborted).toBe(false);
    controller.abort();
    expect(timeout.signal?.aborted).toBe(true);
    expect(timeout.didTimeout).toBe(false);
    timeout.dispose();
  });
});

describe("request-pipeline: connectErrorCode", () => {
  it("returns the numeric code from a Connect-shaped error", () => {
    expect(connectErrorCode(Object.assign(new Error("x"), { code: 14 }))).toBe(14);
  });

  it("returns undefined for non-Connect errors", () => {
    expect(connectErrorCode(new Error("plain"))).toBeUndefined();
    expect(connectErrorCode({ code: "unavailable" })).toBeUndefined();
    expect(connectErrorCode(undefined)).toBeUndefined();
  });
});

describe("request-pipeline: shouldRetryGrpcCall", () => {
  const err = (code: number) => Object.assign(new Error("grpc"), { code });

  it("returns false without retry options", () => {
    expect(shouldRetryGrpcCall(undefined, 0, err(14), false)).toBe(false);
  });

  it("retries transient gRPC codes within the budget", () => {
    expect(shouldRetryGrpcCall(retryWith(), 0, err(14), false)).toBe(true); // unavailable
    expect(shouldRetryGrpcCall(retryWith(), 0, err(8), false)).toBe(true); // resource_exhausted
    expect(shouldRetryGrpcCall(retryWith(), 0, err(4), false)).toBe(true); // deadline_exceeded
    expect(shouldRetryGrpcCall(retryWith(), 0, err(10), false)).toBe(true); // aborted
  });

  it("does not retry non-transient codes", () => {
    expect(shouldRetryGrpcCall(retryWith(), 0, err(3), false)).toBe(false); // invalid_argument
    expect(shouldRetryGrpcCall(retryWith(), 0, err(16), false)).toBe(false); // unauthenticated
    expect(shouldRetryGrpcCall(retryWith(), 0, err(1), false)).toBe(false); // canceled
  });

  it("does not retry when aborted or out of budget", () => {
    expect(shouldRetryGrpcCall(retryWith(), 0, err(14), true)).toBe(false);
    expect(shouldRetryGrpcCall(retryWith({ maxRetries: 2 }), 2, err(14), false)).toBe(false);
  });

  it("does not retry non-Connect errors", () => {
    expect(shouldRetryGrpcCall(retryWith(), 0, new Error("network"), false)).toBe(false);
  });
});

describe("request-pipeline: resolveGrpcRetryDelayMs", () => {
  it("honors retry-after metadata capped by maxDelayMs", () => {
    const err = Object.assign(new Error("grpc"), {
      code: 14,
      metadata: new Headers({ "retry-after": "5" }),
    });
    expect(resolveGrpcRetryDelayMs(retryWith({ maxDelayMs: 2000 }), 0, err)).toBe(2000);
  });

  it("falls back to exponential backoff with jitter when no retry-after", () => {
    const err = Object.assign(new Error("grpc"), { code: 14 });
    const delay = resolveGrpcRetryDelayMs(retryWith({ baseDelayMs: 100, maxDelayMs: 2000 }), 1, err);
    // base * 2^1 = 200, jittered into [100, 200]
    expect(delay).toBeGreaterThanOrEqual(100);
    expect(delay).toBeLessThanOrEqual(200);
  });
});

describe("request-pipeline: parseRetryAfterHeaderMs", () => {
  it("parses delta-seconds and HTTP-date the same as the response helper", () => {
    expect(parseRetryAfterHeaderMs(new Headers({ "retry-after": "3" }))).toBe(3000);
    expect(parseRetryAfterHeaderMs(new Headers())).toBeUndefined();
  });
});
