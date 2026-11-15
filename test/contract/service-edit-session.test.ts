import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { expect, it, vi } from "vitest";
import {
  type ServiceEditSubmitOptions,
  type SourceDescriptor,
  createDataset,
  createServiceEditSession,
} from "../../src/contract/index.js";
import { HonuaClient } from "../../src/core/client.js";
import { HonuaAbortError, HonuaCapabilityNotSupportedError, HonuaGrpcError } from "../../src/core/errors.js";
import {
  ApplyServiceEditsRequestSchema,
  ApplyServiceEditsResponseSchema,
  type DescribeLayerResponse,
  DescribeLayerResponseSchema,
  FieldType,
} from "../../src/gen/geospatial/v1/index.js";
import { wireResponse } from "../helpers/grpc-edit-wire.js";

const GID = "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
const batch = {
  edits: [
    { sourceId: "parents", edits: { adds: [{ globalId: GID, attributes: { cost: "9007199254740993.125" } }] } },
    { sourceId: "children", edits: { adds: [{ attributes: { parent_gid: GID } }] } },
  ],
};

function descriptor(id: string, layerId: number): SourceDescriptor {
  return {
    id,
    protocol: "grpc",
    capabilities: new Set(["applyEdits"]),
    locator: { url: "https://example.test", serviceId: "inspections", layerId },
  };
}

function fixture(sources = [descriptor("parents", 0), descriptor("children", 1)]) {
  const fetchFn = vi.fn();
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  const describe = vi.spyOn(client, "describeLayer").mockResolvedValue(
    create(DescribeLayerResponseSchema, {
      layer: {
        globalIdField: "GlobalID",
        fields: [
          { definition: { name: "cost", fieldType: FieldType.DECIMAL } },
          { definition: { name: "visited", fieldType: FieldType.TIMESTAMP_OFFSET } },
        ],
      },
    }),
  );
  const dataset = createDataset({ id: "test", client, sources, skipCompatibilityCheck: true });
  return { client, dataset, fetchFn, describe, session: createServiceEditSession({ dataset }) };
}

it("sends parent and child edits as one native transaction with exact types and canonical results", async () => {
  const { session, describe, fetchFn } = fixture();
  fetchFn.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://example.test/geospatial.v1.FeatureService/ApplyServiceEdits");
    const wire = fromBinary(ApplyServiceEditsRequestSchema, (init?.body as Uint8Array).subarray(5));
    expect(wire).toMatchObject({ serviceId: "inspections", rollbackOnFailure: true, idempotencyKey: "visit-7" });
    expect(wire.edits.map((layer) => layer.layerId)).toEqual([0, 1]);
    expect(wire.edits[0].adds[0].globalId).toBe(GID);
    expect(wire.edits[0].adds[0].attributes.cost.value).toEqual({
      case: "decimalValue",
      value: "9007199254740993.125",
    });
    expect(wire.edits[1].adds[0].attributes.parent_gid.value).toEqual({ case: "stringValue", value: GID });
    return wireResponse(
      toBinary(
        ApplyServiceEditsResponseSchema,
        create(ApplyServiceEditsResponseSchema, {
          results: [
            { layerId: 0, results: { addResults: [{ objectId: 9007199254740993n, globalId: GID, success: true }] } },
            { layerId: 1, results: { addResults: [{ objectId: 8n, success: true }] } },
          ],
        }),
      ),
    );
  });
  await expect(session.submit({ ...batch, idempotencyKey: "visit-7" })).resolves.toEqual({
    sources: [
      {
        sourceId: "parents",
        layerId: 0,
        result: { added: [{ id: "9007199254740993", globalId: GID, success: true }], updated: [], deleted: [] },
      },
      { sourceId: "children", layerId: 1, result: { added: [{ id: 8, success: true }], updated: [], deleted: [] } },
    ],
  });
  expect(fetchFn).toHaveBeenCalledTimes(1);
  expect(describe).toHaveBeenCalledTimes(2);
});

it("reuses native metadata and passes custom primary keys, precise attributes and cancellation", async () => {
  const parent = descriptor("parents", 0);
  parent.schema = { primaryKey: "site_id", fields: [] };
  const { session, client, describe } = fixture([parent]);
  const apply = vi
    .spyOn(client, "applyServiceEdits")
    .mockResolvedValue({ layers: [{ layerId: 0, updateResults: [{ objectId: 7, success: true }] }] });
  const signal = new AbortController().signal;
  const options = {
    edits: [
      { sourceId: "parents", edits: { updates: [{ id: 7, attributes: { visited: "2026-11-13T09:30:00+05:30" } }] } },
    ],
    signal,
    rollbackOnFailure: false,
    idempotencyKey: "visit-8",
  };
  await session.submit(options);
  await session.submit(options);
  expect(describe).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledWith({
    serviceId: "inspections",
    signal,
    rollbackOnFailure: false,
    idempotencyKey: "visit-8",
    edits: [
      {
        layerId: 0,
        objectIdField: "site_id",
        globalIdField: "GlobalID",
        attributeTypes: { cost: "decimal", visited: "timestamp-offset" },
        updates: [{ attributes: { site_id: 7, visited: "2026-11-13T09:30:00+05:30" } }],
      },
    ],
  });
});

it.each([
  ["service", { serviceId: "other" }],
  ["endpoint", { url: "https://other.test" }],
  ["duplicate layer", { layerId: 0 }],
  ["negative layer", { layerId: -1 }],
  ["fractional layer", { layerId: 1.5 }],
  ["overflow layer", { layerId: 2147483648 }],
  ["blank service", { serviceId: " " }],
])("rejects a later source with a mismatched %s before any RPC", async (_name, locator) => {
  const child = descriptor("children", 1);
  child.locator = { ...child.locator, ...locator };
  const { session, describe, fetchFn } = fixture([descriptor("parents", 0), child]);
  await expect(session.submit(batch)).rejects.toThrow();
  expect(describe).not.toHaveBeenCalled();
  expect(fetchFn).not.toHaveBeenCalled();
});

it("rejects unregistered and repeated sources, empty batches and invalid later edit envelopes before metadata", async () => {
  const { session, describe, fetchFn } = fixture();
  for (const options of [
    { edits: [] },
    { edits: [...batch.edits, { sourceId: "unknown", edits: {} }] },
    { edits: [batch.edits[0], batch.edits[0]] },
    { edits: [batch.edits[0], { sourceId: "children", edits: { deletes: [2 ** 53] } }] },
    { edits: [batch.edits[0], { sourceId: "children", edits: { signal: new AbortController().signal } }] },
    { edits: [batch.edits[0], { sourceId: "children", edits: { rollbackOnFailure: false } }] },
  ])
    await expect(session.submit(options as ServiceEditSubmitOptions)).rejects.toThrow();
  expect(describe).not.toHaveBeenCalled();
  expect(fetchFn).not.toHaveBeenCalled();
});

it.each(["protocol", "capability"])("rejects unsupported source %s without a REST fallback", async (kind) => {
  const child = descriptor("children", 1);
  if (kind === "protocol") child.protocol = "geoservices-feature-service";
  else child.capabilities = new Set(["query"]);
  const { session, describe, fetchFn } = fixture([descriptor("parents", 0), child]);
  await expect(session.submit(batch)).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
  expect(describe).not.toHaveBeenCalled();
  expect(fetchFn).not.toHaveBeenCalled();
});

it("rejects a REST client before metadata or mutation", async () => {
  const fetchFn = vi.fn();
  const client = new HonuaClient({ baseUrl: "https://example.test", fetchFn });
  const dataset = createDataset({
    id: "rest",
    client,
    sources: [descriptor("parents", 0)],
    skipCompatibilityCheck: true,
  });
  await expect(createServiceEditSession({ dataset }).submit(batch)).rejects.toBeInstanceOf(
    HonuaCapabilityNotSupportedError,
  );
  expect(fetchFn).not.toHaveBeenCalled();
});

it("accepts equivalent endpoint URLs", async () => {
  const child = descriptor("children", 1);
  child.locator.url = "https://EXAMPLE.test:443/";
  const { session, client } = fixture([descriptor("parents", 0), child]);
  vi.spyOn(client, "applyServiceEdits").mockResolvedValue({
    layers: [
      { layerId: 0, addResults: [{ objectId: 0, success: true }] },
      { layerId: 1, addResults: [{ objectId: 0, success: true }] },
    ],
  });
  await expect(session.submit(batch)).resolves.toHaveProperty("sources.1.sourceId", "children");
});

it("keeps per-row errors and whole-layer errors on their sources", async () => {
  const { session, client } = fixture();
  vi.spyOn(client, "applyServiceEdits").mockResolvedValue({
    layers: [
      { layerId: 0, addResults: [{ objectId: 0, success: false, error: { code: 400, description: "invalid field" } }] },
      { layerId: 1, error: { code: 403, description: "layer denied" } },
    ],
  });
  await expect(session.submit({ ...batch, rollbackOnFailure: false })).resolves.toMatchObject({
    sources: [
      { sourceId: "parents", result: { added: [{ success: false, error: { code: 400 } }] } },
      { sourceId: "children", error: { code: 403 }, result: { added: [], updated: [], deleted: [] } },
    ],
  });
});

it("propagates whole-call rollback diagnostics without retry or partial success", async () => {
  const { session, client } = fixture();
  const error = new HonuaGrpcError(2, "rolled back", { code: 1000, layers: [{ layerId: 0 }, { layerId: 1 }] });
  const apply = vi.spyOn(client, "applyServiceEdits").mockRejectedValue(error);
  await expect(session.submit(batch)).rejects.toBe(error);
  expect(apply).toHaveBeenCalledTimes(1);
});

it("never attributes a reordered native response to another source", async () => {
  const { session, fetchFn } = fixture();
  fetchFn.mockResolvedValue(
    wireResponse(
      toBinary(
        ApplyServiceEditsResponseSchema,
        create(ApplyServiceEditsResponseSchema, {
          results: [{ layerId: 1 }, { layerId: 0 }],
        }),
      ),
    ),
  );
  await expect(session.submit(batch)).rejects.toMatchObject({ name: "HonuaGrpcError", code: 13 });
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it("does not start metadata for a pre-aborted call", async () => {
  const { session, describe, fetchFn } = fixture();
  await expect(session.submit({ ...batch, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(HonuaAbortError);
  expect(describe).not.toHaveBeenCalled();
  expect(fetchFn).not.toHaveBeenCalled();
});

it("cancels a metadata wait without poisoning a later submit", async () => {
  const { session, client, describe } = fixture();
  let complete!: (value: DescribeLayerResponse) => void;
  describe.mockReturnValue(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const apply = vi.spyOn(client, "applyServiceEdits").mockResolvedValue({
    layers: [
      { layerId: 0, addResults: [{ objectId: 0, success: true }] },
      { layerId: 1, addResults: [{ objectId: 0, success: true }] },
    ],
  });
  const controller = new AbortController();
  const pending = session.submit({ ...batch, signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
  expect(apply).not.toHaveBeenCalled();
  complete(create(DescribeLayerResponseSchema));
  await expect(session.submit(batch)).resolves.toHaveProperty("sources.0.sourceId", "parents");
  expect(describe).toHaveBeenCalledTimes(2);
  expect(apply).toHaveBeenCalledTimes(1);
});
