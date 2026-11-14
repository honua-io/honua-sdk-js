import { create, toBinary } from "@bufbuild/protobuf";
import {
  type ApplyEditsResponse,
  ApplyEditsResponseSchema,
  type Geometry,
  QueryFeaturesResponseSchema,
} from "../../src/gen/geospatial/v1/index.js";

import { wireResponse } from "./grpc-wire.js";

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
