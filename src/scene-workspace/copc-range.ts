/**
 * Bounded HTTP Range client and binary header parser for Cloud Optimized Point
 * Cloud (COPC) scene endpoints (`/scenes/{sceneId}/copc`).
 *
 * Supports both public endpoints and host-bound protected-scene asset sessions
 * without duplicating credential logic or loading unbounded files in memory.
 *
 * @experimental Held back from the beta `@honua/app-platform/scene-workspace`
 *   tier while server COPC range endpoints mature.
 * @module
 */

import type { SceneProtectedAssetSession } from "./scene-access-session.js";

/** Inclusive HTTP byte range (`Range: bytes=start-end`). */
export interface CopcByteRange {
  readonly start: number;
  readonly end: number;
}

/** Parsed LAS 1.4 public header block (375 bytes). */
export interface CopcHeaderInfo {
  readonly signature: "LASF";
  readonly versionMajor: number;
  readonly versionMinor: number;
  readonly headerSize: number;
  readonly offsetToPointData: number;
  readonly vlrCount: number;
  readonly pointDataRecordFormat: number;
  readonly pointDataRecordLength: number;
  readonly pointCount: number;
  readonly scale: readonly [number, number, number];
  readonly offset: readonly [number, number, number];
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly isCompressedLaz: boolean;
}

/** Parsed COPC Info VLR payload (`userId: "copc"`, `recordId: 1`, 160 bytes). */
export interface CopcInfo {
  readonly center: readonly [number, number, number];
  readonly halfSize: number;
  readonly spacing: number;
  readonly rootHierarchyOffset: number;
  readonly rootHierarchySize: number;
  readonly gpstimeMinimum: number;
  readonly gpstimeMaximum: number;
}

/** Result of a `HEAD` probe against a COPC endpoint. */
export interface CopcHeadResult {
  readonly url: string;
  readonly contentLength: number;
  readonly acceptRanges: boolean;
  readonly etag?: string;
}

/** Result of a bounded HTTP range read against a COPC endpoint. */
export interface CopcRangeReadResult {
  readonly url: string;
  readonly status: number;
  readonly bytes: Uint8Array;
  readonly contentRange?: string;
  readonly etag?: string;
}

/** Options for {@link createCopcRangeClient}. */
export interface CopcRangeClientOptions {
  readonly baseUrl?: string;
  readonly sceneId?: string;
  /** Explicit COPC URL (takes precedence over `baseUrl` + `sceneId`). */
  readonly copcUrl?: string;
  /** Optional host-bound session for protected COPC scenes. */
  readonly session?: SceneProtectedAssetSession;
  readonly fetchFn?: typeof fetch;
  /** Hard byte limit per range request. Defaults to 16 MiB. */
  readonly maxRangeBytes?: number;
}

/** Bounded range client for a COPC scene asset. */
export interface CopcRangeClient {
  readonly url: string;
  head(signal?: AbortSignal): Promise<CopcHeadResult>;
  readRange(range: CopcByteRange, signal?: AbortSignal): Promise<CopcRangeReadResult>;
  readHeader(signal?: AbortSignal): Promise<{ readonly lasHeader: CopcHeaderInfo; readonly copcInfo?: CopcInfo }>;
}

const LAS_14_HEADER_BYTES = 375;
const VLR_HEADER_BYTES = 54;
const COPC_INFO_VLR_BYTES = 160;
const INITIAL_COPC_PROBE_END = LAS_14_HEADER_BYTES + VLR_HEADER_BYTES + COPC_INFO_VLR_BYTES - 1;
const DEFAULT_MAX_RANGE_BYTES = 16 * 1024 * 1024;
const LAZ_FORMAT_BIT = 0x80;
const EMPTY_SCENE_SEGMENT = "/scenes//";

/** Resolve canonical `/scenes/{sceneId}/copc` URL, failing closed on empty ids. */
export function buildSceneCopcUrl(baseUrl: string, sceneId: string): string {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, "");
  const trimmedId = sceneId.trim();
  if (!trimmedBase || !trimmedId) {
    throw new Error("buildSceneCopcUrl requires non-empty baseUrl and sceneId.");
  }
  return `${trimmedBase}/scenes/${encodeURIComponent(trimmedId)}/copc`;
}

/**
 * Create a bounded HTTP range client for a COPC scene endpoint.
 *
 * Validates range bounds before issuing any network request and routes
 * protected fetches through {@link SceneProtectedAssetSession.fetchAsset}.
 */
export function createCopcRangeClient(options: CopcRangeClientOptions): CopcRangeClient {
  const url = resolveCopcEndpointUrl(options);
  const maxRangeBytes = validateMaxRangeBytes(options.maxRangeBytes ?? DEFAULT_MAX_RANGE_BYTES);
  const fetchFn = options.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  const issueRequest = (
    method: "GET" | "HEAD",
    headers?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> => {
    if (options.session) {
      return options.session.fetchAsset({ url, method, headers, signal });
    }
    return fetchFn(url, { method, headers, signal });
  };

  const client: CopcRangeClient = {
    url,
    async head(signal?: AbortSignal): Promise<CopcHeadResult> {
      const response = await issueRequest("HEAD", undefined, signal);
      if (!response.ok) {
        throw new Error(`COPC HEAD failed with HTTP ${response.status}.`);
      }
      const lengthHeader = response.headers.get("content-length");
      const contentLength = lengthHeader ? Number.parseInt(lengthHeader, 10) : 0;
      const acceptRanges = (response.headers.get("accept-ranges") ?? "").toLowerCase().includes("bytes");
      const etag = response.headers.get("etag") ?? undefined;
      return {
        url,
        contentLength: Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : 0,
        acceptRanges,
        ...(etag ? { etag } : {}),
      };
    },
    async readRange(range: CopcByteRange, signal?: AbortSignal): Promise<CopcRangeReadResult> {
      const expectedLength = validateRange(range, maxRangeBytes);
      const response = await issueRequest("GET", { Range: `bytes=${range.start}-${range.end}` }, signal);
      const contentRange = response.headers.get("content-range") ?? undefined;
      let bodyLimit = expectedLength;
      try {
        if (response.status === 206) {
          bodyLimit = validateContentRange(contentRange, range);
        } else if (response.status !== 200) {
          throw new Error(`COPC range request failed with HTTP ${response.status}.`);
        } else if (range.start !== 0) {
          throw new Error("COPC endpoint ignored HTTP Range and returned an unbounded or misaligned payload.");
        }
      } catch (error) {
        void response.body?.cancel().catch(() => undefined);
        throw error;
      }
      const bytes = await readBoundedBody(response.body, bodyLimit);
      if (response.status === 206 && bytes.byteLength !== bodyLimit) {
        throw new Error("COPC response size does not match Content-Range.");
      }
      const etag = response.headers.get("etag") ?? undefined;
      return {
        url,
        status: response.status,
        bytes,
        ...(contentRange ? { contentRange } : {}),
        ...(etag ? { etag } : {}),
      };
    },
    async readHeader(signal?: AbortSignal) {
      const result = await client.readRange({ start: 0, end: INITIAL_COPC_PROBE_END }, signal);
      const lasHeader = parseLas14Header(result.bytes);
      const copcInfo = parseCopcInfoVlr(result.bytes, lasHeader.headerSize);
      return { lasHeader, ...(copcInfo ? { copcInfo } : {}) };
    },
  };

  return client;
}

function validateContentRange(header: string | undefined, request: CopcByteRange): number {
  const match = header?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) throw new Error("COPC partial response requires a valid Content-Range.");
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? undefined : Number(match[3]);
  if (
    start !== request.start ||
    !Number.isSafeInteger(end) ||
    end < start ||
    end > request.end ||
    (total !== undefined && (!Number.isSafeInteger(total) || total <= end)) ||
    (end < request.end && total !== end + 1)
  ) {
    throw new Error("COPC Content-Range does not match the requested range.");
  }
  return end - start + 1;
}

async function readBoundedBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  try {
    return await readBoundedChunks(reader, limit);
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedChunks(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(limit);
  let offset = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return bytes.subarray(0, offset);
    if (value.byteLength > limit - offset) {
      throw new Error(`COPC response exceeded the requested byte budget (${limit}).`);
    }
    bytes.set(value, offset);
    offset += value.byteLength;
  }
}

/** Parse a LAS 1.4 public header block from raw bytes. Pure. */
export function parseLas14Header(bytes: Uint8Array): CopcHeaderInfo {
  if (bytes.byteLength < LAS_14_HEADER_BYTES) {
    throw new Error(`LAS 1.4 header requires at least ${LAS_14_HEADER_BYTES} bytes, received ${bytes.byteLength}.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = decodeAscii(bytes, 0, 4);
  if (signature !== "LASF") {
    throw new Error(`Invalid LAS signature "${signature}"; expected "LASF".`);
  }
  const versionMajor = view.getUint8(24);
  const versionMinor = view.getUint8(25);
  const headerSize = view.getUint16(94, true);
  const offsetToPointData = view.getUint32(96, true);
  const vlrCount = view.getUint32(100, true);
  const rawFormat = view.getUint8(104);
  const isCompressedLaz = (rawFormat & LAZ_FORMAT_BIT) !== 0;
  const pointDataRecordFormat = rawFormat & ~LAZ_FORMAT_BIT;
  const pointDataRecordLength = view.getUint16(105, true);
  const legacyPointCount = view.getUint32(107, true);
  const extendedPointCount = versionMajor === 1 && versionMinor >= 4 ? readSafeUint64(view, 247) : legacyPointCount;
  const pointCount = extendedPointCount > 0 ? extendedPointCount : legacyPointCount;

  const scale: readonly [number, number, number] = [
    view.getFloat64(131, true),
    view.getFloat64(139, true),
    view.getFloat64(147, true),
  ];
  const offset: readonly [number, number, number] = [
    view.getFloat64(155, true),
    view.getFloat64(163, true),
    view.getFloat64(171, true),
  ];
  const max: readonly [number, number, number] = [
    view.getFloat64(179, true),
    view.getFloat64(195, true),
    view.getFloat64(211, true),
  ];
  const min: readonly [number, number, number] = [
    view.getFloat64(187, true),
    view.getFloat64(203, true),
    view.getFloat64(219, true),
  ];

  return {
    signature: "LASF",
    versionMajor,
    versionMinor,
    headerSize,
    offsetToPointData,
    vlrCount,
    pointDataRecordFormat,
    pointDataRecordLength,
    pointCount,
    scale,
    offset,
    min,
    max,
    isCompressedLaz,
  };
}

/** Parse the first COPC Info VLR (`userId: "copc"`, `recordId: 1`) at `headerSize`. Pure. */
export function parseCopcInfoVlr(bytes: Uint8Array, headerOffset = LAS_14_HEADER_BYTES): CopcInfo | undefined {
  if (bytes.byteLength < headerOffset + VLR_HEADER_BYTES + COPC_INFO_VLR_BYTES) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const userId = decodeAscii(bytes, headerOffset + 2, 16).replace(/\0+$/, "");
  const recordId = view.getUint16(headerOffset + 18, true);
  const recordLength = view.getUint16(headerOffset + 20, true);
  if (userId !== "copc" || recordId !== 1 || recordLength < COPC_INFO_VLR_BYTES) {
    return undefined;
  }
  const payload = headerOffset + VLR_HEADER_BYTES;
  return {
    center: [view.getFloat64(payload, true), view.getFloat64(payload + 8, true), view.getFloat64(payload + 16, true)],
    halfSize: view.getFloat64(payload + 24, true),
    spacing: view.getFloat64(payload + 32, true),
    rootHierarchyOffset: readSafeUint64(view, payload + 40),
    rootHierarchySize: readSafeUint64(view, payload + 48),
    gpstimeMinimum: view.getFloat64(payload + 56, true),
    gpstimeMaximum: view.getFloat64(payload + 64, true),
  };
}

function resolveCopcEndpointUrl(options: CopcRangeClientOptions): string {
  if (options.copcUrl !== undefined) {
    const trimmed = options.copcUrl.trim();
    if (!trimmed || trimmed.includes(EMPTY_SCENE_SEGMENT)) {
      throw new Error("Invalid copcUrl.");
    }
    return trimmed;
  }
  if (options.baseUrl && options.sceneId) {
    return buildSceneCopcUrl(options.baseUrl, options.sceneId);
  }
  throw new Error("createCopcRangeClient requires either copcUrl or both baseUrl and sceneId.");
}

function validateMaxRangeBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("maxRangeBytes must be a positive safe integer.");
  }
  return value;
}

function validateRange(range: CopcByteRange, maxRangeBytes: number): number {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start
  ) {
    throw new RangeError(`Invalid COPC byte range [${range.start}, ${range.end}].`);
  }
  const length = range.end - range.start + 1;
  if (length > maxRangeBytes) {
    throw new RangeError(`Requested COPC range (${length} bytes) exceeds maxRangeBytes (${maxRangeBytes}).`);
  }
  return length;
}

function decodeAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[offset + i] ?? 0);
  }
  return out;
}

function readSafeUint64(view: DataView, offset: number): number {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  const value = high * 2 ** 32 + low;
  if (!Number.isSafeInteger(value)) throw new Error("COPC uint64 exceeds JavaScript's safe integer range.");
  return value;
}
