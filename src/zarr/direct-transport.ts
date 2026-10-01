import { HonuaAbortError } from "../core/errors.js";
import type { ZarrDirectLimits, ZarrTransferLedger, ZarrTransferRecord } from "./direct-types.js";
import { HonuaZarrError } from "./errors.js";

const SECRET_QUERY = /signature|credential|security-token|token|secret|password|access_key|x-amz-/iu;

export interface ZarrObjectBytes {
  readonly bytes: Uint8Array;
  readonly validator?: string;
}

interface MutableRecord {
  sequence: number;
  purpose: "metadata" | "chunk";
  key: string;
  range: string;
  bytesReceived: number;
  outcome: ZarrTransferRecord["outcome"];
  status?: number;
}

/**
 * Bounded GET of one known object key. Static hosts may answer 200 when the
 * object fits the range budget. Whole-bucket and directory responses do not.
 * Credentials are never attached, and secret query parameters are not recorded.
 */
export class ZarrObjectTransport {
  readonly storeUrl: string;
  readonly redactedUrl: string;
  readonly limits: ZarrDirectLimits;
  private readonly fetchFn: typeof fetch;
  private readonly records: MutableRecord[] = [];
  private nextSequence = 1;
  private metadataRequests = 0;
  private metadataBytes = 0;
  private chunkRequests = 0;
  private chunkBytes = 0;
  private metadataValidator: string | undefined;

  constructor(storeUrl: string, fetchFn: typeof fetch, limits: ZarrDirectLimits) {
    const parsed = parseStoreUrl(storeUrl);
    this.storeUrl = parsed.href;
    this.redactedUrl = redactUrl(parsed);
    this.fetchFn = fetchFn;
    this.limits = limits;
  }

  validator(): string | undefined {
    return this.metadataValidator;
  }

  snapshot(): ZarrTransferLedger {
    return Object.freeze({
      requests: this.metadataRequests + this.chunkRequests,
      bytesFetched: this.metadataBytes + this.chunkBytes,
      metadataRequests: this.metadataRequests,
      metadataBytes: this.metadataBytes,
      chunkRequests: this.chunkRequests,
      chunkBytes: this.chunkBytes,
      ranges: Object.freeze(this.records.map((record) => Object.freeze({ ...record }))),
    });
  }

  async read(
    key: string,
    purpose: "metadata" | "chunk",
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<ZarrObjectBytes | null> {
    const safeKey = assertObjectKey(key);
    if (signal.aborted) {
      this.record(purpose, safeKey, maxBytes, "aborted", 0);
      throw new HonuaAbortError("Direct Zarr read was cancelled.");
    }
    this.assertRequestBudget(purpose);
    const range = `bytes=0-${maxBytes - 1}`;
    const record = this.record(purpose, safeKey, maxBytes, "rejected", 0);
    this.countRequest(purpose);
    const url = joinStoreKey(this.storeUrl, safeKey);
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "GET",
        headers: {
          Accept: purpose === "metadata" ? "application/json, application/octet-stream" : "application/octet-stream",
          Range: range,
        },
        signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      });
    } catch (cause) {
      if (signal.aborted || isAbortLike(cause)) {
        record.outcome = "aborted";
        throw new HonuaAbortError("Direct Zarr read was cancelled.");
      }
      throw new HonuaZarrError(
        "invalid-response",
        "The Zarr object request failed before a readable response was available.",
        { key: safeKey, purpose },
      );
    }

    record.status = response.status;
    if (response.type === "opaque" || response.type === "opaqueredirect") {
      await cancelBody(response);
      throw new HonuaZarrError("invalid-response", "The Zarr object response is not readable.", {
        key: safeKey,
        purpose,
      });
    }
    if (response.status >= 300 && response.status < 400) {
      await cancelBody(response);
      throw new HonuaZarrError("invalid-request", "Redirects are not followed for direct Zarr reads.", {
        key: safeKey,
        purpose,
      });
    }
    if (!sameObject(response.url, url)) {
      await cancelBody(response);
      throw new HonuaZarrError("invalid-request", "The Zarr object response URL does not match the requested key.", {
        key: safeKey,
        purpose,
      });
    }
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.toLowerCase() !== "identity") {
      await cancelBody(response);
      throw new HonuaZarrError(
        "invalid-response",
        "Encoded Zarr responses are refused because the byte budget would be ambiguous.",
        { key: safeKey, purpose },
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/html") || contentType.includes("text/directory")) {
      await cancelBody(response);
      throw new HonuaZarrError("invalid-response", "A directory listing is not a Zarr object.", {
        key: safeKey,
        purpose,
      });
    }
    if (response.status === 404 || response.status === 204) {
      await cancelBody(response);
      record.outcome = "missing";
      return null;
    }
    if (response.status !== 200 && response.status !== 206) {
      await cancelBody(response);
      throw new HonuaZarrError("service-error", `The Zarr object request failed with HTTP ${response.status}.`, {
        key: safeKey,
        purpose,
        status: response.status,
      });
    }

    const declared = declaredLength(response, maxBytes, safeKey, purpose);
    let bytes: Uint8Array;
    try {
      bytes = await readBody(response, declared, signal, safeKey, purpose);
    } catch (error) {
      if (signal.aborted || error instanceof HonuaAbortError) {
        record.outcome = "aborted";
        throw error instanceof HonuaAbortError ? error : new HonuaAbortError("Direct Zarr read was cancelled.");
      }
      throw error;
    }
    record.bytesReceived = bytes.byteLength;
    record.outcome = "success";
    if (purpose === "metadata") this.metadataBytes += bytes.byteLength;
    else this.chunkBytes += bytes.byteLength;
    if (this.metadataBytes + this.chunkBytes > this.limits.maxTotalBytes) {
      throw new HonuaZarrError("response-too-large", "The direct Zarr read exceeded its total byte budget.", {
        limit: this.limits.maxTotalBytes,
        purpose,
      });
    }
    const validator = response.headers.get("etag") ?? response.headers.get("last-modified") ?? undefined;
    if (purpose === "metadata" && validator && !this.metadataValidator) this.metadataValidator = validator;
    return { bytes, ...(validator ? { validator } : {}) };
  }

  private assertRequestBudget(purpose: "metadata" | "chunk"): void {
    const requests = this.metadataRequests + this.chunkRequests;
    if (requests >= this.limits.maxRequests) {
      throw new HonuaZarrError("response-too-large", "The direct Zarr read exceeded its request budget.", {
        limit: this.limits.maxRequests,
        purpose,
      });
    }
    if (purpose === "metadata" && this.metadataRequests >= this.limits.maxMetadataRequests) {
      throw new HonuaZarrError("response-too-large", "The direct Zarr read exceeded its metadata request budget.", {
        limit: this.limits.maxMetadataRequests,
      });
    }
    if (purpose === "chunk" && this.chunkRequests >= this.limits.maxChunkRequests) {
      throw new HonuaZarrError("response-too-large", "The direct Zarr read exceeded its chunk request budget.", {
        limit: this.limits.maxChunkRequests,
      });
    }
  }

  private countRequest(purpose: "metadata" | "chunk"): void {
    if (purpose === "metadata") this.metadataRequests += 1;
    else this.chunkRequests += 1;
  }

  private record(
    purpose: "metadata" | "chunk",
    key: string,
    maxBytes: number,
    outcome: ZarrTransferRecord["outcome"],
    bytesReceived: number,
  ): MutableRecord {
    const record: MutableRecord = {
      sequence: this.nextSequence,
      purpose,
      key,
      range: `bytes=0-${maxBytes - 1}`,
      bytesReceived,
      outcome,
    };
    this.nextSequence += 1;
    this.records.push(record);
    return record;
  }
}

export function redactUrl(url: URL): string {
  const copy = new URL(url.href);
  copy.username = "";
  copy.password = "";
  const kept = new URLSearchParams();
  for (const [key, value] of copy.searchParams) {
    if (!SECRET_QUERY.test(key)) kept.append(key, value);
  }
  copy.search = kept.toString();
  copy.hash = "";
  return copy.toString();
}

function parseStoreUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HonuaZarrError("invalid-request", "The Zarr store URL is not a valid absolute URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HonuaZarrError("invalid-request", "Direct Zarr reads accept only http and https store URLs.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new HonuaZarrError("invalid-request", "The Zarr store URL must not embed userinfo.");
  }
  if (url.hash !== "") {
    throw new HonuaZarrError("invalid-request", "The Zarr store URL must not contain a fragment.");
  }
  return url;
}

export function assertObjectKey(key: string): string {
  if (key.length === 0 || key.length > 512) {
    throw new HonuaZarrError("invalid-request", "The Zarr object key is empty or too long.");
  }
  if (key.startsWith("/") || key.includes("\\") || key.includes("?") || key.includes("#") || key.includes("\0")) {
    throw new HonuaZarrError("invalid-request", "The Zarr object key is not a relative object name.", { key });
  }
  const segments = key.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new HonuaZarrError("invalid-request", "The Zarr object key contains an empty or parent segment.", { key });
  }
  return key;
}

function joinStoreKey(storeUrl: string, key: string): string {
  const store = new URL(storeUrl);
  if (!store.pathname.endsWith("/")) store.pathname = `${store.pathname}/`;
  const resolved = new URL(key, store);
  if (resolved.origin !== store.origin || !resolved.pathname.startsWith(store.pathname)) {
    throw new HonuaZarrError("invalid-request", "The Zarr object key escapes the store prefix.", { key });
  }
  return resolved.toString();
}

function declaredLength(response: Response, maxBytes: number, key: string, purpose: "metadata" | "chunk"): number {
  if (response.status === 206) {
    const parsed = parseContentRange(response.headers.get("content-range"));
    if (!parsed || parsed.start !== 0 || parsed.length <= 0 || parsed.length > maxBytes) {
      void cancelBody(response);
      throw new HonuaZarrError(
        "invalid-response",
        "The Zarr range response does not match the requested byte budget.",
        {
          key,
          purpose,
        },
      );
    }
    if (parsed.total !== undefined && parsed.total > maxBytes) {
      void cancelBody(response);
      throw new HonuaZarrError("response-too-large", "The Zarr object is larger than the range budget.", {
        key,
        purpose,
        limit: maxBytes,
        total: parsed.total,
      });
    }
    return parsed.length;
  }
  const header = response.headers.get("content-length");
  if (header === null) {
    void cancelBody(response);
    throw new HonuaZarrError(
      "response-too-large",
      "The Zarr object response has no content length, so it cannot be bounded.",
      { key, purpose },
    );
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length) || length < 0) {
    void cancelBody(response);
    throw new HonuaZarrError("invalid-response", "The Zarr object response has an invalid content length.", {
      key,
      purpose,
    });
  }
  if (length > maxBytes) {
    void cancelBody(response);
    throw new HonuaZarrError("response-too-large", "The Zarr object is larger than the range budget.", {
      key,
      purpose,
      limit: maxBytes,
      total: length,
    });
  }
  return length;
}

function parseContentRange(value: string | null): { start: number; length: number; total?: number } | undefined {
  if (!value) return undefined;
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(value.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
  const total = match[3] === "*" ? undefined : Number(match[3]);
  if (total !== undefined && (!Number.isSafeInteger(total) || total <= end)) return undefined;
  return { start, length: end - start + 1, ...(total === undefined ? {} : { total }) };
}

async function readBody(
  response: Response,
  expected: number,
  signal: AbortSignal,
  key: string,
  purpose: "metadata" | "chunk",
): Promise<Uint8Array> {
  if (!response.body) {
    if (expected === 0) return new Uint8Array();
    throw new HonuaZarrError("invalid-response", "The Zarr object response has no body.", { key, purpose });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < expected) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new HonuaAbortError("Direct Zarr read was cancelled.");
      }
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > expected) {
        await reader.cancel().catch(() => undefined);
        throw new HonuaZarrError("response-too-large", "The Zarr object response exceeded its declared length.", {
          key,
          purpose,
          limit: expected,
        });
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (received !== expected) {
    throw new HonuaZarrError("invalid-response", "The Zarr object response ended before its declared length.", {
      key,
      purpose,
    });
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function sameObject(responseUrl: string, requestUrl: string): boolean {
  if (!responseUrl) return true;
  try {
    const left = new URL(responseUrl);
    const right = new URL(requestUrl);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

function isAbortLike(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const name = "name" in cause ? String(cause.name) : "";
  return name === "AbortError" || name === "HonuaAbortError";
}
