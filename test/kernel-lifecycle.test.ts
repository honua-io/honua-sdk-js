import { describe, expect, it, vi } from "vitest";
import { type ConnectDiscoverySnapshot, HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION } from "../src/connect.js";
import type { DiscoveryCacheIdentity } from "../src/contract/discovery.js";
import type { Capability } from "../src/contract/types.js";
import { HonuaAbortError } from "../src/core/errors.js";
import { createKernelLifecycle } from "../src/kernel/lifecycle.js";

function identity(key: string): DiscoveryCacheIdentity {
  return Object.freeze({
    version: 1,
    endpoint: `https://example.test/${key}`,
    protocol: "ogc-features",
    authorizationScopeDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    key,
  });
}

function snapshot(cacheIdentity: DiscoveryCacheIdentity): ConnectDiscoverySnapshot {
  return Object.freeze({
    version: HONUA_CONNECT_DISCOVERY_SNAPSHOT_VERSION,
    identityKey: cacheIdentity.key,
    endpoint: cacheIdentity.endpoint,
    protocol: "ogc-features",
    retrievedAt: "2026-07-15T00:00:00.000Z",
    evidence: Object.freeze([]),
    sources: Object.freeze([]),
  });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, timeoutMs = 250): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

describe("kernel lifecycle substrate", () => {
  it("isolates policy, discovery cache, cancellation, and resources between kernels", async () => {
    const allow: Capability[] = ["query"];
    const deny: Capability[] = ["applyEdits"];
    const first = createKernelLifecycle({ capabilityPolicy: { allow, deny } });
    const second = createKernelLifecycle({ capabilityPolicy: { allow: ["tiles"] } });
    allow[0] = "tiles";
    deny[0] = "query";
    const firstKey = identity("first");
    const firstSnapshot = snapshot(firstKey);
    const firstResource = vi.fn();
    const secondResource = vi.fn();
    let firstAbortCount = 0;
    let secondAbortCount = 0;

    first.signal.addEventListener("abort", () => firstAbortCount++);
    second.signal.addEventListener("abort", () => secondAbortCount++);
    first.own(firstResource);
    second.own(secondResource);
    first.discoveryCache.set(firstKey, firstSnapshot, {});

    expect(first.policy.capabilities).toEqual({ allow: ["query"], deny: ["applyEdits"] });
    expect(second.policy.capabilities).toEqual({ allow: ["tiles"] });
    expect(Object.isFrozen(first.policy)).toBe(true);
    expect(Object.isFrozen(first.policy.capabilities)).toBe(true);
    expect(Object.isFrozen(first.policy.capabilities.allow)).toBe(true);
    expect(second.discoveryCache.get(firstKey, {})).toBeUndefined();

    await first.dispose();

    expect(firstAbortCount).toBe(1);
    expect(secondAbortCount).toBe(0);
    expect(firstResource).toHaveBeenCalledOnce();
    expect(secondResource).not.toHaveBeenCalled();
    expect(() => first.discoveryCache.get(firstKey, {})).toThrow("after disposal");
    expect(second.state).toBe("active");

    await second.dispose();
  });

  it("aborts before draining sync and async resources once in reverse ownership order", async () => {
    const lifecycle = createKernelLifecycle();
    const calls: string[] = [];
    let abortCount = 0;
    lifecycle.signal.addEventListener("abort", () => abortCount++);
    const sync = {
      dispose() {
        expect(lifecycle.signal.aborted).toBe(true);
        calls.push("sync");
      },
    };
    const symbolAsync = {
      async [Symbol.asyncDispose]() {
        expect(lifecycle.signal.aborted).toBe(true);
        await Promise.resolve();
        calls.push("async");
      },
    };
    lifecycle.own(sync);
    lifecycle.own(symbolAsync);
    lifecycle.own(sync);

    const first = lifecycle.dispose();
    const second = lifecycle.dispose();

    expect(first).toBe(second);
    expect(lifecycle.state).toBe("disposing");
    await first;
    await lifecycle[Symbol.asyncDispose]();

    expect(abortCount).toBe(1);
    expect(calls).toEqual(["async", "sync"]);
    expect(lifecycle.state).toBe("disposed");
    expect(() => lifecycle.own(() => undefined)).toThrow("after disposal has started");
  });

  it("publishes one completion before a synchronous abort listener can reenter disposal", async () => {
    const lifecycle = createKernelLifecycle();
    const cleanupStarted = deferred();
    const cleanupGate = deferred();
    const cleanup = vi.fn(async () => {
      cleanupStarted.resolve();
      await cleanupGate.promise;
    });
    lifecycle.own(cleanup);
    let reentrantCompletion: Promise<void> | undefined;
    lifecycle.signal.addEventListener(
      "abort",
      () => {
        reentrantCompletion = lifecycle.dispose();
      },
      { once: true },
    );

    const completion = lifecycle.dispose();
    let settled = false;
    void completion.then(() => {
      settled = true;
    });

    expect(reentrantCompletion).toBe(completion);
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.state).toBe("disposing");
    await cleanupStarted.promise;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    cleanupGate.resolve();
    await completion;
    expect(settled).toBe(true);
    expect(lifecycle.dispose()).toBe(completion);
  });

  it("uses a settled cleanup-reentry view and drains every resource once in reverse order", async () => {
    const lifecycle = createKernelLifecycle();
    const pendingCleanupStarted = deferred();
    const pendingCleanupGate = deferred();
    const calls: string[] = [];
    const oldestCleanup = vi.fn(() => {
      calls.push("oldest");
    });
    const pendingCleanup = vi.fn(async () => {
      calls.push("pending:start");
      pendingCleanupStarted.resolve();
      await pendingCleanupGate.promise;
      calls.push("pending:end");
    });
    let reentrantCompletion: Promise<void> | undefined;
    const reentrantCleanup = vi.fn(() => {
      calls.push("reentrant");
      reentrantCompletion = lifecycle.dispose();
      return reentrantCompletion;
    });
    lifecycle.own(oldestCleanup);
    lifecycle.own(pendingCleanup);
    lifecycle.own(reentrantCleanup);

    const completion = lifecycle.dispose();
    let settled = false;
    void completion.then(() => {
      settled = true;
    });
    await pendingCleanupStarted.promise;

    expect(reentrantCompletion).not.toBe(completion);
    await expect(reentrantCompletion).resolves.toBeUndefined();
    expect(calls).toEqual(["reentrant", "pending:start"]);
    expect(reentrantCleanup).toHaveBeenCalledOnce();
    expect(pendingCleanup).toHaveBeenCalledOnce();
    expect(oldestCleanup).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    pendingCleanupGate.resolve();
    await completion;

    expect(calls).toEqual(["reentrant", "pending:start", "pending:end", "oldest"]);
    expect(oldestCleanup).toHaveBeenCalledOnce();
    expect(settled).toBe(true);
    expect(lifecycle.dispose()).toBe(completion);
  });

  it("does not deadlock when an async cleanup adopts its scoped disposal acknowledgement", async () => {
    const lifecycle = createKernelLifecycle();
    let reentrantCompletion: Promise<void> | undefined;
    const cleanup = vi.fn(async () => {
      reentrantCompletion = lifecycle.dispose();
      return reentrantCompletion;
    });
    lifecycle.own(cleanup);

    const completion = lifecycle.dispose();
    await within(completion);

    expect(reentrantCompletion).not.toBe(completion);
    await expect(reentrantCompletion).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(lifecycle.state).toBe("disposed");
    expect(lifecycle.dispose()).toBe(completion);
  });

  it("awaits independent async cleanup work after synchronous disposal reentry", async () => {
    const lifecycle = createKernelLifecycle();
    const cleanupStarted = deferred();
    const independentGate = deferred();
    let released = false;
    let reentrantCompletion: Promise<void> | undefined;
    lifecycle.own(async () => {
      reentrantCompletion = lifecycle.dispose();
      cleanupStarted.resolve();
      await independentGate.promise;
      released = true;
    });

    const completion = lifecycle.dispose();
    const repeated = lifecycle.dispose();
    await cleanupStarted.promise;
    let settled = false;
    void completion.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(repeated).toBe(completion);
    expect(reentrantCompletion).not.toBe(completion);
    await expect(reentrantCompletion).resolves.toBeUndefined();
    expect(released).toBe(false);
    expect(settled).toBe(false);

    independentGate.resolve();
    await within(completion);
    expect(released).toBe(true);
    expect(settled).toBe(true);
  });

  it("continues after cleanup failures and preserves one aggregate completion", async () => {
    const lifecycle = createKernelLifecycle();
    const survivor = vi.fn();
    const syncFailure = new Error("sync cleanup failed");
    const asyncFailure = new Error("async cleanup failed");
    lifecycle.own(survivor);
    lifecycle.own(() => {
      throw syncFailure;
    });
    lifecycle.own(async () => {
      throw asyncFailure;
    });

    const completion = lifecycle.dispose();
    const repeated = lifecycle.dispose();
    expect(completion).toBe(repeated);
    await expect(completion).rejects.toMatchObject({
      errors: [asyncFailure, syncFailure],
    });

    expect(survivor).toHaveBeenCalledOnce();
    expect(lifecycle.state).toBe("disposed");
    expect(lifecycle.dispose()).toBe(completion);
    await expect(lifecycle.dispose()).rejects.toBeInstanceOf(AggregateError);
  });

  it("supports ownership transfer and bounded least-recently-used discovery caching", async () => {
    const lifecycle = createKernelLifecycle({ discoveryCacheMaxEntries: 2 });
    const released = vi.fn();
    expect(lifecycle.own(released)).toBe(released);
    expect(lifecycle.release(released)).toBe(true);
    expect(lifecycle.release(released)).toBe(false);

    const first = identity("first");
    const second = identity("second");
    const third = identity("third");
    lifecycle.discoveryCache.set(first, snapshot(first), {});
    lifecycle.discoveryCache.set(second, snapshot(second), {});
    expect(lifecycle.discoveryCache.get(first, {})).toEqual(snapshot(first));
    lifecycle.discoveryCache.set(third, snapshot(third), {});

    expect(lifecycle.discoveryCache.get(second, {})).toBeUndefined();
    expect(lifecycle.discoveryCache.get(first, {})).toEqual(snapshot(first));
    expect(lifecycle.discoveryCache.get(third, {})).toEqual(snapshot(third));

    await lifecycle.dispose();
    expect(released).not.toHaveBeenCalled();
  });

  it("honors aborted cache operations and rejects invalid cache bounds", async () => {
    expect(() => createKernelLifecycle({ discoveryCacheMaxEntries: 0 })).toThrow(RangeError);
    expect(() => createKernelLifecycle({ discoveryCacheMaxEntries: 1.5 })).toThrow(RangeError);

    const lifecycle = createKernelLifecycle();
    const controller = new AbortController();
    controller.abort();
    const cacheIdentity = identity("aborted");

    expect(() => lifecycle.discoveryCache.get(cacheIdentity, { signal: controller.signal })).toThrow(HonuaAbortError);
    expect(() =>
      lifecycle.discoveryCache.set(cacheIdentity, snapshot(cacheIdentity), { signal: controller.signal }),
    ).toThrow(HonuaAbortError);

    await lifecycle.dispose();
  });

  it("rejects empty-context cache access as soon as owner disposal begins", async () => {
    const lifecycle = createKernelLifecycle();
    const cacheIdentity = identity("owner-disposal");
    const cacheSnapshot = snapshot(cacheIdentity);
    const pendingCleanupStarted = deferred();
    const pendingCleanupGate = deferred();
    lifecycle.discoveryCache.set(cacheIdentity, cacheSnapshot, {});
    lifecycle.own(async () => {
      pendingCleanupStarted.resolve();
      await pendingCleanupGate.promise;
    });

    const completion = lifecycle.dispose();
    expect(() => lifecycle.discoveryCache.get(cacheIdentity, {})).toThrow(HonuaAbortError);
    expect(() => lifecycle.discoveryCache.set(cacheIdentity, cacheSnapshot, {})).toThrow(HonuaAbortError);

    await pendingCleanupStarted.promise;
    expect(lifecycle.state).toBe("disposing");
    expect(() => lifecycle.discoveryCache.get(cacheIdentity, {})).toThrow(HonuaAbortError);
    expect(() => lifecycle.discoveryCache.set(cacheIdentity, cacheSnapshot, {})).toThrow(HonuaAbortError);

    pendingCleanupGate.resolve();
    await completion;
    expect(() => lifecycle.discoveryCache.get(cacheIdentity, {})).toThrow("after disposal");
  });
});
