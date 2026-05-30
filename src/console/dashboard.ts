/**
 * Browser-safe dashboard + report package contracts for Console.
 *
 * A dashboard/report package is a server-owned artifact; this module names the
 * SDK-projected panel model Console renders and provides projection helpers that
 * validate Vega-Lite chart specs and surface typed missing-binding errors. It
 * also bridges the existing generated-app chart widget vocabulary into a
 * Vega-Lite spec so dashboards reuse the same chart kinds as generated apps.
 *
 * @module
 */

import type { HonuaConsoleMetadata, HonuaConsoleProvenance, HonuaConsoleSharing } from "./content.js";
import { HonuaConsoleError } from "./errors.js";
import { HONUA_CONSOLE_VEGA_LITE_SCHEMA, type HonuaVegaLiteSpec, normalizeVegaLiteSpec } from "./vega-lite.js";

export const HONUA_CONSOLE_DASHBOARD_PACKAGE_FORMAT_V1 = "honua_dashboard_package.v1" as const;
export const HONUA_CONSOLE_REPORT_PACKAGE_FORMAT_V1 = "honua_report_package.v1" as const;

export type HonuaConsoleDashboardPackageFormat = typeof HONUA_CONSOLE_DASHBOARD_PACKAGE_FORMAT_V1;
export type HonuaConsoleReportPackageFormat = typeof HONUA_CONSOLE_REPORT_PACKAGE_FORMAT_V1;

export type HonuaConsolePanelKind = "chart" | "map" | "metric" | "table" | "text" | (string & {});

/** Data binding a panel resolves against a content/source at render time. */
export interface HonuaConsolePanelBinding {
  readonly sourceId?: string;
  readonly contentId?: string;
  readonly field?: string;
  readonly [extra: string]: unknown;
}

export interface HonuaConsolePanelBase {
  readonly id: string;
  readonly kind: HonuaConsolePanelKind;
  readonly title?: string;
  readonly binding?: HonuaConsolePanelBinding;
  readonly layout?: { readonly x?: number; readonly y?: number; readonly w?: number; readonly h?: number };
  readonly [extra: string]: unknown;
}

export interface HonuaConsoleChartPanel extends HonuaConsolePanelBase {
  readonly kind: "chart";
  /** Inline Vega-Lite spec. Validated by the projection helpers. */
  readonly chartSpec?: HonuaVegaLiteSpec;
  readonly [extra: string]: unknown;
}

export type HonuaConsolePanel = HonuaConsoleChartPanel | HonuaConsolePanelBase;

/**
 * SDK-projected dashboard package. The server package is authoritative; this
 * shape is the browser-safe panel set Console hydrates.
 */
export interface HonuaConsoleDashboardPackage {
  readonly format: HonuaConsoleDashboardPackageFormat;
  readonly id: string;
  readonly version?: string;
  readonly title?: string;
  readonly metadata?: HonuaConsoleMetadata;
  readonly sharing?: HonuaConsoleSharing;
  readonly provenance?: HonuaConsoleProvenance;
  readonly panels: ReadonlyArray<HonuaConsolePanel>;
  readonly [extra: string]: unknown;
}

/**
 * SDK-projected report package. Reports are ordered sections of panels (often
 * chart panels) intended for print/export rather than an interactive grid.
 */
export interface HonuaConsoleReportSection {
  readonly id: string;
  readonly title?: string;
  readonly body?: string;
  readonly panels?: ReadonlyArray<HonuaConsolePanel>;
  readonly [extra: string]: unknown;
}

export interface HonuaConsoleReportPackage {
  readonly format: HonuaConsoleReportPackageFormat;
  readonly id: string;
  readonly version?: string;
  readonly title?: string;
  readonly metadata?: HonuaConsoleMetadata;
  readonly sharing?: HonuaConsoleSharing;
  readonly provenance?: HonuaConsoleProvenance;
  readonly sections: ReadonlyArray<HonuaConsoleReportSection>;
  readonly [extra: string]: unknown;
}

/** Console-rendered model for a single chart panel. */
export interface HonuaConsoleChartPanelModel {
  readonly id: string;
  readonly kind: "chart";
  readonly title?: string;
  readonly chartSpec: HonuaVegaLiteSpec;
  readonly binding?: HonuaConsolePanelBinding;
}

export interface HonuaConsoleDashboardRenderModel {
  readonly id: string;
  readonly title?: string;
  readonly charts: ReadonlyArray<HonuaConsoleChartPanelModel>;
  readonly panels: ReadonlyArray<HonuaConsolePanel>;
}

function isChartPanel(panel: HonuaConsolePanel): panel is HonuaConsoleChartPanel {
  return panel.kind === "chart";
}

/**
 * Validates a dashboard package and projects it to a Console render model.
 * Every chart panel must carry a Vega-Lite `chartSpec`; a missing spec raises a
 * typed `missing-chart-spec` error so Console can flag the broken panel instead
 * of rendering an empty box.
 */
export function projectDashboardPackage(pkg: HonuaConsoleDashboardPackage): HonuaConsoleDashboardRenderModel {
  if (pkg.format !== HONUA_CONSOLE_DASHBOARD_PACKAGE_FORMAT_V1) {
    throw new HonuaConsoleError(
      "unsupported-package-format",
      `Unsupported dashboard package format "${String(pkg.format)}"`,
      {
        stage: "projection",
        detail: { packageId: pkg.id, path: "format", received: pkg.format },
      },
    );
  }
  const charts: HonuaConsoleChartPanelModel[] = [];
  for (const panel of pkg.panels) {
    if (!isChartPanel(panel)) continue;
    if (!panel.chartSpec) {
      throw new HonuaConsoleError("missing-chart-spec", `Chart panel "${panel.id}" is missing a chartSpec`, {
        stage: "projection",
        detail: { packageId: pkg.id, panelId: panel.id, path: `panels.${panel.id}.chartSpec` },
      });
    }
    charts.push({
      id: panel.id,
      kind: "chart",
      ...(panel.title !== undefined ? { title: panel.title } : {}),
      chartSpec: normalizeVegaLiteSpec(panel.chartSpec, { chartId: panel.id, path: `panels.${panel.id}.chartSpec` }),
      ...(panel.binding ? { binding: panel.binding } : {}),
    });
  }
  return {
    id: pkg.id,
    ...(pkg.title !== undefined ? { title: pkg.title } : {}),
    charts,
    panels: pkg.panels,
  };
}

export interface HonuaConsoleReportRenderModel {
  readonly id: string;
  readonly title?: string;
  readonly sections: ReadonlyArray<{
    readonly id: string;
    readonly title?: string;
    readonly body?: string;
    readonly charts: ReadonlyArray<HonuaConsoleChartPanelModel>;
  }>;
}

/**
 * Validates a report package and projects each section's chart panels to
 * Console render models, validating Vega-Lite specs along the way.
 */
export function projectReportPackage(pkg: HonuaConsoleReportPackage): HonuaConsoleReportRenderModel {
  if (pkg.format !== HONUA_CONSOLE_REPORT_PACKAGE_FORMAT_V1) {
    throw new HonuaConsoleError(
      "unsupported-package-format",
      `Unsupported report package format "${String(pkg.format)}"`,
      {
        stage: "projection",
        detail: { packageId: pkg.id, path: "format", received: pkg.format },
      },
    );
  }
  const sections = pkg.sections.map((section) => {
    const charts: HonuaConsoleChartPanelModel[] = [];
    for (const panel of section.panels ?? []) {
      if (!isChartPanel(panel)) continue;
      if (!panel.chartSpec) {
        throw new HonuaConsoleError("missing-chart-spec", `Chart panel "${panel.id}" is missing a chartSpec`, {
          stage: "projection",
          detail: {
            packageId: pkg.id,
            panelId: panel.id,
            path: `sections.${section.id}.panels.${panel.id}.chartSpec`,
          },
        });
      }
      charts.push({
        id: panel.id,
        kind: "chart",
        ...(panel.title !== undefined ? { title: panel.title } : {}),
        chartSpec: normalizeVegaLiteSpec(panel.chartSpec, {
          chartId: panel.id,
          path: `sections.${section.id}.panels.${panel.id}.chartSpec`,
        }),
        ...(panel.binding ? { binding: panel.binding } : {}),
      });
    }
    return {
      id: section.id,
      ...(section.title !== undefined ? { title: section.title } : {}),
      ...(section.body !== undefined ? { body: section.body } : {}),
      charts,
    };
  });
  return {
    id: pkg.id,
    ...(pkg.title !== undefined ? { title: pkg.title } : {}),
    sections,
  };
}

/**
 * Vocabulary shared with the generated-app chart widget. Bridging this into a
 * Vega-Lite spec lets Console dashboards reuse generated-app chart kinds without
 * a Console-specific chart engine.
 */
export type HonuaConsoleChartKind = "categories" | "histogram" | "time-series";

export interface HonuaConsoleChartWidgetLike {
  readonly chartKind?: HonuaConsoleChartKind;
  readonly groupBy?: string;
  readonly field?: string;
  readonly title?: string;
  readonly bins?: number;
  readonly [extra: string]: unknown;
}

/**
 * Projects a generated-app-style chart widget into an SDK Vega-Lite spec.
 * A missing required field for the chosen chart kind raises a typed
 * `missing-binding` error.
 */
export function chartWidgetToVegaLiteSpec(
  widget: HonuaConsoleChartWidgetLike,
  context: { readonly chartId?: string } = {},
): HonuaVegaLiteSpec {
  const chartKind = widget.chartKind ?? "categories";
  const title = widget.title;
  const base = {
    $schema: HONUA_CONSOLE_VEGA_LITE_SCHEMA,
    ...(title !== undefined ? { title } : {}),
    width: "container" as const,
    height: "container" as const,
  };

  if (chartKind === "categories") {
    if (!widget.groupBy) {
      throw new HonuaConsoleError("missing-binding", 'Chart kind "categories" requires a groupBy field', {
        stage: "chart",
        detail: { ...context, path: "groupBy" },
      });
    }
    return {
      ...base,
      mark: "bar",
      encoding: {
        x: { field: widget.groupBy, type: "nominal", sort: "descending" },
        y: { aggregate: "count", type: "quantitative", title: "Count" },
      },
    };
  }

  if (chartKind === "histogram") {
    if (!widget.field) {
      throw new HonuaConsoleError("missing-binding", 'Chart kind "histogram" requires a field', {
        stage: "chart",
        detail: { ...context, path: "field" },
      });
    }
    return {
      ...base,
      mark: "bar",
      encoding: {
        x: {
          field: widget.field,
          type: "quantitative",
          bin: widget.bins ? { maxbins: widget.bins } : true,
        },
        y: { aggregate: "count", type: "quantitative", title: "Count" },
      },
    };
  }

  // time-series
  if (!widget.field) {
    throw new HonuaConsoleError("missing-binding", 'Chart kind "time-series" requires a time field', {
      stage: "chart",
      detail: { ...context, path: "field" },
    });
  }
  return {
    ...base,
    mark: "line",
    encoding: {
      x: { field: widget.field, type: "temporal" },
      y: { aggregate: "count", type: "quantitative", title: "Count" },
    },
  };
}
