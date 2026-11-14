import { describe, expect, it } from "vitest";
import { type HonuaLayerSpecification, legendFromStyle } from "../src/style/index.js";

describe("style file legend", () => {
  it("preserves symbols and filters while deriving static colors", () => {
    const layer: HonuaLayerSpecification = {
      id: "parcels",
      type: "fill",
      source: "parcels",
      filter: ["==", ["get", "active"], true],
      metadata: { title: "Parcels" },
      paint: { "fill-color": "#f00", "fill-opacity": 0.3 },
    };
    const [legend] = legendFromStyle({ layers: [layer] });
    expect(legend).toEqual({
      layerId: "parcels",
      label: "Parcels",
      layer,
      items: [{ kind: "default", label: "All features", color: "#f00" }],
    });
    expect(legend.layer).not.toBe(layer);
    if (legend.layer.paint) legend.layer.paint["fill-opacity"] = 1;
    expect(layer.paint?.["fill-opacity"]).toBe(0.3);
  });

  it.each(["fill", "line", "background", "fill-extrusion"] as const)(
    "preserves %s pattern symbols without inventing a color legend",
    (type) => {
      const layer: HonuaLayerSpecification = {
        id: "pattern",
        type,
        paint: { [`${type}-color`]: "red", [`${type}-pattern`]: "road-pattern" },
      };
      const [legend] = legendFromStyle({ layers: [layer] });
      expect(legend.items).toEqual([]);
      expect(legend.unresolvedReason).toBeTruthy();
      expect(legend.layer).toEqual(layer);
    },
  );

  it("derives match categories including grouped labels and the fallback", () => {
    const [legend] = legendFromStyle({
      layers: [
        {
          id: "status",
          type: "circle",
          paint: {
            "circle-color": ["match", ["get", "status"], ["open", "new"], "green", 2, "blue", "gray"],
          },
        },
      ],
    });
    expect(legend.items).toEqual([
      { kind: "unique-value", label: "open", color: "green", value: "open" },
      { kind: "unique-value", label: "new", color: "green", value: "new" },
      { kind: "unique-value", label: "2", color: "blue", value: 2 },
      { kind: "default", label: "Other", color: "gray" },
    ]);
  });

  it("labels step boundaries with inclusive lower and exclusive upper limits", () => {
    const [legend] = legendFromStyle({
      layers: [
        {
          id: "size",
          type: "fill",
          paint: {
            "fill-color": ["step", ["get", "size"], "blue", 10, "green", 20, "red"],
          },
        },
      ],
    });
    expect(legend.items).toEqual([
      { kind: "class-break", label: "< 10", color: "blue", maxValue: 10 },
      { kind: "class-break", label: "10 ≤ value < 20", color: "green", minValue: 10, maxValue: 20 },
      { kind: "class-break", label: "≥ 20", color: "red", minValue: 20 },
    ]);
  });

  it("honors caller selection, hidden layers and exclusive maximum zoom", () => {
    const layers: HonuaLayerSpecification[] = [
      { id: "hidden", type: "line", layout: { visibility: "none" } },
      { id: "selected", type: "line", minzoom: 2, maxzoom: 5 },
      { id: "other", type: "line" },
    ];
    expect(
      legendFromStyle({ layers }, { layerIds: ["hidden", "selected"], zoom: 2 }).map((item) => item.layerId),
    ).toEqual(["selected"]);
    expect(legendFromStyle({ layers }, { layerIds: ["selected"], zoom: 5 })).toEqual([]);
    expect(() => legendFromStyle({ layers }, { zoom: Number.NaN })).toThrow(RangeError);
  });

  it.each([
    undefined,
    ["interpolate", ["linear"], ["get", "value"], 0, "blue", 10, "red"],
    ["step", ["get", "value"], "blue", 20, "red", 10, "green"],
    ["match", ["get", "value"], "a", ["get", "dynamic"], "gray"],
  ])("exposes unresolved symbols instead of inventing a legend", (color) => {
    const [legend] = legendFromStyle({ layers: [{ id: "complex", type: "fill", paint: { "fill-color": color } }] });
    expect(legend.items).toEqual([]);
    expect(legend.unresolvedReason).toBeTruthy();
  });
});
