/**
 * Renderer-neutral 3D symbology contract and CSP-safe evaluator/compiler for
 * Cesium entities, models, point clouds, and 3D Tiles.
 *
 * Preserves the existing `honua_style` / {@link Honua3DStyleSpec} contract for
 * 3D Tiles rather than introducing a parallel tileset style language, while
 * giving entities, models, and point clouds deterministic attribute-driven
 * styling and identity-preserving in-place style updates.
 *
 * @experimental Held back from the beta `@honua/app-platform/scene-workspace`
 *   tier until real-Cesium browser symbology evidence promotes the entity slice.
 * @module
 */

import type { Honua3DStyleSpec } from "./cesium-adapter.js";
import type { ScenePointCloudShading } from "./primitives.js";

export const HONUA_3D_SYMBOLOGY_KIND = "honua.3d-symbology" as const;
export const HONUA_3D_SYMBOLOGY_VERSION = "1.0" as const;

/** Base visual symbol properties shared across entity, model, and tileset rules. */
export interface Scene3DSymbolStyle {
  readonly color?: string;
  readonly opacity?: number;
  readonly outlineColor?: string;
  readonly pixelSize?: number;
  readonly lineWidth?: number;
  readonly extrudedHeight?: number;
  readonly scale?: number;
  readonly visible?: boolean;
}

/** Unique-value styling rule matching an exact attribute value. */
export interface Scene3DUniqueValueRule {
  readonly value: string | number | boolean;
  readonly symbol: Scene3DSymbolStyle;
  readonly label?: string;
}

/** Class-break styling rule covering `[minValue, maxValue]` on a numeric field. */
export interface Scene3DClassBreakRule {
  readonly minValue: number;
  readonly maxValue: number;
  readonly symbol: Scene3DSymbolStyle;
  readonly label?: string;
}

/** Continuous interpolation stop for a visual variable. */
export interface Scene3DVisualVariableStop {
  readonly value: number;
  readonly color?: string;
  readonly size?: number;
  readonly opacity?: number;
  readonly scale?: number;
}

/** Continuous attribute-to-visual mapping (color, size, opacity, or scale). */
export interface Scene3DVisualVariable {
  readonly channel: "color" | "size" | "opacity" | "scale";
  readonly field: string;
  readonly stops: readonly Scene3DVisualVariableStop[];
}

/** Label styling configuration for entities. */
export interface Scene3DLabelStyle {
  readonly field?: string;
  readonly text?: string;
  readonly color?: string;
  readonly fontSize?: number;
}

/** Visibility distance range in metres. */
export interface Scene3DScaleRange {
  readonly minDistanceMeters?: number;
  readonly maxDistanceMeters?: number;
}

/** Highlight override applied to selected features without rebuilding entities. */
export interface Scene3DSelectionHighlightStyle {
  readonly color?: string;
  readonly outlineColor?: string;
  readonly opacity?: number;
  readonly scaleMultiplier?: number;
}

/** Versioned, renderer-neutral 3D symbology contract. */
export interface Honua3DSymbologyV1 {
  readonly kind: typeof HONUA_3D_SYMBOLOGY_KIND;
  readonly version: typeof HONUA_3D_SYMBOLOGY_VERSION;
  readonly mode: "simple" | "unique-value" | "class-breaks";
  readonly field?: string;
  readonly defaultSymbol: Scene3DSymbolStyle;
  readonly uniqueValues?: readonly Scene3DUniqueValueRule[];
  readonly classBreaks?: readonly Scene3DClassBreakRule[];
  readonly visualVariables?: readonly Scene3DVisualVariable[];
  readonly label?: Scene3DLabelStyle;
  readonly scaleRange?: Scene3DScaleRange;
  readonly selectionStyle?: Scene3DSelectionHighlightStyle;
  readonly pointCloud?: ScenePointCloudShading;
  readonly filterExpression?: string;
  readonly sourceVersion?: string;
}

/** Diagnostic emitted during symbology validation, evaluation, or compilation. */
export interface Scene3DSymbologyDiagnostic {
  readonly code:
    | "symbology-expression-rejected"
    | "symbology-filter-unsupported"
    | "symbology-invalid-rule"
    | "symbology-invalid-value"
    | "symbology-unsupported-channel";
  readonly severity: "warning" | "error";
  readonly message: string;
}

/** Resolved visual style for one feature/entity. */
export interface EvaluatedEntitySymbology {
  readonly color: string;
  readonly opacity: number;
  readonly outlineColor?: string;
  readonly pixelSize?: number;
  readonly lineWidth?: number;
  readonly extrudedHeight?: number;
  readonly scale: number;
  readonly visible: boolean;
  readonly highlighted: boolean;
  readonly labelText?: string;
  readonly diagnostics: readonly Scene3DSymbologyDiagnostic[];
}

/** Context supplied when evaluating symbology for one feature. */
export interface EvaluateEntitySymbologyOptions {
  readonly selected?: boolean;
  readonly cameraDistanceMeters?: number;
}

/** Minimal live entity collection for style-only updates. */
export interface StyleableCesiumEntityCollection {
  getById(id: string): unknown;
}

/** Summary returned by {@link applyEntityStyleUpdate}. */
export interface EntityStyleUpdateResult {
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
  readonly missing: readonly string[];
  readonly diagnostics: readonly Scene3DSymbologyDiagnostic[];
}

const DEFAULT_COLOR = "#3b82f6";
const DEFAULT_OPACITY = 1;
const DEFAULT_SCALE = 1;
const MAX_EXPRESSION_LENGTH = 512;

const HOSTILE_EXPRESSION_PATTERNS: readonly RegExp[] = [
  /\b(?:eval|Function|constructor|__proto__|prototype|globalThis|window|document|process|require|import)\b/i,
  /[`$;\\]/,
  /(?<![=!<>])=(?![=])/,
  /=>/,
  /\(\s*\)/,
];

const SAFE_EXPRESSION_RE = /^[A-Za-z0-9_.\s'"=!<>|&()+\-*/]+$/;
const FIELD_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const SAFE_COLOR_RE = /^(?:#[0-9a-fA-F]{3,8}|rgba?\([0-9.,%\s]+\)|[a-zA-Z]{3,20})$/;

/**
 * Validate a 3D symbology expression without executing code.
 *
 * Rejects prototype traversal, dynamic code invocation, template literals,
 * statements, and assignments so hostile style descriptors fail closed.
 */
export function validate3DSymbologyExpression(expression: string): Scene3DSymbologyDiagnostic | undefined {
  if (typeof expression !== "string" || expression.trim() === "") {
    return {
      code: "symbology-expression-rejected",
      severity: "error",
      message: "Symbology expression must be a non-empty string.",
    };
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return {
      code: "symbology-expression-rejected",
      severity: "error",
      message: `Symbology expression exceeds ${MAX_EXPRESSION_LENGTH} characters.`,
    };
  }
  for (const pattern of HOSTILE_EXPRESSION_PATTERNS) {
    if (pattern.test(expression)) {
      return {
        code: "symbology-expression-rejected",
        severity: "error",
        message: "Symbology expression contains a forbidden construct and was rejected.",
      };
    }
  }
  if (!SAFE_EXPRESSION_RE.test(expression)) {
    return {
      code: "symbology-expression-rejected",
      severity: "error",
      message: "Symbology expression contains disallowed characters.",
    };
  }
  return undefined;
}

/** Validate a {@link Honua3DSymbologyV1} descriptor without mutating or executing it. Pure. */
export function validate3DSymbology(symbology: Honua3DSymbologyV1): readonly Scene3DSymbologyDiagnostic[] {
  const diagnostics: Scene3DSymbologyDiagnostic[] = [];
  if (symbology.filterExpression !== undefined) {
    const exprError = validate3DSymbologyExpression(symbology.filterExpression);
    diagnostics.push(
      exprError ?? {
        code: "symbology-filter-unsupported",
        severity: "error",
        message: "Filter expressions are unsupported in scene symbology.",
      },
    );
  }
  if (symbology.field !== undefined && !FIELD_IDENTIFIER_RE.test(symbology.field)) {
    diagnostics.push({
      code: "symbology-invalid-rule",
      severity: "error",
      message: `Invalid symbology field identifier "${symbology.field}".`,
    });
  }
  const symbols = [
    symbology.defaultSymbol,
    ...(symbology.classBreaks ?? []).map((rule) => rule.symbol),
    ...(symbology.uniqueValues ?? []).map((rule) => rule.symbol),
  ];
  for (const { color } of symbols) {
    if (color !== undefined && !SAFE_COLOR_RE.test(color)) {
      diagnostics.push({
        code: "symbology-invalid-value",
        severity: "error",
        message: `Invalid symbol color "${color}".`,
      });
    }
  }
  for (const rule of symbology.classBreaks ?? []) {
    if (!Number.isFinite(rule.minValue) || !Number.isFinite(rule.maxValue) || rule.minValue > rule.maxValue) {
      diagnostics.push({
        code: "symbology-invalid-rule",
        severity: "error",
        message: `Class break [${rule.minValue}, ${rule.maxValue}] is invalid.`,
      });
    }
  }
  return diagnostics;
}

/**
 * Evaluate a {@link Honua3DSymbologyV1} descriptor for one feature attribute bag.
 * Pure, deterministic, and CSP-safe.
 */
export function evaluateEntitySymbology(
  symbology: Honua3DSymbologyV1,
  attributes: Readonly<Record<string, unknown>>,
  options: EvaluateEntitySymbologyOptions = {},
): EvaluatedEntitySymbology {
  const diagnostics = [...validate3DSymbology(symbology)];
  if (diagnostics.some((entry) => entry.severity === "error")) {
    return {
      color: DEFAULT_COLOR,
      opacity: DEFAULT_OPACITY,
      scale: DEFAULT_SCALE,
      visible: false,
      highlighted: false,
      diagnostics,
    };
  }
  const matched = resolveRuleSymbol(symbology, attributes);
  let color = matched.color ?? symbology.defaultSymbol.color ?? DEFAULT_COLOR;
  let opacity = clampUnit(matched.opacity ?? symbology.defaultSymbol.opacity ?? DEFAULT_OPACITY);
  let pixelSize = matched.pixelSize ?? symbology.defaultSymbol.pixelSize;
  let scale = positiveOrDefault(matched.scale ?? symbology.defaultSymbol.scale, DEFAULT_SCALE);
  let visible = matched.visible ?? symbology.defaultSymbol.visible ?? true;
  let outlineColor = matched.outlineColor ?? symbology.defaultSymbol.outlineColor;
  const lineWidth = matched.lineWidth ?? symbology.defaultSymbol.lineWidth;
  const extrudedHeight = matched.extrudedHeight ?? symbology.defaultSymbol.extrudedHeight;

  if (symbology.scaleRange && options.cameraDistanceMeters !== undefined) {
    const dist = options.cameraDistanceMeters;
    const min = symbology.scaleRange.minDistanceMeters ?? 0;
    const max = symbology.scaleRange.maxDistanceMeters ?? Number.POSITIVE_INFINITY;
    if (dist < min || dist > max) visible = false;
  }

  for (const variable of symbology.visualVariables ?? []) {
    const rawVal = attributes[variable.field];
    if (typeof rawVal !== "number" || !Number.isFinite(rawVal)) continue;
    const interpolated = interpolateVisualVariable(variable, rawVal);
    if (interpolated.color !== undefined) color = interpolated.color;
    if (interpolated.opacity !== undefined) opacity = clampUnit(interpolated.opacity);
    if (interpolated.size !== undefined) pixelSize = interpolated.size;
    if (interpolated.scale !== undefined) scale = positiveOrDefault(interpolated.scale, scale);
  }

  const highlighted = options.selected === true;
  if (highlighted && symbology.selectionStyle) {
    if (symbology.selectionStyle.color) color = symbology.selectionStyle.color;
    if (symbology.selectionStyle.outlineColor) outlineColor = symbology.selectionStyle.outlineColor;
    if (symbology.selectionStyle.opacity !== undefined) opacity = clampUnit(symbology.selectionStyle.opacity);
    if (symbology.selectionStyle.scaleMultiplier !== undefined && symbology.selectionStyle.scaleMultiplier > 0) {
      scale *= symbology.selectionStyle.scaleMultiplier;
    }
  }

  const labelText = resolveLabelText(symbology.label, attributes);
  return {
    color,
    opacity,
    ...(outlineColor !== undefined ? { outlineColor } : {}),
    ...(pixelSize !== undefined ? { pixelSize } : {}),
    ...(lineWidth !== undefined ? { lineWidth } : {}),
    ...(extrudedHeight !== undefined ? { extrudedHeight } : {}),
    scale,
    visible,
    highlighted,
    ...(labelText !== undefined ? { labelText } : {}),
    diagnostics,
  };
}

/**
 * Compile a {@link Honua3DSymbologyV1} descriptor into the canonical
 * `honua_style` / {@link Honua3DStyleSpec} contract for 3D Tiles.
 * Fails closed when any rule or expression is hostile or invalid.
 */
export function compile3DSymbologyToTilesetStyle(symbology: Honua3DSymbologyV1): {
  readonly spec?: Honua3DStyleSpec;
  readonly diagnostics: readonly Scene3DSymbologyDiagnostic[];
} {
  const diagnostics = validate3DSymbology(symbology);
  if (diagnostics.some((entry) => entry.severity === "error")) {
    return { diagnostics };
  }
  const conditions: [string, string][] = [];
  if (symbology.mode === "unique-value" && symbology.field && symbology.uniqueValues) {
    for (const rule of symbology.uniqueValues) {
      const literal = typeof rule.value === "string" ? JSON.stringify(rule.value) : String(rule.value);
      const color = rule.symbol.color ?? symbology.defaultSymbol.color ?? DEFAULT_COLOR;
      const opacity = clampUnit(rule.symbol.opacity ?? symbology.defaultSymbol.opacity ?? DEFAULT_OPACITY);
      conditions.push([`\${${symbology.field}} === ${literal}`, `color('${color}', ${opacity})`]);
    }
  } else if (symbology.mode === "class-breaks" && symbology.field && symbology.classBreaks) {
    for (const rule of symbology.classBreaks) {
      const color = rule.symbol.color ?? symbology.defaultSymbol.color ?? DEFAULT_COLOR;
      const opacity = clampUnit(rule.symbol.opacity ?? symbology.defaultSymbol.opacity ?? DEFAULT_OPACITY);
      conditions.push([
        `\${${symbology.field}} >= ${rule.minValue} && \${${symbology.field}} <= ${rule.maxValue}`,
        `color('${color}', ${opacity})`,
      ]);
    }
  }
  const defaultColor = symbology.defaultSymbol.color ?? DEFAULT_COLOR;
  const defaultOpacity = clampUnit(symbology.defaultSymbol.opacity ?? DEFAULT_OPACITY);
  conditions.push(["true", `color('${defaultColor}', ${defaultOpacity})`]);

  const spec: Honua3DStyleSpec = {
    encoding: "3d-tiles-styling",
    version: "1.0",
    defaultMaterial: { color: defaultColor, opacity: defaultOpacity },
    style: {
      color: { conditions },
      ...(symbology.defaultSymbol.pixelSize !== undefined ? { pointSize: symbology.defaultSymbol.pixelSize } : {}),
    },
  };
  return { spec, diagnostics };
}

/**
 * Apply a style-only update directly onto mounted Cesium entities by id.
 *
 * Mutates only visual facets (`show`, `point`, `polyline`, `polygon`, `model`,
 * `label`) on live entity instances — never removes or reconstructs an entity,
 * so `viewer.selectedEntity` and live object identity survive intact.
 */
export function applyEntityStyleUpdate(options: {
  readonly collection: StyleableCesiumEntityCollection;
  readonly entityIds: readonly string[];
  readonly symbology: Honua3DSymbologyV1;
  readonly selectedIds?: ReadonlySet<string>;
  readonly cameraDistanceMeters?: number;
  readonly colorFactory?: (cssColor: string, opacity: number) => unknown;
}): EntityStyleUpdateResult {
  const validation = validate3DSymbology(options.symbology);
  if (validation.some((entry) => entry.severity === "error")) {
    return { updated: [], unchanged: [...options.entityIds], missing: [], diagnostics: validation };
  }
  const updated: string[] = [];
  const unchanged: string[] = [];
  const missing: string[] = [];
  const makeColor = options.colorFactory ?? ((cssColor: string, opacity: number) => ({ cssColor, opacity }));

  for (const id of options.entityIds) {
    const entity = options.collection.getById(id) as Record<string, unknown> | undefined;
    if (!entity || typeof entity !== "object") {
      missing.push(id);
      continue;
    }
    const attributes = extractEntityProperties(entity);
    const evaluated = evaluateEntitySymbology(options.symbology, attributes, {
      selected: options.selectedIds?.has(id) ?? false,
      cameraDistanceMeters: options.cameraDistanceMeters,
    });
    const styleKey = JSON.stringify({
      color: evaluated.color,
      opacity: evaluated.opacity,
      pixelSize: evaluated.pixelSize,
      lineWidth: evaluated.lineWidth,
      extrudedHeight: evaluated.extrudedHeight,
      scale: evaluated.scale,
      visible: evaluated.visible,
      labelText: evaluated.labelText,
    });
    if (entity.__honuaStyleKey === styleKey) {
      unchanged.push(id);
      continue;
    }
    applyStyleToLiveEntity(entity, evaluated, makeColor);
    entity.__honuaStyleKey = styleKey;
    updated.push(id);
  }
  return { updated, unchanged, missing, diagnostics: validation };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveRuleSymbol(
  symbology: Honua3DSymbologyV1,
  attributes: Readonly<Record<string, unknown>>,
): Scene3DSymbolStyle {
  if (symbology.mode === "unique-value" && symbology.field && symbology.uniqueValues) {
    const value = attributes[symbology.field];
    const match = symbology.uniqueValues.find((rule) => rule.value === value);
    if (match) return match.symbol;
  }
  if (symbology.mode === "class-breaks" && symbology.field && symbology.classBreaks) {
    const value = attributes[symbology.field];
    if (typeof value === "number" && Number.isFinite(value)) {
      const match = symbology.classBreaks.find((rule) => value >= rule.minValue && value <= rule.maxValue);
      if (match) return match.symbol;
    }
  }
  return symbology.defaultSymbol;
}

function interpolateVisualVariable(
  variable: Scene3DVisualVariable,
  value: number,
): { readonly color?: string; readonly size?: number; readonly opacity?: number; readonly scale?: number } {
  if (variable.stops.length === 0) return {};
  const sorted = [...variable.stops].sort((a, b) => a.value - b.value);
  if (value <= sorted[0]!.value) return pickStopChannel(variable.channel, sorted[0]!);
  const last = sorted[sorted.length - 1]!;
  if (value >= last.value) return pickStopChannel(variable.channel, last);
  for (let i = 1; i < sorted.length; i += 1) {
    const lo = sorted[i - 1]!;
    const hi = sorted[i]!;
    if (value > hi.value) continue;
    const t = hi.value === lo.value ? 0 : (value - lo.value) / (hi.value - lo.value);
    if (variable.channel === "color") {
      return { color: t < 0.5 ? lo.color : hi.color };
    }
    const loNum = readStopNumber(variable.channel, lo);
    const hiNum = readStopNumber(variable.channel, hi);
    if (loNum === undefined || hiNum === undefined) return {};
    const blended = loNum + (hiNum - loNum) * t;
    return { [variable.channel]: blended };
  }
  return {};
}

function pickStopChannel(
  channel: Scene3DVisualVariable["channel"],
  stop: Scene3DVisualVariableStop,
): { readonly color?: string; readonly size?: number; readonly opacity?: number; readonly scale?: number } {
  if (channel === "color") return stop.color !== undefined ? { color: stop.color } : {};
  const val = readStopNumber(channel, stop);
  return val !== undefined ? { [channel]: val } : {};
}

function readStopNumber(channel: "size" | "opacity" | "scale", stop: Scene3DVisualVariableStop): number | undefined {
  const val = stop[channel];
  return typeof val === "number" && Number.isFinite(val) ? val : undefined;
}

function resolveLabelText(
  label: Scene3DLabelStyle | undefined,
  attributes: Readonly<Record<string, unknown>>,
): string | undefined {
  if (!label) return undefined;
  if (label.field) {
    const val = attributes[label.field];
    return val !== undefined && val !== null ? String(val) : undefined;
  }
  return label.text;
}

function extractEntityProperties(entity: Record<string, unknown>): Record<string, unknown> {
  const bag = entity.properties;
  if (!bag || typeof bag !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag as Record<string, unknown>)) {
    const getter = value && typeof value === "object" ? (value as { getValue?: () => unknown }).getValue : undefined;
    out[key] = typeof getter === "function" ? getter.call(value) : value;
  }
  return out;
}

function applyStyleToLiveEntity(
  entity: Record<string, unknown>,
  style: EvaluatedEntitySymbology,
  makeColor: (cssColor: string, opacity: number) => unknown,
): void {
  const colorValue = makeColor(style.color, style.opacity);
  entity.show = style.visible;
  if (entity.point && typeof entity.point === "object") {
    const point = entity.point as Record<string, unknown>;
    point.color = colorValue;
    if (style.pixelSize !== undefined) point.pixelSize = style.pixelSize;
  }
  if (entity.polyline && typeof entity.polyline === "object") {
    const line = entity.polyline as Record<string, unknown>;
    line.material = colorValue;
    if (style.lineWidth !== undefined) line.width = style.lineWidth;
  }
  if (entity.polygon && typeof entity.polygon === "object") {
    const polygon = entity.polygon as Record<string, unknown>;
    polygon.material = colorValue;
    if (style.extrudedHeight !== undefined) polygon.extrudedHeight = style.extrudedHeight;
  }
  if (entity.model && typeof entity.model === "object") {
    const model = entity.model as Record<string, unknown>;
    model.color = colorValue;
    model.scale = style.scale;
  }
  if (style.labelText !== undefined) {
    const existing = entity.label && typeof entity.label === "object" ? (entity.label as Record<string, unknown>) : {};
    entity.label = { ...existing, text: style.labelText };
  }
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OPACITY;
  return Math.min(1, Math.max(0, value));
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
