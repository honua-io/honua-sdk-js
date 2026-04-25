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

const WFS_LOCATOR = { url: "https://mock.honua.test/wfs", typeName: "parcels:lot" };

function buildWfsDataset(
  routes: Array<[string | RegExp, (url: URL, init?: RequestInit) => Response | Promise<Response>]>,
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
        locator: WFS_LOCATOR,
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
    expect(result.added[0].id).toBe("parcels:lot.99");
    expect(result.added[0].success).toBe(true);
    expect(result.updated[0].success).toBe(true);
    expect(result.deleted[0].success).toBe(true);
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
