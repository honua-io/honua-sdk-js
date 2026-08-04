/**
 * Cross-protocol semantic equivalence for the canonical typed filter (#947).
 *
 * Extends the semantic-equivalence corpus idea from #531 to the *canonical*
 * surface: one `Query` carrying `filter` (attribute + spatial) and
 * `temporalFilter` is executed through `Source.query()` against GeoServices,
 * OGC API Features, WFS 2.0, and OData fixtures. Each adapter must
 *
 *  1. put a faithful predicate on its own wire dialect (SQL-92, CQL2 text,
 *     FES 2.0, `$filter` / `datetime`), and
 *  2. return the same canonical `Result` rows.
 *
 * Constructs a target cannot express exactly must throw
 * `HonuaCapabilityNotSupportedError` naming the construct and the protocol —
 * never a silently widened result set.
 */

import { describe, expect, it } from "vitest";

import {
  PROTOCOL_DEFAULT_CAPABILITIES,
  type Query,
  type QueryFilterExpression,
  type QueryTemporalFilter,
  type SourceDescriptor,
  createDataset,
  queryFilter,
} from "../../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";
import { envelope } from "../../src/core/spatial-filter.js";

import {
  PARCEL_FEATURES,
  type ParcelAttrs,
  geoservicesQueryResponse,
  jsonResponse,
  makeMockClient,
  odataMetadataResponse,
  odataParcelsResponse,
  ogcCollectionMetadata,
  ogcItemsResponse,
  wfsCapabilitiesXml,
  wfsGeoJsonResponse,
  xmlResponse,
} from "./shared.js";

/** The one canonical row every protocol must agree on. */
const MATCHED = [PARCEL_FEATURES[0]];

/** Attribute + spatial predicate, identical for every protocol. */
const FILTER: QueryFilterExpression = queryFilter.and(
  queryFilter.eq("STATE", "CA"),
  queryFilter.gt("ACRES", 10),
  queryFilter.spatial("intersects", envelope(-125, 30, -115, 42)),
);

/** Field-bound temporal window: the only form every protocol can express. */
const TEMPORAL: QueryTemporalFilter = {
  kind: "interval",
  start: "2026-01-01T00:00:00Z",
  end: "2026-02-01T00:00:00Z",
  field: "REPORTED_AT",
};

const REQUEST: Query<ParcelAttrs> = { filter: FILTER, temporalFilter: TEMPORAL, pagination: { limit: 10 } };

function geoServicesSource() {
  const seen: { url?: URL } = {};
  const client = makeMockClient({
    routes: [
      [
        "/rest/services/Parcels/FeatureServer/0/query",
        (url) => {
          seen.url = url;
          return jsonResponse(geoservicesQueryResponse(MATCHED));
        },
      ],
    ],
  });
  const source = createDataset({
    id: "parcels",
    client,
    skipCompatibilityCheck: true,
    sources: [
      {
        id: "parcels-fs",
        protocol: "geoservices-feature-service",
        locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
      } satisfies SourceDescriptor,
    ],
  }).source<ParcelAttrs>("parcels-fs")!;
  return { source, seen };
}

function ogcFeaturesSource() {
  const seen: { url?: URL } = {};
  const client = makeMockClient({
    routes: [
      [
        "/ogc/features/collections/parcels/items",
        (url) => {
          seen.url = url;
          return jsonResponse(ogcItemsResponse(MATCHED));
        },
      ],
      ["/ogc/features/collections/parcels", () => jsonResponse(ogcCollectionMetadata())],
    ],
  });
  const source = createDataset({
    id: "parcels",
    client,
    skipCompatibilityCheck: true,
    sources: [
      {
        id: "parcels-ogc",
        protocol: "ogc-features",
        locator: { url: "https://mock/", collectionId: "parcels" },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
      } satisfies SourceDescriptor,
    ],
  }).source<ParcelAttrs>("parcels-ogc")!;
  return { source, seen };
}

function wfsSource() {
  const seen: { url?: URL } = {};
  const client = makeMockClient({
    routes: [
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "GetFeature") {
            seen.url = url;
            return jsonResponse(wfsGeoJsonResponse(MATCHED));
          }
          return new Response("not found", { status: 404 });
        },
      ],
    ],
  });
  const source = createDataset({
    id: "parcels",
    client,
    skipCompatibilityCheck: true,
    sources: [
      {
        id: "parcels-wfs",
        protocol: "wfs",
        // `geometryName` pins the FES `<fes:ValueReference>` so the fixture
        // needs no DescribeFeatureType round trip.
        locator: {
          url: "https://mock.honua.test/wfs",
          typeName: "parcels:lot",
          featureNamespace: "http://parcels.example.test/ns",
          geometryName: "the_geom",
        },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
      } satisfies SourceDescriptor,
    ],
  }).source<ParcelAttrs>("parcels-wfs")!;
  return { source, seen };
}

function odataSource() {
  const seen: { url?: URL } = {};
  const client = makeMockClient({
    routes: [
      ["/odata/$metadata", () => odataMetadataResponse()],
      [
        "/odata/Parcels",
        (url) => {
          seen.url = url;
          return jsonResponse(odataParcelsResponse(MATCHED));
        },
      ],
    ],
  });
  const source = createDataset({
    id: "parcels",
    client,
    skipCompatibilityCheck: true,
    sources: [
      {
        id: "parcels-odata",
        protocol: "odata",
        locator: { url: "https://mock/odata", entitySet: "Parcels" },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
      } satisfies SourceDescriptor,
    ],
  }).source<ParcelAttrs>("parcels-odata")!;
  return { source, seen };
}

describe("typed filter / cross-protocol equivalence through Source.query()", () => {
  it("compiles the same filter to GeoServices SQL-92 plus geometry and time parameters", async () => {
    const { source, seen } = geoServicesSource();
    const result = await source.query(REQUEST);

    const where = seen.url?.searchParams.get("where") ?? "";
    expect(where).toContain("STATE = 'CA'");
    expect(where).toContain("ACRES > 10");
    expect(where).toContain("REPORTED_AT >= TIMESTAMP '2026-01-01T00:00:00Z'");
    expect(where).toContain("REPORTED_AT <= TIMESTAMP '2026-02-01T00:00:00Z'");
    // The spatial node leaves the SQL and becomes request geometry parameters.
    expect(where).not.toContain("esriGeometry");
    expect(seen.url?.searchParams.get("geometryType")).toBe("esriGeometryEnvelope");
    expect(seen.url?.searchParams.get("spatialRel")).toBe("esriSpatialRelIntersects");
    expect(JSON.parse(seen.url?.searchParams.get("geometry") ?? "{}")).toMatchObject({
      xmin: -125,
      ymin: 30,
      xmax: -115,
      ymax: 42,
    });
    expect(result.features.map((f) => f.attributes.OBJECTID)).toEqual([1]);
  });

  it("compiles the same filter to CQL2 text for OGC API Features", async () => {
    const { source, seen } = ogcFeaturesSource();
    const result = await source.query(REQUEST);

    const filter = seen.url?.searchParams.get("filter") ?? "";
    expect(seen.url?.searchParams.get("filter-lang")).toBe("cql2-text");
    expect(filter).toContain("STATE = 'CA'");
    expect(filter).toContain("ACRES > 10");
    expect(filter).toContain("S_INTERSECTS(geometry, POLYGON((-125 30, -115 30, -115 42, -125 42, -125 30)))");
    expect(filter).toContain("T_DURING(REPORTED_AT, INTERVAL('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'))");
    expect(result.features.map((f) => f.attributes.OBJECTID)).toEqual([1]);
  });

  it("compiles the same filter to FES 2.0 for WFS", async () => {
    const { source, seen } = wfsSource();
    const result = await source.query(REQUEST);

    const fes = seen.url?.searchParams.get("FILTER") ?? seen.url?.searchParams.get("filter") ?? "";
    expect(fes).toContain("<fes:PropertyIsEqualTo><fes:ValueReference>STATE</fes:ValueReference>");
    expect(fes).toContain("<fes:Literal>CA</fes:Literal>");
    expect(fes).toContain("<fes:PropertyIsGreaterThan><fes:ValueReference>ACRES</fes:ValueReference>");
    expect(fes).toContain("<fes:BBOX><fes:ValueReference>the_geom</fes:ValueReference>");
    expect(fes).toContain("<fes:During><fes:ValueReference>REPORTED_AT</fes:ValueReference>");
    expect(fes).toContain("<gml:beginPosition>2026-01-01T00:00:00Z</gml:beginPosition>");
    // The `bbox=` KVP shortcut is mutually exclusive with `FILTER=`.
    expect(seen.url?.searchParams.get("bbox")).toBeNull();
    expect(result.features.map((f) => f.attributes.OBJECTID)).toEqual([1]);
  });

  it("compiles the same filter to an OData $filter", async () => {
    const { source, seen } = odataSource();
    const result = await source.query(REQUEST);

    const filter = seen.url?.searchParams.get("$filter") ?? "";
    expect(filter).toContain("STATE eq 'CA'");
    expect(filter).toContain("ACRES gt 10");
    expect(filter).toContain("geo.intersects(");
    expect(filter).toContain("REPORTED_AT ge 2026-01-01T00:00:00Z");
    expect(filter).toContain("REPORTED_AT le 2026-02-01T00:00:00Z");
    expect(result.features.map((f) => f.attributes.OBJECTID)).toEqual([1]);
  });

  it("returns equivalent canonical rows from all four protocols", async () => {
    const results = await Promise.all([
      geoServicesSource().source.query(REQUEST),
      ogcFeaturesSource().source.query(REQUEST),
      wfsSource().source.query(REQUEST),
      odataSource().source.query(REQUEST),
    ]);
    const projected = results.map((result) =>
      result.features.map((feature) => ({
        OBJECTID: feature.attributes.OBJECTID,
        STATE: feature.attributes.STATE,
        ACRES: feature.attributes.ACRES,
      })),
    );
    for (const rows of projected) {
      expect(rows).toEqual([{ OBJECTID: 1, STATE: "CA", ACRES: 12 }]);
    }
  });

  it("applies a source-dimension temporal filter through each protocol's time parameter", async () => {
    const temporalOnly: Query<ParcelAttrs> = {
      temporalFilter: { kind: "interval", start: "2026-01-01T00:00:00Z", end: null },
    };
    const geo = geoServicesSource();
    await geo.source.query(temporalOnly);
    expect(geo.seen.url?.searchParams.get("time")).toBe(`${Date.parse("2026-01-01T00:00:00Z")},null`);

    const ogc = ogcFeaturesSource();
    await ogc.source.query(temporalOnly);
    expect(ogc.seen.url?.searchParams.get("datetime")).toBe("2026-01-01T00:00:00Z/..");
  });
});

describe("typed filter / fail-closed fidelity", () => {
  it("refuses a spatial predicate under OR on GeoServices, naming construct and protocol", async () => {
    const { source } = geoServicesSource();
    const attempt = source.query({
      filter: queryFilter.or(
        queryFilter.eq("STATE", "CA"),
        queryFilter.spatial("intersects", envelope(-125, 30, -115, 42)),
      ),
    });
    await expect(attempt).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(attempt).rejects.toMatchObject({
      capability: "filter.spatial.disjunction",
      protocol: "geoservices-feature-service",
      sourceId: "parcels-fs",
    });
  });

  it("refuses a second spatial constraint rather than dropping one", async () => {
    const { source } = geoServicesSource();
    await expect(
      source.query({
        filter: queryFilter.spatial("intersects", envelope(-125, 30, -115, 42)),
        spatialFilter: envelope(-100, 30, -90, 42),
      }),
    ).rejects.toMatchObject({ capability: "filter.spatial.multiple", protocol: "geoservices-feature-service" });
  });

  it("refuses an OData LIKE pattern that has no exact $filter function", async () => {
    const { source } = odataSource();
    await expect(source.query({ filter: queryFilter.like("STATE", "C%A") })).rejects.toMatchObject({
      capability: "filter.pattern.interior-wildcard",
      protocol: "odata",
    });
  });

  it("refuses a source-dimension temporal filter on OData, which has no time parameter", async () => {
    const { source } = odataSource();
    await expect(
      source.query({ temporalFilter: { kind: "instant", instant: "2026-01-01T00:00:00Z" } }),
    ).rejects.toMatchObject({ capability: "temporalFilter.field", protocol: "odata" });
  });

  it("refuses a source-dimension temporal filter on WFS, which has no time parameter", async () => {
    const { source } = wfsSource();
    await expect(
      source.query({ temporalFilter: { kind: "instant", instant: "2026-01-01T00:00:00Z" } }),
    ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
  });

  it("refuses a filter that names a field with unquotable characters", async () => {
    const { source } = geoServicesSource();
    await expect(
      source.query({ filter: queryFilter.eq("STATE'; DROP TABLE parcels; --", "CA") }),
    ).rejects.toMatchObject({ capability: "filter.property.name" });
  });

  it("escapes string literals instead of refusing legitimate quotes", async () => {
    const { source, seen } = geoServicesSource();
    await source.query({ filter: queryFilter.eq("STATE", "O'Brien") });
    expect(seen.url?.searchParams.get("where")).toBe("STATE = 'O''Brien'");
  });
});
