/**
 * Low-level transport surface consumed by the per-protocol wire modules.
 *
 * `HonuaClient` owns the request/retry/auth/cache pipeline (see
 * `executeRequest` and `request-pipeline.ts`); each protocol family
 * (OGC API Features/Tiles/Maps/Records/Processes, STAC, WMS, WMTS, and the
 * GeoServices map/feature endpoints) builds its own URLs, serializes its own
 * params, and parses its own responses against this injected transport rather
 * than reaching into the client. The client exposes a single object that
 * satisfies this interface and hands it to the wire functions, keeping the
 * client a thin facade over the protocol modules.
 *
 * @module
 */

import type { HonuaMetadataRequestOptions } from "./cache-state.js";
import type { QueryMethod } from "./types.js";

/**
 * The minimal request primitives a protocol wire module needs. Every method
 * routes through the same auth / retry / timeout / interceptor pipeline as the
 * rest of the SDK; wire modules never call `fetch` directly.
 */
export interface HonuaProtocolTransport {
  /**
   * Normalized base URL (trailing slashes trimmed). Pure URL-template builders
   * (e.g. MapLibre tile sources) read this to produce the same origin/base path
   * the server is served from.
   */
  readonly baseUrl: string;

  /**
   * Pipeline-aware JSON request. Sends `Accept: application/json` by default and
   * surfaces GeoServices `{error}` envelopes returned on HTTP 200 as
   * `HonuaHttpError`. Caller-supplied query params belong on `path`.
   */
  requestJson<T = unknown>(method: QueryMethod, path: string, init?: RequestInit, signal?: AbortSignal): Promise<T>;

  /**
   * Fetch a text response (XML / JSON / plain) with explicit Accept negotiation.
   * Used by the WMS / WMTS capabilities pipelines and the WFS adapter.
   */
  requestText(
    method: QueryMethod,
    path: string,
    options?: { accept?: string; contentType?: string; body?: BodyInit; signal?: AbortSignal },
  ): Promise<{ text: string; contentType: string; status: number }>;

  /**
   * Fetch a binary response (raw bytes plus content type). Used by the OGC API
   * Tiles / Maps and WMS / WMTS wire methods that negotiate non-JSON formats.
   */
  requestBytes(
    method: QueryMethod,
    path: string,
    accept: string | undefined,
    init?: RequestInit,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType: string; empty: boolean }>;

  /**
   * Cached metadata GET. Honors the metadata cache (`hit`/`miss`/`stale`/
   * `refreshed`/`bypass`), conditional revalidation, and stale-if-error.
   */
  requestCachedMetadataJson<T>(cacheKey: string, path: string, options?: HonuaMetadataRequestOptions): Promise<T>;

  /**
   * Pipeline-aware request returning the raw, unconsumed `Response` after the
   * shared pipeline succeeds. Callers pick `.json()` / `.text()` / `.arrayBuffer()`.
   */
  pipelineFetch(
    method: QueryMethod,
    path: string,
    init?: RequestInit,
    callerSignal?: AbortSignal,
    options?: { okStatuses?: readonly number[]; redirect?: "safe-follow" | "error" },
  ): Promise<Response>;

  /**
   * Request a PBF binary response and decode it, transparently falling back to
   * `f=json` on decode failure. Used by the GeoServices feature query fast path.
   */
  requestBinaryWithJsonFallback<T = unknown>(
    method: QueryMethod,
    path: string,
    params: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<T>;
}
