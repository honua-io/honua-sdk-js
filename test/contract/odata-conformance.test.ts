/**
 * OData adapter conformance — translation rules and escape-hatch
 * surface. The cross-protocol parametric suite in
 * `test/contract/conformance.test.ts` covers the canonical Source
 * methods; this suite covers the dialect-specific surface
 * (`metadata()`, `batch()`, `apply()`, `search()`, `delta()`, `raw()`)
 * and the per-rule translation choices documented in the design.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROTOCOL_DEFAULT_CAPABILITIES,
  type SourceDescriptor,
  createDataset,
  odataSource,
} from "../../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";
import {
  HonuaOdataEntitySet,
  buildOdataSpatialFilter,
  parseOdataMetadata,
  rewriteWhereToOdataFilter,
} from "../../src/core/odata.js";
import { envelope } from "../../src/core/spatial-filter.js";

import {
  PARCEL_FEATURES,
  type ParcelAttrs,
  jsonResponse,
  makeMockClient,
  odataApplyResponse,
  odataBatchResponse,
  odataDeltaResponse,
  odataMetadataDocument,
  odataMetadataDocumentServerShape,
  odataMetadataResponse,
  odataMetadataResponseServerShape,
  odataParcelsResponse,
  odataServerFeaturesResponse,
} from "./shared.js";

describe("odata / parseOdataMetadata", () => {
  it("extracts entity sets, composite keys, spatial fields, and capabilities", () => {
    const meta = parseOdataMetadata(odataMetadataDocument());
    expect(meta.entitySets.Parcels).toBe("Parcel");
    expect(meta.keys.Parcel).toEqual(["LayerId", "ObjectId"]);
    expect(meta.fields.Parcel?.find((f) => f.name === "Geometry")?.isSpatial).toBe(true);
    expect(meta.fields.Parcel?.find((f) => f.name === "Geometry")?.srid).toBe(4326);
    expect(meta.capabilities.Parcels?.insert).toBe(true);
    expect(meta.capabilities.Parcels?.update).toBe(true);
    expect(meta.capabilities.Parcels?.delete).toBe(true);
    expect(meta.capabilities.Parcels?.batch).toBe(true);
  });

  it("merges sibling <Annotations Target=Container/EntitySet> blocks (honua-server shape)", () => {
    // Honua Server emits Capabilities.* annotations as siblings of
    // <EntityContainer>, not nested in <EntitySet>. The parser must
    // resolve `Target="Honua.Container/Features"` to the `Features`
    // entity-set capability bag and apply each annotation's PropertyValue
    // flag (e.g. ChangeTracking → Supported, ExpandRestrictions →
    // Expandable).
    const meta = parseOdataMetadata(odataMetadataDocumentServerShape());
    expect(meta.entitySets.Features).toBe("Feature");
    expect(meta.capabilities.Features?.filter).toBe(true);
    expect(meta.capabilities.Features?.search).toBe(true);
    expect(meta.capabilities.Features?.expand).toBe(true);
    // ChangeTracking → delta, derived from <PropertyValue Property="Supported" Bool="true"/>.
    expect(meta.capabilities.Features?.delta).toBe(true);
  });

  it("honors explicit Bool=false in sibling annotations (Supported property)", () => {
    const xml = `<?xml version="1.0"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Honua" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Feature">
        <Key><PropertyRef Name="ObjectId"/></Key>
        <Property Name="ObjectId" Type="Edm.Int64"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Features" EntityType="Honua.Feature"/>
      </EntityContainer>
      <Annotations Target="Honua.Container/Features">
        <Annotation Term="Capabilities.ChangeTracking">
          <Record><PropertyValue Property="Supported" Bool="false"/></Record>
        </Annotation>
      </Annotations>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
    const meta = parseOdataMetadata(xml);
    expect(meta.capabilities.Features?.delta).toBe(false);
  });
});

describe("odata / rewriteWhereToOdataFilter", () => {
  it("passes a native OData expression unchanged", () => {
    expect(rewriteWhereToOdataFilter("STATE eq 'CA'")).toBe("STATE eq 'CA'");
  });

  it("rewrites SQL-style equality and AND/OR/NOT", () => {
    expect(rewriteWhereToOdataFilter("STATE = 'CA' AND ACRES > 5")).toMatch(/STATE eq 'CA'/);
    expect(rewriteWhereToOdataFilter("STATE = 'CA' AND ACRES > 5")).toMatch(/ and /);
  });

  it("rewrites IS NULL / IS NOT NULL", () => {
    expect(rewriteWhereToOdataFilter("OWNER IS NULL")).toBe("OWNER eq null");
    expect(rewriteWhereToOdataFilter("OWNER IS NOT NULL")).toBe("OWNER ne null");
  });

  it("rejects unsupported operators rather than emitting a server-side parse error", () => {
    expect(() => rewriteWhereToOdataFilter("STATE has 'CA'")).toThrow(/has/);
    expect(() => rewriteWhereToOdataFilter("STATE in ('CA','OR')")).toThrow(/in/);
    expect(() => rewriteWhereToOdataFilter("isof(Geometry, 'Edm.Geography')")).toThrow(/isof/);
  });

  it("treats `1=1` as the empty filter", () => {
    expect(rewriteWhereToOdataFilter("1=1")).toBe("");
  });

  it("does not rewrite `=` inside quoted string literals", () => {
    // Regex applied across the whole string would corrupt the literal
    // `'A=B'` into `'A eq B'`. The tokenizer must skip quoted spans.
    expect(rewriteWhereToOdataFilter("NAME = 'A=B'")).toBe("NAME eq 'A=B'");
  });

  it("does not rewrite `<>` inside quoted string literals", () => {
    expect(rewriteWhereToOdataFilter("NAME = '<>'")).toBe("NAME eq '<>'");
  });

  it("does not flag unsupported operator words inside quoted string literals", () => {
    // `has` is on the unsupported-operator list; the literal `'has'`
    // must not trigger the rejection.
    expect(rewriteWhereToOdataFilter("NAME = 'has'")).toBe("NAME eq 'has'");
    expect(rewriteWhereToOdataFilter("NAME = 'cast(this)'")).toBe("NAME eq 'cast(this)'");
  });

  it("does not rewrite AND/OR/NOT keywords inside quoted string literals", () => {
    expect(rewriteWhereToOdataFilter("NAME = 'AND OR NOT'")).toBe("NAME eq 'AND OR NOT'");
  });

  it("preserves embedded `''` escape sequences inside quoted literals", () => {
    // OData v4 §5.1.1.6.1 — `''` is the escape for a single `'` inside a
    // string literal. `it''s` must round-trip unchanged.
    expect(rewriteWhereToOdataFilter("NAME = 'it''s'")).toBe("NAME eq 'it''s'");
  });

  it("rejects unsupported operators that appear outside any literal", () => {
    expect(() => rewriteWhereToOdataFilter("NAME = 'safe' AND OTHER has 'bad'")).toThrow(/has/);
  });
});

describe("odata / buildOdataSpatialFilter", () => {
  it("translates an envelope intersects to geo.intersects with a POLYGON WKT", () => {
    const filter = buildOdataSpatialFilter(envelope(-123, 37, -120, 45), {
      geometryColumn: "Geometry",
      inputSrid: 4326,
    });
    expect(filter).toBe(
      "geo.intersects(Geometry,geography'SRID=4326;POLYGON((-123 37, -120 37, -120 45, -123 45, -123 37))')",
    );
  });

  it("falls back to the metadata-derived geometry column when none is supplied", () => {
    const filter = buildOdataSpatialFilter(envelope(-123, 37, -120, 45), {
      geometryFields: [{ name: "Shape", type: "Edm.Geography", isSpatial: true, srid: 4326 }],
      inputSrid: 4326,
    });
    expect(filter).toMatch(/geo\.intersects\(Shape,/);
  });

  it("refuses an unsupported spatialRel rather than silently widening to bbox", () => {
    expect(() =>
      buildOdataSpatialFilter(
        { ...envelope(-123, 37, -120, 45), spatialRel: "esriSpatialRelWithin" },
        { geometryColumn: "Geometry" },
      ),
    ).toThrow(/spatialRel/);
  });

  it("emits geo.distance when spatialRel is esriSpatialRelDistance", () => {
    const filter = buildOdataSpatialFilter(
      {
        geometry: { x: -120, y: 38 },
        geometryType: "esriGeometryPoint",
        spatialRel: "esriSpatialRelDistance",
        distance: 5000,
      },
      { geometryColumn: "Geometry", inputSrid: 4326 },
    );
    expect(filter).toBe("geo.distance(Geometry,geography'SRID=4326;POINT(-120 38)') le 5000");
  });

  it("falls back to the SRID of the *selected* spatial field when multiple spatial fields are present", () => {
    // Entity has two spatial columns with different SRIDs. The caller
    // pinned `Boundary` (3857) via `geometryColumn`. The WKT must carry
    // the Boundary column's SRID, not the lexically-first `Location`
    // column's 4326 — otherwise the server would reproject 4326
    // longitudes against a column whose declared CRS is Web Mercator.
    const filter = buildOdataSpatialFilter(envelope(-13_700_000, 4_400_000, -13_400_000, 5_500_000), {
      geometryColumn: "Boundary",
      geometryFields: [
        { name: "Location", type: "Edm.Geography", isSpatial: true, srid: 4326 },
        { name: "Boundary", type: "Edm.Geometry", isSpatial: true, srid: 3857 },
      ],
    });
    expect(filter).toMatch(/geo\.intersects\(Boundary,/);
    expect(filter).toMatch(/SRID=3857;/);
    expect(filter).not.toMatch(/SRID=4326/);
  });

  it("omits the SRID prefix when the selected spatial field has no declared SRID rather than borrowing another column's", () => {
    // The pinned column exists but its CSDL `<Property>` did not carry
    // an `SRID=`. Using another spatial field's SRID would silently
    // mis-tag the literal; the safer path is to omit the SRID prefix
    // and let the column's server-declared default apply.
    const filter = buildOdataSpatialFilter(envelope(-123, 37, -120, 45), {
      geometryColumn: "Boundary",
      geometryFields: [
        { name: "Location", type: "Edm.Geography", isSpatial: true, srid: 4326 },
        { name: "Boundary", type: "Edm.Geometry", isSpatial: true },
      ],
    });
    expect(filter).toMatch(/geo\.intersects\(Boundary,/);
    expect(filter).not.toMatch(/SRID=/);
  });
});

describe("odata / canonical Source surface translation", () => {
  function build(
    routes: Array<[string | RegExp, (url: URL, init: RequestInit | undefined) => Response | Promise<Response>]>,
  ) {
    const client = makeMockClient({
      routes: [["/odata/$metadata", () => odataMetadataResponse()], ...routes],
    });
    const dataset = createDataset({
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
    });
    return dataset.source<ParcelAttrs>("parcels-odata")!;
  }

  it("query() lowers where/select/orderBy/top/skip onto $-prefixed query options", async () => {
    const captured: URL[] = [];
    const source = build([
      [
        "/odata/Parcels",
        (url) => {
          captured.push(url);
          return jsonResponse(odataParcelsResponse(PARCEL_FEATURES.slice(0, 2), { count: PARCEL_FEATURES.length }));
        },
      ],
    ]);
    const result = await source.query({
      where: "STATE = 'CA'",
      outFields: ["STATE", "ACRES"],
      orderBy: [{ field: "ACRES", direction: "desc" }],
      pagination: { offset: 0, limit: 2 },
    });
    const url = captured[0];
    expect(url.searchParams.get("$filter")).toBe("STATE eq 'CA'");
    expect(url.searchParams.get("$select")).toBe("STATE,ACRES");
    expect(url.searchParams.get("$orderby")).toBe("ACRES desc");
    expect(url.searchParams.get("$top")).toBe("2");
    expect(url.searchParams.get("$count")).toBe("true");
    expect(result.totalCount).toBe(PARCEL_FEATURES.length);
    expect(result.features).toHaveLength(2);
    expect(result.features[0].attributes.STATE).toBe("CA");
  });

  it("query() splits the Edm.Geography column out of attributes onto feature.geometry", async () => {
    const source = build([["/odata/Parcels", () => jsonResponse(odataParcelsResponse())]]);
    const result = await source.query();
    const first = result.features[0];
    expect(first.geometry).toBeTruthy();
    expect((first.attributes as unknown as Record<string, unknown>).Geometry).toBeUndefined();
  });

  it("queryAll() drains @odata.nextLink pages transparently", async () => {
    const source = build([
      [
        /\/odata\/Parcels(\?|$)/,
        (url) => {
          if (!url.searchParams.has("$skiptoken")) {
            return jsonResponse(
              odataParcelsResponse(PARCEL_FEATURES.slice(0, 2), {
                count: PARCEL_FEATURES.length,
                nextLink: "https://mock/odata/Parcels?$skiptoken=cursor-1",
              }),
            );
          }
          return jsonResponse(odataParcelsResponse(PARCEL_FEATURES.slice(2), { count: PARCEL_FEATURES.length }));
        },
      ],
    ]);
    const result = await source.queryAll();
    expect(result.features).toHaveLength(PARCEL_FEATURES.length);
    expect(result.totalCount).toBe(PARCEL_FEATURES.length);
  });

  it("queryAll({ pagination: { limit } }) stamps exceededTransferLimit when the server has more rows", async () => {
    const source = build([
      ["/odata/Parcels", () => jsonResponse(odataParcelsResponse(PARCEL_FEATURES, { count: PARCEL_FEATURES.length }))],
    ]);
    const result = await source.queryAll({ pagination: { limit: 1 } });
    expect(result.features).toHaveLength(1);
    expect(result.exceededTransferLimit).toBe(true);
  });

  it("stream() yields one Result per server page", async () => {
    let calls = 0;
    const source = build([
      [
        /\/odata\/Parcels(\?|$)/,
        (url) => {
          calls += 1;
          if (!url.searchParams.has("$skiptoken")) {
            return jsonResponse(
              odataParcelsResponse(PARCEL_FEATURES.slice(0, 1), {
                nextLink: "https://mock/odata/Parcels?$skiptoken=p2",
              }),
            );
          }
          return jsonResponse(odataParcelsResponse(PARCEL_FEATURES.slice(1)));
        },
      ],
    ]);
    const pages: number[] = [];
    for await (const page of source.stream()) pages.push(page.features.length);
    expect(pages).toEqual([1, 2]);
    expect(calls).toBe(2);
  });

  it("queryObjectIds() narrows $select to the metadata-derived key (composite → ObjectId)", async () => {
    let observedSelect: string | null = null;
    const source = build([
      [
        "/odata/Parcels",
        (url) => {
          observedSelect = url.searchParams.get("$select");
          return jsonResponse({
            value: PARCEL_FEATURES.map((f) => ({ ObjectId: f.attributes.OBJECTID })),
          });
        },
      ],
    ]);
    const ids = await source.queryObjectIds();
    expect(observedSelect).toBe("ObjectId");
    expect(ids).toEqual([1, 2, 3]);
  });

  it("queryObjectIds({ pagination: { limit } }) honors the limit even when the server returns more rows", async () => {
    // `entity.queryAll` respects `params.top` exactly, but a server may
    // return additional rows via `@odata.nextLink` without the canonical
    // surface adding a lookahead row of its own. The canonical
    // `queryObjectIds` must slice the projection to the requested limit
    // (mirrors the STAC adapter at src/contract/source.ts:842) so callers
    // asking for `limit: 1` do not receive 2 ids.
    const source = build([
      [
        /\/odata\/Parcels(\?|$)/,
        (url) => {
          if (!url.searchParams.has("$skiptoken")) {
            return jsonResponse({
              value: PARCEL_FEATURES.slice(0, 1).map((f) => ({ ObjectId: f.attributes.OBJECTID })),
              "@odata.nextLink": "https://mock/odata/Parcels?$skiptoken=p2",
            });
          }
          return jsonResponse({
            value: PARCEL_FEATURES.slice(1).map((f) => ({ ObjectId: f.attributes.OBJECTID })),
          });
        },
      ],
    ]);
    const ids = await source.queryObjectIds({ pagination: { limit: 1 } });
    expect(ids).toHaveLength(1);
    expect(ids).toEqual([1]);
  });

  it("queryObjectIds({ pagination: { limit: 0 } }) returns no ids even if the server returns rows", async () => {
    let observedTop: string | null = null;
    const source = build([
      [
        "/odata/Parcels",
        (url) => {
          observedTop = url.searchParams.get("$top");
          return jsonResponse({
            value: PARCEL_FEATURES.map((f) => ({ ObjectId: f.attributes.OBJECTID })),
            "@odata.nextLink": "https://mock/odata/Parcels?$skiptoken=p2",
          });
        },
      ],
    ]);
    const ids = await source.queryObjectIds({ pagination: { limit: 0 } });
    expect(observedTop).toBe("0");
    expect(ids).toEqual([]);
  });

  it("applyEdits() routes adds → POST, updates → PATCH, deletes → DELETE", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const source = build([
      [
        /\/odata\/Parcels/,
        (url, init) => {
          calls.push({ method: init?.method ?? "GET", path: url.pathname });
          if ((init?.method ?? "GET") === "POST") {
            return jsonResponse({ LayerId: 1, ObjectId: 99, STATE: "WA" });
          }
          return new Response(null, { status: 204 });
        },
      ],
    ]);
    const result = await source.applyEdits({
      adds: [{ attributes: { OBJECTID: 0, STATE: "WA", ACRES: 1 } as unknown as ParcelAttrs }],
      updates: [{ id: 1, attributes: { LayerId: 1, ObjectId: 1, STATE: "CA", ACRES: 99 } as unknown as ParcelAttrs }],
      // Composite-key entities address rows by `LayerId=…,ObjectId=…`.
      // The canonical `deletes: FeatureId[]` envelope accepts the
      // pre-formatted key expression so callers that already speak
      // OData's key syntax do not have to drop into the escape hatch.
      deletes: ["LayerId=1,ObjectId=3"],
    });
    expect(result.added[0].success).toBe(true);
    expect(result.updated[0].success).toBe(true);
    expect(result.deleted[0].success).toBe(true);
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("POST");
    expect(methods).toContain("PATCH");
    expect(methods).toContain("DELETE");
  });

  it("queryAggregate / queryExtent / queryRelated throw on the canonical surface", async () => {
    const source = build([["/odata/Parcels", () => jsonResponse(odataParcelsResponse())]]);
    await expect(source.queryAggregate({ aggregation: { metrics: [{ fn: "sum", field: "ACRES" }] } })).rejects.toThrow(
      HonuaCapabilityNotSupportedError,
    );
    await expect(source.queryExtent()).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(source.queryRelated({ relationshipId: 0, sourceIds: [1] })).rejects.toThrow(
      HonuaCapabilityNotSupportedError,
    );
  });

  it("translates Query.spatialFilter into a geo.intersects $filter with WKT + SRID", async () => {
    let observedFilter: string | null = null;
    const source = build([
      [
        "/odata/Parcels",
        (url) => {
          observedFilter = url.searchParams.get("$filter");
          return jsonResponse(odataParcelsResponse());
        },
      ],
    ]);
    await source.query({
      spatialFilter: envelope(-123, 37, -120, 45),
      outSr: 4326,
    });
    expect(observedFilter).toMatch(/^geo\.intersects\(Geometry,geography'SRID=4326;POLYGON/);
  });
});

describe("odata / capability negotiation via $metadata", () => {
  it("intersects declared capabilities with what $metadata advertises and refuses missing applyEdits", async () => {
    // Same Parcels entity, but every edit annotation is False — the
    // adapter intersects with the descriptor's declared `applyEdits` and
    // refuses the operation rather than letting the wire request fail
    // with a server-side 405.
    const readOnlyMetadata = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Honua.OData" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Parcel">
        <Key><PropertyRef Name="ObjectId"/></Key>
        <Property Name="ObjectId" Type="Edm.Int64" Nullable="false"/>
        <Property Name="STATE" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Parcels" EntityType="Honua.OData.Parcel">
          <Annotation Term="Org.OData.Capabilities.V1.InsertRestrictions">
            <Record><PropertyValue Property="Insertable" Bool="false"/></Record>
          </Annotation>
          <Annotation Term="Org.OData.Capabilities.V1.UpdateRestrictions">
            <Record><PropertyValue Property="Updatable" Bool="false"/></Record>
          </Annotation>
          <Annotation Term="Org.OData.Capabilities.V1.DeleteRestrictions">
            <Record><PropertyValue Property="Deletable" Bool="false"/></Record>
          </Annotation>
        </EntitySet>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
    const client = makeMockClient({
      routes: [
        [
          "/odata/$metadata",
          () => new Response(readOnlyMetadata, { status: 200, headers: { "Content-Type": "application/xml" } }),
        ],
        ["/odata/Parcels", () => jsonResponse(odataParcelsResponse())],
      ],
    });
    const source = odataSource<ParcelAttrs>(
      {
        id: "parcels-odata",
        protocol: "odata",
        locator: { url: "https://mock/odata", entitySet: "Parcels" },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
      },
      client,
      "strict",
    );
    await expect(source.applyEdits({ deletes: [1] })).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });
});

describe("odata / typed escape hatch (HonuaOdataEntitySet)", () => {
  function buildEntity(
    routes: Array<[string | RegExp, (url: URL, init: RequestInit | undefined) => Response | Promise<Response>]>,
  ) {
    // Honor the caller's metadata route override when supplied (the
    // `makeMockClient` matcher is first-match-wins, so user routes have
    // to come before the default).
    const hasMetadataOverride = routes.some(([m]) => typeof m === "string" && m.includes("$metadata"));
    const client = makeMockClient({
      routes: hasMetadataOverride
        ? [...routes, ["/odata/$metadata", () => odataMetadataResponse()]]
        : [["/odata/$metadata", () => odataMetadataResponse()], ...routes],
    });
    return new HonuaOdataEntitySet({ client, entitySet: "Parcels" });
  }

  afterEach(() => vi.restoreAllMocks());

  it("metadata() caches per entity-set instance (single fetch on repeat)", async () => {
    let calls = 0;
    const entity = buildEntity([
      [
        "/odata/$metadata",
        () => {
          calls += 1;
          return odataMetadataResponse();
        },
      ],
    ]);
    await entity.metadata();
    await entity.metadata();
    expect(calls).toBe(1);
  });

  it("batch() submits the OData JSON batch envelope with per-request atomicityGroup for atomic groups", async () => {
    let body: unknown;
    const entity = buildEntity([
      [
        "/odata/$batch",
        async (_url, init) => {
          body = JSON.parse(String(init?.body ?? "{}"));
          return jsonResponse(odataBatchResponse());
        },
      ],
    ]);
    const result = await entity.batch(
      [
        { method: "PATCH", url: "Parcels(LayerId=1,ObjectId=1)", body: { STATE: "CA" } },
        { method: "DELETE", url: "Parcels(LayerId=1,ObjectId=2)" },
      ],
      { atomicity: "all" },
    );
    expect(result.responses).toHaveLength(2);
    expect(result.responses[0].status).toBe(200);
    expect(result.responses[1].status).toBe(204);
    // Honua Server's `ODataBatchHandler` groups requests by
    // `request.AtomicityGroup`; a root-level array is ignored. The same
    // group token is stamped on every request so the change-set runs
    // atomically server-side.
    const payload = body as {
      atomicityGroup?: unknown;
      requests?: Array<{ method: string; atomicityGroup?: string }>;
    };
    expect(payload.atomicityGroup).toBeUndefined();
    expect(payload.requests).toHaveLength(2);
    const groups = payload.requests?.map((r) => r.atomicityGroup);
    expect(groups?.[0]).toBeTruthy();
    expect(groups?.[0]).toBe(groups?.[1]);
  });

  it("batch() omits atomicityGroup when atomicity is unset (independent operations)", async () => {
    let body: unknown;
    const entity = buildEntity([
      [
        "/odata/$batch",
        async (_url, init) => {
          body = JSON.parse(String(init?.body ?? "{}"));
          return jsonResponse(odataBatchResponse());
        },
      ],
    ]);
    await entity.batch([
      { method: "PATCH", url: "Parcels(LayerId=1,ObjectId=1)", body: { STATE: "CA" } },
      { method: "DELETE", url: "Parcels(LayerId=1,ObjectId=2)" },
    ]);
    const payload = body as { requests?: Array<{ atomicityGroup?: string }> };
    expect(payload.requests?.every((r) => r.atomicityGroup === undefined)).toBe(true);
  });

  it("queryAll({ top: 0 }) respects the hard cap before collecting any rows", async () => {
    let calls = 0;
    const entity = buildEntity([
      [
        "/odata/Parcels",
        (url) => {
          calls += 1;
          expect(url.searchParams.get("$top")).toBe("0");
          return jsonResponse(
            odataParcelsResponse(PARCEL_FEATURES.slice(0, 2), {
              count: PARCEL_FEATURES.length,
              nextLink: "https://mock/odata/Parcels?$skiptoken=p2",
            }),
          );
        },
      ],
    ]);
    const result = await entity.queryAll({ top: 0, count: true });
    expect(result.rows).toEqual([]);
    expect(result.totalCount).toBe(PARCEL_FEATURES.length);
    expect(calls).toBe(1);
  });

  it("apply() returns SDK-shaped aggregate rows and forwards $apply", async () => {
    let observedApply: string | null = null;
    const entity = buildEntity([
      [
        "/odata/Parcels",
        (url) => {
          observedApply = url.searchParams.get("$apply");
          return jsonResponse(odataApplyResponse());
        },
      ],
    ]);
    const result = await entity.apply("groupby((STATE),aggregate(ACRES with sum as SumAcres))");
    expect(observedApply).toBe("groupby((STATE),aggregate(ACRES with sum as SumAcres))");
    expect(result.rows).toHaveLength(2);
    expect((result.rows[0] as { STATE: string }).STATE).toBe("CA");
  });

  it("search() forwards $search and returns a HonuaOdataPage", async () => {
    let observedSearch: string | null = null;
    const entity = buildEntity([
      [
        "/odata/Parcels",
        (url) => {
          observedSearch = url.searchParams.get("$search");
          return jsonResponse(odataParcelsResponse());
        },
      ],
    ]);
    const page = await entity.search<ParcelAttrs>("santa");
    expect(observedSearch).toBe("santa");
    expect(page.rows.length).toBeGreaterThan(0);
  });

  it("delta() yields pages and surfaces the final @odata.deltaLink", async () => {
    const entity = buildEntity([["/odata/Parcels", () => jsonResponse(odataDeltaResponse())]]);
    const pages: Array<{ deltaLink?: string }> = [];
    for await (const page of entity.delta<ParcelAttrs>()) pages.push(page);
    expect(pages).toHaveLength(1);
    expect(pages[0].deltaLink).toContain("$deltatoken=");
  });

  it("raw() routes through the configured fetchFn so auth/retry/telemetry stay centralized", async () => {
    let observedPath: string | undefined;
    const entity = buildEntity([
      [
        "/odata/Parcels/$count",
        (url) => {
          observedPath = url.pathname;
          return new Response("42", { status: 200 });
        },
      ],
    ]);
    const response = await entity.raw("GET", "/odata/Parcels/$count");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("42");
    expect(observedPath).toBe("/odata/Parcels/$count");
  });
});

describe("odata / pipeline integrity", () => {
  it("query requests do NOT inject f=json (server rejects unknown query options)", async () => {
    const captured: URL[] = [];
    const client = makeMockClient({
      routes: [
        ["/odata/$metadata", () => odataMetadataResponse()],
        [
          "/odata/Parcels",
          (url) => {
            captured.push(url);
            return jsonResponse(odataParcelsResponse());
          },
        ],
      ],
    });
    const dataset = createDataset({
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
    });
    const source = dataset.source<ParcelAttrs>("parcels-odata")!;
    await source.query({ where: "STATE = 'CA'" });
    expect(captured).toHaveLength(1);
    // Honua Server's OData validators reject any query option that is
    // not in `AllowedQueryParameters`. `f` is not in any of the OData
    // sets, so its presence would cause `InvalidQueryOption`.
    expect(captured[0].searchParams.has("f")).toBe(false);
  });

  it("metadata fetch flows through HonuaClient defaultHeaders so auth survives", async () => {
    let observedAuth: string | null = null;
    const client = new (await import("../../src/core/client.js")).HonuaClient({
      baseUrl: "https://mock.honua.test",
      bearerToken: "test-token",
      fetchFn: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/$metadata")) {
          const headers = new Headers(init?.headers);
          observedAuth = headers.get("Authorization");
          return odataMetadataResponse();
        }
        return jsonResponse(odataParcelsResponse());
      },
    });
    const entity = new HonuaOdataEntitySet({ client, entitySet: "Parcels" });
    await entity.metadata();
    expect(observedAuth).toBe("Bearer test-token");
  });

  it("raw() flows through HonuaClient defaultHeaders so auth survives", async () => {
    let observedAuth: string | null = null;
    const client = new (await import("../../src/core/client.js")).HonuaClient({
      baseUrl: "https://mock.honua.test",
      apiKey: "ak-test",
      fetchFn: async (_input, init) => {
        const headers = new Headers(init?.headers);
        observedAuth = headers.get("X-API-Key");
        return new Response("42", { status: 200 });
      },
    });
    const entity = new HonuaOdataEntitySet({ client, entitySet: "Parcels" });
    await entity.raw("GET", "/odata/Parcels/$count");
    expect(observedAuth).toBe("ak-test");
  });
});

describe("odata / canonical contract honor (review fixes)", () => {
  function buildSource(
    routes: Array<[string | RegExp, (url: URL, init: RequestInit | undefined) => Response | Promise<Response>]>,
  ) {
    const client = makeMockClient({
      routes: [["/odata/$metadata", () => odataMetadataResponse()], ...routes],
    });
    const dataset = createDataset({
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
    });
    return dataset.source<ParcelAttrs>("parcels-odata")!;
  }

  it("queryAll() proves truncation by @odata.count when the server respects $top exactly", async () => {
    // Server returns exactly $top rows + count > limited.length, no
    // nextLink. Old behavior: exceededTransferLimit = false (bug). New:
    // count comparison sets the flag.
    const source = buildSource([
      [
        "/odata/Parcels",
        (url) => {
          const top = Number(url.searchParams.get("$top") ?? "0");
          // Honor $top exactly so the rows-collected check would miss.
          const slice = PARCEL_FEATURES.slice(0, top);
          return jsonResponse(odataParcelsResponse(slice, { count: PARCEL_FEATURES.length }));
        },
      ],
    ]);
    // Lookahead: contract-layer should send $top=2 (limit + 1) so the
    // server returns 2 rows, applyQueryAllLimit trims to 1 and stamps
    // exceededTransferLimit on rows-collected. Belt-and-braces: the
    // count signal also fires.
    const result = await source.queryAll({ pagination: { limit: 1 } });
    expect(result.features).toHaveLength(1);
    expect(result.exceededTransferLimit).toBe(true);
    expect(result.totalCount).toBe(PARCEL_FEATURES.length);
  });

  it("queryAll() lookahead row sizes the server request to limit + 1", async () => {
    const captured: URL[] = [];
    const source = buildSource([
      [
        "/odata/Parcels",
        (url) => {
          captured.push(url);
          return jsonResponse(odataParcelsResponse(PARCEL_FEATURES.slice(0, 2)));
        },
      ],
    ]);
    await source.queryAll({ pagination: { limit: 1 } });
    expect(captured[0].searchParams.get("$top")).toBe("2");
  });

  it("query() with returnGeometry: false drops the geometry column from the canonical Result", async () => {
    const source = buildSource([["/odata/Parcels", () => jsonResponse(odataParcelsResponse())]]);
    const result = await source.query({ returnGeometry: false });
    for (const f of result.features) expect(f.geometry).toBeNull();
  });

  it("query() with returnGeometry: false (no outFields) builds $select from metadata excluding spatial fields", async () => {
    let observedSelect: string | null = null;
    const source = buildSource([
      [
        "/odata/Parcels",
        (url) => {
          observedSelect = url.searchParams.get("$select");
          return jsonResponse(odataParcelsResponse());
        },
      ],
    ]);
    await source.query({ returnGeometry: false });
    // Metadata declares LayerId, ObjectId, STATE, ACRES, Geometry. The
    // $select should include the four non-spatial fields and exclude
    // Geometry so the server never sends it on the wire.
    expect(observedSelect).toBeTruthy();
    expect(observedSelect!.split(",")).toEqual(expect.arrayContaining(["LayerId", "ObjectId", "STATE", "ACRES"]));
    expect(observedSelect).not.toContain("Geometry");
  });

  it("spatialFilter uses INPUT SR (geometry.spatialReference.wkid), not Query.outSr", async () => {
    let observedFilter: string | null = null;
    const source = buildSource([
      [
        "/odata/Parcels",
        (url) => {
          observedFilter = url.searchParams.get("$filter");
          return jsonResponse(odataParcelsResponse());
        },
      ],
    ]);
    // Caller passes a 4326-coordinate envelope but asks for outSr=3857.
    // The WKT literal must carry the INPUT SR (4326), not the requested
    // output SR (3857). Otherwise the server would interpret 4326
    // longitudes as Web Mercator metres.
    const env4326 = envelope(-123, 37, -120, 45, { wkid: 4326 });
    await source.query({ spatialFilter: env4326, outSr: 3857 });
    expect(observedFilter).toMatch(/SRID=4326;POLYGON/);
    expect(observedFilter).not.toMatch(/SRID=3857/);
  });

  it("spatialFilter falls back to metadata SRID when the geometry has no spatialReference", async () => {
    let observedFilter: string | null = null;
    const source = buildSource([
      [
        "/odata/Parcels",
        (url) => {
          observedFilter = url.searchParams.get("$filter");
          return jsonResponse(odataParcelsResponse());
        },
      ],
    ]);
    // No spatialReference on the envelope and no inputSrid override —
    // the metadata-declared SRID (4326) on the Geometry field takes over.
    await source.query({ spatialFilter: envelope(-123, 37, -120, 45) });
    expect(observedFilter).toMatch(/SRID=4326;/);
  });

  it("applyEdits({ rollbackOnFailure: true }) collapses to a single atomic $batch when batch is advertised", async () => {
    let batchBody: unknown;
    let perCallCount = 0;
    const source = buildSource([
      [
        "/odata/$batch",
        async (_url, init) => {
          batchBody = JSON.parse(String(init?.body ?? "{}"));
          return jsonResponse({
            responses: [
              { id: "1", status: 201, body: { LayerId: 1, ObjectId: 99, STATE: "WA" } },
              { id: "2", status: 200, body: { LayerId: 1, ObjectId: 1, STATE: "CA" } },
              { id: "3", status: 204 },
            ],
          });
        },
      ],
      [
        /\/odata\/Parcels(\(|$)/,
        () => {
          perCallCount += 1;
          return new Response(null, { status: 204 });
        },
      ],
    ]);
    const result = await source.applyEdits({
      adds: [{ attributes: { OBJECTID: 0, STATE: "WA", ACRES: 1 } as unknown as ParcelAttrs }],
      updates: [{ id: 1, attributes: { LayerId: 1, ObjectId: 1, STATE: "CA", ACRES: 99 } as unknown as ParcelAttrs }],
      deletes: ["LayerId=1,ObjectId=3"],
      rollbackOnFailure: true,
    });
    // No per-call edits should have leaked through — the $batch took
    // every operation.
    expect(perCallCount).toBe(0);
    // All three operations stamped with the same atomicityGroup.
    const payload = batchBody as {
      requests?: Array<{ method: string; atomicityGroup?: string }>;
    };
    expect(payload.requests).toHaveLength(3);
    const groups = payload.requests?.map((r) => r.atomicityGroup);
    expect(new Set(groups).size).toBe(1);
    expect(result.added[0].success).toBe(true);
    expect(result.added[0].id).toBe(99);
    expect(result.updated[0].success).toBe(true);
    expect(result.deleted[0].success).toBe(true);
  });

  it("applyEdits({ rollbackOnFailure: true }) propagates per-row failures from a failing atomic batch", async () => {
    const source = buildSource([
      [
        "/odata/$batch",
        () =>
          jsonResponse({
            responses: [
              { id: "1", status: 201, body: { LayerId: 1, ObjectId: 99 } },
              {
                id: "2",
                status: 422,
                body: { error: { message: "STATE must not be empty" } },
              },
            ],
          }),
      ],
    ]);
    const result = await source.applyEdits({
      adds: [{ attributes: { OBJECTID: 0, STATE: "WA", ACRES: 1 } as unknown as ParcelAttrs }],
      updates: [{ id: 1, attributes: { LayerId: 1, ObjectId: 1, STATE: "" } as unknown as ParcelAttrs }],
      rollbackOnFailure: true,
    });
    expect(result.added[0].success).toBe(true);
    expect(result.updated[0].success).toBe(false);
    expect(result.updated[0].error?.code).toBe(422);
    expect(result.updated[0].error?.description).toContain("STATE must not be empty");
  });

  it("applyEdits({ rollbackOnFailure: true }) degrades when the server does not advertise $batch", async () => {
    // Override $metadata with a document where BatchSupported = false.
    const noBatchMetadata = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Honua.OData" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Parcel">
        <Key><PropertyRef Name="ObjectId"/></Key>
        <Property Name="ObjectId" Type="Edm.Int64" Nullable="false"/>
        <Property Name="STATE" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Parcels" EntityType="Honua.OData.Parcel">
          <Annotation Term="Org.OData.Capabilities.V1.BatchSupported" Bool="false"/>
        </EntitySet>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
    const client = makeMockClient({
      routes: [
        [
          "/odata/$metadata",
          () => new Response(noBatchMetadata, { status: 200, headers: { "Content-Type": "application/xml" } }),
        ],
        [
          /\/odata\/Parcels/,
          (_url, init) => {
            if ((init?.method ?? "GET") === "POST") return jsonResponse({ ObjectId: 99, STATE: "WA" });
            return new Response(null, { status: 204 });
          },
        ],
      ],
    });
    const source = odataSource<ParcelAttrs>(
      {
        id: "parcels-odata",
        protocol: "odata",
        locator: { url: "https://mock/odata", entitySet: "Parcels" },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
      },
      client,
      "strict",
    );
    const result = await source.applyEdits({
      adds: [{ attributes: { OBJECTID: 0, STATE: "WA", ACRES: 1 } as unknown as ParcelAttrs }],
      rollbackOnFailure: true,
    });
    expect(result.added[0].success).toBe(true);
    expect(result.degraded).toBeDefined();
    expect(result.degraded?.[0].capability).toBe("applyEdits");
    expect(result.degraded?.[0].reason).toContain("rollbackOnFailure");
  });
});

describe("odata / server-shaped locator (url + layerId, no entitySet)", () => {
  it("derives the canonical /odata/Layers(<layerId>)/Features path from layerId alone", async () => {
    // Honua Server's `SourceLocator` only carries `url`, `serviceId`,
    // `layerId` — no `entitySet`. The OData routes are layer-scoped:
    // `/odata/Layers({layerId})/Features`. The adapter must derive that
    // path from `layerId` so a server-shipped binding can hit the wire
    // without the SDK throwing on a missing `entitySet`.
    const captured: URL[] = [];
    const client = makeMockClient({
      routes: [
        ["/odata/$metadata", () => odataMetadataResponseServerShape()],
        [
          /\/odata\/Layers\(1\)\/Features/,
          (url) => {
            captured.push(url);
            return jsonResponse(odataServerFeaturesResponse());
          },
        ],
      ],
    });
    const source = odataSource<ParcelAttrs>(
      {
        id: "layer-1",
        protocol: "odata",
        // Server-shaped locator: url + layerId, no entitySet.
        locator: { url: "https://mock/odata", layerId: 1 },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
      },
      client,
      "strict",
    );
    const result = await source.query();
    expect(result.features).toHaveLength(PARCEL_FEATURES.length);
    expect(captured).toHaveLength(1);
    expect(captured[0].pathname).toBe("/odata/Layers(1)/Features");
  });

  it("looks up capability negotiation by simple entity-set name (Features), not layer-scoped path", async () => {
    // The metadata maps `Honua.Container/Features` → `Features`
    // capabilities. With a server-shaped locator the adapter materializes
    // `entitySet = "Layers(1)/Features"` for HTTP, but capability lookups
    // must target the simple name `Features` so advertised flags
    // (Filterable, Searchable, etc.) still gate the canonical surface.
    let metadataHits = 0;
    const client = makeMockClient({
      routes: [
        [
          "/odata/$metadata",
          () => {
            metadataHits += 1;
            return odataMetadataResponseServerShape();
          },
        ],
        [/\/odata\/Layers\(1\)\/Features/, () => jsonResponse(odataServerFeaturesResponse())],
      ],
    });
    const source = odataSource<ParcelAttrs>(
      {
        id: "layer-1",
        protocol: "odata",
        locator: { url: "https://mock/odata", layerId: 1 },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
      },
      client,
      "strict",
    );
    // First call materializes metadata; capability negotiation succeeds
    // because `Features` is found in the parsed sibling annotations.
    await source.query({ where: "STATE eq 'CA'" });
    expect(metadataHits).toBe(1);
  });

  it("rejects an OData descriptor that has neither entitySet nor layerId", () => {
    const client = makeMockClient({ routes: [] });
    expect(() =>
      odataSource(
        {
          id: "broken-odata",
          protocol: "odata",
          locator: { url: "https://mock/odata" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
        },
        client,
        "strict",
      ),
    ).toThrow(/locator\.entitySet or locator\.layerId/);
  });

  it("applyEdits update with a bare ObjectId targets /odata/Layers(<n>)/Features(<id>) directly", async () => {
    // Server-shaped locator + composite metadata key (LayerId, ObjectId).
    // The LayerId is already in the URL path, so the entity-set key
    // parens should carry only the ObjectId. A caller passing a bare
    // numeric `feature.id` must produce a clean PATCH URL rather than
    // failing the canonicalKeyToOdata `LayerId` lookup.
    const calls: Array<{ method: string; path: string }> = [];
    const client = makeMockClient({
      routes: [
        ["/odata/$metadata", () => odataMetadataResponseServerShape()],
        [
          /\/odata\/Layers\(1\)\/Features\(\d+\)/,
          (url, init) => {
            calls.push({ method: init?.method ?? "GET", path: url.pathname });
            return new Response(null, { status: 204 });
          },
        ],
      ],
    });
    const source = odataSource<ParcelAttrs>(
      {
        id: "layer-1",
        protocol: "odata",
        locator: { url: "https://mock/odata", layerId: 1 },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
      },
      client,
      "strict",
    );
    const result = await source.applyEdits({
      updates: [{ id: 5, attributes: { STATE: "CA", ACRES: 7 } as unknown as ParcelAttrs }],
    });
    expect(result.updated[0].success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "PATCH", path: "/odata/Layers(1)/Features(5)" });
  });

  it("applyEdits delete with a bare ObjectId targets /odata/Layers(<n>)/Features(<id>) directly", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const client = makeMockClient({
      routes: [
        ["/odata/$metadata", () => odataMetadataResponseServerShape()],
        [
          /\/odata\/Layers\(1\)\/Features\(\d+\)/,
          (url, init) => {
            calls.push({ method: init?.method ?? "GET", path: url.pathname });
            return new Response(null, { status: 204 });
          },
        ],
      ],
    });
    const source = odataSource<ParcelAttrs>(
      {
        id: "layer-1",
        protocol: "odata",
        locator: { url: "https://mock/odata", layerId: 1 },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
      },
      client,
      "strict",
    );
    const result = await source.applyEdits({ deletes: [3] });
    expect(result.deleted[0].success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: "DELETE", path: "/odata/Layers(1)/Features(3)" });
  });
});

describe("odata / HonuaOdataEntitySet path metadata", () => {
  it("entitySet vs entitySetName: direct identifier round-trips unchanged", () => {
    const client = makeMockClient({ routes: [] });
    const entity = new HonuaOdataEntitySet({ client, entitySet: "Parcels" });
    expect(entity.entitySet).toBe("Parcels");
    expect(entity.entitySetName).toBe("Parcels");
  });

  it("entitySetName collapses navigation paths to their trailing segment", () => {
    const client = makeMockClient({ routes: [] });
    const entity = new HonuaOdataEntitySet({
      client,
      entitySet: "Layers(42)/Features",
    });
    expect(entity.entitySet).toBe("Layers(42)/Features");
    expect(entity.entitySetName).toBe("Features");
  });
});

describe("odata / SQL comparison operator rewriting (review fix)", () => {
  it("rewrites SQL `>` / `<` / `>=` / `<=` to OData `gt` / `lt` / `ge` / `le`", () => {
    expect(rewriteWhereToOdataFilter("ACRES > 10")).toBe("ACRES gt 10");
    expect(rewriteWhereToOdataFilter("ACRES < 10")).toBe("ACRES lt 10");
    expect(rewriteWhereToOdataFilter("ACRES >= 10")).toBe("ACRES ge 10");
    expect(rewriteWhereToOdataFilter("ACRES <= 10")).toBe("ACRES le 10");
  });

  it("translates the README-style mixed predicate end-to-end", () => {
    // Honua Server's OData lexer rejects `>` as `InvalidQueryOption`.
    // The README publishes `STATE = 'CA' AND ACRES > 10` as a working
    // example, so the rewriter must produce a valid OData $filter.
    expect(rewriteWhereToOdataFilter("STATE = 'CA' AND ACRES > 10")).toBe("STATE eq 'CA' and ACRES gt 10");
  });

  it("does not split `<>` into `lt`/`gt` (not-equal stays as `ne`)", () => {
    expect(rewriteWhereToOdataFilter("STATE <> 'CA'")).toBe("STATE ne 'CA'");
  });

  it("does not rewrite comparison operators inside quoted string literals", () => {
    expect(rewriteWhereToOdataFilter("NAME = 'A>B'")).toBe("NAME eq 'A>B'");
    expect(rewriteWhereToOdataFilter("NAME = 'A<=B'")).toBe("NAME eq 'A<=B'");
  });
});

describe("odata / outFields → $select + $expand (review fix)", () => {
  function buildSource(
    routes: Array<[string | RegExp, (url: URL, init: RequestInit | undefined) => Response | Promise<Response>]>,
  ) {
    const client = makeMockClient({
      routes: [["/odata/$metadata", () => odataMetadataResponse()], ...routes],
    });
    const dataset = createDataset({
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
    });
    return dataset.source<ParcelAttrs>("parcels-odata")!;
  }

  it("translates a single dotted outField into $expand=Owner($select=name) and an empty/no $select", async () => {
    let observedSelect: string | null = null;
    let observedExpand: string | null = null;
    const source = buildSource([
      [
        "/odata/Parcels",
        (url) => {
          observedSelect = url.searchParams.get("$select");
          observedExpand = url.searchParams.get("$expand");
          return jsonResponse(odataParcelsResponse());
        },
      ],
    ]);
    await source.query({ outFields: ["Owner.name"] });
    expect(observedSelect).toBeNull();
    expect(observedExpand).toBe("Owner($select=name)");
  });

  it("groups multiple fields under the same navigation property into one $expand entry", async () => {
    let observedSelect: string | null = null;
    let observedExpand: string | null = null;
    const source = buildSource([
      [
        "/odata/Parcels",
        (url) => {
          observedSelect = url.searchParams.get("$select");
          observedExpand = url.searchParams.get("$expand");
          return jsonResponse(odataParcelsResponse());
        },
      ],
    ]);
    await source.query({ outFields: ["STATE", "Owner.name", "Owner.email"] });
    expect(observedSelect).toBe("STATE");
    expect(observedExpand).toBe("Owner($select=name,email)");
  });

  it("nests multi-level dotted paths as $expand=Owner($expand=address($select=street))", async () => {
    let observedExpand: string | null = null;
    const source = buildSource([
      [
        "/odata/Parcels",
        (url) => {
          observedExpand = url.searchParams.get("$expand");
          return jsonResponse(odataParcelsResponse());
        },
      ],
    ]);
    await source.query({ outFields: ["Owner.address.street"] });
    expect(observedExpand).toBe("Owner($expand=address($select=street))");
  });

  it("excludes the geometry column from $select even when other dotted outFields project navigations", async () => {
    let observedSelect: string | null = null;
    let observedExpand: string | null = null;
    const source = buildSource([
      [
        "/odata/Parcels",
        (url) => {
          observedSelect = url.searchParams.get("$select");
          observedExpand = url.searchParams.get("$expand");
          return jsonResponse(odataParcelsResponse());
        },
      ],
    ]);
    await source.query({
      outFields: ["STATE", "Geometry", "Owner.name"],
      returnGeometry: false,
    });
    // Geometry is dropped from the root select; the navigation expand is preserved.
    expect(observedSelect).toBe("STATE");
    expect(observedExpand).toBe("Owner($select=name)");
  });
});

describe("odata / geometry-field resolution honors descriptor.schema (review fix)", () => {
  function buildSchemaSource(
    metadataDoc: string,
    routes: Array<[string | RegExp, (url: URL, init: RequestInit | undefined) => Response | Promise<Response>]>,
  ) {
    const client = makeMockClient({
      routes: [
        [
          "/odata/$metadata",
          () => new Response(metadataDoc, { status: 200, headers: { "Content-Type": "application/xml" } }),
        ],
        ...routes,
      ],
    });
    const dataset = createDataset({
      id: "places",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "places-odata",
          protocol: "odata",
          locator: { url: "https://mock/odata", entitySet: "Places" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
          // Caller-supplied schema names the geometry column "Location",
          // which is neither `Geometry` nor `Geography` nor `Shape`.
          schema: {
            fields: [
              { name: "OBJECTID", type: "esriFieldTypeOID" },
              { name: "STATE", type: "esriFieldTypeString" },
              { name: "Location", type: "esriFieldTypeGeometry" },
            ],
          },
        } satisfies SourceDescriptor,
      ],
    });
    return dataset.source("places-odata")!;
  }

  // Metadata where the `Place` type names its spatial column `Location`
  // and the `Places` entity-set carries a SRID-stamped declaration. The
  // adapter must honor this name end-to-end (spatial filter, $select
  // dropping when returnGeometry=false, row split).
  const metadataLocation = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Honua.OData" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Place">
        <Key><PropertyRef Name="OBJECTID"/></Key>
        <Property Name="OBJECTID" Type="Edm.Int64" Nullable="false"/>
        <Property Name="STATE" Type="Edm.String"/>
        <Property Name="Location" Type="Edm.Geography" SRID="4326"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Places" EntityType="Honua.OData.Place"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it("emits geo.intersects against the schema-declared `Location` column (not hard-coded `Geometry`)", async () => {
    let observedFilter: string | null = null;
    const source = buildSchemaSource(metadataLocation, [
      [
        "/odata/Places",
        (url) => {
          observedFilter = url.searchParams.get("$filter");
          return jsonResponse({
            "@odata.context": "https://mock/odata/$metadata#Places",
            value: [],
          });
        },
      ],
    ]);
    await source.query({ spatialFilter: envelope(-123, 37, -120, 45, { wkid: 4326 }) });
    expect(observedFilter).toMatch(/^geo\.intersects\(Location,geography'SRID=4326;POLYGON/);
  });

  it("drops the `Location` column from the metadata-derived $select on returnGeometry=false", async () => {
    let observedSelect: string | null = null;
    const source = buildSchemaSource(metadataLocation, [
      [
        "/odata/Places",
        (url) => {
          observedSelect = url.searchParams.get("$select");
          return jsonResponse({
            "@odata.context": "https://mock/odata/$metadata#Places",
            value: [],
          });
        },
      ],
    ]);
    await source.query({ returnGeometry: false });
    expect(observedSelect).toBeTruthy();
    expect(observedSelect!.split(",")).toEqual(expect.arrayContaining(["OBJECTID", "STATE"]));
    expect(observedSelect).not.toContain("Location");
  });

  it("splits the `Location` column out of attributes onto feature.geometry", async () => {
    const source = buildSchemaSource(metadataLocation, [
      [
        "/odata/Places",
        () =>
          jsonResponse({
            "@odata.context": "https://mock/odata/$metadata#Places",
            value: [{ OBJECTID: 1, STATE: "CA", Location: { type: "Point", coordinates: [-120, 38] } }],
          }),
      ],
    ]);
    const result = await source.query();
    const first = result.features[0];
    expect(first.geometry).toEqual({ type: "Point", coordinates: [-120, 38] });
    expect((first.attributes as unknown as Record<string, unknown>).Location).toBeUndefined();
  });
});

describe("odata / HonuaOdataEntitySet.apply signature (README fix)", () => {
  it("accepts a literal OData $apply transformation string and forwards it on the wire", async () => {
    let observedApply: string | null = null;
    const client = makeMockClient({
      routes: [
        ["/odata/$metadata", () => odataMetadataResponse()],
        [
          "/odata/Parcels",
          (url) => {
            observedApply = url.searchParams.get("$apply");
            return jsonResponse(odataApplyResponse());
          },
        ],
      ],
    });
    const entity = new HonuaOdataEntitySet({ client, entitySet: "Parcels" });
    // Matches the README example shape exactly: the published call is
    // `odata.apply("groupby((STATE),aggregate(ACRES with sum as SumAcres))")`.
    const result = await entity.apply("groupby((STATE),aggregate(ACRES with sum as SumAcres))");
    expect(observedApply).toBe("groupby((STATE),aggregate(ACRES with sum as SumAcres))");
    expect(result.rows).toHaveLength(2);
  });
});
