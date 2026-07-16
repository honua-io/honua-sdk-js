import { describe, expect, it } from "vitest";

import {
  type OdataSourceOptions,
  PROTOCOL_DEFAULT_CAPABILITIES,
  type Source,
  type SourceDescriptor,
  odataSource,
} from "../../src/contract/index.js";
import { HonuaOdataEdmEncodingError } from "../../src/honua.js";

import { jsonResponse, makeMockClient } from "./shared.js";

const LOSSLESS_METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Example" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <ComplexType Name="Measurement">
        <Property Name="Amount" Type="Edm.Decimal" Precision="38" Scale="9"/>
        <Property Name="Reading" Type="Edm.Double"/>
      </ComplexType>
      <EntityType Name="Record">
        <Key><PropertyRef Name="Id"/></Key>
        <Property Name="Id" Type="Edm.Int64" Nullable="false"/>
        <Property Name="Amount" Type="Edm.Decimal" Precision="38" Scale="9"/>
        <Property Name="Reading" Type="Edm.Double"/>
        <Property Name="Measurement" Type="Example.Measurement"/>
        <Property Name="Measurements" Type="Collection(Example.Measurement)"/>
      </EntityType>
      <EntityType Name="NamedRecord">
        <Key><PropertyRef Name="Name"/></Key>
        <Property Name="Name" Type="Edm.String" Nullable="false"/>
        <Property Name="Amount" Type="Edm.Decimal" Precision="38" Scale="9"/>
      </EntityType>
      <EntityType Name="GuidRecord">
        <Key><PropertyRef Name="Id"/></Key>
        <Property Name="Id" Type="Edm.Guid" Nullable="false"/>
        <Property Name="Amount" Type="Edm.Decimal" Precision="38" Scale="9"/>
      </EntityType>
      <EntityType Name="Asset">
        <Key><PropertyRef Name="Tenant"/><PropertyRef Name="Id"/></Key>
        <Property Name="Tenant" Type="Edm.String" Nullable="false"/>
        <Property Name="Id" Type="Edm.Int64" Nullable="false"/>
        <Property Name="Amount" Type="Edm.Decimal" Precision="38" Scale="9"/>
      </EntityType>
      <EntityContainer Name="Container">
        <EntitySet Name="Records" EntityType="Example.Record"/>
        <EntitySet Name="NamedRecords" EntityType="Example.NamedRecord"/>
        <EntitySet Name="GuidRecords" EntityType="Example.GuidRecord"/>
        <EntitySet Name="Assets" EntityType="Example.Asset"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

type Route = [string | RegExp, (url: URL, init: RequestInit | undefined) => Response | Promise<Response>];

function buildSource(
  entitySet: string,
  routes: Route[],
  options: OdataSourceOptions = { writeEncoding: "lossless-json" },
  onMetadata?: () => void,
): Source<Record<string, unknown>> {
  const client = makeMockClient({
    routes: [
      [
        "/odata/$metadata",
        () => {
          onMetadata?.();
          return new Response(LOSSLESS_METADATA, {
            status: 200,
            headers: { "Content-Type": "application/xml" },
          });
        },
      ],
      ...routes,
    ],
  });
  return odataSource<Record<string, unknown>>(
    {
      id: entitySet.toLowerCase(),
      protocol: "odata",
      locator: { url: "https://mock/odata", entitySet },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
    } satisfies SourceDescriptor,
    client,
    "strict",
    options,
  );
}

describe("odata / lossless write integration", () => {
  it("encodes exact and nested values once for direct adds, updates, and Int64 keys", async () => {
    let metadataHits = 0;
    const calls: Array<{ body?: string; contentType?: string; method: string; path: string }> = [];
    const source = buildSource(
      "Records",
      [
        [
          /\/odata\/Records/,
          (url, init) => {
            const method = init?.method ?? "GET";
            calls.push({
              method,
              path: url.pathname,
              ...(typeof init?.body === "string" ? { body: init.body } : {}),
              ...(new Headers(init?.headers).get("Content-Type")
                ? { contentType: new Headers(init?.headers).get("Content-Type") ?? undefined }
                : {}),
            });
            return method === "POST"
              ? jsonResponse({ Id: "9223372036854775807" })
              : new Response(null, { status: 204 });
          },
        ],
      ],
      { writeEncoding: "lossless-json" },
      () => {
        metadataHits += 1;
      },
    );

    const result = await source.applyEdits({
      adds: [
        {
          attributes: {
            Id: 9_223_372_036_854_775_807n,
            Amount: "12345678901234567890.123456789",
            Reading: Number.POSITIVE_INFINITY,
            Measurement: { Amount: "0.000000001", Reading: Number.NaN },
            Measurements: [{ Amount: "2.500000000", Reading: Number.NEGATIVE_INFINITY }],
          },
        },
      ],
      updates: [
        {
          id: "9223372036854775807",
          attributes: { Amount: "99999999999999999999.000000001" },
        },
      ],
      deletes: ["9223372036854775807"],
    });

    expect(metadataHits).toBe(1);
    expect(result.added[0]).toMatchObject({ id: "9223372036854775807", success: true });
    expect(result.updated[0].success).toBe(true);
    expect(result.deleted[0].success).toBe(true);
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/odata/Records",
        contentType: "application/json;IEEE754Compatible=true",
        body: JSON.stringify({
          Id: "9223372036854775807",
          Amount: "12345678901234567890.123456789",
          Reading: "INF",
          Measurement: { Amount: "0.000000001", Reading: "NaN" },
          Measurements: [{ Amount: "2.500000000", Reading: "-INF" }],
        }),
      },
      {
        method: "PATCH",
        path: "/odata/Records(9223372036854775807)",
        contentType: "application/json;IEEE754Compatible=true",
        body: JSON.stringify({ Amount: "99999999999999999999.000000001" }),
      },
      { method: "DELETE", path: "/odata/Records(9223372036854775807)" },
    ]);
  });

  it("formats string, GUID, and composite keys from metadata without Number coercion", async () => {
    const paths: string[] = [];
    const route: Route = [
      /\/odata\/(?:NamedRecords|GuidRecords|Assets)/,
      (url) => {
        paths.push(url.pathname);
        return new Response(null, { status: 204 });
      },
    ];
    const named = buildSource("NamedRecords", [route]);
    const guid = buildSource("GuidRecords", [route]);
    const assets = buildSource("Assets", [route]);

    await named.applyEdits({ updates: [{ id: "O'Neil/a,b", attributes: {} }], deletes: ["O'Neil/a,b"] });
    await guid.applyEdits({
      updates: [{ id: "01234567-89AB-CDEF-0123-456789ABCDEF", attributes: {} }],
      deletes: ["01234567-89AB-CDEF-0123-456789ABCDEF"],
    });
    await assets.applyEdits({
      updates: [
        {
          attributes: {
            Tenant: "north/O'Neil",
            Id: "9223372036854775807",
            Amount: "1.000000000",
          },
        },
      ],
    });

    expect(paths).toEqual([
      "/odata/NamedRecords('O''Neil%2Fa%2Cb')",
      "/odata/NamedRecords('O''Neil%2Fa%2Cb')",
      "/odata/GuidRecords(01234567-89AB-CDEF-0123-456789ABCDEF)",
      "/odata/GuidRecords(01234567-89AB-CDEF-0123-456789ABCDEF)",
      "/odata/Assets(Tenant='north%2FO''Neil',Id=9223372036854775807)",
    ]);
  });

  it.each(["{01234567-89ab-cdef-0123-456789abcdef}", "01234567-89ab-cdef-0123-456789abcdeg"])(
    "rejects malformed GUID key %s before issuing an edit",
    async (id) => {
      let editHits = 0;
      const source = buildSource("GuidRecords", [
        [
          "/odata/GuidRecords",
          () => {
            editHits += 1;
            return new Response(null, { status: 204 });
          },
        ],
      ]);

      await expect(source.applyEdits({ deletes: [id] })).rejects.toBeInstanceOf(HonuaOdataEdmEncodingError);
      expect(editHits).toBe(0);
    },
  );

  it("uses the same encoded bodies, keys, and per-part media types in an atomic batch", async () => {
    let outerContentType: string | null = null;
    let payload: {
      requests?: Array<{
        atomicityGroup?: string;
        body?: Record<string, unknown>;
        headers?: Record<string, string>;
        method: string;
        url: string;
      }>;
    } = {};
    const source = buildSource("Records", [
      [
        "/odata/$batch",
        (_url, init) => {
          outerContentType = new Headers(init?.headers).get("Content-Type");
          payload = JSON.parse(String(init?.body ?? "{}")) as typeof payload;
          return jsonResponse({
            responses: [
              { id: "1", status: 201, body: { Id: "9223372036854775807" } },
              { id: "2", status: 204 },
              { id: "3", status: 204 },
            ],
          });
        },
      ],
    ]);

    const result = await source.applyEdits({
      adds: [
        {
          attributes: {
            Id: "9223372036854775807",
            Measurement: { Amount: "1.250000000", Reading: Number.NaN },
          },
        },
      ],
      updates: [{ id: "9223372036854775807", attributes: { Reading: Number.POSITIVE_INFINITY } }],
      deletes: ["9223372036854775807"],
      rollbackOnFailure: true,
    });

    expect(result.added[0].success).toBe(true);
    expect(result.updated[0].success).toBe(true);
    expect(result.deleted[0].success).toBe(true);
    expect(outerContentType).toBe("application/json");
    expect(payload.requests).toEqual([
      {
        id: "1",
        method: "POST",
        url: "Records",
        headers: { "Content-Type": "application/json;IEEE754Compatible=true" },
        body: {
          Id: "9223372036854775807",
          Measurement: { Amount: "1.250000000", Reading: "NaN" },
        },
        atomicityGroup: "g1",
      },
      {
        id: "2",
        method: "PATCH",
        url: "Records(9223372036854775807)",
        headers: { "Content-Type": "application/json" },
        body: { Reading: "INF" },
        atomicityGroup: "g1",
      },
      {
        id: "3",
        method: "DELETE",
        url: "Records(9223372036854775807)",
        headers: { "Content-Type": "application/json" },
        atomicityGroup: "g1",
      },
    ]);
  });

  it("preserves legacy body bytes, ordinary media types, and key formatting when omitted", async () => {
    const calls: Array<{ body?: string; contentType?: string; method: string; path: string }> = [];
    const source = buildSource(
      "Records",
      [
        [
          /\/odata\/Records/,
          (url, init) => {
            const method = init?.method ?? "GET";
            calls.push({
              method,
              path: url.pathname,
              ...(typeof init?.body === "string" ? { body: init.body } : {}),
              ...(new Headers(init?.headers).get("Content-Type")
                ? { contentType: new Headers(init?.headers).get("Content-Type") ?? undefined }
                : {}),
            });
            return method === "POST" ? jsonResponse({ Id: "7" }) : new Response(null, { status: 204 });
          },
        ],
      ],
      {},
    );

    await source.applyEdits({
      adds: [{ attributes: { Id: "7", Amount: "12.340", Reading: null } }],
      updates: [{ id: 7, attributes: { Amount: 8.5, Reading: Number.POSITIVE_INFINITY } }],
      deletes: [7],
    });

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/odata/Records",
        contentType: "application/json",
        body: '{"Id":"7","Amount":"12.340","Reading":null}',
      },
      {
        method: "PATCH",
        path: "/odata/Records(7)",
        contentType: "application/json",
        body: '{"Amount":8.5,"Reading":null}',
      },
      { method: "DELETE", path: "/odata/Records(7)" },
    ]);
  });

  it("shares one metadata request across concurrent opted-in edits", async () => {
    let metadataHits = 0;
    let editHits = 0;
    const source = buildSource(
      "Records",
      [
        [
          "/odata/Records",
          () => {
            editHits += 1;
            return jsonResponse({ Id: String(editHits) });
          },
        ],
      ],
      { writeEncoding: "lossless-json" },
      () => {
        metadataHits += 1;
      },
    );

    await Promise.all([
      source.applyEdits({ adds: [{ attributes: { Id: "1", Amount: "1.000000000" } }] }),
      source.applyEdits({ adds: [{ attributes: { Id: "2", Amount: "2.000000000" } }] }),
    ]);

    expect(metadataHits).toBe(1);
    expect(editHits).toBe(2);
  });

  it("rejects an unknown write encoding before any request", () => {
    expect(() => buildSource("Records", [], { writeEncoding: "unsafe" as "legacy" })).toThrow(/writeEncoding/);
  });
});
