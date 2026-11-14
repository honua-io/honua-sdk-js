import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import { grpcSourceSchemaV2 } from "../src/connect-grpc-schema.js";
import { createDataset } from "../src/contract/index.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaCapabilityNotSupportedError, HonuaGrpcError } from "../src/core/errors.js";
import {
  fromProtoApplyEditsResponse,
  fromProtoQueryResponse,
  streamProtoPages,
  toProtoApplyEditsRequest,
  toProtoQueryRequest,
} from "../src/core/grpc-adapter.js";
import { grpcEditSchema } from "../src/core/grpc-edit-schema.js";
import {
  ApplyEditsRequestSchema,
  ApplyEditsResponseSchema,
  DescribeLayerResponseSchema,
  FeaturePageSchema,
  FieldType,
  QueryFeaturesResponseSchema,
} from "../src/gen/geospatial/v1/index.js";
import { LayerDescriptorSchema } from "../src/gen/geospatial/v1/metadata_types_pb.js";
import { response } from "./helpers/grpc-edit-wire.js";

const target = { serviceId: "inspections", layerId: 0 };
const GID = "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";

it("decodes date, time, offset timestamp and decimal values as exact text", () => {
  const result = fromProtoQueryResponse(typedQueryResponse());
  expect(result).toMatchObject({
    objectIdFieldName: "OBJECTID",
    globalIdFieldName: "GlobalID",
    fields: [
      { name: "inspected_on", type: "esriFieldTypeDateOnly" },
      { name: "opens_at", type: "esriFieldTypeTimeOnly" },
      { name: "signed_at", type: "esriFieldTypeTimestampOffset" },
      { name: "fee", type: "esriFieldTypeString" },
    ],
    features: [
      {
        attributes: {
          OBJECTID: 9,
          GlobalID: GID,
          inspected_on: "2026-11-14",
          opens_at: "08:30:00.1234567",
          signed_at: "2026-11-14T08:30:00.5-08:00",
          fee: "12345678901234567890.10",
        },
      },
    ],
  });
});

it("keeps a projected global-ID attribute as sent and restores it on streamed pages", async () => {
  const projected = fromProtoQueryResponse(
    create(QueryFeaturesResponseSchema, {
      objectIdFieldName: "OBJECTID",
      globalIdFieldName: "GlobalID",
      features: [{ id: 1n, globalId: GID, attributes: { globalid: { value: { case: "stringValue", value: "x" } } } }],
    }),
  );
  expect((projected as { features: { attributes: Record<string, unknown> }[] }).features[0].attributes).toEqual({
    OBJECTID: 1,
    globalid: "x",
  });

  async function* pages() {
    yield create(FeaturePageSchema, {
      objectIdFieldName: "OBJECTID",
      globalIdFieldName: "GlobalID",
      features: [{ id: 1n, globalId: GID }],
    });
    yield create(FeaturePageSchema, { features: [{ id: 2n, globalId: GID.replace("6f", "7f") }], isLastPage: true });
  }
  const streamed = [];
  for await (const page of streamProtoPages(pages())) streamed.push(...page);
  expect(streamed.map((feature) => feature.attributes.GlobalID)).toEqual([GID, GID.replace("6f", "7f")]);
});

it("selects by normalised global IDs and refuses mixed or empty selectors", () => {
  expect(toProtoQueryRequest({ ...target, globalIds: [`{${GID.toUpperCase()}}`] }).globalIds).toEqual([GID]);
  expect(() => toProtoQueryRequest({ ...target, globalIds: [] })).toThrow("at least one");
  expect(() => toProtoQueryRequest({ ...target, globalIds: ["x"] })).toThrow("must be UUIDs");
  expect(() => toProtoQueryRequest({ ...target, globalIds: [GID], objectIds: [1] })).toThrow("cannot be combined");
});

const attributeTypes = {
  inspected_on: "date",
  opens_at: "time",
  signed_at: "timestamp-offset",
  fee: "decimal",
} as const;

it("encodes declared precise types on their wire cases and leaves other strings plain", () => {
  const wire = toProtoApplyEditsRequest({
    ...target,
    attributeTypes,
    adds: [
      {
        attributes: {
          INSPECTED_ON: "2026-11-14",
          opens_at: "08:30:00",
          signed_at: new Date(Date.UTC(2026, 10, 14, 16, 30)),
          fee: "0.10",
          note: "2026-11-14",
          missing: null,
        },
      },
      { attributes: { fee: 12.5, signed_at: "2026-11-14T08:30:00.1234567+05:45" } },
    ],
  });
  const [first, second] = wire.adds;
  expect(first.attributes.INSPECTED_ON.value).toEqual({ case: "dateValue", value: "2026-11-14" });
  expect(first.attributes.opens_at.value).toEqual({ case: "timeValue", value: "08:30:00" });
  expect(first.attributes.signed_at.value).toEqual({
    case: "timestampOffsetValue",
    value: "2026-11-14T16:30:00.000Z",
  });
  expect(first.attributes.fee.value).toEqual({ case: "decimalValue", value: "0.10" });
  expect(first.attributes.note.value).toEqual({ case: "stringValue", value: "2026-11-14" });
  expect(first.attributes.missing.value.case).toBe("nullValue");
  expect(second.attributes.fee.value).toEqual({ case: "decimalValue", value: "12.5" });
  expect(second.attributes.signed_at.value).toEqual({
    case: "timestampOffsetValue",
    value: "2026-11-14T08:30:00.1234567+05:45",
  });
});

it.each([
  ["inspected_on", "11/14/2026"],
  ["opens_at", "8:30"],
  ["signed_at", "2026-11-14T08:30:00"],
  ["fee", "1e3"],
  ["fee", "+1"],
])("rejects an invalid %s value before any request: %s", async (field, value) => {
  const fetchFn = vi.fn();
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  await expect(
    client.applyEdits({ ...target, attributeTypes, adds: [{ attributes: { [field]: value } }] }),
  ).rejects.toThrow(/gRPC (date|time|timestamp-offset|decimal) edit attribute/);
  expect(fetchFn).not.toHaveBeenCalled();
});

it("addresses updates and deletes by normalised global ID and keeps adds' client global IDs", () => {
  const wire = toProtoApplyEditsRequest({
    ...target,
    useGlobalIds: true,
    globalIdField: "GlobalID",
    adds: [{ attributes: { globalid: `{${GID.toUpperCase()}}`, name: "new" } }],
    updates: [{ attributes: { GlobalID: GID, OBJECTID: 5, name: "changed" } }],
    deletes: [` ${GID.toUpperCase()} `],
  });
  expect(wire.useGlobalIds).toBe(true);
  expect(wire.adds[0].globalId).toBe(GID);
  expect(Object.keys(wire.adds[0].attributes)).toEqual(["name"]);
  expect(wire.updates[0].globalId).toBe(GID);
  expect(wire.updates[0].attributes.GlobalID).toBeUndefined();
  expect(wire.updates[0].id).toBe(0n);
  expect(wire.deletes).toEqual([]);
  expect(wire.deleteGlobalIds).toEqual([GID]);
});

it("keeps integer addressing by default, sending only explicit add global IDs", () => {
  const wire = toProtoApplyEditsRequest({
    ...target,
    globalIdField: "GlobalID",
    adds: [{ attributes: { GlobalID: "x" }, globalId: GID }, { attributes: { GlobalID: GID } }],
    updates: [{ attributes: { OBJECTID: 5, GlobalID: GID } }],
    deletes: [6],
  });
  expect(wire.useGlobalIds).toBe(false);
  expect(wire.adds[0].globalId).toBe(GID);
  expect(wire.adds[0].attributes.GlobalID).toBeUndefined();
  // An attribute-only global ID stays an attribute, which pre-1.2 servers also store.
  expect(wire.adds[1].globalId).toBe("");
  expect(wire.adds[1].attributes.GlobalID.value).toEqual({ case: "stringValue", value: GID });
  expect(wire.updates[0].attributes.GlobalID.value).toEqual({ case: "stringValue", value: GID });
  expect(wire.updates[0].id).toBe(5n);
  expect(wire.updates[0].globalId).toBe("");
  expect(wire.deletes).toEqual([6n]);
  expect(wire.deleteGlobalIds).toEqual([]);
});

it.each([
  [{ useGlobalIds: true, globalIdField: "GlobalID", updates: [{ attributes: { OBJECTID: 1 } }] }, "need globalId"],
  [{ useGlobalIds: true, deletes: ["not-a-uuid"] }, "must be UUIDs"],
  [{ useGlobalIds: true, globalIdField: "GlobalID", adds: [{ attributes: { GlobalID: 7 } }] }, "UUID strings"],
])("rejects unusable global-ID edits before sending: %#", (edit, message) => {
  expect(() => toProtoApplyEditsRequest({ ...target, ...edit })).toThrow(message);
});

it("returns both identities on edit results", () => {
  expect(
    fromProtoApplyEditsResponse(
      create(ApplyEditsResponseSchema, {
        addResults: [{ objectId: 9n, globalId: GID, success: true }],
        deleteResults: [{ objectId: 0n, success: false, error: { code: 404, message: "missing" } }],
      }),
    ),
  ).toEqual({
    addResults: [{ objectId: 9, globalId: GID, success: true }],
    updateResults: [],
    deleteResults: [{ objectId: 0, success: false, error: { code: 404, description: "missing" } }],
  });
});

it("refuses a global-ID delete that a pre-1.2 server silently ignored, keeping committed results", async () => {
  const fetchFn = vi.fn(async () =>
    response(create(ApplyEditsResponseSchema, { addResults: [{ objectId: 3n, success: true }] })),
  );
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  await expect(
    client.applyEdits({ ...target, useGlobalIds: true, adds: [{ attributes: {} }], deletes: [GID] }),
  ).rejects.toMatchObject({
    name: "HonuaGrpcError",
    code: 9,
    message: expect.stringContaining("may have been committed"),
    details: { addResults: [{ objectId: 3, success: true }], deleteResults: [] },
  });
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it("keeps exponent-form decimal numbers on their double encoding", () => {
  const wire = toProtoApplyEditsRequest({ ...target, attributeTypes, adds: [{ attributes: { fee: 1e-7 } }] });
  expect(wire.adds[0].attributes.fee.value).toEqual({ case: "doubleValue", value: 1e-7 });
});

it("refuses a global-ID query that a pre-1.2 server answered unfiltered", () => {
  const sent = toProtoQueryRequest({ ...target, globalIds: [GID] });
  const unfiltered = create(QueryFeaturesResponseSchema, { objectIdFieldName: "OBJECTID", features: [{ id: 1n }] });
  expect(() => fromProtoQueryResponse(unfiltered, sent)).toThrow(HonuaCapabilityNotSupportedError);
  expect(() => fromProtoQueryResponse(typedQueryResponse(), sent)).not.toThrow();
});

it("refuses an add whose client global ID a pre-1.2 server did not echo", async () => {
  const fetchFn = vi.fn(async () =>
    response(create(ApplyEditsResponseSchema, { addResults: [{ objectId: 3n, success: true }] })),
  );
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  await expect(client.applyEdits({ ...target, adds: [{ attributes: {}, globalId: GID }] })).rejects.toMatchObject({
    code: 9,
    details: { addResults: [{ objectId: 3, success: true }] },
  });
});

it("refuses global-ID selectors and feature global IDs on REST instead of running unfiltered", async () => {
  const fetchFn = vi.fn();
  const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn });
  await expect(client.queryFeatures({ ...target, globalIds: [GID] })).rejects.toMatchObject({
    name: "HonuaCapabilityNotSupportedError",
    capability: "globalIds",
  });
  await expect(client.applyEdits({ ...target, adds: [{ attributes: {}, globalId: GID }] })).rejects.toMatchObject({
    capability: "globalId",
  });
  expect(fetchFn).not.toHaveBeenCalled();
});

it("forwards useGlobalIds and a JSON global-ID delete list on REST", async () => {
  const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("useGlobalIds")).toBe("true");
    expect(JSON.parse(body.get("deletes") ?? "")).toEqual([GID]);
    return Response.json({ deleteResults: [{ objectId: 1, globalId: GID, success: true }] });
  });
  const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn });
  await expect(client.applyEdits({ ...target, useGlobalIds: true, deletes: [GID] })).resolves.toMatchObject({
    deleteResults: [{ globalId: GID, success: true }],
  });
});

const layer = create(LayerDescriptorSchema, {
  serviceId: "inspections",
  layerId: 0,
  objectIdField: "OBJECTID",
  globalIdField: "GlobalID",
  fields: [
    { definition: { name: "OBJECTID", fieldType: FieldType.BIG_INTEGER } },
    { definition: { name: "GlobalID", fieldType: FieldType.UUID } },
    { definition: { name: "inspected_on", fieldType: FieldType.DATE } },
    { definition: { name: "opens_at", fieldType: FieldType.TIME } },
    { definition: { name: "signed_at", fieldType: FieldType.TIMESTAMP_OFFSET } },
    { definition: { name: "fee", fieldType: FieldType.DECIMAL }, precision: 12, scale: 2 },
    { definition: { name: "ratio", fieldType: FieldType.DECIMAL }, precision: 2, scale: 4 },
    { definition: { name: "amount", fieldType: FieldType.DECIMAL } },
  ],
});

it("projects offset timestamps, decimals and the global-ID role", () => {
  const schema = grpcSourceSchemaV2(layer, { source: "https://example.test/DescribeLayer#inspections/0" });
  const byName = Object.fromEntries(schema.fields.map((field) => [field.name, field]));
  expect(byName.GlobalID.roles).toContain("honua.global-id");
  expect(byName.signed_at.type).toEqual({ kind: "timestamp", unit: "nanosecond", timezone: "offset" });
  expect(byName.fee.type).toEqual({ kind: "decimal", precision: 12, scale: 2, jsonEncoding: "string" });
  expect(byName.ratio.type).toEqual({ kind: "decimal", precision: 2, jsonEncoding: "string" });
  expect(byName.amount.type).toEqual({ kind: "decimal", jsonEncoding: "string" });
});

it("derives edit encoding hints from the descriptor", () => {
  expect(grpcEditSchema(layer)).toEqual({
    // DATE and TIME also exist in 1.1 descriptors, so only 1.2-only types are auto-typed.
    attributeTypes: { signed_at: "timestamp-offset", fee: "decimal", ratio: "decimal", amount: "decimal" },
    globalIdField: "GlobalID",
  });
  expect(grpcEditSchema(undefined)).toEqual({ attributeTypes: {} });
});

it("encodes canonical Source edits from one DescribeLayer read and returns global IDs", async () => {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url.slice(url.lastIndexOf("/") + 1));
    if (url.endsWith("/DescribeLayer")) {
      return grpcResponse(toBinary(DescribeLayerResponseSchema, create(DescribeLayerResponseSchema, { layer })));
    }
    const wire = fromBinary(ApplyEditsRequestSchema, (init?.body as Uint8Array).subarray(5));
    expect(wire.useGlobalIds).toBe(true);
    expect(wire.updates[0].globalId).toBe(GID);
    expect(wire.updates[0].attributes.OBJECTID).toBeUndefined();
    expect(wire.updates[0].attributes.inspected_on.value).toEqual({ case: "stringValue", value: "2026-11-14" });
    expect(wire.updates[0].attributes.fee.value).toEqual({ case: "decimalValue", value: "10.00" });
    expect(wire.deleteGlobalIds).toEqual([GID]);
    return response(
      create(ApplyEditsResponseSchema, {
        updateResults: [{ objectId: 4n, globalId: GID, success: true }],
        deleteResults: [{ objectId: 5n, globalId: GID, success: true }],
      }),
    );
  });
  const source = grpcSource(fetchFn);
  const edit = {
    useGlobalIds: true,
    updates: [{ id: 4, globalId: GID, attributes: { inspected_on: "2026-11-14", fee: "10.00" } }],
    deletes: [GID],
  };
  const result = await source.applyEdits(edit);
  expect(result.updated).toEqual([{ id: 4, globalId: GID, success: true }]);
  expect(result.deleted).toEqual([{ id: 5, globalId: GID, success: true }]);
  await source.applyEdits(edit);
  expect(calls).toEqual(["DescribeLayer", "ApplyEdits", "ApplyEdits"]);
});

it("falls back to untyped encoding only when DescribeLayer is unimplemented", async () => {
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/DescribeLayer")) return statusResponse(12);
    const wire = fromBinary(ApplyEditsRequestSchema, (init?.body as Uint8Array).subarray(5));
    expect(wire.adds[0].attributes.inspected_on.value).toEqual({ case: "stringValue", value: "2026-11-14" });
    return response(create(ApplyEditsResponseSchema, { addResults: [{ objectId: 1n, success: true }] }));
  });
  const fallback = grpcSource(fetchFn);
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(
      fallback.applyEdits({ adds: [{ attributes: { inspected_on: "2026-11-14" } }] }),
    ).resolves.toMatchObject({
      added: [{ id: 1, success: true }],
    });
  }
  // The UNIMPLEMENTED answer is cached: one DescribeLayer for both edits.
  expect(fetchFn.mock.calls.filter(([input]) => String(input).endsWith("/DescribeLayer"))).toHaveLength(1);

  const denied = vi.fn(async (_input: RequestInfo | URL) => statusResponse(7));
  const source = grpcSource(denied);
  await expect(source.applyEdits({ adds: [{ attributes: {} }] })).rejects.toBeInstanceOf(HonuaGrpcError);
  await expect(source.applyEdits({ adds: [{ attributes: {} }] })).rejects.toMatchObject({ code: 7 });
  // A failed read is retried, never cached, and no write was sent.
  expect(denied.mock.calls.map(([input]) => String(input).endsWith("/DescribeLayer"))).toEqual([true, true]);
});

it("lets a caller abort while the shared DescribeLayer read is pending, without sending a write", async () => {
  const fetchFn = vi.fn(() => new Promise<Response>(() => {}));
  const controller = new AbortController();
  const pending = grpcSource(fetchFn).applyEdits({ adds: [{ attributes: {} }], signal: controller.signal });
  await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "HonuaAbortError" });
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it("forwards canonical global-ID deletes on REST and refuses feature global IDs there", async () => {
  const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("useGlobalIds")).toBe("true");
    expect(JSON.parse(body.get("deletes") ?? "")).toEqual([GID]);
    return Response.json({ deleteResults: [{ objectId: 2, globalId: GID, success: true }] });
  });
  const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn });
  const source = createDataset({
    id: "rest",
    client,
    skipCompatibilityCheck: true,
    sources: [
      {
        id: "source",
        protocol: "geoservices-feature-service",
        locator: { url: "https://example.test", ...target },
        capabilities: new Set(["applyEdits"]),
      },
    ],
  }).source("source")!;
  await expect(source.applyEdits({ useGlobalIds: true, deletes: [GID] })).resolves.toMatchObject({
    deleted: [{ id: 2, globalId: GID, success: true }],
  });
  await expect(
    source.applyEdits({ useGlobalIds: true, updates: [{ globalId: GID, attributes: {} }] }),
  ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

function typedQueryResponse() {
  return create(QueryFeaturesResponseSchema, {
    objectIdFieldName: "OBJECTID",
    globalIdFieldName: "GlobalID",
    fields: [
      { name: "inspected_on", fieldType: FieldType.DATE },
      { name: "opens_at", fieldType: FieldType.TIME },
      { name: "signed_at", fieldType: FieldType.TIMESTAMP_OFFSET },
      { name: "fee", fieldType: FieldType.DECIMAL },
    ],
    features: [
      {
        id: 9n,
        globalId: GID,
        attributes: {
          inspected_on: { value: { case: "dateValue", value: "2026-11-14" } },
          opens_at: { value: { case: "timeValue", value: "08:30:00.1234567" } },
          signed_at: { value: { case: "timestampOffsetValue", value: "2026-11-14T08:30:00.5-08:00" } },
          fee: { value: { case: "decimalValue", value: "12345678901234567890.10" } },
        },
      },
    ],
  });
}

function grpcSource(fetchFn: typeof fetch) {
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  return createDataset({
    id: "fixture",
    client,
    skipCompatibilityCheck: true,
    sources: [
      {
        id: "source",
        protocol: "grpc",
        locator: { url: "https://example.test", ...target },
        schema: { primaryKey: "OBJECTID", fields: [] },
        capabilities: new Set(["applyEdits"]),
      },
    ],
  }).source("source")!;
}

function frame(bytes: Uint8Array, flags = 0): Uint8Array {
  const framed = new Uint8Array(bytes.length + 5);
  framed[0] = flags;
  new DataView(framed.buffer).setUint32(1, bytes.length);
  framed.set(bytes, 5);
  return framed;
}

function grpcResponse(bytes: Uint8Array): Response {
  const data = frame(bytes);
  const trailers = frame(new TextEncoder().encode("grpc-status: 0\r\n"), 128);
  const body = new Uint8Array(data.length + trailers.length);
  body.set(data);
  body.set(trailers, data.length);
  return new Response(body, { headers: { "content-type": "application/grpc-web+proto" } });
}

function statusResponse(status: number): Response {
  return new Response(null, {
    headers: { "content-type": "application/grpc-web+proto", "grpc-status": String(status), "grpc-message": "x" },
  });
}
