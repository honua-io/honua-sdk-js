/**
 * Helpers shared across the per-protocol wire modules and the client's
 * transport core: header merging and the common OGC metadata query-param
 * builder plus CSV normalizers. Kept transport-agnostic so both
 * `HonuaClient` and the protocol modules can import them without a cycle.
 *
 * @module
 */

import { HonuaAbortError } from "./errors.js";
import type { HonuaAuthCredentials, OgcMetadataRequest } from "./types.js";

function appendHeaderEntries(headers: HeadersInit, setEntry: (key: string, value: string) => void): void {
  if (headers instanceof Headers) {
    for (const [key, value] of headers.entries()) {
      setEntry(key, value);
    }
    return;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      setEntry(key, value);
    }
    return;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) {
      continue;
    }
    setEntry(key, String(value));
  }
}

/**
 * Merge any number of `HeadersInit` values into a plain `Record<string,string>`,
 * with later entries overriding earlier ones case-insensitively while preserving
 * the latest casing. Accepts `Headers`, tuple arrays, and plain objects;
 * `undefined`/`null` object values are skipped.
 */
export function mergeHeaders(...headersList: Array<HeadersInit | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  const keysByLower = new Map<string, string>();
  const setEntry = (key: string, value: string): void => {
    const lower = key.toLowerCase();
    const existing = keysByLower.get(lower);
    if (existing !== undefined && existing !== key) {
      delete merged[existing];
    }
    keysByLower.set(lower, key);
    merged[key] = value;
  };

  for (const headers of headersList) {
    if (headers) {
      appendHeaderEntries(headers, setEntry);
    }
  }
  return merged;
}

/** Build the shared OGC metadata query params (`f` + caller `extraParams`). */
export function createOgcMetadataParams(request: OgcMetadataRequest): URLSearchParams {
  const params = new URLSearchParams();
  params.set("f", request.responseFormat ?? "json");
  if (request.extraParams) {
    for (const [key, value] of Object.entries(request.extraParams)) {
      params.set(key, String(value));
    }
  }
  return params;
}

/** Normalize a string-or-(string|number)-array value to a CSV string. */
export function normalizeCsv(value: string | readonly (string | number)[]): string {
  if (typeof value === "string") {
    return value;
  }
  return Array.from(value).join(",");
}

/** Normalize a string-or-string-array value to a CSV string. */
export function normalizeStringCsv(value: string | readonly string[]): string {
  return typeof value === "string" ? value : value.join(",");
}

/**
 * True when a GeoServices/FeatureServer response advertises more pages via
 * `exceededTransferLimit`. GeoServices servers clamp `resultRecordCount` to
 * their `maxRecordCount` and set this flag when more rows remain, so
 * offset-paginated fetch-all loops must keep paging while it is set — advancing
 * by the actual returned row count, never a fixed `page * pageSize` stride that
 * would skip the rows the server capped off — rather than stopping on the first
 * page that comes back shorter than the requested `pageSize`.
 */
export function responseExceededTransferLimit(response: unknown): boolean {
  return (
    typeof response === "object" &&
    response !== null &&
    (response as { exceededTransferLimit?: unknown }).exceededTransferLimit === true
  );
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Normalize a credential provider result into a canonical credential bag. */
export function normalizeAuthCredentials(
  value: HonuaAuthCredentials | string | null | undefined,
): HonuaAuthCredentials | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? { bearerToken: value } : undefined;
  }
  if (!value) return undefined;
  const apiKey = nonEmptyString(value.apiKey);
  const bearerToken = nonEmptyString(value.bearerToken);
  const authorization = nonEmptyString(value.authorization);
  if (!apiKey && !bearerToken && !authorization) return undefined;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(bearerToken ? { bearerToken } : {}),
    ...(authorization ? { authorization } : {}),
    ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
  };
}

/** Project normalized auth credentials onto outgoing request headers. */
export function authHeadersFromCredentials(credentials: HonuaAuthCredentials): Record<string, string> | undefined {
  const authorization =
    credentials.authorization ?? (credentials.bearerToken ? `Bearer ${credentials.bearerToken}` : undefined);
  if (!credentials.apiKey && !authorization) return undefined;
  return {
    ...(credentials.apiKey ? { "X-API-Key": credentials.apiKey } : {}),
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

/** Race a promise against an optional AbortSignal, rejecting with HonuaAbortError on abort. */
export function awaitAbortable<T>(value: T | Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const pending = Promise.resolve(value);
  if (!signal) return pending;
  if (signal.aborted) {
    void pending.catch(() => undefined);
    return Promise.reject(new HonuaAbortError());
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
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
