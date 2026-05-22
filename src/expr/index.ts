/**
 * `@honua/sdk-js/expr` — Honua expression builder.
 *
 * A small, typed DSL that compiles to the MapLibre-style style/filter
 * expression shape. Use it to build runtime style expressions, layer
 * filters, and Honua-side projections without hand-rolling JSON arrays.
 *
 * @example
 * ```ts
 * import { get, eq, all, gt, interpolate, linear, zoom, rgb } from "@honua/sdk-js/expr";
 *
 * // Filter: STATUS = 'ACTIVE' AND POPULATION > 10000
 * const filter = all(eq(get("STATUS"), "ACTIVE"), gt(get("POPULATION"), 10000));
 *
 * // Paint expression: interpolate point color by zoom
 * const color = interpolate(linear(), zoom(), 8, rgb(70, 130, 180), 14, rgb(220, 20, 60));
 * ```
 *
 * @example Render to a JSON expression
 * ```ts
 * import { expr, eq, get } from "@honua/sdk-js/expr";
 *
 * const isActive = eq(get("STATUS"), "ACTIVE");
 * const json = expr(isActive); // ["==", ["get", "STATUS"], "ACTIVE"]
 * map.setFilter("parcels", json);
 * ```
 *
 * @packageDocumentation
 */
export {
  expr,
  Expr,
  get,
  has,
  at,
  contains,
  indexOf,
  slice,
  length,
  id,
  geometryType,
  properties,
  featureState,
  lineProgress,
  heatmapDensity,
  pitch,
  accumulated,
  distanceFromCenter,
  literal,
  toBoolean,
  toNumber,
  exprToString,
  toColor,
  typeOf,
  eq,
  neq,
  lt,
  lte,
  gt,
  gte,
  not,
  all,
  any,
  switchCase,
  matchExpr,
  coalesce,
  add,
  subtract,
  multiply,
  divide,
  mod,
  pow,
  abs,
  ceil,
  floor,
  round,
  sqrt,
  ln,
  log2,
  log10,
  sin,
  cos,
  tan,
  asin,
  acos,
  atan,
  min,
  max,
  e,
  pi,
  ln2Const,
  concat,
  upcase,
  downcase,
  rgb,
  rgba,
  step,
  interpolate,
  interpolateHcl,
  interpolateLab,
  linear,
  exponential,
  cubicBezier,
  zoom,
  letExpr,
  varExpr,
  format,
  numberFormat,
  collator,
  resolvedLocale,
  hsl,
  hsla,
  toRgba,
  image,
  distance,
  within,
  intersects,
} from "./expression.js";
export type {
  ExprColor,
  ExprFormatted,
  ExprImage,
  ExprValue,
  NumberInput,
  StringInput,
  BooleanInput,
  ColorInput,
  Resolvable,
  InterpolationMethod,
  GeoJsonPoint,
  GeoJsonMultiPoint,
  GeoJsonLineString,
  GeoJsonMultiLineString,
  GeoJsonPolygon,
  GeoJsonMultiPolygon,
  GeoJsonGeometry,
  FormatSegmentOptions,
  NumberFormatOptions,
  CollatorOptions,
  ExprCollator,
} from "./expression.js";
