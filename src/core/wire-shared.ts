/**
 * Helpers shared across the per-protocol wire modules and the client's
 * transport core: header merging and the common OGC metadata query-param
 * builder plus CSV normalizers. Kept transport-agnostic so both
 * `HonuaClient` and the protocol modules can import them without a cycle.
 *
 * @module
 */

import type { OgcMetadataRequest } from "./types.js";

/**
 * Merge any number of `HeadersInit` values into a plain `Record<string,string>`,
 * with later entries overriding earlier ones. Accepts `Headers`, tuple arrays,
 * and plain objects; `undefined`/`null` object values are skipped.
 */
export function mergeHeaders(...headersList: Array<HeadersInit | undefined>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const headers of headersList) {
    if (!headers) {
      continue;
    }

    if (headers instanceof Headers) {
      for (const [key, value] of headers.entries()) {
        merged[key] = value;
      }
      continue;
    }

    if (Array.isArray(headers)) {
      for (const [key, value] of headers) {
        merged[key] = value;
      }
      continue;
    }

    for (const [key, value] of Object.entries(headers)) {
      if (value === undefined || value === null) {
        continue;
      }
      merged[key] = String(value);
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
