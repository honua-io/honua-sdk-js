import { describe, expect, it } from "vitest";
import {
  FilterInputError,
  bboxToOperand,
  filterSchema,
  toGeometryOperand,
  toQueryFilter,
  toTemporalFilter,
} from "../../src/neutral/filter.js";

describe("protocol-neutral filter vocabulary", () => {
  it("lowers comparison nodes onto the canonical AST", () => {
    expect(toQueryFilter({ op: "eq", field: "STATUS", value: "open" })).toEqual({
      kind: "comparison",
      operator: "eq",
      left: { kind: "property", name: "STATUS" },
      right: { kind: "literal", value: "open" },
    });
    expect(toQueryFilter({ op: "gte", field: "POP", value: 100 })).toMatchObject({ operator: "gte" });
  });

  it("lowers list, range, null and pattern nodes", () => {
    expect(toQueryFilter({ op: "in", field: "ST", values: ["CA", "TX"] })).toMatchObject({
      kind: "list",
      operator: "in",
      values: [
        { kind: "literal", value: "CA" },
        { kind: "literal", value: "TX" },
      ],
    });
    expect(toQueryFilter({ op: "between", field: "POP", lower: 1, upper: 9 })).toMatchObject({
      kind: "range",
      operator: "between",
    });
    expect(toQueryFilter({ op: "is-null", field: "SEATS" })).toMatchObject({ kind: "null", operator: "is-null" });
    expect(toQueryFilter({ op: "like", field: "NAME", pattern: "San%", caseSensitive: false })).toMatchObject({
      kind: "pattern",
      pattern: "San%",
      caseSensitive: false,
    });
  });

  it("lowers boolean composition", () => {
    const filter = toQueryFilter({
      op: "and",
      args: [
        { op: "eq", field: "A", value: 1 },
        { op: "not", arg: { op: "eq", field: "B", value: 2 } },
      ],
    });
    expect(filter).toMatchObject({ kind: "boolean", operator: "and" });
    expect((filter as { args: unknown[] }).args[1]).toMatchObject({ kind: "not" });
  });

  it("lowers spatial nodes from GeoJSON and from a bbox", () => {
    const fromGeoJson = toQueryFilter({
      op: "within",
      geometry: { type: "Point", coordinates: [1, 2] },
      field: "geom",
    });
    expect(fromGeoJson).toMatchObject({
      kind: "spatial",
      operator: "within",
      property: "geom",
      geometry: { geometry: { x: 1, y: 2 }, geometryType: "esriGeometryPoint" },
    });

    expect(toQueryFilter({ op: "intersects", bbox: [0, 1, 2, 3] })).toMatchObject({
      kind: "spatial",
      geometry: { geometryType: "esriGeometryEnvelope" },
    });
  });

  it("refuses a spatial node with no operand, or with two", () => {
    expect(() => toQueryFilter({ op: "intersects" })).toThrow(FilterInputError);
    expect(() =>
      toQueryFilter({ op: "intersects", bbox: [0, 1, 2, 3], geometry: { type: "Point", coordinates: [1, 2] } }),
    ).toThrow(/not both|exactly one/);
  });

  it("lowers temporal nodes for instants and intervals", () => {
    expect(toQueryFilter({ op: "before", field: "TS", value: "2026-01-01T00:00:00Z" })).toMatchObject({
      kind: "temporal",
      operator: "before",
      value: { valueType: "instant" },
    });
    expect(
      toQueryFilter({ op: "during", field: "TS", value: ["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"] }),
    ).toMatchObject({ kind: "temporal", operator: "during", value: { valueType: "interval" } });
  });

  it("rejects an unknown operator", () => {
    expect(() => toQueryFilter({ op: "sounds-like", field: "A", value: 1 } as never)).toThrow(FilterInputError);
  });

  it("converts GeoJSON geometry, and still accepts Esri-JSON", () => {
    expect(
      toGeometryOperand({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      }),
    ).toMatchObject({
      geometryType: "esriGeometryPolygon",
    });
    expect(toGeometryOperand({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 })).toMatchObject({
      geometryType: "esriGeometryEnvelope",
    });
    expect(toGeometryOperand({ rings: [] }, "esriGeometryPolygon")).toMatchObject({
      geometryType: "esriGeometryPolygon",
    });
  });

  it("refuses geometry it cannot classify rather than guessing a type", () => {
    expect(() => toGeometryOperand({ nonsense: true })).toThrow(/neither GeoJSON/);
    expect(() => toGeometryOperand({ type: "GeometryCollection", coordinates: [] })).toThrow();
  });

  it("stamps a spatial reference on a bbox operand when a SRID is supplied", () => {
    expect(bboxToOperand([0, 1, 2, 3], 3857).geometry).toEqual({
      xmin: 0,
      ymin: 1,
      xmax: 2,
      ymax: 3,
      spatialReference: { wkid: 3857 },
    });
  });

  it("lowers the temporal input onto Query.temporalFilter", () => {
    expect(toTemporalFilter({ instant: "2026-01-01T00:00:00Z" })).toEqual({
      kind: "instant",
      instant: "2026-01-01T00:00:00Z",
    });
    expect(toTemporalFilter({ start: "2026-01-01T00:00:00Z", end: null, field: "TS" })).toEqual({
      kind: "interval",
      start: "2026-01-01T00:00:00Z",
      end: null,
      field: "TS",
    });
    expect(() => toTemporalFilter({})).toThrow(/requires `instant`/);
    expect(() => toTemporalFilter({ instant: "2026-01-01T00:00:00Z", start: null })).toThrow(/not both/);
  });

  it("validates the wire schema, rejecting malformed nodes", () => {
    expect(() => filterSchema.parse({ op: "eq", field: "A", value: 1 })).not.toThrow();
    expect(() => filterSchema.parse({ op: "eq", field: "", value: 1 })).toThrow();
    expect(() => filterSchema.parse({ op: "and", args: [] })).toThrow();
    expect(() => filterSchema.parse({ op: "unknown" })).toThrow();
  });
});
