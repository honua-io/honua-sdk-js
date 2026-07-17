/** Internal executable-raster evidence shared by live discovery and cache replay. */

import type { DiscoveryAxisOrderMetadata, DiscoveryTileMatrixMetadata } from "./contract/discovery.js";

const WEB_MERCATOR_HALF_WORLD = 20_037_508.342789244;
const GOOGLE_MAPS_COMPATIBLE_SCALE_0 = 559_082_264.0287178;
const GOOGLE_MAPS_TILE_SIZE = 256;

export interface RasterTileMatrixSetEvidence {
  readonly id: string;
  readonly crs?: string;
  readonly wellKnownScaleSet?: string;
  readonly matrices: readonly DiscoveryTileMatrixMetadata[];
  /** Live parser evidence; absent cached metadata was already fail-closed before storage. */
  readonly complete?: boolean;
}

/** Whether an advertised CRS identifier is exactly an EPSG:3857 identifier. */
export function isAdvertisedWebMercatorCrs(value: string | undefined): boolean {
  return matchesCrs(value, "epsg", "3857");
}

/** Axis order advertised by the small WMS 1.3 CRS set the SDK can prove. */
export function advertisedWmsAxisOrder(crs: string): DiscoveryAxisOrderMetadata["order"] {
  if (matchesCrs(crs, "ogc", "crs84")) return "xy";
  if (matchesCrs(crs, "epsg", "4326")) return "yx";
  if (matchesCrs(crs, "epsg", "3857")) return "xy";
  return "unknown";
}

/** Map a proven GoogleMapsCompatible matrix identifier sequence to MapLibre zooms. */
export function mapLibreTileMatrixTemplate(ids: readonly string[]): string | undefined {
  if (ids.length === 0) return undefined;
  let prefix: string | undefined;
  for (const [index, id] of ids.entries()) {
    const match = /^(.*?)(0|[1-9]\d*)$/.exec(id);
    if (!match || match[2] !== String(index)) return undefined;
    if (prefix === undefined) prefix = match[1];
    else if (prefix !== match[1]) return undefined;
  }
  return `${prefix ?? ""}{z}`;
}

/**
 * Return why a matrix set cannot be executed by MapLibre, or undefined when
 * every advertised invariant proves the GoogleMapsCompatible pyramid.
 */
export function mapLibreMatrixSetUnavailableReason(matrixSet: RasterTileMatrixSetEvidence): string | undefined {
  if (matrixSet.complete === false) {
    return `WMTS tile matrix set "${matrixSet.id}" contains malformed matrix metadata and is not executable.`;
  }
  if (!isAdvertisedWebMercatorCrs(matrixSet.crs)) {
    return `WMTS tile matrix set "${matrixSet.id}" does not advertise an exact EPSG:3857 CRS.`;
  }
  if (!isGoogleMapsCompatibleScaleSet(matrixSet.wellKnownScaleSet)) {
    return `WMTS tile matrix set "${matrixSet.id}" does not advertise the exact GoogleMapsCompatible well-known scale set.`;
  }
  const template = mapLibreTileMatrixTemplate(matrixSet.matrices.map((matrix) => matrix.id));
  if (!template) {
    return `WMTS tile matrix set "${matrixSet.id}" has identifiers that cannot map exactly to MapLibre zoom levels.`;
  }
  for (const [zoom, matrix] of matrixSet.matrices.entries()) {
    const integers = [matrix.tileWidth, matrix.tileHeight, matrix.matrixWidth, matrix.matrixHeight];
    if (integers.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      return `WMTS tile matrix set "${matrixSet.id}" contains non-positive or unsafe integer dimensions.`;
    }
    if (!Number.isFinite(matrix.scaleDenominator) || matrix.scaleDenominator <= 0) {
      return `WMTS tile matrix set "${matrixSet.id}" contains a non-positive or non-finite scale denominator.`;
    }
    if (matrix.tileWidth !== GOOGLE_MAPS_TILE_SIZE || matrix.tileHeight !== GOOGLE_MAPS_TILE_SIZE) {
      return `WMTS tile matrix set "${matrixSet.id}" does not use 256 by 256 GoogleMapsCompatible tiles.`;
    }
    const expectedDimension = 2 ** zoom;
    if (
      !Number.isSafeInteger(expectedDimension) ||
      matrix.matrixWidth !== expectedDimension ||
      matrix.matrixHeight !== expectedDimension
    ) {
      return `WMTS tile matrix set "${matrixSet.id}" dimensions do not progress with MapLibre zoom levels.`;
    }
    if (
      !nearlyEqual(matrix.topLeftCorner[0], -WEB_MERCATOR_HALF_WORLD, 1e-6, 1e-12) ||
      !nearlyEqual(matrix.topLeftCorner[1], WEB_MERCATOR_HALF_WORLD, 1e-6, 1e-12)
    ) {
      return `WMTS tile matrix set "${matrixSet.id}" does not use the GoogleMapsCompatible Web Mercator origin.`;
    }
    const expectedScale = GOOGLE_MAPS_COMPATIBLE_SCALE_0 / 2 ** zoom;
    if (!nearlyEqual(matrix.scaleDenominator, expectedScale, 1e-6, 1e-10)) {
      return `WMTS tile matrix set "${matrixSet.id}" scale denominators do not progress with MapLibre resolutions.`;
    }
  }
  return undefined;
}

function isGoogleMapsCompatibleScaleSet(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase().replace(/\/+$/, "");
  return (
    normalized === "urn:ogc:def:wkss:ogc:1.0:googlemapscompatible" ||
    /^https?:\/\/www\.opengis\.net\/def\/wkss\/ogc\/1\.0\/googlemapscompatible$/.test(normalized)
  );
}

function matchesCrs(value: string | undefined, authority: "epsg" | "ogc", code: string): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase().replace(/\/+$/, "");
  if (authority === "epsg" && normalized === `epsg:${code}`) return true;
  if (authority === "ogc" && normalized === `crs:${code.replace(/^crs/, "")}`) return true;
  const urn = new RegExp(`^urn:ogc:def:crs:${authority}:[^:]*:${code}$`);
  const uri = new RegExp(`^https?://www\\.opengis\\.net/def/crs/${authority}/[^/]+/${code}$`);
  return urn.test(normalized) || uri.test(normalized);
}

function nearlyEqual(actual: number, expected: number, absoluteTolerance: number, relativeTolerance: number): boolean {
  return Math.abs(actual - expected) <= Math.max(absoluteTolerance, Math.abs(expected) * relativeTolerance);
}
