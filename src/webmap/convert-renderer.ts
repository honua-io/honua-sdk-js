/**
 * Converts Esri renderer JSON to MapLibre paint/layout properties.
 *
 * Since issue #497 this module emits first-class renderer objects
 * (`src/style/renderers.ts`) for uniqueValue/classBreaks renderers and
 * compiles them through the shared `/expr`-based compiler, so WebMap
 * conversion, esri-compat, and standalone renderer objects share a single
 * implementation. The compiled style output is unchanged.
 *
 * @module
 */

import type { ClassBreaksRenderer, RendererStyle, UniqueValueEntry, UniqueValueRenderer } from "../style/renderers.js";
import { classBreaksRenderer, uniqueValueRenderer } from "../style/renderers.js";
import { convertSymbol } from "./convert-symbol.js";
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
  const rendererObject = uniqueValueRendererFromWebMap(renderer, warn);
  if (!rendererObject) return undefined;
  return compileRendererObject(rendererObject);
}

function convertClassBreaksRenderer(
  renderer: WebMapClassBreaksRenderer,
  warn: WarningCollector,
): RendererConversionResult | undefined {
  const breaks = renderer.classBreakInfos ?? [];
  if (breaks.length === 0) {
    return convertSymbol(renderer.defaultSymbol, warn);
  }
  const rendererObject = classBreaksRendererFromWebMap(renderer, warn);
  if (!rendererObject) return undefined;
  return compileRendererObject(rendererObject);
}

/**
 * Build a first-class unique-value renderer object from WebMap renderer
 * JSON. Returns `undefined` when the renderer has no value infos or the
 * first symbol cannot be converted (matching `convertRenderer` behavior).
 *
 * @experimental
 */
export function uniqueValueRendererFromWebMap(
  renderer: WebMapUniqueValueRenderer,
  warn: WarningCollector,
): UniqueValueRenderer | undefined {
  const infos = renderer.uniqueValueInfos ?? [];
  if (infos.length === 0) return undefined;

  // The first valid symbol determines the layer type.
  const firstResult = convertSymbol(infos[0].symbol, warn);
  if (!firstResult) return undefined;

  const values: UniqueValueEntry[] = [];
  for (const info of infos) {
    const symbolResult = convertSymbol(info.symbol, warn);
    if (!symbolResult) continue;
    values.push({
      value: info.value as string | number,
      ...(info.label !== undefined ? { label: info.label } : {}),
      style: { paint: symbolResult.paint, layout: symbolResult.layout },
    });
  }

  return uniqueValueRenderer({
    field: renderer.field1 ?? "",
    ...(renderer.field2 !== undefined ? { field2: renderer.field2 } : {}),
    ...(renderer.field3 !== undefined ? { field3: renderer.field3 } : {}),
    ...(renderer.fieldDelimiter !== undefined ? { fieldDelimiter: renderer.fieldDelimiter } : {}),
    values,
    ...(renderer.defaultLabel !== undefined ? { defaultLabel: renderer.defaultLabel } : {}),
    ...defaultStyleFromSymbol(renderer.defaultSymbol, warn),
    layerType: firstResult.layerType,
  });
}

/**
 * Build a first-class class-breaks renderer object from WebMap renderer
 * JSON. Returns `undefined` when the renderer has no break infos, no field,
 * or the first symbol cannot be converted (matching `convertRenderer`
 * behavior).
 *
 * @experimental
 */
export function classBreaksRendererFromWebMap(
  renderer: WebMapClassBreaksRenderer,
  warn: WarningCollector,
): ClassBreaksRenderer | undefined {
  const breaks = renderer.classBreakInfos ?? [];
  if (breaks.length === 0) return undefined;

  const firstResult = convertSymbol(breaks[0].symbol, warn);
  if (!firstResult) return undefined;

  const field = renderer.field;
  if (!field) {
    warn.warn("missing-field", "classBreaks renderer missing field property");
    return undefined;
  }

  const entries = [];
  for (const brk of breaks) {
    const symbolResult = convertSymbol(brk.symbol, warn);
    if (!symbolResult) continue;
    entries.push({
      ...(brk.classMinValue !== undefined ? { min: brk.classMinValue } : {}),
      ...(brk.classMaxValue !== undefined ? { max: brk.classMaxValue } : {}),
      ...(brk.label !== undefined ? { label: brk.label } : {}),
      style: { paint: symbolResult.paint, layout: symbolResult.layout },
    });
  }

  return classBreaksRenderer({
    field,
    breaks: entries,
    ...(renderer.defaultLabel !== undefined ? { defaultLabel: renderer.defaultLabel } : {}),
    ...defaultStyleFromSymbol(renderer.defaultSymbol, warn),
    layerType: firstResult.layerType,
  });
}

function defaultStyleFromSymbol(
  defaultSymbol: WebMapSymbol | undefined,
  warn: WarningCollector,
): { defaultStyle?: RendererStyle } {
  if (!defaultSymbol) return {};
  const converted = convertSymbol(defaultSymbol, warn);
  // A default symbol that fails conversion still overrides the first-entry
  // fallback: every property defaults to "transparent" (legacy behavior).
  return { defaultStyle: converted ? { paint: converted.paint, layout: converted.layout } : {} };
}

function compileRendererObject(renderer: ClassBreaksRenderer | UniqueValueRenderer): RendererConversionResult {
  // The descriptor carries the symbol-derived layer type, so the geometry
  // argument is inert here; "polygon" is an arbitrary stand-in.
  const [fragment] = renderer.toMapLibre("polygon");
  return { layerType: fragment.type, paint: fragment.paint, layout: fragment.layout };
}
