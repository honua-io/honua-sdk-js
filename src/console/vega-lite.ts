/**
 * Browser-safe Vega-Lite chart spec contract for Console dashboards/reports.
 *
 * Console renders dashboard and report charts with Vega-Lite. The SDK does not
 * bundle Vega — it only owns the **portable, validated spec shape** so dashboard
 * and report packages can carry chart specs that round-trip cleanly between the
 * server, the SDK projection, and the Console renderer. This is a deliberately
 * narrow subset of the Vega-Lite grammar (single-view, encoding-based marks)
 * sufficient for the operations-dashboard chart kinds.
 *
 * @module
 */

import { HonuaConsoleError } from "./errors.js";

export const HONUA_CONSOLE_VEGA_LITE_SCHEMA = "https://vega.github.io/schema/vega-lite/v5.json" as const;

export type HonuaVegaLiteMark = "bar" | "line" | "point" | "area" | "arc" | "rect" | "tick";

export type HonuaVegaLiteFieldType = "quantitative" | "temporal" | "ordinal" | "nominal";

export type HonuaVegaLiteAggregate = "count" | "sum" | "mean" | "median" | "min" | "max" | (string & {});

export interface HonuaVegaLiteFieldDef {
  readonly field?: string;
  readonly type: HonuaVegaLiteFieldType;
  readonly aggregate?: HonuaVegaLiteAggregate;
  readonly timeUnit?: string;
  readonly bin?: boolean | { readonly maxbins?: number };
  readonly title?: string;
  readonly sort?: "ascending" | "descending" | null;
  readonly [extra: string]: unknown;
}

export interface HonuaVegaLiteEncoding {
  readonly x?: HonuaVegaLiteFieldDef;
  readonly y?: HonuaVegaLiteFieldDef;
  readonly color?: HonuaVegaLiteFieldDef;
  readonly theta?: HonuaVegaLiteFieldDef;
  readonly tooltip?: HonuaVegaLiteFieldDef | ReadonlyArray<HonuaVegaLiteFieldDef>;
  readonly [channel: string]: HonuaVegaLiteFieldDef | ReadonlyArray<HonuaVegaLiteFieldDef> | undefined;
}

/**
 * Inline data values. Console may instead bind a named data source at render
 * time; when `values` is omitted the spec is a template the host populates.
 */
export interface HonuaVegaLiteData {
  readonly name?: string;
  readonly values?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly [extra: string]: unknown;
}

/**
 * SDK-projected Vega-Lite chart spec. Carries the SDK schema marker so the
 * renderer can confirm the contract version. Extra Vega-Lite properties survive
 * via the open index signature.
 */
export interface HonuaVegaLiteSpec {
  readonly $schema?: typeof HONUA_CONSOLE_VEGA_LITE_SCHEMA | (string & {});
  readonly title?: string;
  readonly description?: string;
  readonly width?: number | "container";
  readonly height?: number | "container";
  readonly mark: HonuaVegaLiteMark | { readonly type: HonuaVegaLiteMark; readonly [extra: string]: unknown };
  readonly encoding: HonuaVegaLiteEncoding;
  readonly data?: HonuaVegaLiteData;
  readonly [extra: string]: unknown;
}

const VEGA_LITE_MARKS: ReadonlySet<string> = new Set<HonuaVegaLiteMark>([
  "bar",
  "line",
  "point",
  "area",
  "arc",
  "rect",
  "tick",
]);

const VEGA_LITE_FIELD_TYPES: ReadonlySet<string> = new Set<HonuaVegaLiteFieldType>([
  "quantitative",
  "temporal",
  "ordinal",
  "nominal",
]);

function markType(mark: HonuaVegaLiteSpec["mark"]): string | undefined {
  if (typeof mark === "string") return mark;
  if (mark && typeof mark === "object" && typeof mark.type === "string") return mark.type;
  return undefined;
}

/**
 * Validates the SDK Vega-Lite subset and narrows an unknown value to
 * {@link HonuaVegaLiteSpec}. Throws a typed {@link HonuaConsoleError} with code
 * `invalid-vega-lite-spec` (or `unsupported-chart-spec` for an out-of-subset
 * mark/type) so Console can render a precise failure state.
 */
export function assertVegaLiteSpec(
  value: unknown,
  context: { readonly chartId?: string; readonly path?: string } = {},
): asserts value is HonuaVegaLiteSpec {
  const path = context.path ?? "spec";
  if (!value || typeof value !== "object") {
    throw new HonuaConsoleError("invalid-vega-lite-spec", "Vega-Lite spec must be an object", {
      stage: "chart",
      detail: { ...context, path, received: value },
    });
  }
  const spec = value as Record<string, unknown>;
  const mark = markType(spec.mark as HonuaVegaLiteSpec["mark"]);
  if (!mark) {
    throw new HonuaConsoleError("invalid-vega-lite-spec", "Vega-Lite spec is missing a mark", {
      stage: "chart",
      detail: { ...context, path: `${path}.mark` },
    });
  }
  if (!VEGA_LITE_MARKS.has(mark)) {
    throw new HonuaConsoleError("unsupported-chart-spec", `Unsupported Vega-Lite mark "${mark}"`, {
      stage: "chart",
      detail: { ...context, path: `${path}.mark`, received: mark, expected: [...VEGA_LITE_MARKS] },
    });
  }
  const encoding = spec.encoding;
  if (!encoding || typeof encoding !== "object") {
    throw new HonuaConsoleError("invalid-vega-lite-spec", "Vega-Lite spec is missing encoding", {
      stage: "chart",
      detail: { ...context, path: `${path}.encoding` },
    });
  }
  for (const [channel, def] of Object.entries(encoding as Record<string, unknown>)) {
    if (def === undefined) continue;
    const defs = Array.isArray(def) ? def : [def];
    for (const fieldDef of defs) {
      if (!fieldDef || typeof fieldDef !== "object") {
        throw new HonuaConsoleError("invalid-vega-lite-spec", `Encoding channel "${channel}" must be a field def`, {
          stage: "chart",
          detail: { ...context, path: `${path}.encoding.${channel}`, received: fieldDef },
        });
      }
      const type = (fieldDef as Record<string, unknown>).type;
      if (typeof type !== "string" || !VEGA_LITE_FIELD_TYPES.has(type)) {
        throw new HonuaConsoleError(
          "unsupported-chart-spec",
          `Encoding channel "${channel}" has unsupported type "${String(type)}"`,
          {
            stage: "chart",
            detail: {
              ...context,
              path: `${path}.encoding.${channel}.type`,
              received: type,
              expected: [...VEGA_LITE_FIELD_TYPES],
            },
          },
        );
      }
    }
  }
}

/** Returns `true` when `value` is a valid SDK-subset Vega-Lite spec. */
export function isVegaLiteSpec(value: unknown): value is HonuaVegaLiteSpec {
  try {
    assertVegaLiteSpec(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes an SDK-subset Vega-Lite spec to a stable, validated shape: pins the
 * SDK `$schema`, coerces a string mark to a `{ type }` object only when extra
 * mark props are absent (string form is preserved otherwise), and validates the
 * result. The output round-trips through {@link assertVegaLiteSpec}.
 */
export function normalizeVegaLiteSpec(
  value: unknown,
  context: { readonly chartId?: string; readonly path?: string } = {},
): HonuaVegaLiteSpec {
  assertVegaLiteSpec(value, context);
  const spec = value as HonuaVegaLiteSpec;
  return {
    ...spec,
    $schema: spec.$schema ?? HONUA_CONSOLE_VEGA_LITE_SCHEMA,
  };
}
