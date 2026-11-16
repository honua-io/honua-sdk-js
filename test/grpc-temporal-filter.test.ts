import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { createDataset } from "../src/contract/index.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import { toProtoQueryRequest } from "../src/core/grpc-adapter.js";
import { FeaturePageSchema, QueryFeaturesResponseSchema } from "../src/gen/geospatial/v1/index.js";

const window = { kind: "interval" as const, start: "2026-01-01T00:00:00Z", end: null };

function fixture() {
  const fetchFn = vi.fn(() => {
    throw new Error("Unexpected network request");
  });
  const queryFeatures = vi.fn(async () => create(QueryFeaturesResponseSchema));
  const queryFeaturesStream = vi.fn(async function* () {
    yield create(FeaturePageSchema, { isLastPage: true });
  });
  const client = new HonuaClient({ baseUrl: "https://example.test", transport: "grpc-web", fetchFn });
  Object.defineProperty(client, "connectClient", { value: { queryFeatures, queryFeaturesStream } });
  const source = createDataset({
    id: "fixture",
    client,
    skipCompatibilityCheck: true,
    sources: [
      {
        id: "inspections",
        protocol: "grpc",
        locator: { url: client.serverBaseUrl, serviceId: "published", layerId: 0 },
        capabilities: new Set(["query", "stream"]),
      },
    ],
  }).source("inspections")!;
  return { client, source, queryFeatures, queryFeaturesStream, fetchFn };
}

describe("gRPC temporal filters", () => {
  it.each(["0", "null,1767225600000", "", 0])("rejects an explicit unsupported time parameter: %j", (time) => {
    expect(() => toProtoQueryRequest({ serviceId: "published", layerId: 0, extraParams: { time } })).toThrow(
      HonuaCapabilityNotSupportedError,
    );
  });

  it("rejects a field-less canonical time window before either RPC is called", async () => {
    const { client, source, queryFeatures, queryFeaturesStream, fetchFn } = fixture();
    await expect(source.query({ temporalFilter: window })).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(source.stream({ temporalFilter: window }).next()).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
    await expect(
      client.queryFeaturesStream({ serviceId: "published", layerId: 0, extraParams: { time: "0" } }).next(),
    ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    expect(queryFeatures).not.toHaveBeenCalled();
    expect(queryFeaturesStream).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("preserves field-bound temporal predicates in unary and streaming requests", async () => {
    const { source, queryFeatures, fetchFn } = fixture();
    const temporalFilter = { ...window, field: "REPORTED_AT" };
    await source.query({ temporalFilter });
    await source.stream({ temporalFilter }).next();
    expect(queryFeatures).toHaveBeenCalledTimes(2);
    for (const call of queryFeatures.mock.calls) {
      expect(call).toEqual([
        expect.objectContaining({
          serviceId: "published",
          layerId: 0,
          where: expect.stringMatching(/REPORTED_AT.*>=.*2026-01-01/),
        }),
        undefined,
      ]);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("preserves an ordinary query when time is omitted", async () => {
    const { source, queryFeatures } = fixture();
    await source.query({ where: "OBJECTID = 0" });
    expect(queryFeatures).toHaveBeenCalledWith(expect.objectContaining({ where: "OBJECTID = 0" }), undefined);
    expect(toProtoQueryRequest({ serviceId: "published", layerId: 0 }).where).toBe("1=1");
  });
});
