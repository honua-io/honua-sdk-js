import { create, fromBinary } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import { FeatureLayerCompat } from "../src/client-compat-entry.js";
import { createDataset } from "../src/contract/index.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaGrpcError } from "../src/core/errors.js";
import { toProtoApplyEditsRequest } from "../src/core/grpc-adapter.js";
import { ApplyEditsRequestSchema, ApplyEditsResponseSchema } from "../src/gen/geospatial/v1/index.js";
import { response } from "./helpers/grpc-edit-wire.js";

const target = { serviceId: "parcels", layerId: 0 };

it("sends typed adds, updates and deletes with auth through ApplyEdits only", async () => {
  const fetchFn = typedEditFetch();
  const client = new HonuaClient({
    baseUrl: "https://example.test",
    transport: "grpc-web",
    bearerToken: "edit-token",
    fetchFn,
  });
  await expect(
    client.applyEdits({
      ...target,
      objectIdField: "parcel_id",
      idempotencyKey: "logical-edit-1",
      adds: [{ attributes: { name: "new", active: true, score: 1.25, missing: null }, geometry: { x: 1, y: 2 } }],
      updates: [{ attributes: { parcel_id: 2, name: "changed" } }],
      deletes: "3,9223372036854775807",
    }),
  ).resolves.toEqual({
    addResults: [{ objectId: "9223372036854775807", success: true }],
    updateResults: [{ objectId: 2, success: false, error: { code: 1000, description: "rolled back" } }],
    deleteResults: [{ objectId: 3, success: true }],
  });
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it("surfaces a whole-batch response error instead of returning empty success", async () => {
  const fetchFn = vi.fn(async () =>
    response(
      create(ApplyEditsResponseSchema, {
        error: { code: 1000, message: "batch rejected" },
        deleteResults: [
          { objectId: 9223372036854775807n, success: false, error: { code: 400, message: "invalid row" } },
        ],
      }),
    ),
  );
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  await expect(client.applyEdits({ ...target, deletes: [1] })).rejects.toMatchObject({
    name: "HonuaGrpcError",
    code: 2,
    details: {
      code: 1000,
      message: "batch rejected",
      addResults: [],
      updateResults: [],
      deleteResults: [
        { objectId: "9223372036854775807", success: false, error: { code: 400, description: "invalid row" } },
      ],
    },
  });
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it("preserves IDs through the canonical Source edit facade", async () => {
  const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const wire = fromBinary(ApplyEditsRequestSchema, (init?.body as Uint8Array).subarray(5));
    expect(wire.updates.map((feature) => feature.id)).toEqual([7n, 9223372036854775807n]);
    expect(wire.deletes).toEqual([9223372036854775807n]);
    return response(
      create(ApplyEditsResponseSchema, {
        updateResults: [{ objectId: 9223372036854775807n, success: true }],
        deleteResults: [{ objectId: 9223372036854775807n, success: true }],
      }),
    );
  });
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  const source = createDataset({
    id: "fixture",
    client,
    skipCompatibilityCheck: true,
    sources: [
      {
        id: "source",
        protocol: "grpc",
        locator: { url: "https://example.test", serviceId: "parcels", layerId: 0 },
        schema: { primaryKey: "parcel_id", fields: [] },
        capabilities: new Set(["applyEdits"]),
      },
    ],
  }).source("source")!;
  const result = await source.applyEdits({
    updates: [{ attributes: { parcel_id: 7 } }, { id: "9223372036854775807", attributes: {} }],
    deletes: ["9223372036854775807"],
  });
  expect(result.updated[0].id).toBe("9223372036854775807");
  expect(result.deleted[0].id).toBe("9223372036854775807");
  expect(fetchFn).toHaveBeenCalledTimes(1);
  for (const deletes of [[Number.MAX_SAFE_INTEGER + 1], ["9223372036854775807", Number.MAX_SAFE_INTEGER + 1]]) {
    await expect(source.applyEdits({ deletes })).rejects.toThrow("safe integers");
  }
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it("rejects explicit geometry clearing before sending an update", async () => {
  const fetchFn = vi.fn();
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  await expect(
    client.applyEdits({ ...target, updates: [{ attributes: { OBJECTID: 1 }, geometry: null }] }),
  ).rejects.toMatchObject({ name: "HonuaCapabilityNotSupportedError", capability: "clearGeometry" });
  expect(fetchFn).not.toHaveBeenCalled();
});

it("preserves partial row failures when rollback is disabled", async () => {
  const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const wire = fromBinary(ApplyEditsRequestSchema, (init?.body as Uint8Array).subarray(5));
    expect(wire.rollbackOnFailure).toBe(false);
    return response(
      create(ApplyEditsResponseSchema, {
        addResults: [
          { objectId: 1n, success: true },
          { success: false, error: { code: 400, message: "invalid" } },
        ],
      }),
    );
  });
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  const result = await client.applyEdits({
    ...target,
    rollbackOnFailure: false,
    adds: [{ attributes: {} }, { attributes: {} }],
  });
  expect(result.addResults).toEqual([
    { objectId: 1, success: true },
    { objectId: 0, success: false, error: { code: 400, description: "invalid" } },
  ]);
});

it.each([5, 7, 12, 14])(
  "surfaces whole-call status %s without REST fallback or automatic write retry",
  async (status) => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("/geospatial.v1.FeatureService/ApplyEdits");
      return new Response(null, {
        headers: {
          "content-type": "application/grpc-web+proto",
          "grpc-status": String(status),
          "grpc-message": "edit failed",
        },
      });
    });
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "grpc-web",
      fetchFn,
      retry: { maxRetries: 3, baseDelayMs: 0 },
    });
    await expect(client.applyEdits({ ...target, deletes: [1] })).rejects.toMatchObject({ code: status });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  },
);

it("passes cancellation to the native call without fallback", async () => {
  const controller = new AbortController();
  const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      controller.abort();
    });
  });
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  await expect(client.applyEdits({ ...target, deletes: [1], signal: controller.signal })).rejects.toBeInstanceOf(
    HonuaGrpcError,
  );
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it("keeps the existing REST edit route for default clients", async () => {
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toContain("/rest/services/parcels/FeatureServer/0/applyEdits");
    return Response.json({ deleteResults: [{ objectId: 1, success: true }] });
  });
  const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn });
  await expect(client.applyEdits({ ...target, deletes: [1] })).resolves.toMatchObject({
    deleteResults: [{ success: true }],
  });
});

it("encodes dates, binary values and exact integers and resolves conventional IDs", () => {
  const wire = toProtoApplyEditsRequest({
    ...target,
    updates: [
      {
        attributes: {
          OBJECTID: "9223372036854775807",
          when: new Date(1234),
          bytes: new Uint8Array([1]),
          count: 42n,
        },
      },
    ],
  });
  expect(wire.updates[0].id).toBe(9223372036854775807n);
  expect(wire.updates[0].attributes.when.value).toEqual({ case: "datetimeValue", value: 1234n });
  expect(wire.updates[0].attributes.bytes.value).toEqual({ case: "bytesValue", value: new Uint8Array([1]) });
  expect(wire.updates[0].attributes.count.value).toEqual({ case: "int64Value", value: 42n });
});

it("rejects edit reprojection before sending", () => {
  expect(() =>
    toProtoApplyEditsRequest({
      ...target,
      adds: [{ attributes: {}, geometry: { x: 1, y: 2, spatialReference: { wkid: 4326 } } }],
    }),
  ).toThrow("layer coordinates");
});

it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, {}, undefined, 1n << 63n])(
  "rejects unrepresentable attributes before any request: %s",
  async (value) => {
    const fetchFn = vi.fn();
    const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
    await expect(client.applyEdits({ ...target, adds: [{ attributes: { value } }] })).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  },
);

it.each(["1.5", "9223372036854775808", "", "1,,2"])("rejects invalid delete IDs: %s", (deletes) => {
  expect(() => toProtoApplyEditsRequest({ ...target, deletes })).toThrow();
});

function typedEditFetch() {
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://example.test/geospatial.v1.FeatureService/ApplyEdits");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer edit-token");
    const body = init?.body as Uint8Array;
    const wire = fromBinary(ApplyEditsRequestSchema, body.subarray(5));
    expect(wire).toMatchObject({
      ...target,
      rollbackOnFailure: true,
      idempotencyKey: "logical-edit-1",
      deletes: [3n, 9223372036854775807n],
    });
    expect(wire.adds[0].attributes.name.value).toEqual({ case: "stringValue", value: "new" });
    expect(wire.adds[0].attributes.active.value).toEqual({ case: "boolValue", value: true });
    expect(wire.adds[0].attributes.score.value).toEqual({ case: "doubleValue", value: 1.25 });
    expect(wire.adds[0].attributes.missing.value.case).toBe("nullValue");
    expect(wire.adds[0].geometry?.shape).toMatchObject({ case: "point", value: { x: 1, y: 2 } });
    expect(wire.updates[0].id).toBe(2n);
    return response(
      create(ApplyEditsResponseSchema, {
        addResults: [{ objectId: 9223372036854775807n, success: true }],
        updateResults: [{ objectId: 2n, success: false, error: { code: 1000, message: "rolled back" } }],
        deleteResults: [{ objectId: 3n, success: true }],
      }),
    );
  });
  return fetchFn;
}

it("forwards a compatibility layer's custom primary key through native edits", async () => {
  const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const wire = fromBinary(ApplyEditsRequestSchema, (init?.body as Uint8Array).subarray(5));
    expect(wire.updates[0].id).toBe(7n);
    expect(wire.deletes).toEqual([8n]);
    return response(create(ApplyEditsResponseSchema, { updateResults: [{ objectId: 7n, success: true }] }));
  });
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  const layer = new FeatureLayerCompat({
    url: "https://example.test/rest/services/parcels/FeatureServer/0",
    objectIdField: "parcel_id",
    client,
  });
  const result = await layer.applyEdits({
    updates: [{ attributes: { parcel_id: 7, name: "changed" } }],
    deleteFeatures: [{ attributes: { parcel_id: 8 } }],
  });
  expect(result.updateResults).toEqual([{ objectId: 7, success: true }]);
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(String(fetchFn.mock.calls[0][0])).toContain("/geospatial.v1.FeatureService/ApplyEdits");
});
