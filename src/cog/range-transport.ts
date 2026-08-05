import { HonuaCogError } from "./errors.js";
import type {
  CogByteRangeRequest,
  CogRangePurpose,
  CogRangeReader,
  CogRangeRecord,
  CogTransferLedger,
  CogTransferLimitOptions,
  CogTransferLimits,
} from "./types.js";

const MIB = 1024 * 1024;

export const DEFAULT_COG_TRANSFER_LIMITS: CogTransferLimits = Object.freeze({
  maxMetadataRequests: 32,
  maxWindowRequests: 64,
  maxRangeBytes: 2 * MIB,
  maxMetadataBytes: 2 * MIB,
  maxWindowBytes: 32 * MIB,
  maxTotalBytes: 40 * MIB,
  maxWindowPixels: 4_194_304,
  maxDecodedBytes: 64 * MIB,
});

const HARD_COG_TRANSFER_LIMITS: CogTransferLimits = Object.freeze({
  maxMetadataRequests: 128,
  maxWindowRequests: 256,
  maxRangeBytes: 8 * MIB,
  maxMetadataBytes: 8 * MIB,
  maxWindowBytes: 64 * MIB,
  maxTotalBytes: 128 * MIB,
  maxWindowPixels: 16_777_216,
  maxDecodedBytes: 256 * MIB,
});

export function normalizeCogTransferLimits(options: CogTransferLimitOptions = {}): CogTransferLimits {
  return Object.freeze({
    maxMetadataRequests: boundedLimit(
      options.maxMetadataRequests,
      DEFAULT_COG_TRANSFER_LIMITS.maxMetadataRequests,
      HARD_COG_TRANSFER_LIMITS.maxMetadataRequests,
      "maxMetadataRequests",
    ),
    maxWindowRequests: boundedLimit(
      options.maxWindowRequests,
      DEFAULT_COG_TRANSFER_LIMITS.maxWindowRequests,
      HARD_COG_TRANSFER_LIMITS.maxWindowRequests,
      "maxWindowRequests",
    ),
    maxRangeBytes: boundedLimit(
      options.maxRangeBytes,
      DEFAULT_COG_TRANSFER_LIMITS.maxRangeBytes,
      HARD_COG_TRANSFER_LIMITS.maxRangeBytes,
      "maxRangeBytes",
    ),
    maxMetadataBytes: boundedLimit(
      options.maxMetadataBytes,
      DEFAULT_COG_TRANSFER_LIMITS.maxMetadataBytes,
      HARD_COG_TRANSFER_LIMITS.maxMetadataBytes,
      "maxMetadataBytes",
    ),
    maxWindowBytes: boundedLimit(
      options.maxWindowBytes,
      DEFAULT_COG_TRANSFER_LIMITS.maxWindowBytes,
      HARD_COG_TRANSFER_LIMITS.maxWindowBytes,
      "maxWindowBytes",
    ),
    maxTotalBytes: boundedLimit(
      options.maxTotalBytes,
      DEFAULT_COG_TRANSFER_LIMITS.maxTotalBytes,
      HARD_COG_TRANSFER_LIMITS.maxTotalBytes,
      "maxTotalBytes",
    ),
    maxWindowPixels: boundedLimit(
      options.maxWindowPixels,
      DEFAULT_COG_TRANSFER_LIMITS.maxWindowPixels,
      HARD_COG_TRANSFER_LIMITS.maxWindowPixels,
      "maxWindowPixels",
    ),
    maxDecodedBytes: boundedLimit(
      options.maxDecodedBytes,
      DEFAULT_COG_TRANSFER_LIMITS.maxDecodedBytes,
      HARD_COG_TRANSFER_LIMITS.maxDecodedBytes,
      "maxDecodedBytes",
    ),
  });
}

function boundedLimit(value: number | undefined, fallback: number, hardMaximum: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > hardMaximum) {
    throw new HonuaCogError(
      "invalid-range",
      `${label} must be a positive safe integer no greater than ${hardMaximum}.`,
    );
  }
  return selected;
}

interface MutableRangeRecord {
  sequence: number;
  purpose: CogRangePurpose;
  offset: number;
  length: number;
  bytesReceived: number;
  outcome: CogRangeRecord["outcome"];
  status?: number;
  contentRange?: string;
  validator?: string;
  errorCode?: string;
}

interface TransferCounters {
  metadataRequests: number;
  metadataBytes: number;
  windowRequests: number;
  windowBytes: number;
  reservedMetadataBytes: number;
  reservedWindowBytes: number;
}

export class CogRangeTransport {
  private readonly assetUrl: string;
  private readonly fetchFn: typeof fetch;
  readonly limits: CogTransferLimits;
  private nextSequence = 1;
  private readonly records = new Map<number, CogRangeRecord>();
  private readonly counters: TransferCounters = {
    metadataRequests: 0,
    metadataBytes: 0,
    windowRequests: 0,
    windowBytes: 0,
    reservedMetadataBytes: 0,
    reservedWindowBytes: 0,
  };
  private stableValidator: string | undefined;

  constructor(assetUrl: string, fetchFn: typeof fetch, limits: CogTransferLimits) {
    this.assetUrl = assetUrl;
    this.fetchFn = fetchFn;
    this.limits = limits;
  }

  reader(purpose: CogRangePurpose, signal: AbortSignal): CogRangeReader {
    return (request) => this.read(purpose, signal, request);
  }

  validator(): string | undefined {
    return this.stableValidator;
  }

  snapshot(): CogTransferLedger {
    const ranges = Object.freeze([...this.records.values()].sort((left, right) => left.sequence - right.sequence));
    return Object.freeze({
      requests: this.counters.metadataRequests + this.counters.windowRequests,
      bytesFetched: this.counters.metadataBytes + this.counters.windowBytes,
      metadataRequests: this.counters.metadataRequests,
      metadataBytes: this.counters.metadataBytes,
      windowRequests: this.counters.windowRequests,
      windowBytes: this.counters.windowBytes,
      ranges,
    });
  }

  private async read(purpose: CogRangePurpose, signal: AbortSignal, request: CogByteRangeRequest): Promise<Uint8Array> {
    const { offset, length } = validateRange(request, this.limits.maxRangeBytes);
    if (signal.aborted) throw abortedError();
    this.assertRequestAvailable(purpose);
    this.reserve(purpose, length);

    const record: MutableRangeRecord = {
      sequence: this.nextSequence++,
      purpose,
      offset,
      length,
      bytesReceived: 0,
      outcome: "rejected",
    };
    this.incrementRequests(purpose);

    try {
      let response: Response;
      try {
        response = await this.fetchFn(this.assetUrl, {
          method: "GET",
          headers: {
            Accept: "image/tiff, image/vnd.stac.geotiff;q=0.9, application/octet-stream;q=0.1",
            Range: `bytes=${offset}-${offset + length - 1}`,
          },
          signal,
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
        });
      } catch (cause) {
        if (signal.aborted || isAbortLike(cause)) throw abortedError(cause);
        throw new HonuaCogError(
          "cors-unavailable",
          "The COG range request was blocked by CORS or the network before a readable response was available.",
          { cause },
        );
      }

      record.status = response.status;
      if (response.type === "opaque") {
        await cancelBody(response);
        throw new HonuaCogError(
          "cors-unavailable",
          "The COG range response is opaque; the asset must expose readable CORS response headers.",
        );
      }
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        await cancelBody(response);
        throw new HonuaCogError("redirect-disallowed", "Redirects are not allowed for bounded COG range requests.");
      }
      if (response.url && canonicalUrl(response.url) !== canonicalUrl(this.assetUrl)) {
        await cancelBody(response);
        throw new HonuaCogError(
          "redirect-disallowed",
          "The COG range response URL differs from the classified STAC asset URL.",
        );
      }
      if (response.status === 200 || response.status === 416) {
        await cancelBody(response);
        throw new HonuaCogError(
          "range-unsupported",
          response.status === 200
            ? "The asset ignored the Range header; whole-file fallback is disabled."
            : "The asset rejected the requested byte range.",
        );
      }
      if (response.status !== 206) {
        await cancelBody(response);
        throw new HonuaCogError("http-error", `The COG range request failed with HTTP ${response.status}.`);
      }

      const contentEncoding = response.headers.get("content-encoding");
      if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
        await cancelBody(response);
        throw new HonuaCogError(
          "invalid-range-response",
          "Compressed range responses are not accepted because byte offsets would be ambiguous.",
        );
      }
      const contentRange = response.headers.get("content-range");
      if (contentRange) record.contentRange = contentRange;
      const parsed = parseContentRange(contentRange);
      const expectedEnd = offset + length - 1;
      if (!parsed || parsed.start !== offset || parsed.end !== expectedEnd || parsed.total <= parsed.end) {
        await cancelBody(response);
        throw new HonuaCogError(
          "invalid-range-response",
          "The COG response did not expose the exact requested Content-Range and total size.",
        );
      }
      if (parsed.start === 0 && parsed.end + 1 === parsed.total) {
        await cancelBody(response);
        throw new HonuaCogError(
          "whole-file-disallowed",
          "The requested range would materialize the entire asset; direct COG reads must remain partial.",
        );
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== length)) {
        await cancelBody(response);
        throw new HonuaCogError(
          "invalid-range-response",
          "The COG response Content-Length does not match the requested byte range.",
        );
      }

      const validator = responseValidator(response.headers);
      if (validator) record.validator = validator;
      const bytes = await readExactBody(response, length, signal, record);
      this.acceptValidator(validator);
      record.outcome = "success";
      return bytes;
    } catch (cause) {
      const error = signal.aborted ? abortedError(cause) : normalizeRangeError(cause);
      record.outcome = error.code === "aborted" ? "aborted" : "rejected";
      record.errorCode = error.code;
      throw error;
    } finally {
      this.releaseReservation(purpose, length);
      this.addFetchedBytes(purpose, record.bytesReceived);
      this.records.set(record.sequence, freezeRecord(record));
    }
  }

  private reserve(purpose: CogRangePurpose, length: number): void {
    const purposeBytes =
      purpose === "metadata"
        ? this.counters.metadataBytes + this.counters.reservedMetadataBytes
        : this.counters.windowBytes + this.counters.reservedWindowBytes;
    const purposeLimit = purpose === "metadata" ? this.limits.maxMetadataBytes : this.limits.maxWindowBytes;
    if (purposeBytes + length > purposeLimit) {
      throw new HonuaCogError(
        "byte-limit-exceeded",
        `The ${purpose} byte budget of ${purposeLimit} bytes would be exceeded.`,
      );
    }
    const allBytes =
      this.counters.metadataBytes +
      this.counters.windowBytes +
      this.counters.reservedMetadataBytes +
      this.counters.reservedWindowBytes;
    if (allBytes + length > this.limits.maxTotalBytes) {
      throw new HonuaCogError(
        "byte-limit-exceeded",
        `The session byte budget of ${this.limits.maxTotalBytes} bytes would be exceeded.`,
      );
    }
    if (purpose === "metadata") this.counters.reservedMetadataBytes += length;
    else this.counters.reservedWindowBytes += length;
  }

  private releaseReservation(purpose: CogRangePurpose, length: number): void {
    if (purpose === "metadata") this.counters.reservedMetadataBytes -= length;
    else this.counters.reservedWindowBytes -= length;
  }

  private incrementRequests(purpose: CogRangePurpose): void {
    if (purpose === "metadata") this.counters.metadataRequests += 1;
    else this.counters.windowRequests += 1;
  }

  private assertRequestAvailable(purpose: CogRangePurpose): void {
    const current = purpose === "metadata" ? this.counters.metadataRequests : this.counters.windowRequests;
    const maximum = purpose === "metadata" ? this.limits.maxMetadataRequests : this.limits.maxWindowRequests;
    if (current >= maximum) {
      throw new HonuaCogError("request-limit-exceeded", `The ${purpose} request limit of ${maximum} has been reached.`);
    }
  }

  private addFetchedBytes(purpose: CogRangePurpose, bytes: number): void {
    if (purpose === "metadata") this.counters.metadataBytes += bytes;
    else this.counters.windowBytes += bytes;
  }

  private acceptValidator(validator: string | undefined): void {
    if (!this.stableValidator && validator) {
      this.stableValidator = validator;
      return;
    }
    if (this.stableValidator && validator !== this.stableValidator) {
      throw new HonuaCogError(
        "asset-changed",
        "The COG validator changed or disappeared between range responses; mixed-version decoding is refused.",
      );
    }
  }
}

function validateRange(request: CogByteRangeRequest, maxRangeBytes: number): CogByteRangeRequest {
  const { offset, length } = request;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    length > maxRangeBytes ||
    !Number.isSafeInteger(offset + length - 1)
  ) {
    throw new HonuaCogError(
      "invalid-range",
      `Byte ranges require a non-negative safe offset and 1-${maxRangeBytes} byte length.`,
    );
  }
  return { offset, length };
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | undefined {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value ?? "");
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= 0) return undefined;
  return { start, end, total };
}

async function readExactBody(
  response: Response,
  expectedLength: number,
  signal: AbortSignal,
  record: MutableRangeRecord,
): Promise<Uint8Array> {
  if (!response.body) {
    throw new HonuaCogError("invalid-range-response", "The COG range response has no readable body.");
  }
  const reader = response.body.getReader();
  const abort = () => void reader.cancel().catch(() => undefined);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const output = new Uint8Array(expectedLength);
  let written = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortedError();
      const next = await reader.read();
      if (next.done) break;
      record.bytesReceived += next.value.byteLength;
      if (written + next.value.byteLength > expectedLength) {
        await reader.cancel().catch(() => undefined);
        throw new HonuaCogError(
          "range-overflow",
          `The COG range response exceeded its ${expectedLength}-byte ceiling.`,
        );
      }
      output.set(next.value, written);
      written += next.value.byteLength;
    }
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    if (signal.aborted || isAbortLike(cause)) throw abortedError(cause);
    if (cause instanceof HonuaCogError) throw cause;
    throw new HonuaCogError("invalid-range-response", "The COG range response stream failed.", { cause });
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  if (written !== expectedLength) {
    throw new HonuaCogError(
      "invalid-range-response",
      `The COG range response ended after ${written} bytes; ${expectedLength} bytes were required.`,
    );
  }
  return output;
}

function responseValidator(headers: Headers): string | undefined {
  const etag = headers.get("etag");
  if (etag) return `etag:${etag}`;
  const lastModified = headers.get("last-modified");
  return lastModified ? `last-modified:${lastModified}` : undefined;
}

function freezeRecord(record: MutableRangeRecord): CogRangeRecord {
  return Object.freeze({
    sequence: record.sequence,
    purpose: record.purpose,
    offset: record.offset,
    length: record.length,
    bytesReceived: record.bytesReceived,
    outcome: record.outcome,
    ...(record.status !== undefined ? { status: record.status } : {}),
    ...(record.contentRange ? { contentRange: record.contentRange } : {}),
    ...(record.validator ? { validator: record.validator } : {}),
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
  });
}

function normalizeRangeError(cause: unknown): HonuaCogError {
  if (cause instanceof HonuaCogError) return cause;
  return new HonuaCogError("invalid-range-response", "The COG range request failed.", { cause });
}

function abortedError(cause?: unknown): HonuaCogError {
  return new HonuaCogError("aborted", "The COG range request was aborted.", cause ? { cause } : undefined);
}

function isAbortLike(cause: unknown): boolean {
  return (
    (cause instanceof DOMException && cause.name === "AbortError") ||
    (cause instanceof Error && cause.name === "AbortError")
  );
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}
