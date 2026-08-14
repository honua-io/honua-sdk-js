import { describe, expect, it } from "vitest";

import {
  type AdapterKind,
  type CapabilityAwareSource,
  PROTOCOL_DEFAULT_CAPABILITIES,
  type SourceDescriptor,
  createDataset,
} from "../src/contract/index.js";
import type { FilterClause } from "../src/filter-registry/index.js";
import { createHonuaFeatureTable } from "../src/web-components/index.js";
import {
  PARCEL_FEATURES,
  type ParcelAttrs,
  geoservicesQueryResponse,
  jsonResponse,
  makeMockClient,
  odataMetadataResponse,
  odataParcelsResponse,
  ogcItemsResponse,
  wfsCapabilitiesXml,
  wfsGeoJsonResponse,
  xmlResponse,
} from "./contract/shared.js";

interface WireObservation {
  readonly offset: number;
  readonly limit: number;
  readonly sort: string | null;
  readonly filter: string | null;
}

interface ProtocolFixture {
  readonly adapterKind: AdapterKind;
  readonly expectedSort: string;
  readonly observations: WireObservation[];
  readonly source: CapabilityAwareSource<ParcelAttrs>;
}

const STATE_FILTER: FilterClause = {
  id: "state-ca",
  owner: { kind: "table", id: "protocol-matrix" },
  field: "STATE",
  operator: "=",
  value: "CA",
  effect: "filter",
};

const COLUMNS = [
  { field: "OBJECTID", label: "ID", type: "integer" as const },
  { field: "STATE", label: "State", type: "string" as const },
  { field: "ACRES", label: "Acres", type: "number" as const },
];

function fixtureRows(offset: number, limit: number, filtered: boolean) {
  const available = filtered ? PARCEL_FEATURES.filter((feature) => feature.attributes.STATE === "CA") : PARCEL_FEATURES;
  return { available, page: available.slice(offset, offset + limit) };
}

function sourceFrom(client: ReturnType<typeof makeMockClient>, descriptor: SourceDescriptor) {
  return createDataset({
    id: "feature-table-protocol-matrix",
    client,
    skipCompatibilityCheck: true,
    sources: [descriptor],
  }).source<ParcelAttrs>(descriptor.id)!;
}

function geoServicesFixture(): ProtocolFixture {
  const observations: WireObservation[] = [];
  const client = makeMockClient({
    routes: [
      [
        "/rest/services/Parcels/FeatureServer/0/query",
        (url) => {
          const offset = Number(url.searchParams.get("resultOffset") ?? "0");
          const limit = Number(url.searchParams.get("resultRecordCount") ?? "0");
          const filter = url.searchParams.get("where");
          const rows = fixtureRows(offset, limit, filter?.includes("STATE") === true);
          observations.push({
            offset,
            limit,
            sort: url.searchParams.get("orderByFields"),
            filter,
          });
          return jsonResponse(geoservicesQueryResponse(rows.page, offset + rows.page.length < rows.available.length));
        },
      ],
    ],
  });
  const descriptor = {
    id: "parcels-geoservices",
    protocol: "geoservices-feature-service",
    locator: { url: "https://mock/", serviceId: "Parcels", layerId: 0 },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
    schema: { primaryKey: "OBJECTID" },
  } satisfies SourceDescriptor;
  return {
    adapterKind: "geoservices-feature-service",
    expectedSort: "ACRES DESC",
    observations,
    source: sourceFrom(client, descriptor),
  };
}

function ogcFeaturesFixture(): ProtocolFixture {
  const observations: WireObservation[] = [];
  const client = makeMockClient({
    routes: [
      [
        "/ogc/features/collections/parcels/items",
        (url) => {
          const offset = Number(url.searchParams.get("offset") ?? "0");
          const limit = Number(url.searchParams.get("limit") ?? "0");
          const filter = url.searchParams.get("filter");
          const rows = fixtureRows(offset, limit, filter?.includes("STATE") === true);
          observations.push({ offset, limit, sort: url.searchParams.get("sortby"), filter });
          return jsonResponse({
            ...ogcItemsResponse(rows.page),
            numberMatched: rows.available.length,
            numberReturned: rows.page.length,
          });
        },
      ],
    ],
  });
  const descriptor = {
    id: "parcels-ogc",
    protocol: "ogc-features",
    locator: { url: "https://mock/", collectionId: "parcels" },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
    schema: { primaryKey: "OBJECTID" },
  } satisfies SourceDescriptor;
  return {
    adapterKind: "ogc-features",
    expectedSort: "-ACRES",
    observations,
    source: sourceFrom(client, descriptor),
  };
}

function wfsFixture(): ProtocolFixture {
  const observations: WireObservation[] = [];
  const client = makeMockClient({
    routes: [
      [
        "/wfs",
        (url) => {
          const request = url.searchParams.get("request");
          if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
          if (request !== "GetFeature") return new Response("not found", { status: 404 });
          const offset = Number(url.searchParams.get("startIndex") ?? "0");
          const limit = Number(url.searchParams.get("count") ?? "0");
          const filter = url.searchParams.get("filter") ?? url.searchParams.get("FILTER");
          const rows = fixtureRows(offset, limit, filter?.includes("STATE") === true);
          observations.push({ offset, limit, sort: url.searchParams.get("sortBy"), filter });
          return jsonResponse({
            ...wfsGeoJsonResponse(rows.page),
            numberMatched: rows.available.length,
            numberReturned: rows.page.length,
          });
        },
      ],
    ],
  });
  const descriptor = {
    id: "parcels-wfs",
    protocol: "wfs",
    locator: {
      url: "https://mock.honua.test/wfs",
      typeName: "parcels:lot",
      featureNamespace: "http://parcels.example.test/ns",
      geometryName: "the_geom",
    },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
    schema: { primaryKey: "OBJECTID" },
  } satisfies SourceDescriptor;
  return {
    adapterKind: "wfs",
    expectedSort: "ACRES D",
    observations,
    source: sourceFrom(client, descriptor),
  };
}

function odataFixture(): ProtocolFixture {
  const observations: WireObservation[] = [];
  const client = makeMockClient({
    routes: [
      ["/odata/$metadata", () => odataMetadataResponse()],
      [
        "/odata/Parcels",
        (url) => {
          const offset = Number(url.searchParams.get("$skip") ?? "0");
          const limit = Number(url.searchParams.get("$top") ?? "0");
          const filter = url.searchParams.get("$filter");
          const rows = fixtureRows(offset, limit, filter?.includes("STATE") === true);
          observations.push({ offset, limit, sort: url.searchParams.get("$orderby"), filter });
          return jsonResponse(odataParcelsResponse(rows.page, { count: rows.available.length }));
        },
      ],
    ],
  });
  const descriptor = {
    id: "parcels-odata",
    protocol: "odata",
    locator: { url: "https://mock/odata", entitySet: "Parcels" },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
    schema: { primaryKey: "OBJECTID" },
  } satisfies SourceDescriptor;
  return {
    adapterKind: "odata",
    expectedSort: "ACRES desc",
    observations,
    source: sourceFrom(client, descriptor),
  };
}

const PROTOCOL_CASES = [
  { label: "GeoServices", build: geoServicesFixture },
  { label: "OGC API Features", build: ogcFeaturesFixture },
  { label: "WFS 2.0", build: wfsFixture },
  { label: "OData v4", build: odataFixture },
] as const;

describe("feature table / real Source adapter protocol matrix", () => {
  it.each(PROTOCOL_CASES)("pushes bounded paging, sorting, and filtering through $label", async ({ build }) => {
    const fixture = build();
    expect(fixture.source.adapter(fixture.adapterKind)).toBeDefined();

    const table = createHonuaFeatureTable<ParcelAttrs>({
      source: fixture.source,
      sourceId: fixture.source.descriptor.id,
      columns: COLUMNS,
      budgets: { pageSize: 2, maxCachedRows: 4, windowOverscan: 0 },
    });

    const first = await table.refresh();
    expect(first.rows.flatMap((row) => (row ? [row.attributes.OBJECTID] : []))).toEqual([1, 2]);
    expect(first.ledger.rows).toBe(2);

    const secondPage = await table.setScroll({ scrollTop: 64, rowHeight: 32, viewportHeight: 32 });
    expect(secondPage.rows.flatMap((row) => (row ? [row.attributes.OBJECTID] : []))).toEqual([3]);

    await table.setScroll({ scrollTop: 0, rowHeight: 32, viewportHeight: 32 });
    await table.setSort([{ field: "ACRES", direction: "desc" }]);
    const filtered = await table.setFilters([STATE_FILTER]);
    expect(filtered.rows.flatMap((row) => (row ? [row.attributes.OBJECTID] : []))).toEqual([1, 2]);

    expect(fixture.observations).toHaveLength(4);
    expect(fixture.observations.map((observation) => observation.offset)).toEqual([0, 2, 0, 0]);
    expect(fixture.observations.every((observation) => observation.limit === 2)).toBe(true);
    expect(fixture.observations[2]?.sort).toBe(fixture.expectedSort);
    expect(fixture.observations[3]?.sort).toBe(fixture.expectedSort);
    expect(fixture.observations[3]?.filter).toContain("STATE");
    expect(fixture.observations[3]?.filter).toContain("CA");
    expect(filtered.ledger.rows).toBe(7);

    table.dispose();
  });
});
