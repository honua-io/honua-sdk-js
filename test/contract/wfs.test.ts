/**
 * WFS 2.0 adapter tests. Covers the wire-level surface (GetCapabilities
 * caching + content negotiation, GetFeature paging, FES emission for
 * `Query.where` / `Query.spatialFilter`, Transaction round-trip), the
 * canonical surface integration (`wfsSource` Source contract), the
 * stored-query escape hatch, and the XXE defense.
 */

import { describe, expect, it } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES, type SourceDescriptor, createDataset } from "../../src/contract/index.js";
import { HonuaCapabilityNotSupportedError, HonuaWfsExceptionError } from "../../src/core/errors.js";
import { parseWfsCapabilities } from "../../src/core/wfs-capabilities.js";
import { UNSUPPORTED_FES, compileSpatialFilter, compileWhere, serializeFes } from "../../src/core/wfs-filter.js";
import { HonuaWfs, HonuaWfsFeatureType } from "../../src/core/wfs.js";

import {
  PARCEL_FEATURES,
  type ParcelAttrs,
  makeMockClient,
  wfsCapabilitiesXml,
  wfsExceptionXml,
  wfsGeoJsonResponse,
  wfsListStoredQueriesXml,
  wfsTransactionResponseXml,
  xmlResponse,
} from "./shared.js";

const WFS_LOCATOR = {
  url: "https://mock.honua.test/wfs",
  typeName: "parcels:lot",
  featureNamespace: "http://parcels.example.test/ns",
};

function buildWfsDataset(
  routes: Array<[string | RegExp, (url: URL, init?: RequestInit) => Response | Promise<Response>]>,
  locator: { url: string; typeName: string; featureNamespace?: string } = WFS_LOCATOR,
) {
  const client = makeMockClient({ routes });
  return createDataset({
    id: "parcels",
    client,
    skipCompatibilityCheck: true,
    sources: [
      {
        id: "parcels-wfs",
        protocol: "wfs",
        locator,
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
      } satisfies SourceDescriptor,
    ],
  });
}

describe("wfs / capabilities", () => {
  it("parses operations, output formats, and feature-type bbox", () => {
    const snapshot = parseWfsCapabilities(wfsCapabilitiesXml());
    expect(snapshot.version).toBe("2.0.0");
    expect(snapshot.operations.has("GetFeature")).toBe(true);
    const formats = snapshot.outputFormatsByOp.get("GetFeature") ?? [];
    expect(formats).toContain("application/geo+json");
    expect(snapshot.featureTypes[0].name).toBe("parcels:lot");
    expect(snapshot.featureTypes[0].wgs84BoundingBox).toEqual({
      xmin: -123,
      ymin: 37,
      xmax: -120,
      ymax: 45,
    });
  });

  it("rejects DOCTYPE / ENTITY declarations to defend against XXE", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE root [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]><wfs:WFS_Capabilities xmlns:wfs="http://www.opengis.net/wfs/2.0"><wfs:Name>&xxe;</wfs:Name></wfs:WFS_Capabilities>`;
    expect(() => parseWfsCapabilities(xxe)).toThrow(/DOCTYPE|ENTITY/);
  });

  it("treats an ExceptionReport at the GetCapabilities root as a typed error", () => {
    expect(() => parseWfsCapabilities(wfsExceptionXml("InvalidParameterValue", "service"))).toThrow(
      HonuaWfsExceptionError,
    );
  });

  it("caches the snapshot and exposes a refresh hook", async () => {
    let hits = 0;
    const client = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            hits += 1;
            const request = url.searchParams.get("request");
            if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
            return new Response("not implemented", { status: 404 });
          },
        ],
      ],
    });
    const wfs = new HonuaWfs({ client, endpointUrl: WFS_LOCATOR.url });
    await wfs.capabilities();
    await wfs.capabilities();
    expect(hits).toBe(1);
    expect(wfs.capabilitiesFetches).toBe(1);
    wfs.refresh();
    await wfs.capabilities();
    expect(hits).toBe(2);
  });
});

describe("wfs / FES emission", () => {
  it("emits a deterministic <fes:And> for STATE = 'CA' AND ACRES > 10", () => {
    const compiled = compileWhere("STATE = 'CA' AND ACRES > 10");
    expect(compiled).not.toBe(UNSUPPORTED_FES);
    const xml = serializeFes(compiled === UNSUPPORTED_FES ? [] : [compiled], { typeName: "parcels:lot" });
    expect(xml).toContain("<fes:And>");
    expect(xml).toContain("<fes:PropertyIsEqualTo>");
    expect(xml).toContain("<fes:Literal>CA</fes:Literal>");
    expect(xml).toContain("<fes:PropertyIsGreaterThan>");
    expect(xml).toContain("<fes:Literal>10</fes:Literal>");
  });

  it("supports IN / BETWEEN / IS NULL / LIKE / NOT", () => {
    const compiled = compileWhere(
      "STATE IN ('CA', 'OR') AND ACRES BETWEEN 5 AND 25 AND OWNER IS NOT NULL AND NAME LIKE 'Lot%'",
    );
    expect(compiled).not.toBe(UNSUPPORTED_FES);
    if (compiled === UNSUPPORTED_FES) return;
    const xml = serializeFes([compiled], { typeName: "parcels:lot" });
    expect(xml).toContain("<fes:PropertyIsBetween>");
    expect(xml).toContain("<fes:PropertyIsLike");
    expect(xml).toContain("<fes:PropertyIsNull>");
    expect(xml).toContain("<fes:Or>");
  });

  it("returns UNSUPPORTED_FES for unsupported expressions", () => {
    expect(compileWhere("LENGTH(NAME) > 5")).toBe(UNSUPPORTED_FES);
    expect(compileWhere("STATE IN (SELECT id FROM x)")).toBe(UNSUPPORTED_FES);
  });

  it("translates an envelope spatialFilter to <fes:BBOX>", () => {
    const compiled = compileSpatialFilter(
      {
        geometry: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
      },
      { geometryProperty: "the_geom", srsName: "urn:ogc:def:crs:EPSG::4326" },
    );
    expect(compiled).not.toBe(UNSUPPORTED_FES);
    if (compiled === UNSUPPORTED_FES) return;
    const xml = serializeFes([compiled]);
    expect(xml).toContain("<fes:BBOX>");
    expect(xml).toContain("<gml:Envelope");
    expect(xml).toContain("urn:ogc:def:crs:EPSG::4326");
  });

  it("emits lat,lon corners for a URN-form geographic CRS (GML 3.2 axis order)", () => {
    const compiled = compileSpatialFilter(
      {
        geometry: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
      },
      { geometryProperty: "the_geom", srsName: "urn:ogc:def:crs:EPSG::4326" },
    );
    expect(compiled).not.toBe(UNSUPPORTED_FES);
    if (compiled === UNSUPPORTED_FES) return;
    const xml = serializeFes([compiled]);
    // EPSG:4326 in URN form is latitude,longitude on conformant WFS 2.0 servers.
    expect(xml).toContain("<gml:lowerCorner>37 -123</gml:lowerCorner>");
    expect(xml).toContain("<gml:upperCorner>45 -120</gml:upperCorner>");
  });

  it("keeps lon,lat corners for the legacy short EPSG form and CRS84", () => {
    const short = compileSpatialFilter(
      {
        geometry: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
      },
      { geometryProperty: "the_geom", srsName: "EPSG:4326" },
    );
    expect(short).not.toBe(UNSUPPORTED_FES);
    if (short === UNSUPPORTED_FES) return;
    expect(serializeFes([short])).toContain("<gml:lowerCorner>-123 37</gml:lowerCorner>");

    const crs84 = compileSpatialFilter(
      {
        geometry: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
      },
      { geometryProperty: "the_geom", srsName: "urn:ogc:def:crs:OGC:1.3:CRS84" },
    );
    expect(crs84).not.toBe(UNSUPPORTED_FES);
    if (crs84 === UNSUPPORTED_FES) return;
    expect(serializeFes([crs84])).toContain("<gml:lowerCorner>-123 37</gml:lowerCorner>");
  });

  it("emits lat,lon for a URN-form geographic CRS in a <fes:Within> polygon", () => {
    const compiled = compileSpatialFilter(
      {
        geometry: {
          rings: [
            [
              [-123, 37],
              [-120, 37],
              [-120, 45],
              [-123, 45],
              [-123, 37],
            ],
          ],
        },
        geometryType: "esriGeometryPolygon",
        spatialRel: "esriSpatialRelWithin",
      },
      { geometryProperty: "the_geom", srsName: "urn:ogc:def:crs:EPSG::4326" },
    );
    expect(compiled).not.toBe(UNSUPPORTED_FES);
    if (compiled === UNSUPPORTED_FES) return;
    const xml = serializeFes([compiled]);
    expect(xml).toContain("<gml:posList>37 -123 37 -120 45 -120 45 -123 37 -123</gml:posList>");
  });

  it("keeps projected CRS axis order as easting,northing (x,y)", () => {
    const compiled = compileSpatialFilter(
      {
        geometry: { xmin: 100, ymin: 200, xmax: 300, ymax: 400 },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
      },
      { geometryProperty: "the_geom", srsName: "urn:ogc:def:crs:EPSG::3857" },
    );
    expect(compiled).not.toBe(UNSUPPORTED_FES);
    if (compiled === UNSUPPORTED_FES) return;
    expect(serializeFes([compiled])).toContain("<gml:lowerCorner>100 200</gml:lowerCorner>");
  });

  it("translates a polygon + within into <fes:Within>", () => {
    const compiled = compileSpatialFilter(
      {
        geometry: {
          rings: [
            [
              [-123, 37],
              [-120, 37],
              [-120, 45],
              [-123, 45],
              [-123, 37],
            ],
          ],
        },
        geometryType: "esriGeometryPolygon",
        spatialRel: "esriSpatialRelWithin",
      },
      { geometryProperty: "the_geom" },
    );
    expect(compiled).not.toBe(UNSUPPORTED_FES);
    if (compiled === UNSUPPORTED_FES) return;
    const xml = serializeFes([compiled]);
    expect(xml).toContain("<fes:Within>");
    expect(xml).toContain("<gml:Polygon");
  });

  it("envelope + contains lowers to a polygon under <fes:Contains> (not bbox semantics)", () => {
    const compiled = compileSpatialFilter(
      {
        geometry: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelContains",
      },
      { geometryProperty: "the_geom" },
    );
    expect(compiled).not.toBe(UNSUPPORTED_FES);
    if (compiled === UNSUPPORTED_FES) return;
    const xml = serializeFes([compiled]);
    expect(xml).toContain("<fes:Contains>");
    expect(xml).toContain("<gml:Polygon");
    expect(xml).not.toContain("<fes:BBOX>");
  });

  it("envelope + intersects keeps the bbox shortcut", () => {
    const compiled = compileSpatialFilter(
      {
        geometry: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
      },
      { geometryProperty: "the_geom" },
    );
    expect(compiled).not.toBe(UNSUPPORTED_FES);
    if (compiled === UNSUPPORTED_FES) return;
    expect(compiled.kind).toBe("bbox");
  });
});

describe("wfs / canonical Source", () => {
  it("query() routes through GetCapabilities + GetFeature(GeoJSON) and returns canonical features", async () => {
    let getFeatureUrl: URL | undefined;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            getFeatureUrl = url;
            return new Response(JSON.stringify(wfsGeoJsonResponse()), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const result = await source.query({ where: "STATE = 'CA'" });
    expect(result.features).toHaveLength(PARCEL_FEATURES.length);
    expect(result.features[0].attributes.OBJECTID).toBe(1);
    expect(result.totalCount).toBe(PARCEL_FEATURES.length);
    expect(getFeatureUrl).toBeDefined();
    expect(getFeatureUrl?.searchParams.get("typeNames")).toBe("parcels:lot");
    expect(getFeatureUrl?.searchParams.get("outputFormat")).toBe("application/geo+json");
    expect(getFeatureUrl?.searchParams.get("filter")).toContain("PropertyIsEqualTo");
  });

  it("queryExtent uses WGS84BoundingBox from capabilities for unfiltered requests", async () => {
    let getFeatureHits = 0;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            getFeatureHits += 1;
            return new Response(JSON.stringify(wfsGeoJsonResponse()), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const out = await source.queryExtent();
    expect(out.extent).toEqual({ xmin: -123, ymin: 37, xmax: -120, ymax: 45 });
    // No GetFeature traffic — bbox came from GetCapabilities metadata.
    expect(getFeatureHits).toBe(0);
  });

  it("queryExtent falls back to a drained page when a where filter is present", async () => {
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            return new Response(
              JSON.stringify(wfsGeoJsonResponse(PARCEL_FEATURES.filter((f) => f.attributes.STATE === "CA"))),
              {
                status: 200,
                headers: { "Content-Type": "application/geo+json" },
              },
            );
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const out = await source.queryExtent({ where: "STATE = 'CA'" });
    expect(out.extent).toBeTruthy();
    expect(out.extent!.xmin).toBeLessThanOrEqual(out.extent!.xmax);
  });

  it("queryExtent ignores outFields so projected requests still include geometry", async () => {
    let observedPropertyName: string | null | undefined;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            observedPropertyName = url.searchParams.get("propertyName");
            const projectedAwayGeometry = observedPropertyName !== null;
            const body = wfsGeoJsonResponse(PARCEL_FEATURES.filter((f) => f.attributes.STATE === "CA"));
            return new Response(
              JSON.stringify({
                ...body,
                features: projectedAwayGeometry
                  ? body.features.map((feature) => ({ ...feature, geometry: null }))
                  : body.features,
              }),
              { status: 200, headers: { "Content-Type": "application/geo+json" } },
            );
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const out = await source.queryExtent({ where: "STATE = 'CA'", outFields: ["OBJECTID"] });
    expect(observedPropertyName).toBeNull();
    expect(out.extent).toEqual({ xmin: -121, ymin: 37, xmax: -120, ymax: 38 });
  });

  it("filtered queryExtent drains all pages so the widest geometry on a later page is included", async () => {
    // Server-side feature set: two pages worth, where the second page holds
    // the widest x and the smallest y. A single-page implementation would
    // miss those extremes.
    const widePageFeatures = [
      {
        type: "Feature" as const,
        id: 100,
        properties: { OBJECTID: 100, STATE: "CA", ACRES: 1 },
        geometry: { type: "Point", coordinates: [-130, 30] },
      },
      {
        type: "Feature" as const,
        id: 101,
        properties: { OBJECTID: 101, STATE: "CA", ACRES: 1 },
        geometry: { type: "Point", coordinates: [-110, 50] },
      },
    ];
    const firstPageFeatures = PARCEL_FEATURES.map((f) => ({
      type: "Feature" as const,
      id: f.attributes.OBJECTID,
      properties: { ...f.attributes },
      geometry: { type: "Point", coordinates: [f.geometry.x, f.geometry.y] },
    }));
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
            const count = Number(url.searchParams.get("count") ?? "2000");
            // Page 1: PARCEL_FEATURES + filler to hit the page-size cap.
            // Page 2: widePageFeatures. Page 3: empty (drain terminates).
            if (startIndex === 0) {
              const filler = Array.from({ length: Math.max(0, count - firstPageFeatures.length) }, (_, idx) => ({
                type: "Feature" as const,
                id: 9000 + idx,
                properties: { OBJECTID: 9000 + idx, STATE: "CA", ACRES: 1 },
                geometry: { type: "Point", coordinates: [-122, 38] },
              }));
              const features = [...firstPageFeatures, ...filler];
              return new Response(
                JSON.stringify({ type: "FeatureCollection", features, numberMatched: features.length + 2 }),
                { status: 200, headers: { "Content-Type": "application/geo+json" } },
              );
            }
            return new Response(
              JSON.stringify({ type: "FeatureCollection", features: widePageFeatures, numberMatched: 2 }),
              { status: 200, headers: { "Content-Type": "application/geo+json" } },
            );
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const out = await source.queryExtent({ where: "STATE = 'CA'" });
    expect(out.extent).toBeTruthy();
    // Wide x from page 2 (-130) and high y from page 2 (50) must appear in
    // the extent — proves the drain visited the second page.
    expect(out.extent!.xmin).toBeLessThanOrEqual(-130);
    expect(out.extent!.ymax).toBeGreaterThanOrEqual(50);
  });

  it("query with outFields appends the geometry property so geometry is preserved", async () => {
    let observedPropertyName: string | null = null;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            observedPropertyName = url.searchParams.get("propertyName");
            return new Response(JSON.stringify(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1))), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const result = await source.query({ outFields: ["OBJECTID", "STATE"] });
    expect(observedPropertyName).toBe("OBJECTID,STATE,the_geom");
    expect(result.features[0].geometry).not.toBeNull();
  });

  it("query with returnGeometry=false omits the geometry property", async () => {
    let observedPropertyName: string | null = null;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            observedPropertyName = url.searchParams.get("propertyName");
            const body = wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1));
            return new Response(
              JSON.stringify({ ...body, features: body.features.map((f) => ({ ...f, geometry: null })) }),
              { status: 200, headers: { "Content-Type": "application/geo+json" } },
            );
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const result = await source.query({ outFields: ["OBJECTID", "STATE"], returnGeometry: false });
    expect(observedPropertyName).toBe("OBJECTID,STATE");
    expect(result.features[0].geometry).toBeNull();
  });

  it("query with returnGeometry=false but no outFields throws (WFS cannot suppress geometry without enumeration)", async () => {
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          return new Response(JSON.stringify(wfsGeoJsonResponse()), {
            status: 200,
            headers: { "Content-Type": "application/geo+json" },
          });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    await expect(source.query({ where: "1=1", returnGeometry: false })).rejects.toThrow(
      HonuaCapabilityNotSupportedError,
    );
  });

  it("query with outFields that already include the geometry property does not duplicate it", async () => {
    let observedPropertyName: string | null = null;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            observedPropertyName = url.searchParams.get("propertyName");
            return new Response(JSON.stringify(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1))), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    await source.query({ outFields: ["OBJECTID", "the_geom", "STATE"] });
    expect(observedPropertyName).toBe("OBJECTID,the_geom,STATE");
  });

  it("queryObjectIds tolerates returnGeometry=false (geometry intent is irrelevant for ids-only)", async () => {
    let observedPropertyName: string | null = null;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            observedPropertyName = url.searchParams.get("propertyName");
            return new Response(JSON.stringify(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 2))), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const ids = await source.queryObjectIds({ where: "STATE = 'CA'", returnGeometry: false, outFields: ["OBJECTID"] });
    expect(observedPropertyName).toBeNull();
    expect(ids.length).toBeGreaterThan(0);
  });

  it("filtered queryExtent tolerates returnGeometry=false (drain forces geometry on the wire)", async () => {
    let observedPropertyName: string | null = null;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            observedPropertyName = url.searchParams.get("propertyName");
            return new Response(
              JSON.stringify(wfsGeoJsonResponse(PARCEL_FEATURES.filter((f) => f.attributes.STATE === "CA"))),
              { status: 200, headers: { "Content-Type": "application/geo+json" } },
            );
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const out = await source.queryExtent({ where: "STATE = 'CA'", returnGeometry: false });
    expect(observedPropertyName).toBeNull();
    expect(out.extent).toBeTruthy();
  });

  it("numeric outSr maps to an EPSG URN srsName on GET GetFeature", async () => {
    let getFeatureUrl: URL | undefined;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            getFeatureUrl = url;
            return new Response(JSON.stringify(wfsGeoJsonResponse()), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    await source.query({ where: "STATE = 'CA'", outSr: 3857 });
    expect(getFeatureUrl?.searchParams.get("srsName")).toBe("urn:ogc:def:crs:EPSG::3857");
  });

  it("long-filter POST GetFeature preserves propertyName, sortBy, and srsName in the body", async () => {
    let observedBody = "";
    const dataset = buildWfsDataset([
      [
        "/wfs",
        async (url, init) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (init?.method === "POST") {
            observedBody = typeof init.body === "string" ? init.body : await new Response(init.body).text();
            return new Response(JSON.stringify(wfsGeoJsonResponse()), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          if (request === "GetFeature") {
            return new Response(JSON.stringify(wfsGeoJsonResponse()), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    // Construct a where clause whose URL-encoded FES filter exceeds the
    // GET budget so the adapter switches to POST GetFeature.
    const longList = Array.from({ length: 600 }, (_, i) => `'value-${i}'`).join(", ");
    await source.query({
      where: `STATE IN (${longList})`,
      outFields: ["OBJECTID", "STATE"],
      orderBy: [{ field: "ACRES", direction: "desc" }],
      outSr: 3857,
    });
    expect(observedBody).toContain("<wfs:GetFeature");
    expect(observedBody).toContain('srsName="urn:ogc:def:crs:EPSG::3857"');
    expect(observedBody).toContain("<wfs:PropertyName>OBJECTID</wfs:PropertyName>");
    expect(observedBody).toContain("<wfs:PropertyName>STATE</wfs:PropertyName>");
    // Geometry property is appended so outFields callers do not silently
    // lose geometry on the wire.
    expect(observedBody).toContain("<wfs:PropertyName>the_geom</wfs:PropertyName>");
    expect(observedBody).toContain("<fes:SortBy>");
    expect(observedBody).toContain("<fes:ValueReference>ACRES</fes:ValueReference>");
    expect(observedBody).toContain("<fes:SortOrder>DESC</fes:SortOrder>");
  });

  it("throws HonuaCapabilityNotSupportedError when only GML is advertised", async () => {
    const gmlOnlyCapabilities = wfsCapabilitiesXml().replace("<ows:Value>application/geo+json</ows:Value>", "");
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(gmlOnlyCapabilities);
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    await expect(source.query({ where: "1=1" })).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });

  it("throws HonuaCapabilityNotSupportedError for unsupported where expressions", async () => {
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            return new Response(JSON.stringify(wfsGeoJsonResponse()), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    await expect(source.query({ where: "ST_AREA(geom) > 100" })).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });

  it("applyEdits builds a Transaction body and surfaces InsertResults handles", async () => {
    let observedBody: string | undefined;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        async (url, init) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (init?.method === "POST") {
            observedBody = typeof init.body === "string" ? init.body : await new Response(init.body).text();
            return xmlResponse(wfsTransactionResponseXml());
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const result = await source.applyEdits({
      adds: [
        { attributes: { OBJECTID: 99, STATE: "CA", ACRES: 5 }, geometry: { type: "Point", coordinates: [-122, 37] } },
      ],
      updates: [{ id: 1, attributes: { OBJECTID: 1, STATE: "CA", ACRES: 8 } }],
      deletes: [3],
      rollbackOnFailure: true,
    });
    expect(observedBody).toContain("<wfs:Transaction");
    expect(observedBody).toContain('releaseAction="ALL"');
    expect(observedBody).toContain("<wfs:Insert");
    expect(observedBody).toContain("<wfs:Update");
    expect(observedBody).toContain("<wfs:Delete");
    // The prefix in `parcels:lot` must be bound on the Transaction root —
    // see review finding "WFS-T inserts emit unbound namespace prefixes".
    expect(observedBody).toContain('xmlns:parcels="http://parcels.example.test/ns"');
    expect(observedBody).toContain("<parcels:lot>");
    expect(result.added[0].id).toBe("parcels:lot.99");
    expect(result.added[0].success).toBe(true);
    expect(result.updated[0].success).toBe(true);
    expect(result.deleted[0].success).toBe(true);
  });

  it("applyEdits falls back to a synthetic xmlns when the locator omits featureNamespace", async () => {
    let observedBody: string | undefined;
    const dataset = buildWfsDataset(
      [
        [
          "/wfs",
          async (url, init) => {
            const request = url.searchParams.get("request");
            if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
            if (init?.method === "POST") {
              observedBody = typeof init.body === "string" ? init.body : await new Response(init.body).text();
              return xmlResponse(wfsTransactionResponseXml());
            }
            return new Response("not found", { status: 404 });
          },
        ],
      ],
      { url: "https://mock.honua.test/wfs", typeName: "parcels:lot" },
    );
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    await source.applyEdits({ deletes: [1] });
    expect(observedBody).toContain('xmlns:parcels="urn:honua:wfs:feature-namespace:parcels"');
  });

  it("applyEdits omits xmlns binding for an unprefixed type name", async () => {
    let observedBody: string | undefined;
    const dataset = buildWfsDataset(
      [
        [
          "/wfs",
          async (url, init) => {
            const request = url.searchParams.get("request");
            if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
            if (init?.method === "POST") {
              observedBody = typeof init.body === "string" ? init.body : await new Response(init.body).text();
              return xmlResponse(wfsTransactionResponseXml());
            }
            return new Response("not found", { status: 404 });
          },
        ],
      ],
      { url: "https://mock.honua.test/wfs", typeName: "lot" },
    );
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    await source.applyEdits({ deletes: [1] });
    expect(observedBody).toContain("<wfs:Transaction");
    expect(observedBody).not.toContain("xmlns:parcels=");
    expect(observedBody).not.toContain("urn:honua:wfs:feature-namespace");
  });

  it("applyEdits surfaces ExceptionReport as HonuaWfsExceptionError", async () => {
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url, init) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (init?.method === "POST") {
            return new Response(wfsExceptionXml("OperationProcessingFailed", "transaction rejected"), {
              status: 400,
              headers: { "Content-Type": "application/xml" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    await expect(source.applyEdits({ deletes: [1] })).rejects.toBeInstanceOf(HonuaWfsExceptionError);
  });

  it("rollbackOnFailure: false maps to releaseAction='SOME'", async () => {
    let observedBody = "";
    const dataset = buildWfsDataset([
      [
        "/wfs",
        async (url, init) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (init?.method === "POST") {
            observedBody = typeof init.body === "string" ? init.body : await new Response(init.body).text();
            return xmlResponse(wfsTransactionResponseXml());
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    await source.applyEdits({ deletes: [1], rollbackOnFailure: false });
    expect(observedBody).toContain('releaseAction="SOME"');
  });

  it("queryAll honors Query.pagination.limit and stamps exceededTransferLimit", async () => {
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            const start = Number(url.searchParams.get("startIndex") ?? "0");
            const count = Number(url.searchParams.get("count") ?? PARCEL_FEATURES.length);
            const slice = PARCEL_FEATURES.slice(start, start + count);
            return new Response(
              JSON.stringify({
                ...wfsGeoJsonResponse(slice),
                numberMatched: PARCEL_FEATURES.length,
              }),
              { status: 200, headers: { "Content-Type": "application/geo+json" } },
            );
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const result = await source.queryAll({ pagination: { limit: 1 } });
    expect(result.features).toHaveLength(1);
    expect(result.exceededTransferLimit).toBe(true);
  });

  it("applyEdits with an id-less update does not POST an unfiltered <wfs:Update>", async () => {
    let observedBody: string | undefined;
    let postHits = 0;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        async (url, init) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (init?.method === "POST") {
            postHits += 1;
            observedBody = typeof init.body === "string" ? init.body : await new Response(init.body).text();
            return xmlResponse(wfsTransactionResponseXml());
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const result = await source.applyEdits({
      updates: [{ attributes: { OBJECTID: 1, STATE: "CA", ACRES: 8 } } as any],
    });
    // Per-item failure for the malformed update; transaction is never sent
    // because no operations remain after filtering.
    expect(postHits).toBe(0);
    expect(observedBody).toBeUndefined();
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].success).toBe(false);
    expect(result.updated[0].error?.code).toBe(400);
    expect(result.updated[0].error?.description).toContain("update.id");
  });

  it("applyEdits skips id-less updates from the body but still sends valid edits", async () => {
    let observedBody: string | undefined;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        async (url, init) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (init?.method === "POST") {
            observedBody = typeof init.body === "string" ? init.body : await new Response(init.body).text();
            return xmlResponse(wfsTransactionResponseXml());
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const result = await source.applyEdits({
      updates: [
        { attributes: { OBJECTID: 1, STATE: "CA", ACRES: 8 } } as any,
        { id: 2, attributes: { OBJECTID: 2, STATE: "CA", ACRES: 11 } },
      ],
    });
    expect(observedBody).toBeDefined();
    // The malformed update never made it onto the wire; only the valid one.
    expect(observedBody!.match(/<wfs:Update/g) ?? []).toHaveLength(1);
    expect(observedBody).toContain('<fes:ResourceId rid="2"/>');
    expect(result.updated).toHaveLength(2);
    expect(result.updated[0].success).toBe(false);
    expect(result.updated[0].error?.code).toBe(400);
    expect(result.updated[1].success).toBe(true);
    expect(result.updated[1].id).toBe(2);
  });

  it("applyEdits maps InsertResults by handle even when the server reorders the buckets", async () => {
    // Server replies with InsertResults in *reverse* request order. Without
    // handle-based mapping the canonical EditOutcome.id values would be
    // swapped — adds[0] would carry the rid meant for adds[1] and so on.
    const reorderedTransactionResponse = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:TransactionResponse xmlns:wfs="http://www.opengis.net/wfs/2.0" version="2.0.0">
  <wfs:TransactionSummary>
    <wfs:totalInserted>3</wfs:totalInserted>
    <wfs:totalUpdated>0</wfs:totalUpdated>
    <wfs:totalDeleted>0</wfs:totalDeleted>
  </wfs:TransactionSummary>
  <wfs:InsertResults>
    <wfs:Feature handle="add-3">
      <fes:ResourceId xmlns:fes="http://www.opengis.net/fes/2.0" rid="parcels:lot.300"/>
    </wfs:Feature>
    <wfs:Feature handle="add-1">
      <fes:ResourceId xmlns:fes="http://www.opengis.net/fes/2.0" rid="parcels:lot.100"/>
    </wfs:Feature>
    <wfs:Feature handle="add-2">
      <fes:ResourceId xmlns:fes="http://www.opengis.net/fes/2.0" rid="parcels:lot.200"/>
    </wfs:Feature>
  </wfs:InsertResults>
</wfs:TransactionResponse>`;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        async (url, init) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (init?.method === "POST") return xmlResponse(reorderedTransactionResponse);
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const result = await source.applyEdits({
      adds: [
        { attributes: { OBJECTID: 100, STATE: "CA", ACRES: 1 }, geometry: { type: "Point", coordinates: [-122, 37] } },
        { attributes: { OBJECTID: 200, STATE: "CA", ACRES: 2 }, geometry: { type: "Point", coordinates: [-121, 38] } },
        { attributes: { OBJECTID: 300, STATE: "CA", ACRES: 3 }, geometry: { type: "Point", coordinates: [-120, 39] } },
      ],
    });
    expect(result.added).toHaveLength(3);
    expect(result.added[0].id).toBe("parcels:lot.100");
    expect(result.added[1].id).toBe("parcels:lot.200");
    expect(result.added[2].id).toBe("parcels:lot.300");
    expect(result.added.every((o) => o.success)).toBe(true);
  });

  it("applyEdits surfaces missing InsertResults handles as success: false under releaseAction='SOME'", async () => {
    // releaseAction="SOME" lets the server commit a subset of inserts. The
    // server only echoes the handles that committed, so the missing
    // bucket must surface as success: false rather than the legacy
    // first-N-succeeded heuristic which would silently mark adds[0] /
    // adds[1] as successful and drop adds[2].
    const partialTransactionResponse = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:TransactionResponse xmlns:wfs="http://www.opengis.net/wfs/2.0" version="2.0.0">
  <wfs:TransactionSummary>
    <wfs:totalInserted>2</wfs:totalInserted>
    <wfs:totalUpdated>0</wfs:totalUpdated>
    <wfs:totalDeleted>0</wfs:totalDeleted>
  </wfs:TransactionSummary>
  <wfs:InsertResults>
    <wfs:Feature handle="add-1">
      <fes:ResourceId xmlns:fes="http://www.opengis.net/fes/2.0" rid="parcels:lot.100"/>
    </wfs:Feature>
    <wfs:Feature handle="add-3">
      <fes:ResourceId xmlns:fes="http://www.opengis.net/fes/2.0" rid="parcels:lot.300"/>
    </wfs:Feature>
  </wfs:InsertResults>
</wfs:TransactionResponse>`;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        async (url, init) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (init?.method === "POST") return xmlResponse(partialTransactionResponse);
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const result = await source.applyEdits({
      adds: [
        { attributes: { OBJECTID: 100, STATE: "CA", ACRES: 1 }, geometry: { type: "Point", coordinates: [-122, 37] } },
        { attributes: { OBJECTID: 200, STATE: "CA", ACRES: 2 }, geometry: { type: "Point", coordinates: [-121, 38] } },
        { attributes: { OBJECTID: 300, STATE: "CA", ACRES: 3 }, geometry: { type: "Point", coordinates: [-120, 39] } },
      ],
      rollbackOnFailure: false,
    });
    expect(result.added[0]).toEqual({ id: "parcels:lot.100", success: true });
    expect(result.added[1]).toEqual({ success: false });
    expect(result.added[2]).toEqual({ id: "parcels:lot.300", success: true });
  });

  it("applyEdits falls back to positional InsertResults when the server omits handles", async () => {
    // Some WFS servers do not echo the `handle` attribute on
    // <wfs:Feature> (the spec marks it informational). The adapter must
    // not drop every insert id in that case — it falls back to the
    // legacy positional pairing keyed on InsertResults order +
    // totalInserted.
    const noHandleTransactionResponse = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:TransactionResponse xmlns:wfs="http://www.opengis.net/wfs/2.0" version="2.0.0">
  <wfs:TransactionSummary>
    <wfs:totalInserted>2</wfs:totalInserted>
    <wfs:totalUpdated>0</wfs:totalUpdated>
    <wfs:totalDeleted>0</wfs:totalDeleted>
  </wfs:TransactionSummary>
  <wfs:InsertResults>
    <wfs:Feature>
      <fes:ResourceId xmlns:fes="http://www.opengis.net/fes/2.0" rid="parcels:lot.100"/>
    </wfs:Feature>
    <wfs:Feature>
      <fes:ResourceId xmlns:fes="http://www.opengis.net/fes/2.0" rid="parcels:lot.200"/>
    </wfs:Feature>
  </wfs:InsertResults>
</wfs:TransactionResponse>`;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        async (url, init) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (init?.method === "POST") return xmlResponse(noHandleTransactionResponse);
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const result = await source.applyEdits({
      adds: [
        { attributes: { OBJECTID: 100, STATE: "CA", ACRES: 1 }, geometry: { type: "Point", coordinates: [-122, 37] } },
        { attributes: { OBJECTID: 200, STATE: "CA", ACRES: 2 }, geometry: { type: "Point", coordinates: [-121, 38] } },
      ],
    });
    expect(result.added[0]).toEqual({ id: "parcels:lot.100", success: true });
    expect(result.added[1]).toEqual({ id: "parcels:lot.200", success: true });
  });

  it("queryObjectIds drains pages until the server returns a short page", async () => {
    let pageRequests = 0;
    const totalRows = 4500; // > one drain page (2000)
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            pageRequests += 1;
            const start = Number(url.searchParams.get("startIndex") ?? "0");
            const count = Number(url.searchParams.get("count") ?? "2000");
            const end = Math.min(totalRows, start + count);
            const features = Array.from({ length: end - start }, (_, idx) => ({
              type: "Feature" as const,
              id: start + idx + 1,
              properties: { OBJECTID: start + idx + 1, STATE: "CA", ACRES: 1 },
              geometry: { type: "Point", coordinates: [-122, 38] },
            }));
            return new Response(JSON.stringify({ type: "FeatureCollection", features, numberMatched: totalRows }), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const ids = await source.queryObjectIds({ where: "1=1" });
    expect(pageRequests).toBeGreaterThanOrEqual(3);
    expect(ids).toHaveLength(totalRows);
    expect(ids[0]).toBe(1);
    expect(ids[ids.length - 1]).toBe(totalRows);
  });

  it("queryObjectIds caps at Query.pagination.limit when supplied", async () => {
    const totalRows = 4500;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            const start = Number(url.searchParams.get("startIndex") ?? "0");
            const count = Number(url.searchParams.get("count") ?? "2000");
            const end = Math.min(totalRows, start + count);
            const features = Array.from({ length: end - start }, (_, idx) => ({
              type: "Feature" as const,
              id: start + idx + 1,
              properties: { OBJECTID: start + idx + 1, STATE: "CA", ACRES: 1 },
              geometry: { type: "Point", coordinates: [-122, 38] },
            }));
            return new Response(JSON.stringify({ type: "FeatureCollection", features, numberMatched: totalRows }), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const ids = await source.queryObjectIds({ pagination: { limit: 50 } });
    expect(ids).toHaveLength(50);
  });

  it("envelope spatialRel='within' takes the FES path, not bbox=", async () => {
    let getFeatureUrl: URL | undefined;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            getFeatureUrl = url;
            return new Response(JSON.stringify(wfsGeoJsonResponse()), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    await source.query({
      spatialFilter: {
        geometry: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelWithin",
      },
    });
    // Non-intersects envelope must NOT shortcut as bbox= — it must emit
    // <fes:Within> in the filter so the server preserves "within" semantics.
    expect(getFeatureUrl?.searchParams.get("bbox")).toBeNull();
    const filter = getFeatureUrl?.searchParams.get("filter") ?? "";
    expect(filter).toContain("<fes:Within>");
    expect(filter).toContain("<gml:Polygon");
  });

  it("envelope spatialRel='intersects' still takes the bbox= shortcut", async () => {
    let getFeatureUrl: URL | undefined;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            getFeatureUrl = url;
            return new Response(JSON.stringify(wfsGeoJsonResponse()), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    await source.query({
      spatialFilter: {
        geometry: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
      },
    });
    expect(getFeatureUrl?.searchParams.get("bbox")).toBe("-123,37,-120,45");
    expect(getFeatureUrl?.searchParams.get("filter")).toBeNull();
  });

  it("query({ pagination: { limit: 0 } }) returns empty without a GetFeature wire call", async () => {
    let getFeatureHits = 0;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            getFeatureHits += 1;
            return new Response(JSON.stringify(wfsGeoJsonResponse()), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const result = await source.query({ pagination: { limit: 0 } });
    expect(result.features).toEqual([]);
    expect(result.exceededTransferLimit).toBe(false);
    expect(getFeatureHits).toBe(0);
  });

  it("queryAll({ pagination: { limit: 0 } }) fetches a lookahead page and stamps exceededTransferLimit", async () => {
    let observedCount: string | null | undefined;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            observedCount = url.searchParams.get("count");
            const requested = Number(observedCount ?? PARCEL_FEATURES.length);
            const slice = PARCEL_FEATURES.slice(0, requested);
            return new Response(
              JSON.stringify({
                ...wfsGeoJsonResponse(slice),
                numberMatched: PARCEL_FEATURES.length,
              }),
              { status: 200, headers: { "Content-Type": "application/geo+json" } },
            );
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const result = await source.queryAll({ pagination: { limit: 0 } });
    expect(observedCount).toBe("1");
    expect(result.features).toEqual([]);
    expect(result.exceededTransferLimit).toBe(true);
  });

  it("stream({ pagination: { limit: 0 } }) yields nothing without a GetFeature wire call", async () => {
    let getFeatureHits = 0;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            getFeatureHits += 1;
            return new Response(JSON.stringify(wfsGeoJsonResponse()), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const yielded: number[] = [];
    for await (const page of source.stream({ pagination: { limit: 0 } })) {
      yielded.push(page.features.length);
    }
    expect(yielded).toEqual([]);
    expect(getFeatureHits).toBe(0);
  });

  it("queryObjectIds({ pagination: { limit: 0 } }) returns [] without a GetFeature wire call", async () => {
    let getFeatureHits = 0;
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            getFeatureHits += 1;
            return new Response(JSON.stringify(wfsGeoJsonResponse()), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const ids = await source.queryObjectIds({ pagination: { limit: 0 } });
    expect(ids).toEqual([]);
    expect(getFeatureHits).toBe(0);
  });
});

describe("wfs / protocol escape hatch", () => {
  it("Source.protocol('wfs') returns the bound HonuaWfsFeatureType", () => {
    const dataset = buildWfsDataset([]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const wfs = source.protocol("wfs");
    expect(wfs).toBeInstanceOf(HonuaWfsFeatureType);
    expect((wfs as HonuaWfsFeatureType).typeName).toBe("parcels:lot");
  });

  it("storedQueries() returns the advertised identifiers", async () => {
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          if (url.searchParams.get("request") === "ListStoredQueries") {
            return xmlResponse(wfsListStoredQueriesXml());
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const wfs = source.protocol("wfs") as HonuaWfsFeatureType;
    const ids = await wfs.root.storedQueries();
    expect(ids).toContain("byKey");
  });

  it("storedQuery(id).execute returns canonical feature data when JSON output is available", async () => {
    const dataset = buildWfsDataset([
      [
        "/wfs",
        (url) => {
          if (url.searchParams.get("request") === "GetFeature" && url.searchParams.get("storedquery_id") === "byKey") {
            expect(url.searchParams.get("id")).toBe("1");
            return new Response(JSON.stringify(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1))), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ]);
    const source = dataset.source<ParcelAttrs>("parcels-wfs")!;
    const wfs = source.protocol("wfs") as HonuaWfsFeatureType;
    const sq = wfs.root.storedQuery("byKey");
    const response = await sq.execute({ parameters: { id: 1 } });
    expect(response.kind).toBe("json");
  });
});
