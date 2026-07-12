import { describe, expect, it } from "vitest";

import { sourceFeatureSelectionTarget } from "@honua/sdk-js/exploration";
import {
  interactionQueryParamNames,
  parseInteractionQueryState,
  parseSelection,
  preparePrimaryDetailModel,
  prepareSelectionDetailModels,
  serializeInteractionQueryState,
  serializeSelection,
} from "@honua/sdk-js/interactions";

describe("interaction detail model helpers", () => {
  it("prepares popup/detail data for selected features", () => {
    const target = sourceFeatureSelectionTarget("incidents", 10);
    const detail = preparePrimaryDetailModel({
      selection: [target],
      sourceId: "incidents",
      objectIdField: "OBJECTID",
      titleField: "name",
      fields: [
        { name: "name", label: "Name" },
        { name: "status", label: "Status", formatter: (value) => String(value).toUpperCase() },
        { name: "internal", visible: false },
      ],
      features: [
        {
          attributes: { OBJECTID: 10, name: "Station 10", status: "open", internal: "hidden" },
          geometry: { x: -157.8, y: 21.3 },
        },
      ],
    });

    expect(detail).toMatchObject({
      status: "ready",
      target,
      title: "Station 10",
      attributes: { OBJECTID: 10, name: "Station 10", status: "open", internal: "hidden" },
      geometry: { x: -157.8, y: 21.3 },
    });
    expect(detail.fields).toEqual([
      { name: "name", label: "Name", value: "Station 10" },
      { name: "status", label: "Status", value: "OPEN" },
    ]);
  });

  it("returns empty detail state when selection is cleared", () => {
    expect(preparePrimaryDetailModel({ selection: [], features: [] })).toEqual({
      status: "empty",
      attributes: {},
      fields: [],
    });
  });

  it("marks selected features as stale when filtered or deleted from current results", () => {
    const selected = [
      sourceFeatureSelectionTarget("incidents", 10),
      sourceFeatureSelectionTarget("incidents", 20),
      sourceFeatureSelectionTarget("assets", 10),
    ];

    const details = prepareSelectionDetailModels({
      selection: selected,
      sourceId: "incidents",
      features: [
        { attributes: { OBJECTID: 20, name: "Current incident" } },
        { sourceId: "assets", attributes: { OBJECTID: 10, name: "Same object id, other source" } },
      ],
      titleField: "name",
    });

    expect(details.map((detail) => detail.status)).toEqual(["stale", "ready", "ready"]);
    expect(details[0].target).toEqual(sourceFeatureSelectionTarget("incidents", 10));
    expect(details[1]).toMatchObject({ title: "Current incident" });
    expect(details[2]).toMatchObject({ title: "Same object id, other source" });
  });
});

describe("interaction share-state helpers", () => {
  it("serializes and parses mixed raw and source-qualified selection", () => {
    const selection = [1, "2", sourceFeatureSelectionTarget("incidents", 3, { sourceLayer: "points" })];
    const encoded = serializeSelection(selection);

    expect(parseSelection(encoded)).toEqual(selection);
    expect(parseSelection("not json")).toEqual([]);
  });

  it("omits cleared filters, pages, and selection from shareable query state", () => {
    expect(
      serializeInteractionQueryState({
        filters: {},
        pagination: {},
        grouping: [],
        orderBy: [],
        selection: [],
      }),
    ).toBe("");
  });

  it("round-trips linked query projection state through URL query params", () => {
    const selection = [sourceFeatureSelectionTarget("incidents", 7)];
    const encoded = serializeInteractionQueryState({
      filters: {
        status: { field: "STATUS", operator: "=", value: "open", appliesTo: ["incidents"] },
      },
      spatialFilter: {
        geometry: { xmin: 0, ymin: 1, xmax: 2, ymax: 3 },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
      },
      extent: { xmin: 0, ymin: 1, xmax: 2, ymax: 3 },
      orderBy: [{ field: "UPDATED_AT", direction: "desc" }],
      pagination: { offset: 20, limit: 10 },
      outFields: ["OBJECTID", "STATUS"],
      grouping: ["STATUS"],
      aggregation: { metrics: [{ field: "*", fn: "count" }] },
      selection,
    });

    const names = interactionQueryParamNames();
    const params = new URLSearchParams(encoded);
    expect(params.has(names.filters)).toBe(true);
    expect(params.has(names.selection)).toBe(true);
    expect(parseInteractionQueryState(`?${encoded}`)).toEqual({
      filters: {
        status: { appliesTo: ["incidents"], field: "STATUS", operator: "=", value: "open" },
      },
      spatialFilter: {
        geometry: { xmax: 2, xmin: 0, ymax: 3, ymin: 1 },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
      },
      extent: { xmax: 2, xmin: 0, ymax: 3, ymin: 1 },
      orderBy: [{ direction: "desc", field: "UPDATED_AT" }],
      pagination: { limit: 10, offset: 20 },
      outFields: ["OBJECTID", "STATUS"],
      grouping: ["STATUS"],
      aggregation: { metrics: [{ field: "*", fn: "count" }] },
      selection,
    });
  });
});
