import { create, toBinary } from "@bufbuild/protobuf";
import {
  type ApplyEditsResponse,
  ApplyEditsResponseSchema,
  type Geometry,
  QueryFeaturesResponseSchema,
} from "../../src/gen/geospatial/v1/index.js";

function frame(bytes: Uint8Array, flags = 0): Uint8Array {
  const framed = new Uint8Array(bytes.length + 5);
  framed[0] = flags;
  new DataView(framed.buffer).setUint32(1, bytes.length);
  framed.set(bytes, 5);
  return framed;
}

export function wireResponse(bytes: Uint8Array): Response {
  const data = frame(bytes);
  const trailers = frame(new TextEncoder().encode("grpc-status: 0\r\n"), 128);
  const body = new Uint8Array(data.length + trailers.length);
  body.set(data);
  body.set(trailers, data.length);
  return new Response(body, { headers: { "content-type": "application/grpc-web+proto" } });
}

export function response(message: ApplyEditsResponse): Response {
  return wireResponse(toBinary(ApplyEditsResponseSchema, message));
}

export function queryResponse(geometry: Geometry): Response {
  return wireResponse(
    toBinary(
      QueryFeaturesResponseSchema,
      create(QueryFeaturesResponseSchema, {
        objectIdFieldName: "OBJECTID",
        features: [{ id: 1n, geometry }],
      }),
    ),
  );
}
