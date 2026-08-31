import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { HonuaGeneratedAppChartWidget } from "../../src/generated-app/manifest.js";
import { HONUA_MAP_PACKAGE_FORMAT_V1 } from "../../src/runtime/map-package.js";
import {
  HONUA_DASHBOARD_PACKAGE_FORMAT_V1,
  HONUA_PACKAGE_PROVENANCE_FORMAT_V1,
  HONUA_VEGA_LITE_SCHEMA,
  chartWidgetToVegaLiteSpec,
  getPackageProvenance,
  validatePackageProvenance,
  validateStudioPackage,
} from "../../src/studio/index.js";

const FIXTURE_DIR = path.join(process.cwd(), "test", "fixtures", "studio-packages");

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as Record<string, unknown>;
}

describe("cross-surface package fixtures", () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["map", "map-only.v1.json"],
    ["dashboard", "dashboard.v1.json"],
    ["report", "report.v1.json"],
    ["app", "app.v1.json"],
  ];

  it.each(cases)("%s fixture validates through the unified envelope", (family, file) => {
    const pkg = loadFixture(file);
    const response = validateStudioPackage(family, pkg);
    expect(response.valid, JSON.stringify(response.diagnostics)).toBe(true);
    expect(response.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it.each(cases)("%s fixture carries a parity provenance envelope", (_family, file) => {
    const pkg = loadFixture(file);
    const provenance = getPackageProvenance(pkg);
    expect(provenance).toBeDefined();
    expect(provenance?.format).toBe(HONUA_PACKAGE_PROVENANCE_FORMAT_V1);
    expect(["mcp", "qgis"]).toContain(provenance?.origin);
    expect(provenance?.prompt?.text).toBeTruthy();
    expect(provenance?.dataBindings?.length).toBeGreaterThan(0);
    expect(provenance?.permissions?.length).toBeGreaterThan(0);
  });

  it("report fixture declares a server-side render permission", () => {
    const provenance = getPackageProvenance(loadFixture("report.v1.json"));
    const render = provenance?.permissions?.find((p) => p.scope === "report:render");
    expect(render?.clientSide).toBe(false);
  });
});

describe("validateStudioPackage", () => {
  it("delegates the map family to the structural map validator", () => {
    const response = validateStudioPackage("map", { format: HONUA_MAP_PACKAGE_FORMAT_V1 });
    // Missing id / sourceBindings / mapSpec all surface from the map validator.
    expect(response.valid).toBe(false);
    expect(response.diagnostics.some((d) => d.code === "missing-map-package-id")).toBe(true);
    expect(response.diagnostics.some((d) => d.code === "missing-source-bindings")).toBe(true);
  });

  it("rejects an unknown family", () => {
    const response = validateStudioPackage("not-a-family", {});
    expect(response.valid).toBe(false);
    expect(response.diagnostics[0]?.code).toBe("unknown-family");
  });

  it("flags a wrong format string for a stub family", () => {
    const response = validateStudioPackage("report", { packageId: "r1", format: "wrong" });
    expect(response.valid).toBe(false);
    expect(response.diagnostics.some((d) => d.code === "unsupported-format")).toBe(true);
  });

  it("flags a missing identity field", () => {
    const response = validateStudioPackage("report", { format: "honua_report_package.v1" });
    expect(response.diagnostics.some((d) => d.code === "missing-package-id")).toBe(true);
  });

  it("uses packageId for the dashboard family and id for the app family", () => {
    expect(
      validateStudioPackage("dashboard", {
        format: HONUA_DASHBOARD_PACKAGE_FORMAT_V1,
        packageId: "dashboard-1",
        data: { sourceId: "incidents" },
        layout: { kind: "operations-dashboard", widgets: [] },
      }).valid,
    ).toBe(true);
    expect(validateStudioPackage("app", { id: "app1", version: "1.0.0" }).valid).toBe(true);
  });

  it("rejects lifecycle fields in the authored dashboard artifact", () => {
    const response = validateStudioPackage("dashboard", {
      format: HONUA_DASHBOARD_PACKAGE_FORMAT_V1,
      packageId: "dashboard-1",
      data: { sourceId: "incidents" },
      layout: { kind: "operations-dashboard", widgets: [] },
      proposalId: "proposal-1",
    });
    expect(response.valid).toBe(false);
    expect(response.diagnostics).toContainEqual(
      expect.objectContaining({ code: "dashboard-lifecycle-field", path: "proposalId" }),
    );
  });

  it("can require provenance to be present", () => {
    const response = validateStudioPackage(
      "report",
      { packageId: "r1", format: "honua_report_package.v1" },
      { requireProvenance: true },
    );
    expect(response.diagnostics.some((d) => d.code === "missing-provenance")).toBe(true);
  });

  it("treats an expired package as invalid", () => {
    const response = validateStudioPackage("report", {
      packageId: "r1",
      format: "honua_report_package.v1",
      expiresAt: "2000-01-01T00:00:00Z",
    });
    expect(response.diagnostics.some((d) => d.code === "expired-package")).toBe(true);
  });
});

describe("validatePackageProvenance", () => {
  it("accepts a well-formed envelope from any origin", () => {
    const response = validatePackageProvenance({
      provenance: {
        format: HONUA_PACKAGE_PROVENANCE_FORMAT_V1,
        origin: "qgis",
        dataBindings: [{ sourceId: "s1" }],
        permissions: [{ scope: "source:read" }],
      },
    });
    expect(response.valid).toBe(true);
    expect(response.pkg?.origin).toBe("qgis");
  });

  it("rejects an unsupported provenance format", () => {
    const response = validatePackageProvenance({ provenance: { format: "nope", origin: "mcp" } });
    expect(response.valid).toBe(false);
    expect(response.diagnostics.some((d) => d.code === "unsupported-provenance-format")).toBe(true);
  });

  it("warns on an unknown origin but stays valid", () => {
    const response = validatePackageProvenance({
      provenance: { format: HONUA_PACKAGE_PROVENANCE_FORMAT_V1, origin: "spreadsheet" },
    });
    expect(response.valid).toBe(true);
    expect(response.diagnostics.some((d) => d.code === "unknown-provenance-origin" && d.severity === "warning")).toBe(
      true,
    );
  });

  it("flags data bindings missing a sourceId", () => {
    const response = validatePackageProvenance({
      provenance: { format: HONUA_PACKAGE_PROVENANCE_FORMAT_V1, origin: "mcp", dataBindings: [{}] },
    });
    expect(response.valid).toBe(false);
    expect(response.diagnostics.some((d) => d.code === "invalid-provenance-data-binding")).toBe(true);
  });
});

describe("chartWidgetToVegaLiteSpec", () => {
  it("derives a bar spec for a categories chart", () => {
    const widget: HonuaGeneratedAppChartWidget = {
      id: "c1",
      kind: "chart",
      chartKind: "categories",
      title: "By status",
      groupBy: "status",
    };
    const spec = chartWidgetToVegaLiteSpec(widget);
    expect(spec?.$schema).toBe(HONUA_VEGA_LITE_SCHEMA);
    expect(spec?.data).toEqual({ name: "c1" });
    expect(typeof spec?.mark === "object" && spec?.mark.type).toBe("bar");
    expect(spec?.encoding.x?.field).toBe("status");
    expect(spec?.encoding.y?.aggregate).toBe("count");
  });

  it("derives a binned histogram spec", () => {
    const spec = chartWidgetToVegaLiteSpec({
      id: "c2",
      kind: "chart",
      chartKind: "histogram",
      field: "magnitude",
      bins: 12,
    });
    expect(spec?.encoding.x?.field).toBe("magnitude");
    expect(spec?.encoding.x?.bin).toEqual({ maxbins: 12 });
  });

  it("derives a temporal line spec for time-series", () => {
    const spec = chartWidgetToVegaLiteSpec({
      id: "c3",
      kind: "chart",
      chartKind: "time-series",
      field: "reported_at",
    });
    expect(typeof spec?.mark === "object" && spec?.mark.type).toBe("line");
    expect(spec?.encoding.x?.type).toBe("temporal");
  });

  it("inlines provided rows as data.values", () => {
    const rows = [{ status: "open", count: 3 }];
    const spec = chartWidgetToVegaLiteSpec(
      { id: "c4", kind: "chart", chartKind: "categories", groupBy: "status" },
      rows,
    );
    expect(spec?.data?.values).toEqual(rows);
  });

  it("returns undefined when a categories chart has no grouping field", () => {
    expect(chartWidgetToVegaLiteSpec({ id: "c5", kind: "chart", chartKind: "categories" })).toBeUndefined();
  });
});
