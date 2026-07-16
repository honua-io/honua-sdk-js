import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { Capability, Query, Result, Source, SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import { isHonuaSdkError, serializeHonuaError } from "../src/core/error-envelope.js";
import { HonuaAbortError } from "../src/core/errors.js";
import { GeoparquetRuntime, geoparquetSource } from "../src/geoparquet/index.js";
import {
  type GeoParquetResourceHandleV1,
  type QueryExecutionPlanV2,
  canonicalStringify,
  createGeoParquetResourceHandle,
  createGeoParquetResourceRegistry,
  executeQueryPlan,
  explainQuery,
  hashQueryPlan,
  migrateGeoParquetQueryPlanV1,
  parseQueryPlan,
  queryPlanCacheKey,
  serializeQueryPlan,
  sha256,
  toJsonValue,
} from "../src/query-planner/index.js";

const CONTEXT = "tenant:alpha/role:analyst";
const PLAN_CONTEXT = {
  authorizationScope: ["data:read"],
  schemaVersion: "schema:4",
  sourceVersion: "source:9",
} as const;
const SIGNED_SOURCE =
  "https://AKIAIOSFODNN7EXAMPLE:node-secret@example.test/parcels.parquet?X-Amz-Signature=signature-secret";
const ROTATED_SOURCE = "https://account.blob.core.windows.net/parcels/current.parquet?sv=2026&sig=rotation-secret";
const MARKERS = ["AKIAIOSFODNN7EXAMPLE", "node-secret", "signature-secret", "rotation-secret"] as const;

describe("opaque GeoParquet v2 query plans", () => {
  it("keeps canonical plan, persistence, explain, log, and cache projections credential-free", () => {
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.plan-test" });
    const handle = registry.register({
      id: "parcels:current",
      authorizationContextId: CONTEXT,
      resourceVersion: "snapshot:42",
      sources: [SIGNED_SOURCE],
    });
    const plan = opaquePlan(handle);
    const serialized = serializeQueryPlan(plan);
    const cacheKey = queryPlanCacheKey(plan);
    const logProjection = JSON.stringify({ event: "query-plan-explained", plan, cacheKey });

    expect(plan.version).toBe("2.0");
    expect(plan.ir.version).toBe("2.0");
    expect(plan.ir.source).toMatchObject({
      id: "parcels:current",
      endpoint: "[opaque-resource]",
      geoparquet: { resource: handle, geometryColumn: "geometry", geometryEncoding: "wkb" },
    });
    expect(plan.steps[0]).toMatchObject({
      compiled: {
        compiler: "duckdb-sql-v2",
        resource: handle,
      },
    });
    const remote = plan.steps[0];
    if (!remote || remote.engine !== "remote") throw new Error("expected a remote step");
    expect(remote.compiled.sqlTemplate).toContain("honua-resource://resolve-at-execution");
    expect(cacheKey).toBe(`honua-query-plan:2.0:${plan.fingerprint}`);
    expect(hashQueryPlan(plan)).toBe(plan.fingerprint);
    assertRedacted([JSON.stringify(plan), serialized, cacheKey, logProjection], MARKERS);

    const parsed = parseQueryPlan(serialized);
    expect(parsed).toEqual(plan);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(serializeQueryPlan(parsed)).toBe(serialized);
  });

  it("binds cache identity to stable resource/scope/version while ignoring private credential rotation", () => {
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.identity" });
    const first = registry.register({
      id: "parcels:stable",
      authorizationContextId: CONTEXT,
      resourceVersion: "snapshot:7",
      sources: [SIGNED_SOURCE],
    });
    const firstPlan = opaquePlan(first);
    const rotated = registry.register({
      id: "parcels:stable",
      authorizationContextId: CONTEXT,
      resourceVersion: "snapshot:7",
      sources: [ROTATED_SOURCE],
    });
    const rotatedPlan = opaquePlan(rotated, ROTATED_SOURCE);
    expect(rotatedPlan.fingerprint).toBe(firstPlan.fingerprint);
    expect(queryPlanCacheKey(rotatedPlan)).toBe(queryPlanCacheKey(firstPlan));

    const nextVersion = createGeoParquetResourceHandle({
      resolver: "io.honua.identity",
      id: "parcels:stable",
      authorizationContextId: CONTEXT,
      resourceVersion: "snapshot:8",
    });
    const otherContext = createGeoParquetResourceHandle({
      resolver: "io.honua.identity",
      id: "parcels:stable",
      authorizationContextId: "tenant:beta/role:analyst",
      resourceVersion: "snapshot:7",
    });
    expect(queryPlanCacheKey(opaquePlan(nextVersion))).not.toBe(queryPlanCacheKey(firstPlan));
    expect(queryPlanCacheKey(opaquePlan(otherContext))).not.toBe(queryPlanCacheKey(firstPlan));
  });

  it("rejects unsafe v2 metadata before returning a self-invalid plan", () => {
    const handle = createGeoParquetResourceHandle({
      resolver: "io.honua.metadata",
      id: "parcels:metadata",
      authorizationContextId: CONTEXT,
    });
    const marker = "metadata-secret-marker";
    const base = descriptor(SIGNED_SOURCE);
    const cases: ReadonlyArray<{
      readonly descriptor: SourceDescriptor;
      readonly schemaVersion?: string;
      readonly sourceVersion?: string;
    }> = [
      { descriptor: { ...base, schema: { primaryKey: `id\n${marker}` } } },
      {
        descriptor: {
          ...base,
          locator: {
            ...base.locator,
            geoparquet: { ...base.locator.geoparquet, geometryColumn: `geometry\u0000${marker}` },
          },
        },
      },
      {
        descriptor: {
          ...base,
          locator: {
            ...base.locator,
            geoparquet: { ...base.locator.geoparquet, bboxColumn: `bbox\r${marker}` },
          },
        },
      },
      { descriptor: base, schemaVersion: `schema\t${marker}` },
      { descriptor: base, sourceVersion: `source\u007f${marker}` },
    ];

    for (const item of cases) {
      const error = captureError(() =>
        explainQuery({
          descriptor: item.descriptor,
          geoparquetResource: handle,
          ...(item.schemaVersion !== undefined ? { schemaVersion: item.schemaVersion } : {}),
          ...(item.sourceVersion !== undefined ? { sourceVersion: item.sourceVersion } : {}),
        }),
      );
      expect(error).toMatchObject({ code: "invalid-query" });
      assertErrorRedacted(error, [marker, ...MARKERS]);
    }
  });

  it("resolves only at execution and routes the private sources through the GeoParquet adapter seam", async () => {
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.execute" });
    const handle = registry.register({ id: "parcels:run", authorizationContextId: CONTEXT, sources: [SIGNED_SOURCE] });
    const plan = opaquePlan(handle);
    const executeResolvedQuery = vi.fn(
      async (input: { readonly sources: readonly string[]; readonly query: Query; readonly sourceId: string }) => {
        expect(input.sources).toEqual([SIGNED_SOURCE]);
        expect(input.query.where).toBe("population > 10");
        expect(input.sourceId).toBe("parcels:run");
        return result([{ attributes: { id: 1 } }]);
      },
    );
    const query = vi.fn();
    const source = fakeSource(descriptor(ROTATED_SOURCE), { executeResolvedQuery }, query);

    const execution = await executeQueryPlan(plan, source, {
      ...PLAN_CONTEXT,
      authorizationContextId: CONTEXT,
      geoParquetResourceResolver: registry.resolver,
    });
    expect(execution.result.features).toEqual([{ attributes: { id: 1 } }]);
    expect(executeResolvedQuery).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    assertRedacted([JSON.stringify(execution), serializeQueryPlan(plan)], MARKERS);
  });

  it("uses the real Node GeoParquet runtime seam without profiling or retaining the signed source in the plan", async () => {
    const sql: string[] = [];
    const runtime = new GeoparquetRuntime({
      driverFactory: async () => ({
        async run() {},
        async query(statement) {
          sql.push(statement);
          return [{ id: 7, name: "fixture" }];
        },
        async registerFileBuffer() {},
        async close() {},
      }),
    });
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.node-runtime" });
    const handle = registry.register({ id: "parcels:node", authorizationContextId: CONTEXT, sources: [SIGNED_SOURCE] });
    const plan = opaquePlan(handle);
    const source = geoparquetSource(descriptor(ROTATED_SOURCE), { runtime });

    try {
      const execution = await executeQueryPlan(plan, source, {
        ...PLAN_CONTEXT,
        authorizationContextId: CONTEXT,
        geoParquetResourceResolver: registry.resolver,
      });
      expect(execution.result.features[0]?.attributes).toMatchObject({ id: 7, name: "fixture" });
      expect(sql).toHaveLength(1);
      expect(sql[0]).toContain(SIGNED_SOURCE.replaceAll("'", "''"));
      expect(sql[0]).not.toContain("DESCRIBE");
      assertRedacted([serializeQueryPlan(plan), queryPlanCacheKey(plan)], MARKERS);
    } finally {
      await runtime.dispose();
    }
  });

  it("routes direct and bounded-local aggregation through the resolved resource seam", async () => {
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.aggregate" });
    const handle = registry.register({
      id: "parcels:aggregate",
      authorizationContextId: CONTEXT,
      sources: [SIGNED_SOURCE],
    });
    const aggregateQuery: Query = {
      aggregation: { metrics: [{ fn: "count", field: "*", alias: "total" }] },
    };
    const directPlan = explainQuery({
      descriptor: descriptor(SIGNED_SOURCE),
      geoparquetResource: handle,
      query: aggregateQuery,
      ...PLAN_CONTEXT,
    });
    const directAdapter = {
      executeResolvedQuery: vi.fn(async (input: { readonly operation: string; readonly query: Query }) => {
        expect(input.operation).toBe("queryAggregate");
        expect(input.query.aggregation).toEqual(aggregateQuery.aggregation);
        return { features: [], exceededTransferLimit: false, aggregateRows: [{ total: 9 }] };
      }),
    };
    await expect(
      executeQueryPlan(directPlan, fakeSource(descriptor(SIGNED_SOURCE), directAdapter), {
        ...PLAN_CONTEXT,
        authorizationContextId: CONTEXT,
        geoParquetResourceResolver: registry.resolver,
      }),
    ).resolves.toMatchObject({ result: { aggregateRows: [{ total: 9 }] } });

    const boundedDescriptor = descriptor(SIGNED_SOURCE, ["query"]);
    boundedDescriptor.schema = { primaryKey: "id" };
    const boundedPlan = explainQuery({
      descriptor: boundedDescriptor,
      geoparquetResource: handle,
      query: aggregateQuery,
      capabilityPolicy: "degraded",
      fallback: { mode: "bounded-local", maxRows: 2 },
      ...PLAN_CONTEXT,
    });
    expect(boundedPlan.ir.source.primaryKey).toBe("id");
    const boundedAdapter = {
      executeResolvedQuery: vi.fn(async (input: { readonly operation: string; readonly query: Query }) => {
        expect(input.operation).toBe("queryAll");
        expect(input.query.pagination).toEqual({ offset: 0, limit: 3 });
        return result([{ attributes: { id: 1 } }, { attributes: { id: 2 } }]);
      }),
    };
    await expect(
      executeQueryPlan(boundedPlan, fakeSource(boundedDescriptor, boundedAdapter), {
        ...PLAN_CONTEXT,
        authorizationContextId: CONTEXT,
        geoParquetResourceResolver: registry.resolver,
      }),
    ).resolves.toMatchObject({ result: { aggregateRows: [{ total: 2 }] } });
  });

  it("fails closed for absent, cross-context, unknown, and expired resolver entries", async () => {
    let now = 10;
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.fail-closed", now: () => now });
    const handle = registry.register({
      id: "parcels:guarded",
      authorizationContextId: CONTEXT,
      sources: [SIGNED_SOURCE],
      expiresAt: 11,
    });
    const plan = opaquePlan(handle);
    const adapter = { executeResolvedQuery: vi.fn(async () => result([])) };
    const source = fakeSource(descriptor(SIGNED_SOURCE), adapter);
    const resolver = vi.fn(registry.resolver);

    await expect(executeQueryPlan(plan, source, PLAN_CONTEXT)).rejects.toMatchObject({ code: "resource-unavailable" });
    await expect(
      executeQueryPlan(plan, source, {
        ...PLAN_CONTEXT,
        authorizationContextId: "tenant:beta/role:analyst",
        geoParquetResourceResolver: resolver,
      }),
    ).rejects.toMatchObject({ code: "resource-unavailable" });
    expect(resolver).not.toHaveBeenCalled();

    const foreign = createGeoParquetResourceRegistry({ resolver: "io.honua.foreign" });
    await expect(
      executeQueryPlan(plan, source, {
        ...PLAN_CONTEXT,
        authorizationContextId: CONTEXT,
        geoParquetResourceResolver: foreign.resolver,
      }),
    ).rejects.toMatchObject({ code: "resource-unavailable" });

    now = 11;
    const expired = await rejectionOf(
      executeQueryPlan(plan, source, {
        ...PLAN_CONTEXT,
        authorizationContextId: CONTEXT,
        geoParquetResourceResolver: resolver,
      }),
    );
    expect(expired).toMatchObject({ code: "resource-expired" });
    assertErrorRedacted(expired, MARKERS);
    expect(adapter.executeResolvedQuery).not.toHaveBeenCalled();
  });

  it("preserves cancellation and reconstructs adapter failures without retaining locator material", async () => {
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.errors" });
    const handle = registry.register({
      id: "parcels:error",
      authorizationContextId: CONTEXT,
      sources: [SIGNED_SOURCE],
    });
    const plan = opaquePlan(handle);
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeQueryPlan(plan, fakeSource(descriptor(SIGNED_SOURCE), { executeResolvedQuery: vi.fn() }), {
        ...PLAN_CONTEXT,
        authorizationContextId: CONTEXT,
        geoParquetResourceResolver: registry.resolver,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);

    const duringExecution = new AbortController();
    await expect(
      executeQueryPlan(
        plan,
        fakeSource(descriptor(SIGNED_SOURCE), {
          executeResolvedQuery() {
            duringExecution.abort();
            return result([]);
          },
        }),
        {
          ...PLAN_CONTEXT,
          authorizationContextId: CONTEXT,
          geoParquetResourceResolver: registry.resolver,
          signal: duringExecution.signal,
        },
      ),
    ).rejects.toBeInstanceOf(HonuaAbortError);

    const failure = await rejectionOf(
      executeQueryPlan(
        plan,
        fakeSource(descriptor(SIGNED_SOURCE), {
          executeResolvedQuery() {
            throw new Error(`DuckDB rejected ${SIGNED_SOURCE}`);
          },
        }),
        {
          ...PLAN_CONTEXT,
          authorizationContextId: CONTEXT,
          geoParquetResourceResolver: registry.resolver,
        },
      ),
    );
    expect(failure).toMatchObject({
      code: "resource-execution-failed",
      message: "GeoParquet resource execution failed",
    });
    assertErrorRedacted(failure, MARKERS);
  });

  it("retains credential-free v1 compatibility and provides an explicit v1-to-v2 migration", async () => {
    const legacyDescriptor = descriptor("fixtures/parcels.parquet");
    const legacy = explainQuery({ descriptor: legacyDescriptor, query: { pagination: { limit: 2 } } });
    const roundTrip = parseQueryPlan(serializeQueryPlan(legacy));
    expect(roundTrip.version).toBe("1.0");
    const query = vi.fn(async () => result([{ attributes: { id: 2 } }]));
    await expect(executeQueryPlan(legacy, fakeSource(legacyDescriptor, undefined, query))).resolves.toMatchObject({
      result: { features: [{ attributes: { id: 2 } }] },
    });

    const handle = createGeoParquetResourceHandle({
      resolver: "io.honua.migration",
      id: "parcels:migrated",
      authorizationContextId: CONTEXT,
      resourceVersion: "snapshot:1",
    });
    const migrated = migrateGeoParquetQueryPlanV1(legacy, handle);
    expect(migrated.version).toBe("2.0");
    expect(migrated.ir.source.geoparquet.resource).toEqual(handle);
    expect(serializeQueryPlan(migrated)).not.toContain("fixtures/parcels.parquet");
  });

  it("rejects credential-bearing legacy locators before planning, hashing, parsing, or migration", () => {
    const planningError = captureError(() => explainQuery({ descriptor: descriptor(SIGNED_SOURCE) }));
    expect(planningError).toMatchObject({
      code: "invalid-query",
      message: "Credential-bearing GeoParquet locators require an opaque resource handle",
    });
    assertErrorRedacted(planningError, MARKERS);

    const safe = explainQuery({ descriptor: descriptor("fixtures/parcels.parquet") });
    const hostile = structuredClone(safe);
    if (!hostile.ir.source.geoparquet) throw new Error("expected legacy GeoParquet identity");
    const hostileSources = hostile.ir.source.geoparquet.sources as string[];
    hostileSources[0] = SIGNED_SOURCE;
    const hashingError = captureError(() => hashQueryPlan(hostile));
    const parsingError = captureError(() => parseQueryPlan(JSON.stringify(hostile)));
    const migrationError = captureError(() =>
      migrateGeoParquetQueryPlanV1(
        hostile,
        createGeoParquetResourceHandle({
          resolver: "io.honua.migration",
          id: "parcels:hostile",
          authorizationContextId: CONTEXT,
        }),
      ),
    );
    for (const error of [hashingError, parsingError, migrationError]) {
      expect(error).toMatchObject({ code: "invalid-plan" });
      assertErrorRedacted(error, MARKERS);
    }

    const opaque = structuredClone(
      opaquePlan(
        createGeoParquetResourceHandle({
          resolver: "io.honua.hostile",
          id: "parcels:opaque",
          authorizationContextId: CONTEXT,
        }),
      ),
    ) as QueryExecutionPlanV2 & { diagnostic?: string };
    opaque.diagnostic = SIGNED_SOURCE;
    const opaqueHashingError = captureError(() => hashQueryPlan(opaque));
    const opaqueSerializationError = captureError(() => serializeQueryPlan(opaque));
    const opaqueParsingError = captureError(() => parseQueryPlan(JSON.stringify(opaque)));
    for (const error of [opaqueHashingError, opaqueSerializationError, opaqueParsingError]) {
      expect(error).toMatchObject({ code: "invalid-plan" });
      assertErrorRedacted(error, MARKERS);
    }
  });

  it("rejects re-signed non-canonical v2 fields at every persistence and execution boundary", async () => {
    const registry = createGeoParquetResourceRegistry({ resolver: "io.honua.canonical-plan" });
    const handle = registry.register({
      id: "parcels:canonical",
      authorizationContextId: CONTEXT,
      sources: [SIGNED_SOURCE],
    });
    const canonical = opaquePlan(handle);
    const resolver = vi.fn(registry.resolver);
    const adapter = { executeResolvedQuery: vi.fn(async () => result([])) };
    const source = fakeSource(descriptor(SIGNED_SOURCE), adapter);
    const attacks: ReadonlyArray<{
      readonly marker: string;
      readonly apply: (plan: QueryExecutionPlanV2) => void;
    }> = [
      {
        marker: "unknown-top-level-marker",
        apply(plan) {
          (plan as unknown as Record<string, unknown>).unexpected = "unknown-top-level-marker";
          resignPlan(plan);
        },
      },
      {
        marker: "unknown-nested-marker",
        apply(plan) {
          (plan.ir.query as unknown as Record<string, unknown>).unexpected = "unknown-nested-marker";
          resignPlan(plan);
        },
      },
      {
        marker: "changed-id-marker",
        apply(plan) {
          resignPlan(plan);
          (plan as unknown as { id: string }).id = "plan_changed-id-marker";
        },
      },
      {
        marker: "invalid-operation-marker",
        apply(plan) {
          const remote = plan.steps[0] as unknown as Record<string, unknown>;
          remote.operation = "invalid-operation-marker";
          resignPlan(plan);
        },
      },
      {
        marker: "step-mutation-marker",
        apply(plan) {
          const remote = plan.steps[0] as unknown as Record<string, unknown>;
          remote.reason = "step-mutation-marker";
          resignPlan(plan);
        },
      },
    ];

    for (const attack of attacks) {
      const hostile = structuredClone(canonical);
      attack.apply(hostile);
      const errors = [
        captureError(() => serializeQueryPlan(hostile)),
        captureError(() => parseQueryPlan(JSON.stringify(hostile))),
        await rejectionOf(
          executeQueryPlan(hostile, source, {
            ...PLAN_CONTEXT,
            authorizationContextId: CONTEXT,
            geoParquetResourceResolver: resolver,
          }),
        ),
      ];
      for (const error of errors) {
        expect(error).toMatchObject({
          code: "invalid-plan",
          message: "Query plan is invalid or unsafe to persist",
        });
        assertErrorRedacted(error, [attack.marker, ...MARKERS]);
      }
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(adapter.executeResolvedQuery).not.toHaveBeenCalled();
  });

  it("round-trips the committed credential-free persistence/explain/log/cache fixture", async () => {
    const fixture = JSON.parse(
      await readFile("test/fixtures/query-planner/geoparquet-resource-surfaces.v2.json", "utf8"),
    );
    const parsed = parseQueryPlan(fixture.persistence.plan);
    expect(serializeQueryPlan(parsed)).toBe(fixture.persistence.plan);
    expect(queryPlanCacheKey(parsed)).toBe(fixture.cache.key);
    expect(fixture.explain).toEqual(parsed);
    expect(fixture.log).toEqual({ event: "query-plan-explained", planId: parsed.id, fingerprint: parsed.fingerprint });
    assertRedacted([JSON.stringify(fixture)], MARKERS);
  });
});

function opaquePlan(handle: GeoParquetResourceHandleV1, locator = SIGNED_SOURCE): QueryExecutionPlanV2 {
  return explainQuery({
    descriptor: descriptor(locator),
    geoparquetResource: handle,
    query: { where: "population > 10", outFields: ["id", "name"], pagination: { limit: 2 } },
    ...PLAN_CONTEXT,
  });
}

function descriptor(
  url: string,
  supported: readonly Capability[] = ["query", "queryAggregate", "stream"],
): SourceDescriptor {
  return {
    id: "descriptor-id-is-not-plan-resource-identity",
    protocol: "geoparquet",
    locator: { url, geoparquet: { geometryColumn: "geometry", geometryEncoding: "wkb" } },
    capabilities: capabilities(supported),
  };
}

function fakeSource(
  sourceDescriptor: SourceDescriptor,
  adapter: { readonly executeResolvedQuery: (...args: never[]) => unknown } | undefined,
  query = vi.fn(async () => result([])),
): Source {
  const unsupported = async () => {
    throw new Error("not used");
  };
  return {
    descriptor: sourceDescriptor,
    capabilities: sourceDescriptor.capabilities,
    query,
    queryAll: unsupported,
    queryAggregate: unsupported,
    queryExtent: unsupported,
    async *stream() {},
    queryObjectIds: unsupported,
    applyEdits: unsupported,
    queryRelated: unsupported,
    attachments: { query: unsupported, list: unsupported, add: unsupported, update: unsupported, delete: unsupported },
    protocol: () => adapter as never,
    adapter: () => adapter as never,
  };
}

function result(features: Result["features"]): Result {
  return { features, exceededTransferLimit: false };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

function captureError(callback: () => unknown): unknown {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error("Expected callback to throw");
}

function resignPlan(plan: QueryExecutionPlanV2): void {
  const mutable = plan as unknown as Record<string, unknown>;
  const { id: _id, fingerprint: _fingerprint, ...unsigned } = mutable;
  const fingerprint = sha256(canonicalStringify(toJsonValue(unsigned)));
  mutable.fingerprint = fingerprint;
  mutable.id = `plan_${fingerprint.slice("sha256:".length, "sha256:".length + 16)}`;
}

function assertRedacted(surfaces: readonly string[], markers: readonly string[]): void {
  for (const surface of surfaces) {
    for (const marker of markers) expect(surface).not.toContain(marker);
  }
}

function assertErrorRedacted(error: unknown, markers: readonly string[]): void {
  const record = error as { readonly message?: unknown; readonly stack?: unknown; readonly cause?: unknown };
  const surfaces = [
    String(error),
    typeof record.message === "string" ? record.message : "",
    typeof record.stack === "string" ? record.stack : "",
    JSON.stringify(error) ?? "",
    JSON.stringify(record.cause) ?? "",
  ];
  if (isHonuaSdkError(error)) surfaces.push(JSON.stringify(serializeHonuaError(error)));
  assertRedacted(surfaces, markers);
  expect(record.cause).toBeUndefined();
}
