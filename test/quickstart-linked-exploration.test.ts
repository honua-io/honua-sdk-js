import { describe, expect, it } from "vitest";

import type { LinkedViewQueryProjection } from "@honua/sdk-js/exploration";
import type { QuickstartFeatureSummary } from "../examples/maplibre-quickstart/src/data.js";
import {
  applyQuickstartProjection,
  createMapLibreLayerFilter,
  createQuickstartFilterOptions,
  formatProjectionExtent,
} from "../examples/maplibre-quickstart/src/linked-exploration.js";

function summary(id: string, properties: Record<string, unknown>, center: [number, number]): QuickstartFeatureSummary {
  return {
    id,
    title: String(properties.NAME ?? id),
    subtitle: String(properties.STATUS ?? "Feature"),
    center,
    geometryKind: "polygon",
    feature: {
      type: "Feature",
      id,
      properties,
      geometry: {
        type: "Polygon",
        coordinates: [],
      },
    },
  };
}

function projection(overrides: Partial<LinkedViewQueryProjection>): LinkedViewQueryProjection {
  return {
    filters: {},
    orderBy: [],
    pagination: {},
    grouping: [],
    selection: [],
    ...overrides,
  };
}

describe("quickstart linked exploration helpers", () => {
  const features = [
    summary(
      "1",
      { NAME: "Civic center service zone", STATUS: "Monitoring", CATEGORY: "Operations" },
      [-157.861, 21.306],
    ),
    summary(
      "2",
      { NAME: "Harbor response district", STATUS: "Field review", CATEGORY: "Maritime" },
      [-157.885, 21.299],
    ),
    summary("3", { NAME: "Kakaako utility corridor", STATUS: "Ready", CATEGORY: "Infrastructure" }, [-157.863, 21.291]),
  ];

  it("prefers GIS status/category fields for filter controls", () => {
    expect(createQuickstartFilterOptions(features)).toEqual([
      {
        field: "STATUS",
        values: ["Field review", "Monitoring", "Ready"],
      },
      {
        field: "CATEGORY",
        values: ["Infrastructure", "Maritime", "Operations"],
      },
    ]);
  });

  it("applies linked filters and map extent to result rows", () => {
    const visible = applyQuickstartProjection(
      features,
      projection({
        filters: {
          status: { field: "STATUS", operator: "=", value: "Field review" },
        },
        extent: {
          xmin: -157.89,
          ymin: 21.295,
          xmax: -157.88,
          ymax: 21.305,
          spatialReference: { wkid: 4326 },
        },
      }),
    );

    expect(visible.map((feature) => feature.id)).toEqual(["2"]);
  });

  it("translates linked attribute filters into MapLibre layer filters", () => {
    expect(
      createMapLibreLayerFilter(
        "polygon",
        projection({
          filters: {
            status: { field: "STATUS", operator: "=", value: "Ready" },
          },
        }),
      ),
    ).toEqual(["all", ["==", "$type", "Polygon"], ["==", "STATUS", "Ready"]]);
  });

  it("formats the viewport extent shown in the linked query panel", () => {
    expect(
      formatProjectionExtent({
        xmin: -157.89,
        ymin: 21.295,
        xmax: -157.88,
        ymax: 21.305,
      }),
    ).toBe("-157.8900, 21.2950 to -157.8800, 21.3050");
  });
});
