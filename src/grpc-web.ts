/**
 * Browser gRPC-Web client with statically bound optional Buf/Connect peers.
 * Install the three runtime peers before importing this opt-in entrypoint.
 * REST consumers should keep using the default or honua entrypoint.
 * @experimental
 * @packageDocumentation
 */
import { createClient } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";

import { HonuaClient as BaseHonuaClient } from "./core/client.js";
import * as grpcAdapter from "./core/grpc-adapter.js";
import {
  type CreateHonuaClientOptions,
  type SelectHonuaTransportOptions,
  createHonuaClientWith,
  selectHonuaTransportWith,
} from "./core/transport-selection.js";
import type { HonuaTransport } from "./core/types.js";
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

/**
 * Browser variant of the root `createHonuaClient`: probes with this entrypoint's
 * statically bound gRPC-Web runtime and returns its {@link HonuaClient} when the
 * server answers gRPC-Web, or a REST client otherwise. Pass `transport` to skip
 * the probe.
 */
export function createHonuaClient(options: CreateHonuaClientOptions): Promise<BaseHonuaClient> {
  return createHonuaClientWith(options, ({ transport, ...clientOptions }) =>
    transport === "grpc-web" ? new HonuaClient(clientOptions) : new BaseHonuaClient({ ...clientOptions, transport }),
  );
}

/** Browser variant of the root `selectHonuaTransport`, probing with this entrypoint's bound runtime. */
export function selectHonuaTransport(options: SelectHonuaTransportOptions): Promise<HonuaTransport> {
  return selectHonuaTransportWith(options, ({ transport, ...clientOptions }) =>
    transport === "grpc-web" ? new HonuaClient(clientOptions) : new BaseHonuaClient({ ...clientOptions, transport }),
  );
}

export { HONUA_TRANSPORT_PROBE_TIMEOUT_MS } from "./core/transport-selection.js";
export type {
  CreateHonuaClientOptions,
  HonuaTransportPreference,
  SelectHonuaTransportOptions,
} from "./core/transport-selection.js";
