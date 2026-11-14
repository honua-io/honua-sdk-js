import { create } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import { HonuaClient } from "../src/core/client.js";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import {
  fromProtoApplyEditsResponse,
  fromProtoQueryResponse,
  streamProtoPages,
  toProtoApplyEditsRequest,
  toProtoQueryRequest,
} from "../src/core/grpc-adapter.js";
import {
  ApplyEditsResponseSchema,
  FeaturePageSchema,
  FieldType,
  QueryFeaturesResponseSchema,
} from "../src/gen/geospatial/v1/index.js";
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
