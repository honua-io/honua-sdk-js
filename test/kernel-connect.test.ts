import { describe, expect, it, vi } from "vitest";
import {
  type ConnectDiscoveryCache,
  type ConnectDiscoverySnapshot,
  type ConnectOptions,
  HONUA_CONNECT_ADAPTER_VERSION,
  HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
  HONUA_CONNECT_PROJECTION_VERSION,
  type HonuaConnection,
} from "../src/connect.js";
import { createDiscoveryCacheIdentity } from "../src/contract/discovery.js";
import { HonuaAbortError, HonuaDiscoveryError } from "../src/core/errors.js";
import {
  type KernelConnectDelegate,
  type KernelConnectOptions,
  createKernelLifecycle,
} from "../src/kernel/lifecycle.js";

const CONNECTION = Object.freeze({}) as HonuaConnection;

function recordingDelegate(calls: ConnectOptions[], connection: HonuaConnection = CONNECTION): KernelConnectDelegate {
  return async (options) => {
    calls.push(options);
    return connection;
  };
}

function abortingDelegate(calls: ConnectOptions[]): KernelConnectDelegate {
  return (options) => {
    calls.push(options);
    return new Promise<HonuaConnection>((_, reject) => {
      const abort = () => reject(new HonuaAbortError());
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  };
}

async function rejected(error: Promise<unknown>): Promise<Error> {
  try {
    await error;
  } catch (caught) {
    if (caught instanceof Error) return caught;
    throw new Error("Expected an Error rejection");
  }
  throw new Error("Expected promise to reject");
}

describe("kernel connect delegation", () => {
  it("forwards opaque locators to existing discovery while binding isolated cache and policy state", async () => {
    const firstCalls: ConnectOptions[] = [];
    const secondCalls: ConnectOptions[] = [];
    const first = createKernelLifecycle({
      capabilityPolicy: { allow: ["query"], deny: ["applyEdits"] },
      connectDelegate: recordingDelegate(firstCalls),
    });
    const second = createKernelLifecycle({
      capabilityPolicy: { allow: ["tiles"] },
      connectDelegate: recordingDelegate(secondCalls),
    });
    const locator = new URL("https://geo.example.test/a-later-adapter-path");
    const callerCache: ConnectDiscoveryCache = { get: vi.fn(), set: vi.fn() };

    const result = await first.connect(locator, {
      id: "future-source",
      cache: callerCache,
      capabilityPolicy: { allow: ["applyEdits"] },
    } as unknown as KernelConnectOptions);
    await second.connect("https://geo.example.test/second", { protocol: "ogc-features" });

    expect(result).toBe(CONNECTION);
    expect(firstCalls).toHaveLength(1);
    expect(firstCalls[0]?.endpoint).toBe("https://geo.example.test/a-later-adapter-path");
    expect(firstCalls[0]).toMatchObject({
      id: "future-source",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      capabilityPolicy: { allow: ["query"], deny: ["applyEdits"] },
    });
    expect(firstCalls[0]?.cache).toBe(first.discoveryCache);
    expect(firstCalls[0]?.cache).not.toBe(callerCache);
    expect(firstCalls[0]?.signal).toBe(first.signal);
    expect(secondCalls[0]?.cache).toBe(second.discoveryCache);
    expect(secondCalls[0]?.cache).not.toBe(first.discoveryCache);
    expect(secondCalls[0]?.signal).toBe(second.signal);
    expect(secondCalls[0]?.capabilityPolicy).toBe(second.policy.capabilities);

    await Promise.all([first.dispose(), second.dispose()]);
  });

  it("defaults only clean public locators to anonymous and retains safe format-query delegation", async () => {
    const calls: ConnectOptions[] = [];
    const lifecycle = createKernelLifecycle({ connectDelegate: recordingDelegate(calls) });
    const withFormat = "https://geo.example.test/FeatureServer/0?f=pjson";

    await lifecycle.connect(withFormat);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.endpoint).toBe("https://geo.example.test/FeatureServer/0");
    expect(calls[0]?.protocol).toBe("auto");
    expect(calls[0]?.authorizationScopeFingerprint).toBe("anonymous");
    await lifecycle.dispose();
  });

  it("fails closed for authenticated discovery configuration until a non-anonymous scope is explicit", async () => {
    const secret = "TOP-SECRET-API-KEY";
    const calls: ConnectOptions[] = [];
    const lifecycle = createKernelLifecycle({ connectDelegate: recordingDelegate(calls) });
    const endpoint = "https://geo.example.test/FeatureServer/0";

    const missing = await rejected(lifecycle.connect(endpoint, { clientOptions: { apiKey: secret } }));
    const anonymous = await rejected(
      lifecycle.connect(endpoint, {
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { apiKey: secret },
      }),
    );
    const customTransport = await rejected(
      lifecycle.connect(endpoint, { clientOptions: { fetchFn: vi.fn<typeof fetch>() } }),
    );

    for (const error of [missing, anonymous, customTransport]) {
      expect(error).toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-cache-identity" });
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(secret);
    }
    expect(calls).toHaveLength(0);

    await lifecycle.connect(endpoint, {
      authorizationScopeFingerprint: "tenant:alpha/role:reader",
      clientOptions: { apiKey: secret },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorizationScopeFingerprint).toBe("tenant:alpha/role:reader");
    expect(calls[0]?.clientOptions?.apiKey).toBe(secret);
    await lifecycle.dispose();
  });

  it("partitions caller-controlled GeoParquet profiling away from anonymous discovery", async () => {
    const calls: ConnectOptions[] = [];
    const lifecycle = createKernelLifecycle({ connectDelegate: recordingDelegate(calls) });
    const profiler = { profile: vi.fn() };
    const geoparquet = { profiler } as KernelConnectOptions["geoparquet"];

    await expect(
      lifecycle.connect("https://geo.example.test/parcels.parquet", { protocol: "geoparquet", geoparquet }),
    ).rejects.toMatchObject({ code: "invalid-cache-identity" });
    await expect(
      lifecycle.connect("https://geo.example.test/parcels.parquet", {
        protocol: "geoparquet",
        authorizationScopeFingerprint: "anonymous",
        geoparquet,
      }),
    ).rejects.toMatchObject({ code: "invalid-cache-identity" });

    await lifecycle.connect("https://geo.example.test/parcels.parquet", {
      protocol: "geoparquet",
      authorizationScopeFingerprint: "tenant:alpha/profiler:v1",
      geoparquet,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorizationScopeFingerprint).toBe("tenant:alpha/profiler:v1");
    expect(calls[0]?.geoparquet?.profiler).toBe(profiler);
    await lifecycle.dispose();
  });

  it("snapshots nested options without invoking ordinary accessors or Proxy get traps", async () => {
    const calls: ConnectOptions[] = [];
    const lifecycle = createKernelLifecycle({ connectDelegate: recordingDelegate(calls) });
    let propertyReads = 0;
    const trackReads = <T extends object>(target: T): T =>
      new Proxy(target, {
        get() {
          propertyReads += 1;
          throw new Error("a property getter was invoked");
        },
      });
    const before = vi.fn();
    const interceptorTarget = { before };
    const clientOptionsTarget = {
      apiKey: "SECRET",
      interceptors: trackReads([trackReads(interceptorTarget)]),
      retry: trackReads({ maxRetries: 2, retryStatuses: trackReads([429, 503]) }),
    };
    const options = trackReads({
      authorizationScopeFingerprint: "tenant:alpha/reader",
      clientOptions: trackReads(clientOptionsTarget),
      metadata: trackReads({ cache: "bypass" as const }),
    });

    await lifecycle.connect("https://geo.example.test/ogc", options);

    expect(propertyReads).toBe(0);
    expect(calls).toHaveLength(1);
    expect(Object.is(calls[0]?.clientOptions, clientOptionsTarget)).toBe(false);
    expect(Object.is(calls[0]?.clientOptions?.interceptors?.[0], interceptorTarget)).toBe(false);
    expect(calls[0]?.clientOptions?.retry?.retryStatuses).toEqual([429, 503]);
    expect(Object.isFrozen(calls[0]?.clientOptions?.retry?.retryStatuses)).toBe(true);
    await lifecycle.dispose();
  });

  it("rejects accessor-bearing options without invoking the accessor or delegating", async () => {
    const calls: ConnectOptions[] = [];
    const lifecycle = createKernelLifecycle({ connectDelegate: recordingDelegate(calls) });
    let getterCalls = 0;
    const options = {} as KernelConnectOptions;
    Object.defineProperty(options, "clientOptions", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { apiKey: "MUST-NOT-BE-READ" };
      },
    });

    await expect(lifecycle.connect("https://geo.example.test/ogc", options)).rejects.toThrow(
      "stable enumerable data fields",
    );
    expect(getterCalls).toBe(0);
    expect(calls).toHaveLength(0);
    await lifecycle.dispose();
  });

  it("rejects credential-bearing and identity-bearing locator forms without exposing their contents", async () => {
    const secret = "URL-CREDENTIAL-SHOULD-NOT-LEAK";
    const calls: ConnectOptions[] = [];
    const lifecycle = createKernelLifecycle({ connectDelegate: recordingDelegate(calls) });
    const unsafe = [
      `https://user:${secret}@geo.example.test/data`,
      `https://geo.example.test/data?access_token=${secret}`,
      `https://geo.example.test/data?collection=${secret}`,
      `https://geo.example.test/data#${secret}`,
    ];

    for (const locator of unsafe) {
      const error = await rejected(
        lifecycle.connect(locator, { authorizationScopeFingerprint: "tenant:alpha/role:reader" }),
      );
      expect(error).toBeInstanceOf(HonuaDiscoveryError);
      expect(error).toMatchObject({ code: "invalid-endpoint" });
      expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(secret);
    }
    expect(calls).toHaveLength(0);
    await lifecycle.dispose();
  });

  it("composes caller and owner cancellation without aborting either independent controller", async () => {
    const calls: ConnectOptions[] = [];
    const lifecycle = createKernelLifecycle({ connectDelegate: abortingDelegate(calls) });
    const caller = new AbortController();
    const callerPending = lifecycle.connect("https://geo.example.test/caller", { signal: caller.signal });

    expect(calls[0]?.signal).not.toBe(caller.signal);
    expect(calls[0]?.signal).not.toBe(lifecycle.signal);
    caller.abort(new Error("caller-only"));
    await expect(callerPending).rejects.toBeInstanceOf(HonuaAbortError);
    expect(lifecycle.signal.aborted).toBe(false);

    const ownerPending = lifecycle.connect("https://geo.example.test/owner");
    expect(calls[1]?.signal).toBe(lifecycle.signal);
    expect(caller.signal.aborted).toBe(true);
    const disposal = lifecycle.dispose();
    await expect(ownerPending).rejects.toBeInstanceOf(HonuaAbortError);
    await disposal;
    expect(caller.signal.reason).toEqual(new Error("caller-only"));
    await expect(lifecycle.connect("https://geo.example.test/late")).rejects.toThrow("after disposal has started");
  });

  it("rejects and cleans a late delegated result when the delegate ignores owner cancellation", async () => {
    let resolve: (connection: HonuaConnection) => void = () => undefined;
    const delegated = new Promise<HonuaConnection>((complete) => {
      resolve = complete;
    });
    const dispose = vi.fn(async () => undefined);
    const late = Object.assign({}, { [Symbol.asyncDispose]: dispose }) as unknown as HonuaConnection;
    const lifecycle = createKernelLifecycle({ connectDelegate: async () => delegated });

    const pending = lifecycle.connect("https://geo.example.test/late");
    const disposal = lifecycle.dispose();
    resolve(late);

    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
    await disposal;
    expect(dispose).toHaveBeenCalledTimes(1);

    let reject: (error: unknown) => void = () => undefined;
    const rejectedDelegate = new Promise<HonuaConnection>((_, fail) => {
      reject = fail;
    });
    const rejectingLifecycle = createKernelLifecycle({ connectDelegate: async () => rejectedDelegate });
    const rejectedPending = rejectingLifecycle.connect("https://geo.example.test/late-rejection");
    const rejectingDisposal = rejectingLifecycle.dispose();
    reject(new Error("late delegate failure"));
    await expect(rejectedPending).rejects.toBeInstanceOf(HonuaAbortError);
    await rejectingDisposal;
  });

  it("retains actionable multi-source ambiguity from the delegated discovery result", async () => {
    const endpoint = "https://geo.example.test/ogc";
    const lifecycle = createKernelLifecycle();
    const cacheIdentity = await createDiscoveryCacheIdentity({
      endpoint,
      protocol: "ogc-features",
      authorizationScopeFingerprint: "anonymous",
      adapterVersion: HONUA_CONNECT_ADAPTER_VERSION,
      projectionVersion: HONUA_CONNECT_PROJECTION_VERSION,
    });
    const snapshot: ConnectDiscoverySnapshot = Object.freeze({
      version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
      identityKey: cacheIdentity.key,
      endpoint: cacheIdentity.endpoint,
      protocol: "ogc-features",
      retrievedAt: "2026-07-15T00:00:00.000Z",
      evidence: Object.freeze([{ kind: "metadata" as const, capabilities: Object.freeze(["query"] as const) }]),
      sources: Object.freeze(
        ["parcels", "roads"].map((id) =>
          Object.freeze({
            id,
            locator: Object.freeze({ url: endpoint, collectionId: id, layout: "ogc-api" as const }),
          }),
        ),
      ),
    });
    lifecycle.discoveryCache.set(cacheIdentity, snapshot, {});

    const connection = await lifecycle.connect(endpoint, { protocol: "ogc-features" });
    expect(connection.inspection.defaultSourceId).toBeUndefined();

    let ambiguity: unknown;
    try {
      connection.source();
    } catch (error) {
      ambiguity = error;
    }
    expect(ambiguity).toBeInstanceOf(HonuaDiscoveryError);
    expect(ambiguity).toMatchObject({
      code: "ambiguous-source",
      detail: { sourceIds: ["parcels", "roads"] },
    });
    expect((ambiguity as Error).message).toContain("pass one of: parcels, roads");
    expect(connection.source("roads").descriptor.id).toBe("roads");

    await lifecycle.dispose();
  });
});
