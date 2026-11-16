/**
 * Default transport for `connect()` on a GeoServices feature service.
 *
 * Transport is separate from protocol detection. With no caller client and no
 * `clientOptions.transport`, a cache miss makes one gRPC-Web probe (see
 * `createHonuaClient`) and the default client reads and edits over gRPC-Web
 * where the server offers it. The discovery snapshot records the choice, so a
 * cache hit replays it without a request.
 *
 * @module
 */
import type { ConnectTarget } from "./connect-geoservices.js";
import type { ConnectDiscoverySnapshot, ConnectOptions, ConnectResolvedProtocol } from "./connect.js";
import { HonuaAbortError, HonuaDiscoveryError } from "./core/errors.js";
import { grpcWebRuntimeLoads, selectHonuaTransport } from "./core/transport-selection.js";
import type { HonuaTransport } from "./core/types.js";

/**
 * Transport for a feature service's default client, or `undefined` when the
 * caller chose the client or transport, or the target is not a feature
 * service. A cache hit replays the recorded choice without a request, falling
 * back to REST where this environment cannot load the gRPC-Web runtime; a miss
 * probes once.
 */
export async function defaultFeatureServiceTransport(
  snapshot: ConnectDiscoverySnapshot | undefined,
  options: ConnectOptions,
  target: ConnectTarget,
): Promise<HonuaTransport | undefined> {
  if (options.client || target.protocol !== "geoservices-feature-service") return undefined;
  if (options.clientOptions?.transport !== undefined) return undefined;
  if (snapshot) {
    const recorded = snapshot.transport ?? "rest";
    return recorded === "grpc-web" && !(await grpcWebRuntimeLoads(target.clientBaseUrl)) ? "rest" : recorded;
  }
  try {
    return await selectHonuaTransport({
      ...options.clientOptions,
      baseUrl: target.clientBaseUrl,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) throw new HonuaAbortError(undefined, { cause: error });
    throw error;
  }
}

/** Refuse a cached transport that is not REST or gRPC-Web, or sits on another protocol. */
export function assertCachedTransport(transport: unknown, protocol: ConnectResolvedProtocol): void {
  if (transport === undefined) return;
  if (protocol === "geoservices-feature-service" && (transport === "rest" || transport === "grpc-web")) return;
  throw new HonuaDiscoveryError("invalid-discovery-cache", "Discovery cache records an invalid transport.");
}
