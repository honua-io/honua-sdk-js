import { describe, expect, it, vi } from "vitest";
import type { ConnectOptions, HonuaConnection } from "../src/connect.js";
import type { SourceDiscoveryInspection } from "../src/contract/discovery.js";
import type { Dataset, Source, SourceDescriptor, SourceId } from "../src/contract/types.js";
import { HonuaAbortError, HonuaDiscoveryError } from "../src/core/errors.js";
import { type ConnectLocator, type HonuaKernelOptions, createHonua, createHonuaKernel } from "../src/kernel/index.js";
import type { KernelConnectDelegate } from "../src/kernel/lifecycle.js";

interface MockConnection {
  readonly connection: HonuaConnection;
  readonly inspections: SourceDiscoveryInspection[];
  readonly source: ReturnType<typeof vi.fn>;
}

function mockConnection(
  ids: readonly SourceId[],
  options: {
    readonly id?: string;
    readonly endpoint?: string;
    readonly cacheStatus?: "bypass" | "hit" | "miss" | "refreshed";
    readonly diagnostic?: string;
    readonly defaultSourceId?: SourceId | null;
  } = {},
): MockConnection {
  const endpoint = options.endpoint ?? "https://geo.example.test/ogc";
  const inspections = ids.map((id): SourceDiscoveryInspection => {
    const descriptor: SourceDescriptor = {
      id,
      protocol: "ogc-features",
      locator: {
        url: endpoint,
        collectionId: id,
      },
      capabilities: new Set(["query"]),
      schema: { primaryKey: "id", fields: [{ name: "id", type: "esriFieldTypeString" }] },
    };
    return {
      descriptor,
      metadata: { crs: ["EPSG:4326"] },
      discovery: "metadata",
      provenance: [{ source: endpoint, retrievedAt: "2026-07-15T00:00:00.000Z" }],
      capabilityDecisions: [],
      diagnostics: options.diagnostic
        ? [{ code: "partial-discovery", severity: "warning", message: options.diagnostic }]
        : [],
    };
  });
  const sourceById = new Map(
    inspections.map((inspection) => {
      const source = {
        descriptor: inspection.descriptor,
        capabilities: inspection.descriptor.capabilities,
      } as Source;
      return [inspection.descriptor.id, source] as const;
    }),
  );
  const dataset = {
    id: options.id ?? "managed",
    sourceDescriptors: inspections.map((entry) => entry.descriptor),
    sourceIds: () => [...sourceById.keys()],
    source: (id: SourceId) => sourceById.get(id),
  } as unknown as Dataset;
  const source = vi.fn((id?: SourceId) => {
    const resolved = id ?? (ids.length === 1 ? ids[0] : undefined);
    const value = resolved ? sourceById.get(resolved) : undefined;
    if (!value) throw new HonuaDiscoveryError("ambiguous-source", "mock source mismatch");
    return value;
  });
  const defaultSourceId =
    options.defaultSourceId === null ? undefined : (options.defaultSourceId ?? (ids.length === 1 ? ids[0] : undefined));
  return {
    inspections,
    source,
    connection: {
      id: options.id ?? "managed",
      dataset,
      inspection: {
        id: options.id ?? "managed",
        endpoint,
        protocol: "ogc-features",
        ...(defaultSourceId ? { defaultSourceId } : {}),
        sources: inspections,
        diagnostics: inspections.flatMap((entry) => [...entry.diagnostics]),
        cacheIdentity: {
          version: 1,
          endpoint,
          protocol: "ogc-features",
          authorizationScopeDigest: "sha256:SECRET-CACHE-PARTITION",
          key: "discovery:v1:SECRET-CACHE-KEY",
        },
        cacheStatus: options.cacheStatus ?? "miss",
      },
      source,
    } as unknown as HonuaConnection,
  };
}

function sequenceDelegate(
  calls: ConnectOptions[],
  results: Array<HonuaConnection | Promise<HonuaConnection>>,
): KernelConnectDelegate {
  return async (options) => {
    calls.push(options);
    const next = results.shift();
    if (!next) throw new Error("No delegated discovery result was queued.");
    return next;
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("Expected an Error rejection.");
  }
  throw new Error("Expected a rejection.");
}

describe("createHonua application kernel facade", () => {
  it("projects only the public construction options into the internal lifecycle", async () => {
    const options = {
      capabilityPolicy: { allow: ["query"] },
      discoveryCacheMaxEntries: 2,
      connectDelegate: "not-a-public-option",
    } as unknown as HonuaKernelOptions;

    const honua = createHonua(options);
    await expect(honua.dispose()).resolves.toBeUndefined();
    expect(() => createHonua({ discoveryCacheMaxEntries: 0 })).toThrow(RangeError);
  });

  it("returns a deeply immutable, detached, credential-safe inspection without exposing cache partitions", async () => {
    const secret = "TOP-SECRET-API-KEY";
    const advertisedSecret = "SIGNED-URL-SECRET";
    const raw = mockConnection(["parcels"], {
      endpoint: `https://user:password@geo.example.test/ogc?access_token=${advertisedSecret}&collection=parcels#private`,
      diagnostic: `metadata token=${secret} failed at https://user:password@geo.example.test/ogc?access_token=${advertisedSecret}`,
    });
    const calls: ConnectOptions[] = [];
    const honua = createHonuaKernel({ connectDelegate: sequenceDelegate(calls, [raw.connection]) });
    const locator = new URL("https://geo.example.test/ogc?f=pjson");
    const connection = await honua.connect(locator, {
      protocol: "ogc-features",
      authorizationScopeFingerprint: "tenant:alpha/reader",
      clientOptions: { apiKey: secret },
    });

    const first = await connection.inspect();
    const repeated = await connection.inspect();
    const serialized = JSON.stringify(first);

    expect(repeated).toBe(first);
    expect(first.endpoint).toBe("https://geo.example.test/ogc");
    expect("cacheIdentity" in first).toBe(false);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(advertisedSecret);
    expect(serialized).not.toContain("SECRET-CACHE");
    expect(serialized).not.toContain("password");
    expect(first.sources[0]?.descriptor.capabilities.has("query")).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.sources)).toBe(true);
    expect(Object.isFrozen(first.sources[0]?.descriptor)).toBe(true);
    expect(Object.isFrozen(first.sources[0]?.descriptor.locator)).toBe(true);
    expect(() =>
      (first.sources as SourceDiscoveryInspection[]).push(raw.inspections[0] as SourceDiscoveryInspection),
    ).toThrow();
    expect(() => {
      (first.sources[0]?.descriptor.locator as { url: string }).url = "https://mutated.example.test";
    }).toThrow();
    expect(() => (first.sources[0]?.descriptor.capabilities as Set<string>).add("applyEdits")).toThrow();

    raw.inspections[0]!.descriptor.locator.url = "https://caller-mutated.example.test";
    raw.inspections.push(raw.inspections[0] as SourceDiscoveryInspection);
    locator.pathname = "/caller-mutated";
    expect(first.sources).toHaveLength(1);
    expect(first.endpoint).toBe("https://geo.example.test/ogc");
    expect(first.sources[0]?.descriptor.locator.url).not.toContain("caller-mutated");
    expect(calls[0]?.endpoint).toBe("https://geo.example.test/ogc");

    await honua.dispose();
  });

  it("requires explicit source selection under ambiguity and never echoes an invalid selection", async () => {
    const ambiguous = mockConnection(["parcels", "roads"], { defaultSourceId: null });
    const selected = mockConnection(["parcels", "roads"], { defaultSourceId: null });
    const unknown = mockConnection(["parcels", "roads"], { defaultSourceId: null });
    const calls: ConnectOptions[] = [];
    const honua = createHonuaKernel({
      connectDelegate: sequenceDelegate(calls, [ambiguous.connection, selected.connection, unknown.connection]),
    });

    const first = await honua.connect("https://geo.example.test/ogc", { protocol: "ogc-features" });
    expect(() => first.source()).toThrowError(
      expect.objectContaining({
        code: "ambiguous-source",
        detail: { sourceIds: ["parcels", "roads"] },
      }),
    );

    const locator: ConnectLocator = {
      url: "https://geo.example.test/ogc",
      protocol: "ogc-features",
      sourceId: "roads",
    };
    const second = await honua.connect(locator);
    expect(second.source().descriptor.id).toBe("roads");
    expect(selected.source).toHaveBeenCalledWith("roads");

    const invalid = "TOP-SECRET-SELECTION";
    const error = await rejected(
      honua.connect("https://geo.example.test/ogc", { protocol: "ogc-features", sourceId: invalid }),
    );
    expect(error).toMatchObject({
      name: "HonuaDiscoveryError",
      code: "ambiguous-source",
      detail: { sourceIds: ["parcels", "roads"] },
    });
    expect(`${error.message} ${JSON.stringify(error)}`).not.toContain(invalid);
    expect(error.message).toContain("parcels, roads");
    expect(calls.every((call) => !("sourceId" in call))).toBe(true);

    await honua.dispose();
  });

  it("publishes refreshes deterministically with latest-started-wins stale-snapshot protection", async () => {
    const initial = mockConnection(["initial"], { cacheStatus: "miss" });
    const older = mockConnection(["older"], { cacheStatus: "refreshed" });
    const newer = mockConnection(["newer"], { cacheStatus: "refreshed" });
    const olderGate = deferred<HonuaConnection>();
    const newerGate = deferred<HonuaConnection>();
    const calls: ConnectOptions[] = [];
    const honua = createHonuaKernel({
      connectDelegate: sequenceDelegate(calls, [initial.connection, olderGate.promise, newerGate.promise]),
    });
    const retry = { maxRetries: 2, baseDelayMs: 10 };
    const metadata = { ttlMs: 1000 };
    const connection = await honua.connect("https://geo.example.test/ogc", {
      protocol: "ogc-features",
      clientOptions: { retry },
      metadata,
    });
    retry.maxRetries = 99;
    metadata.ttlMs = 99_000;

    const firstRefresh = connection.inspect({ refresh: true });
    const secondRefresh = connection.inspect({ refresh: true });
    newerGate.resolve(newer.connection);
    const newestSnapshot = await secondRefresh;
    expect(newestSnapshot.sources[0]?.descriptor.id).toBe("newer");

    olderGate.resolve(older.connection);
    const staleCompletion = await firstRefresh;
    expect(staleCompletion).toBe(newestSnapshot);
    expect(await connection.inspect()).toBe(newestSnapshot);
    expect(connection.sourceDescriptors[0]?.id).toBe("newer");
    expect(calls.slice(1).every((call) => call.refresh === true)).toBe(true);
    expect(calls[1]?.clientOptions?.retry).toEqual({ maxRetries: 2, baseDelayMs: 10 });
    expect(calls[1]?.metadata).toEqual({ ttlMs: 1000 });
    expect(calls[1]?.signal).not.toBe(calls[2]?.signal);

    await honua.dispose();
  });

  it("owns optional delegated adapter resources through refresh and disposes each exactly once", async () => {
    const initial = mockConnection(["initial"]);
    const refreshed = mockConnection(["refreshed"]);
    const disposeInitial = vi.fn(async () => undefined);
    const disposeRefreshed = vi.fn(async () => undefined);
    Object.assign(initial.connection, { [Symbol.asyncDispose]: disposeInitial });
    Object.assign(refreshed.connection, { [Symbol.asyncDispose]: disposeRefreshed });
    const calls: ConnectOptions[] = [];
    const honua = createHonuaKernel({
      connectDelegate: sequenceDelegate(calls, [initial.connection, refreshed.connection]),
    });
    const connection = await honua.connect("https://geo.example.test/ogc", { protocol: "ogc-features" });

    await connection.inspect({ refresh: true });
    expect(disposeInitial).not.toHaveBeenCalled();
    expect(disposeRefreshed).not.toHaveBeenCalled();

    const disposal = connection.dispose();
    expect(connection.dispose()).toBe(disposal);
    await disposal;
    expect(disposeInitial).toHaveBeenCalledTimes(1);
    expect(disposeRefreshed).toHaveBeenCalledTimes(1);
    await honua.dispose();
  });

  it("does not deadlock when delegated adapter cleanup synchronously acknowledges owner disposal", async () => {
    const raw = mockConnection(["parcels"]);
    const owner: { connection?: Awaited<ReturnType<ReturnType<typeof createHonuaKernel>["connect"]>> } = {};
    let cleanupAcknowledgement: Promise<void> | undefined;
    const disposeAdapter = vi.fn(async () => {
      cleanupAcknowledgement = owner.connection?.dispose();
      await cleanupAcknowledgement;
    });
    Object.assign(raw.connection, { [Symbol.asyncDispose]: disposeAdapter });
    const honua = createHonuaKernel({ connectDelegate: async () => raw.connection });
    const connection = await honua.connect("https://geo.example.test/ogc", { protocol: "ogc-features" });
    owner.connection = connection;

    const disposal = connection.dispose();
    await disposal;

    expect(disposeAdapter).toHaveBeenCalledTimes(1);
    expect(cleanupAcknowledgement).toBeDefined();
    expect(Object.is(cleanupAcknowledgement, disposal)).toBe(false);
    expect(connection.dispose()).toBe(disposal);
    await honua.dispose();
  });

  it("cancels refresh for the caller, preserves the prior snapshot, and aborts pending work on disposal", async () => {
    const initial = mockConnection(["parcels"]);
    const calls: ConnectOptions[] = [];
    let refreshCount = 0;
    const delegate: KernelConnectDelegate = async (options) => {
      calls.push(options);
      if (refreshCount++ === 0) return initial.connection;
      return new Promise<HonuaConnection>((_, reject) => {
        const abort = () => reject(new HonuaAbortError());
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const honua = createHonuaKernel({ connectDelegate: delegate });
    const connection = await honua.connect("https://geo.example.test/ogc", { protocol: "ogc-features" });
    const stable = await connection.inspect();
    const caller = new AbortController();
    const callerRefresh = connection.inspect({ refresh: true, signal: caller.signal });
    caller.abort();

    await expect(callerRefresh).rejects.toBeInstanceOf(HonuaAbortError);
    expect(calls[1]?.signal?.aborted).toBe(true);
    expect(await connection.inspect()).toBe(stable);

    const ownerRefresh = connection.inspect({ refresh: true });
    const firstDisposal = connection.dispose();
    const repeatedDisposal = connection.dispose();
    expect(firstDisposal).toBe(repeatedDisposal);
    await expect(ownerRefresh).rejects.toBeInstanceOf(HonuaAbortError);
    await firstDisposal;
    await expect(connection.inspect()).rejects.toThrow("after disposal has started");
    expect(() => connection.source()).toThrow("after disposal has started");
    expect(() => connection.dataset).toThrow("after disposal has started");
    expect(() => connection.sourceDescriptors).toThrow("after disposal has started");
    await honua.dispose();
  });

  it("rejects connect/disposal races even when a delegate ignores cancellation", async () => {
    const pending = deferred<HonuaConnection>();
    const calls: ConnectOptions[] = [];
    const honua = createHonuaKernel({ connectDelegate: sequenceDelegate(calls, [pending.promise]) });
    const connection = honua.connect("https://geo.example.test/ogc", { protocol: "ogc-features" });

    const disposal = honua.dispose();
    expect(calls[0]?.signal?.aborted).toBe(true);
    pending.resolve(mockConnection(["late"]).connection);

    await expect(connection).rejects.toBeInstanceOf(HonuaAbortError);
    await disposal;
    await expect(honua.connect("https://geo.example.test/other", { protocol: "ogc-features" })).rejects.toThrow(
      "after disposal has started",
    );
  });

  it("reads public locator and option snapshots without invoking Proxy get traps", async () => {
    const raw = mockConnection(["parcels"]);
    const calls: ConnectOptions[] = [];
    const honua = createHonuaKernel({ connectDelegate: sequenceDelegate(calls, [raw.connection]) });
    let propertyReads = 0;
    const trackReads = <T extends object>(target: T): T =>
      new Proxy(target, {
        get() {
          propertyReads += 1;
          throw new Error("a Proxy get trap was invoked");
        },
      });
    const locator = trackReads({ url: "https://geo.example.test/ogc", protocol: "ogc-features" as const });
    const retryStatuses = trackReads([429, 503]);
    const options = trackReads({
      authorizationScopeFingerprint: "tenant:alpha/reader",
      clientOptions: trackReads({
        apiKey: "SECRET",
        retry: trackReads({ maxRetries: 2, retryStatuses }),
      }),
    });

    const connection = await honua.connect(locator, options);

    expect(propertyReads).toBe(0);
    expect(calls[0]?.endpoint).toBe("https://geo.example.test/ogc");
    expect(calls[0]?.clientOptions?.retry?.retryStatuses).toEqual([429, 503]);
    expect(Object.isFrozen(calls[0]?.clientOptions?.retry?.retryStatuses)).toBe(true);
    await connection.dispose();
    await honua.dispose();
  });

  it("rejects connect and inspect accessors without invoking them", async () => {
    const raw = mockConnection(["parcels"]);
    const calls: ConnectOptions[] = [];
    const honua = createHonuaKernel({ connectDelegate: sequenceDelegate(calls, [raw.connection]) });
    let connectGetterCalls = 0;
    const connectOptions = {} as Record<string, unknown>;
    Object.defineProperty(connectOptions, "clientOptions", {
      enumerable: true,
      get() {
        connectGetterCalls += 1;
        return { apiKey: "MUST-NOT-BE-READ" };
      },
    });

    await expect(
      honua.connect("https://geo.example.test/rejected", connectOptions as unknown as { protocol?: "auto" }),
    ).rejects.toThrow("stable enumerable data fields");
    expect(connectGetterCalls).toBe(0);
    expect(calls).toHaveLength(0);

    const connection = await honua.connect("https://geo.example.test/ogc", { protocol: "ogc-features" });
    let inspectGetterCalls = 0;
    const inspectOptions = {} as Record<string, unknown>;
    Object.defineProperty(inspectOptions, "refresh", {
      enumerable: true,
      get() {
        inspectGetterCalls += 1;
        return true;
      },
    });
    await expect(connection.inspect(inspectOptions)).rejects.toThrow("stable enumerable data fields");
    expect(inspectGetterCalls).toBe(0);
    expect(calls).toHaveLength(1);
    await honua.dispose();
  });

  it("keeps an explicitly selected previous source when refresh no longer advertises it", async () => {
    const initial = mockConnection(["parcels", "roads"], { defaultSourceId: null });
    const changed = mockConnection(["parcels"]);
    const calls: ConnectOptions[] = [];
    const honua = createHonuaKernel({
      connectDelegate: sequenceDelegate(calls, [initial.connection, changed.connection]),
    });
    const connection = await honua.connect(
      { url: "https://geo.example.test/ogc", protocol: "ogc-features", sourceId: "roads" },
      {},
    );
    const stable = await connection.inspect();

    const error = await rejected(connection.inspect({ refresh: true }));
    expect(error).toMatchObject({ code: "ambiguous-source", detail: { sourceIds: ["parcels"] } });
    expect(await connection.inspect()).toBe(stable);
    expect(connection.source().descriptor.id).toBe("roads");

    await honua.dispose();
  });

  it("redacts credential-bearing delegated failures and rejects unsafe locators before delegation", async () => {
    const secret = "DELEGATE-AUTH-SECRET";
    const calls: ConnectOptions[] = [];
    let invocation = 0;
    const delegate = vi.fn<KernelConnectDelegate>(async (options) => {
      calls.push(options);
      if (invocation++ > 0) {
        throw new HonuaDiscoveryError("protocol-mismatch", "Delegated discovery failed.", { debug: secret });
      }
      throw new Error(
        `transport exposed ${secret} at https://user:${secret}@geo.example.test/ogc?access_token=${secret}`,
      );
    });
    const honua = createHonuaKernel({ connectDelegate: delegate });
    const delegated = await rejected(
      honua.connect("https://geo.example.test/ogc", {
        protocol: "ogc-features",
        authorizationScopeFingerprint: "tenant:alpha/reader",
        clientOptions: { apiKey: secret },
      }),
    );
    expect(`${delegated.message} ${JSON.stringify(delegated)}`).not.toContain(secret);
    expect(delegated.message).toContain("[redacted]");

    const detailFailure = await rejected(
      honua.connect("https://geo.example.test/ogc", {
        protocol: "ogc-features",
        authorizationScopeFingerprint: "tenant:alpha/reader",
        clientOptions: { apiKey: secret },
      }),
    );
    expect(detailFailure).toMatchObject({ code: "protocol-mismatch", detail: { debug: "[redacted]" } });
    expect(`${detailFailure.message} ${JSON.stringify(detailFailure)}`).not.toContain(secret);

    const locatorSecret = "LOCATOR-SECRET";
    const locatorFailure = await rejected(
      honua.connect(`https://geo.example.test/ogc?access_token=${locatorSecret}`, {
        protocol: "ogc-features",
      }),
    );
    expect(locatorFailure).toMatchObject({ code: "invalid-endpoint" });
    expect(`${locatorFailure.message} ${JSON.stringify(locatorFailure)}`).not.toContain(locatorSecret);
    expect(delegate).toHaveBeenCalledTimes(2);

    await honua.dispose();
  });

  it("sanitizes accessor-bearing delegated errors without invoking their accessors", async () => {
    let getterCalls = 0;
    const delegatedError = new Error("Delegated discovery failed safely.");
    Object.defineProperty(delegatedError, "debug", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "access_token=MUST-NOT-BE-READ";
      },
    });
    const honua = createHonuaKernel({
      connectDelegate: async () => {
        throw delegatedError;
      },
    });

    const failure = await rejected(honua.connect("https://geo.example.test/ogc", { protocol: "ogc-features" }));

    expect(Object.is(failure, delegatedError)).toBe(false);
    expect(failure.message).toBe("Delegated discovery failed safely.");
    expect(getterCalls).toBe(0);
    expect("debug" in failure).toBe(false);
    await honua.dispose();
  });

  it("does not forward accessor-bearing non-Error rejection payloads", async () => {
    let getterCalls = 0;
    const rejection: Record<string, unknown> = {};
    Object.defineProperty(rejection, "message", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "access_token=MUST-NOT-BE-READ";
      },
    });
    const honua = createHonuaKernel({
      connectDelegate: async () => {
        throw rejection;
      },
    });

    const failure = await rejected(honua.connect("https://geo.example.test/ogc", { protocol: "ogc-features" }));

    expect(failure.message).toBe("Honua operation failed.");
    expect(getterCalls).toBe(0);
    await honua.dispose();
  });
});
