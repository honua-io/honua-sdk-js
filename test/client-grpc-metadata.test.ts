import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { HonuaClient } from "../src/core/client.js";
import {
  DescribeLayerRequestSchema,
  DescribeLayerResponseSchema,
  DescribeServiceRequestSchema,
  DescribeServiceResponseSchema,
} from "../src/gen/geospatial/v1/feature_service_pb.js";

function frame(payload: Uint8Array, flags = 0): Uint8Array {
  const result = new Uint8Array(5 + payload.length);
  result[0] = flags;
  new DataView(result.buffer).setUint32(1, payload.length);
  result.set(payload, 5);
  return result;
}
function response(payload: Uint8Array): Response {
  const message = frame(payload);
  const trailers = frame(new TextEncoder().encode("grpc-status: 0\r\n"), 128);
  const body = new Uint8Array(message.length + trailers.length);
  body.set(message);
  body.set(trailers, message.length);
  return new Response(body, { headers: { "content-type": "application/grpc-web+proto" } });
}

function layerResponse(url: string, bytes: Uint8Array): Response {
  expect(url).toBe("https://example.test/geospatial.v1.FeatureService/DescribeLayer");
  expect(fromBinary(DescribeLayerRequestSchema, bytes.subarray(5))).toMatchObject({
    serviceId: "parcels",
    layerId: 7,
  });
  return response(
    toBinary(
      DescribeLayerResponseSchema,
      create(DescribeLayerResponseSchema, {
        layer: {
          serviceId: "parcels",
          layerId: 7,
          fields: [
            {
              definition: { name: "id", fieldType: 3 },
              defaultValue: { value: { case: "int64Value", value: 9007199254740993n } },
            },
          ],
        },
      }),
    ),
  );
}

function descriptorFetch(calls: string[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    calls.push(url);
    expect(new Headers(init?.headers).get("x-api-key")).toBe("key");
    const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
    if (url.endsWith("/DescribeService")) {
      expect(fromBinary(DescribeServiceRequestSchema, bytes.subarray(5))).toMatchObject({
        serviceId: "parcels",
        pageSize: 2,
        pageToken: "cursor",
      });
      return response(
        toBinary(
          DescribeServiceResponseSchema,
          create(DescribeServiceResponseSchema, {
            service: { serviceId: "parcels" },
            layers: [{ layerId: 7, name: "Parcels" }],
            nextPageToken: "next",
          }),
        ),
      );
    }
    return layerResponse(url, bytes);
  };
}

it("uses unary descriptor RPCs and retains int64 metadata without REST requests", async () => {
  const calls: string[] = [];
  const client = new HonuaClient({
    baseUrl: "https://example.test",
    transport: "grpc-web",
    apiKey: "key",
    fetchFn: descriptorFetch(calls),
  });
  const service = await client.describeService({ serviceId: "parcels", pageSize: 2, pageToken: "cursor" });
  expect(service.nextPageToken).toBe("next");
  const layer = await client.describeLayer({ serviceId: "parcels", layerId: 7 });
  expect(layer.layer?.fields[0]?.defaultValue?.value).toEqual({ case: "int64Value", value: 9007199254740993n });
  expect(calls).toHaveLength(2);
});
it("rejects descriptor calls on a REST client before issuing a request", async () => {
  const client = new HonuaClient({
    baseUrl: "https://example.test",
    fetchFn: async () => {
      throw new Error("unexpected request");
    },
  });
  await expect(client.describeLayer({ serviceId: "parcels", layerId: 7 })).rejects.toThrow("grpc-web");
});
