/**
 * Native-first transport selection. {@link createHonuaClient} uses gRPC-Web
 * when the server answers gRPC-Web and the optional Buf/Connect peers are
 * installed, and GeoServices REST otherwise. The choice is made once, before
 * the first data call; a call on the chosen transport never retries on the
 * other one.
 *
 * @module
 */
import { HonuaClient } from "./client.js";
import { HonuaOptionalGrpcPeerError } from "./optional-grpc-peer.js";
import type { HonuaClientOptions, HonuaTransport } from "./types.js";

/** `"auto"` selects gRPC-Web where the server offers it, REST otherwise. */
export type HonuaTransportPreference = HonuaTransport | "auto";

/** Options for {@link createHonuaClient}. */
export interface CreateHonuaClientOptions extends Omit<HonuaClientOptions, "transport"> {
  /**
   * Transport preference. Default `"auto"`: gRPC-Web when the server answers a
   * gRPC-Web probe and the optional peers (`@bufbuild/protobuf`,
   * `@connectrpc/connect`, `@connectrpc/connect-web`) are installed, otherwise
   * `"rest"`. `"rest"` and `"grpc-web"` skip the probe.
   */
  readonly transport?: HonuaTransportPreference;
  /** Cancels the transport probe. */
  readonly signal?: AbortSignal;
}

/**
 * Create a {@link HonuaClient} on the native gRPC-Web transport where the
 * server offers it, with GeoServices REST as the compatibility transport.
 *
 * The probe is one unary `DescribeService` call with an empty service ID. Any
 * gRPC-Web answer, including the expected `INVALID_ARGUMENT`, shows the server
 * serves the native contract. A response that is not gRPC-Web (for example an
 * HTML 404 from a REST-only server), no response at all (an unreachable host
 * or a CORS policy that does not admit gRPC-Web), or missing optional peers
 * selects REST. Check `client.isGrpcWeb` to see which transport was chosen.
 *
 * @throws The caller's abort reason when `signal` aborts during the probe.
 *
 * @example
 * ```ts
 * const client = await createHonuaClient({ baseUrl: "https://your-honua-server.example" });
 * const rest = await createHonuaClient({ baseUrl, transport: "rest" }); // no probe
 * ```
 */
export async function createHonuaClient(options: CreateHonuaClientOptions): Promise<HonuaClient> {
  return createHonuaClientWith(options, (clientOptions) => new HonuaClient(clientOptions));
}

/**
 * @internal Shared by the root and `grpc-web` entrypoints: `makeClient` builds the
 * client for a resolved transport, so the browser entrypoint can probe and
 * return its statically bound gRPC-Web class.
 */
export async function createHonuaClientWith(
  options: CreateHonuaClientOptions,
  makeClient: (options: HonuaClientOptions & { readonly transport: HonuaTransport }) => HonuaClient,
): Promise<HonuaClient> {
  const { transport = "auto", signal, ...clientOptions } = options;
  const selected = transport === "auto" ? await probeTransport(clientOptions, signal, makeClient) : transport;
  return makeClient({ ...clientOptions, transport: selected });
}

/**
 * Probe the server once and return the transport {@link createHonuaClient}
 * would choose. Exposed for callers that construct clients themselves.
 */
export async function selectHonuaTransport(
  options: Omit<HonuaClientOptions, "transport">,
  signal?: AbortSignal,
): Promise<HonuaTransport> {
  return probeTransport(options, signal, (clientOptions) => new HonuaClient(clientOptions));
}

async function probeTransport(
  options: Omit<HonuaClientOptions, "transport">,
  signal: AbortSignal | undefined,
  makeClient: (options: HonuaClientOptions & { readonly transport: HonuaTransport }) => HonuaClient,
): Promise<HonuaTransport> {
  signal?.throwIfAborted();
  const baseFetch = (options.fetchFn ?? fetch).bind(globalThis);
  let answer: Response | undefined;
  const probe = makeClient({
    ...options,
    transport: "grpc-web",
    // One attempt: a retried probe only delays the fallback decision.
    retry: { maxRetries: 0 },
    fetchFn: async (input, init) => {
      const response = await baseFetch(input, init);
      answer = response;
      return response;
    },
  });
  try {
    await probe.describeService({ serviceId: "", ...(signal ? { signal } : {}) });
    return "grpc-web";
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof HonuaOptionalGrpcPeerError) return "rest";
    return answer !== undefined && isGrpcWebAnswer(answer) ? "grpc-web" : "rest";
  }
}

function isGrpcWebAnswer(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return /^application\/grpc-web(?:-text)?(?:[+;]|$)/iu.test(contentType) || response.headers.has("grpc-status");
}
