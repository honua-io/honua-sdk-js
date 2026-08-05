/**
 * Converts Esri labelingInfo to MapLibre symbol layers.
 *
 * Supports basic Arcade expressions like `$feature.FIELD_NAME`.
 * Complex Arcade expressions emit a warning and are skipped.
 *
 * @module
 */

import type { HonuaLayerSpecification } from "../style/specification.js";
import { esriColorToCss } from "./convert-symbol.js";
import type { WebMapLabelClass, WebMapTextSymbol } from "./types.js";
import type { WarningCollector } from "./warnings.js";

export function convertLabelingInfo(
  labelClasses: WebMapLabelClass[] | undefined,
  sourceId: string,
  baseLayerId: string,
  warn: WarningCollector,
): HonuaLayerSpecification[] {
  if (!labelClasses || labelClasses.length === 0) return [];

  const layers: HonuaLayerSpecification[] = [];

  for (let i = 0; i < labelClasses.length; i++) {
    const lc = labelClasses[i];
    const lcWarn = warn.child(`labelingInfo[${i}]`);

    const textExpr = parseLabelExpression(lc, lcWarn);
    if (!textExpr) continue;

    const layer: HonuaLayerSpecification = {
      id: `${baseLayerId}-label-${i}`,
      type: "symbol",
      source: sourceId,
      layout: {
        "text-field": textExpr,
        "text-size": 12,
      },
      paint: {},
    };

    // Apply symbol styling
    if (lc.symbol) {
      applyTextSymbolStyle(lc.symbol, layer);
    }

    // Apply scale constraints
    if (lc.minScale) layer.maxzoom = scaleToZoom(lc.minScale);
    if (lc.maxScale) layer.minzoom = scaleToZoom(lc.maxScale);

    // Apply where clause as filter
    if (lc.where) {
      layer.metadata = { ...layer.metadata, esriWhere: lc.where };
    }

    layers.push(layer);
  }

  return layers;
}

const FEATURE_FIELD_RE = /^\$feature\.(\w+)$/;

function parseLabelExpression(lc: WebMapLabelClass, warn: WarningCollector): unknown | undefined {
  // Prefer labelExpressionInfo (Arcade-based)
  if (lc.labelExpressionInfo?.expression) {
    const expr = lc.labelExpressionInfo.expression;
    // Simple: $feature.FIELD_NAME
    const simple = expr.match(FEATURE_FIELD_RE);
    if (simple) {
      return ["get", simple[1]];
    }
    // Try concatenation patterns: $feature.A + " " + $feature.B
    if (expr.includes("$feature.") && !expr.includes("(")) {
      return parseSimpleConcatExpression(expr, warn);
    }
    warn.warn("complex-arcade", `Complex Arcade expression not supported: ${expr}`);
    return undefined;
  }

  // Fallback: labelExpression (e.g., "[FIELD_NAME]")
  if (lc.labelExpression) {
    const bracketMatch = lc.labelExpression.match(/^\[(\w+)\]$/);
    if (bracketMatch) {
      return ["get", bracketMatch[1]];
    }
    warn.warn("complex-label-expression", `Complex label expression not supported: ${lc.labelExpression}`);
    return undefined;
  }

  // Fallback: value template
  if (lc.labelExpressionInfo?.value) {
    const value = lc.labelExpressionInfo.value;
    const fieldMatch = value.match(/^\{(\w+)\}$/);
    if (fieldMatch) {
      return ["get", fieldMatch[1]];
    }
  }

  return undefined;
}

function parseSimpleConcatExpression(expr: string, warn: WarningCollector): unknown | undefined {
  // Handle: $feature.A + " " + $feature.B
  const parts = expr.split("+").map((p) => p.trim());
  const concatArgs: unknown[] = [];

  for (const part of parts) {
    const fieldMatch = part.match(FEATURE_FIELD_RE);
    if (fieldMatch) {
      concatArgs.push(["get", fieldMatch[1]]);
    } else if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
      concatArgs.push(part.slice(1, -1));
    } else {
      warn.warn("complex-arcade", `Cannot parse Arcade expression part: ${part}`);
      return undefined;
    }
  }

  if (concatArgs.length === 1) return concatArgs[0];
  return ["concat", ...concatArgs];
}

function applyTextSymbolStyle(symbol: WebMapTextSymbol, layer: HonuaLayerSpecification): void {
  if (symbol.color) {
    const color = esriColorToCss(symbol.color);
    if (color) (layer.paint as Record<string, unknown>)["text-color"] = color;
  }
  if (symbol.font) {
    const layout = layer.layout as Record<string, unknown>;
    if (symbol.font.size != null) layout["text-size"] = symbol.font.size;
    if (symbol.font.family) layout["text-font"] = [symbol.font.family];
  }
}

/** Approximate Esri scale denominator to MapLibre zoom level. */
function scaleToZoom(scale: number): number {
  if (scale <= 0) return 0;
  // Esri uses 96 DPI; at zoom 0, scale ≈ 559082264
  return Math.round(Math.log2(559082264 / scale) * 100) / 100;
}
