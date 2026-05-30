import { describe, expect, it } from "vitest";

import {
  HONUA_CONSOLE_DASHBOARD_PACKAGE_FORMAT_V1,
  HONUA_CONSOLE_REPORT_PACKAGE_FORMAT_V1,
  HONUA_CONSOLE_VEGA_LITE_SCHEMA,
  type HonuaConsoleDashboardPackage,
  HonuaConsoleError,
  type HonuaConsoleReportPackage,
  type HonuaVegaLiteSpec,
  assertVegaLiteSpec,
  chartWidgetToVegaLiteSpec,
  isKnownConsoleContentKind,
  isVegaLiteSpec,
  normalizeVegaLiteSpec,
  projectDashboardPackage,
  projectReportPackage,
  toConsoleDiagnostic,
} from "../src/console/index.js";

const validSpec: HonuaVegaLiteSpec = {
  mark: "bar",
  encoding: {
    x: { field: "status", type: "nominal" },
    y: { aggregate: "count", type: "quantitative" },
  },
};

describe("console content contracts", () => {
  it("recognizes known content kinds and flags unknown ones", () => {
    expect(isKnownConsoleContentKind("dashboard")).toBe(true);
    expect(isKnownConsoleContentKind("report")).toBe(true);
    expect(isKnownConsoleContentKind("map-package")).toBe(true);
    expect(isKnownConsoleContentKind("totally-new-kind")).toBe(false);
  });
});

describe("vega-lite chart spec", () => {
  it("accepts a valid SDK-subset spec", () => {
    expect(isVegaLiteSpec(validSpec)).toBe(true);
  });

  it("normalize pins the SDK $schema and round-trips through assert", () => {
    const normalized = normalizeVegaLiteSpec(validSpec);
    expect(normalized.$schema).toBe(HONUA_CONSOLE_VEGA_LITE_SCHEMA);
    // Round-trip: a normalized spec must still validate, and re-normalizing is stable.
    expect(() => assertVegaLiteSpec(normalized)).not.toThrow();
    expect(normalizeVegaLiteSpec(normalized)).toEqual(normalized);
  });

  it("preserves an explicit $schema and extra properties on round-trip", () => {
    const withExtras: HonuaVegaLiteSpec = {
      ...validSpec,
      $schema: HONUA_CONSOLE_VEGA_LITE_SCHEMA,
      title: "Incidents by status",
      width: "container",
      mark: { type: "bar", cornerRadius: 2 },
    };
    const normalized = normalizeVegaLiteSpec(withExtras);
    expect(normalized).toEqual(withExtras);
  });

  it("rejects an unsupported mark with a typed error", () => {
    expect(() => assertVegaLiteSpec({ mark: "geoshape", encoding: { x: { type: "nominal" } } })).toThrowError(
      HonuaConsoleError,
    );
    try {
      assertVegaLiteSpec({ mark: "geoshape", encoding: { x: { type: "nominal" } } }, { chartId: "c1" });
    } catch (error) {
      const diag = toConsoleDiagnostic(error);
      expect(diag.code).toBe("unsupported-chart-spec");
      expect(diag.stage).toBe("chart");
      expect(diag.detail?.chartId).toBe("c1");
    }
  });

  it("rejects an unsupported encoding type", () => {
    expect(() => assertVegaLiteSpec({ mark: "bar", encoding: { x: { field: "a", type: "geojson" } } })).toThrowError(
      /unsupported type/,
    );
  });

  it("rejects a non-object / missing-encoding spec", () => {
    expect(() => assertVegaLiteSpec(null)).toThrowError(HonuaConsoleError);
    expect(() => assertVegaLiteSpec({ mark: "bar" })).toThrowError(/missing encoding/);
  });
});

describe("chartWidgetToVegaLiteSpec bridge", () => {
  it("projects a categories widget to a bar chart spec", () => {
    const spec = chartWidgetToVegaLiteSpec({ chartKind: "categories", groupBy: "status", title: "By status" });
    expect(spec.mark).toBe("bar");
    expect(spec.title).toBe("By status");
    expect(spec.encoding.x?.field).toBe("status");
    expect(isVegaLiteSpec(spec)).toBe(true);
  });

  it("projects a histogram widget with bins", () => {
    const spec = chartWidgetToVegaLiteSpec({ chartKind: "histogram", field: "magnitude", bins: 20 });
    expect(spec.mark).toBe("bar");
    expect(spec.encoding.x?.bin).toEqual({ maxbins: 20 });
    expect(isVegaLiteSpec(spec)).toBe(true);
  });

  it("projects a time-series widget to a line chart spec", () => {
    const spec = chartWidgetToVegaLiteSpec({ chartKind: "time-series", field: "reportedAt" });
    expect(spec.mark).toBe("line");
    expect(spec.encoding.x?.type).toBe("temporal");
    expect(isVegaLiteSpec(spec)).toBe(true);
  });

  it("raises a typed missing-binding error when a required field is absent", () => {
    try {
      chartWidgetToVegaLiteSpec({ chartKind: "histogram" }, { chartId: "w9" });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HonuaConsoleError);
      const diag = toConsoleDiagnostic(error);
      expect(diag.code).toBe("missing-binding");
      expect(diag.detail?.chartId).toBe("w9");
      expect(diag.detail?.path).toBe("field");
    }
  });
});

describe("dashboard package projection", () => {
  const dashboard: HonuaConsoleDashboardPackage = {
    format: HONUA_CONSOLE_DASHBOARD_PACKAGE_FORMAT_V1,
    id: "dash-1",
    title: "Operations",
    panels: [
      { id: "p-map", kind: "map" },
      { id: "p-chart", kind: "chart", title: "Status", chartSpec: validSpec, binding: { sourceId: "incidents" } },
    ],
  };

  it("projects chart panels and round-trips Vega-Lite specs", () => {
    const model = projectDashboardPackage(dashboard);
    expect(model.id).toBe("dash-1");
    expect(model.charts).toHaveLength(1);
    expect(model.charts[0]?.id).toBe("p-chart");
    expect(model.charts[0]?.chartSpec.$schema).toBe(HONUA_CONSOLE_VEGA_LITE_SCHEMA);
    expect(model.charts[0]?.binding?.sourceId).toBe("incidents");
    // Non-chart panels are preserved on the model for layout.
    expect(model.panels).toHaveLength(2);
  });

  it("raises a typed missing-chart-spec error for a chart panel without a spec", () => {
    const broken: HonuaConsoleDashboardPackage = {
      ...dashboard,
      panels: [{ id: "p-broken", kind: "chart" }],
    };
    try {
      projectDashboardPackage(broken);
      throw new Error("expected throw");
    } catch (error) {
      const diag = toConsoleDiagnostic(error);
      expect(diag.code).toBe("missing-chart-spec");
      expect(diag.detail?.panelId).toBe("p-broken");
    }
  });

  it("rejects an unsupported package format", () => {
    const bad = { ...dashboard, format: "honua_dashboard_package.v2" } as unknown as HonuaConsoleDashboardPackage;
    try {
      projectDashboardPackage(bad);
      throw new Error("expected throw");
    } catch (error) {
      expect(toConsoleDiagnostic(error).code).toBe("unsupported-package-format");
    }
  });
});

describe("report package projection", () => {
  const report: HonuaConsoleReportPackage = {
    format: HONUA_CONSOLE_REPORT_PACKAGE_FORMAT_V1,
    id: "rep-1",
    title: "Quarterly",
    sections: [
      {
        id: "s1",
        title: "Summary",
        body: "Overview text",
        panels: [{ id: "c1", kind: "chart", chartSpec: validSpec }],
      },
      { id: "s2", title: "Notes" },
    ],
  };

  it("projects each section's chart panels", () => {
    const model = projectReportPackage(report);
    expect(model.sections).toHaveLength(2);
    expect(model.sections[0]?.charts).toHaveLength(1);
    expect(model.sections[0]?.charts[0]?.chartSpec.$schema).toBe(HONUA_CONSOLE_VEGA_LITE_SCHEMA);
    expect(model.sections[0]?.body).toBe("Overview text");
    expect(model.sections[1]?.charts).toHaveLength(0);
  });
});
