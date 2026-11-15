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
import { isGrpcRuntimeLoadFailure } from "./optional-grpc-peer.js";
import type { HonuaClientOptions, HonuaTransport } from "./types.js";

/** `"auto"` selects gRPC-Web where the server offers it, REST otherwise. */
export type HonuaTransportPreference = HonuaTransport | "auto";

/** How long the transport probe waits for an answer before selecting REST. */
export const HONUA_TRANSPORT_PROBE_TIMEOUT_MS = 5_000;

const MAX_TIMER_MS = 2_147_483_647;

/** Options for {@link selectHonuaTransport}. */
export interface SelectHonuaTransportOptions extends Omit<HonuaClientOptions, "transport"> {
  /** Cancels the transport probe; the returned promise rejects with the abort reason. */
  readonly signal?: AbortSignal;
  /**
   * Milliseconds to wait for the probe's answer, counted from when the request is
   * sent, before selecting REST. Default {@link HONUA_TRANSPORT_PROBE_TIMEOUT_MS};
   * must be finite, positive and at most 2147483647, otherwise the probe throws
   * `RangeError`.
   */
  readonly probeTimeoutMs?: number;
}

/** Options for {@link createHonuaClient}. */
export interface CreateHonuaClientOptions extends SelectHonuaTransportOptions {
  /**
   * Transport preference. Default `"auto"`: gRPC-Web when the server answers a
   * gRPC-Web probe and the optional peers (`@bufbuild/protobuf`,
   * `@connectrpc/connect`, `@connectrpc/connect-web`) can be loaded, otherwise
   * `"rest"`. `"rest"` and `"grpc-web"` skip the probe.
   */
  readonly transport?: HonuaTransportPreference;
}

type ClientFactory = (options: HonuaClientOptions & { readonly transport: HonuaTransport }) => HonuaClient;

/**
 * Create a {@link HonuaClient} on the native gRPC-Web transport where the
 * server offers it, with GeoServices REST as the compatibility transport.
 *
 * The probe is one unary `DescribeService` call with an empty service ID. Any
 * gRPC-Web answer, including the expected `INVALID_ARGUMENT`, shows the server
 * serves the native contract. A response that is not gRPC-Web (for example an
 * HTML 404 from a REST-only server), no response within the probe timeout after
 * the request is sent (an unreachable host, or a CORS policy that does not admit
 * gRPC-Web), or a gRPC runtime that cannot be loaded select REST. Check
 * `client.isGrpcWeb` to see which transport was chosen.
 *
 * Browser bundles: import `createHonuaClient` from `@honua/sdk-js/grpc-web`.
 * This variant loads the peers through a runtime specifier that bundlers do not
 * follow, so in a bundled browser app it always selects REST.
 *
 * @throws The caller's abort reason when `signal` aborts during the probe, and
 *   any error raised before the probe request is sent (for example a failing
 *   `auth` provider), so a local failure is never read as a REST-only server.
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
 * Probe the server once and return the transport {@link createHonuaClient}
 * would choose, for callers that construct clients themselves. Same browser
 * caveat as {@link createHonuaClient}.
 */
export async function selectHonuaTransport(options: SelectHonuaTransportOptions): Promise<HonuaTransport> {
  return selectHonuaTransportWith(options, (clientOptions) => new HonuaClient(clientOptions));
}

/**
 * @internal Shared by the root and `grpc-web` entrypoints: `makeClient` builds the
 * client for a resolved transport, so the browser entrypoint can probe and
 * return its statically bound gRPC-Web class.
 */
export async function createHonuaClientWith(
  options: CreateHonuaClientOptions,
  makeClient: ClientFactory,
): Promise<HonuaClient> {
  const { transport = "auto", signal, probeTimeoutMs, ...clientOptions } = options;
  const selected =
    transport === "auto"
      ? await selectHonuaTransportWith(
          {
            ...clientOptions,
            ...(signal ? { signal } : {}),
            ...(probeTimeoutMs !== undefined ? { probeTimeoutMs } : {}),
          },
          makeClient,
        )
      : transport;
  return makeClient({ ...clientOptions, transport: selected });
}

/** @internal See {@link createHonuaClientWith}. */
export async function selectHonuaTransportWith(
  options: SelectHonuaTransportOptions,
  makeClient: ClientFactory,
): Promise<HonuaTransport> {
  const { signal, probeTimeoutMs = HONUA_TRANSPORT_PROBE_TIMEOUT_MS, ...clientOptions } = options;
  if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs <= 0 || probeTimeoutMs > MAX_TIMER_MS) {
    throw new RangeError(`probeTimeoutMs must be a positive number of milliseconds up to ${MAX_TIMER_MS}.`);
  }
  signal?.throwIfAborted();
  const baseFetch = (clientOptions.fetchFn ?? fetch).bind(globalThis);
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sent = false;
  let answer: Response | undefined;
  const probe = makeClient({
    ...clientOptions,
    transport: "grpc-web",
    // One attempt: a retried probe only delays the decision.
    retry: { maxRetries: 0 },
    fetchFn: async (input, init) => {
      // The deadline covers the server round trip, not local module loading or auth.
      sent = true;
      timer = setTimeout(() => deadline.abort(new Error("transport probe timed out")), probeTimeoutMs);
      const response = await baseFetch(input, init);
      answer = response;
      return response;
    },
  });

  const forwardAbort = () => deadline.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    await probe.describeService({ serviceId: "", signal: deadline.signal });
    return "grpc-web";
  } catch (error) {
    signal?.throwIfAborted();
    if (answer !== undefined) return isGrpcWebAnswer(answer) ? "grpc-web" : "rest";
    if (sent || isGrpcRuntimeLoadFailure(error)) return "rest";
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

function isGrpcWebAnswer(response: Response): boolean {
  // content-type is readable cross-origin without an expose list; grpc-status is not.
  const contentType = response.headers.get("content-type") ?? "";
  return /^application\/grpc-web(?:-text)?(?:[+;]|$)/iu.test(contentType) || response.headers.has("grpc-status");
}
