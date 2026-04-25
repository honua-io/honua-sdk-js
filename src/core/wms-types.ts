/**
 * Public request/response envelopes for the WMS / WMTS first-party
 * adapter. Kept in their own module so the canonical SDK surface
 * (`src/contract/index.ts`, `src/runtime/index.ts`, `src/index.ts`) can
 * re-export them without dragging the runtime classes into trees that
 * never reference WMS.
 *
 * @module
 */

import type { HonuaTypedFeature } from "./types.js";

// ── WMS request/response envelopes ────────────────────────────

/**
 * Coordinate reference system identifier accepted by WMS 1.3 endpoints.
 * `EPSG:4326`, `EPSG:3857`, `CRS:84` are first-party; any other string is
 * accepted but the adapter will trust the caller for axis order.
 */
export type WmsCrs = "EPSG:4326" | "EPSG:3857" | "CRS:84" | (string & {});

/** WMS 1.3 GetMap request envelope. */
export interface WmsMapRequest {
  /** Layer names. Multiple layers are serialized as a comma-separated `LAYERS=` value. */
  layers: readonly string[];
  /**
   * Style names. When present the array length must match `layers`. An
   * empty array (or a missing entry) selects the layer's default style.
   */
  styles?: readonly string[];
  /** CRS code. Defaults to `EPSG:3857`. */
  crs?: WmsCrs;
  /**
   * Bounding box in the requested CRS. Tuple is the canonical
   * `[minx, miny, maxx, maxy]` shape; the adapter swaps axis order when
   * the CRS is `EPSG:4326` (lat,lon) per WMS 1.3 §6.7.3.2.
   */
  bbox: readonly [number, number, number, number];
  width: number;
  height: number;
  /** Image MIME type. Defaults to `image/png`. */
  format?: string;
  /** Whether the rendered image should be transparent. Defaults to `true`. */
  transparent?: boolean;
  /** WMS `TIME` dimension override; falls back to the layer default. */
  time?: string;
  /** WMS `ELEVATION` dimension override. */
  elevation?: string;
  /** Background colour as `0xRRGGBB` or `#RRGGBB`. */
  bgcolor?: string;
  /** Vendor extras forwarded verbatim on the wire. */
  extraParams?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

/** WMS 1.3 GetFeatureInfo request envelope. */
export interface WmsFeatureInfoRequest extends WmsMapRequest {
  /** Layers to query. Subset of `layers`. */
  queryLayers: readonly string[];
  /** Pixel column offset within the rendered image. */
  i: number;
  /** Pixel row offset within the rendered image. */
  j: number;
  /** `INFO_FORMAT` MIME type. Defaults to `application/json`. */
  infoFormat?: "application/json" | "text/plain" | "text/html" | (string & {});
  /** Maximum features to return. */
  featureCount?: number;
}

/** WMS GetLegendGraphic request envelope. */
export interface WmsLegendRequest {
  layer: string;
  style?: string;
  format?: string;
  width?: number;
  height?: number;
  signal?: AbortSignal;
  extraParams?: Record<string, string | number | boolean>;
}

/**
 * Decoded GetFeatureInfo response. `features` carries the canonical
 * typed-feature shape when the wire response was JSON; non-JSON content
 * is exposed through `bytes` so the protocol escape hatch still owns the
 * raw payload.
 */
export interface HonuaWmsFeatureInfoResponse<T = Record<string, unknown>> {
  contentType: string;
  /** Decoded features when `infoFormat` was `application/json`. */
  features?: ReadonlyArray<HonuaTypedFeature<T>>;
  /** Raw bytes for non-JSON info formats (text/plain, html, …). */
  bytes?: Uint8Array;
}

/** Raw bytes returned by `GetMap` / `GetLegendGraphic`. */
export interface HonuaWmsImageResponse {
  bytes: Uint8Array;
  contentType: string;
}

// ── WMTS request envelopes ────────────────────────────────────

/** Routing mode for `GetTile`. honua-server advertises both. */
export type WmtsTileMode = "kvp" | "rest";

/** WMTS 1.0 GetTile request envelope. */
export interface WmtsTileRequest {
  layer: string;
  /** Style identifier. Defaults to `default`. */
  style?: string;
  /** TileMatrixSet identifier. Defaults to `WebMercatorQuad`. */
  tileMatrixSet?: string;
  /** TileMatrix identifier (zoom level). */
  tileMatrix: string | number;
  tileRow: number;
  tileCol: number;
  /** Image MIME type. Defaults to `image/png`. */
  format?: string;
  /** Routing mode. Defaults to `rest`. */
  mode?: WmtsTileMode;
  signal?: AbortSignal;
  extraParams?: Record<string, string | number | boolean>;
}

/** WMTS 1.0 GetFeatureInfo request envelope. */
export interface WmtsFeatureInfoRequest extends WmtsTileRequest {
  i: number;
  j: number;
  infoFormat?: "application/json" | "text/plain" | "text/html" | (string & {});
}

/** Raw bytes returned by a WMTS `GetTile`. */
export interface HonuaWmtsTileResponse {
  bytes: Uint8Array;
  contentType: string;
  /** True when the server returned a non-error empty payload (sparse tile). */
  empty: boolean;
}

/** WMTS GetFeatureInfo response (mirrors WMS). */
export type HonuaWmtsFeatureInfoResponse<T = Record<string, unknown>> = HonuaWmsFeatureInfoResponse<T>;
