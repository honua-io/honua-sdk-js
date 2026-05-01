/**
 * Converts Esri symbol JSON to MapLibre paint/layout properties.
 *
 * @module
 */

import type { HonuaLayerSpecification } from "../style/specification.js";
import type {
  EsriColor,
  WebMapPictureMarkerSymbol,
  WebMapSimpleFillSymbol,
  WebMapSimpleLineSymbol,
  WebMapSimpleMarkerSymbol,
  WebMapSymbol,
  WebMapTextSymbol,
} from "./types.js";
import type { WarningCollector } from "./warnings.js";

// ── Color conversion ────────────────────────────────────────

/** Convert Esri `[r,g,b,a]` (a 0–255) to CSS `rgba()` string. */
export function esriColorToCss(color: EsriColor | undefined): string | undefined {
  if (!color || color.length < 4) return undefined;
  const [r, g, b, a] = color;
  const alpha = Math.round((a / 255) * 100) / 100;
  if (alpha === 1) return `rgb(${r},${g},${b})`;
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Line style mapping ──────────────────────────────────────

const LINE_DASH_MAP: Record<string, number[] | undefined> = {
  esriSLSSolid: undefined,
  esriSLSDash: [6, 4],
  esriSLSDot: [2, 4],
  esriSLSDashDot: [6, 4, 2, 4],
  esriSLSDashDotDot: [6, 4, 2, 4, 2, 4],
  esriSLSNull: [0, 10],
};

export function esriLineStyleToDashArray(style: string | undefined): number[] | undefined {
  if (!style) return undefined;
  return LINE_DASH_MAP[style];
}

// ── Symbol → layer conversion ───────────────────────────────

export interface SymbolConversionResult {
  layerType: string;
  paint: Record<string, unknown>;
  layout: Record<string, unknown>;
}

export function convertSymbol(
  symbol: WebMapSymbol | undefined,
  warn: WarningCollector,
): SymbolConversionResult | undefined {
  if (!symbol) return undefined;

  switch (symbol.type) {
    case "esriSFS":
      return convertSimpleFill(symbol as WebMapSimpleFillSymbol);
    case "esriSLS":
      return convertSimpleLine(symbol as WebMapSimpleLineSymbol);
    case "esriSMS":
      return convertSimpleMarker(symbol as WebMapSimpleMarkerSymbol);
    case "esriPMS":
      return convertPictureMarker(symbol as WebMapPictureMarkerSymbol, warn);
    case "esriTS":
      return convertTextSymbol(symbol as WebMapTextSymbol);
    default:
      warn.warn("unsupported-symbol", `Unsupported symbol type: ${symbol.type}`);
      return undefined;
  }
}

function convertSimpleFill(symbol: WebMapSimpleFillSymbol): SymbolConversionResult {
  const paint: Record<string, unknown> = {};
  const fillColor = esriColorToCss(symbol.color);
  if (fillColor) paint["fill-color"] = fillColor;

  if (symbol.color) {
    const alpha = symbol.color[3] / 255;
    if (alpha < 1) paint["fill-opacity"] = Math.round(alpha * 100) / 100;
  }

  if (symbol.outline) {
    const outlineColor = esriColorToCss(symbol.outline.color);
    if (outlineColor) paint["fill-outline-color"] = outlineColor;
  }

  return { layerType: "fill", paint, layout: {} };
}

function convertSimpleLine(symbol: WebMapSimpleLineSymbol): SymbolConversionResult {
  const paint: Record<string, unknown> = {};
  const layout: Record<string, unknown> = {};

  const lineColor = esriColorToCss(symbol.color);
  if (lineColor) paint["line-color"] = lineColor;
  if (symbol.width != null) paint["line-width"] = symbol.width;

  const dashArray = esriLineStyleToDashArray(symbol.style);
  if (dashArray) paint["line-dasharray"] = dashArray;

  return { layerType: "line", paint, layout };
}

function convertSimpleMarker(symbol: WebMapSimpleMarkerSymbol): SymbolConversionResult {
  const paint: Record<string, unknown> = {};

  const circleColor = esriColorToCss(symbol.color);
  if (circleColor) paint["circle-color"] = circleColor;
  if (symbol.size != null) paint["circle-radius"] = symbol.size / 2;

  if (symbol.outline) {
    const strokeColor = esriColorToCss(symbol.outline.color);
    if (strokeColor) paint["circle-stroke-color"] = strokeColor;
    if (symbol.outline.width != null) paint["circle-stroke-width"] = symbol.outline.width;
  }

  return { layerType: "circle", paint, layout: {} };
}

function convertPictureMarker(symbol: WebMapPictureMarkerSymbol, warn: WarningCollector): SymbolConversionResult {
  const layout: Record<string, unknown> = {};

  if (symbol.url) {
    layout["icon-image"] = symbol.url;
    warn.warn("sprite-required", "Picture marker symbol requires sprite setup for icon-image", { url: symbol.url });
  }
  if (symbol.width != null && symbol.height != null) {
    layout["icon-size"] = 1;
  }

  return { layerType: "symbol", paint: {}, layout };
}

function convertTextSymbol(symbol: WebMapTextSymbol): SymbolConversionResult {
  const paint: Record<string, unknown> = {};
  const layout: Record<string, unknown> = {};

  const textColor = esriColorToCss(symbol.color);
  if (textColor) paint["text-color"] = textColor;

  if (symbol.text) layout["text-field"] = symbol.text;
  if (symbol.font) {
    if (symbol.font.size != null) layout["text-size"] = symbol.font.size;
    if (symbol.font.family) layout["text-font"] = [symbol.font.family];
  }

  return { layerType: "symbol", paint, layout };
}
