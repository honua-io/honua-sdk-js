import { describe, expect, it } from "vitest";
import { convertExtent, convertInitialViewpoint } from "../src/webmap/index.js";
import { createWarningCollector } from "../src/webmap/warnings.js";

describe("WebMap extent converter", () => {
  it("converts Web Mercator extent to center/zoom", () => {
    const warn = createWarningCollector();
    const result = convertExtent(
      {
        xmin: -13658965,
        ymin: 5697895,
        xmax: -13614146,
        ymax: 5765219,
        spatialReference: { wkid: 102100, latestWkid: 3857 },
      },
      warn,
    );

    expect(result).toBeDefined();
    expect(result!.center).toHaveLength(2);
    // Longitude should be roughly -122.x (San Francisco area)
    expect(result!.center[0]).toBeGreaterThan(-123);
    expect(result!.center[0]).toBeLessThan(-122);
    // Latitude should be roughly 45-46 (Portland area)
    expect(result!.center[1]).toBeGreaterThan(45);
    expect(result!.center[1]).toBeLessThan(47);
    expect(result!.zoom).toBeGreaterThan(0);
    expect(warn.warnings).toHaveLength(0);
  });

  it("converts geographic (4326) extent", () => {
    const warn = createWarningCollector();
    const result = convertExtent(
      {
        xmin: -120,
        ymin: 35,
        xmax: -118,
        ymax: 37,
        spatialReference: { wkid: 4326 },
      },
      warn,
    );

    expect(result).toBeDefined();
    expect(result!.center).toEqual([-119, 36]);
    expect(result!.zoom).toBeGreaterThan(0);
  });

  it("emits warning for unsupported spatial reference", () => {
    const warn = createWarningCollector();
    const result = convertExtent(
      {
        xmin: 0,
        ymin: 0,
        xmax: 100,
        ymax: 100,
        spatialReference: { wkid: 2154 },
      },
      warn,
    );

    expect(result).toBeUndefined();
    expect(warn.warnings).toHaveLength(1);
    expect(warn.warnings[0].code).toBe("unsupported-spatial-reference");
  });

  it("returns undefined for undefined extent", () => {
    const warn = createWarningCollector();
    expect(convertExtent(undefined, warn)).toBeUndefined();
  });

  it("handles extent without spatial reference (small values → geographic)", () => {
    const warn = createWarningCollector();
    const result = convertExtent({ xmin: -10, ymin: 40, xmax: 10, ymax: 50 }, warn);

    expect(result).toBeDefined();
    expect(result!.center).toEqual([0, 45]);
  });

  it("converts initialViewpoint point geometry using scale", () => {
    const warn = createWarningCollector();
    const result = convertInitialViewpoint(
      {
        targetGeometry: {
          x: -13636555,
          y: 5728700,
          spatialReference: { wkid: 102100 },
        },
        scale: 4622324,
      },
      warn,
    );

    expect(result).toBeDefined();
    expect(result!.center[0]).toBeGreaterThan(-123);
    expect(result!.center[0]).toBeLessThan(-122);
    expect(result!.zoom).toBeGreaterThan(6);
    expect(result!.zoom).toBeLessThan(8);
    expect(warn.warnings).toHaveLength(0);
  });

  it("warns for unsupported initialViewpoint spatial reference", () => {
    const warn = createWarningCollector();
    const result = convertInitialViewpoint(
      {
        targetGeometry: {
          x: 700000,
          y: 6600000,
          spatialReference: { wkid: 2154 },
        },
      },
      warn,
    );

    expect(result).toBeUndefined();
    expect(warn.warnings).toHaveLength(1);
    expect(warn.warnings[0].code).toBe("unsupported-spatial-reference");
  });
});
