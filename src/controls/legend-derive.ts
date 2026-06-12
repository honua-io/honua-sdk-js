/**
 * Derive-mode engine behind `<honua-legend>`: parses a style layer's
 * categorical color paint expression into legend entries, so the map style
 * stays the single source of truth and the legend cannot drift from it.
 *
 * ## Supported expression shapes
 *
 * The color paint property of the layer (`fill-color`, `line-color`, or
 * `circle-color` depending on the layer type) may be:
 *
 * 1. A literal CSS color string — yields a single entry labeled with the
 *    layer id.
 * 2. `["match", ["get", <attr>], in1, color1, ..., fallbackColor]` — the
 *    primary categorical shape. Branch inputs may be strings, numbers, or
 *    arrays thereof (an array branch becomes one row labeled with the values
 *    joined by `", "`). Every output, including the fallback, must be a
 *    literal color string; the fallback becomes a row labeled `"Other"`.
 * 3. `["case", ["==", ["get", <attr>], <literal>], color1, ..., fallback]` —
 *    simple equality chains only; each condition labels its row with the
 *    compared literal, and the fallback becomes `"Other"`.
 * 4. `["step", ["get", <attr>], color0, stop1, color1, ...]` — numeric breaks
 *    on a feature attribute, labeled `"< stop1"`, `"stop1–stop2"`, ...,
 *    `"≥ stopN"`.
 *
 * Anything else — `interpolate`, zoom- or feature-state-driven expressions,
 * non-literal color outputs, nested expressions, unsupported layer types —
 * throws {@link HonuaLegendDeriveError} with a `code` describing the failure,
 * so callers can fall back gracefully instead of rendering a wrong legend.
 *
 * For `fill` layers, a literal `fill-outline-color` is propagated to every
 * derived entry as the swatch outline.
 *
 * @module
 */

import type { HonuaLegendEntry, HonuaLegendMap, HonuaLegendSwatchShape } from "./types.js";

/** Machine-readable reason a legend could not be derived. */
export type HonuaLegendDeriveErrorCode =
  | "layer-not-found"
  | "unsupported-layer-type"
  | "missing-paint"
  | "unsupported-expression";

/** Thrown by {@link deriveLegendEntries} when a legend cannot be derived. */
export class HonuaLegendDeriveError extends Error {
  public override readonly name = "HonuaLegendDeriveError";
  /** Why derivation failed; `"layer-not-found"` is often transient (layer not added yet). */
  public readonly code: HonuaLegendDeriveErrorCode;

  public constructor(code: HonuaLegendDeriveErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const PAINT_BY_LAYER_TYPE: Record<string, { property: string; shape: HonuaLegendSwatchShape }> = {
  fill: { property: "fill-color", shape: "fill" },
  line: { property: "line-color", shape: "line" },
  circle: { property: "circle-color", shape: "circle" },
};

/** Label given to the `match`/`case` fallback branch. */
export const HONUA_LEGEND_FALLBACK_LABEL = "Other";

/**
 * Derives legend entries from the categorical color expression of the given
 * style layer. See the module docs for the supported expression shapes;
 * throws {@link HonuaLegendDeriveError} on anything else.
 */
export function deriveLegendEntries(map: HonuaLegendMap, layerId: string): HonuaLegendEntry[] {
  const layer = typeof map.getLayer === "function" ? map.getLayer(layerId) : undefined;
  if (!layer || typeof layer !== "object") {
    throw new HonuaLegendDeriveError("layer-not-found", `Layer "${layerId}" does not exist on the map.`);
  }
  const layerType = (layer as { type?: unknown }).type;
  const mapping = typeof layerType === "string" ? PAINT_BY_LAYER_TYPE[layerType] : undefined;
  if (!mapping) {
    throw new HonuaLegendDeriveError(
      "unsupported-layer-type",
      `Cannot derive a legend for layer "${layerId}" of type "${String(layerType)}"; supported types: fill, line, circle.`,
    );
  }
  const value = readPaintProperty(map, layer, layerId, mapping.property);
  if (value === undefined || value === null) {
    throw new HonuaLegendDeriveError(
      "missing-paint",
      `Layer "${layerId}" has no "${mapping.property}" paint value to derive a legend from.`,
    );
  }
  const outline =
    mapping.shape === "fill" ? literalColor(readPaintProperty(map, layer, layerId, "fill-outline-color")) : undefined;
  return colorValueToEntries(value, layerId, mapping.shape, outline);
}

function readPaintProperty(map: HonuaLegendMap, layer: object, layerId: string, name: string): unknown {
  if (typeof map.getPaintProperty === "function") {
    const value = map.getPaintProperty(layerId, name);
    if (value !== undefined) return value;
  }
  const paint = (layer as { paint?: unknown }).paint;
  if (typeof paint === "object" && paint !== null) return (paint as Record<string, unknown>)[name];
  return undefined;
}

function colorValueToEntries(
  value: unknown,
  layerId: string,
  shape: HonuaLegendSwatchShape,
  outline: string | undefined,
): HonuaLegendEntry[] {
  if (typeof value === "string") return [makeEntry(layerId, value, shape, outline)];
  if (Array.isArray(value)) {
    const operator = value[0];
    if (operator === "match") return matchToEntries(value, layerId, shape, outline);
    if (operator === "case") return caseToEntries(value, layerId, shape, outline);
    if (operator === "step") return stepToEntries(value, layerId, shape, outline);
    throw new HonuaLegendDeriveError(
      "unsupported-expression",
      `Layer "${layerId}": unsupported color expression operator "${String(operator)}"; supported: literal color, match, case, step.`,
    );
  }
  throw new HonuaLegendDeriveError(
    "unsupported-expression",
    `Layer "${layerId}": color paint value must be a literal color string or a match/case/step expression.`,
  );
}

function matchToEntries(
  expression: readonly unknown[],
  layerId: string,
  shape: HonuaLegendSwatchShape,
  outline: string | undefined,
): HonuaLegendEntry[] {
  requireGetInput(expression[1], layerId, "match");
  const body = expression.slice(2);
  if (body.length < 3 || body.length % 2 === 0) {
    throw new HonuaLegendDeriveError(
      "unsupported-expression",
      `Layer "${layerId}": match expression must have branch input/output pairs plus a fallback color.`,
    );
  }
  const entries: HonuaLegendEntry[] = [];
  for (let index = 0; index < body.length - 1; index += 2) {
    const label = matchBranchLabel(body[index], layerId);
    const color = requireLiteralColor(body[index + 1], layerId);
    entries.push(makeEntry(label, color, shape, outline));
  }
  entries.push(
    makeEntry(HONUA_LEGEND_FALLBACK_LABEL, requireLiteralColor(body[body.length - 1], layerId), shape, outline),
  );
  return entries;
}

function matchBranchLabel(input: unknown, layerId: string): string {
  if (typeof input === "string" || typeof input === "number") return String(input);
  if (
    Array.isArray(input) &&
    input.length > 0 &&
    input.every((item) => typeof item === "string" || typeof item === "number")
  ) {
    return input.map((item) => String(item)).join(", ");
  }
  throw new HonuaLegendDeriveError(
    "unsupported-expression",
    `Layer "${layerId}": match branch inputs must be strings, numbers, or arrays of them.`,
  );
}

function caseToEntries(
  expression: readonly unknown[],
  layerId: string,
  shape: HonuaLegendSwatchShape,
  outline: string | undefined,
): HonuaLegendEntry[] {
  const body = expression.slice(1);
  if (body.length < 3 || body.length % 2 === 0) {
    throw new HonuaLegendDeriveError(
      "unsupported-expression",
      `Layer "${layerId}": case expression must have condition/output pairs plus a fallback color.`,
    );
  }
  const entries: HonuaLegendEntry[] = [];
  for (let index = 0; index < body.length - 1; index += 2) {
    const label = caseConditionLabel(body[index], layerId);
    const color = requireLiteralColor(body[index + 1], layerId);
    entries.push(makeEntry(label, color, shape, outline));
  }
  entries.push(
    makeEntry(HONUA_LEGEND_FALLBACK_LABEL, requireLiteralColor(body[body.length - 1], layerId), shape, outline),
  );
  return entries;
}

function caseConditionLabel(condition: unknown, layerId: string): string {
  if (Array.isArray(condition) && condition.length === 3 && condition[0] === "==") {
    const compared = condition[2];
    if (
      isGetExpression(condition[1]) &&
      (typeof compared === "string" || typeof compared === "number" || typeof compared === "boolean")
    ) {
      return String(compared);
    }
  }
  throw new HonuaLegendDeriveError(
    "unsupported-expression",
    `Layer "${layerId}": case conditions must be simple equalities ["==", ["get", <attribute>], <literal>].`,
  );
}

function stepToEntries(
  expression: readonly unknown[],
  layerId: string,
  shape: HonuaLegendSwatchShape,
  outline: string | undefined,
): HonuaLegendEntry[] {
  requireGetInput(expression[1], layerId, "step");
  const body = expression.slice(2);
  if (body.length < 3 || body.length % 2 === 0) {
    throw new HonuaLegendDeriveError(
      "unsupported-expression",
      `Layer "${layerId}": step expression must have a base color plus stop/color pairs.`,
    );
  }
  const stops: number[] = [];
  const colors: string[] = [requireLiteralColor(body[0], layerId)];
  for (let index = 1; index < body.length; index += 2) {
    const stop = body[index];
    if (typeof stop !== "number") {
      throw new HonuaLegendDeriveError(
        "unsupported-expression",
        `Layer "${layerId}": step stops must be numeric literals.`,
      );
    }
    stops.push(stop);
    colors.push(requireLiteralColor(body[index + 1], layerId));
  }
  return colors.map((color, index) => {
    const lower = index === 0 ? undefined : stops[index - 1];
    const upper = index < stops.length ? stops[index] : undefined;
    const label =
      lower === undefined
        ? `< ${String(upper)}`
        : upper === undefined
          ? `≥ ${String(lower)}`
          : `${String(lower)}–${String(upper)}`;
    return makeEntry(label, color, shape, outline);
  });
}

function requireGetInput(input: unknown, layerId: string, operator: string): void {
  if (!isGetExpression(input)) {
    throw new HonuaLegendDeriveError(
      "unsupported-expression",
      `Layer "${layerId}": ${operator} input must be a ["get", <attribute>] expression on a feature attribute.`,
    );
  }
}

function isGetExpression(value: unknown): boolean {
  return Array.isArray(value) && value[0] === "get" && typeof value[1] === "string";
}

function requireLiteralColor(value: unknown, layerId: string): string {
  const color = literalColor(value);
  if (color === undefined) {
    throw new HonuaLegendDeriveError(
      "unsupported-expression",
      `Layer "${layerId}": expression outputs must be literal color strings; got ${JSON.stringify(value)}.`,
    );
  }
  return color;
}

function literalColor(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function makeEntry(
  label: string,
  fill: string,
  shape: HonuaLegendSwatchShape,
  outline: string | undefined,
): HonuaLegendEntry {
  return { label, color: outline === undefined ? fill : { fill, outline }, shape };
}
