import { describe, expect, it } from "vitest";

import { ClassBreaksRendererCompat } from "../src/esri-compat/class-breaks-renderer.js";
import {
  rendererObjectFromClassBreaksCompat,
  rendererObjectFromUniqueValueCompat,
} from "../src/esri-compat/renderer-objects.js";
import { UniqueValueRendererCompat } from "../src/esri-compat/unique-value-renderer.js";
import { convertRenderer } from "../src/webmap/index.js";
import { createWarningCollector } from "../src/webmap/warnings.js";

const RED = { type: "esriSMS", color: [255, 0, 0, 255] as [number, number, number, number], size: 10 };
const GREEN = { type: "esriSMS", color: [0, 255, 0, 255] as [number, number, number, number], size: 10 };
const GRAY = { type: "esriSMS", color: [128, 128, 128, 255] as [number, number, number, number], size: 8 };

describe("esri-compat renderer shims emit renderer objects", () => {
  it("ClassBreaksRendererCompat projects to a class-breaks renderer object", () => {
    const compat = new ClassBreaksRendererCompat({
      field: "POP",
      defaultSymbol: GRAY,
      classBreakInfos: [
        { minValue: 0, maxValue: 1000, symbol: RED, label: "Small" },
        { minValue: 1000, maxValue: 100000, symbol: GREEN, label: "Large" },
      ],
    });
    const { renderer, warnings } = rendererObjectFromClassBreaksCompat(compat);
    expect(warnings).toHaveLength(0);
    expect(renderer).toBeDefined();
    expect(renderer!.kind).toBe("class-breaks");
    const [fragment] = renderer!.toMapLibre("point");
    expect(fragment.type).toBe("circle");
    expect(fragment.paint["circle-color"]).toEqual([
      "step",
      ["get", "POP"],
      "rgb(128,128,128)",
      0,
      "rgb(255,0,0)",
      1000,
      "rgb(0,255,0)",
    ]);
    // The default symbol contributes a trailing default swatch.
    expect(renderer!.legendItems().map((item) => item.label)).toEqual(["Small", "Large", "Other"]);
    expect(renderer!.legendItems().at(-1)?.color).toBe("rgb(128,128,128)");
  });

  it("UniqueValueRendererCompat projects to a unique-value renderer object", () => {
    const compat = new UniqueValueRendererCompat({
      field: "STATUS",
      defaultSymbol: GRAY,
      defaultLabel: "Unknown",
      uniqueValueInfos: [
        { value: "open", symbol: RED, label: "Open" },
        { value: "closed", symbol: GREEN, label: "Closed" },
      ],
    });
    const { renderer, warnings } = rendererObjectFromUniqueValueCompat(compat);
    expect(warnings).toHaveLength(0);
    expect(renderer).toBeDefined();
    const [fragment] = renderer!.toMapLibre("point");
    expect(fragment.paint["circle-color"]).toEqual([
      "match",
      ["get", "STATUS"],
      "open",
      "rgb(255,0,0)",
      "closed",
      "rgb(0,255,0)",
      "rgb(128,128,128)",
    ]);
    expect(renderer!.legendItems()).toEqual([
      { kind: "unique-value", label: "Open", color: "rgb(255,0,0)", value: "open" },
      { kind: "unique-value", label: "Closed", color: "rgb(0,255,0)", value: "closed" },
      { kind: "default", label: "Unknown", color: "rgb(128,128,128)" },
    ]);
  });

  it("compat emission and webmap conversion share one implementation (identical output)", () => {
    const compat = new UniqueValueRendererCompat({
      field: "TYPE",
      uniqueValueInfos: [
        { value: "a", symbol: RED },
        { value: "b", symbol: GREEN },
      ],
    });
    const { renderer } = rendererObjectFromUniqueValueCompat(compat);
    const [fragment] = renderer!.toMapLibre("point");

    const warn = createWarningCollector();
    const converted = convertRenderer(
      {
        type: "uniqueValue",
        field1: "TYPE",
        uniqueValueInfos: [
          { value: "a", symbol: RED },
          { value: "b", symbol: GREEN },
        ],
      },
      warn,
    );
    expect(JSON.stringify({ paint: fragment.paint, layout: fragment.layout })).toBe(
      JSON.stringify({ paint: converted!.paint, layout: converted!.layout }),
    );
  });

  it("returns undefined when nothing is convertible", () => {
    const empty = rendererObjectFromUniqueValueCompat(new UniqueValueRendererCompat({ field: "X" }));
    expect(empty.renderer).toBeUndefined();
    const badSymbol = rendererObjectFromClassBreaksCompat(
      new ClassBreaksRendererCompat({
        field: "X",
        classBreakInfos: [{ maxValue: 10, symbol: { type: "esriUnknown" } }],
      }),
    );
    expect(badSymbol.renderer).toBeUndefined();
    expect(badSymbol.warnings.some((warning) => warning.code === "unsupported-symbol")).toBe(true);
  });
});
