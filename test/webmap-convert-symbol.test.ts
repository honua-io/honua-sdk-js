import { describe, expect, it } from "vitest";
import { convertSymbol, esriColorToCss, esriLineStyleToDashArray } from "../src/webmap/index.js";
import { createWarningCollector } from "../src/webmap/warnings.js";

describe("WebMap symbol converter", () => {
  describe("esriColorToCss", () => {
    it("converts fully opaque color to rgb()", () => {
      expect(esriColorToCss([255, 0, 128, 255])).toBe("rgb(255,0,128)");
    });

    it("converts semi-transparent color to rgba()", () => {
      expect(esriColorToCss([76, 115, 0, 200])).toBe("rgba(76,115,0,0.78)");
    });

    it("converts fully transparent color to rgba()", () => {
      expect(esriColorToCss([0, 0, 0, 0])).toBe("rgba(0,0,0,0)");
    });

    it("returns undefined for undefined input", () => {
      expect(esriColorToCss(undefined)).toBeUndefined();
    });
  });

  describe("esriLineStyleToDashArray", () => {
    it("returns undefined for solid", () => {
      expect(esriLineStyleToDashArray("esriSLSSolid")).toBeUndefined();
    });

    it("returns [6,4] for dash", () => {
      expect(esriLineStyleToDashArray("esriSLSDash")).toEqual([6, 4]);
    });

    it("returns [2,4] for dot", () => {
      expect(esriLineStyleToDashArray("esriSLSDot")).toEqual([2, 4]);
    });

    it("returns [6,4,2,4] for dashDot", () => {
      expect(esriLineStyleToDashArray("esriSLSDashDot")).toEqual([6, 4, 2, 4]);
    });

    it("returns [6,4,2,4,2,4] for dashDotDot", () => {
      expect(esriLineStyleToDashArray("esriSLSDashDotDot")).toEqual([6, 4, 2, 4, 2, 4]);
    });

    it("returns undefined for unknown style", () => {
      expect(esriLineStyleToDashArray("esriSLSUnknown")).toBeUndefined();
    });
  });

  describe("convertSymbol", () => {
    it("converts esriSFS to fill layer properties", () => {
      const warn = createWarningCollector();
      const result = convertSymbol(
        {
          type: "esriSFS",
          style: "esriSFSSolid",
          color: [0, 128, 255, 255] as [number, number, number, number],
          outline: {
            type: "esriSLS",
            style: "esriSLSSolid",
            color: [0, 0, 0, 255] as [number, number, number, number],
            width: 1,
          },
        },
        warn,
      );

      expect(result).toEqual({
        layerType: "fill",
        paint: {
          "fill-color": "rgb(0,128,255)",
          "fill-outline-color": "rgb(0,0,0)",
        },
        layout: {},
      });
      expect(warn.warnings).toHaveLength(0);
    });

    it("converts esriSLS to line layer properties", () => {
      const warn = createWarningCollector();
      const result = convertSymbol(
        {
          type: "esriSLS",
          style: "esriSLSDash",
          color: [255, 0, 0, 255] as [number, number, number, number],
          width: 3,
        },
        warn,
      );

      expect(result).toEqual({
        layerType: "line",
        paint: {
          "line-color": "rgb(255,0,0)",
          "line-width": 3,
          "line-dasharray": [6, 4],
        },
        layout: {},
      });
    });

    it("converts esriSMS to circle layer properties", () => {
      const warn = createWarningCollector();
      const result = convertSymbol(
        {
          type: "esriSMS",
          style: "esriSMSCircle",
          color: [0, 200, 0, 255] as [number, number, number, number],
          size: 12,
          outline: {
            type: "esriSLS",
            style: "esriSLSSolid",
            color: [50, 50, 50, 255] as [number, number, number, number],
            width: 2,
          },
        },
        warn,
      );

      expect(result).toEqual({
        layerType: "circle",
        paint: {
          "circle-color": "rgb(0,200,0)",
          "circle-radius": 6,
          "circle-stroke-color": "rgb(50,50,50)",
          "circle-stroke-width": 2,
        },
        layout: {},
      });
    });

    it("converts esriPMS and emits sprite warning", () => {
      const warn = createWarningCollector();
      const result = convertSymbol(
        {
          type: "esriPMS",
          url: "https://example.com/icon.png",
          width: 24,
          height: 24,
        },
        warn,
      );

      expect(result).toEqual({
        layerType: "symbol",
        paint: {},
        layout: {
          "icon-image": "https://example.com/icon.png",
          "icon-size": 1,
        },
      });
      expect(warn.warnings).toHaveLength(1);
      expect(warn.warnings[0].code).toBe("sprite-required");
    });

    it("converts esriTS to symbol layer properties", () => {
      const warn = createWarningCollector();
      const result = convertSymbol(
        {
          type: "esriTS",
          color: [0, 0, 0, 255] as [number, number, number, number],
          font: { family: "Arial", size: 14 },
          text: "Label",
        },
        warn,
      );

      expect(result).toEqual({
        layerType: "symbol",
        paint: { "text-color": "rgb(0,0,0)" },
        layout: {
          "text-field": "Label",
          "text-size": 14,
          "text-font": ["Arial"],
        },
      });
    });

    it("emits warning for unknown symbol type", () => {
      const warn = createWarningCollector();
      const result = convertSymbol({ type: "esriUnknown" }, warn);
      expect(result).toBeUndefined();
      expect(warn.warnings).toHaveLength(1);
      expect(warn.warnings[0].code).toBe("unsupported-symbol");
    });
  });
});
