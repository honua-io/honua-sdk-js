import { readFileSync } from "node:fs";
import { createPropertyExpression, v8, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { ClassBreaksRendererCompat } from "../src/esri-compat/class-breaks-renderer.js";
import {
  convertSimpleRendererCompat,
  rendererObjectFromClassBreaksCompat,
  rendererObjectFromUniqueValueCompat,
} from "../src/esri-compat/renderer-objects.js";
import { SimpleRendererCompat } from "../src/esri-compat/simple-renderer.js";
import { UniqueValueRendererCompat } from "../src/esri-compat/unique-value-renderer.js";
import { webmapJsonToMapLibreStyle } from "../src/map/webmap-maplibre.js";
import { rendererFromJSON } from "../src/style/renderers.js";
import { WEB_MERCATOR_SCALE_AT_ZOOM_ZERO } from "../src/style/visual-variables.js";
import { convertRenderer, createWarningCollector, parseWebMap } from "../src/webmap/index.js";
import type { WebMapRenderer } from "../src/webmap/types.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/webmap-helicopter-renderer.json", import.meta.url), "utf8"),
);
const color = fixture.renderer.visualVariables[0];
const line = { type: "esriSLS", color: [170, 170, 170, 255], width: 0.75 };
const size = {
  type: "sizeInfo",
  field: "Value",
  stops: [
    { value: 0, size: 3 },
    { value: 10, size: 15 },
  ],
};

function evaluate(value: unknown, property: string, properties: Record<string, unknown> = {}, zoom = 10) {
  const type = property.split("-")[0];
  const spec = (v8 as any)[`paint_${type}`][property];
  const compiled = createPropertyExpression(value, spec);
  expect(compiled.result, JSON.stringify(compiled.value)).toBe("success");
  if (compiled.result === "error") throw new Error(JSON.stringify(compiled.value));
  return compiled.value.evaluate({ zoom }, { type: 2, properties });
}

function rgba(value: any): number[] {
  return [value.r / value.a, value.g / value.a, value.b / value.a, value.a];
}
function converted(renderer: WebMapRenderer) {
  const warnings = createWarningCollector("renderer");
  const result = convertRenderer(renderer, warnings)!;
  expect(warnings.warnings).toEqual([]);
  return result;
}

describe("WebMap visual variables", () => {
  it.each(["simple", "classBreaks", "uniqueValue"])("preserves the captured Speed ramp on %s renderers", (type) => {
    const renderer: WebMapRenderer =
      type === "classBreaks"
        ? fixture.renderer
        : type === "simple"
          ? { type, symbol: line, visualVariables: [color] }
          : { type, field1: "Category", uniqueValueInfos: [{ value: "a", symbol: line }], visualVariables: [color] };
    const result = converted(renderer);
    const expression = result.paint["line-color"];
    for (const stop of color.stops) {
      const actual = rgba(evaluate(expression, "line-color", { Speed: stop.value, Category: "a" }));
      for (let i = 0; i < 4; i++) expect(actual[i]).toBeCloseTo(stop.color[i] / 255, 10);
    }
    const midpoint = rgba(evaluate(expression, "line-color", { Speed: 40, Category: "a" }));
    expect(midpoint[0]).toBeCloseTo((160 + 223) / 2 / 255, 10);
    expect(midpoint[3]).toBeCloseTo(79 / 255, 10);
    for (const [value, stop] of [
      [-10, color.stops[0]],
      [300, color.stops[4]],
    ] as const) {
      expect(rgba(evaluate(expression, "line-color", { Speed: value, Category: "a" }))).toEqual(
        rgba(evaluate(expression, "line-color", { Speed: stop.value, Category: "a" })),
      );
    }
    for (const value of [null, undefined, "20", false]) {
      expect(rgba(evaluate(expression, "line-color", { Speed: value, Category: "a" }))).toEqual([
        170 / 255,
        170 / 255,
        170 / 255,
        1,
      ]);
    }
    expect(result.visualVariableLegends?.[0]).toMatchObject({
      field: "Speed",
      input: "field",
      missingValue: "base-symbol",
      outOfRange: "clamp",
    });
    expect(result.visualVariableLegends?.[0].stops[0]).toEqual({
      value: 20,
      label: "",
      color: `rgba(160,0,0,${79 / 255})`,
    });
  });

  it("interpolates line width in scale space at stops and intermediate scales", () => {
    const result = converted(fixture.renderer);
    const stops = fixture.renderer.visualVariables[1].stops;
    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      expect(
        evaluate(result.paint["line-width"], "line-width", {}, Math.log2(WEB_MERCATOR_SCALE_AT_ZOOM_ZERO / stop.value)),
      ).toBeCloseTo((stop.size * 4) / 3, 10);
      if (i > 0) {
        const scale = (stop.value + stops[i - 1].value) / 2;
        expect(
          evaluate(result.paint["line-width"], "line-width", {}, Math.log2(WEB_MERCATOR_SCALE_AT_ZOOM_ZERO / scale)),
        ).toBeCloseTo((((stop.size + stops[i - 1].size) / 2) * 4) / 3, 10);
      }
    }
  });

  it.each(["circle", "line", "fill"])("converts point sizes to CSS pixels for %s", (type) => {
    const symbol =
      type === "circle"
        ? { type: "esriSMS", size: 10, color: [255, 0, 0, 255] }
        : type === "line"
          ? line
          : { type: "esriSFS", color: [255, 0, 0, 255], outline: line };
    const variable = { ...size, ...(type === "fill" ? { target: "outline" } : {}) };
    const result = converted({ type: "simple", symbol, visualVariables: [variable] });
    const property = type === "circle" ? "circle-radius" : "line-width";
    const paint = type === "fill" ? result.additionalLayers![0].paint : result.paint;
    expect(evaluate(paint[property], property, { Value: 5 })).toBeCloseTo(type === "circle" ? 6 : 12);
    expect(result.visualVariableLegends?.[0].sizeUnit).toBe("css-pixels");
    if (type === "fill") expect(result.paint["fill-outline-color"]).toBe("transparent");
  });

  it("preserves category-dependent null fallback and renderer revival", () => {
    const compat = new UniqueValueRendererCompat({
      field: "Kind",
      uniqueValueInfos: [
        { value: "a", symbol: line },
        { value: "b", symbol: { ...line, color: [0, 0, 255, 255] } },
      ],
      visualVariables: [color],
    });
    const { renderer, warnings } = rendererObjectFromUniqueValueCompat(compat);
    expect(warnings).toEqual([]);
    const [fragment] = renderer!.toMapLibre("line");
    expect(rgba(evaluate(fragment.paint["line-color"], "line-color", { Kind: "b", Speed: null }))).toEqual([
      0, 0, 1, 1,
    ]);
    expect(rendererFromJSON(renderer!.toJSON()).toMapLibre("line")).toEqual(renderer!.toMapLibre("line"));
    expect(renderer!.visualVariableLegends!()[0].missingValueStyle).toEqual([
      "match",
      ["get", "Kind"],
      "a",
      "rgba(170,170,170,1)",
      "b",
      "rgba(0,0,255,1)",
      "rgba(170,170,170,1)",
    ]);
  });

  it("preserves exact polygon alpha for missing values without multiplying it twice", () => {
    const result = converted({
      type: "simple",
      symbol: { type: "esriSFS", color: [10, 20, 30, 79] },
      visualVariables: [color],
    });
    expect(evaluate(result.paint["fill-color"], "fill-color", { Speed: null }).a).toBeCloseTo(79 / 255, 12);
    expect(evaluate(result.paint["fill-color"], "fill-color", { Speed: 20 }).a).toBeCloseTo(79 / 255, 12);
    expect(result.paint["fill-opacity"]).toBe(1);
  });

  it("converts static dimensions when only a color variable is supplied", () => {
    const point = converted({
      type: "simple",
      symbol: { type: "esriSMS", size: 10, outline: { ...line, width: 3 } },
      visualVariables: [color],
    });
    expect(point.paint["circle-radius"]).toBeCloseTo(20 / 3);
    expect(point.paint["circle-stroke-width"]).toBe(4);
    expect(converted({ type: "simple", symbol: line, visualVariables: [color] }).paint["line-width"]).toBe(1);
  });

  it.each(["esriSLSDash", "esriSLSNull"])("preserves outline alpha and %s with a size variable", (style) => {
    const renderer = {
      type: "simple",
      symbol: { type: "esriSFS", color: [0, 0, 0, 255], outline: { ...line, style, color: [10, 20, 30, 79] } },
      visualVariables: [{ ...size, target: "outline" }],
    };
    const result = converted(renderer);
    const paint = result.additionalLayers![0].paint;
    expect(evaluate(paint["line-color"], "line-color").a).toBeCloseTo(79 / 255, 12);
    if (style === "esriSLSDash") expect(paint["line-dasharray"]).toEqual([6, 4]);
    else {
      const parsed = parseWebMap({
        operationalLayers: [
          {
            id: "polygon",
            opacity: 0.5,
            url: "https://example.test/FeatureServer/0",
            layerDefinition: { drawingInfo: { renderer } },
          },
        ],
      });
      expect(parsed.style.layers[1].paint!["line-opacity"]).toBe(0);
    }
  });

  it("reports varying categorical polygon outline dash styles", () => {
    const warn = createWarningCollector();
    convertRenderer(
      {
        type: "uniqueValue",
        field1: "Kind",
        uniqueValueInfos: [
          { value: "a", symbol: { type: "esriSFS", outline: { ...line, style: "esriSLSDash" } } },
          { value: "b", symbol: { type: "esriSFS", outline: { ...line, style: "esriSLSDot" } } },
        ],
        visualVariables: [{ ...size, target: "outline" }],
      },
      warn,
    );
    expect(warn.warnings).toEqual([
      expect.objectContaining({
        code: "unsupported-renderer-semantics",
        path: "uniqueValueInfos[1].symbol.outline.style",
      }),
    ]);
  });

  it("points nested scale-dependent ranges at the original property", () => {
    const warn = createWarningCollector();
    convertRenderer(
      {
        type: "simple",
        symbol: line,
        visualVariables: [
          {
            type: "sizeInfo",
            field: "Value",
            minDataValue: 0,
            maxDataValue: 10,
            minSize: { expression: "view.scale" },
            maxSize: 12,
          },
        ],
      },
      warn,
    );
    expect(warn.warnings[0]).toMatchObject({ code: "unsupported-visual-variable", path: "visualVariables[0].minSize" });
  });

  it("retains class-specific outline width for missing size values in CSS pixels", () => {
    const result = converted({
      type: "uniqueValue",
      field1: "Kind",
      uniqueValueInfos: [
        { value: "a", symbol: { type: "esriSFS", color: [0, 0, 0, 255], outline: { ...line, width: 3 } } },
        { value: "b", symbol: { type: "esriSFS", color: [0, 0, 0, 255], outline: { ...line, width: 6 } } },
      ],
      visualVariables: [{ ...size, target: "outline" }],
    });
    const width = result.additionalLayers![0].paint["line-width"];
    expect(evaluate(width, "line-width", { Kind: "a", Value: null })).toBe(4);
    expect(evaluate(width, "line-width", { Kind: "b", Value: null })).toBe(8);
  });

  it("shares WebMap and compat compilation, retains clone/update state, and remaps fields", () => {
    const input = fixture.renderer;
    const options = { fieldMap: { Speed: "speed" } };
    const compat = new ClassBreaksRendererCompat({
      field: input.field,
      minValue: input.minValue,
      classBreakInfos: input.classBreakInfos.map((entry: any) => ({
        maxValue: entry.classMaxValue,
        symbol: entry.symbol,
      })),
      visualVariables: input.visualVariables,
    });
    expect(compat.clone().visualVariables).toEqual(input.visualVariables);
    const { renderer, warnings } = rendererObjectFromClassBreaksCompat(compat, options);
    const converted = convertRenderer(input, createWarningCollector(), options)!;
    expect(warnings).toEqual([]);
    expect(renderer!.toMapLibre("line")[0].paint).toEqual(converted.paint);
    expect(renderer!.visualVariableLegends!()).toEqual(converted.visualVariableLegends);
    expect(JSON.stringify(converted.paint)).not.toContain('"Speed"');
    const simple = new SimpleRendererCompat({ symbol: line, visualVariables: [color] });
    expect(convertSimpleRendererCompat(simple, options).renderer).toEqual(
      convertRenderer({ type: "simple", symbol: line, visualVariables: [color] }, createWarningCollector(), options),
    );
    compat.update({ visualVariables: [] });
    expect(compat.toJSON().visualVariables).toEqual([]);
  });

  it.each([
    { type: "rotationInfo", field: "Angle" },
    { ...color, valueExpression: "$feature.Speed / 2" },
    { ...color, normalizationField: "Population" },
    { ...size, valueUnit: "meters" },
    { ...size, minSize: { expression: "view.scale" }, stops: undefined },
    {
      ...color,
      stops: [
        { value: 1, color: [0, 0, 0, 255] },
        { value: 1, color: [255, 0, 0, 255] },
      ],
    },
    null,
  ])("reports unsupported semantics with actionable migration paths: %j", (variable) => {
    const input = {
      operationalLayers: [
        {
          id: "flight",
          url: "https://example.test/FeatureServer/0",
          layerDefinition: { drawingInfo: { renderer: { type: "simple", symbol: line, visualVariables: [variable] } } },
        },
      ],
    };
    const parsed = parseWebMap(input);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0].code).toBe("unsupported-visual-variable");
    expect(parsed.warnings[0].path).toContain(
      "operationalLayers[0].layerDefinition.drawingInfo.renderer.visualVariables[0]",
    );
    const report = webmapJsonToMapLibreStyle(input);
    expect(report.manualGaps).toHaveLength(1);
    expect(report.manualGaps[0].kind).toBe("unsupported-renderer");
  });

  it("rejects colliding variables and validates real MapLibre style including polygon outlines", () => {
    const warn = createWarningCollector();
    convertRenderer({ type: "simple", symbol: line, visualVariables: [color, color] }, warn);
    expect(warn.warnings[0]).toMatchObject({ code: "unsupported-visual-variable", path: "visualVariables[1]" });
    const { style, warnings } = parseWebMap({
      operationalLayers: [
        {
          id: "polygon",
          opacity: 0.5,
          url: "https://example.test/FeatureServer/0",
          layerDefinition: {
            drawingInfo: {
              renderer: {
                type: "simple",
                symbol: { type: "esriSFS", color: [0, 0, 255, 128], outline: line },
                visualVariables: [color, { ...size, target: "outline" }],
              },
            },
          },
        },
      ],
    });
    expect(warnings).toEqual([]);
    expect(style.layers).toHaveLength(2);
    expect(style.layers[1]).toMatchObject({ type: "line", paint: { "line-opacity": 0.5 } });
    const valid = {
      ...style,
      sources: { polygon: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
    };
    expect(validateStyleMin(valid as any)).toEqual([]);
    expect(style.layers[0].metadata).toHaveProperty("honua:visual-variable-legends");
  });
});
