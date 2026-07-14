import { describe, expect, it } from "vitest";

import { QueryBuilder, bufferEnvelope as bufferEnvelopeHonua } from "@honua/sdk-js/honua";
import type { QueryFeaturesRequest } from "@honua/sdk-js/honua";
import { buffer as geometryBuffer } from "../src/geometry/index.js";
import * as rootSurface from "../src/index.js";
import {
  HonuaGeometryError,
  bufferEnvelope,
  envelope,
  isHonuaError,
  point,
  polygon,
  spatialContains,
  spatialIntersects,
  spatialWithin,
} from "../src/index.js";
import type { SpatialFilter } from "../src/index.js";

describe("SpatialFilter builders", () => {
  it("keeps envelope expansion distinct from the true geometry buffer surface", () => {
    expect(rootSurface).not.toHaveProperty("buffer");
    expect(rootSurface.bufferEnvelope).toBe(bufferEnvelope);
    expect(bufferEnvelopeHonua).toBe(bufferEnvelope);
    expect(geometryBuffer).toBeTypeOf("function");
  });

  describe("envelope", () => {
    it("produces correct geometry JSON", () => {
      const f = envelope(-118.5, 33.7, -117.5, 34.2);
      expect(f.geometry).toEqual({ xmin: -118.5, ymin: 33.7, xmax: -117.5, ymax: 34.2 });
      expect(f.geometryType).toBe("esriGeometryEnvelope");
      expect(f.spatialRel).toBe("esriSpatialRelIntersects");
    });

    it("includes spatialReference when provided", () => {
      const f = envelope(0, 0, 100, 100, { wkid: 4326 });
      expect(f.geometry).toEqual({
        xmin: 0,
        ymin: 0,
        xmax: 100,
        ymax: 100,
        spatialReference: { wkid: 4326 },
      });
    });

    it("omits spatialReference when not provided", () => {
      const f = envelope(0, 0, 1, 1);
      expect(f.geometry).not.toHaveProperty("spatialReference");
    });
  });

  describe("point", () => {
    it("produces correct geometry JSON", () => {
      const f = point(-118.24, 34.05);
      expect(f.geometry).toEqual({ x: -118.24, y: 34.05 });
      expect(f.geometryType).toBe("esriGeometryPoint");
      expect(f.spatialRel).toBe("esriSpatialRelIntersects");
    });

    it("includes spatialReference when provided", () => {
      const f = point(10, 20, { wkid: 3857 });
      expect(f.geometry).toEqual({ x: 10, y: 20, spatialReference: { wkid: 3857 } });
    });

    it("omits spatialReference when not provided", () => {
      const f = point(10, 20);
      expect(f.geometry).not.toHaveProperty("spatialReference");
    });
  });

  describe("polygon", () => {
    it("produces correct geometry JSON", () => {
      const rings = [
        [
          [-118, 34],
          [-117, 34],
          [-117, 35],
          [-118, 35],
          [-118, 34],
        ],
      ];
      const f = polygon(rings);
      expect(f.geometry).toEqual({ rings });
      expect(f.geometryType).toBe("esriGeometryPolygon");
      expect(f.spatialRel).toBe("esriSpatialRelIntersects");
    });

    it("includes spatialReference when provided", () => {
      const rings = [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ];
      const f = polygon(rings, { wkid: 4326 });
      expect(f.geometry).toEqual({ rings, spatialReference: { wkid: 4326 } });
    });

    it("omits spatialReference when not provided", () => {
      const rings = [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ];
      const f = polygon(rings);
      expect(f.geometry).not.toHaveProperty("spatialReference");
    });
  });

  describe("bufferEnvelope", () => {
    it("creates correct envelope bounds centered on the point", () => {
      const f = bufferEnvelope(10, 20, 5);
      expect(f.geometry).toEqual({ xmin: 5, ymin: 15, xmax: 15, ymax: 25 });
      expect(f.geometryType).toBe("esriGeometryEnvelope");
      expect(f.spatialRel).toBe("esriSpatialRelIntersects");
    });

    it("handles fractional coordinates and distance", () => {
      const f = bufferEnvelope(-118.24, 34.05, 0.5);
      expect(f.geometry).toEqual({
        xmin: -118.74,
        ymin: 33.55,
        xmax: -117.74,
        ymax: 34.55,
      });
    });

    it("handles zero distance (degenerates to a point-sized envelope)", () => {
      const f = bufferEnvelope(5, 10, 0);
      expect(f.geometry).toEqual({ xmin: 5, ymin: 10, xmax: 5, ymax: 10 });
    });

    it("passes through spatialReference", () => {
      const f = bufferEnvelope(0, 0, 1, { wkid: 3857 });
      expect(f.geometry).toEqual({
        xmin: -1,
        ymin: -1,
        xmax: 1,
        ymax: 1,
        spatialReference: { wkid: 3857 },
      });
    });

    it.each([
      [Number.NaN, 0, 1],
      [0, Number.POSITIVE_INFINITY, 1],
      [0, 0, -1],
    ])("rejects invalid planar expansion inputs (%s, %s, %s)", (x, y, distance) => {
      expect(() => bufferEnvelope(x, y, distance)).toThrowError(HonuaGeometryError);
      try {
        bufferEnvelope(x, y, distance);
      } catch (error) {
        expect(error).toMatchObject({
          name: "HonuaGeometryError",
          code: "malformed-geometry",
          detail: { operation: "buffer-envelope", reason: "invalid-coordinate-or-distance" },
        });
        expect(isHonuaError(error)).toBe(true);
      }
    });

    it("rejects finite inputs whose computed bounds overflow", () => {
      expect(() => bufferEnvelope(Number.MAX_VALUE, 0, Number.MAX_VALUE)).toThrowError(HonuaGeometryError);
      try {
        bufferEnvelope(Number.MAX_VALUE, 0, Number.MAX_VALUE);
      } catch (error) {
        expect(error).toMatchObject({
          name: "HonuaGeometryError",
          code: "malformed-geometry",
          detail: { operation: "buffer-envelope", reason: "computed-bounds-not-finite" },
        });
      }
    });

    it("preserves an explicit cause and participates in the SDK error guard", () => {
      const cause = new Error("bad coordinate source");
      const error = new HonuaGeometryError(
        "malformed-geometry",
        "invalid test geometry",
        { operation: "classify" },
        { cause },
      );

      expect(error.cause).toBe(cause);
      expect(isHonuaError(error)).toBe(true);
    });
  });

  describe("spatialIntersects", () => {
    it("sets spatialRel to esriSpatialRelIntersects", () => {
      const f = spatialIntersects({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 });
      expect(f.spatialRel).toBe("esriSpatialRelIntersects");
    });

    it("detects envelope geometry type", () => {
      const f = spatialIntersects({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 });
      expect(f.geometryType).toBe("esriGeometryEnvelope");
    });

    it("detects point geometry type", () => {
      const f = spatialIntersects({ x: 10, y: 20 });
      expect(f.geometryType).toBe("esriGeometryPoint");
    });

    it("detects polygon geometry type", () => {
      const f = spatialIntersects({
        rings: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      });
      expect(f.geometryType).toBe("esriGeometryPolygon");
    });

    it("detects polyline geometry type", () => {
      const f = spatialIntersects({
        paths: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      });
      expect(f.geometryType).toBe("esriGeometryPolyline");
    });

    it("detects multipoint geometry type", () => {
      const f = spatialIntersects({
        points: [
          [0, 0],
          [1, 1],
        ],
      });
      expect(f.geometryType).toBe("esriGeometryMultipoint");
    });

    it("ignores empty ArcGIS multipoint slots while validating non-empty positions", () => {
      const geometry = { points: [[], [0, 0], [], [1, 1]] };
      const filter = spatialIntersects(geometry);

      expect(filter.geometryType).toBe("esriGeometryMultipoint");
      expect(filter.geometry).toBe(geometry);
    });

    it.each([
      [{ x: null }, "esriGeometryPoint"],
      [{ points: [] }, "esriGeometryMultipoint"],
      [{ paths: [] }, "esriGeometryPolyline"],
      [{ rings: [] }, "esriGeometryPolygon"],
      [{ xmin: null }, "esriGeometryEnvelope"],
    ] as const)("classifies an explicitly empty %j", (geometry, expected) => {
      expect(spatialIntersects(geometry).geometryType).toBe(expected);
    });

    it.each([
      [
        {
          points: [
            [0, 0],
            [1, 1, null],
          ],
          hasM: true,
        },
        "esriGeometryMultipoint",
      ],
      [
        {
          paths: [
            [
              [0, 0, 10],
              [1, 1, 11],
            ],
          ],
          hasZ: true,
        },
        "esriGeometryPolyline",
      ],
      [
        {
          rings: [
            [
              [0, 0, 1, null],
              [1, 0, 1, 2],
              [1, 1, 1, null],
              [0, 0, 2, 9],
            ],
          ],
          hasZ: true,
          hasM: true,
        },
        "esriGeometryPolygon",
      ],
      [{ x: 1, y: 2, z: 3, m: null, id: 4 }, "esriGeometryPoint"],
      [
        {
          xmin: 0,
          ymin: 1,
          xmax: 10,
          ymax: 11,
          zmin: -2,
          zmax: 2,
          mmin: 3,
          mmax: 4,
          idmin: 5,
          idmax: 6,
        },
        "esriGeometryEnvelope",
      ],
    ] as const)("honors valid Esri dimensional metadata for %j", (geometry, expected) => {
      expect(spatialIntersects(geometry).geometryType).toBe(expected);
    });

    it.each([{}, { type: "Point", coordinates: [0, 0] }, { coordinates: [0, 0] }])(
      "fails closed for unknown geometry %j",
      (geometry) => {
        expect(() => spatialIntersects(geometry)).toThrowError(HonuaGeometryError);
        try {
          spatialIntersects(geometry);
        } catch (error) {
          expect(error).toMatchObject({
            name: "HonuaGeometryError",
            code: "unknown-geometry",
            detail: { operation: "classify" },
          });
          expect(isHonuaError(error)).toBe(true);
        }
      },
    );

    it.each([
      { x: 1 },
      { x: 1, y: Number.NaN },
      { xmin: 0, ymin: 0, xmax: 1 },
      { xmin: 2, ymin: 0, xmax: 1, ymax: 1 },
      { x: null, y: 0 },
      { xmin: null, ymin: 0 },
      { points: [[0]] },
      { points: [[0, 0, 1]] },
      { points: [[0, 0]], hasZ: true },
      { points: [[0, 0, null]], hasZ: true },
      { points: [[0, 0, 1, 2, 3]], hasZ: true, hasM: true },
      { points: [[0, 0, Number.POSITIVE_INFINITY]], hasM: true },
      { points: [], hasZ: "true" },
      { rings: [], hasM: 1 },
      { paths: [[[0, 0]]] },
      { paths: [[]] },
      {
        paths: [
          [],
          [
            [0, 0],
            [1, 1],
          ],
        ],
      },
      { rings: [[]] },
      {
        rings: [
          [],
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      {
        rings: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        ],
      },
      { x: 0, y: 0, z: Number.POSITIVE_INFINITY },
      { x: 0, y: 0, m: Number.NaN },
      { x: 0, y: 0, id: Number.POSITIVE_INFINITY },
      { xmin: 0, ymin: 0, xmax: 1, ymax: 1, zmin: 0 },
      { xmin: 0, ymin: 0, xmax: 1, ymax: 1, zmin: 0, zmax: Number.POSITIVE_INFINITY },
      { xmin: 0, ymin: 0, xmax: 1, ymax: 1, mmin: 0, mmax: Number.NaN },
      { xmin: 0, ymin: 0, xmax: 1, ymax: 1, idmin: Number.NEGATIVE_INFINITY, idmax: 2 },
      { rings: [], x: 0, y: 0 },
    ])("fails closed for malformed geometry %j", (geometry) => {
      expect(() => spatialIntersects(geometry)).toThrowError(HonuaGeometryError);
      try {
        spatialIntersects(geometry);
      } catch (error) {
        expect(error).toMatchObject({
          name: "HonuaGeometryError",
          code: "malformed-geometry",
          detail: { operation: "classify" },
        });
        expect(isHonuaError(error)).toBe(true);
      }
    });

    it.each([null, undefined, [], 42, "point"])("wraps non-object JS input %j in HonuaGeometryError", (geometry) => {
      const classify = () => spatialIntersects(geometry as unknown as Record<string, unknown>);
      expect(classify).toThrowError(HonuaGeometryError);
      try {
        classify();
      } catch (error) {
        expect(error).toMatchObject({
          name: "HonuaGeometryError",
          code: "malformed-geometry",
          detail: { operation: "classify", reason: "geometry-must-be-object", keys: [] },
        });
        expect(isHonuaError(error)).toBe(true);
      }
    });

    it("preserves the original geometry object", () => {
      const geom = { xmin: -1, ymin: -1, xmax: 1, ymax: 1 };
      const f = spatialIntersects(geom);
      expect(f.geometry).toBe(geom);
    });
  });

  describe("spatialContains", () => {
    it("sets spatialRel to esriSpatialRelContains", () => {
      const f = spatialContains({
        rings: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      });
      expect(f.spatialRel).toBe("esriSpatialRelContains");
    });

    it("detects geometry type from shape", () => {
      const f = spatialContains({
        rings: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      });
      expect(f.geometryType).toBe("esriGeometryPolygon");
    });
  });

  describe("spatialWithin", () => {
    it("sets spatialRel to esriSpatialRelWithin", () => {
      const f = spatialWithin({ xmin: 0, ymin: 0, xmax: 10, ymax: 10 });
      expect(f.spatialRel).toBe("esriSpatialRelWithin");
    });

    it("detects geometry type from shape", () => {
      const f = spatialWithin({ xmin: 0, ymin: 0, xmax: 10, ymax: 10 });
      expect(f.geometryType).toBe("esriGeometryEnvelope");
    });
  });

  describe("spread into QueryFeaturesRequest", () => {
    it("spreads envelope filter into a request", () => {
      const req: QueryFeaturesRequest = {
        serviceId: "cities",
        layerId: 0,
        where: "POP > 1000",
        ...envelope(-118.5, 33.7, -117.5, 34.2),
      };
      expect(req.geometry).toEqual({ xmin: -118.5, ymin: 33.7, xmax: -117.5, ymax: 34.2 });
      expect(req.geometryType).toBe("esriGeometryEnvelope");
      expect(req.spatialRel).toBe("esriSpatialRelIntersects");
      expect(req.serviceId).toBe("cities");
      expect(req.where).toBe("POP > 1000");
    });

    it("spreads point filter into a request", () => {
      const req: QueryFeaturesRequest = {
        serviceId: "svc",
        layerId: 1,
        ...point(10, 20),
      };
      expect(req.geometry).toEqual({ x: 10, y: 20 });
      expect(req.geometryType).toBe("esriGeometryPoint");
    });

    it("spreads buffer filter into a request", () => {
      const req: QueryFeaturesRequest = {
        serviceId: "svc",
        layerId: 0,
        ...bufferEnvelope(0, 0, 5),
      };
      expect(req.geometry).toEqual({ xmin: -5, ymin: -5, xmax: 5, ymax: 5 });
      expect(req.geometryType).toBe("esriGeometryEnvelope");
    });

    it("spreads spatial relationship wrapper into a request", () => {
      const req: QueryFeaturesRequest = {
        serviceId: "svc",
        layerId: 0,
        ...spatialContains({
          rings: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
              [0, 0],
            ],
          ],
        }),
      };
      expect(req.spatialRel).toBe("esriSpatialRelContains");
      expect(req.geometryType).toBe("esriGeometryPolygon");
    });
  });

  describe("integration with QueryBuilder", () => {
    it("works with QueryBuilder.from().geometry() and related methods", () => {
      const f = envelope(-118.5, 33.7, -117.5, 34.2);
      const req = QueryBuilder.from("cities", 0)
        .where("POP > 1000")
        .geometry(f.geometry)
        .geometryType(f.geometryType)
        .spatialRel(f.spatialRel!)
        .build();

      expect(req.geometry).toEqual({ xmin: -118.5, ymin: 33.7, xmax: -117.5, ymax: 34.2 });
      expect(req.geometryType).toBe("esriGeometryEnvelope");
      expect(req.spatialRel).toBe("esriSpatialRelIntersects");
      expect(req.where).toBe("POP > 1000");
    });

    it("works with point filter and QueryBuilder", () => {
      const f = point(-118.24, 34.05, { wkid: 4326 });
      const req = QueryBuilder.from("svc", 0)
        .geometry(f.geometry)
        .geometryType(f.geometryType)
        .spatialRel(f.spatialRel!)
        .build();

      expect(req.geometry).toEqual({ x: -118.24, y: 34.05, spatialReference: { wkid: 4326 } });
      expect(req.geometryType).toBe("esriGeometryPoint");
    });

    it("works with spatialWithin wrapper and QueryBuilder", () => {
      const f = spatialWithin({ xmin: 0, ymin: 0, xmax: 100, ymax: 100 });
      const req = QueryBuilder.from("svc", 0)
        .geometry(f.geometry)
        .geometryType(f.geometryType)
        .spatialRel(f.spatialRel!)
        .build();

      expect(req.spatialRel).toBe("esriSpatialRelWithin");
      expect(req.geometryType).toBe("esriGeometryEnvelope");
    });
  });

  describe("SpatialFilter type compatibility", () => {
    it("conforms to the SpatialFilter interface", () => {
      // This is a compile-time check; if it compiles, the type is correct.
      const f: SpatialFilter = envelope(0, 0, 1, 1);
      expect(f.geometry).toBeDefined();
      expect(f.geometryType).toBeDefined();
    });

    it("all builders return SpatialFilter-compatible objects", () => {
      const filters: SpatialFilter[] = [
        envelope(0, 0, 1, 1),
        point(0, 0),
        polygon([
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ]),
        bufferEnvelope(0, 0, 1),
        spatialIntersects({ x: 0, y: 0 }),
        spatialContains({
          rings: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        }),
        spatialWithin({ xmin: 0, ymin: 0, xmax: 1, ymax: 1 }),
      ];
      expect(filters).toHaveLength(7);
      for (const f of filters) {
        expect(f.geometry).toBeDefined();
        expect(f.geometryType).toBeDefined();
      }
    });
  });
});
