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
  const url = requireLocatorUrl(descriptor);
  const tileSize = options.tileSize ?? 256;
  const format = options.format ?? "image/png";
  const transparent = options.transparent ?? true;
  const params = new URLSearchParams();
  params.set("SERVICE", "WMS");
  params.set("VERSION", "1.3.0");
  params.set("REQUEST", "GetMap");
  params.set("LAYERS", descriptor.locator.typeName ?? "");
  params.set("STYLES", descriptor.locator.styleId ?? "");
  params.set("CRS", "EPSG:3857");
  params.set("FORMAT", format);
  params.set("TRANSPARENT", String(transparent).toUpperCase());
  const template = `${url}?${params.toString()}&BBOX={bbox-epsg3857}&WIDTH={width}&HEIGHT={height}`;
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
    tileSize: options.tileSize ?? 256,
    scheme: "xyz",
    ...(options.minzoom !== undefined ? { minzoom: options.minzoom } : {}),
    ...(options.maxzoom !== undefined ? { maxzoom: options.maxzoom } : {}),
    ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
  };
}

function requireLocatorUrl(descriptor: SourceDescriptor): string {
  const url = descriptor.locator.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new TypeError(`descriptor for "${descriptor.id}" is missing locator.url`);
  }
  return url;
}
