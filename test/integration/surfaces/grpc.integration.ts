/**
 * gRPC-web transport integration coverage. Drives the SDK's
 * `transport: "grpc-web"` FeatureService path against the seeded layer and
 * asserts the three properties that matter for a wire transport:
 *
 *   1. a query round-trips and decodes to the same protocol-neutral shape,
 *   2. results reach parity with the REST transport for an identical query,
 *   3. the configured auth credential is attached to every gRPC-web request,
 *   4. a transient failure is replayed through the shared retry/backoff path.
 *
 * gRPC-web depends on the server publishing the FeatureService over its HTTP
 * endpoint, which many seeds/deployments do not. Capability is therefore
 * discovered at runtime by probing a query: if the transport is unreachable
 * (Connect/network error, or a capability-gap HTTP status) the whole surface
 * skips with an explicit reason and is recorded as skipped in the run metadata.
 *
 * @module
 */

import { HonuaClient } from "@honua/sdk-js";
import type { QueryFeaturesRequest } from "@honua/sdk-js/honua";
import { expect, it } from "vitest";
import {
  type CapabilityGap,
  classifyCapabilityGap,
  integrationSuite,
  recordSurface,
  runWithDiagnostics,
} from "../harness.js";

const SURFACE = "grpc";

integrationSuite("gRPC-web transport", SURFACE, ({ client: restClient, context, config }) => {
  // Bounded, replay-safe query: `where=1=1` with a small record cap so the
  // parity/round-trip assertions stay deterministic regardless of seed size.
  const baseQuery: QueryFeaturesRequest = {
    serviceId: config.serviceId,
    layerId: config.layerId,
    where: "1=1",
    outFields: ["*"],
    returnGeometry: true,
    outSr: 4326,
    resultRecordCount: 10,
  };

  const makeGrpcClient = (extra: Record<string, unknown> = {}): HonuaClient =>
    new HonuaClient({
      baseUrl: config.baseUrl,
      transport: "grpc-web",
      timeoutMs: config.timeoutMs,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.bearerToken ? { bearerToken: config.bearerToken } : {}),
      ...extra,
    } as ConstructorParameters<typeof HonuaClient>[0]);

  // Memoized runtime capability probe. `undefined` => transport usable.
  let probe: Promise<CapabilityGap | undefined> | undefined;
  const probeCapability = (): Promise<CapabilityGap | undefined> => {
    probe ??= (async () => {
      try {
        await makeGrpcClient().queryFeatures({ ...baseQuery, resultRecordCount: 1 });
        return undefined;
      } catch (error) {
        if ((process.env.HONUA_DEPLOYMENT_TARGET ?? "").trim() === "local-docker") {
          throw error;
        }
        // A gRPC-web transport that the server does not serve surfaces as a
        // Connect "unimplemented"/network error rather than an HTTP status the
        // classifier recognizes. An external deployment may explicitly omit
        // the optional transport, but the deterministic self-contained lane
        // advertises gRPC-web and therefore fails closed above.
        const gap =
          classifyCapabilityGap("gRPC-web FeatureService", error) ??
          ({
            reason: `gRPC-web transport unavailable: ${error instanceof Error ? error.message : String(error)}`,
          } satisfies CapabilityGap);
        return gap;
      }
    })();
    return probe;
  };

  const skipIfUnavailable = async (ctx: { skip: (note?: string) => void }): Promise<CapabilityGap | undefined> => {
    const gap = await probeCapability();
    if (gap) {
      recordSurface(SURFACE, gap.reason);
      ctx.skip(gap.reason);
    }
    return gap;
  };

  it("round-trips a query over the gRPC-web transport [cert:grpc-web/query#positive] [cert:grpc-web/query#pagination] [cert:grpc-web/query#media-schema]", async (ctx) => {
    if (await skipIfUnavailable(ctx)) return;
    const grpc = makeGrpcClient();
    const result = await runWithDiagnostics(context, "grpc queryFeatures", () => grpc.queryFeatures(baseQuery));
    const features = result.features ?? [];
    expect(Array.isArray(features)).toBe(true);
    expect(features.length).toBeGreaterThan(0);
    expect(features[0]?.attributes).toBeDefined();

    const firstPage = await runWithDiagnostics(context, "grpc first page", () =>
      grpc.queryFeatures({ ...baseQuery, orderByFields: "objectid ASC", resultOffset: 0, resultRecordCount: 1 }),
    );
    const secondPage = await runWithDiagnostics(context, "grpc second page", () =>
      grpc.queryFeatures({ ...baseQuery, orderByFields: "objectid ASC", resultOffset: 1, resultRecordCount: 1 }),
    );
    expect(firstPage.features).toHaveLength(1);
    expect(secondPage.features).toHaveLength(1);
    expect(firstPage.features?.[0]?.attributes).toMatchObject({ objectid: 4, name: "alpha" });
    expect(secondPage.features?.[0]?.attributes).toMatchObject({ objectid: 5, name: "beta" });
  });

  it("returns query parity with the REST transport [cert:grpc-web/rest-parity#positive] [cert:grpc-web/rest-parity#media-schema]", async (ctx) => {
    if (await skipIfUnavailable(ctx)) return;
    const grpc = makeGrpcClient();
    const [rest, grpcResult] = await Promise.all([
      runWithDiagnostics(context, "rest queryFeatures (parity)", () => restClient.queryFeatures(baseQuery)),
      runWithDiagnostics(context, "grpc queryFeatures (parity)", () => grpc.queryFeatures(baseQuery)),
    ]);
    const restFeatures = rest.features ?? [];
    const grpcFeatures = grpcResult.features ?? [];
    // Same query, same record cap → same feature count across transports.
    expect(grpcFeatures.length).toBe(restFeatures.length);
    // And the same attribute schema on the first feature (field-name parity is
    // the drift signal the conformance lane also guards).
    const restKeys = Object.keys(restFeatures[0]?.attributes ?? {}).sort();
    const grpcKeys = Object.keys(grpcFeatures[0]?.attributes ?? {}).sort();
    if (restKeys.length > 0) {
      expect(grpcKeys).toEqual(restKeys);
    }
  });

  it("attaches the configured auth credential to gRPC-web requests [cert:grpc-web/authentication#positive] [cert:grpc-web/authentication#auth] [cert:grpc-web/authentication#media-schema]", async (ctx) => {
    if (await skipIfUnavailable(ctx)) return;
    if (!config.apiKey && !config.bearerToken) {
      ctx.skip("no apiKey/bearerToken configured; no credential to assert on the wire");
      return;
    }
    const seenHeaders: Headers[] = [];
    const recordingFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      seenHeaders.push(headers);
      return fetch(input, init);
    };
    const grpc = makeGrpcClient({ fetchFn: recordingFetch });
    await runWithDiagnostics(context, "grpc queryFeatures (auth)", () => grpc.queryFeatures(baseQuery));
    expect(seenHeaders.length).toBeGreaterThan(0);
    const attached = seenHeaders.some(
      (headers) =>
        (config.apiKey !== undefined && headers.get("x-api-key") === config.apiKey) ||
        (config.bearerToken !== undefined && headers.get("authorization") === `Bearer ${config.bearerToken}`),
    );
    expect(attached).toBe(true);
  });

  it("replays a transient failure through the gRPC-web retry/backoff path [cert:grpc-web/retry#positive] [cert:grpc-web/retry#negative] [cert:grpc-web/retry#media-schema]", async (ctx) => {
    if (await skipIfUnavailable(ctx)) return;
    // Fail the first gRPC-web POST with HTTP 503 (Connect maps this to the
    // retryable `unavailable` code), then delegate to the real transport. A
    // working retry interceptor replays the unary call and the query succeeds;
    // a broken one throws on the first attempt.
    let calls = 0;
    const flakyFetch: typeof fetch = (input, init) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          new Response("temporarily unavailable", {
            status: 503,
            headers: { "content-type": "text/plain" },
          }),
        );
      }
      return fetch(input, init);
    };
    const grpc = makeGrpcClient({
      retry: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 },
      fetchFn: flakyFetch,
    });
    const result = await runWithDiagnostics(context, "grpc queryFeatures (retry)", () => grpc.queryFeatures(baseQuery));
    expect(calls).toBeGreaterThan(1);
    expect(Array.isArray(result.features ?? [])).toBe(true);
  });
});
