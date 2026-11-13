import { HonuaAbortError } from "../core/errors.js";
import { cancelBody, parseContentRange } from "../core/http-range.js";
import { HonuaPublicationError } from "./errors.js";

/** Small reads (footers, bloom filters, page indexes) are kept for later lookups, up to this total. */
const CACHED_READ_BYTES = 64 * 1024;
const CACHE_LIMIT_BYTES = 1024 * 1024;

/** A byte-addressable view of a remote artifact, as a Parquet reader expects it. */
export interface RangeFile {
  readonly byteLength: number;
  slice(start: number, end?: number): Promise<ArrayBuffer>;
}

/** Counts the bytes read through one view. */
export interface ByteMeter {
  bytes: number;
}

export interface ArtifactRangeReader {
  readonly url: string;
  readonly byteLength: number;
  /** A view whose reads stop when `signal` aborts; bytes it transfers are added to `meter`. */
  view(signal?: AbortSignal, meter?: ByteMeter): RangeFile;
}

export function megabytes(bytes: number): string {
  return (bytes / 2 ** 20).toFixed(1);
}

/** A host that answers a range request with the whole file would make every read a full download. */
export function rangeNotServedError(url: string, byteLength: number): HonuaPublicationError {
  return new HonuaPublicationError(
    "query-budget-exceeded",
    `The host of ${url} does not serve byte ranges, so reading it in the browser would download the whole ${megabytes(byteLength)} MB file.`,
    { detail: { url, reason: "range-not-served", fileBytes: byteLength } },
  );
}

export function isRangeNotServed(error: unknown): error is HonuaPublicationError {
  return error instanceof HonuaPublicationError && error.detail?.reason === "range-not-served";
}

function sizeMismatchError(url: string, byteLength: number, detail: Record<string, unknown>): HonuaPublicationError {
  return new HonuaPublicationError(
    "artifact-mismatch",
    `${url} does not hold the ${byteLength}-byte artifact the descriptor names.`,
    { detail: { url, expectedBytes: byteLength, ...detail } },
  );
}

interface RangeRequest {
  readonly start: number;
  readonly end: number;
  readonly signal: AbortSignal | undefined;
}

/**
 * Reads a published artifact by HTTP range requests only. A response that is
 * not a 206 for exactly the requested bytes is refused before its body is
 * read, so a host without range support never costs a full download. A file
 * small enough to be requested whole may also come back as a 200.
 */
export function artifactRangeReader(url: string, byteLength: number, fetchImpl: typeof fetch): ArtifactRangeReader {
  const cache = new Map<string, ArrayBuffer>();
  let cachedBytes = 0;

  async function checkedResponse({ start, end, signal }: RangeRequest): Promise<Response> {
    const response = await fetchImpl(url, {
      headers: { range: `bytes=${start}-${end - 1}` },
      ...(signal ? { signal } : {}),
    });
    const wholeFile = start === 0 && end === byteLength;
    if (response.status === 206 || (response.status === 200 && wholeFile)) return response;
    await cancelBody(response);
    if (response.status === 200) throw rangeNotServedError(url, byteLength);
    if (response.status === 416) throw sizeMismatchError(url, byteLength, { status: 416, requested: [start, end] });
    throw new HonuaPublicationError(
      "artifact-unavailable",
      `${url} could not be read: the host answered HTTP ${response.status}.`,
      { detail: { url, status: response.status } },
    );
  }

  async function read(request: RangeRequest): Promise<ArrayBuffer> {
    if (request.signal?.aborted) throw new HonuaAbortError();
    const response = await checkedResponse(request);
    const expected = request.end - request.start;
    const range = parseContentRange(response.headers.get("content-range"));
    const announced = Number(response.headers.get("content-length") ?? expected);
    const rangeMatches =
      response.status === 200 ||
      range === undefined ||
      (range.start === request.start && range.end === request.end - 1 && range.total === byteLength);
    if (!rangeMatches || announced !== expected) {
      await cancelBody(response);
      throw sizeMismatchError(url, byteLength, { contentRange: range ?? null, contentLength: announced });
    }
    const body = await response.arrayBuffer();
    if (body.byteLength !== expected) throw sizeMismatchError(url, byteLength, { receivedBytes: body.byteLength });
    return body;
  }

  function remember(key: string, body: ArrayBuffer): void {
    if (body.byteLength > CACHED_READ_BYTES || cachedBytes + body.byteLength > CACHE_LIMIT_BYTES) return;
    cache.set(key, body);
    cachedBytes += body.byteLength;
  }

  return Object.freeze({
    url,
    byteLength,
    view(signal?: AbortSignal, meter?: ByteMeter): RangeFile {
      return {
        byteLength,
        async slice(start: number, end = byteLength) {
          const key = `${start}-${end}`;
          const cached = cache.get(key);
          if (cached) return cached;
          const body = await read({ start, end, signal });
          if (meter) meter.bytes += body.byteLength;
          remember(key, body);
          return body;
        },
      };
    },
  });
}
