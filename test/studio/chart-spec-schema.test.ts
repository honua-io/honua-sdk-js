import fs from "node:fs";

import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import type { HonuaGeneratedAppChartWidget } from "../../src/generated-app/manifest.js";
import { HONUA_VEGA_LITE_SCHEMA, chartWidgetToVegaLiteSpec } from "../../src/studio/index.js";

const schema = JSON.parse(
  fs.readFileSync(new URL("../../node_modules/vega-lite/build/vega-lite-schema.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const ajv = new Ajv.default({ allErrors: true, strict: false });
const validateVegaLite = ajv.compile(schema);

const widgets: ReadonlyArray<HonuaGeneratedAppChartWidget> = [
  {
    id: "categories",
    kind: "chart",
    chartKind: "categories",
    title: "Parcels by zone",
    groupBy: "zone",
  },
  {
    id: "histogram",
    kind: "chart",
    chartKind: "histogram",
    field: "area",
    bins: 8,
  },
  {
    id: "time-series",
    kind: "chart",
    chartKind: "time-series",
    field: "observedAt",
    metric: { fn: "sum", field: "area", alias: "Area" },
  },
];

describe("Studio Vega-Lite v6 chart grammar", () => {
  it.each(widgets)("emits a schema-valid $chartKind spec with a named dataset", (widget) => {
    const spec = chartWidgetToVegaLiteSpec(widget);

    expect(spec?.$schema).toBe(HONUA_VEGA_LITE_SCHEMA);
    expect(spec?.data).toEqual({ name: widget.id });
    expect(validateVegaLite(spec), JSON.stringify(validateVegaLite.errors)).toBe(true);
  });

  it.each(widgets)("emits a schema-valid $chartKind spec with inline rows", (widget) => {
    const rows = [{ zone: "residential", area: 640, observedAt: "2026-08-20T00:00:00Z" }];
    const spec = chartWidgetToVegaLiteSpec(widget, rows);

    expect(spec?.data).toEqual({ values: rows });
    expect(validateVegaLite(spec), JSON.stringify(validateVegaLite.errors)).toBe(true);
  });
});
