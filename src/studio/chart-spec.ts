/**
 * A documented, compatible subset of the Vega-Lite v6 spec used by Studio
 * dashboard and report charts. The acceptance criterion for cross-surface
 * parity is that "dashboard/report charts use Vega-Lite specs or an explicitly
 * documented compatible subset" — this module is that documented subset, plus
 * a pure helper that derives a spec from a generated-app chart widget so MCP,
 * QGIS, Console, and the SDK preview runtime all render the same chart.
 *
 * The subset is intentionally narrow: bar / arc / line / point marks over a
 * single positional encoding pair plus an optional color channel. It is a
 * structural subset of a real Vega-Lite `TopLevelSpec`, so a host may hand the
 * object directly to `vega-embed` / `vega-lite` without translation, while the
 * SDK stays free of a Vega dependency (these are plain data types).
 *
 * @experimental Not yet covered by the SDK's semver contract — these shapes
 *   may change in any minor release prior to `1.0.0`.
 * @module
 */

import type { HonuaGeneratedAppChartWidget } from "../generated-app/manifest.js";

/** Vega-Lite schema URL this subset targets. */
export const HONUA_VEGA_LITE_SCHEMA = "https://vega.github.io/schema/vega-lite/v6.json" as const;

/** Mark types in the supported subset. */
export type HonuaChartMark = "bar" | "line" | "point" | "arc";

/** Encoding field type in the supported subset. */
export type HonuaChartFieldType = "quantitative" | "nominal" | "ordinal" | "temporal";

/**
 * One positional / visual encoding channel. A structural subset of a
 * Vega-Lite `FieldDef`.
 *
 * @experimental
 */
export interface HonuaChartEncodingChannel {
  readonly field: string;
  readonly type: HonuaChartFieldType;
  readonly title?: string;
  readonly aggregate?: "count" | "sum" | "mean" | "min" | "max" | "median";
  readonly timeUnit?: string;
  readonly bin?: boolean | { readonly maxbins?: number };
}

/**
 * The encoding block. `x`/`y` are the positional pair; `color` is optional.
 *
 * @experimental
 */
export interface HonuaChartEncoding {
  readonly x?: HonuaChartEncodingChannel;
  readonly y?: HonuaChartEncodingChannel;
  readonly color?: HonuaChartEncodingChannel;
}

/**
 * The documented Vega-Lite-compatible chart spec. Inline `data.values` carry
 * the rows; a host may instead point `data.name` at a named dataset. The
 * `$schema` and structural layout make this directly consumable by Vega-Lite.
 *
 * @experimental
 */
export interface HonuaVegaLiteChartSpec {
  readonly $schema: typeof HONUA_VEGA_LITE_SCHEMA;
  readonly title?: string;
  readonly description?: string;
  readonly mark: HonuaChartMark | { readonly type: HonuaChartMark; readonly tooltip?: boolean };
  readonly encoding: HonuaChartEncoding;
  readonly data: {
    readonly values?: ReadonlyArray<Record<string, unknown>>;
    readonly name?: string;
  };
  readonly width?: number | "container";
  readonly height?: number | "container";
}

/**
 * Map a generated-app chart widget kind to a Vega-Lite mark and the encoding
 * shape the subset expects.
 */
const CHART_KIND_MARK: Record<NonNullable<HonuaGeneratedAppChartWidget["chartKind"]>, HonuaChartMark> = {
  categories: "bar",
  histogram: "bar",
  "time-series": "line",
};

/**
 * Derive a {@link HonuaVegaLiteChartSpec} from a generated-app chart widget so
 * dashboard and report charts render identically across surfaces. `rows`, when
 * supplied, become inline `data.values`; otherwise the host binds the named
 * dataset identified by the widget id. Returns `undefined` when the widget lacks the field needed for its
 * chart kind (so a caller can degrade cleanly rather than emit a broken spec).
 *
 * @experimental
 */
export function chartWidgetToVegaLiteSpec(
  widget: HonuaGeneratedAppChartWidget,
  rows?: ReadonlyArray<Record<string, unknown>>,
): HonuaVegaLiteChartSpec | undefined {
  const chartKind = widget.chartKind ?? "categories";
  const mark = CHART_KIND_MARK[chartKind];

  let encoding: HonuaChartEncoding | undefined;
  if (chartKind === "categories") {
    const category = widget.groupBy ?? widget.field;
    if (!category) return undefined;
    encoding = {
      x: { field: category, type: "nominal", title: widget.title },
      y: { field: "count", type: "quantitative", aggregate: "count", title: "Count" },
    };
  } else if (chartKind === "histogram") {
    if (!widget.field) return undefined;
    encoding = {
      x: {
        field: widget.field,
        type: "quantitative",
        bin: widget.bins ? { maxbins: widget.bins } : true,
        title: widget.title ?? widget.field,
      },
      y: { field: "count", type: "quantitative", aggregate: "count", title: "Count" },
    };
  } else {
    // time-series
    const timeField = widget.field ?? widget.groupBy;
    if (!timeField) return undefined;
    const valueChannel: HonuaChartEncodingChannel = widget.metric
      ? {
          field: widget.metric.field === "*" ? "count" : widget.metric.field,
          type: "quantitative",
          aggregate: metricToAggregate(widget.metric.fn),
          title: widget.metric.alias ?? widget.metric.field,
        }
      : { field: "count", type: "quantitative", aggregate: "count", title: "Count" };
    encoding = {
      x: { field: timeField, type: "temporal", title: widget.title ?? timeField },
      y: valueChannel,
    };
  }

  return {
    $schema: HONUA_VEGA_LITE_SCHEMA,
    ...(widget.title ? { title: widget.title } : {}),
    mark: { type: mark, tooltip: true },
    encoding,
    width: "container",
    data: rows ? { values: rows } : { name: widget.id },
  };
}

function metricToAggregate(metric: string): NonNullable<HonuaChartEncodingChannel["aggregate"]> {
  switch (metric) {
    case "sum":
      return "sum";
    case "avg":
    case "mean":
      return "mean";
    case "min":
      return "min";
    case "max":
      return "max";
    default:
      return "count";
  }
}
