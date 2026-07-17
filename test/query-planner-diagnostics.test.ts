import { execFileSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import type { Result, Source, SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import {
  canonicalStringify,
  executeQueryPlan,
  explainQuery,
  parseQueryPlan,
  serializeQueryPlan,
  sha256,
  toJsonValue,
} from "../src/query-planner/index.js";
import type { GeoParquetResourceHandleV1 } from "../src/query-planner/resource.js";

const SHA_A = `sha256:${"a".repeat(64)}` as const;
const SHA_B = `sha256:${"b".repeat(64)}` as const;

function descriptor(overrides: Partial<SourceDescriptor> = {}): SourceDescriptor {
  return {
    id: "parcels",
    protocol: "geoservices-feature-service",
    locator: { url: "https://features.example.test/FeatureServer", serviceId: "parcels", layerId: 0 },
    capabilities: capabilities(["query", "queryAggregate"]),
    schemaV2: { kind: "honua.source-schema", version: "2.0", fingerprint: SHA_A },
    ...overrides,
  };
}

function fakeSource(sourceDescriptor: SourceDescriptor): Source {
  const result: Result = { features: [], exceededTransferLimit: false };
  const query = vi.fn(async () => result);
  return {
    descriptor: sourceDescriptor,
    capabilities: sourceDescriptor.capabilities,
    query,
    queryAll: query,
    queryAggregate: query,
    queryExtent: query,
    async *stream() {},
    queryObjectIds: vi.fn(async () => []),
    applyEdits: vi.fn(async () => ({ added: [], updated: [], deleted: [] })),
    queryRelated: vi.fn(async () => ({ groups: [] })),
    attachments: {
      query: vi.fn(async () => []),
      list: vi.fn(async () => []),
      add: vi.fn(async () => ({ success: true })),
      update: vi.fn(async () => ({ success: true })),
      delete: vi.fn(async () => ({ success: true })),
    },
    protocol: () => undefined,
    adapter: () => undefined,
  } as unknown as Source;
}

describe("structured query-plan decisions", () => {
  it("emits versioned bounds, cache, fidelity, provenance, warnings, and validity without raw evidence", () => {
    const plan = explainQuery({
      descriptor: descriptor(),
      query: { pagination: { limit: 25 }, outSr: 4326 },
      authorizationScope: ["tenant:alpha/read"],
      estimates: { rows: 20, bytes: 4_096, requests: 1 },
      cache: {
        policy: "require-fresh",
        freshness: "stale",
        validator: { kind: "etag", value: 'secret-etag-"7"' },
      },
      discovery: {
        state: "metadata",
        source: "https://user:password@catalog.example.test/items?token=discovery-secret",
        validator: { kind: "revision", value: "private-revision-7" },
      },
    });

    expect(plan).toMatchObject({
      diagnosticsVersion: "1.0",
      fidelity: "exact",
      losses: [],
      bounds: {
        version: "1.0",
        requests: { confidence: "exact", lower: 1, upper: 1, unit: "request" },
        rows: { confidence: "bounded", upper: 25, unit: "row" },
        bytes: { confidence: "estimated", estimate: 4_096, unit: "byte" },
        transferBytes: { confidence: "estimated", estimate: 4_096, unit: "byte" },
      },
      cache: {
        version: "1.0",
        policy: "require-fresh",
        action: "revalidate",
        freshness: "stale",
        reason: "validator-available",
      },
      provenance: {
        version: "1.0",
        schema: { state: "known", fingerprint: SHA_A, basis: "schema-v2" },
        discovery: { state: "metadata" },
        authorizationScope: { count: 1 },
      },
      validity: { version: "1.0", plannerVersion: "honua-query-planner@1", executionMode: "snapshot" },
      warnings: [],
    });
    expect(plan.steps[0]).toMatchObject({
      engine: "remote",
      pushdown: "full",
      fidelity: "exact",
      losses: [],
      bounds: { version: "1.0" },
      provenance: { version: "1.0" },
    });
    const serialized = serializeQueryPlan(plan);
    for (const secret of ["password", "discovery-secret", "secret-etag", "private-revision"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("normalizes bypass identity and discards irrelevant freshness and validator evidence", () => {
    const first = explainQuery({
      descriptor: descriptor(),
      cache: { policy: "bypass", freshness: "fresh", validator: { kind: "etag", value: "bypass-marker-one" } },
    });
    const second = explainQuery({
      descriptor: descriptor(),
      cache: {
        policy: "bypass",
        freshness: "stale",
        validator: { kind: "revision", value: "bypass-marker-two" },
      },
    });

    expect(first.cache).toEqual({
      version: "1.0",
      policy: "bypass",
      action: "bypass",
      freshness: "unknown",
      reason: "policy-bypass",
    });
    expect(second.cache).toEqual(first.cache);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(serializeQueryPlan(first)).not.toMatch(/bypass-marker/);
  });

  it("reports spatial envelope reduction as approximate at step and plan scope", () => {
    const plan = explainQuery({
      descriptor: {
        id: "parcels",
        protocol: "geoparquet",
        locator: {
          url: "fixtures/parcels.parquet",
          geoparquet: { geometryColumn: "geometry", geometryEncoding: "wkb" },
        },
        capabilities: capabilities(["query"]),
      },
      query: {
        spatialFilter: {
          geometryType: "esriGeometryPolygon",
          geometry: {
            rings: [
              [
                [0, 0],
                [2, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        },
      },
    });

    expect(plan.fidelity).toBe("approximate");
    expect(plan.losses).toEqual([
      expect.objectContaining({ code: "spatial-envelope-reduction", path: "$.ir.query.spatialFilter" }),
    ]);
    expect(plan.steps[0]).toMatchObject({ fidelity: "approximate", losses: plan.losses });
    expect(plan.warnings).toContainEqual(
      expect.objectContaining({ code: "approximate-spatial-filter", path: "$.ir.query.spatialFilter" }),
    );

    const dishonest = structuredClone(plan) as unknown as Record<string, unknown>;
    dishonest.fidelity = "exact";
    dishonest.losses = [];
    dishonest.warnings = [];
    const firstStep = (dishonest.steps as Array<Record<string, unknown>>)[0];
    if (!firstStep) throw new Error("expected a remote step");
    firstStep.fidelity = "exact";
    firstStep.losses = [];
    resignPlan(dishonest);
    expect(captureError(() => serializeQueryPlan(dishonest as never))).toMatchObject({ code: "invalid-plan" });

    const disguisedCompiler = structuredClone(plan) as unknown as Record<string, unknown>;
    disguisedCompiler.fidelity = "exact";
    disguisedCompiler.losses = [];
    disguisedCompiler.warnings = [];
    const disguisedStep = (disguisedCompiler.steps as Array<Record<string, unknown>>)[0];
    if (!disguisedStep) throw new Error("expected a remote step");
    disguisedStep.fidelity = "exact";
    disguisedStep.losses = [];
    delete (disguisedStep.compiled as Record<string, unknown>).bboxApproximated;
    resignPlan(disguisedCompiler);
    expect(captureError(() => serializeQueryPlan(disguisedCompiler as never))).toMatchObject({ code: "invalid-plan" });
  });

  it("marks bounded local execution equivalent and exposes materialization ceilings", () => {
    const plan = explainQuery({
      descriptor: descriptor({ capabilities: capabilities(["query"]) }),
      query: { aggregation: { metrics: [{ fn: "count", field: "OBJECTID" }] } },
      capabilityPolicy: "degraded",
      fallback: { mode: "bounded-local", maxRows: 100, maxBytes: 8_192 },
    });
    expect(plan.fidelity).toBe("equivalent");
    expect(plan.steps[1]).toMatchObject({
      engine: "client",
      fidelity: "equivalent",
      bounds: {
        rows: { confidence: "bounded", upper: 100 },
        serializedMaterializationBytes: { confidence: "bounded", upper: 8_192 },
        memoryBytes: { confidence: "unknown" },
      },
    });
    expect(plan.bounds).toMatchObject({
      requests: { confidence: "unknown", source: "plan-summary", lower: 1 },
      rows: { confidence: "bounded", source: "plan-summary", lower: 0, upper: 201 },
      bytes: { confidence: "unknown", source: "plan-summary" },
      serializedMaterializationBytes: {
        confidence: "bounded",
        source: "plan-summary",
        lower: 0,
        upper: 8_192,
      },
      memoryBytes: { confidence: "unknown", source: "plan-summary" },
    });
    expect(plan.warnings[0]).toMatchObject({ code: "bounded-local-fallback", path: "$.steps[1]" });
  });

  it("validates request counts and keeps exact and queryAll request evidence consistent", () => {
    for (const requests of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => explainQuery({ descriptor: descriptor(), estimates: { requests } })).toThrow(
        /estimates\.requests must be a safe integer >= 1/,
      );
    }

    expect(() => explainQuery({ descriptor: descriptor(), estimates: { requests: 7 } })).toThrow(
      /must be 1 for the exact single-request query operation/,
    );
    const direct = explainQuery({ descriptor: descriptor(), estimates: { requests: 1 } });
    expect(direct.steps[0]).toMatchObject({
      requests: 1,
      bounds: { requests: { confidence: "exact", lower: 1, upper: 1, estimate: 1 } },
    });
    expect(direct.bounds.requests).toMatchObject({ confidence: "exact", lower: 1, upper: 1, estimate: 1 });

    const queryAll = explainQuery({
      descriptor: descriptor({ capabilities: capabilities(["query"]) }),
      query: { aggregation: { metrics: [{ fn: "count", field: "OBJECTID" }] } },
      capabilityPolicy: "degraded",
      fallback: { mode: "bounded-local", maxRows: 10 },
      estimates: { requests: 3 },
    });
    expect(queryAll.steps[0]).toMatchObject({
      requests: 3,
      bounds: { requests: { confidence: "estimated", lower: 1, estimate: 3 } },
    });
    expect(queryAll.bounds.requests).toMatchObject({
      confidence: "estimated",
      source: "plan-summary",
      lower: 1,
      estimate: 3,
    });
  });

  it("binds source and filter CRS evidence independently of output CRS", () => {
    const planFor = (wkid: number, srsName: string) =>
      explainQuery({
        descriptor: descriptor({ locator: { ...descriptor().locator, srsName } }),
        query: {
          spatialFilter: {
            geometryType: "esriGeometryPoint",
            geometry: { x: -157.8, y: 21.3, spatialReference: { wkid } },
          },
          outSr: 3857,
        },
      });
    const first = planFor(4326, "EPSG:4326");
    const changedFilter = planFor(4269, "EPSG:4326");
    const changedSource = planFor(4326, "EPSG:4269");

    expect(changedFilter.validity.crsFingerprint).not.toBe(first.validity.crsFingerprint);
    expect(changedSource.validity.crsFingerprint).not.toBe(first.validity.crsFingerprint);
  });

  it("excludes volatile observation/cursor fields while binding snapshot versus delta mode", () => {
    const build = (observedAt: string, cursor: string, executionMode: "snapshot" | "delta" = "snapshot") =>
      explainQuery({
        descriptor: descriptor(),
        discovery: {
          state: "metadata",
          source: "catalog:parcels",
          observedAt,
        } as never,
        executionMode,
        cursor,
      } as never);
    const first = build("2026-07-15T00:00:00Z", "cursor-secret-one");
    const second = build("2026-07-16T00:00:00Z", "cursor-secret-two");
    const delta = build("2026-07-16T00:00:00Z", "cursor-secret-three", "delta");
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(delta.fingerprint).not.toBe(first.fingerprint);
    expect(serializeQueryPlan(first)).not.toContain("cursor-secret");
    expect(first.validity.executionMode).toBe("snapshot");
    expect(delta.validity.executionMode).toBe("delta");
  });

  it("round-trips structured opaque-resource cache and provenance decisions", () => {
    const resource: GeoParquetResourceHandleV1 = {
      kind: "honua.query-resource",
      version: "1.0",
      protocol: "geoparquet",
      resource: { kind: "resolver", resolver: "io.honua.test", id: "parcels" },
      authorizationContextId: "tenant:alpha",
    };
    const plan = explainQuery({
      descriptor: {
        id: "private-parcels",
        protocol: "geoparquet",
        locator: { url: "honua-resource://opaque" },
        capabilities: capabilities(["query"]),
        schemaV2: { kind: "honua.source-schema", version: "2.0", fingerprint: SHA_A },
      },
      geoparquetResource: resource,
      cache: { policy: "prefer-cache", freshness: "fresh", validator: { kind: "revision", value: "snapshot-7" } },
      discovery: { state: "metadata", source: "catalog:private-parcels" },
    });
    expect(parseQueryPlan(serializeQueryPlan(plan))).toEqual(plan);
  });
});

describe("query-plan validity and redaction", () => {
  it("fails stale and foreign contexts with stable typed reasons", async () => {
    const plannedDescriptor = descriptor();
    const plan = explainQuery({
      descriptor: plannedDescriptor,
      sourceVersion: "source-1",
      authorizationScope: ["tenant:alpha/read"],
      discovery: { state: "metadata", source: "catalog:parcels", validator: { kind: "revision", value: "r1" } },
    });

    await expect(
      executeQueryPlan(plan, fakeSource(plannedDescriptor), {
        sourceVersion: "source-2",
        authorizationScope: ["tenant:alpha/read"],
        discovery: { state: "metadata", source: "catalog:parcels", validator: { kind: "revision", value: "r1" } },
      }),
    ).rejects.toMatchObject({
      code: "stale-plan",
      reason: "source-version-changed",
      context: { reason: "source-version-changed" },
    });

    await expect(
      executeQueryPlan(plan, fakeSource(plannedDescriptor), {
        sourceVersion: "source-1",
        authorizationScope: ["tenant:beta/read"],
        discovery: { state: "metadata", source: "catalog:parcels", validator: { kind: "revision", value: "r1" } },
      }),
    ).rejects.toMatchObject({ code: "foreign-plan", reason: "authorization-scope-changed" });

    await expect(
      executeQueryPlan(plan, fakeSource(descriptor({ id: "buildings" })), {
        sourceVersion: "source-1",
        authorizationScope: ["tenant:alpha/read"],
        discovery: { state: "metadata", source: "catalog:parcels", validator: { kind: "revision", value: "r1" } },
      }),
    ).rejects.toMatchObject({ code: "foreign-plan", reason: "source-identity-changed" });

    await expect(
      executeQueryPlan(plan, fakeSource(plannedDescriptor), {
        sourceVersion: "source-1",
        authorizationScope: ["tenant:alpha/read"],
        discovery: { state: "metadata", source: "catalog:parcels", validator: { kind: "revision", value: "r2" } },
      }),
    ).rejects.toMatchObject({ code: "stale-plan", reason: "discovery-changed" });
  });

  it("rejects credential-like native expressions and authorization scopes without retaining them", () => {
    const markers = ["native-secret-123", "eyJabcdefghijk.abcdefghijk.abcdefghijk", "version-marker-123"];
    const errors: unknown[] = [];
    for (const build of [
      () => explainQuery({ descriptor: descriptor(), query: { where: "password = 'native-secret-123'" } }),
      () => explainQuery({ descriptor: descriptor(), authorizationScope: [markers[1]!] }),
      () =>
        explainQuery({
          descriptor: descriptor(),
          sourceVersion: `https://catalog.example.test/item?token=${markers[2]}`,
        }),
    ]) {
      try {
        build();
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors).toHaveLength(3);
    for (const error of errors) {
      const surface = `${String(error)}\n${JSON.stringify(error)}\n${error instanceof Error ? error.stack : ""}`;
      for (const marker of markers) expect(surface).not.toContain(marker);
    }
  });

  it("bounds and digests schema/source version evidence before persistence", () => {
    const schemaVersion = "schema-private-evidence-7";
    const sourceVersion = "source-private-evidence-9";
    const plan = explainQuery({ descriptor: descriptor({ schemaV2: undefined }), schemaVersion, sourceVersion });
    const serialized = serializeQueryPlan(plan);

    expect(plan.ir.source.schemaVersion).toBe(schemaVersion);
    expect(plan.ir.source.sourceVersion).toBe(sourceVersion);
    expect(plan.provenance.schema).toMatchObject({ fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(plan.provenance.source.versionFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    if (plan.provenance.schema.state !== "known") throw new Error("expected schema version provenance");
    expect(plan.provenance.schema.fingerprint).not.toContain(schemaVersion);
    expect(plan.provenance.source.versionFingerprint).not.toContain(sourceVersion);
    expect(serialized).toContain(schemaVersion);
    expect(serialized).toContain(sourceVersion);
    expect(() => explainQuery({ descriptor: descriptor(), schemaVersion: "s".repeat(1_025) })).toThrow(
      /schema version identity is invalid/,
    );
    expect(() => explainQuery({ descriptor: descriptor(), sourceVersion: "s".repeat(1_025) })).toThrow(
      /source version identity is invalid/,
    );
  });

  it("rejects re-signed nested locator, header, and query credentials without over-redacting benign fields", () => {
    const base = explainQuery({
      descriptor: descriptor(),
      query: { where: "token_count > 0", outFields: ["token_count", "secret_category"] },
    });
    expect(() => serializeQueryPlan(base)).not.toThrow();

    const attacks = [
      { transport: { locator: { url: "https://user:locator-marker@example.test/data" } } },
      { transport: { headers: { "X-Auth": "header-marker" } } },
      { transport: { query: { key: "query-marker" } } },
      { transport: { credentials: { value: "key-marker" } } },
    ];
    for (const attack of attacks) {
      const hostile = structuredClone(base) as unknown as Record<string, unknown>;
      Object.assign(hostile, attack);
      resignPlan(hostile);
      const error = captureError(() => serializeQueryPlan(hostile as never));
      expect(error).toMatchObject({ code: "invalid-plan" });
      const surface = `${String(error)}\n${JSON.stringify(error)}\n${error instanceof Error ? error.stack : ""}`;
      expect(surface).not.toMatch(/(?:locator|header|query|key)-marker/);
    }
  });

  it("serializes identically in independent processes", () => {
    const program = `
      import { explainQuery, serializeQueryPlan } from "./dist/src/query-planner/index.js";
      const plan = explainQuery({
        descriptor: {
          id: "stable",
          protocol: "geoservices-feature-service",
          locator: { url: "https://example.test/FeatureServer", serviceId: "stable", layerId: 0 },
          capabilities: new Set(["query"]),
        },
        query: { pagination: { limit: 7 }, outSr: 4326 },
        cache: { policy: "prefer-cache", freshness: "fresh", validator: { kind: "etag", value: "v7" } },
        discovery: { state: "declared", source: "fixture:stable" },
      });
      process.stdout.write(serializeQueryPlan(plan));
    `;
    const run = () => execFileSync(process.execPath, ["--input-type=module", "--eval", program], { encoding: "utf8" });
    expect(run()).toBe(run());
  });
});

function resignPlan(plan: Record<string, unknown>): void {
  const { id: _id, fingerprint: _fingerprint, ...unsigned } = plan;
  const fingerprint = sha256(canonicalStringify(toJsonValue(unsigned)));
  plan.fingerprint = fingerprint;
  plan.id = `plan_${fingerprint.slice("sha256:".length, "sha256:".length + 16)}`;
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected operation to fail");
}
