import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import { grpcSourceSchemaV2 } from "../src/connect-grpc-schema.js";
import { createDataset } from "../src/contract/index.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaCapabilityNotSupportedError, HonuaGrpcError } from "../src/core/errors.js";
import { grpcEditSchema } from "../src/core/grpc-edit-schema.js";
import {
  ApplyEditsRequestSchema,
  ApplyEditsResponseSchema,
  DescribeLayerResponseSchema,
  FieldType,
} from "../src/gen/geospatial/v1/index.js";
import { LayerDescriptorSchema } from "../src/gen/geospatial/v1/metadata_types_pb.js";
import { response } from "./helpers/grpc-edit-wire.js";

// Canonical Source edits typed from DescribeLayer (geospatial-grpc 1.2 values and global IDs).
const target = { serviceId: "inspections", layerId: 0 };
const GID = "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";

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
