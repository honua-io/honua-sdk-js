import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  SPATIAL_AGGREGATION_CAPABILITY,
  assertValidSpatialAggregationRequest,
  isSpatialAggregationComplete,
  resolveSpatialAggregationWidgetSummary,
  spatialAggregationProgress,
  spatialAggregationWidgets,
  validateSpatialAggregationRequest,
} from "../src/contract/index.js";
import type {
  SpatialAggregationContractFixture,
  SpatialAggregationMetadata,
  SpatialAggregationRequest,
  SpatialAggregationResult,
} from "../src/contract/index.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/spatial-aggregation");
const fixture = JSON.parse(
  readFileSync(resolve(fixturesDir, "indexed-summary.v1.json"), "utf8"),
) as SpatialAggregationContractFixture;

describe("spatial aggregation contract", () => {
  it("pins a canonical capability and validates the fixture request envelope", () => {
    expect(CAPABILITIES).toContain(SPATIAL_AGGREGATION_CAPABILITY);
    expect(validateSpatialAggregationRequest(fixture.request)).toEqual([]);
    expect(() => assertValidSpatialAggregationRequest(fixture.request)).not.toThrow();

    expect(fixture.request.spatialFilter?.geometryType).toBe("esriGeometryEnvelope");
    expect(fixture.request.viewport?.zoom).toBe(11);
    expect(fixture.request.resolution).toMatchObject({
      zoom: 11,
      indexResolution: 8,
      strategy: "fit-viewport",
    });
    expect(fixture.request.index?.modelId).toBeUndefined();
    expect(new Set(fixture.request.summaries.map((summary) => summary.kind))).toEqual(
      new Set(["count", "category", "histogram", "range", "sum", "avg", "min", "max"]),
    );
    expect(fixture.request.groupBy?.map((group) => group.field)).toEqual(["severity", "land_use"]);
  });

  it("keeps indexed cell ids opaque so widgets do not depend on H3 or Quadbin", () => {
    const h3Widgets = spatialAggregationWidgets(fixture.response);
    const quadbinModel = fixture.response.metadata.indexModels?.find((model) => model.id === "quadbin");
    if (!quadbinModel) throw new Error("fixture is missing quadbin index metadata");

    const quadbinResult: SpatialAggregationResult = {
      ...fixture.response,
      index: {
        ...fixture.response.index,
        model: quadbinModel,
        resolution: 12,
      },
      cells: fixture.response.cells.map((cell, index) => ({
        ...cell,
        id: `520725188477504716${index}`,
      })),
    };

    expect(fixture.response.index.model.id).toBe("h3");
    expect(quadbinResult.index.model.id).toBe("quadbin");
    expect(spatialAggregationWidgets(quadbinResult)).toEqual(h3Widgets);
  });

  it("exposes widget metadata and derives fallback widgets from summaries", () => {
    const widgets = spatialAggregationWidgets(fixture.response);

    expect(widgets).toContainEqual(
      expect.objectContaining({
        id: "severity-list",
        kind: "category-list",
        summaryId: "bySeverity",
      }),
    );
    expect(widgets).toContainEqual(
      expect.objectContaining({
        id: "population-range",
        kind: "range-list",
        summaryId: "populationExposureRange",
      }),
    );
    expect(widgets).toContainEqual(
      expect.objectContaining({
        id: "grouped-risk-table",
        kind: "grouped-table",
        groupBy: ["severity", "landUse"],
      }),
    );

    const metadataWithoutWidgets: SpatialAggregationMetadata = {
      ...fixture.response.metadata,
      widgets: [],
    };
    const derived = spatialAggregationWidgets(metadataWithoutWidgets);

    expect(derived.map((widget) => widget.kind)).toEqual([
      "stat",
      "category-list",
      "histogram",
      "range-list",
      "stat",
      "stat",
      "stat",
      "stat",
      "grouped-table",
    ]);
    expect(derived.at(-1)).toMatchObject({
      id: "grouped-summaries",
      groupBy: ["severity", "landUse"],
    });
  });

  it("resolves widget summaries from server totals before visible cell pages", () => {
    const widgets = spatialAggregationWidgets(fixture.response);
    const severityWidget = widgets.find((widget) => widget.id === "severity-list");
    const histogramWidget = widgets.find((widget) => widget.id === "response-histogram");
    const rangeWidget = widgets.find((widget) => widget.id === "population-range");
    const groupedWidget = widgets.find((widget) => widget.id === "grouped-risk-table");
    if (!severityWidget || !histogramWidget || !rangeWidget || !groupedWidget) {
      throw new Error("fixture is missing expected aggregation widgets");
    }

    const severity = resolveSpatialAggregationWidgetSummary(fixture.response, severityWidget);
    const histogram = resolveSpatialAggregationWidgetSummary(fixture.response, histogramWidget);
    const range = resolveSpatialAggregationWidgetSummary(fixture.response, rangeWidget);

    expect(severity).toMatchObject({
      source: "totals",
      summaryId: "bySeverity",
      summary: {
        kind: "category",
        buckets: [
          { value: "critical", count: 62 },
          { value: "high", count: 104 },
          { value: "moderate", count: 65 },
        ],
      },
    });
    expect(histogram).toMatchObject({
      source: "totals",
      summary: {
        kind: "histogram",
        buckets: [{ count: 54 }, { count: 91 }, { count: 66 }, { count: 20 }],
      },
    });
    expect(range).toMatchObject({
      source: "totals",
      summary: {
        kind: "range",
        buckets: [
          { id: "low", count: 74 },
          { id: "medium", count: 101 },
          { id: "high", count: 56 },
        ],
      },
    });
    expect(resolveSpatialAggregationWidgetSummary(fixture.response, groupedWidget)).toBeUndefined();

    const cellFallback: SpatialAggregationResult = {
      ...fixture.response,
      totals: undefined,
    };
    const fallbackSeverity = resolveSpatialAggregationWidgetSummary(cellFallback, severityWidget);
    expect(fallbackSeverity).toMatchObject({
      source: "cell",
      cellId: fixture.response.cells[0]?.id,
      summary: { kind: "category" },
    });
    if (fallbackSeverity?.summary.kind !== "category") throw new Error("expected category fallback summary");
    expect(fallbackSeverity.summary.buckets[0]).toMatchObject({ value: "critical", count: 8 });
  });

  it("reports progressive loading state separately from the cell payload", () => {
    expect(isSpatialAggregationComplete(fixture.response)).toBe(false);
    expect(spatialAggregationProgress(fixture.response)).toMatchObject({
      status: "partial",
      refinement: "append",
      nextCursor: "page-2",
      loadedCellCount: 2,
      totalCellCount: 96,
    });

    const completeResult: SpatialAggregationResult = {
      ...fixture.response,
      metadata: {
        ...fixture.response.metadata,
        progressive: {
          status: "complete",
          loadedCellCount: 96,
          totalCellCount: 96,
        },
      },
      page: {
        loadedCellCount: 96,
        totalCellCount: 96,
      },
    };

    expect(isSpatialAggregationComplete(completeResult)).toBe(true);
  });

  it("flags malformed summary, viewport, resolution, and paging inputs", () => {
    const invalidRequest: SpatialAggregationRequest = {
      sourceId: "",
      viewport: {
        extent: fixture.request.viewport?.extent ?? fixture.response.index.extent!,
        zoom: -1,
        width: 0,
      },
      resolution: {
        indexResolution: -1,
        maxCellCount: 0,
      },
      summaries: [
        { id: "duplicate", kind: "sum", field: "" },
        { id: "duplicate", kind: "histogram", field: "response_minutes", bins: 0 },
        {
          id: "badRange",
          kind: "range",
          field: "exposed_population",
          ranges: [{ id: "backwards", min: 10, max: 5 }],
        },
      ],
      groupBy: [{ field: "", limit: 0 }],
      page: { limit: 0 },
    };

    const paths = validateSpatialAggregationRequest(invalidRequest).map((issue) => issue.path);

    expect(paths).toEqual(
      expect.arrayContaining([
        "sourceId",
        "summaries[0].field",
        "summaries[1].id",
        "summaries[1].bins",
        "summaries[2].ranges[0].max",
        "groupBy[0].field",
        "groupBy[0].limit",
        "viewport.zoom",
        "viewport.width",
        "resolution.indexResolution",
        "resolution.maxCellCount",
        "page.limit",
      ]),
    );
    expect(() => assertValidSpatialAggregationRequest(invalidRequest)).toThrow("Invalid spatial aggregation request");
  });
});
