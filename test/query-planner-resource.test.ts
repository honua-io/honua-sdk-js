import { describe, expect, it, vi } from "vitest";

import type { Source, SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import { isHonuaSdkError, serializeHonuaError } from "../src/core/error-envelope.js";
import { HonuaAbortError } from "../src/core/errors.js";
import {
  HonuaQueryPlanExecutionError,
  type QueryExecutionPlanV1,
  createGeoParquetResourceRegistry,
  executeQueryPlan,
  explainQuery,
  hashGeoParquetResourceHandle,
  hashQueryPlan,
  parseGeoParquetResourceHandle,
  resolveGeoParquetResource,
} from "../src/query-planner/index.js";

const SIGNED_SOURCES = [
  "https://AKIAIOSFODNN7EXAMPLE:aws-secret@example.test/data.parquet?X-Amz-Signature=aws-signature-secret",
  "https://account.blob.core.windows.net/data/a.parquet?sv=2026&sig=azure-sig-secret",
  "https://storage.googleapis.com/bucket/a.parquet?X-Goog-Credential=gcs-credential-secret",
  "https://cdn.example.test/a.parquet?Policy=cloudfront-policy-secret&Signature=cloudfront-signature-secret",
] as const;

const SENSITIVE_MARKERS = [
  "AKIAIOSFODNN7EXAMPLE",
  "aws-secret",
  "aws-signature-secret",
  "azure-sig-secret",
  "gcs-credential-secret",
  "cloudfront-policy-secret",
  "cloudfront-signature-secret",
] as const;

const CONTEXT = "tenant:alpha/role:analyst";

describe("GeoParquet resource handles", () => {
  it("keeps signed locators and expiry outside stable handle identity", async () => {
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.test-resolver" });
    const handle = registry.register({
      id: "parcels:2",
      authorizationContextId: CONTEXT,
      resourceVersion: "etag:2026-07-14",
      sources: SIGNED_SOURCES,
      expiresAt: Date.now() + 60_000,
    });

    const serialized = JSON.stringify(handle);
    const fingerprint = hashGeoParquetResourceHandle(handle);
    expect(handle).toEqual({
      kind: "honua.query-resource",
      version: "1.0",
      protocol: "geoparquet",
      resource: { kind: "resolver", resolver: "io.honua.test-resolver", id: "parcels:2" },
      authorizationContextId: CONTEXT,
      resourceVersion: "etag:2026-07-14",
    });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(Object.isFrozen(handle.resource)).toBe(true);
    const reparsed = parseGeoParquetResourceHandle(JSON.parse(serialized));
    expect(reparsed).toEqual(handle);
    expect(Object.isFrozen(reparsed.resource)).toBe(true);
    assertTextRedacted(serialized, SENSITIVE_MARKERS);
    assertTextRedacted(fingerprint, SENSITIVE_MARKERS);

    const resolved = await resolveGeoParquetResource(handle, registry.resolver, {
      authorizationContextId: CONTEXT,
    });
    expect(resolved.sources).toEqual(SIGNED_SOURCES);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.sources)).toBe(true);
  });

  it("rotates credentials atomically without changing safe identity", async () => {
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.rotation" });
    const originalSources = ["https://data.example.test/parcels.parquet?sig=first-secret"];
    const first = registry.register({
      id: "parcels:stable",
      authorizationContextId: CONTEXT,
      resourceVersion: "snapshot:7",
      sources: originalSources,
    });
    originalSources[0] = "https://attacker.invalid/mutated.parquet?sig=mutation-secret";
    expect(
      (await resolveGeoParquetResource(first, registry.resolver, { authorizationContextId: CONTEXT })).sources,
    ).toEqual(["https://data.example.test/parcels.parquet?sig=first-secret"]);

    const second = registry.register({
      id: "parcels:stable",
      authorizationContextId: CONTEXT,
      resourceVersion: "snapshot:7",
      sources: ["https://data.example.test/parcels.parquet?sig=rotated-secret"],
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(hashGeoParquetResourceHandle(second)).toBe(hashGeoParquetResourceHandle(first));
    expect(
      (await resolveGeoParquetResource(first, registry.resolver, { authorizationContextId: CONTEXT })).sources,
    ).toEqual(["https://data.example.test/parcels.parquet?sig=rotated-secret"]);
    assertTextRedacted(JSON.stringify(second), ["first-secret", "mutation-secret", "rotated-secret"]);
  });

  it("isolates equal logical ids by authorization context without resolver or clock oracles", async () => {
    const now = vi.fn(() => 100);
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.scoped", now });
    const alpha = registry.register({
      id: "shared:parcels",
      authorizationContextId: "tenant:alpha",
      sources: ["https://alpha.example.test/a.parquet?sig=alpha-secret"],
      expiresAt: 99,
    });
    const beta = registry.register({
      id: "shared:parcels",
      authorizationContextId: "tenant:beta",
      sources: ["https://beta.example.test/b.parquet?sig=beta-secret"],
    });
    const resolver = vi.fn(registry.resolver);

    const mismatch = await rejectionOf(
      resolveGeoParquetResource(alpha, resolver, { authorizationContextId: "tenant:beta" }),
    );
    expect(mismatch).toMatchObject({ code: "resource-unavailable" });
    expect(resolver).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    assertErrorRedacted(mismatch, ["alpha-secret", "beta-secret"]);

    expect(
      (await resolveGeoParquetResource(beta, resolver, { authorizationContextId: "tenant:beta" })).sources,
    ).toEqual(["https://beta.example.test/b.parquet?sig=beta-secret"]);
  });

  it("expires exactly at the private deadline and fails closed across lifecycle transitions", async () => {
    let now = 99;
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.lifecycle", now: () => now });
    const handle = registry.register({
      id: "parcels:expiry",
      authorizationContextId: CONTEXT,
      sources: ["https://data.example.test/a.parquet?sig=expiry-secret"],
      expiresAt: 100,
    });
    expect(
      (await resolveGeoParquetResource(handle, registry.resolver, { authorizationContextId: CONTEXT })).sources,
    ).toHaveLength(1);

    now = 100;
    const expired = await rejectionOf(
      resolveGeoParquetResource(handle, registry.resolver, { authorizationContextId: CONTEXT }),
    );
    expect(expired).toMatchObject({ code: "resource-expired" });
    assertErrorRedacted(expired, ["expiry-secret"]);
    await expect(
      resolveGeoParquetResource(handle, registry.resolver, { authorizationContextId: CONTEXT }),
    ).rejects.toMatchObject({ code: "resource-expired" });

    registry.revoke(handle);
    expect(registry.revoke(handle)).toBeUndefined();
    await expect(
      resolveGeoParquetResource(handle, registry.resolver, { authorizationContextId: CONTEXT }),
    ).rejects.toMatchObject({ code: "resource-unavailable" });

    registry.dispose();
    expect(registry.dispose()).toBeUndefined();
    await expect(
      resolveGeoParquetResource(handle, registry.resolver, { authorizationContextId: CONTEXT }),
    ).rejects.toMatchObject({ code: "resource-unavailable" });
    expect(() =>
      registry.register({ id: "closed", authorizationContextId: CONTEXT, sources: ["fixtures/closed.parquet"] }),
    ).toThrowError(expect.objectContaining({ code: "resource-unavailable" }));
  });

  it("rejects lifecycle reentrancy instead of returning a captured private locator", async () => {
    let disposeDuringClock = false;
    const registry = createGeoParquetResourceRegistry({
      resolver: "io.honua.reentrant-clock",
      now: () => {
        if (disposeDuringClock) registry.dispose();
        return 50;
      },
    });
    const handle = registry.register({
      id: "parcels:reentrant",
      authorizationContextId: CONTEXT,
      sources: ["https://data.example.test/reentrant.parquet?sig=reentrant-secret"],
      expiresAt: 100,
    });
    disposeDuringClock = true;

    const error = await rejectionOf(
      resolveGeoParquetResource(handle, registry.resolver, { authorizationContextId: CONTEXT }),
    );
    expect(error).toMatchObject({ code: "resource-unavailable" });
    assertErrorRedacted(error, ["reentrant-secret"]);
  });

  it("supports pre-abort and mid-flight abort while handling a late secret rejection", async () => {
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.abort" });
    const handle = registry.register({ id: "parcels:abort", authorizationContextId: CONTEXT, sources: ["a.parquet"] });
    const preAborted = new AbortController();
    preAborted.abort();
    const neverCalled = vi.fn(registry.resolver);
    await expect(
      resolveGeoParquetResource(handle, neverCalled, {
        authorizationContextId: CONTEXT,
        signal: preAborted.signal,
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(neverCalled).not.toHaveBeenCalled();

    let rejectPending: ((reason: unknown) => void) | undefined;
    const pendingResolver = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectPending = reject;
        }),
    );
    const controller = new AbortController();
    const resolving = resolveGeoParquetResource(handle, pendingResolver, {
      authorizationContextId: CONTEXT,
      signal: controller.signal,
    });
    controller.abort();
    const aborted = await rejectionOf(resolving);
    expect(aborted).toBeInstanceOf(HonuaAbortError);
    assertErrorRedacted(aborted, ["late-rejection-secret"]);
    rejectPending?.(new Error("late-rejection-secret"));
    await Promise.resolve();
  });

  it("reconstructs resolver failures without retaining messages, causes, or contexts", async () => {
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.redaction" });
    const handle = registry.register({
      id: "parcels:redaction",
      authorizationContextId: CONTEXT,
      sources: ["a.parquet"],
    });
    const secret = "https://user:resolver-secret@example.test/a.parquet?sig=resolver-query-secret";

    const generic = await rejectionOf(
      resolveGeoParquetResource(
        handle,
        () => {
          throw new Error(secret);
        },
        { authorizationContextId: CONTEXT },
      ),
    );
    expect(generic).toMatchObject({ code: "resource-resolution-failed" });
    assertErrorRedacted(generic, ["resolver-secret", "resolver-query-secret"]);

    const forged = await rejectionOf(
      resolveGeoParquetResource(
        handle,
        () => {
          throw new HonuaQueryPlanExecutionError("resource-expired", secret, {
            cause: new Error("resolver-cause-secret"),
            context: { token: "resolver-context-secret" },
          });
        },
        { authorizationContextId: CONTEXT },
      ),
    );
    expect(forged).toMatchObject({
      code: "resource-expired",
      message: "GeoParquet resource authorization has expired",
    });
    assertErrorRedacted(forged, [
      "resolver-secret",
      "resolver-query-secret",
      "resolver-cause-secret",
      "resolver-context-secret",
    ]);

    const forgedAbort = await rejectionOf(
      resolveGeoParquetResource(
        handle,
        () => {
          throw new HonuaAbortError("resolver-abort-secret", { cause: new Error("resolver-abort-cause-secret") });
        },
        { authorizationContextId: CONTEXT },
      ),
    );
    expect(forgedAbort).toMatchObject({ code: "resource-resolution-failed" });
    assertErrorRedacted(forgedAbort, ["resolver-abort-secret", "resolver-abort-cause-secret"]);
  });

  it("rejects hostile or future handle values without invoking accessors or echoing input", () => {
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.validation" });
    const base = registry.register({ id: "parcels:valid", authorizationContextId: CONTEXT, sources: ["a.parquet"] });
    const jwtSecret = "eyJhbGciOiJIUzI1NiJ9.eyJ0b2tlbiI6InNlY3JldCJ9.signature-secret";
    const hostileValues: unknown[] = [
      { ...base, version: "2.0" },
      { ...base, resource: { ...base.resource, resolver: "IO.HONUA.UPPERCASE" } },
      { ...base, resource: { ...base.resource, id: "https://user:id-secret@example.test/a?token=id-query-secret" } },
      { ...base, resource: { ...base.resource, id: "../../traversal-secret" } },
      { ...base, resource: { ...base.resource, id: jwtSecret } },
      { ...base, resourceVersion: undefined },
      { ...base, resourceVersion: "version=credential-secret" },
      { ...base, authorizationContextId: "tenant:alpha?token=context-secret" },
      { ...base, authorizationContextId: "tenant:\u0000control-secret" },
      { ...base, authorizationContextId: "tenant:hawaiʻi" },
      { ...base, authorizationContextId: `tenant:${"x".repeat(257)}` },
      { ...base, extra: "extra-secret" },
      Object.assign(Object.create({ inherited: "inherited-secret" }), base),
      new Proxy(base, {
        ownKeys() {
          throw new Error("proxy-trap-secret");
        },
      }),
    ];
    const symbolValue = { ...base, [Symbol("symbol-secret")]: "symbol-value-secret" };
    hostileValues.push(symbolValue);
    const hiddenValue = { ...base };
    Object.defineProperty(hiddenValue, "hidden", { value: "hidden-secret" });
    hostileValues.push(hiddenValue);
    const accessorResource = { kind: "resolver", resolver: "io.honua.validation" } as Record<string, unknown>;
    Object.defineProperty(accessorResource, "id", {
      enumerable: true,
      get() {
        throw new Error("accessor-id-secret");
      },
    });
    hostileValues.push({ ...base, resource: accessorResource });

    for (const hostile of hostileValues) {
      let error: unknown;
      try {
        parseGeoParquetResourceHandle(hostile);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: "invalid-resource-handle",
        message: "GeoParquet resource handle is invalid",
      });
      assertErrorRedacted(error, [
        "id-secret",
        "id-query-secret",
        "traversal-secret",
        "signature-secret",
        "credential-secret",
        "context-secret",
        "control-secret",
        "extra-secret",
        "inherited-secret",
        "proxy-trap-secret",
        "symbol-secret",
        "symbol-value-secret",
        "hidden-secret",
        "accessor-id-secret",
      ]);
    }
  });

  it("bounds and copies hostile resolver output", async () => {
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.output" });
    const handle = registry.register({ id: "parcels:output", authorizationContextId: CONTEXT, sources: ["a.parquet"] });
    const invalidSources: unknown[] = [
      [],
      new Array(1),
      Array.from({ length: 65 }, () => "a.parquet"),
      ["x".repeat(16_385)],
      Array.from({ length: 9 }, () => "x".repeat(16_000)),
      ["a.parquet\u0000output-secret"],
      [42],
    ];
    const accessorArray: string[] = [];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("output-accessor-secret");
      },
    });
    Object.defineProperty(accessorArray, "length", { value: 1 });
    invalidSources.push(accessorArray);

    for (const sources of invalidSources) {
      const error = await rejectionOf(
        resolveGeoParquetResource(handle, () => ({ sources }) as never, { authorizationContextId: CONTEXT }),
      );
      expect(error).toMatchObject({ code: "resource-resolution-failed" });
      assertErrorRedacted(error, ["output-secret", "output-accessor-secret"]);
    }

    const mutable = ["https://data.example.test/a.parquet?sig=copy-secret"];
    const resolved = await resolveGeoParquetResource(handle, () => ({ sources: mutable }), {
      authorizationContextId: CONTEXT,
    });
    mutable[0] = "https://attacker.invalid/changed.parquet";
    expect(resolved.sources).toEqual(["https://data.example.test/a.parquet?sig=copy-secret"]);
    expect(Object.isFrozen(resolved.sources)).toBe(true);
  });

  it("enforces capacity while allowing atomic replacement and idempotent removal", async () => {
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.capacity", maxEntries: 1 });
    const handle = registry.register({
      id: "one",
      authorizationContextId: CONTEXT,
      sources: ["https://data.example.test/one.parquet?sig=original-secret"],
    });
    expect(() =>
      registry.register({ id: "one", authorizationContextId: CONTEXT, sources: ["bad\u0000replacement-secret"] }),
    ).toThrowError("GeoParquet resource registration is invalid");
    expect(
      (await resolveGeoParquetResource(handle, registry.resolver, { authorizationContextId: CONTEXT })).sources,
    ).toEqual(["https://data.example.test/one.parquet?sig=original-secret"]);

    registry.register({ id: "one", authorizationContextId: CONTEXT, sources: ["one-rotated.parquet"] });
    expect(() =>
      registry.register({ id: "two", authorizationContextId: CONTEXT, sources: ["two.parquet"] }),
    ).toThrowError(expect.objectContaining({ code: "resource-unavailable" }));
    registry.revoke(handle);
    expect(() =>
      registry.register({ id: "two", authorizationContextId: CONTEXT, sources: ["two.parquet"] }),
    ).not.toThrow();
    expect(() => createGeoParquetResourceRegistry({ resolver: "io.honua.too-large", maxEntries: 4_097 })).toThrowError(
      "GeoParquet resource registry options are invalid",
    );

    const expiring = createGeoParquetResourceRegistry({
      resolver: "io.honua.expired-capacity",
      maxEntries: 1,
      now: () => 2,
    });
    const expiredHandle = expiring.register({
      id: "expired",
      authorizationContextId: CONTEXT,
      sources: ["expired.parquet"],
      expiresAt: 1,
    });
    await expect(
      resolveGeoParquetResource(expiredHandle, expiring.resolver, { authorizationContextId: CONTEXT }),
    ).rejects.toMatchObject({ code: "resource-expired" });
    expect(() =>
      expiring.register({ id: "replacement", authorizationContextId: CONTEXT, sources: ["replacement.parquet"] }),
    ).not.toThrow();
  });

  it("preserves credential-free v1 GeoParquet plan JSON and execution compatibility", async () => {
    const descriptor = geoparquetDescriptor();
    const plan = explainQuery({ descriptor, query: { where: "population > 10", pagination: { limit: 2 } } });
    const parsed = JSON.parse(JSON.stringify(plan)) as QueryExecutionPlanV1;
    expect(parsed.version).toBe("1.0");
    expect(parsed.ir.version).toBe("1.0");
    expect(hashQueryPlan(parsed)).toBe(plan.fingerprint);
    const query = vi.fn().mockResolvedValue({ features: [{ attributes: { id: 1 } }], exceededTransferLimit: false });
    const execution = await executeQueryPlan(parsed, fakeSource(descriptor, { query }));
    expect(query).toHaveBeenCalledOnce();
    expect(execution.result.features).toEqual([{ attributes: { id: 1 } }]);
  });
});

function geoparquetDescriptor(): SourceDescriptor {
  return {
    id: "parcels",
    protocol: "geoparquet",
    locator: {
      url: "https://data.example.test/parcels.parquet",
      geoparquet: { geometryColumn: "geometry", geometryEncoding: "wkb" },
    },
    capabilities: capabilities(["query", "queryAggregate", "stream"]),
    schema: { primaryKey: "id" },
  };
}

function fakeSource(
  descriptor: SourceDescriptor,
  overrides: Partial<Pick<Source, "query" | "queryAll" | "queryAggregate">> = {},
): Source {
  const unsupported = async () => {
    throw new Error("not used");
  };
  return {
    descriptor,
    capabilities: descriptor.capabilities,
    query: overrides.query ?? unsupported,
    queryAll: overrides.queryAll ?? unsupported,
    queryAggregate: overrides.queryAggregate ?? unsupported,
    queryExtent: unsupported,
    async *stream() {},
    queryObjectIds: unsupported,
    applyEdits: unsupported,
    queryRelated: unsupported,
    attachments: { query: unsupported, list: unsupported, add: unsupported, update: unsupported, delete: unsupported },
    protocol: () => undefined,
    adapter: () => undefined,
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

function assertTextRedacted(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) expect(text).not.toContain(secret);
}

function assertErrorRedacted(error: unknown, secrets: readonly string[]): void {
  const record = error as {
    readonly message?: unknown;
    readonly stack?: unknown;
    readonly cause?: unknown;
    readonly context?: unknown;
  };
  const surfaces = [
    String(error),
    typeof record.message === "string" ? record.message : "",
    typeof record.stack === "string" ? record.stack : "",
    JSON.stringify(error),
    JSON.stringify(record.context),
    JSON.stringify(record.cause),
  ];
  if (isHonuaSdkError(error)) surfaces.push(JSON.stringify(serializeHonuaError(error)));
  for (const surface of surfaces) assertTextRedacted(surface ?? "", secrets);
  expect(record.cause).toBeUndefined();
}
