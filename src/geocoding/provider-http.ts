/**
 * Minimal shared HTTP helper for the third-party geocoding / routing provider
 * adapters. Mirrors the request semantics of the SDK's core clients — timeout
 * composition and the typed error envelope (`HonuaTimeoutError`,
 * `HonuaAbortError`, `HonuaNetworkError`, `HonuaHttpError`) — without pulling
 * the full request pipeline into these small subpath bundles.
 *
 * Unlike `HonuaGeocodingClient`, provider adapters never attach Honua
 * credentials, so the default fetch redirect behavior is safe here.
 *
 * @packageDocumentation
 */

import { HonuaAbortError, HonuaHttpError, HonuaNetworkError, HonuaTimeoutError } from "../core/errors.js";

/** Transport options shared by every provider adapter. @experimental */
export interface ProviderTransportOptions {
  /** Custom fetch implementation (testing, interception, auth bridges). */
  fetchFn?: typeof fetch;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/** @internal */
export interface ProviderRequestInit extends ProviderTransportOptions {
  /** Extra request headers (e.g. a Nominatim-policy `User-Agent`). */
  headers?: Record<string, string>;
  /** Label used in error messages, e.g. `"nominatim geocode"`. */
  label: string;
}

/**
 * GET a JSON document with the SDK's typed error mapping.
 *
 * @internal
 */
export async function providerGetJson<T>(url: string, init: ProviderRequestInit): Promise<T> {
  // Bind to `globalThis` at call time: invoking an unbound `window.fetch`
  // throws "TypeError: Illegal invocation" in browsers.
  const fetchFn = (init.fetchFn ?? fetch).bind(globalThis);
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (init.timeoutMs !== undefined) {
    timeoutId = setTimeout(() => controller.abort(), init.timeoutMs);
  }

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json", ...init.headers },
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      if (init.timeoutMs !== undefined) {
        throw new HonuaTimeoutError(init.timeoutMs);
      }
      throw new HonuaAbortError();
    }
    throw new HonuaNetworkError(
      err instanceof Error
        ? `${init.label} request failed: ${err.message}`
        : `${init.label} request failed due to a network error`,
      err,
    );
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => null);
    }
    throw new HonuaHttpError(response.status, `${init.label} request failed with status ${response.status}`, body, {
      responseHeaders: response.headers,
    });
  }

  try {
    return (await response.json()) as T;
  } catch (err: unknown) {
    throw new HonuaNetworkError(`${init.label} response was not valid JSON`, err);
  }
}

/** Strip trailing slashes so adapters can join paths deterministically. @internal */
export function trimProviderBaseUrl(baseUrl: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === "/") {
    end -= 1;
  }
  const trimmed = baseUrl.slice(0, end);
  if (!trimmed) {
    throw new Error("Provider baseUrl must be a non-empty URL (no default third-party endpoint is baked in).");
  }
  return trimmed;
}

/** Stringify provider attributes to the contract `Record<string, string | null>` shape. @internal */
export function stringifyProviderAttributes(attrs: Record<string, unknown>): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) {
      continue;
    }
    result[key] = value === null ? null : String(value);
  }
  return result;
}
