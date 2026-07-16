import {
  HonuaAbortError,
  HonuaDiscoveryError,
  HonuaHttpError,
  HonuaNetworkError,
  HonuaTimeoutError,
} from "./core/errors.js";
import type { StacDiscoveryFetch, StacDiscoveryLimits } from "./stac-discovery-types.js";

export interface ResolvedStacDiscoveryLimits {
  readonly maxDocuments: number;
  readonly maxDepth: number;
  readonly maxLinksPerDocument: number;
  readonly maxAssets: number;
  readonly maxJsonBytes: number;
  readonly maxProbeBytes: number;
  readonly requestTimeoutMs: number;
  readonly maxRedirects: number;
}

export interface StacTransportStatistics {
  requests: number;
  redirects: number;
  bytesRead: number;
  probeBytesRead: number;
}

export interface StacTransportResponse {
  readonly url: string;
  readonly status: number;
  readonly contentType?: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly contentRange?: string;
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

export type StacTransportPurpose = "document" | "probe";

export interface StacDiscoveryTransportOptions {
  readonly fetchFn: StacDiscoveryFetch;
  readonly rootOrigin: string;
  readonly headers?: HeadersInit;
  readonly signal?: AbortSignal;
  readonly limits: ResolvedStacDiscoveryLimits;
  readonly statistics: StacTransportStatistics;
  /** Revalidates every redirect target for its request purpose. */
  readonly assertRedirect: (url: URL, purpose: StacTransportPurpose) => void;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LIMIT_DEFAULTS: ResolvedStacDiscoveryLimits = Object.freeze({
  maxDocuments: 128,
  maxDepth: 12,
  maxLinksPerDocument: 512,
  maxAssets: 1_000,
  maxJsonBytes: 1024 * 1024,
  maxProbeBytes: 64 * 1024,
  requestTimeoutMs: 10_000,
  maxRedirects: 5,
});

const LIMIT_MAXIMA: ResolvedStacDiscoveryLimits = Object.freeze({
  maxDocuments: 1_024,
  maxDepth: 32,
  maxLinksPerDocument: 2_048,
  maxAssets: 10_000,
  maxJsonBytes: 8 * 1024 * 1024,
  maxProbeBytes: 256 * 1024,
  requestTimeoutMs: 60_000,
  maxRedirects: 10,
});

export function normalizeStacDiscoveryLimits(input: StacDiscoveryLimits | undefined): ResolvedStacDiscoveryLimits {
  return Object.freeze({
    maxDocuments: boundedInteger(input?.maxDocuments, "maxDocuments"),
    maxDepth: boundedInteger(input?.maxDepth, "maxDepth", true),
    maxLinksPerDocument: boundedInteger(input?.maxLinksPerDocument, "maxLinksPerDocument"),
    maxAssets: boundedInteger(input?.maxAssets, "maxAssets"),
    maxJsonBytes: boundedInteger(input?.maxJsonBytes, "maxJsonBytes"),
    maxProbeBytes: boundedInteger(input?.maxProbeBytes, "maxProbeBytes"),
    requestTimeoutMs: boundedInteger(input?.requestTimeoutMs, "requestTimeoutMs"),
    maxRedirects: boundedInteger(input?.maxRedirects, "maxRedirects", true),
  });
}

function boundedInteger(value: number | undefined, name: keyof ResolvedStacDiscoveryLimits, allowZero = false): number {
  const normalized = value ?? LIMIT_DEFAULTS[name];
  if (!Number.isSafeInteger(normalized) || normalized < (allowZero ? 0 : 1) || normalized > LIMIT_MAXIMA[name]) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `Static STAC discovery limit ${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer no greater than the SDK ceiling.`,
      { limit: name, maximum: LIMIT_MAXIMA[name] },
    );
  }
  return normalized;
}

export class StacDiscoveryTransport {
  private readonly fetchFn: StacDiscoveryFetch;
  private readonly rootOrigin: string;
  private readonly headers: Headers;
  private readonly signal: AbortSignal | undefined;
  private readonly limits: ResolvedStacDiscoveryLimits;
  private readonly statistics: StacTransportStatistics;
  private readonly assertRedirect: StacDiscoveryTransportOptions["assertRedirect"];

  public constructor(options: StacDiscoveryTransportOptions) {
    this.fetchFn = options.fetchFn;
    this.rootOrigin = options.rootOrigin;
    this.headers = normalizeCallerHeaders(options.headers);
    this.signal = options.signal;
    this.limits = options.limits;
    this.statistics = options.statistics;
    this.assertRedirect = options.assertRedirect;
  }

  public async document(url: string): Promise<StacTransportResponse> {
    return this.request(url, "document", this.limits.maxJsonBytes, undefined, false);
  }

  public async probe(url: string, range: "prefix" | "suffix"): Promise<StacTransportResponse> {
    const maximum = this.limits.maxProbeBytes;
    const rangeHeader = range === "prefix" ? `bytes=0-${maximum - 1}` : `bytes=-${maximum}`;
    return this.request(url, "probe", maximum, rangeHeader, true);
  }

  private async request(
    input: string,
    purpose: StacTransportPurpose,
    maximumBytes: number,
    range: string | undefined,
    truncate: boolean,
  ): Promise<StacTransportResponse> {
    throwIfAborted(this.signal);
    const deadline = requestDeadline(this.signal, this.limits.requestTimeoutMs);
    let current = input;
    try {
      for (let redirects = 0; ; redirects += 1) {
        const currentUrl = new URL(current);
        const headers = headersForOrigin(this.headers, currentUrl.origin === this.rootOrigin);
        headers.set("Accept", purpose === "document" ? "application/geo+json, application/json;q=0.9" : "*/*");
        if (range) {
          headers.set("Range", range);
          headers.set("Accept-Encoding", "identity");
        }
        this.statistics.requests += 1;
        let response: Response;
        try {
          response = await abortable(
            this.fetchFn(current, {
              method: "GET",
              headers,
              redirect: "manual",
              credentials: "omit",
              referrerPolicy: "no-referrer",
              signal: deadline.signal,
            }),
            deadline.signal,
          );
        } catch (cause) {
          if (this.signal?.aborted) throw new HonuaAbortError();
          if (deadline.timedOut()) throw new HonuaTimeoutError(this.limits.requestTimeoutMs);
          if (cause instanceof HonuaAbortError || cause instanceof HonuaTimeoutError) throw cause;
          throw new HonuaNetworkError("Static STAC discovery request failed.", cause);
        }

        if (response.type === "opaqueredirect") {
          throw new HonuaNetworkError("Static STAC discovery refused an opaque redirect.", undefined);
        }
        if (REDIRECT_STATUSES.has(response.status)) {
          if (redirects >= this.limits.maxRedirects) {
            throw new HonuaNetworkError("Static STAC discovery exceeded its redirect limit.", undefined);
          }
          const location = response.headers.get("location");
          let target: URL;
          try {
            if (!location) throw new Error("missing");
            target = new URL(location, current);
          } catch {
            throw new HonuaNetworkError("Static STAC discovery received an invalid redirect.", undefined);
          }
          try {
            this.assertRedirect(target, purpose);
          } catch (cause) {
            throw new HonuaNetworkError("Static STAC discovery refused an unsafe redirect.", cause);
          }
          if (currentUrl.protocol === "https:" && target.protocol !== "https:") {
            throw new HonuaNetworkError("Static STAC discovery refused an HTTPS downgrade redirect.", undefined);
          }
          cancelStream(response.body);
          this.statistics.redirects += 1;
          current = target.toString();
          continue;
        }

        if (!response.ok) {
          cancelStream(response.body);
          throw new HonuaHttpError(response.status, "Static STAC discovery request failed.", {});
        }
        const contentLength = parseContentLength(response.headers.get("content-length"));
        if (!truncate && contentLength !== undefined && contentLength > maximumBytes) {
          cancelStream(response.body);
          throw new HonuaDiscoveryError(
            "invalid-endpoint",
            "Static STAC JSON exceeds the configured response-size limit.",
            { maximumBytes },
          );
        }
        let body: Awaited<ReturnType<typeof readBounded>>;
        try {
          body = await readBounded(response, maximumBytes, truncate, deadline.signal);
        } catch (cause) {
          if (this.signal?.aborted) throw new HonuaAbortError();
          if (deadline.timedOut()) throw new HonuaTimeoutError(this.limits.requestTimeoutMs);
          throw cause;
        }
        if (purpose === "probe") this.statistics.probeBytesRead += body.bytes.byteLength;
        else this.statistics.bytesRead += body.bytes.byteLength;
        return Object.freeze({
          url: current,
          status: response.status,
          ...(response.headers.get("content-type")
            ? { contentType: response.headers.get("content-type") ?? undefined }
            : {}),
          ...(response.headers.get("etag") ? { etag: response.headers.get("etag") ?? undefined } : {}),
          ...(response.headers.get("last-modified")
            ? { lastModified: response.headers.get("last-modified") ?? undefined }
            : {}),
          ...(response.headers.get("content-range")
            ? { contentRange: response.headers.get("content-range") ?? undefined }
            : {}),
          bytes: body.bytes,
          truncated: body.truncated,
        });
      }
    } finally {
      deadline.dispose();
    }
  }
}

function normalizeCallerHeaders(input: HeadersInit | undefined): Headers {
  let headers: Headers;
  try {
    headers = new Headers(input);
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", "Static STAC discovery headers are invalid.");
  }
  for (const forbidden of ["host", "content-length", "range", "accept-encoding"]) {
    if (headers.has(forbidden)) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        `Static STAC discovery callers may not override the ${forbidden} header.`,
      );
    }
  }
  return headers;
}

function headersForOrigin(input: Headers, rootOrigin: boolean): Headers {
  return rootOrigin ? new Headers(input) : new Headers();
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function readBounded(
  response: Response,
  maximumBytes: number,
  truncate: boolean,
  signal: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
  if (!response.body) return Object.freeze({ bytes: new Uint8Array(), truncated: false });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      const chunk = part.value;
      if (length + chunk.byteLength > maximumBytes) {
        if (!truncate) {
          throw new HonuaDiscoveryError(
            "invalid-endpoint",
            "Static STAC JSON exceeds the configured response-size limit.",
            { maximumBytes },
          );
        }
        const remaining = maximumBytes - length;
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        length = maximumBytes;
        truncated = true;
        cancelReader(reader);
        break;
      }
      chunks.push(chunk);
      length += chunk.byteLength;
    }
  } catch (cause) {
    cancelReader(reader);
    throw cause;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A hostile stream may keep an underlying read pending after cancel.
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Object.freeze({ bytes, truncated });
}

function cancelStream(stream: ReadableStream<Uint8Array> | null): void {
  if (!stream) return;
  try {
    void stream.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best effort and must never extend a request deadline.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best effort and must never extend a request deadline.
  }
}

function requestDeadline(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) forwardAbort();
  else parent?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", forwardAbort);
    },
  };
}

async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined);
    throw new HonuaAbortError();
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(new HonuaAbortError()));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}
