/** Shared, fail-closed GeoServices metadata request boundary. */

import { honuaMetadataRequestHeaders } from "./core/cache-state.js";
import type { HonuaMetadataRequestOptions } from "./core/cache-state.js";
import type { HonuaClient } from "./core/client.js";
import { HonuaAbortError, HonuaDiscoveryError, HonuaHttpError } from "./core/errors.js";

export interface GeoServicesMetadataAvailable {
  readonly kind: "available";
  readonly value: Readonly<Record<string, unknown>>;
}

export interface GeoServicesMetadataSecured {
  readonly kind: "secured";
  readonly statusCode: number;
}

export type GeoServicesMetadataOutcome = GeoServicesMetadataAvailable | GeoServicesMetadataSecured;

export interface GeoServicesMetadataOptions {
  readonly signal?: AbortSignal;
  readonly refresh?: boolean;
  readonly metadata?: Omit<HonuaMetadataRequestOptions, "signal" | "refresh">;
}

/**
 * Read one GeoServices JSON metadata document through the credential-safe
 * client boundary. HTTP 401/403 and ArcGIS token statuses 498/499 are retained
 * as structured secured outcomes; every other malformed/error response fails.
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
  try {
    const value = await client.request<unknown>({
      method: "GET",
      path: clientRelativePath(clientBaseUrl, endpoint),
      responseFormat: "json",
      headers: honuaMetadataRequestHeaders({
        refresh: options.refresh === true,
        bypass: options.metadata?.cache === "bypass",
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    throwIfAborted(options.signal);
    const body = requireRecord(value, "GeoServices metadata");
    const serviceError = readOwn(body, "error");
    if (isRecord(serviceError)) {
      const rawCode = readOwn(serviceError, "code");
      const code = Number.isSafeInteger(rawCode) ? (rawCode as number) : undefined;
      if (code !== undefined && [401, 403, 498, 499].includes(code)) {
        return Object.freeze({ kind: "secured" as const, statusCode: code });
      }
      throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices metadata returned an error object.", {
        ...(code !== undefined ? { code } : {}),
      });
    }
    return Object.freeze({ kind: "available" as const, value: body });
  } catch (error) {
    if (options.signal?.aborted || error instanceof HonuaAbortError) throw error;
    if (error instanceof HonuaHttpError && [401, 403, 498, 499].includes(error.statusCode)) {
      return Object.freeze({ kind: "secured" as const, statusCode: error.statusCode });
    }
    throw error;
  }
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
