/**
 * Converts Esri WebMap extents/viewpoints to MapLibre center/zoom.
 *
 * Supports Web Mercator (WKID 3857 / 102100) and geographic (4326).
 * Unsupported spatial references emit warnings and are skipped.
 *
 * @module
 */

import type { WebMapExtent, WebMapPoint, WebMapViewpoint } from "./types.js";
import type { WarningCollector } from "./warnings.js";

export interface ExtentConversionResult {
  center: [number, number];
  zoom: number;
}

const WEB_MERCATOR_WKIDS = new Set([3857, 102100, 102113]);
const EARTH_RADIUS = 6378137;
const ORIGIN_SHIFT = Math.PI * EARTH_RADIUS; // ~20037508.34

export function convertInitialViewpoint(
  viewpoint: WebMapViewpoint | undefined,
  warn: WarningCollector,
): ExtentConversionResult | undefined {
  if (!viewpoint?.targetGeometry) return undefined;

  const target = viewpoint.targetGeometry;
  if (isExtent(target)) {
    const extentResult = convertExtent(target, warn.child("targetGeometry"));
    if (!extentResult) return undefined;
    if (viewpoint.scale != null) {
      return {
        center: extentResult.center,
        zoom: scaleToZoom(viewpoint.scale),
      };
    }
    return extentResult;
  }

  if (isPoint(target)) {
    return convertPointViewpoint(target, viewpoint.scale, warn.child("targetGeometry"));
  }

  warn.warn("unsupported-viewpoint-geometry", "initialViewpoint.targetGeometry must be a point or extent");
  return undefined;
}

export function convertExtent(
  extent: WebMapExtent | undefined,
  warn: WarningCollector,
): ExtentConversionResult | undefined {
  if (!extent) return undefined;

  const wkid = extent.spatialReference?.latestWkid ?? extent.spatialReference?.wkid;

  if (wkid && !WEB_MERCATOR_WKIDS.has(wkid)) {
    // Check if it looks like geographic (4326)
    if (wkid === 4326) {
      return convertGeographicExtent(extent);
    }
    warn.warn(
      "unsupported-spatial-reference",
      `Spatial reference WKID ${wkid} not supported; expected Web Mercator (3857)`,
      { wkid },
    );
    return undefined;
  }

  // Default assumption: if no SR specified and values are small, treat as geographic
  if (!wkid && Math.abs(extent.xmin) <= 180 && Math.abs(extent.xmax) <= 180) {
    return convertGeographicExtent(extent);
  }

  // Web Mercator → geographic
  return convertMercatorExtent(extent);
}

function convertPointViewpoint(
  point: WebMapPoint,
  scale: number | undefined,
  warn: WarningCollector,
): ExtentConversionResult | undefined {
  const wkid = point.spatialReference?.latestWkid ?? point.spatialReference?.wkid;

  if (wkid && !WEB_MERCATOR_WKIDS.has(wkid) && wkid !== 4326) {
    warn.warn(
      "unsupported-spatial-reference",
      `Spatial reference WKID ${wkid} not supported; expected Web Mercator (3857) or WGS84 (4326)`,
      { wkid },
    );
    return undefined;
  }

  const isGeographic = wkid === 4326 || (!wkid && Math.abs(point.x) <= 180 && Math.abs(point.y) <= 90);
  const center: [number, number] = isGeographic
    ? [point.x, point.y]
    : [round6(mercatorXToLng(point.x)), round6(mercatorYToLat(point.y))];

  return {
    center,
    zoom: scale != null ? scaleToZoom(scale) : 10,
  };
}

function convertGeographicExtent(extent: WebMapExtent): ExtentConversionResult {
  const centerLng = (extent.xmin + extent.xmax) / 2;
  const centerLat = (extent.ymin + extent.ymax) / 2;
  const lngSpan = extent.xmax - extent.xmin;
  // Approximate zoom from longitude span: 360/2^zoom ≈ lngSpan
  const zoom = lngSpan > 0 ? Math.round(Math.log2(360 / lngSpan) * 100) / 100 : 2;
  return { center: [centerLng, centerLat], zoom };
}

function convertMercatorExtent(extent: WebMapExtent): ExtentConversionResult {
  const centerX = (extent.xmin + extent.xmax) / 2;
  const centerY = (extent.ymin + extent.ymax) / 2;

  const centerLng = mercatorXToLng(centerX);
  const centerLat = mercatorYToLat(centerY);

  // Zoom from mercator extent width
  const xSpan = extent.xmax - extent.xmin;
  const fullWidth = ORIGIN_SHIFT * 2;
  const zoom = xSpan > 0 ? Math.round(Math.log2(fullWidth / xSpan) * 100) / 100 : 2;

  return {
    center: [round6(centerLng), round6(centerLat)],
    zoom,
  };
}

function scaleToZoom(scale: number): number {
  if (scale <= 0) return 0;
  return Math.round(Math.log2(559082264 / scale) * 100) / 100;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function isExtent(value: WebMapExtent | WebMapPoint): value is WebMapExtent {
  return (
    typeof (value as { xmin?: unknown }).xmin === "number" &&
    typeof (value as { ymin?: unknown }).ymin === "number" &&
    typeof (value as { xmax?: unknown }).xmax === "number" &&
    typeof (value as { ymax?: unknown }).ymax === "number"
  );
}

function isPoint(value: WebMapExtent | WebMapPoint): value is WebMapPoint {
  return typeof (value as { x?: unknown }).x === "number" && typeof (value as { y?: unknown }).y === "number";
}

function mercatorXToLng(x: number): number {
  return (x / ORIGIN_SHIFT) * 180;
}

function mercatorYToLat(y: number): number {
  let lat = (y / ORIGIN_SHIFT) * 180;
  lat = (180 / Math.PI) * (2 * Math.atan(Math.exp((lat * Math.PI) / 180)) - Math.PI / 2);
  return lat;
}
