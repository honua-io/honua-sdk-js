/**
 * Mapbox-style runtime helpers for source/layer mutation, expression
 * diagnostics, and source-qualified feature interaction targets.
 *
 * The types in this file intentionally stay structural instead of importing
 * MapLibre GL JS declarations. App code can use common source, layer, paint,
 * layout, filter, and interaction helpers without coupling to a specific
 * renderer package version.
 *
 * @module
 */

import type { FeatureId } from "../contract/types.js";
import {
  type HonuaErrorMetadata,
  HonuaSdkError,
  honuaErrorOptionsWithCause,
  mergeHonuaErrorContext,
  ownHonuaErrorContext,
  withHonuaErrorClassification,
} from "../core/error-base.js";
import { sourceFeatureSelectionTarget } from "../exploration/selection.js";
import type { SourceQualifiedFeatureSelectionTarget } from "../exploration/types.js";
import { Expr } from "../expr/index.js";
import type {
  HonuaLayerSpecification,
  HonuaSourceSpecification,
  HonuaStyleSpecification,
} from "../style/specification.js";
import { isHonuaSource } from "../style/specification.js";
import type { HonuaMapPackage } from "./map-package.js";
import {
  validateRuntimeFilterStyleSpecSync,
  validateRuntimeLayerStyleSpecSync,
  validateRuntimeSourceStyleSpecSync,
  validateRuntimeStyleExpressionStyleSpecSync,
} from "./style-spec-validation.js";
import type { RuntimeStyleSpecValidationMode } from "./style-spec-validation.js";

export type HonuaRuntimeDiagnosticSeverity = "error" | "warning";

export interface HonuaRuntimeDiagnostic {
  readonly code: string;
  readonly severity: HonuaRuntimeDiagnosticSeverity;
  readonly message: string;
  readonly path?: string;
  readonly sourceId?: string;
  readonly layerId?: string;
  readonly protocol?: string;
  readonly capability?: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export class HonuaRuntimeDiagnosticError extends HonuaSdkError {
  public readonly diagnostics: readonly HonuaRuntimeDiagnostic[];
  public override readonly cause: unknown;

  public constructor(
    message: string,
    diagnostics: readonly HonuaRuntimeDiagnostic[],
    cause?: unknown,
    metadata: HonuaErrorMetadata = {},
  ) {
    super(
      "runtime.diagnostic",
      message,
      withHonuaErrorClassification(
        honuaErrorOptionsWithCause(metadata, cause),
        "runtime",
        "validation",
        false,
        mergeHonuaErrorContext(ownHonuaErrorContext(metadata), {
          diagnosticCount: diagnostics.length,
          diagnosticCodes: diagnostics.map(({ code }) => code),
        }),
      ),
    );
    this.name = "HonuaRuntimeDiagnosticError";
    this.diagnostics = diagnostics;
    this.cause = cause;
  }
}

export interface NativeMapLibreSourceSpecification {
  readonly type: string;
  readonly [key: string]: unknown;
}

export type RuntimeSourceSpecification = HonuaSourceSpecification | NativeMapLibreSourceSpecification;
export type RuntimeStyleValue = unknown;
export type RuntimePaintSpecification = Record<string, RuntimeStyleValue>;
export type RuntimeLayoutSpecification = Record<string, RuntimeStyleValue>;
export type RuntimeFilterExpression = unknown;

export interface RuntimeLayerSpecification extends Omit<HonuaLayerSpecification, "paint" | "layout" | "filter"> {
  readonly paint?: RuntimePaintSpecification;
  readonly layout?: RuntimeLayoutSpecification;
  readonly filter?: RuntimeFilterExpression;
}

export interface RuntimeLayerUpdate extends Partial<Omit<RuntimeLayerSpecification, "id">> {
  readonly order?: RuntimeLayerOrder;
}

export interface RuntimeLayerOrderOptions {
  readonly beforeId?: string;
  readonly afterId?: string;
  readonly position?: "top" | "bottom";
}

/**
 * Layer order input. A string is treated as MapLibre's `beforeId`.
 */
export type RuntimeLayerOrder = string | RuntimeLayerOrderOptions | undefined;

export interface RuntimeExpressionValidationOptions {
  readonly kind?: "style" | "filter";
  readonly path?: string;
  readonly sourceId?: string;
  readonly layerId?: string;
  readonly protocol?: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly requireExpression?: boolean;
  readonly strictUnknownOperators?: boolean;
  readonly styleSpecValidationMode?: RuntimeStyleSpecValidationMode;
}

export interface RuntimeStyleValidationContext {
  readonly style?: HonuaStyleSpecification;
  readonly mapPackage?: HonuaMapPackage;
  readonly operation?: string;
  readonly styleSpecValidationMode?: RuntimeStyleSpecValidationMode;
}

export interface RuntimeFeatureStateTarget {
  readonly source: string;
  readonly id: FeatureId;
  readonly sourceLayer?: string;
}

export interface RuntimeFeatureInteractionEvent {
  readonly type: string;
  readonly layerId: string;
  readonly sourceId: string;
  readonly sourceLayer?: string;
  readonly feature: unknown;
  readonly featureId?: FeatureId;
  readonly selectionTarget?: SourceQualifiedFeatureSelectionTarget;
  readonly originalEvent: unknown;
}

export interface RuntimeClickInteractionOptions {
  readonly sourceId?: string;
  readonly sourceLayer?: string;
  readonly featureIdProperty?: string;
  readonly resolveFeatureId?: (feature: unknown, event: unknown) => FeatureId | undefined;
}

export type RuntimeClickInteractionHandler = (event: RuntimeFeatureInteractionEvent) => void;

export interface RuntimeHoverInteractionOptions {
  readonly sourceId?: string;
  readonly sourceLayer?: string;
  readonly stateKey?: string;
}

export interface RuntimeSelectionInteractionOptions {
  readonly sourceId?: string;
  readonly sourceLayer?: string;
  readonly stateKey?: string;
  readonly multiSelect?: boolean;
  readonly onChange?: (selectedIds: ReadonlySet<string | number>) => void;
  readonly onSelectionTargetsChange?: (selectedTargets: ReadonlyArray<SourceQualifiedFeatureSelectionTarget>) => void;
}

export interface RuntimeExplorationSelectionOptions extends RuntimeSelectionInteractionOptions {
  readonly replaceSelection?: boolean;
}

interface OperatorRule {
  readonly minArgs?: number;
  readonly maxArgs?: number;
  readonly custom?: (expr: readonly unknown[], options: RuntimeExpressionValidationOptions) => HonuaRuntimeDiagnostic[];
}

const EXPRESSION_OPERATORS: Readonly<Record<string, OperatorRule>> = {
  "!": { minArgs: 1, maxArgs: 1 },
  "!=": { minArgs: 2, maxArgs: 3 },
  "<": { minArgs: 2, maxArgs: 3 },
  "<=": { minArgs: 2, maxArgs: 3 },
  "==": { minArgs: 2, maxArgs: 3 },
  ">": { minArgs: 2, maxArgs: 3 },
  ">=": { minArgs: 2, maxArgs: 3 },
  "-": { minArgs: 1, maxArgs: 2 },
  "+": { minArgs: 2 },
  "*": { minArgs: 2 },
  "/": { minArgs: 2, maxArgs: 2 },
  "%": { minArgs: 2, maxArgs: 2 },
  "^": { minArgs: 2, maxArgs: 2 },
  abs: { minArgs: 1, maxArgs: 1 },
  accumulated: { minArgs: 0, maxArgs: 0 },
  acos: { minArgs: 1, maxArgs: 1 },
  all: { minArgs: 1 },
  any: { minArgs: 1 },
  array: { minArgs: 1 },
  asin: { minArgs: 1, maxArgs: 1 },
  at: { minArgs: 2, maxArgs: 2 },
  atan: { minArgs: 1, maxArgs: 1 },
  boolean: { minArgs: 1 },
  case: { custom: validateCaseExpression },
  ceil: { minArgs: 1, maxArgs: 1 },
  coalesce: { minArgs: 1 },
  collator: { minArgs: 0, maxArgs: 1 },
  concat: { minArgs: 1 },
  cos: { minArgs: 1, maxArgs: 1 },
  "cubic-bezier": { minArgs: 4, maxArgs: 4 },
  "distance-from-center": { minArgs: 0, maxArgs: 0 },
  downcase: { minArgs: 1, maxArgs: 1 },
  distance: { minArgs: 1, maxArgs: 1 },
  e: { minArgs: 0, maxArgs: 0 },
  "feature-state": { minArgs: 1, maxArgs: 1 },
  floor: { minArgs: 1, maxArgs: 1 },
  format: { minArgs: 1 },
  geometry: { minArgs: 0, maxArgs: 0 },
  "geometry-type": { minArgs: 0, maxArgs: 0 },
  get: { minArgs: 1, maxArgs: 2 },
  has: { minArgs: 1, maxArgs: 2 },
  "heatmap-density": { minArgs: 0, maxArgs: 0 },
  hsl: { minArgs: 3, maxArgs: 3 },
  hsla: { minArgs: 4, maxArgs: 4 },
  id: { minArgs: 0, maxArgs: 0 },
  image: { minArgs: 1, maxArgs: 1 },
  in: { minArgs: 2, maxArgs: 2 },
  index: { minArgs: 0, maxArgs: 0 },
  "index-of": { minArgs: 2, maxArgs: 3 },
  interpolate: { custom: validateInterpolateExpression },
  "interpolate-hcl": { custom: validateInterpolateExpression },
  "interpolate-lab": { custom: validateInterpolateExpression },
  intersects: { minArgs: 1, maxArgs: 1 },
  length: { minArgs: 1, maxArgs: 1 },
  let: { minArgs: 3 },
  "line-progress": { minArgs: 0, maxArgs: 0 },
  literal: { minArgs: 1, maxArgs: 1 },
  ln: { minArgs: 1, maxArgs: 1 },
  ln2: { minArgs: 0, maxArgs: 0 },
  log10: { minArgs: 1, maxArgs: 1 },
  log2: { minArgs: 1, maxArgs: 1 },
  match: { custom: validateMatchExpression },
  max: { minArgs: 1 },
  min: { minArgs: 1 },
  "number-format": { minArgs: 1, maxArgs: 2 },
  number: { minArgs: 1 },
  object: { minArgs: 1 },
  pi: { minArgs: 0, maxArgs: 0 },
  pitch: { minArgs: 0, maxArgs: 0 },
  properties: { minArgs: 0, maxArgs: 0 },
  "resolved-locale": { minArgs: 1, maxArgs: 1 },
  resolvedLocale: { minArgs: 1, maxArgs: 1 },
  rgb: { minArgs: 3, maxArgs: 3 },
  rgba: { minArgs: 4, maxArgs: 4 },
  round: { minArgs: 1, maxArgs: 1 },
  sin: { minArgs: 1, maxArgs: 1 },
  slice: { minArgs: 2, maxArgs: 3 },
  sqrt: { minArgs: 1, maxArgs: 1 },
  step: { custom: validateStepExpression },
  string: { minArgs: 1 },
  tan: { minArgs: 1, maxArgs: 1 },
  "to-boolean": { minArgs: 1, maxArgs: 1 },
  "to-color": { minArgs: 1 },
  "to-number": { minArgs: 1 },
  "to-rgba": { minArgs: 1, maxArgs: 1 },
  "to-string": { minArgs: 1, maxArgs: 1 },
  typeof: { minArgs: 1, maxArgs: 1 },
  upcase: { minArgs: 1, maxArgs: 1 },
  var: { minArgs: 1, maxArgs: 1 },
  within: { minArgs: 1, maxArgs: 1 },
  zoom: { minArgs: 0, maxArgs: 0 },
};

export function materializeRuntimeSource(source: RuntimeSourceSpecification): RuntimeSourceSpecification {
  return materializeStyleValue(source) as RuntimeSourceSpecification;
}

export function materializeRuntimeLayer(layer: RuntimeLayerSpecification): HonuaLayerSpecification {
  return materializeStyleValue(layer) as HonuaLayerSpecification;
}

export function materializeStyleValue(value: unknown): unknown {
  if (value instanceof Expr) {
    return value.toJSON();
  }
  if (Array.isArray(value)) {
    return value.map((entry) => materializeStyleValue(entry));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = materializeStyleValue(entry);
    }
    return result;
  }
  return value;
}

export function validateRuntimeSource(
  sourceId: string,
  source: RuntimeSourceSpecification,
  context: RuntimeStyleValidationContext = {},
): HonuaRuntimeDiagnostic[] {
  const diagnostics: HonuaRuntimeDiagnostic[] = [];
  const sourceContext = sourceDiagnosticContext(sourceId, source, context);

  if (!sourceId.trim()) {
    diagnostics.push({
      code: "source-id-empty",
      severity: "error",
      message: "Source id must be a non-empty string.",
      path: "sourceId",
      ...sourceContext,
    });
  }

  if (!isPlainObject(source)) {
    diagnostics.push({
      code: "source-invalid",
      severity: "error",
      message: "Source specification must be a non-null object.",
      path: `sources.${sourceId}`,
      ...sourceContext,
    });
    return diagnostics;
  }

  if (typeof source.type !== "string" || source.type.trim().length === 0) {
    diagnostics.push({
      code: "source-type-invalid",
      severity: "error",
      message: "Source specification must include a non-empty string type.",
      path: `sources.${sourceId}.type`,
      ...sourceContext,
    });
  }

  if (isHonuaSource(source) && typeof source.url !== "string") {
    diagnostics.push({
      code: "source-url-missing",
      severity: "error",
      message: "Honua source specifications require a string url.",
      path: `sources.${sourceId}.url`,
      ...sourceContext,
    });
  }

  diagnostics.push(
    ...validateRuntimeSourceStyleSpecSync(sourceId, source, {
      mode: context.styleSpecValidationMode,
      path: `sources.${sourceId}`,
      ...sourceContext,
    }),
  );

  return diagnostics;
}

export function validateRuntimeLayer(
  layer: RuntimeLayerSpecification | HonuaLayerSpecification,
  context: RuntimeStyleValidationContext = {},
): HonuaRuntimeDiagnostic[] {
  const materialized = materializeRuntimeLayer(layer as RuntimeLayerSpecification);
  const diagnostics: HonuaRuntimeDiagnostic[] = [];
  const sourceId = materialized.source;
  const sourceContext = layerDiagnosticContext(materialized.id, sourceId, context);

  if (typeof materialized.id !== "string" || materialized.id.trim().length === 0) {
    diagnostics.push({
      code: "layer-id-invalid",
      severity: "error",
      message: "Layer specification must include a non-empty string id.",
      path: "layers[].id",
      ...sourceContext,
    });
  }

  if (typeof materialized.type !== "string" || materialized.type.trim().length === 0) {
    diagnostics.push({
      code: "layer-type-invalid",
      severity: "error",
      message: "Layer specification must include a non-empty string type.",
      path: `layers.${materialized.id}.type`,
      ...sourceContext,
    });
  }

  if (sourceId && context.style && !Object.hasOwn(context.style.sources, sourceId)) {
    diagnostics.push({
      code: "layer-source-missing",
      severity: "error",
      message: `Layer "${materialized.id}" references missing source "${sourceId}".`,
      path: `layers.${materialized.id}.source`,
      ...sourceContext,
    });
  }

  if (materialized.paint !== undefined && !isPlainObject(materialized.paint)) {
    diagnostics.push({
      code: "layer-paint-invalid",
      severity: "error",
      message: "Layer paint must be an object when provided.",
      path: `layers.${materialized.id}.paint`,
      ...sourceContext,
    });
  } else {
    for (const [property, value] of Object.entries(materialized.paint ?? {})) {
      diagnostics.push(
        ...validateRuntimeStyleExpression(value, {
          kind: "style",
          path: `layers.${materialized.id}.paint.${property}`,
          ...sourceContext,
        }),
      );
    }
  }

  if (materialized.layout !== undefined && !isPlainObject(materialized.layout)) {
    diagnostics.push({
      code: "layer-layout-invalid",
      severity: "error",
      message: "Layer layout must be an object when provided.",
      path: `layers.${materialized.id}.layout`,
      ...sourceContext,
    });
  } else {
    for (const [property, value] of Object.entries(materialized.layout ?? {})) {
      diagnostics.push(
        ...validateRuntimeStyleExpression(value, {
          kind: "style",
          path: `layers.${materialized.id}.layout.${property}`,
          ...sourceContext,
        }),
      );
    }
  }

  if (materialized.filter !== undefined) {
    diagnostics.push(
      ...validateRuntimeFilterExpression(materialized.filter, {
        path: `layers.${materialized.id}.filter`,
        ...sourceContext,
      }),
    );
  }

  diagnostics.push(
    ...validateRuntimeLayerStyleSpecSync(materialized, {
      mode: context.styleSpecValidationMode,
      style: context.style,
      path: `layers.${materialized.id}`,
      ...sourceContext,
    }),
  );

  return diagnostics;
}

export function validateRuntimeStyleExpression(
  value: unknown,
  options: RuntimeExpressionValidationOptions = {},
): HonuaRuntimeDiagnostic[] {
  const materialized = materializeStyleValue(value);
  if (!Array.isArray(materialized)) {
    return [];
  }
  if (!looksLikeExpressionArray(materialized)) {
    return options.requireExpression
      ? [
          diagnostic("expression-operator-invalid", "Expression arrays must start with an operator string.", {
            ...options,
          }),
        ]
      : [];
  }
  return [
    ...validateExpressionArray(materialized, options),
    ...validateRuntimeStyleExpressionStyleSpecSync(materialized, styleSpecOptions(options)),
  ];
}

export function validateRuntimeFilterExpression(
  filter: unknown,
  options: Omit<RuntimeExpressionValidationOptions, "kind" | "requireExpression"> = {},
): HonuaRuntimeDiagnostic[] {
  const materialized = materializeStyleValue(filter);
  if (!Array.isArray(materialized)) {
    return [
      diagnostic("filter-invalid", "Layer filter must be a MapLibre expression array.", {
        kind: "filter",
        requireExpression: true,
        ...options,
      }),
    ];
  }
  const expressionOptions = {
    kind: "filter" as const,
    requireExpression: true,
    ...options,
  };
  return [
    ...validateRuntimeStyleExpression(materialized, expressionOptions),
    ...validateRuntimeFilterStyleSpecSync(materialized, styleSpecOptions(expressionOptions)),
  ];
}

export function throwRuntimeDiagnostics(
  diagnostics: readonly HonuaRuntimeDiagnostic[],
  message = "Runtime style diagnostics failed.",
): void {
  const errors = diagnostics.filter((entry) => entry.severity === "error");
  if (errors.length > 0) {
    throw new HonuaRuntimeDiagnosticError(message, errors);
  }
}

export function rendererRuntimeDiagnosticError(
  message: string,
  diagnostic: Omit<HonuaRuntimeDiagnostic, "severity"> & { readonly severity?: HonuaRuntimeDiagnosticSeverity },
  cause: unknown,
): HonuaRuntimeDiagnosticError {
  return new HonuaRuntimeDiagnosticError(
    message,
    [
      {
        severity: "error",
        ...diagnostic,
      },
    ],
    cause,
  );
}

export function resolveRuntimeBeforeId(
  style: HonuaStyleSpecification,
  order: RuntimeLayerOrder,
  movingLayerId?: string,
): { beforeId: string | undefined; diagnostics: HonuaRuntimeDiagnostic[] } {
  const diagnostics: HonuaRuntimeDiagnostic[] = [];
  const orderedLayers = style.layers.filter((layer) => layer.id !== movingLayerId);

  if (order === undefined) {
    return { beforeId: undefined, diagnostics };
  }

  if (typeof order === "string") {
    if (order && !orderedLayers.some((layer) => layer.id === order)) {
      diagnostics.push({
        code: "layer-order-before-missing",
        severity: "error",
        message: `Cannot insert before missing layer "${order}".`,
        layerId: movingLayerId,
        path: "beforeId",
      });
    }
    return { beforeId: order || undefined, diagnostics };
  }

  const requested = [order.beforeId, order.afterId, order.position].filter((value) => value !== undefined);
  if (requested.length > 1) {
    diagnostics.push({
      code: "layer-order-conflict",
      severity: "error",
      message: "Specify only one of beforeId, afterId, or position.",
      layerId: movingLayerId,
      path: "order",
    });
    return { beforeId: undefined, diagnostics };
  }

  if (order.beforeId !== undefined) {
    if (!orderedLayers.some((layer) => layer.id === order.beforeId)) {
      diagnostics.push({
        code: "layer-order-before-missing",
        severity: "error",
        message: `Cannot insert before missing layer "${order.beforeId}".`,
        layerId: movingLayerId,
        path: "order.beforeId",
      });
    }
    return { beforeId: order.beforeId, diagnostics };
  }

  if (order.afterId !== undefined) {
    const index = orderedLayers.findIndex((layer) => layer.id === order.afterId);
    if (index === -1) {
      diagnostics.push({
        code: "layer-order-after-missing",
        severity: "error",
        message: `Cannot insert after missing layer "${order.afterId}".`,
        layerId: movingLayerId,
        path: "order.afterId",
      });
      return { beforeId: undefined, diagnostics };
    }
    return { beforeId: orderedLayers[index + 1]?.id, diagnostics };
  }

  if (order.position === "bottom") {
    return { beforeId: orderedLayers[0]?.id, diagnostics };
  }

  return { beforeId: undefined, diagnostics };
}

export function sourceContextForLayer(
  style: HonuaStyleSpecification,
  mapPackage: HonuaMapPackage | undefined,
  layerId: string,
): { sourceId: string; sourceLayer: string | undefined; protocol: string | undefined } | undefined {
  const layer = style.layers.find((entry) => entry.id === layerId);
  if (!layer?.source) return undefined;
  return {
    sourceId: layer.source,
    sourceLayer: layer["source-layer"],
    protocol: protocolForSource(style, mapPackage, layer.source),
  };
}

export function featureTargetForLayer(
  style: HonuaStyleSpecification,
  layerId: string,
  id: FeatureId,
): RuntimeFeatureStateTarget | undefined {
  const layer = style.layers.find((entry) => entry.id === layerId);
  if (!layer?.source) return undefined;
  return {
    source: layer.source,
    id,
    ...(layer["source-layer"] !== undefined ? { sourceLayer: layer["source-layer"] } : {}),
  };
}

export function selectionTargetForLayer(
  style: HonuaStyleSpecification,
  layerId: string,
  id: FeatureId,
): SourceQualifiedFeatureSelectionTarget | undefined {
  const target = featureTargetForLayer(style, layerId, id);
  if (!target) return undefined;
  return sourceFeatureSelectionTarget(target.source, target.id, { sourceLayer: target.sourceLayer });
}

export function featureStateTargetFromSelection(
  target: SourceQualifiedFeatureSelectionTarget,
): RuntimeFeatureStateTarget {
  return {
    source: target.sourceId,
    id: target.id,
    ...(target.sourceLayer !== undefined ? { sourceLayer: target.sourceLayer } : {}),
  };
}

export function featureStateTargetKey(target: RuntimeFeatureStateTarget): string {
  return `${target.source}\u0000${target.sourceLayer ?? ""}\u0000${typeof target.id}:${String(target.id)}`;
}

export function protocolForSource(
  style: HonuaStyleSpecification,
  mapPackage: HonuaMapPackage | undefined,
  sourceId: string | undefined,
): string | undefined {
  if (!sourceId) return undefined;
  const bindingProtocol = mapPackage?.sourceBindings.find((binding) => binding.sourceId === sourceId)?.protocol;
  if (bindingProtocol) return bindingProtocol;
  const source = style.sources[sourceId];
  return typeof source?.type === "string" ? source.type : undefined;
}

export function resolveFeatureIdFromEventFeature(
  feature: unknown,
  event: unknown,
  options: RuntimeClickInteractionOptions = {},
): FeatureId | undefined {
  const explicit = options.resolveFeatureId?.(feature, event);
  if (explicit !== undefined) return explicit;

  if (isPlainObject(feature)) {
    const directId = feature.id;
    if (typeof directId === "string" || typeof directId === "number") return directId;

    if (options.featureIdProperty && isPlainObject(feature.properties)) {
      const propertyId = feature.properties[options.featureIdProperty];
      if (typeof propertyId === "string" || typeof propertyId === "number") return propertyId;
    }
  }

  return undefined;
}

function validateExpressionArray(
  expr: readonly unknown[],
  options: RuntimeExpressionValidationOptions,
): HonuaRuntimeDiagnostic[] {
  const diagnostics: HonuaRuntimeDiagnostic[] = [];
  if (expr.length === 0) {
    return [diagnostic("expression-empty", "Expression array must not be empty.", options)];
  }

  const operator = expr[0];
  if (typeof operator !== "string") {
    return [
      diagnostic("expression-operator-invalid", "Expression arrays must start with an operator string.", options),
    ];
  }

  const rule = EXPRESSION_OPERATORS[operator];
  if (!rule) {
    diagnostics.push(
      diagnostic(
        "expression-operator-unknown",
        `Expression operator "${operator}" is not recognized by Honua's built-in validator.`,
        {
          ...options,
          strictUnknownOperators: options.strictUnknownOperators,
          context: { operator },
        },
        options.strictUnknownOperators ? "error" : "warning",
      ),
    );
  } else {
    const argCount = expr.length - 1;
    if (rule.minArgs !== undefined && argCount < rule.minArgs) {
      diagnostics.push(
        diagnostic(
          "expression-arity-too-small",
          `Expression operator "${operator}" expects at least ${rule.minArgs} argument(s), received ${argCount}.`,
          { ...options, context: { operator, expected: rule.minArgs, received: argCount } },
        ),
      );
    }
    if (rule.maxArgs !== undefined && argCount > rule.maxArgs) {
      diagnostics.push(
        diagnostic(
          "expression-arity-too-large",
          `Expression operator "${operator}" expects at most ${rule.maxArgs} argument(s), received ${argCount}.`,
          { ...options, context: { operator, expected: rule.maxArgs, received: argCount } },
        ),
      );
    }
    diagnostics.push(...(rule.custom?.(expr, options) ?? []));
  }

  if (operator === "literal") {
    return diagnostics;
  }

  for (let i = 1; i < expr.length; i++) {
    const entry = expr[i];
    if (Array.isArray(entry) && looksLikeExpressionArray(entry)) {
      diagnostics.push(
        ...validateExpressionArray(entry, {
          ...options,
          path: pathWithIndex(options.path, i),
        }),
      );
    }
  }

  return diagnostics;
}

function validateCaseExpression(
  expr: readonly unknown[],
  options: RuntimeExpressionValidationOptions,
): HonuaRuntimeDiagnostic[] {
  const argCount = expr.length - 1;
  if (argCount < 3 || argCount % 2 === 0) {
    return [
      diagnostic(
        "expression-case-invalid",
        'The "case" expression requires condition/output pairs followed by a fallback value.',
        { ...options, context: { operator: "case", received: argCount } },
      ),
    ];
  }
  return [];
}

function validateMatchExpression(
  expr: readonly unknown[],
  options: RuntimeExpressionValidationOptions,
): HonuaRuntimeDiagnostic[] {
  const argCount = expr.length - 1;
  if (argCount < 4 || argCount % 2 !== 0) {
    return [
      diagnostic(
        "expression-match-invalid",
        'The "match" expression requires an input, label/output pairs, and a fallback value.',
        { ...options, context: { operator: "match", received: argCount } },
      ),
    ];
  }
  return [];
}

function validateStepExpression(
  expr: readonly unknown[],
  options: RuntimeExpressionValidationOptions,
): HonuaRuntimeDiagnostic[] {
  const argCount = expr.length - 1;
  if (argCount < 4 || argCount % 2 !== 0) {
    return [
      diagnostic(
        "expression-step-invalid",
        'The "step" expression requires an input, base output, and stop/output pairs.',
        { ...options, context: { operator: "step", received: argCount } },
      ),
    ];
  }
  return [];
}

function validateInterpolateExpression(
  expr: readonly unknown[],
  options: RuntimeExpressionValidationOptions,
): HonuaRuntimeDiagnostic[] {
  if (expr.length < 7 || (expr.length - 3) % 2 !== 0) {
    return [
      diagnostic(
        "expression-interpolate-invalid",
        'The "interpolate" expression requires an interpolation mode, input, and stop/output pairs.',
        { ...options, context: { operator: String(expr[0]), received: expr.length - 1 } },
      ),
    ];
  }
  return [];
}

function sourceDiagnosticContext(
  sourceId: string,
  source: RuntimeSourceSpecification | undefined,
  context: RuntimeStyleValidationContext,
): Pick<HonuaRuntimeDiagnostic, "sourceId" | "protocol" | "context"> {
  const protocol = source?.type ?? protocolForSource(context.style ?? emptyStyle(), context.mapPackage, sourceId);
  return {
    sourceId,
    ...(protocol ? { protocol } : {}),
    ...(context.operation ? { context: { operation: context.operation } } : {}),
  };
}

function layerDiagnosticContext(
  layerId: string | undefined,
  sourceId: string | undefined,
  context: RuntimeStyleValidationContext,
): Pick<HonuaRuntimeDiagnostic, "sourceId" | "layerId" | "protocol" | "context"> {
  return {
    ...(sourceId ? { sourceId } : {}),
    ...(layerId ? { layerId } : {}),
    ...(protocolForSource(context.style ?? emptyStyle(), context.mapPackage, sourceId) !== undefined
      ? { protocol: protocolForSource(context.style ?? emptyStyle(), context.mapPackage, sourceId) }
      : {}),
    ...(context.operation ? { context: { operation: context.operation } } : {}),
  };
}

function diagnostic(
  code: string,
  message: string,
  options: RuntimeExpressionValidationOptions,
  severity: HonuaRuntimeDiagnosticSeverity = "error",
): HonuaRuntimeDiagnostic {
  return {
    code,
    severity,
    message,
    ...(options.path ? { path: options.path } : {}),
    ...(options.sourceId ? { sourceId: options.sourceId } : {}),
    ...(options.layerId ? { layerId: options.layerId } : {}),
    ...(options.protocol ? { protocol: options.protocol } : {}),
    ...(options.context ? { context: options.context } : {}),
  };
}

function styleSpecOptions(options: RuntimeExpressionValidationOptions): {
  mode: RuntimeStyleSpecValidationMode | undefined;
  path: string | undefined;
  sourceId: string | undefined;
  layerId: string | undefined;
  protocol: string | undefined;
  context: Readonly<Record<string, unknown>> | undefined;
} {
  return {
    mode: options.styleSpecValidationMode,
    path: options.path,
    sourceId: options.sourceId,
    layerId: options.layerId,
    protocol: options.protocol,
    context: options.context,
  };
}

function looksLikeExpressionArray(value: readonly unknown[]): boolean {
  return value.length > 0 && typeof value[0] === "string";
}

function pathWithIndex(path: string | undefined, index: number): string {
  return path ? `${path}[${index}]` : `[${index}]`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyStyle(): HonuaStyleSpecification {
  return { version: 8, sources: {}, layers: [] };
}
