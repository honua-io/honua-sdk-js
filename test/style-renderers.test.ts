import { describe, expect, it } from "vitest";

import {
  classBreaksRenderer,
  clusterRenderer,
  heatmapRenderer,
  isRenderer,
  rendererFromJSON,
  uniqueValueRenderer,
} from "../src/style/index.js";
import type { RendererGeometryType } from "../src/style/index.js";
import { convertRenderer } from "../src/webmap/index.js";
import { createWarningCollector } from "../src/webmap/warnings.js";

const GEOMETRIES: readonly RendererGeometryType[] = ["point", "line", "polygon"];
const COLOR_PROPERTY: Record<RendererGeometryType, string> = {
  point: "circle-color",
  line: "line-color",
  polygon: "fill-color",
};
const LAYER_TYPE: Record<RendererGeometryType, string> = { point: "circle", line: "line", polygon: "fill" };

describe("classBreaksRenderer", () => {
  const renderer = classBreaksRenderer({
    field: "magnitude",
    breaks: [
      { min: 0, max: 3, label: "Minor" },
      { min: 3, max: 5 },
      { min: 5, label: "Strong" },
    ],
    colors: ["#fed976", "#fd8d3c", "#b10026"],
    defaultColor: "#cccccc",
    defaultLabel: "No data",
  });

  it.each(GEOMETRIES)("compiles a deterministic step expression for %s geometry", (geometry) => {
    const fragments = renderer.toMapLibre(geometry);
    expect(fragments).toHaveLength(1);
    const [fragment] = fragments;
    expect(fragment.role).toBe("symbolizer");
    expect(fragment.type).toBe(LAYER_TYPE[geometry]);
    expect(fragment.paint[COLOR_PROPERTY[geometry]]).toEqual([
      "step",
      ["get", "magnitude"],
      "#cccccc",
      0,
      "#fed976",
      3,
      "#fd8d3c",
      5,
      "#b10026",
    ]);
    expect(fragment.layout).toEqual({});
    // Pure function: identical output on every call.
    expect(renderer.toMapLibre(geometry)).toEqual(fragments);
  });

  it("exposes legend metadata as a stable contract", () => {
    expect(renderer.legendItems()).toEqual([
      { kind: "class-break", label: "Minor", color: "#fed976", minValue: 0, maxValue: 3 },
      { kind: "class-break", label: "3–5", color: "#fd8d3c", minValue: 3, maxValue: 5 },
      { kind: "class-break", label: "Strong", color: "#b10026", minValue: 5 },
      { kind: "default", label: "No data", color: "#cccccc" },
    ]);
  });

  it("round-trips through JSON", () => {
    const revived = rendererFromJSON(renderer.toJSON());
    expect(revived.kind).toBe("class-breaks");
    expect(revived.toMapLibre("polygon")).toEqual(renderer.toMapLibre("polygon"));
    expect(revived.legendItems()).toEqual(renderer.legendItems());
    expect(revived.toJSON()).toEqual(renderer.toJSON());
  });

  it("validates breaks", () => {
    expect(() => classBreaksRenderer({ field: "f", breaks: [] })).toThrow(/at least one break/);
    expect(() => classBreaksRenderer({ field: "f", breaks: [{ color: "#000" }] })).toThrow(/min or max/);
    expect(() => classBreaksRenderer({ field: "f", breaks: [{ min: 0 }] })).toThrow(/color/);
    expect(() => classBreaksRenderer({ field: "", breaks: [{ min: 0, color: "#000" }] })).toThrow(/field/);
  });
});

describe("uniqueValueRenderer", () => {
  const renderer = uniqueValueRenderer({
    field: "priority",
    values: [
      { value: "high", color: "#b91c1c", label: "High priority" },
      { value: "low", color: "#0f766e" },
    ],
    defaultColor: "#334155",
  });

  it.each(GEOMETRIES)("compiles a deterministic match expression for %s geometry", (geometry) => {
    const [fragment] = renderer.toMapLibre(geometry);
    expect(fragment.type).toBe(LAYER_TYPE[geometry]);
    expect(fragment.paint[COLOR_PROPERTY[geometry]]).toEqual([
      "match",
      ["get", "priority"],
      "high",
      "#b91c1c",
      "low",
      "#0f766e",
      "#334155",
    ]);
  });

  it("concatenates multi-field inputs with the delimiter", () => {
    const multi = uniqueValueRenderer({
      field: "STATE",
      field2: "ZONE",
      fieldDelimiter: "|",
      values: [{ value: "CA|Urban", color: "#f00" }],
    });
    const [fragment] = multi.toMapLibre("polygon");
    expect((fragment.paint["fill-color"] as unknown[])[1]).toEqual(["concat", ["get", "STATE"], "|", ["get", "ZONE"]]);
  });

  it("falls back to the first entry when no default is given", () => {
    const noDefault = uniqueValueRenderer({ field: "t", values: [{ value: "a", color: "#111" }] });
    const [fragment] = noDefault.toMapLibre("point");
    expect(fragment.paint["circle-color"]).toEqual(["match", ["get", "t"], "a", "#111", "#111"]);
  });

  it("exposes legend metadata with values", () => {
    expect(renderer.legendItems()).toEqual([
      { kind: "unique-value", label: "High priority", color: "#b91c1c", value: "high" },
      { kind: "unique-value", label: "low", color: "#0f766e", value: "low" },
      { kind: "default", label: "Other", color: "#334155" },
    ]);
  });

  it("round-trips through JSON", () => {
    const revived = rendererFromJSON(renderer.toJSON());
    expect(revived.toMapLibre("line")).toEqual(renderer.toMapLibre("line"));
    expect(revived.legendItems()).toEqual(renderer.legendItems());
  });
});

describe("heatmapRenderer", () => {
  it("compiles a heatmap fragment with the default ramp", () => {
    const [fragment] = heatmapRenderer().toMapLibre("point");
    expect(fragment.type).toBe("heatmap");
    expect(fragment.paint["heatmap-radius"]).toBe(30);
    expect(fragment.paint["heatmap-intensity"]).toBe(1);
    const color = fragment.paint["heatmap-color"] as unknown[];
    expect(color.slice(0, 3)).toEqual(["interpolate", ["linear"], ["heatmap-density"]]);
    expect(color[3]).toBe(0);
    expect(color[4]).toBe("rgba(33,102,172,0)");
    expect(fragment.paint["heatmap-weight"]).toBeUndefined();
  });

  it("wires weight, opacity, and an even string ramp", () => {
    const renderer = heatmapRenderer({
      weightField: "magnitude",
      radius: 44,
      intensity: 2,
      opacity: 0.8,
      colorRamp: ["rgba(0,0,255,0)", "cyan", "red"],
    });
    const [fragment] = renderer.toMapLibre("point");
    expect(fragment.paint["heatmap-weight"]).toEqual(["to-number", ["get", "magnitude"], 0]);
    expect(fragment.paint["heatmap-opacity"]).toBe(0.8);
    expect(fragment.paint["heatmap-color"]).toEqual([
      "interpolate",
      ["linear"],
      ["heatmap-density"],
      0,
      "rgba(0,0,255,0)",
      0.5,
      "cyan",
      1,
      "red",
    ]);
    expect(renderer.legendItems()).toEqual([
      { kind: "heatmap-stop", label: "0", color: "rgba(0,0,255,0)", value: 0 },
      { kind: "heatmap-stop", label: "0.5", color: "cyan", value: 0.5 },
      { kind: "heatmap-stop", label: "1", color: "red", value: 1 },
    ]);
  });

  it("rejects non-ascending ramps and round-trips through JSON", () => {
    expect(() =>
      heatmapRenderer({
        colorRamp: [
          { stop: 0.5, color: "#000" },
          { stop: 0.5, color: "#111" },
        ],
      }),
    ).toThrow(/ascending/);
    const renderer = heatmapRenderer({ radius: 20 });
    expect(rendererFromJSON(renderer.toJSON()).toMapLibre("point")).toEqual(renderer.toMapLibre("point"));
  });
});

describe("clusterRenderer", () => {
  const renderer = clusterRenderer({
    radius: 60,
    maxZoom: 12,
    steps: [
      { threshold: 0, color: "#51bbd6" },
      { threshold: 100, color: "#f1f075" },
      { threshold: 750, color: "#f28cb1", radius: 40 },
    ],
  });

  it("produces GeoJSON-source cluster config", () => {
    expect(renderer.toMapLibreSource()).toEqual({ cluster: true, clusterRadius: 60, clusterMaxZoom: 12 });
    const weighted = clusterRenderer({ countField: "population", steps: [{ threshold: 0, color: "#000" }] });
    expect(weighted.toMapLibreSource()).toEqual({
      cluster: true,
      clusterRadius: 50,
      clusterMaxZoom: 14,
      clusterProperties: { population_sum: ["+", ["get", "population"]] },
    });
  });

  it("compiles cluster, count, and unclustered fragments", () => {
    const fragments = renderer.toMapLibre("point");
    expect(fragments.map((fragment) => fragment.role)).toEqual(["clusters", "cluster-count", "unclustered"]);
    const [clusters, count, unclustered] = fragments;
    expect(clusters.filter).toEqual(["has", "point_count"]);
    expect(clusters.paint["circle-color"]).toEqual([
      "step",
      ["get", "point_count"],
      "#51bbd6",
      100,
      "#f1f075",
      750,
      "#f28cb1",
    ]);
    expect(clusters.paint["circle-radius"]).toEqual(["step", ["get", "point_count"], 14, 100, 20, 750, 40]);
    expect(count.type).toBe("symbol");
    expect(count.layout["text-field"]).toEqual(["get", "point_count_abbreviated"]);
    expect(unclustered.filter).toEqual(["!", ["has", "point_count"]]);
    expect(unclustered.paint["circle-color"]).toBe("#16735b");
  });

  it("drives count expressions from countField sums", () => {
    const weighted = clusterRenderer({
      countField: "population",
      steps: [
        { threshold: 0, color: "#000" },
        { threshold: 10, color: "#111" },
      ],
    });
    const [clusters, count] = weighted.toMapLibre("point");
    expect((clusters.paint["circle-color"] as unknown[])[1]).toEqual(["get", "population_sum"]);
    expect(count.layout["text-field"]).toEqual(["to-string", ["get", "population_sum"]]);
  });

  it("exposes ranged legend metadata", () => {
    expect(renderer.legendItems()).toEqual([
      { kind: "cluster-step", label: "0–100", color: "#51bbd6", minValue: 0, maxValue: 100 },
      { kind: "cluster-step", label: "100–750", color: "#f1f075", minValue: 100, maxValue: 750 },
      { kind: "cluster-step", label: "≥ 750", color: "#f28cb1", minValue: 750 },
      { kind: "default", label: "Individual features", color: "#16735b" },
    ]);
  });

  it("validates steps and round-trips through JSON", () => {
    expect(() => clusterRenderer({ steps: [] })).toThrow(/at least one step/);
    expect(() =>
      clusterRenderer({
        steps: [
          { threshold: 10, color: "#000" },
          { threshold: 5, color: "#111" },
        ],
      }),
    ).toThrow(/ascending/);
    expect(rendererFromJSON(renderer.toJSON()).toMapLibre("point")).toEqual(renderer.toMapLibre("point"));
  });
});

describe("renderer object plumbing", () => {
  it("isRenderer identifies renderer objects", () => {
    expect(isRenderer(uniqueValueRenderer({ field: "f", values: [{ value: 1, color: "#000" }] }))).toBe(true);
    expect(isRenderer({})).toBe(false);
    expect(isRenderer(null)).toBe(false);
    expect(isRenderer({ kind: "unique-value" })).toBe(false);
  });

  it("rendererFromJSON rejects unknown kinds", () => {
    expect(() => rendererFromJSON({ kind: "nope" } as never)).toThrow(/Unknown renderer kind/);
  });

  it("descriptors are serialization-safe and detached from the renderer", () => {
    const renderer = classBreaksRenderer({ field: "f", breaks: [{ min: 0, color: "#000" }] });
    const descriptor = renderer.toJSON();
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
    (descriptor as { field: string }).field = "mutated";
    expect(renderer.toJSON().field).toBe("f");
  });
});

describe("webmap converter emits renderer objects (single implementation)", () => {
  it("convertRenderer output matches the renderer object compile byte for byte", () => {
    const warn = createWarningCollector();
    const webmapRenderer = {
      type: "classBreaks" as const,
      field: "VALUE",
      defaultSymbol: { type: "esriSFS", color: [255, 255, 255, 255] as [number, number, number, number] },
      classBreakInfos: [
        {
          classMinValue: 0,
          classMaxValue: 100,
          symbol: { type: "esriSFS", color: [255, 255, 178, 255] as [number, number, number, number] },
        },
        {
          classMinValue: 100,
          classMaxValue: 500,
          symbol: { type: "esriSFS", color: [253, 141, 60, 255] as [number, number, number, number] },
        },
      ],
    };
    const converted = convertRenderer(webmapRenderer, warn);
    expect(converted).toBeDefined();
    // The legacy shape (pre-#497) — the converter must keep emitting exactly this.
    expect(JSON.stringify(converted)).toBe(
      JSON.stringify({
        layerType: "fill",
        paint: {
          "fill-color": ["step", ["get", "VALUE"], "rgb(255,255,255)", 0, "rgb(255,255,178)", 100, "rgb(253,141,60)"],
        },
        layout: {},
      }),
    );
  });
});
