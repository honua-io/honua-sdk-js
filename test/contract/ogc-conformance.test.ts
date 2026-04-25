/**
 * Conformance-class → canonical capability negotiation. The OGC API
 * conformance class identifiers are intentionally kept internal:
 * `negotiateOgcCapabilities` is the only seam that translates between
 * the server-advertised list and the canonical capability vocabulary.
 */

import { describe, expect, it } from "vitest";

import {
  hasOgcConformanceClass,
  negotiateOgcCapabilities,
} from "../../src/core/ogc-conformance.js";

describe("ogc-conformance / negotiateOgcCapabilities", () => {
  it("translates OGC API Features 1.0 + Part 3 + Part 4 into canonical capabilities", () => {
    const caps = negotiateOgcCapabilities("ogc-features", {
      conformsTo: [
        "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
        "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/oas30",
        "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson",
        "http://www.opengis.net/spec/ogcapi-features-3/1.0/conf/filter",
        "http://www.opengis.net/spec/ogcapi-features-4/1.0/conf/create-replace-delete",
      ],
    });
    expect(caps.has("query")).toBe(true);
    expect(caps.has("queryObjectIds")).toBe(true);
    expect(caps.has("queryAggregate")).toBe(true);
    expect(caps.has("applyEdits")).toBe(true);
    // No render / tiles for plain Features.
    expect(caps.has("render")).toBe(false);
    expect(caps.has("tiles")).toBe(false);
  });

  it("translates OGC API Tiles core + tilesets-list + dataset-tilesets", () => {
    const caps = negotiateOgcCapabilities("ogc-tiles", {
      conformsTo: [
        "http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/core",
        "http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/tilesets-list",
        "http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/mvt",
      ],
    });
    expect(caps.has("tiles")).toBe(true);
    expect(caps.has("render")).toBe(true);
  });

  it("translates OGC API Maps core + scaling + spatial-subsetting", () => {
    const caps = negotiateOgcCapabilities("ogc-maps", {
      conformsTo: [
        "http://www.opengis.net/spec/ogcapi-maps-1/1.0/conf/core",
        "http://www.opengis.net/spec/ogcapi-maps-1/1.0/conf/scaling",
        "http://www.opengis.net/spec/ogcapi-maps-1/1.0/conf/spatial-subsetting",
      ],
    });
    expect(caps.has("render")).toBe(true);
  });

  it("translates OGC API Processes core + dismiss to the processes capability", () => {
    const caps = negotiateOgcCapabilities("ogc-processes", {
      conformsTo: [
        "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/core",
        "http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/dismiss",
      ],
    });
    expect(caps.has("processes")).toBe(true);
  });

  it("translates STAC item-search to query + queryObjectIds and does not advertise queryAggregate for filter", () => {
    // STAC's `filter` extension is CQL2 query-side filtering, not server-side
    // aggregation. The STAC source adapter has no aggregation implementation
    // (`stacSearchSource.queryAggregate` always throws), so the negotiated
    // capability set must not include `queryAggregate`. Otherwise a
    // descriptor built from negotiated caps would advertise a method the
    // adapter cannot fulfill.
    const caps = negotiateOgcCapabilities("stac", {
      conformsTo: [
        "https://api.stacspec.org/v1.0.0/core",
        "https://api.stacspec.org/v1.0.0/item-search",
        "https://api.stacspec.org/v1.0.0/filter",
      ],
    });
    expect(caps.has("query")).toBe(true);
    expect(caps.has("queryObjectIds")).toBe(true);
    expect(caps.has("queryAggregate")).toBe(false);
  });

  it("returns an empty set when the server does not advertise any matching class", () => {
    const caps = negotiateOgcCapabilities("ogc-features", { conformsTo: [] });
    expect(caps.size).toBe(0);
  });

  it("hasOgcConformanceClass is a substring check against conformsTo", () => {
    const conformance = {
      conformsTo: ["http://www.opengis.net/spec/ogcapi-features-3/1.0/conf/filter"],
    };
    expect(hasOgcConformanceClass(conformance, "features-3")).toBe(true);
    expect(hasOgcConformanceClass(conformance, "features-4")).toBe(false);
    expect(hasOgcConformanceClass(undefined, "anything")).toBe(false);
  });
});
