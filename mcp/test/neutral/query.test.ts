import { HonuaCapabilityNotSupportedError } from "@honua/sdk-js";
import { describe, expect, it } from "vitest";
import { toToolErrorPayload, toolErrorResult } from "../../src/neutral/errors.js";
import { parseOrderBy, toQuery } from "../../src/neutral/query.js";
import { projectDegraded, projectGeometry } from "../../src/neutral/result.js";

const GEOSERVICES = { protocol: "geoservices-feature-service" } as const;
const OGC = { protocol: "ogc-features" } as const;

describe("neutral query lowering", () => {
  it("parses both order-by forms", () => {
    expect(parseOrderBy("NAME DESC, VALUE ASC")).toEqual([
      { field: "NAME", direction: "desc" },
      { field: "VALUE", direction: "asc" },
    ]);
    expect(parseOrderBy([{ field: "NAME" }])).toEqual([{ field: "NAME", direction: "asc" }]);
    expect(parseOrderBy(undefined)).toBeUndefined();
    expect(parseOrderBy("")).toBeUndefined();
    expect(parseOrderBy([])).toBeUndefined();
  });

  it("requests all fields for GeoServices but never for other protocols", () => {
    expect(toQuery({}, GEOSERVICES).outFields).toEqual(["*"]);
    expect(toQuery({}, OGC).outFields).toBeUndefined();
    expect(toQuery({ outFields: ["A"] }, OGC).outFields).toEqual(["A"]);
  });

  it("applies the default page size and clamps an oversized one", () => {
    expect(toQuery({}, OGC).pagination).toEqual({ limit: 100 });
    expect(toQuery({ limit: 99_999 }, OGC).pagination).toEqual({ limit: 2000 });
    expect(toQuery({ offset: 10 }, OGC).pagination).toEqual({ limit: 100, offset: 10 });
  });

  it("omits the default page size for aggregate/extent queries", () => {
    expect(toQuery({}, { ...OGC, paginate: false }).pagination).toBeUndefined();
    expect(toQuery({ limit: 5 }, { ...OGC, paginate: false }).pagination).toEqual({ limit: 5 });
  });

  it("routes an envelope-intersects constraint to the portable spatial filter", () => {
    const query = toQuery({ bbox: [0, 1, 2, 3] }, OGC);
    expect(query.spatialFilter).toMatchObject({
      geometryType: "esriGeometryEnvelope",
      spatialRel: "esriSpatialRelIntersects",
    });
    expect(query.filter).toBeUndefined();
  });

  it("routes a richer spatial constraint to the typed filter so it can fail closed", () => {
    const query = toQuery({ geometry: { type: "Point", coordinates: [1, 2] }, spatialRel: "within" }, OGC);
    expect(query.spatialFilter).toBeUndefined();
    expect(query.filter).toMatchObject({ kind: "spatial", operator: "within" });
  });

  it("conjoins the typed filter with the spatial constraint", () => {
    const query = toQuery(
      {
        filter: { op: "eq", field: "A", value: 1 },
        geometry: { type: "Point", coordinates: [1, 2] },
        spatialRel: "contains",
      },
      OGC,
    );
    expect(query.filter).toMatchObject({ kind: "boolean", operator: "and" });
  });

  it("refuses geometry and bbox together", () => {
    expect(() => toQuery({ bbox: [0, 1, 2, 3], geometry: { type: "Point", coordinates: [1, 2] } }, OGC)).toThrow(
      /not both/,
    );
  });

  it("keeps the deprecated where clause only when it is non-empty", () => {
    expect(toQuery({ where: "A = 1" }, GEOSERVICES).where).toBe("A = 1");
    expect(toQuery({ where: "   " }, GEOSERVICES).where).toBeUndefined();
  });

  it("carries the canonical temporal filter through", () => {
    expect(toQuery({ temporal: { instant: "2026-01-01T00:00:00Z" } }, OGC).temporalFilter).toEqual({
      kind: "instant",
      instant: "2026-01-01T00:00:00Z",
    });
  });
});

describe("neutral result projection", () => {
  it("re-encodes Esri geometry as GeoJSON and passes GeoJSON through", () => {
    expect(projectGeometry({ x: 1, y: 2 }, "geojson")).toEqual({ type: "Point", coordinates: [1, 2] });
    expect(projectGeometry({ type: "Point", coordinates: [1, 2] }, "geojson")).toEqual({
      type: "Point",
      coordinates: [1, 2],
    });
    expect(projectGeometry({ x: 1, y: 2 }, "esri-json")).toEqual({ x: 1, y: 2 });
    expect(projectGeometry(null, "geojson")).toBeNull();
    expect(projectGeometry({ rings: [] }, "geojson")).toBeNull();
  });

  it("normalizes degradation reasons and omits an empty list", () => {
    expect(projectDegraded(undefined)).toBeUndefined();
    expect(projectDegraded([])).toBeUndefined();
    expect(projectDegraded([{ capability: "queryAggregate", reason: "client-side" }])).toEqual([
      { capability: "queryAggregate", reason: "client-side", protocol: null, sourceId: null },
    ]);
  });
});

describe("capability honesty", () => {
  it("maps a capability refusal onto an explained, machine-actionable error", () => {
    const payload = toToolErrorPayload(
      new HonuaCapabilityNotSupportedError("queryAggregate", "ogc-features", "ogc-features:obs"),
    );

    expect(payload.code).toBe("capability_not_supported");
    expect(payload.error.kind).toBe("ExecutionFailed");
    expect(payload.error.capability).toBe("queryAggregate");
    expect(payload.error.protocol).toBe("ogc-features");
    expect(payload.error.explanation).toBeDefined();
    expect(payload.error.guidance).toBeTruthy();
  });

  it("does not fabricate an explanation for a filter-construct refusal", () => {
    const payload = toToolErrorPayload(
      new HonuaCapabilityNotSupportedError("filter.spatial.multiple", "geoservices-feature-service"),
    );

    expect(payload.error.explanation).toBeUndefined();
    expect(payload.error.violations?.[0].fieldPath).toBe("filter");
  });

  it("emits the payload in both the text and structured channels", () => {
    const result = toolErrorResult(toToolErrorPayload(new Error("boom")));

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "tool_execution_failed" });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { kind: "ExecutionFailed" } });
  });
});
