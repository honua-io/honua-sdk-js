import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import { createDataset } from "../src/contract/index.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import { toProtoRelatedRequest } from "../src/core/grpc-adapter.js";
import {
  ApplyServiceEditsRequestSchema,
  ApplyServiceEditsResponseSchema,
  FieldType,
  GeometryType,
  QueryRelatedRecordsRequestSchema,
  QueryRelatedRecordsResponseSchema,
} from "../src/gen/geospatial/v1/index.js";

import { wireResponse } from "./helpers/grpc-edit-wire.js";

const GID = "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";

it("follows QueryRelatedRecords pages over gRPC-Web and merges groups by origin", async () => {
  const tokens: string[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://example.test/geospatial.v1.FeatureService/QueryRelatedRecords");
    const wire = fromBinary(QueryRelatedRecordsRequestSchema, (init?.body as Uint8Array).subarray(5));
    expect(wire).toMatchObject({ serviceId: "inspections", layerId: 0, relationshipId: 2, objectIds: [1n, 2n] });
    expect(wire.outFields).toEqual(["status"]);
    expect(wire.returnGeometry).toBe(false);
    tokens.push(wire.pageToken);
    return wireResponse(toBinary(QueryRelatedRecordsResponseSchema, relatedPage(wire.pageToken)));
  });
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  const result = await client.queryRelatedRecords({
    serviceId: "inspections",
    layerId: 0,
    relationshipId: 2,
    objectIds: [1, 2],
    outFields: "status",
    returnGeometry: false,
  });
  expect(tokens).toEqual(["", "page-2"]);
  expect(result.fields).toEqual([{ name: "status", type: "esriFieldTypeString", alias: "status", nullable: false }]);
  expect(result.relatedRecordGroups).toEqual([
    {
      objectId: 1,
      relatedRecords: [
        { attributes: { status: "open", OBJECTID: 10, GlobalID: GID } },
        { attributes: { status: "closed", OBJECTID: 12 } },
      ],
    },
    { objectId: 2, relatedRecords: [{ attributes: { status: "open", OBJECTID: 11 } }] },
  ]);
});

it("backs canonical Source.queryRelated on gRPC", async () => {
  const fetchFn = vi.fn(async () => wireResponse(toBinary(QueryRelatedRecordsResponseSchema, relatedPage("page-2"))));
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  const source = createDataset({
    id: "fixture",
    client,
    skipCompatibilityCheck: true,
    sources: [
      {
        id: "source",
        protocol: "grpc",
        locator: { url: "https://example.test", serviceId: "inspections", layerId: 0 },
        capabilities: new Set(["queryRelated"]),
      },
    ],
  }).source("source")!;
  await expect(source.queryRelated({ relationshipId: 2, sourceIds: [1] })).resolves.toMatchObject({
    groups: [{ sourceId: 1, features: [{ attributes: { status: "closed" } }] }],
  });
});

it("rejects unsafe origin IDs before any request", async () => {
  const fetchFn = vi.fn();
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  await expect(
    client.queryRelatedRecords({ serviceId: "s", layerId: 0, relationshipId: 1, objectIds: [2 ** 53] }),
  ).rejects.toThrow("safe integers");
  expect(fetchFn).not.toHaveBeenCalled();
});

it("sends parent and child layers in one ApplyServiceEdits call and keeps layer order", async () => {
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://example.test/geospatial.v1.FeatureService/ApplyServiceEdits");
    const wire = fromBinary(ApplyServiceEditsRequestSchema, (init?.body as Uint8Array).subarray(5));
    expect(wire).toMatchObject({ serviceId: "inspections", rollbackOnFailure: true, idempotencyKey: "visit-7" });
    expect(wire.edits.map((layer) => layer.layerId)).toEqual([0, 1]);
    expect(wire.edits[0].adds[0].globalId).toBe(GID);
    expect(wire.edits[1].adds[0].attributes.parent_gid.value).toEqual({ case: "stringValue", value: GID });
    expect(wire.edits[1].deletes).toEqual([4n]);
    return serviceResponse(parentChildResults());
  });
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  await expect(
    client.applyServiceEdits({
      serviceId: "inspections",
      idempotencyKey: "visit-7",
      edits: [
        { layerId: 0, adds: [{ attributes: { name: "site" }, globalId: GID }] },
        { layerId: 1, adds: [{ attributes: { parent_gid: GID } }], deletes: [4] },
      ],
    }),
  ).resolves.toEqual({
    layers: [
      { layerId: 0, addResults: [{ objectId: 7, globalId: GID, success: true }], updateResults: [], deleteResults: [] },
      {
        layerId: 1,
        addResults: [{ objectId: 8, success: true }],
        updateResults: [],
        deleteResults: [{ objectId: 4, success: true }],
      },
    ],
  });
});

it("throws a rolled-back service batch with every layer's diagnostics attached", async () => {
  const fetchFn = vi.fn(async () =>
    wireResponse(
      toBinary(
        ApplyServiceEditsResponseSchema,
        create(ApplyServiceEditsResponseSchema, {
          error: { code: 1000, message: "rolled back" },
          results: [
            { layerId: 0, results: { addResults: [{ success: true }] } },
            { layerId: 1, results: { addResults: [{ success: false, error: { code: 400, message: "bad" } }] } },
          ],
        }),
      ),
    ),
  );
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  await expect(
    client.applyServiceEdits({
      serviceId: "s",
      edits: [
        { layerId: 0, adds: [{ attributes: {} }] },
        { layerId: 1, adds: [{ attributes: {} }] },
      ],
    }),
  ).rejects.toMatchObject({
    name: "HonuaGrpcError",
    details: {
      code: 1000,
      layers: [
        { layerId: 0, addResults: [{ objectId: 0, success: true }] },
        { layerId: 1, addResults: [{ objectId: 0, success: false, error: { code: 400, description: "bad" } }] },
      ],
    },
  });
});

it("refuses duplicate layers and a service batch whose global IDs were not applied", async () => {
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn: vi.fn() });
  await expect(client.applyServiceEdits({ serviceId: "s", edits: [{ layerId: 0 }, { layerId: 0 }] })).rejects.toThrow(
    RangeError,
  );

  const ignoring = vi.fn(async () =>
    wireResponse(
      toBinary(
        ApplyServiceEditsResponseSchema,
        create(ApplyServiceEditsResponseSchema, { results: [{ layerId: 0, results: {} }] }),
      ),
    ),
  );
  const old = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn: ignoring });
  await expect(
    old.applyServiceEdits({ serviceId: "s", edits: [{ layerId: 0, useGlobalIds: true, deletes: [GID] }] }),
  ).rejects.toMatchObject({ code: 9 });
});

it("uses the GeoServices service-level applyEdits on REST and refuses mixed global-ID modes", async () => {
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toContain("/rest/services/inspections/FeatureServer/applyEdits");
    const body = new URLSearchParams(String(init?.body));
    expect(JSON.parse(body.get("edits") ?? "")).toEqual([
      { id: 0, adds: [{ attributes: { name: "site" } }] },
      { id: 1, deletes: [4] },
    ]);
    expect(body.get("rollbackOnFailure")).toBe("true");
    return Response.json([
      { id: 0, addResults: [{ objectId: 7, success: true }] },
      { id: 1, deleteResults: [{ objectId: 4, success: true }] },
    ]);
  });
  const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn });
  await expect(
    client.applyServiceEdits({
      serviceId: "inspections",
      edits: [
        { layerId: 0, adds: [{ attributes: { name: "site" } }] },
        { layerId: 1, deletes: [4] },
      ],
    }),
  ).resolves.toEqual({
    layers: [
      { layerId: 0, addResults: [{ objectId: 7, success: true }] },
      { layerId: 1, deleteResults: [{ objectId: 4, success: true }] },
    ],
  });
  await expect(
    client.applyServiceEdits({
      serviceId: "inspections",
      edits: [
        { layerId: 0, useGlobalIds: true, deletes: [GID] },
        { layerId: 1, deletes: [4] },
      ],
    }),
  ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it("keeps a layer's own error on that layer and refuses results in a different layer order", async () => {
  const layerError = vi.fn(async () =>
    serviceResponse(
      create(ApplyServiceEditsResponseSchema, {
        results: [
          { layerId: 0, results: { addResults: [{ objectId: 1n, success: true }] } },
          { layerId: 1, results: { error: { code: 409, message: "conflict" } } },
        ],
      }),
    ),
  );
  const edits = [
    { layerId: 0, adds: [{ attributes: {} }] },
    { layerId: 1, adds: [{ attributes: {} }] },
  ];
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn: layerError });
  await expect(client.applyServiceEdits({ serviceId: "s", edits })).resolves.toMatchObject({
    layers: [{ layerId: 0 }, { layerId: 1, error: { code: 409, description: "conflict" } }],
  });

  const reordered = vi.fn(async () =>
    serviceResponse(create(ApplyServiceEditsResponseSchema, { results: [{ layerId: 1 }, { layerId: 0 }] })),
  );
  const strict = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn: reordered });
  await expect(strict.applyServiceEdits({ serviceId: "s", edits })).rejects.toMatchObject({ code: 13 });
});

it("never replays ApplyServiceEdits automatically, even with retries configured", async () => {
  const fetchFn = vi.fn(async () => new Response(null, { status: 503 }));
  const client = new HonuaClient({
    baseUrl: "https://example.test",
    transport: "grpc-web",
    fetchFn,
    retry: { maxRetries: 3, baseDelayMs: 0 },
  });
  await expect(client.applyServiceEdits({ serviceId: "s", edits: [{ layerId: 0, deletes: [1] }] })).rejects.toThrow();
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it("refuses a repeated continuation token instead of looping", async () => {
  const fetchFn = vi.fn(async () =>
    wireResponse(
      toBinary(QueryRelatedRecordsResponseSchema, create(QueryRelatedRecordsResponseSchema, { nextPageToken: "same" })),
    ),
  );
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  await expect(
    client.queryRelatedRecords({ serviceId: "s", layerId: 0, relationshipId: 1, objectIds: [1] }),
  ).rejects.toMatchObject({ name: "HonuaGrpcError", code: 13 });
  expect(fetchFn).toHaveBeenCalledTimes(2);
});

it("maps outSR for related records, refuses other extra parameters and keeps exact int64 origins", () => {
  const base = { serviceId: "s", layerId: 0, relationshipId: 1 };
  expect(toProtoRelatedRequest({ ...base, extraParams: { outSR: 4326 } }).outSr?.wkid).toBe(4326);
  expect(() => toProtoRelatedRequest({ ...base, extraParams: { orderByFields: "name" } })).toThrow(
    HonuaCapabilityNotSupportedError,
  );
  expect(toProtoRelatedRequest({ ...base, objectIds: "9007199254740993" }).objectIds).toEqual([9007199254740993n]);
});

it("refuses duplicate layers with the same error on REST as on gRPC", async () => {
  const fetchFn = vi.fn();
  const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn });
  await expect(client.applyServiceEdits({ serviceId: "s", edits: [{ layerId: 0 }, { layerId: 0 }] })).rejects.toThrow(
    RangeError,
  );
  expect(fetchFn).not.toHaveBeenCalled();
});

it("reports UNIMPLEMENTED related-record and service-edit RPCs as capability gaps", async () => {
  const fetchFn = vi.fn(async () => statusResponse(12));
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  await expect(
    client.queryRelatedRecords({ serviceId: "s", layerId: 0, relationshipId: 1, objectIds: [1] }),
  ).rejects.toMatchObject({ name: "HonuaCapabilityNotSupportedError", capability: "queryRelated" });
  await expect(
    client.applyServiceEdits({ serviceId: "s", edits: [{ layerId: 0, deletes: [1] }] }),
  ).rejects.toMatchObject({
    capability: "applyServiceEdits",
  });
});

it("refuses a service response that omits a layer's results", async () => {
  const fetchFn = vi.fn(async () =>
    serviceResponse(create(ApplyServiceEditsResponseSchema, { results: [{ layerId: 0 }] })),
  );
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  await expect(
    client.applyServiceEdits({ serviceId: "s", edits: [{ layerId: 0, adds: [{ attributes: {} }] }] }),
  ).rejects.toMatchObject({ code: 13 });
});

it("retries QueryRelatedRecords on UNAVAILABLE because it is a read", async () => {
  const fetchFn = vi
    .fn()
    .mockResolvedValueOnce(statusResponse(14))
    .mockResolvedValueOnce(wireResponse(toBinary(QueryRelatedRecordsResponseSchema, relatedPage("page-2"))));
  const client = new HonuaClient({
    baseUrl: "https://example.test",
    transport: "grpc-web",
    fetchFn,
    retry: { maxRetries: 2, baseDelayMs: 0 },
  });
  await expect(
    client.queryRelatedRecords({ serviceId: "s", layerId: 0, relationshipId: 1, objectIds: [1] }),
  ).resolves.toMatchObject({ relatedRecordGroups: [{ objectId: 1 }] });
  expect(fetchFn).toHaveBeenCalledTimes(2);
});

it("sends REST global-ID service edits as one flag with GUID deletes and drops empty delete tokens", async () => {
  const bodies: URLSearchParams[] = [];
  const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(new URLSearchParams(String(init?.body)));
    return Response.json([{ id: 0 }]);
  });
  const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn });
  await client.applyServiceEdits({ serviceId: "s", edits: [{ layerId: 0, useGlobalIds: true, deletes: [GID] }] });
  await client.applyServiceEdits({
    serviceId: "s",
    edits: [
      { layerId: 0, deletes: "1,,2" },
      { layerId: 1, deletes: "" },
    ],
  });
  expect(bodies[0].get("useGlobalIds")).toBe("true");
  expect(JSON.parse(bodies[0].get("edits") ?? "")).toEqual([{ id: 0, deletes: [GID] }]);
  expect(bodies[1].get("useGlobalIds")).toBeNull();
  expect(JSON.parse(bodies[1].get("edits") ?? "")).toEqual([
    { id: 0, deletes: [1, 2] },
    { id: 1, deletes: [] },
  ]);
});

function statusResponse(status: number): Response {
  return new Response(null, {
    headers: { "content-type": "application/grpc-web+proto", "grpc-status": String(status), "grpc-message": "x" },
  });
}

function parentChildResults() {
  return create(ApplyServiceEditsResponseSchema, {
    results: [
      { layerId: 0, results: { addResults: [{ objectId: 7n, globalId: GID, success: true }] } },
      {
        layerId: 1,
        results: { addResults: [{ objectId: 8n, success: true }], deleteResults: [{ objectId: 4n, success: true }] },
      },
    ],
  });
}

function serviceResponse(message: ReturnType<typeof parentChildResults>): Response {
  return wireResponse(toBinary(ApplyServiceEditsResponseSchema, message));
}

function relatedPage(token: string) {
  const metadata = {
    relatedLayerId: 3,
    objectIdFieldName: "OBJECTID",
    globalIdFieldName: "GlobalID",
    geometryType: GeometryType.NONE,
    fields: [{ name: "status", fieldType: FieldType.STRING }],
  };
  if (token === "") {
    return create(QueryRelatedRecordsResponseSchema, {
      ...metadata,
      groups: [
        { objectId: 1n, features: [{ id: 10n, globalId: GID, attributes: { status: stringValue("open") } }] },
        { objectId: 2n, features: [{ id: 11n, attributes: { status: stringValue("open") } }] },
      ],
      nextPageToken: "page-2",
    });
  }
  return create(QueryRelatedRecordsResponseSchema, {
    ...metadata,
    groups: [{ objectId: 1n, features: [{ id: 12n, attributes: { status: stringValue("closed") } }] }],
  });
}

function stringValue(value: string) {
  return { value: { case: "stringValue" as const, value } };
}
