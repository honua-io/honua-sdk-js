/**
 * Browser gRPC-Web client with statically bound optional Buf/Connect peers.
 * Install the three runtime peers before importing this opt-in entrypoint.
 * REST consumers should keep using the default or honua entrypoint.
 * @packageDocumentation
 */
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";

import { HonuaClient as BaseHonuaClient } from "./core/client.js";
import * as grpcAdapter from "./core/grpc-adapter.js";
import type { HonuaClientOptions } from "./core/types.js";
import { FeatureService } from "./gen/geospatial/v1/feature_service_pb.js";

export type GrpcWebClientOptions = Omit<HonuaClientOptions, "transport"> & { transport?: "grpc-web" };

/** A native client whose transport and adapters can be bundled for the browser. */
export class HonuaClient extends BaseHonuaClient {
  public constructor(options: GrpcWebClientOptions) {
    super({ ...options, transport: "grpc-web" });
  }

  protected override loadGrpcWebRuntime() {
    return Promise.resolve({ createClient, createGrpcWebTransport, FeatureService });
  }

  protected override loadGrpcAdapter() {
    return Promise.resolve(grpcAdapter);
  }
}
