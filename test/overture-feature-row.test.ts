import { describe, expect, it } from "vitest";

import { normalizeFeature } from "../examples/overture-geoparquet/src/feature-row.js";

const place = {
  id: "waikiki",
  names: { primary: "Waikiki Beach" },
  category: "beach",
  confidence: "0.96",
  bbox: { xmin: "-157.8261", xmax: "-157.8261", ymin: "21.2762", ymax: "21.2762" },
};

describe("Overture displayed numeric fields", () => {
  it("converts lossless decimal strings into confidence and geographic coordinates", () => {
    expect(normalizeFeature(place)).toEqual({
      id: "waikiki",
      name: "Waikiki Beach",
      category: "beach",
      confidence: 0.96,
      longitude: -157.8261,
      latitude: 21.2762,
    });
  });

  it("accepts numeric fields and computes the bbox center", () => {
    expect(
      normalizeFeature({ ...place, confidence: 0, bbox: { xmin: -158, xmax: -157, ymin: 21, ymax: 22 } }),
    ).toMatchObject({ confidence: 0, longitude: -157.5, latitude: 21.5 });
  });

  it.each([undefined, null, "", " ", "invalid", Number.NaN, Number.POSITIVE_INFINITY, new Uint32Array([96])])(
    "rejects malformed confidence instead of rendering zero: %s",
    (confidence) => {
      expect(() => normalizeFeature({ ...place, confidence })).toThrow("confidence must be a finite number");
    },
  );

  it("rejects missing bbox coordinates instead of plotting at the origin", () => {
    expect(() => normalizeFeature({ ...place, bbox: { ...place.bbox, xmin: null } })).toThrow(
      "bbox.xmin must be a finite number",
    );
  });
});
