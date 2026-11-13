import { HonuaAbortError } from "../core/errors.js";
import { HonuaPublicationError } from "./errors.js";

/** Reads up to this size (footers, bloom filters, page indexes) are kept for later lookups. */
const CACHED_READ_BYTES = 64 * 1024;

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

function megabytes(bytes: number): string {
  return (bytes / 2 ** 20).toFixed(1);
}

/** A host that answers a range request with the whole file would make every read a full download. */
export function rangeNotServedError(url: string, byteLength: number, status: number): HonuaPublicationError {
  return new HonuaPublicationError(
    "query-budget-exceeded",
    `The host of ${url} does not serve byte ranges, so reading it in the browser would download the whole ${megabytes(byteLength)} MB file.`,
    { detail: { url, status, reason: "range-not-served", fileBytes: byteLength } },
  );
}

export function isRangeNotServed(error: unknown): error is HonuaPublicationError {
  return error instanceof HonuaPublicationError && error.detail?.reason === "range-not-served";
}

function totalFromContentRange(header: string | null): number | undefined {
  const total = /\/(\d+)$/.exec(header ?? "")?.[1];
  return total === undefined ? undefined : Number(total);
}

/**
 * Reads a published artifact by HTTP range requests only. A response that is
 * not a 206 for exactly the requested bytes is refused before its body is
 * read, so a host without range support never costs a full download.
 */
export function artifactRangeReader(url: string, byteLength: number, fetchImpl: typeof fetch): ArtifactRangeReader {
  const cache = new Map<string, ArrayBuffer>();

  async function read(start: number, end: number, signal: AbortSignal | undefined): Promise<ArrayBuffer> {
    if (signal?.aborted) throw new HonuaAbortError();
    const response = await fetchImpl(url, {
      headers: { range: `bytes=${start}-${end - 1}` },
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 206) {
      await response.body?.cancel().catch(() => undefined);
      throw rangeNotServedError(url, byteLength, response.status);
    }
    const body = await response.arrayBuffer();
    const total = totalFromContentRange(response.headers.get("content-range"));
    if (body.byteLength !== end - start || (total !== undefined && total !== byteLength)) {
      throw new HonuaPublicationError(
        "artifact-mismatch",
        `${url} returned ${body.byteLength} bytes of a ${total ?? "unknown"}-byte file for a ${end - start}-byte range of the ${byteLength}-byte artifact the descriptor names.`,
        { detail: { url, expectedBytes: byteLength, servedBytes: total ?? null } },
      );
    }
    return body;
  }

  async function cachedRead(start: number, end: number, signal?: AbortSignal, meter?: ByteMeter): Promise<ArrayBuffer> {
    const key = `${start}-${end}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const body = await read(start, end, signal);
    if (meter) meter.bytes += body.byteLength;
    if (body.byteLength <= CACHED_READ_BYTES) cache.set(key, body);
    return body;
  }

  return Object.freeze({
    url,
    byteLength,
    view(signal?: AbortSignal, meter?: ByteMeter): RangeFile {
      return {
        byteLength,
        slice: (start: number, end = byteLength) => cachedRead(start, end, signal, meter),
      };
    },
  });
}
