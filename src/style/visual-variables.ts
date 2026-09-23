import {
  Expr,
  type Resolvable,
  eq,
  exponential,
  get,
  interpolate,
  linear,
  rgba,
  switchCase,
  toNumber,
  typeOf,
  zoom,
} from "../expr/expression.js";
import type { WarningCollector } from "../webmap/warnings.js";

/** Explicit field bindings; omitted names retain their original spelling. */
export interface RendererConversionOptions {
  fieldMap?: Readonly<Record<string, string>>;
}

export interface VisualVariableLegend {
  type: "color" | "size";
  field?: string;
  title?: string;
  property: string;
  input: "field" | "scale";
  stops: { value: number; label: string; color?: string; size?: number }[];
  outOfRange: "clamp";
  missingValue: "base-symbol";
  /** Original property expression, including class/category fallback behavior. */
  missingValueStyle: unknown;
  /** Output sizes are CSS pixels (point markers use radius). */
  sizeUnit?: "css-pixels";
}

/** Serializable overlay shared by WebMap and compatibility renderer objects. */
export interface VisualVariableStyle {
  paint: Record<string, unknown>;
  outline?: { paint: Record<string, unknown>; layout: Record<string, unknown> };
  legends: VisualVariableLegend[];
}

/** ArcGIS Web Mercator scale at MapLibre zoom zero: 512 CSS pixels, 96 DPI.
 * This is projected scale, so latitude does not change it. Ground resolution
 * differs by cos(latitude); $view.scale is not a ground-distance measurement.
 */
export const WEB_MERCATOR_SCALE_AT_ZOOM_ZERO = (2 * Math.PI * 6378137 * 96) / (512 * 0.0254);

export function webMercatorScaleToZoom(scale: number): number {
  return Math.log2(WEB_MERCATOR_SCALE_AT_ZOOM_ZERO / scale);
}

export function compileVisualVariables(
  variables: unknown,
  layerType: string,
  basePaint: Record<string, unknown>,
  warn: WarningCollector,
  options: RendererConversionOptions = {},
  outlineWidth: unknown = 0,
  outlinePaint: Record<string, unknown> = {},
): VisualVariableStyle {
  const result: VisualVariableStyle = { paint: {}, legends: [] };
  if (variables === undefined) return result;
  if (!Array.isArray(variables)) {
    warn.child("visualVariables").warn("unsupported-visual-variable", "Expected a visualVariables array.");
    return result;
  }
  const assigned = new Set<string>();
  variables.forEach((input, index) => {
    const at = warn.child(`visualVariables[${index}]`);
    const reject = (message: string, property?: string) =>
      (property ? at.child(property) : at).warn("unsupported-visual-variable", message);
    if (!isRecord(input)) return reject("Expected a visual variable object.");
    const color = input.type === "colorInfo";
    if (!color && input.type !== "sizeInfo")
      return reject(`Unsupported visual variable type: ${String(input.type)}. Reauthor this variable.`, "type");
    for (const key of Object.keys(input)) {
      if (!KNOWN_PROPERTIES.has(key))
        return reject(`Unsupported visual variable property '${key}'; this variable was not applied.`, key);
    }
    if (
      color &&
      ["minDataValue", "maxDataValue", "minSize", "maxSize", "valueUnit"].some((key) => input[key] != null)
    ) {
      return reject("Size range properties cannot be applied to a colorInfo variable.");
    }
    const normalization = ["normalizationField", "normalizationType", "normalizationTotal"].find(
      (key) => input[key] != null,
    );
    if (normalization) {
      return reject(
        "Visual variable normalization is unsupported; precompute a numeric field and bind it explicitly.",
        normalization,
      );
    }
    const expression = input.valueExpression ?? input.expression;
    const scale = !color && (expression === "$view.scale" || expression === "view.scale");
    if (expression != null && !scale)
      return reject(
        "Unsupported visual variable expression; bind a numeric field or use $view.scale for sizeInfo.",
        input.valueExpression !== undefined ? "valueExpression" : "expression",
      );
    if (
      input.valueExpression !== undefined &&
      input.expression !== undefined &&
      !["$view.scale", "view.scale"].includes(String(input.expression))
    ) {
      return reject("Conflicting expression and valueExpression properties.", "expression");
    }
    if (!scale && (typeof input.field !== "string" || input.field.length === 0))
      return reject("A numeric field is required.", "field");
    if (input.valueUnit != null && input.valueUnit !== "unknown")
      return reject("Real-world size units are unsupported; provide a screen size ramp in points.", "valueUnit");
    const outline = !color && layerType === "fill" && input.target === "outline";
    if (input.target != null && !outline)
      return reject("Only sizeInfo on polygon outlines supports a target.", "target");
    const property = color
      ? ({ circle: "circle-color", line: "line-color", fill: "fill-color" } as Record<string, string>)[layerType]
      : outline
        ? "line-width"
        : ({ circle: "circle-radius", line: "line-width" } as Record<string, string>)[layerType];
    if (!property) return reject(`Unsupported ${String(input.type)} combination with ${layerType} symbols.`);
    if (assigned.has(property))
      return reject(`Multiple variables target ${property}; only the first supported variable is applied.`);
    let rawStops = input.stops;
    if (!color && rawStops === undefined)
      rawStops = [
        { value: input.minDataValue, size: input.minSize },
        { value: input.maxDataValue, size: input.maxSize },
      ];
    if (!Array.isArray(rawStops) || rawStops.length < 2)
      return reject("At least two strictly ascending stops are required.", "stops");
    const stops: { value: number; output: Resolvable; label: string; color?: string; size?: number }[] = [];
    for (let i = 0; i < rawStops.length; i++) {
      const stop = rawStops[i];
      if (
        !isRecord(stop) ||
        !finite(stop.value) ||
        (scale && stop.value <= 0) ||
        (i > 0 && stop.value <= stops[i - 1].value)
      )
        return reject("Stop values must be finite, strictly ascending, and positive for scale.", `stops[${i}].value`);
      for (const property of Object.keys(stop)) {
        if (!["value", "label", color ? "color" : "size"].includes(property)) {
          return reject(
            `Unsupported stop property '${property}'; this variable was not applied.`,
            `stops[${i}].${property}`,
          );
        }
      }
      const label = typeof stop.label === "string" ? stop.label : String(stop.value);
      if (color) {
        const c = stop.color;
        if (!Array.isArray(c) || c.length !== 4 || !c.every((v) => finite(v) && v >= 0 && v <= 255))
          return reject("Color stops require RGBA components in [0,255].", `stops[${i}].color`);
        const css = `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;
        stops.push({ value: stop.value, output: rgba(c[0], c[1], c[2], c[3] / 255), label, color: css });
      } else {
        if (!finite(stop.size) || stop.size < 0)
          return reject(
            "Size stops require a finite nonnegative size in points; nested scale ranges are unsupported.",
            `stops[${i}].size`,
          );
        const size = (stop.size * (96 / 72)) / (layerType === "circle" ? 2 : 1);
        stops.push({ value: stop.value, output: size, label, size });
      }
    }
    const field = typeof input.field === "string" ? (options.fieldMap?.[input.field] ?? input.field) : undefined;
    const sourceFallback = missingSafeStyle(
      outline ? outlineWidth : (basePaint[property] ?? (color ? "transparent" : 0)),
    );
    const fallback = sourceFallback;
    const ramp = scale
      ? interpolate(
          exponential(0.5),
          zoom(),
          ...[...stops].reverse().map((s): [number, Resolvable] => [webMercatorScaleToZoom(s.value), s.output]),
        )
      : switchCase(
          [
            eq(typeOf(get(field!)), "number"),
            interpolate(
              linear(),
              toNumber(get(field!)),
              ...stops.map((s): [number, Resolvable] => [s.value, s.output]),
            ),
          ],
          new Expr(fallback),
        );
    if (outline) {
      result.outline = {
        paint: {
          ...outlinePaint,
          "line-color": basePaint["fill-outline-color"] ?? "transparent",
          "line-width": ramp.toJSON(),
        },
        layout: {},
      };
      // A separate line layer replaces MapLibre's fixed one-pixel fill outline.
      result.paint["fill-outline-color"] = "transparent";
    } else result.paint[property] = ramp.toJSON();
    // Symbol alpha is carried by color, never multiplied a second time.
    if (color && layerType === "fill") result.paint["fill-opacity"] = 1;
    assigned.add(property);
    const legendOptions = isRecord(input.legendOptions) ? input.legendOptions : undefined;
    if (legendOptions?.showLegend !== false)
      result.legends.push({
        type: color ? "color" : "size",
        ...(field ? { field } : {}),
        ...(typeof legendOptions?.title === "string" ? { title: legendOptions.title } : {}),
        property,
        input: scale ? "scale" : "field",
        stops: stops.map(({ output: _output, ...stop }) => stop),
        outOfRange: "clamp",
        missingValue: "base-symbol",
        missingValueStyle: fallback,
        ...(!color ? { sizeUnit: "css-pixels" as const } : {}),
      });
  });
  return result;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A class-break step requires a number. Missing classification values use its
// default symbol instead of causing a MapLibre expression evaluation error.
function missingSafeStyle(style: unknown): unknown {
  return Array.isArray(style) && style[0] === "step"
    ? ["case", ["==", ["typeof", style[1]], "number"], style, style[2]]
    : style;
}

const KNOWN_PROPERTIES = new Set([
  "type",
  "field",
  "stops",
  "valueExpression",
  "expression",
  "valueExpressionTitle",
  "legendOptions",
  "normalizationField",
  "normalizationType",
  "normalizationTotal",
  "target",
  "valueUnit",
  "minDataValue",
  "maxDataValue",
  "minSize",
  "maxSize",
  "authoringInfo",
]);
