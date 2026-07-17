/** Shared, fail-closed GeoServices metadata request boundary. */

import { honuaMetadataRequestHeaders } from "./core/cache-state.js";
import type { HonuaCacheReadMode } from "./core/cache-state.js";
import type { HonuaClient } from "./core/client.js";
import { HonuaAbortError, HonuaDiscoveryError, HonuaHttpError, HonuaNetworkError } from "./core/errors.js";

export interface GeoServicesMetadataAvailable {
  readonly kind: "available";
  readonly value: Readonly<Record<string, unknown>>;
  /** Validated credential-free authority that actually produced the metadata. */
  readonly source: string;
}

export interface GeoServicesMetadataSecured {
  readonly kind: "secured";
  readonly statusCode: number;
  /** Requested authority; redirects are refused before credentials are replayed. */
  readonly source: string;
}

export type GeoServicesMetadataOutcome = GeoServicesMetadataAvailable | GeoServicesMetadataSecured;

/** Exact cache directive supported by raw GeoServices service discovery. */
export interface GeoServicesMetadataRequestOptions {
  /**
   * "bypass" adds no-store/no-cache request headers. Raw service discovery does
   * not own an SDK-local metadata cache, so TTL and stale-fallback controls are
   * deliberately not part of this contract.
   */
  readonly cache?: HonuaCacheReadMode;
}

export interface GeoServicesMetadataOptions {
  readonly signal?: AbortSignal;
  readonly refresh?: boolean;
  readonly metadata?: GeoServicesMetadataRequestOptions;
}

/** Maximum decoded response bytes accepted before JSON parsing. */
export const HONUA_GEOSERVICES_METADATA_MAX_BYTES = 1_048_576;

/**
 * Read one GeoServices JSON metadata document through the credential-safe
 * client boundary. HTTP 401/403 and ArcGIS token statuses 498/499 are retained
 * as structured secured outcomes; every other malformed/error response fails.
 *
 * The response stream is capped before allocation/JSON parsing. Redirects are
 * refused rather than replaying credentials, and a successful response's final
 * URL must exactly match the requested metadata authority and path.
 *
 * @internal
 */
export async function getGeoServicesMetadata(
  client: HonuaClient,
  clientBaseUrl: string,
  endpoint: string,
  options: GeoServicesMetadataOptions,
): Promise<GeoServicesMetadataOutcome> {
  throwIfAborted(options.signal);
  validateMetadataRequestOptions(options.metadata);
  const path = appendJsonFormat(clientRelativePath(clientBaseUrl, endpoint));
  try {
    const response = await client.pipelineFetch(
      "GET",
      path,
      {
        headers: honuaMetadataRequestHeaders({
          refresh: options.refresh === true,
          bypass: options.metadata?.cache === "bypass",
        }),
      },
      options.signal,
      { redirect: "manual", discardErrorBody: true },
    );
    throwIfAborted(options.signal);
    const source = validateMetadataResponseUrl(response, endpoint);
    const value = await readBoundedJson(response, options.signal);
    throwIfAborted(options.signal);
    const body = requireRecord(value, "GeoServices metadata");
    validateMetadataBounds(body);
    const serviceError = readOwn(body, "error");
    if (isRecord(serviceError)) {
      const rawCode = readOwn(serviceError, "code");
      const code = Number.isSafeInteger(rawCode) ? (rawCode as number) : undefined;
      if (code !== undefined && [401, 403, 498, 499].includes(code)) {
        return Object.freeze({ kind: "secured" as const, statusCode: code, source });
      }
      throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices metadata returned an error object.", {
        ...(code !== undefined ? { code } : {}),
      });
    }
    return Object.freeze({ kind: "available" as const, value: body, source });
  } catch (error) {
    if (options.signal?.aborted || error instanceof HonuaAbortError) throw error;
    if (error instanceof HonuaNetworkError && error.message.includes("opaque")) {
      throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices metadata redirects are not allowed.");
    }
    if (error instanceof HonuaHttpError && [401, 403, 498, 499].includes(error.statusCode)) {
      return Object.freeze({ kind: "secured" as const, statusCode: error.statusCode, source: endpoint });
    }
    if (error instanceof HonuaHttpError) {
      const redirected = error.statusCode >= 300 && error.statusCode < 400;
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        redirected ? "GeoServices metadata redirects are not allowed." : "GeoServices metadata request failed.",
        { statusCode: error.statusCode },
      );
    }
    throw error;
  }
}

function validateMetadataRequestOptions(options: GeoServicesMetadataRequestOptions | undefined): void {
  if (options === undefined) return;
  if (!isRecord(options)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices metadata options must be an object.");
  }
  const keys = Reflect.ownKeys(options);
  if (keys.some((key) => key !== "cache")) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "GeoServices metadata options support only the cache directive; TTL and stale fallback require an owned metadata cache.",
    );
  }
  const cache = readOwn(options, "cache");
  if (cache !== undefined && cache !== "default" && cache !== "bypass") {
    throw new HonuaDiscoveryError("invalid-endpoint", 'GeoServices metadata cache must be "default" or "bypass".');
  }
}

function appendJsonFormat(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}f=json`;
}

function validateMetadataResponseUrl(response: Response, endpoint: string): string {
  if (response.redirected) {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices metadata redirects are not allowed.");
  }
  const expected = new URL(endpoint);
  let actual: URL;
  try {
    actual = response.url ? new URL(response.url) : new URL(endpoint);
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices metadata returned an invalid response URL.");
  }
  const formatQueryIsSafe =
    actual.searchParams.size === 0 ||
    [...actual.searchParams].every(
      ([name, value]) =>
        (name.toLowerCase() === "f" || name.toLowerCase() === "format") &&
        (value.toLowerCase() === "json" || value.toLowerCase() === "pjson"),
    );
  const expectedPath = expected.pathname.replace(/\/$/, "");
  const actualPath = actual.pathname.replace(/\/$/, "");
  if (
    actual.origin !== expected.origin ||
    actualPath !== expectedPath ||
    actual.username ||
    actual.password ||
    actual.hash ||
    !formatQueryIsSafe
  ) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "GeoServices metadata response authority or service path does not match the requested endpoint.",
    );
  }
  return `${actual.origin}${actualPath}`;
}

async function readBoundedJson(response: Response, signal: AbortSignal | undefined): Promise<unknown> {
  const advertisedLength = response.headers.get("content-length")?.trim();
  if (advertisedLength && /^\d+$/.test(advertisedLength)) {
    const length = Number(advertisedLength);
    if (!Number.isSafeInteger(length) || length > HONUA_GEOSERVICES_METADATA_MAX_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      rejectOversizedResponse();
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    const abort = () => void reader.cancel().catch(() => undefined);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        throwIfAborted(signal);
        if (done) break;
        total += value.byteLength;
        if (total > HONUA_GEOSERVICES_METADATA_MAX_BYTES) {
          void reader.cancel().catch(() => undefined);
          rejectOversizedResponse();
        }
        chunks.push(value);
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices metadata must be valid UTF-8 JSON.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices metadata must be a valid JSON object.");
  }
}

function rejectOversizedResponse(): never {
  throw new HonuaDiscoveryError(
    "invalid-endpoint",
    `GeoServices metadata exceeds the ${HONUA_GEOSERVICES_METADATA_MAX_BYTES}-byte response limit.`,
  );
}

const MAX_METADATA_DEPTH = 32;
const MAX_METADATA_NODES = 50_000;
const MAX_METADATA_ARRAY_LENGTH = 10_000;
const MAX_METADATA_OBJECT_KEYS = 10_000;
const MAX_METADATA_STRING_LENGTH = 65_536;
const MAX_METADATA_TOTAL_STRING_LENGTH = 1_000_000;

/** Bound already-parsed metadata so irrelevant attacker-controlled branches cannot exhaust projection work. */
function validateMetadataBounds(value: unknown): void {
  let nodes = 0;
  let stringLength = 0;
  const seen = new WeakSet<object>();

  const visit = (entry: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_METADATA_NODES || depth > MAX_METADATA_DEPTH) rejectOversizedMetadata();
    if (typeof entry === "string") {
      stringLength += entry.length;
      if (entry.length > MAX_METADATA_STRING_LENGTH || stringLength > MAX_METADATA_TOTAL_STRING_LENGTH) {
        rejectOversizedMetadata();
      }
      return;
    }
    if (entry === null || typeof entry === "number" || typeof entry === "boolean") return;
    if (typeof entry !== "object") {
      throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices metadata contains an unsupported value.");
    }
    if (seen.has(entry)) {
      throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices metadata must not contain cycles.");
    }
    seen.add(entry);
    if (Array.isArray(entry)) {
      if (entry.length > MAX_METADATA_ARRAY_LENGTH) rejectOversizedMetadata();
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    const record = requireRecord(entry, "GeoServices metadata value");
    const descriptors = Object.getOwnPropertyDescriptors(record);
    const keys = Object.keys(descriptors);
    if (keys.length > MAX_METADATA_OBJECT_KEYS) rejectOversizedMetadata();
    for (const key of keys) {
      stringLength += key.length;
      if (key.length > MAX_METADATA_STRING_LENGTH || stringLength > MAX_METADATA_TOTAL_STRING_LENGTH) {
        rejectOversizedMetadata();
      }
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) {
        throw new HonuaDiscoveryError("invalid-endpoint", `GeoServices metadata property "${key}" must be data.`);
      }
      visit(descriptor.value, depth + 1);
    }
  };

  visit(value, 0);
}

function rejectOversizedMetadata(): never {
  throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices metadata exceeds discovery bounds.");
}

function clientRelativePath(clientBaseUrl: string, endpoint: string): string {
  const base = new URL(clientBaseUrl);
  const target = new URL(endpoint);
  if (base.origin !== target.origin) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "GeoServices metadata endpoint does not match the client origin.",
    );
  }
  const basePath = base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "");
  if (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices metadata endpoint does not match the client root.");
  }
  return target.pathname.slice(basePath.length) || "/";
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new HonuaDiscoveryError("invalid-endpoint", `${label} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readOwn(record: Readonly<Record<string, unknown>>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if ("get" in descriptor) {
    throw new HonuaDiscoveryError("invalid-endpoint", `GeoServices metadata property "${key}" must be data.`);
  }
  return descriptor.value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}
