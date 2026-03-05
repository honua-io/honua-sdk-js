import { describe, expect, it } from "vitest";
import { convertRenderer } from "../src/webmap/index.js";
import { createWarningCollector } from "../src/webmap/warnings.js";

describe("WebMap renderer converter", () => {
  describe("simple renderer", () => {
    it("delegates to symbol conversion", () => {
      const warn = createWarningCollector();
      const result = convertRenderer(
        {
          type: "simple",
          symbol: {
            type: "esriSFS",
            color: [100, 200, 50, 255] as [number, number, number, number],
          },
        },
        warn,
      );

      expect(result).toEqual({
        layerType: "fill",
        paint: { "fill-color": "rgb(100,200,50)" },
        layout: {},
      });
    });
  });

  describe("uniqueValue renderer", () => {
    it("produces match expression for single field", () => {
      const warn = createWarningCollector();
      const result = convertRenderer(
        {
          type: "uniqueValue",
          field1: "TYPE",
          defaultSymbol: {
            type: "esriSFS",
            color: [200, 200, 200, 255] as [number, number, number, number],
          },
          uniqueValueInfos: [
            {
              value: "A",
              symbol: {
                type: "esriSFS",
                color: [255, 0, 0, 255] as [number, number, number, number],
              },
            },
            {
              value: "B",
              symbol: {
                type: "esriSFS",
                color: [0, 255, 0, 255] as [number, number, number, number],
              },
            },
          ],
        },
        warn,
      );

      expect(result).toBeDefined();
      expect(result!.layerType).toBe("fill");
      const fillColor = result!.paint["fill-color"] as unknown[];
      expect(fillColor[0]).toBe("match");
      expect(fillColor[1]).toEqual(["get", "TYPE"]);
      expect(fillColor).toContain("A");
      expect(fillColor).toContain("B");
    });

    it("produces concat expression for multi-field", () => {
      const warn = createWarningCollector();
      const result = convertRenderer(
        {
          type: "uniqueValue",
          field1: "STATE",
          field2: "ZONE",
          fieldDelimiter: ",",
          defaultSymbol: {
            type: "esriSFS",
            color: [200, 200, 200, 255] as [number, number, number, number],
          },
          uniqueValueInfos: [
            {
              value: "CA,Urban",
              symbol: {
                type: "esriSFS",
                color: [255, 0, 0, 255] as [number, number, number, number],
              },
            },
          ],
        },
        warn,
      );

      expect(result).toBeDefined();
      const fillColor = result!.paint["fill-color"] as unknown[];
      expect(fillColor[0]).toBe("match");
      const fieldExpr = fillColor[1] as unknown[];
      expect(fieldExpr[0]).toBe("concat");
    });
  });

  describe("classBreaks renderer", () => {
    it("produces step expression", () => {
      const warn = createWarningCollector();
      const result = convertRenderer(
        {
          type: "classBreaks",
          field: "VALUE",
          defaultSymbol: {
            type: "esriSFS",
            color: [255, 255, 255, 255] as [number, number, number, number],
          },
          classBreakInfos: [
            {
              classMinValue: 0,
              classMaxValue: 100,
              symbol: {
                type: "esriSFS",
                color: [255, 255, 178, 255] as [number, number, number, number],
              },
            },
            {
              classMinValue: 100,
              classMaxValue: 500,
              symbol: {
                type: "esriSFS",
                color: [253, 141, 60, 255] as [number, number, number, number],
              },
            },
          ],
        },
        warn,
      );

      expect(result).toBeDefined();
      expect(result!.layerType).toBe("fill");
      const fillColor = result!.paint["fill-color"] as unknown[];
      expect(fillColor[0]).toBe("step");
      expect(fillColor[1]).toEqual(["get", "VALUE"]);
      // Default
      expect(fillColor[2]).toBe("rgb(255,255,255)");
      // First break threshold
      expect(fillColor[3]).toBe(0);
      expect(fillColor[4]).toBe("rgb(255,255,178)");
    });
  });

  describe("unsupported renderer", () => {
    it("emits warning for heatmap renderer", () => {
      const warn = createWarningCollector();
      const result = convertRenderer({ type: "heatmap", blurRadius: 10 }, warn);

      expect(result).toBeUndefined();
      expect(warn.warnings).toHaveLength(1);
      expect(warn.warnings[0].code).toBe("unsupported-renderer");
      expect(warn.warnings[0].message).toContain("heatmap");
    });
  });
});
