/**
 * Backend-agnostic WFS 2.0. The adapter drives a raw GetCapabilities
 * endpoint and — critically — issues GetFeature against the DCP operation
 * URL the server advertises (`ows:DCP/ows:HTTP/ows:Get/@xlink:href`), not
 * the assumed capabilities path. The GeoServer fixture is mounted at
 * `/geoserver/ows` but advertises its operation URL at `/geoserver/wfs`,
 * so a correct client sends GetFeature to `/geoserver/wfs`.
 *
 * Fixtures recorded from ahocevar.com/geoserver (see
 * `test/fixtures/backend-agnostic/geoserver-wfs/`); no network here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES, type SourceDescriptor, createDataset } from "../../src/contract/index.js";
import { HonuaClient } from "../../src/core/client.js";
import { parseWfsCapabilities, parseWfsDescribeFeatureTypeGeometry } from "../../src/core/wfs-capabilities.js";
import { HonuaWfsProtocolError } from "../../src/core/wfs-protocol-error.js";

import {
  type ParcelAttrs,
  makeMockClient,
  wfsCapabilitiesXml,
  wfsGeoJsonResponse,
  wfsTransactionResponseXml,
  xmlResponse,
} from "./shared.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/backend-agnostic/geoserver-wfs/", import.meta.url));
const CAPS_XML = readFileSync(`${FIXTURES}capabilities.xml`, "utf8");
const GETFEATURE = JSON.parse(readFileSync(`${FIXTURES}getfeature-countries.json`, "utf8"));

describe("wfs backend-agnostic / capabilities DCP URLs", () => {
  it("captures the DCP Get/Post operation URLs from a raw GeoServer GetCapabilities", () => {
    const snapshot = parseWfsCapabilities(CAPS_XML);
    const getFeature = snapshot.operations.get("GetFeature");
    expect(getFeature?.getUrl).toBe("https://ahocevar.com/geoserver/wfs");
    expect(getFeature?.postUrl).toBe("https://ahocevar.com/geoserver/wfs");
    expect(getFeature?.outputFormats).toContain("application/json");
    expect(snapshot.featureTypes[0].name).toBe("ne:ne_10m_admin_0_countries");
    expect(snapshot.namespaces.get("ne")).toBe("http://www.naturalearthdata.com");
  });
});

describe("wfs backend-agnostic / GetFeature honours the advertised DCP URL", () => {
  it("sends GetFeature to the DCP-advertised /geoserver/wfs, not the /geoserver/ows endpoint", async () => {
    const requested: string[] = [];
    const client = new HonuaClient({
      baseUrl: "https://ahocevar.com",
      fetchFn: async (input) => {
        const url = new URL(String(input));
        requested.push(url.pathname + url.search);
        if (url.searchParams.get("request") === "GetCapabilities") {
          return new Response(CAPS_XML, { status: 200, headers: { "Content-Type": "application/xml" } });
        }
        if (url.searchParams.get("request") === "GetFeature") {
          return new Response(JSON.stringify(GETFEATURE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const source = createDataset({
      id: "gs",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "countries",
          protocol: "wfs",
          // Endpoint mounted at /geoserver/ows; the DCP href points at /geoserver/wfs.
          locator: { url: "https://ahocevar.com/geoserver/ows", typeName: "ne:ne_10m_admin_0_countries" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
        } satisfies SourceDescriptor,
      ],
    }).source<{ name: string; sovereignt: string }>("countries")!;

    const result = await source.query({ pagination: { limit: 2 } });
    expect(result.features).toHaveLength(2);
    expect(result.features[0].attributes.name).toBe("Aruba");

    // GetCapabilities went to the configured endpoint (/geoserver/ows)...
    const caps = requested.find((r) => r.includes("GetCapabilities"));
    expect(caps).toBeDefined();
    expect(caps).toContain("/geoserver/ows");
    // ...but GetFeature went to the DCP-advertised /geoserver/wfs.
    const getFeature = requested.find((r) => r.includes("GetFeature"));
    expect(getFeature).toBeDefined();
    expect(getFeature).toContain("/geoserver/wfs");
    expect(getFeature).not.toContain("/geoserver/ows");
  });
});

// ── Geometry property resolution (#949) ──────────────────────
//
// The geometry property name is per-server, not universal: PostGIS via
// GeoServer defaults to `the_geom`, MapServer serves `msGeometry`, and other
// schemas name it anything. Assuming one of them makes FES spatial filters
// match nothing and writes transaction geometry into a property the server
// does not have, so the adapter resolves it from DescribeFeatureType.

/** GeoServer-shaped DescribeFeatureType response for `parcels:lot`. */
const GEOSERVER_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:parcels="http://parcels.example.test/ns" elementFormDefault="qualified" targetNamespace="http://parcels.example.test/ns" version="1.0">
  <xsd:import namespace="http://www.opengis.net/gml/3.2" schemaLocation="https://mock.honua.test/schemas/gml/3.2.1/gml.xsd"/>
  <xsd:complexType name="lotType">
    <xsd:complexContent>
      <xsd:extension base="gml:AbstractFeatureType">
        <xsd:sequence>
          <xsd:element maxOccurs="1" minOccurs="0" name="STATE" nillable="true" type="xsd:string"/>
          <xsd:element maxOccurs="1" minOccurs="0" name="ACRES" nillable="true" type="xsd:double"/>
          <xsd:element maxOccurs="1" minOccurs="0" name="the_geom" nillable="true" type="gml:MultiSurfacePropertyType"/>
        </xsd:sequence>
      </xsd:extension>
    </xsd:complexContent>
  </xsd:complexType>
  <xsd:element name="lot" substitutionGroup="gml:AbstractFeature" type="parcels:lotType"/>
</xsd:schema>`;

/** MapServer-shaped response: unprefixed XSD elements and `msGeometry`. */
const MAPSERVER_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:ms="http://mapserver.gis.umn.edu/mapserver" elementFormDefault="qualified" targetNamespace="http://mapserver.gis.umn.edu/mapserver" version="0.1">
  <import namespace="http://www.opengis.net/gml/3.2" schemaLocation="https://mock.honua.test/schemas/gml/3.2.1/gml.xsd"/>
  <element name="lot" substitutionGroup="gml:AbstractFeature" type="ms:lotType"/>
  <complexType name="lotType">
    <complexContent>
      <extension base="gml:AbstractFeatureType">
        <sequence>
          <element maxOccurs="1" minOccurs="0" name="msGeometry" nillable="true" type="gml:GeometryPropertyType"/>
          <element minOccurs="0" name="STATE" type="string"/>
        </sequence>
      </extension>
    </complexContent>
  </complexType>
</schema>`;

/** Schema-less server: a describable type that declares no geometry at all. */
const NO_GEOMETRY_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:parcels="http://parcels.example.test/ns" targetNamespace="http://parcels.example.test/ns" version="1.0">
  <xsd:complexType name="lotType">
    <xsd:complexContent>
      <xsd:extension base="gml:AbstractFeatureType">
        <xsd:sequence>
          <xsd:element maxOccurs="1" minOccurs="0" name="STATE" nillable="true" type="xsd:string"/>
        </xsd:sequence>
      </xsd:extension>
    </xsd:complexContent>
  </xsd:complexType>
  <xsd:element name="lot" substitutionGroup="gml:AbstractFeature" type="parcels:lotType"/>
</xsd:schema>`;

const WITHIN_POLYGON = {
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
  geometryType: "esriGeometryPolygon" as const,
  spatialRel: "esriSpatialRelWithin" as const,
};

const PARCEL_EDIT = {
  adds: [
    {
      attributes: { OBJECTID: 99, STATE: "CA", ACRES: 5 } as ParcelAttrs,
      geometry: { type: "Point", coordinates: [-122, 37] } as Record<string, unknown>,
    },
  ],
  updates: [
    {
      id: 1,
      attributes: { OBJECTID: 1, STATE: "CA", ACRES: 8 } as ParcelAttrs,
      geometry: { type: "Point", coordinates: [-121, 38] } as Record<string, unknown>,
    },
  ],
};

/**
 * One WFS source over a mock server whose DescribeFeatureType response (or
 * failure) is the variable under test.
 */
function buildBackend(options: { describeFeatureType: string | number; geometryName?: string }) {
  const requests: string[] = [];
  let getFeatureUrl: URL | undefined;
  let transactionBody: string | undefined;
  const client = makeMockClient({
    routes: [
      [
        "/wfs",
        async (url, init) => {
          const request = url.searchParams.get("request") ?? (init?.method === "POST" ? "Transaction" : "");
          requests.push(request);
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request === "DescribeFeatureType") {
            return typeof options.describeFeatureType === "number"
              ? new Response("schema unavailable", { status: options.describeFeatureType })
              : xmlResponse(options.describeFeatureType);
          }
          if (request === "GetFeature") {
            getFeatureUrl = url;
            return new Response(JSON.stringify(wfsGeoJsonResponse()), {
              status: 200,
              headers: { "Content-Type": "application/geo+json" },
            });
          }
          if (request === "Transaction") {
            transactionBody = typeof init?.body === "string" ? init.body : await new Response(init?.body).text();
            return xmlResponse(wfsTransactionResponseXml());
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
        locator: {
          url: "https://mock.honua.test/wfs",
          typeName: "parcels:lot",
          featureNamespace: "http://parcels.example.test/ns",
          ...(options.geometryName !== undefined ? { geometryName: options.geometryName } : {}),
        },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
      } satisfies SourceDescriptor,
    ],
  }).source<ParcelAttrs>("parcels-wfs")!;
  return {
    source,
    requests,
    getFilter: () => getFeatureUrl?.searchParams.get("filter") ?? "",
    getTransactionBody: () => transactionBody,
  };
}

describe("wfs backend-agnostic / DescribeFeatureType geometry parsing", () => {
  it("reads the geometry property of the requested type from each server flavour", () => {
    expect(parseWfsDescribeFeatureTypeGeometry(GEOSERVER_XSD, "parcels:lot")).toEqual(["the_geom"]);
    expect(parseWfsDescribeFeatureTypeGeometry(MAPSERVER_XSD, "ms:lot")).toEqual(["msGeometry"]);
    expect(parseWfsDescribeFeatureTypeGeometry(NO_GEOMETRY_XSD, "parcels:lot")).toEqual([]);
  });

  it("ignores same-named property types bound to a non-GML namespace", () => {
    const decoy = GEOSERVER_XSD.replace(
      'type="gml:MultiSurfacePropertyType"',
      'xmlns:other="urn:vendor:types" type="other:MultiSurfacePropertyType"',
    );
    expect(parseWfsDescribeFeatureTypeGeometry(decoy, "parcels:lot")).toEqual([]);
  });
});

describe("wfs backend-agnostic / geometry property drives filters and transactions", () => {
  it("uses the GeoServer-default the_geom the schema actually declares", async () => {
    const backend = buildBackend({ describeFeatureType: GEOSERVER_XSD });
    await backend.source.query({ spatialFilter: WITHIN_POLYGON });
    expect(backend.getFilter()).toContain("<fes:Within><fes:ValueReference>the_geom</fes:ValueReference>");

    await backend.source.applyEdits(PARCEL_EDIT);
    expect(backend.getTransactionBody()).toContain("<the_geom><gml:Point");
    expect(backend.getTransactionBody()).toContain("<wfs:Property><wfs:ValueReference>the_geom</wfs:ValueReference>");
    // One DescribeFeatureType round-trip, cached across both operations.
    expect(backend.requests.filter((r) => r === "DescribeFeatureType")).toHaveLength(1);
  });

  it("uses msGeometry against a MapServer schema instead of the legacy default", async () => {
    const backend = buildBackend({ describeFeatureType: MAPSERVER_XSD });
    await backend.source.query({ spatialFilter: WITHIN_POLYGON });
    const filter = backend.getFilter();
    expect(filter).toContain("<fes:Within><fes:ValueReference>msGeometry</fes:ValueReference>");
    expect(filter).not.toContain("the_geom");

    await backend.source.applyEdits(PARCEL_EDIT);
    const body = backend.getTransactionBody();
    expect(body).toContain("<msGeometry><gml:Point");
    expect(body).toContain("<wfs:Property><wfs:ValueReference>msGeometry</wfs:ValueReference>");
    expect(body).not.toContain("the_geom");
  });

  it("honours an explicit locator.geometryName without describing the type", async () => {
    // A schema that would resolve to `the_geom` must lose to the override, and
    // the override must skip the DescribeFeatureType round-trip entirely.
    const backend = buildBackend({ describeFeatureType: GEOSERVER_XSD, geometryName: "geom" });
    await backend.source.query({ spatialFilter: WITHIN_POLYGON });
    expect(backend.getFilter()).toContain("<fes:Within><fes:ValueReference>geom</fes:ValueReference>");

    await backend.source.applyEdits(PARCEL_EDIT);
    expect(backend.getTransactionBody()).toContain("<geom><gml:Point");
    expect(backend.requests).not.toContain("DescribeFeatureType");
  });

  it("fails closed when the schema names no geometry rather than assuming the_geom", async () => {
    const backend = buildBackend({ describeFeatureType: NO_GEOMETRY_XSD });
    await expect(backend.source.query({ spatialFilter: WITHIN_POLYGON })).rejects.toMatchObject({
      reason: "unresolved-geometry-property",
    });
    await expect(backend.source.applyEdits(PARCEL_EDIT)).rejects.toBeInstanceOf(HonuaWfsProtocolError);
    // No request may go out on a guessed property name.
    expect(backend.requests).not.toContain("GetFeature");
    expect(backend.requests).not.toContain("Transaction");
  });

  it("fails closed when DescribeFeatureType itself is unreachable", async () => {
    const backend = buildBackend({ describeFeatureType: 500 });
    const rejection = backend.source.query({ spatialFilter: WITHIN_POLYGON });
    await expect(rejection).rejects.toBeInstanceOf(HonuaWfsProtocolError);
    await expect(rejection).rejects.toThrow(/locator\.geometryName/);
    expect(backend.requests).not.toContain("GetFeature");
  });

  it("keeps the bbox shortcut free of any schema round-trip", async () => {
    // `bbox=` addresses the default geometry positionally, so an
    // envelope-intersects query must not depend on DescribeFeatureType.
    const backend = buildBackend({ describeFeatureType: 500 });
    await backend.source.query({
      spatialFilter: {
        geometry: { xmin: -123, ymin: 37, xmax: -120, ymax: 45 },
        geometryType: "esriGeometryEnvelope",
        spatialRel: "esriSpatialRelIntersects",
      },
    });
    expect(backend.requests).toContain("GetFeature");
    expect(backend.requests).not.toContain("DescribeFeatureType");
  });
});
