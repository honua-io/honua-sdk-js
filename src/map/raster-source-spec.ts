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
const WMTS_REQUEST_KEYS = new Set([
  "FORMAT",
  "LAYER",
  "REQUEST",
  "SERVICE",
  "STYLE",
  "TILECOL",
  "TILEMATRIX",
  "TILEMATRIXSET",
  "TILEROW",
  "VERSION",
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
  const binding = descriptor.locator.raster;
  if (binding && binding.kind !== "wms-kvp") {
    throw new TypeError(`descriptor for "${descriptor.id}" carries a non-WMS raster binding`);
  }
  const endpoint = requireSafeRasterLocatorUrl(descriptor, binding?.url);
  const tileSize = validateRasterTileSize(options.tileSize ?? DEFAULT_RASTER_TILE_SIZE);
  const format = options.format ?? binding?.format ?? "image/png";
  if (binding && options.format !== undefined && options.format.toLowerCase() !== binding.format.toLowerCase()) {
    throw new TypeError(
      `descriptor for "${descriptor.id}" was discovered with WMS format "${binding.format}", not "${options.format}"`,
    );
  }
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
  const binding = descriptor.locator.raster;
  if (binding?.kind === "wms-kvp") {
    throw new TypeError(`descriptor for "${descriptor.id}" carries a non-WMTS raster binding`);
  }
  const url = requireSafeRasterLocatorUrl(descriptor, binding?.url).toString();
  const format = options.format ?? binding?.format ?? "image/png";
  if (binding && options.format !== undefined && options.format.toLowerCase() !== binding.format.toLowerCase()) {
    throw new TypeError(
      `descriptor for "${descriptor.id}" was discovered with WMTS format "${binding.format}", not "${options.format}"`,
    );
  }
  const ext = wmtsExtensionForFormat(format);
  const layer = descriptor.locator.typeName ?? "";
  const style = descriptor.locator.styleId ?? "default";
  const tms = descriptor.locator.tileMatrixSetId ?? "WebMercatorQuad";
  const tileUrl = binding
    ? binding.kind === "wmts-template"
      ? wmtsResourceTemplate(binding.url, layer, style, tms, binding.tileMatrixTemplate)
      : wmtsKvpTemplate(binding.url, layer, style, tms, format, binding.tileMatrixTemplate)
    : `${url}/${encodeURIComponent(layer)}/${encodeURIComponent(style)}/${encodeURIComponent(tms)}/{z}/{y}/{x}.${ext}`;
  return {
    type: "raster",
    tiles: [tileUrl],
    tileSize: validateRasterTileSize(options.tileSize ?? DEFAULT_RASTER_TILE_SIZE),
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

function requireSafeRasterLocatorUrl(descriptor: SourceDescriptor, discoveredUrl?: string): URL {
  const value = discoveredUrl ?? descriptor.locator.url;
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

function wmtsResourceTemplate(
  template: string,
  layer: string,
  style: string,
  tileMatrixSet: string,
  tileMatrix: string,
): string {
  return template
    .replaceAll("{Layer}", encodeURIComponent(layer))
    .replaceAll("{Style}", encodeURIComponent(style))
    .replaceAll("{TileMatrixSet}", encodeURIComponent(tileMatrixSet))
    .replaceAll("{TileMatrix}", encodeTemplateValue(tileMatrix))
    .replaceAll("{TileRow}", "{y}")
    .replaceAll("{TileCol}", "{x}");
}

function wmtsKvpTemplate(
  url: string,
  layer: string,
  style: string,
  tileMatrixSet: string,
  format: string,
  tileMatrix: string,
): string {
  const request = new URL(url);
  for (const key of [...request.searchParams.keys()]) {
    if (WMTS_REQUEST_KEYS.has(key.toUpperCase())) request.searchParams.delete(key);
  }
  request.searchParams.set("SERVICE", "WMTS");
  request.searchParams.set("VERSION", "1.0.0");
  request.searchParams.set("REQUEST", "GetTile");
  request.searchParams.set("LAYER", layer);
  request.searchParams.set("STYLE", style);
  request.searchParams.set("FORMAT", format);
  request.searchParams.set("TILEMATRIXSET", tileMatrixSet);
  return `${request.toString()}&TILEMATRIX=${encodeTemplateValue(tileMatrix)}&TILEROW={y}&TILECOL={x}`;
}

function encodeTemplateValue(value: string): string {
  return encodeURIComponent(value).replace(/%7Bz%7D/gi, "{z}");
}
