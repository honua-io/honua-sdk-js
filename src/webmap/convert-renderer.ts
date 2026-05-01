/**
 * Converts Esri renderer JSON to MapLibre paint/layout properties.
 *
 * Handles simple, uniqueValue, and classBreaks renderers. Produces
 * data-driven expressions (match, step) for categorized/graduated renderers.
 *
 * @module
 */

import { type SymbolConversionResult, convertSymbol, esriColorToCss } from "./convert-symbol.js";
import type { WebMapClassBreaksRenderer, WebMapRenderer, WebMapSymbol, WebMapUniqueValueRenderer } from "./types.js";
import type { WarningCollector } from "./warnings.js";

export interface RendererConversionResult {
  layerType: string;
  paint: Record<string, unknown>;
  layout: Record<string, unknown>;
}

export function convertRenderer(
  renderer: WebMapRenderer | undefined,
  warn: WarningCollector,
): RendererConversionResult | undefined {
  if (!renderer) return undefined;

  switch (renderer.type) {
    case "simple":
      return convertSimpleRenderer((renderer as { symbol?: WebMapSymbol }).symbol, warn);
    case "uniqueValue":
      return convertUniqueValueRenderer(renderer as WebMapUniqueValueRenderer, warn);
    case "classBreaks":
      return convertClassBreaksRenderer(renderer as WebMapClassBreaksRenderer, warn);
    default:
      warn.warn("unsupported-renderer", `Unsupported renderer type: ${renderer.type}`, { type: renderer.type });
      return undefined;
  }
}

function convertSimpleRenderer(
  symbol: WebMapSymbol | undefined,
  warn: WarningCollector,
): RendererConversionResult | undefined {
  return convertSymbol(symbol, warn);
}

function convertUniqueValueRenderer(
  renderer: WebMapUniqueValueRenderer,
  warn: WarningCollector,
): RendererConversionResult | undefined {
  const infos = renderer.uniqueValueInfos ?? [];
  if (infos.length === 0) {
    return convertSymbol(renderer.defaultSymbol, warn);
  }

  // Determine the layer type from the first valid symbol
  const firstResult = convertSymbol(infos[0].symbol, warn);
  if (!firstResult) return undefined;
  const { layerType } = firstResult;

  // Build the field expression
  const fieldExpr = buildFieldExpression(renderer);

  // Build paint properties with match expressions
  const paintKeys = collectPaintKeys(infos, warn, layerType);
  const paint: Record<string, unknown> = {};
  const layout: Record<string, unknown> = {};

  for (const key of paintKeys) {
    const matchArgs: unknown[] = [fieldExpr];
    for (const info of infos) {
      const symbolResult = convertSymbol(info.symbol, warn);
      if (!symbolResult) continue;
      matchArgs.push(info.value);
      matchArgs.push(symbolResult.paint[key] ?? symbolResult.layout[key]);
    }
    // Default value from defaultSymbol or first symbol
    const defaultResult = renderer.defaultSymbol ? convertSymbol(renderer.defaultSymbol, warn) : firstResult;
    const defaultVal = defaultResult?.paint[key] ?? defaultResult?.layout[key] ?? "transparent";
    matchArgs.push(defaultVal);

    if (isLayoutProperty(key)) {
      layout[key] = ["match", ...matchArgs];
    } else {
      paint[key] = ["match", ...matchArgs];
    }
  }

  return { layerType, paint, layout };
}

function convertClassBreaksRenderer(
  renderer: WebMapClassBreaksRenderer,
  warn: WarningCollector,
): RendererConversionResult | undefined {
  const breaks = renderer.classBreakInfos ?? [];
  if (breaks.length === 0) {
    return convertSymbol(renderer.defaultSymbol, warn);
  }

  const firstResult = convertSymbol(breaks[0].symbol, warn);
  if (!firstResult) return undefined;
  const { layerType } = firstResult;

  const field = renderer.field;
  if (!field) {
    warn.warn("missing-field", "classBreaks renderer missing field property");
    return undefined;
  }

  const paintKeys = collectPaintKeysFromBreaks(breaks, warn, layerType);
  const paint: Record<string, unknown> = {};
  const layout: Record<string, unknown> = {};

  for (const key of paintKeys) {
    // Default value
    const defaultResult = renderer.defaultSymbol ? convertSymbol(renderer.defaultSymbol, warn) : firstResult;
    const defaultVal = defaultResult?.paint[key] ?? defaultResult?.layout[key] ?? "transparent";

    const stepArgs: unknown[] = [["get", field], defaultVal];
    for (const brk of breaks) {
      const symbolResult = convertSymbol(brk.symbol, warn);
      if (!symbolResult) continue;
      const threshold = brk.classMinValue ?? brk.classMaxValue;
      stepArgs.push(threshold);
      stepArgs.push(symbolResult.paint[key] ?? symbolResult.layout[key]);
    }

    if (isLayoutProperty(key)) {
      layout[key] = ["step", ...stepArgs];
    } else {
      paint[key] = ["step", ...stepArgs];
    }
  }

  return { layerType, paint, layout };
}

function buildFieldExpression(renderer: WebMapUniqueValueRenderer): unknown {
  if (!renderer.field2 && !renderer.field3) {
    return ["get", renderer.field1 ?? ""];
  }
  // Multi-field: concatenate with delimiter
  const delim = renderer.fieldDelimiter ?? ",";
  const fields: unknown[] = [];
  if (renderer.field1) fields.push(["get", renderer.field1]);
  if (renderer.field2) {
    fields.push(delim);
    fields.push(["get", renderer.field2]);
  }
  if (renderer.field3) {
    fields.push(delim);
    fields.push(["get", renderer.field3]);
  }
  return ["concat", ...fields];
}

function collectPaintKeys(infos: { symbol?: WebMapSymbol }[], warn: WarningCollector, layerType: string): Set<string> {
  const keys = new Set<string>();
  for (const info of infos) {
    const result = convertSymbol(info.symbol, warn);
    if (!result) continue;
    for (const k of Object.keys(result.paint)) keys.add(k);
    for (const k of Object.keys(result.layout)) keys.add(k);
  }
  return keys;
}

function collectPaintKeysFromBreaks(
  breaks: { symbol?: WebMapSymbol }[],
  warn: WarningCollector,
  layerType: string,
): Set<string> {
  return collectPaintKeys(breaks, warn, layerType);
}

const LAYOUT_PROPERTIES = new Set([
  "icon-image",
  "icon-size",
  "icon-offset",
  "icon-anchor",
  "icon-rotate",
  "text-field",
  "text-font",
  "text-size",
  "text-offset",
  "text-anchor",
  "text-max-width",
  "text-letter-spacing",
  "text-justify",
  "text-rotate",
  "symbol-placement",
  "symbol-spacing",
  "visibility",
]);

function isLayoutProperty(key: string): boolean {
  return LAYOUT_PROPERTIES.has(key);
}
