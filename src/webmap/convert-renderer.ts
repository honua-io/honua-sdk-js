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
import {
  type RendererConversionOptions,
  type VisualVariableLegend,
  bindRendererField,
  compileVisualVariables,
} from "../style/visual-variables.js";
import { convertSymbol, esriLineStyleToDashArray } from "./convert-symbol.js";
import type { WebMapClassBreaksRenderer, WebMapRenderer, WebMapSymbol, WebMapUniqueValueRenderer } from "./types.js";
import type { WarningCollector } from "./warnings.js";

export interface RendererConversionResult {
  layerType: string;
  paint: Record<string, unknown>;
  layout: Record<string, unknown>;
  additionalLayers?: { layerType: string; paint: Record<string, unknown>; layout: Record<string, unknown> }[];
  visualVariableLegends?: VisualVariableLegend[];
}

export function convertRenderer(
  renderer: WebMapRenderer | undefined,
  warn: WarningCollector,
  options: RendererConversionOptions = {},
): RendererConversionResult | undefined {
  if (!renderer) return undefined;

  switch (renderer.type) {
    case "simple":
      return applyVisualVariables(
        convertRendererSymbol((renderer as { symbol?: WebMapSymbol }).symbol, warn, renderer.visualVariables),
        renderer,
        warn,
        options,
      );
    case "uniqueValue":
      return convertUniqueValueRenderer(renderer as WebMapUniqueValueRenderer, warn, options);
    case "classBreaks":
      return convertClassBreaksRenderer(renderer as WebMapClassBreaksRenderer, warn, options);
    default:
      warn.warn("unsupported-renderer", `Unsupported renderer type: ${renderer.type}`, { type: renderer.type });
      compileVisualVariables(renderer.visualVariables, "unknown", {}, warn, options);
      return undefined;
  }
}

function convertUniqueValueRenderer(
  renderer: WebMapUniqueValueRenderer,
  warn: WarningCollector,
  options: RendererConversionOptions,
): RendererConversionResult | undefined {
  const infos = renderer.uniqueValueInfos ?? [];
  if (infos.length === 0) {
    return applyVisualVariables(
      convertRendererSymbol(renderer.defaultSymbol, warn, renderer.visualVariables),
      renderer,
      warn,
      options,
    );
  }
  const rendererObject = uniqueValueRendererFromWebMap(renderer, warn, options);
  if (!rendererObject) return undefined;
  return compileRendererObject(rendererObject);
}

function convertClassBreaksRenderer(
  renderer: WebMapClassBreaksRenderer,
  warn: WarningCollector,
  options: RendererConversionOptions,
): RendererConversionResult | undefined {
  const breaks = renderer.classBreakInfos ?? [];
  if (breaks.length === 0) {
    return applyVisualVariables(
      convertRendererSymbol(renderer.defaultSymbol, warn, renderer.visualVariables),
      renderer,
      warn,
      options,
    );
  }
  const rendererObject = classBreaksRendererFromWebMap(renderer, warn, options);
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
  options: RendererConversionOptions = {},
): UniqueValueRenderer | undefined {
  warnRendererSemantics(renderer, warn);
  const infos = renderer.uniqueValueInfos ?? [];
  if (infos.length === 0) {
    compileVisualVariables(renderer.visualVariables, "unknown", {}, warn, options);
    return undefined;
  }

  // The first valid symbol determines the layer type.
  const firstResult = convertRendererSymbol(infos[0].symbol, warn, renderer.visualVariables);
  if (!firstResult) {
    compileVisualVariables(renderer.visualVariables, "unknown", {}, warn, options);
    return undefined;
  }

  const values: UniqueValueEntry[] = [];
  for (const info of infos) {
    const symbolResult = convertRendererSymbol(info.symbol, warn, renderer.visualVariables);
    if (!symbolResult) continue;
    values.push({
      value: info.value as string | number,
      ...(info.label !== undefined ? { label: info.label } : {}),
      style: { paint: symbolResult.paint, layout: symbolResult.layout },
    });
  }

  const base = uniqueValueRenderer({
    field: bindRendererField(renderer.field1 ?? "", options),
    ...(renderer.field2 !== undefined ? { field2: bindRendererField(renderer.field2, options) } : {}),
    ...(renderer.field3 !== undefined ? { field3: bindRendererField(renderer.field3, options) } : {}),
    ...(renderer.fieldDelimiter !== undefined ? { fieldDelimiter: renderer.fieldDelimiter } : {}),
    values,
    ...(renderer.defaultLabel !== undefined ? { defaultLabel: renderer.defaultLabel } : {}),
    ...defaultStyleFromSymbol(renderer.defaultSymbol, warn, renderer.visualVariables),
    layerType: firstResult.layerType,
  });
  if (renderer.visualVariables === undefined) return base;
  return uniqueValueRenderer({
    ...base.toJSON(),
    visualVariableStyle: compileVisualVariables(
      renderer.visualVariables,
      firstResult.layerType,
      base.toMapLibre("polygon")[0].paint,
      warn,
      options,
      ...outlineFromRenderer(renderer, options, warn),
    ),
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
  options: RendererConversionOptions = {},
): ClassBreaksRenderer | undefined {
  warnRendererSemantics(renderer, warn);
  const breaks = renderer.classBreakInfos ?? [];
  if (breaks.length === 0) {
    compileVisualVariables(renderer.visualVariables, "unknown", {}, warn, options);
    return undefined;
  }

  const firstResult = convertRendererSymbol(breaks[0].symbol, warn, renderer.visualVariables);
  if (!firstResult) {
    compileVisualVariables(renderer.visualVariables, "unknown", {}, warn, options);
    return undefined;
  }

  const field = renderer.field;
  if (!field) {
    warn.warn("missing-field", "classBreaks renderer missing field property");
    compileVisualVariables(renderer.visualVariables, "unknown", {}, warn, options);
    return undefined;
  }

  const entries = [];
  for (const brk of breaks) {
    const symbolResult = convertRendererSymbol(brk.symbol, warn, renderer.visualVariables);
    if (!symbolResult) continue;
    entries.push({
      ...(brk.classMinValue !== undefined ? { min: brk.classMinValue } : {}),
      ...(brk.classMaxValue !== undefined ? { max: brk.classMaxValue } : {}),
      ...(brk.label !== undefined ? { label: brk.label } : {}),
      style: { paint: symbolResult.paint, layout: symbolResult.layout },
    });
  }

  const base = classBreaksRenderer({
    field: bindRendererField(field, options),
    breaks: entries,
    ...(renderer.defaultLabel !== undefined ? { defaultLabel: renderer.defaultLabel } : {}),
    ...defaultStyleFromSymbol(renderer.defaultSymbol, warn, renderer.visualVariables),
    layerType: firstResult.layerType,
  });
  if (renderer.visualVariables === undefined) return base;
  return classBreaksRenderer({
    ...base.toJSON(),
    visualVariableStyle: compileVisualVariables(
      renderer.visualVariables,
      firstResult.layerType,
      base.toMapLibre("polygon")[0].paint,
      warn,
      options,
      ...outlineFromRenderer(renderer, options, warn),
    ),
  });
}

function defaultStyleFromSymbol(
  defaultSymbol: WebMapSymbol | undefined,
  warn: WarningCollector,
  variables: unknown,
): { defaultStyle?: RendererStyle } {
  if (!defaultSymbol) return {};
  const converted = convertRendererSymbol(defaultSymbol, warn, variables);
  // A default symbol that fails conversion still overrides the first-entry
  // fallback: every property defaults to "transparent" (legacy behavior).
  return { defaultStyle: converted ? { paint: converted.paint, layout: converted.layout } : {} };
}

function compileRendererObject(renderer: ClassBreaksRenderer | UniqueValueRenderer): RendererConversionResult {
  // The descriptor carries the symbol-derived layer type, so the geometry
  // argument is inert here; "polygon" is an arbitrary stand-in.
  const [fragment, ...additional] = renderer.toMapLibre("polygon");
  return {
    layerType: fragment.type,
    paint: fragment.paint,
    layout: fragment.layout,
    ...(additional.length
      ? { additionalLayers: additional.map((f) => ({ layerType: f.type, paint: f.paint, layout: f.layout })) }
      : {}),
    ...(renderer.visualVariableLegends?.().length
      ? { visualVariableLegends: [...renderer.visualVariableLegends()] }
      : {}),
  };
}

function applyVisualVariables(
  base: RendererConversionResult | undefined,
  renderer: WebMapRenderer,
  warn: WarningCollector,
  options: RendererConversionOptions,
): RendererConversionResult | undefined {
  const variables = compileVisualVariables(
    renderer.visualVariables,
    base?.layerType ?? "unknown",
    base?.paint ?? {},
    warn,
    options,
    ...outlineFromRenderer(renderer, options, warn),
  );
  if (!base) return undefined;
  const paint = { ...base.paint, ...variables.paint };
  return {
    ...base,
    paint,
    ...(variables.outline ? { additionalLayers: [{ layerType: "line", ...variables.outline }] } : {}),
    ...(variables.legends.length ? { visualVariableLegends: variables.legends } : {}),
  };
}

function warnRendererSemantics(renderer: WebMapRenderer, warn: WarningCollector): void {
  for (const property of ["valueExpression", "normalizationField", "normalizationType", "normalizationTotal"]) {
    if (renderer[property] != null && renderer[property] !== "")
      warn
        .child(property)
        .warn(
          "unsupported-renderer-semantics",
          `Renderer ${property} is unsupported; the base field renderer is a fallback that requires review.`,
        );
  }
}

function convertRendererSymbol(
  symbol: WebMapSymbol | undefined,
  warn: WarningCollector,
  variables: unknown,
): RendererConversionResult | undefined {
  const result = convertSymbol(symbol, warn);
  if (!result || !symbol || !Array.isArray(variables) || variables.length === 0) return result;
  const colorProperty = ({ fill: "fill-color", line: "line-color", circle: "circle-color" } as Record<string, string>)[
    result.layerType
  ];
  const color = symbol.color;
  if (colorProperty && Array.isArray(color) && color.length === 4) {
    result.paint[colorProperty] = `rgba(${color[0]},${color[1]},${color[2]},${Number(color[3]) / 255})`;
    if (result.layerType === "fill") delete result.paint["fill-opacity"];
  }
  for (const property of ["line-width", "circle-radius", "circle-stroke-width"]) {
    if (typeof result.paint[property] === "number") result.paint[property] = (result.paint[property] * 96) / 72;
  }
  const outline = symbol.outline as { color?: unknown } | undefined;
  const outlineColor = outline?.color;
  if (Array.isArray(outlineColor) && outlineColor.length === 4) {
    const property = result.layerType === "fill" ? "fill-outline-color" : "circle-stroke-color";
    result.paint[property] =
      `rgba(${outlineColor[0]},${outlineColor[1]},${outlineColor[2]},${Number(outlineColor[3]) / 255})`;
  }
  return result;
}

function outlineFromRenderer(
  renderer: WebMapRenderer,
  options: RendererConversionOptions,
  warn: WarningCollector,
): [unknown, Record<string, unknown>] {
  const variables = renderer.visualVariables;
  if (!Array.isArray(variables) || !variables.some((v) => v?.type === "sizeInfo" && v?.target === "outline"))
    return [0, {}];
  const symbols =
    renderer.type === "simple"
      ? [{ symbol: renderer.symbol as WebMapSymbol | undefined, path: "symbol" }]
      : renderer.type === "classBreaks"
        ? ((renderer as WebMapClassBreaksRenderer).classBreakInfos ?? []).map((entry, i) => ({
            symbol: entry.symbol,
            path: `classBreakInfos[${i}].symbol`,
          }))
        : ((renderer as WebMapUniqueValueRenderer).uniqueValueInfos ?? []).map((entry, i) => ({
            symbol: entry.symbol,
            path: `uniqueValueInfos[${i}].symbol`,
          }));
  if (renderer.defaultSymbol) symbols.push({ symbol: renderer.defaultSymbol as WebMapSymbol, path: "defaultSymbol" });
  const styles = symbols.map(({ symbol, path }) => ({
    style: (symbol?.outline as { style?: string } | undefined)?.style ?? "esriSLSSolid",
    path,
  }));
  const firstStyle = styles[0]?.style ?? "esriSLSSolid";
  const paint: Record<string, unknown> = {};
  for (const { style, path } of styles) {
    if (style !== firstStyle || (style !== "esriSLSSolid" && !esriLineStyleToDashArray(style))) {
      warn
        .child(`${path}.outline.style`)
        .warn(
          "unsupported-renderer-semantics",
          "Varying or unknown polygon outline dash styles require separate layers; review the converted outline style.",
        );
    }
  }
  if (firstStyle === "esriSLSNull") paint["line-opacity"] = 0;
  else {
    const dash = esriLineStyleToDashArray(firstStyle);
    if (dash) paint["line-dasharray"] = dash;
  }
  const width = (symbol: WebMapSymbol | undefined): number => {
    const outline = symbol?.outline as { width?: unknown } | undefined;
    return typeof outline?.width === "number" ? (outline.width * 96) / 72 : 0;
  };
  if (renderer.type === "simple") return [width(renderer.symbol as WebMapSymbol | undefined), paint];
  if (renderer.type === "classBreaks") {
    const input = renderer as WebMapClassBreaksRenderer;
    if (!input.field || !input.classBreakInfos?.length) return [width(input.defaultSymbol), paint];
    return [
      classBreaksRenderer({
        field: bindRendererField(input.field, options),
        breaks: input.classBreakInfos.map((entry) => ({
          min: entry.classMinValue,
          max: entry.classMaxValue,
          style: { paint: { "line-width": width(entry.symbol) } },
        })),
        ...(input.defaultSymbol ? { defaultStyle: { paint: { "line-width": width(input.defaultSymbol) } } } : {}),
      }).toMapLibre("line")[0].paint["line-width"],
      paint,
    ];
  }
  const input = renderer as WebMapUniqueValueRenderer;
  if (!input.uniqueValueInfos?.length) return [width(input.defaultSymbol), paint];
  return [
    uniqueValueRenderer({
      field: bindRendererField(input.field1 ?? "", options),
      field2: input.field2 ? bindRendererField(input.field2, options) : undefined,
      field3: input.field3 ? bindRendererField(input.field3, options) : undefined,
      fieldDelimiter: input.fieldDelimiter,
      values: input.uniqueValueInfos.map((entry) => ({
        value: entry.value,
        style: { paint: { "line-width": width(entry.symbol) } },
      })),
      ...(input.defaultSymbol ? { defaultStyle: { paint: { "line-width": width(input.defaultSymbol) } } } : {}),
    }).toMapLibre("line")[0].paint["line-width"],
    paint,
  ];
}
