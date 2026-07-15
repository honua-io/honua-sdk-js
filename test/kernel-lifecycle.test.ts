import { describe, expect, it, vi } from "vitest";
import type { ConnectDiscoverySnapshot } from "../src/connect.js";
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
    version: 4,
    identityKey: cacheIdentity.key,
    endpoint: cacheIdentity.endpoint,
    protocol: "ogc-features",
    retrievedAt: "2026-07-15T00:00:00.000Z",
    evidence: Object.freeze([]),
    sources: Object.freeze([]),
  });
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
});
