import type { SourceDescriptor } from "../contract/types.js";
import { wmtsExtensionForFormat } from "../core/wms-types.js";

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
  const url = binding?.url ?? requireLocatorUrl(descriptor);
  const tileSize = options.tileSize ?? 256;
  const format = options.format ?? binding?.format ?? "image/png";
  const transparent = options.transparent ?? true;
  const request = new URL(url);
  request.searchParams.set("SERVICE", "WMS");
  request.searchParams.set("VERSION", "1.3.0");
  request.searchParams.set("REQUEST", "GetMap");
  request.searchParams.set("LAYERS", descriptor.locator.typeName ?? "");
  request.searchParams.set("STYLES", descriptor.locator.styleId ?? "");
  request.searchParams.set("CRS", "EPSG:3857");
  request.searchParams.set("FORMAT", format);
  request.searchParams.set("TRANSPARENT", String(transparent).toUpperCase());
  request.searchParams.delete("BBOX");
  request.searchParams.delete("WIDTH");
  request.searchParams.delete("HEIGHT");
  const template = `${request.toString()}&BBOX={bbox-epsg3857}&WIDTH={width}&HEIGHT={height}`;
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
  const url = requireLocatorUrl(descriptor);
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
    tileSize: options.tileSize ?? 256,
    scheme: "xyz",
    ...(options.minzoom !== undefined ? { minzoom: options.minzoom } : {}),
    ...(options.maxzoom !== undefined ? { maxzoom: options.maxzoom } : {}),
    ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
  };
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
  request.searchParams.set("SERVICE", "WMTS");
  request.searchParams.set("VERSION", "1.0.0");
  request.searchParams.set("REQUEST", "GetTile");
  request.searchParams.set("LAYER", layer);
  request.searchParams.set("STYLE", style);
  request.searchParams.set("FORMAT", format);
  request.searchParams.set("TILEMATRIXSET", tileMatrixSet);
  request.searchParams.delete("TILEMATRIX");
  request.searchParams.delete("TILEROW");
  request.searchParams.delete("TILECOL");
  return `${request.toString()}&TILEMATRIX=${encodeTemplateValue(tileMatrix)}&TILEROW={y}&TILECOL={x}`;
}

function encodeTemplateValue(value: string): string {
  return encodeURIComponent(value).replace(/%7Bz%7D/gi, "{z}");
}

function requireLocatorUrl(descriptor: SourceDescriptor): string {
  const url = descriptor.locator.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new TypeError(`descriptor for "${descriptor.id}" is missing locator.url`);
  }
  return url;
}
