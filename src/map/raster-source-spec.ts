import type { SourceDescriptor } from "../contract/types.js";
import { wmtsExtensionForFormat } from "../core/wms-types.js";

const DEFAULT_RASTER_TILE_SIZE = 256;
const MAX_RASTER_TILE_SIZE = 4_096;
const CREDENTIAL_QUERY_KEYS = new Set([
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "authtoken",
  "awsaccesskeyid",
  "bearer",
  "bearertoken",
  "clientsecret",
  "code",
  "credential",
  "expires",
  "googleaccessid",
  "idtoken",
  "jwt",
  "key",
  "keypairid",
  "password",
  "passwd",
  "privatekey",
  "policy",
  "pwd",
  "refreshtoken",
  "sas",
  "secret",
  "se",
  "session",
  "sessionid",
  "sig",
  "signature",
  "sp",
  "subscriptionkey",
  "sv",
  "token",
]);
const WMS_REQUEST_KEYS = new Set([
  "BBOX",
  "CRS",
  "FORMAT",
  "HEIGHT",
  "LAYERS",
  "REQUEST",
  "SERVICE",
  "SRS",
  "STYLES",
  "TRANSPARENT",
  "VERSION",
  "WIDTH",
]);

export interface RasterSourceSpecOptions {
  readonly tileSize?: number;
  readonly format?: string;
}

export interface WmsRasterSourceSpecOptions extends RasterSourceSpecOptions {
  readonly transparent?: boolean;
}

export interface WmtsRasterSourceSpecOptions extends RasterSourceSpecOptions {
  readonly minzoom?: number;
  readonly maxzoom?: number;
}

export interface MapLibreRasterSourceSpec {
  readonly type: "raster";
  readonly tiles: readonly string[];
  readonly tileSize: number;
  readonly scheme?: "xyz";
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly attribution?: string;
}

/** Build a MapLibre raster source containing a WMS 1.3 GetMap template. */
export function buildWmsRasterSourceSpec(
  descriptor: SourceDescriptor,
  options: WmsRasterSourceSpecOptions = {},
): MapLibreRasterSourceSpec {
  const endpoint = requireSafeWmsLocatorUrl(descriptor);
  const tileSize = validateRasterTileSize(options.tileSize ?? DEFAULT_RASTER_TILE_SIZE);
  const format = options.format ?? "image/png";
  const transparent = options.transparent ?? true;
  const params = new URLSearchParams(endpoint.search);
  for (const key of [...params.keys()]) {
    if (WMS_REQUEST_KEYS.has(key.toUpperCase())) params.delete(key);
  }
  params.set("SERVICE", "WMS");
  params.set("VERSION", "1.3.0");
  params.set("REQUEST", "GetMap");
  params.set("LAYERS", descriptor.locator.typeName ?? "");
  params.set("STYLES", descriptor.locator.styleId ?? "");
  params.set("CRS", "EPSG:3857");
  params.set("FORMAT", format);
  params.set("TRANSPARENT", String(transparent).toUpperCase());
  endpoint.search = "";
  const template = `${endpoint.toString()}?${params.toString()}&BBOX={bbox-epsg-3857}&WIDTH=${tileSize}&HEIGHT=${tileSize}`;
  return {
    type: "raster",
    tiles: [template],
    tileSize,
    ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
  };
}

/** Build a MapLibre raster source containing a RESTful WMTS tile template. */
export function buildWmtsRasterSourceSpec(
  descriptor: SourceDescriptor,
  options: WmtsRasterSourceSpecOptions = {},
): MapLibreRasterSourceSpec {
  const url = requireLocatorUrl(descriptor);
  const ext = wmtsExtensionForFormat(options.format ?? "image/png");
  const layer = descriptor.locator.typeName ?? "";
  const style = descriptor.locator.styleId ?? "default";
  const tms = descriptor.locator.tileMatrixSetId ?? "WebMercatorQuad";
  return {
    type: "raster",
    tiles: [
      `${url}/${encodeURIComponent(layer)}/${encodeURIComponent(style)}/${encodeURIComponent(tms)}/{z}/{y}/{x}.${ext}`,
    ],
    tileSize: options.tileSize ?? DEFAULT_RASTER_TILE_SIZE,
    scheme: "xyz",
    ...(options.minzoom !== undefined ? { minzoom: options.minzoom } : {}),
    ...(options.maxzoom !== undefined ? { maxzoom: options.maxzoom } : {}),
    ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
  };
}

/** Return whether a URL is safe to embed in a browser-owned raster source. */
export function isSafeMapLibreRasterEndpoint(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash) {
      return false;
    }
    return [...url.searchParams.keys()].every((key) => !isCredentialQueryKey(key));
  } catch {
    return false;
  }
}

/** Validate a browser raster tileSize; WMS mirrors it into image dimensions. */
export function validateRasterTileSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RASTER_TILE_SIZE) {
    throw new RangeError(`tileSize must be a safe integer from 1 through ${MAX_RASTER_TILE_SIZE}.`);
  }
  return value;
}

function requireSafeWmsLocatorUrl(descriptor: SourceDescriptor): URL {
  const value = descriptor.locator.url;
  if (!isSafeMapLibreRasterEndpoint(value)) {
    throw new TypeError(
      `descriptor for "${descriptor.id}" must use a credential-free HTTP(S) locator.url without a fragment`,
    );
  }
  return new URL(value);
}

function isCredentialQueryKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
  return CREDENTIAL_QUERY_KEYS.has(normalized) || normalized.startsWith("xamz") || normalized.startsWith("xgoog");
}

function requireLocatorUrl(descriptor: SourceDescriptor): string {
  const url = descriptor.locator.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new TypeError(`descriptor for "${descriptor.id}" is missing locator.url`);
  }
  return url;
}
