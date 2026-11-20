import { describe, expect, it, vi } from "vitest";

import { HonuaClient } from "../src/core/client.js";
import { HonuaHttpError } from "../src/core/errors.js";
import { geoJsonToGeoServices, geoServicesGeometryToGeoJSON } from "../src/core/geoservices-geojson.js";
import { spatialIntersects } from "../src/core/spatial-filter.js";

describe("SDK review fixes — GeoServices to GeoJSON Z/M coordinates", () => {
  it("does not place M into GeoJSON Z slot when hasM is true and hasZ is false", () => {
    expect(
      geoServicesGeometryToGeoJSON({
        hasM: true,
        hasZ: false,
        paths: [
          [
            [0, 0, 100],
            [1, 1, 200],
          ],
        ],
      }),
    ).toEqual({
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    });
    expect(
      geoServicesGeometryToGeoJSON({
        hasM: true,
        points: [
          [10, 20, 50],
          [30, 40, 60],
        ],
      }),
    ).toEqual({
      type: "MultiPoint",
      coordinates: [
        [10, 20],
        [30, 40],
      ],
    });
  });
});

describe("SDK review fixes — sparse ZM coordinates", () => {
  it("does not emit invalid [x, y, null, m] for sparse ZM points or vertices", () => {
    expect(geoServicesGeometryToGeoJSON({ x: 1, y: 2, z: null, m: 42 } as Record<string, unknown>)).toEqual({
      type: "Point",
      coordinates: [1, 2],
    });
    expect(
      geoServicesGeometryToGeoJSON({
        hasZ: true,
        hasM: true,
        paths: [
          [
            [0, 0, 15, 100],
            [1, 1, null, 200],
          ],
        ],
      } as Record<string, unknown>),
    ).toEqual({
      type: "LineString",
      coordinates: [
        [0, 0, 15],
        [1, 1],
      ],
    });
  });
});

describe("SDK review fixes — GeoJSON to GeoServices 3D/4D dimension flags", () => {
  it("sets hasZ and hasM on MultiPoint, LineString, and MultiLineString", () => {
    expect(
      geoJsonToGeoServices({
        type: "MultiPoint",
        coordinates: [
          [0, 0, 10],
          [1, 1, 20],
        ],
      }),
    ).toEqual({
      points: [
        [0, 0, 10],
        [1, 1, 20],
      ],
      hasZ: true,
    });
    expect(
      geoJsonToGeoServices({
        type: "LineString",
        coordinates: [
          [0, 0, 10],
          [1, 1, 20],
        ],
      }),
    ).toEqual({
      paths: [
        [
          [0, 0, 10],
          [1, 1, 20],
        ],
      ],
      hasZ: true,
    });
    expect(
      geoJsonToGeoServices({
        type: "MultiLineString",
        coordinates: [
          [
            [0, 0, 10, 1],
            [1, 1, 20, 2],
          ],
        ],
      }),
    ).toEqual({
      paths: [
        [
          [0, 0, 10, 1],
          [1, 1, 20, 2],
        ],
      ],
      hasZ: true,
      hasM: true,
    });
  });
});

describe("SDK review fixes — Polygon 3D/4D dimension flags & antimeridian envelopes", () => {
  it("sets hasZ and hasM on Polygon and MultiPolygon", () => {
    const poly3d = geoJsonToGeoServices({
      type: "Polygon",
      coordinates: [
        [
          [0, 0, 5],
          [1, 0, 5],
          [1, 1, 5],
          [0, 1, 5],
          [0, 0, 5],
        ],
      ],
    });
    expect(poly3d).toMatchObject({ hasZ: true });
    expect(poly3d).not.toHaveProperty("hasM");
    const multiPoly4d = geoJsonToGeoServices({
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0, 5, 1],
            [1, 0, 5, 2],
            [1, 1, 5, 3],
            [0, 1, 5, 4],
            [0, 0, 5, 1],
          ],
        ],
      ],
    });
    expect(multiPoly4d).toMatchObject({ hasZ: true, hasM: true });
  });

  it("allows antimeridian-crossing geographic envelopes while still rejecting invalid bounds", () => {
    expect(spatialIntersects({ xmin: 170, ymin: -20, xmax: -170, ymax: 20 }).geometryType).toBe("esriGeometryEnvelope");
    expect(
      spatialIntersects({ xmin: 175, ymin: -15, xmax: -175, ymax: 15, spatialReference: { wkid: 4326 } }).geometryType,
    ).toBe("esriGeometryEnvelope");
    expect(() => spatialIntersects({ xmin: 170, ymin: 20, xmax: -170, ymax: -20 })).toThrow();
    expect(() => spatialIntersects({ xmin: 190, ymin: -20, xmax: -170, ymax: 20 })).toThrow();
    expect(() =>
      spatialIntersects({ xmin: 170, ymin: -20, xmax: -170, ymax: 20, spatialReference: { wkid: 3857 } }),
    ).toThrow();
  });
});

describe("SDK review fixes — gRPC-web queryFeaturesAll maxRecords", () => {
  it("enforces maxRecords on grpc-web in queryFeaturesAll", async () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "grpc-web",
      fetchFn: async () => new Response("{}", { status: 200 }),
    });
    const allRows = [1, 2, 3, 4, 5].map((id) => ({ attributes: { OBJECTID: id } }));
    vi.spyOn(client, "queryFeatures").mockImplementation(async (request) => {
      const offset = request.resultOffset ?? 0;
      const count = request.resultRecordCount ?? 2;
      return { objectIdFieldName: "OBJECTID", features: allRows.slice(offset, offset + count) };
    });
    const features = await client.featureLayer("Parcels", 0).queryFeaturesAll({ pageSize: 2, maxRecords: 3 });
    expect(features.map((f) => f.attributes.OBJECTID)).toEqual([1, 2, 3]);
  });
});

describe("SDK review fixes — OData relative baseUrl pagination", () => {
  it("handles empty and relative baseUrl when following OData @odata.nextLink", async () => {
    for (const baseUrl of ["", "/honua"]) {
      const seenUrls: string[] = [];
      const client = new HonuaClient({
        baseUrl,
        fetchFn: async (input) => {
          seenUrls.push(String(input));
          if (seenUrls.length === 1) {
            return Response.json({ value: [{ id: 1 }], "@odata.nextLink": `${baseUrl}/odata/Parcels?$skiptoken=p2` });
          }
          return Response.json({ value: [{ id: 2 }] });
        },
      });
      const page = await client.odata("Parcels").queryAll();
      expect(page.rows).toEqual([{ id: 1 }, { id: 2 }]);
      expect(seenUrls).toEqual([`${baseUrl}/odata/Parcels`, `${baseUrl}/odata/Parcels?%24skiptoken=p2`]);
    }
  });
});

const WFS_CAPABILITIES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:WFS_Capabilities version="2.0.0" xmlns:wfs="http://www.opengis.net/wfs/2.0"
  xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink">
  <ows:OperationsMetadata>
    <ows:Operation name="GetFeature">
      <ows:DCP><ows:HTTP><ows:Get xlink:href="/wfs"/><ows:Post xlink:href="/wfs"/></ows:HTTP></ows:DCP>
      <ows:Parameter name="outputFormat">
        <ows:AllowedValues><ows:Value>application/geo+json</ows:Value></ows:AllowedValues>
      </ows:Parameter>
    </ows:Operation>
  </ows:OperationsMetadata>
  <wfs:FeatureTypeList><wfs:FeatureType><wfs:Name>parcels:lot</wfs:Name></wfs:FeatureType></wfs:FeatureTypeList>
</wfs:WFS_Capabilities>`;

describe("SDK review fixes — WFS relative baseUrl & error interceptors", () => {
  it("handles empty and relative baseUrl when canonicalizing WFS capabilities URLs", async () => {
    for (const baseUrl of ["", "/honua"]) {
      const seenUrls: string[] = [];
      const client = new HonuaClient({
        baseUrl,
        fetchFn: async (input) => {
          const url = String(input);
          seenUrls.push(url);
          if (url.includes("request=GetCapabilities")) {
            return new Response(WFS_CAPABILITIES_XML, { status: 200, headers: { "Content-Type": "application/xml" } });
          }
          return Response.json({ type: "FeatureCollection", features: [] });
        },
      });
      const wfs = client.wfs("/wfs");
      const caps = await wfs.capabilities();
      expect(caps.operations.get("GetFeature")?.getUrl).toBe("/wfs");
      const result = await wfs.featureType("parcels:lot").getFeature({});
      expect(result.kind).toBe("json");
      expect(seenUrls[0]).toBe(`${baseUrl}/wfs?service=WFS&version=2.0.0&request=GetCapabilities`);
      expect(seenUrls[1]).toContain(`${baseUrl}/wfs?service=WFS&version=2.0.0&request=GetFeature`);
    }
  });

  it("invokes error interceptors exactly once on HTTP-200 GeoServices error envelopes", async () => {
    for (const mode of ["json", "metadata", "preferBinary"] as const) {
      const errorSpy = vi.fn();
      const client = new HonuaClient({
        baseUrl: "https://example.test",
        preferBinary: mode === "preferBinary",
        interceptors: [{ error: errorSpy }],
        fetchFn: async () =>
          new Response(JSON.stringify({ error: { code: 499, message: "Token Required" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      });
      const call =
        mode === "metadata"
          ? client.getLayerMetadata("svc", 0)
          : client.queryFeatures({ serviceId: "svc", layerId: 0, where: "1=1" });
      await expect(call).rejects.toThrow(HonuaHttpError);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    }
  });
});
