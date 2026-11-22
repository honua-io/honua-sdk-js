import { describe, expect, it, vi } from "vitest";

import {
  GOVERNED_WAREHOUSE_PROVIDERS,
  type GovernedWarehouseProvider,
  HonuaWarehouseError,
  type WarehouseEffectiveSourceCapabilities,
  type WarehouseExecutionPlan,
  type WarehousePlanBudgets,
  type WarehouseSemanticIntent,
  type WarehouseSourceTransport,
  acceptWarehouseExecutionPlan,
  buildWarehouseExplainRequest,
  buildWarehouseSourceCacheKey,
  collectWarehouseColumnarStream,
  createGovernedWarehouseSource,
  evaluateWarehouseExecutionPlan,
  executeWarehouseColumnarStream,
  handoffWarehouseBatchToDeckGl,
  handoffWarehouseBatchToMapLibre,
  reconcileWarehouseExecutionMetrics,
  runWarehouseProviderConformance,
  validateWarehouseExecutionPlan,
  validateWarehouseSourceCapabilities,
} from "../src/columnar-workflow/index.js";
import { createGeoArrowBatch } from "../src/columnar/index.js";
import { createDataset } from "../src/contract/source.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaAbortError, HonuaCapabilityNotSupportedError } from "../src/core/errors.js";

const FIXED_NOW = () => new Date("2026-11-21T12:00:00.000Z");

function sampleCapabilities(
  provider: GovernedWarehouseProvider,
  overrides: Partial<WarehouseEffectiveSourceCapabilities> = {},
): WarehouseEffectiveSourceCapabilities {
  return {
    schemaVersion: "honua.warehouse-source-capabilities.v1",
    sourceId: `${provider}-parcels`,
    connectionId: `conn-${provider}-01`,
    provider,
    governedQueryId: `gq_${provider}_parcels_v1`,
    sourceVersion: "rev-2026-11-21",
    schemaVersionToken: "schema-v1",
    geometryField: "geometry",
    temporalField: "updated_at",
    fields: [
      { name: "id", type: "integer", nullable: false },
      { name: "zone", type: "string", nullable: true },
      { name: "updated_at", type: "timestamp", nullable: true },
    ],
    availability: {
      status: "available",
      observedAt: "2026-11-21T11:00:00.000Z",
      expiresAt: "2026-11-21T14:00:00.000Z",
    },
    policy: {
      policyScopeFingerprint: "scope:tenant-alpha:role-analyst",
      tenantScope: "tenant-alpha",
      readOnly: true,
      rowPolicyActive: true,
      fieldMaskingActive: true,
    },
    crs: {
      storageCrs: "OGC:CRS84",
      supportsReprojection: true,
      geometryModel: "geodetic",
    },
    limits: {
      maxScannedRows: 5_000_000,
      maxScannedBytes: 512 * 1024 * 1024,
      maxReturnedRows: 100_000,
      maxReturnedBytes: 64 * 1024 * 1024,
      deadlineMs: 15_000,
      costHintAvailable: true,
    },
    formats: ["format.geoparquet", "format.geoarrow"],
    spatialPredicates: ["bbox-intersects", "intersects", "within"],
    capabilities: {
      query: true,
      queryAggregate: true,
      spatialAggregate: true,
      h3Aggregation: true,
      queryExtent: true,
      stream: true,
      temporalFilter: true,
      widgets: true,
    },
    ...overrides,
  };
}

function samplePlan(
  provider: GovernedWarehouseProvider,
  overrides: Partial<WarehouseExecutionPlan> = {},
): WarehouseExecutionPlan {
  return {
    schemaVersion: "honua.warehouse-execution-plan.v1",
    planId: `plan-${provider}-001`,
    planFingerprint: `sha256:plan-${provider}-001`,
    sourceId: `${provider}-parcels`,
    provider,
    policyScopeFingerprint: "scope:tenant-alpha:role-analyst",
    sourceVersion: "rev-2026-11-21",
    schemaVersionToken: "schema-v1",
    parameterRedacted: true,
    representation: "geoarrow",
    outputFormat: "format.geoarrow",
    pushedDownPredicates: ["bbox-intersects", "zone = $1"],
    residualPredicates: [],
    bboxPushdown: true,
    h3Pushdown: true,
    stages: [
      { id: "s1", stage: "warehouse", operation: "spatial-scan-and-h3-aggregate", pushedDown: true },
      { id: "s2", stage: "server", operation: "geoarrow-stream-encode", pushedDown: true },
      { id: "s3", stage: "browser", operation: "deckgl-gpu-bind", pushedDown: false },
    ],
    transfers: [
      {
        from: "warehouse",
        to: "server",
        format: "format.geoarrow",
        estimatedRows: 4,
        estimatedBytes: 4_096,
      },
      {
        from: "server",
        to: "browser",
        format: "format.geoarrow",
        estimatedRows: 4,
        estimatedBytes: 4_096,
      },
    ],
    estimates: {
      scannedRows: 25_000,
      scannedBytes: 2 * 1024 * 1024,
      returnedRows: 4,
      returnedBytes: 4_096,
      transferBytes: 4_096,
      estimatedCost: 0.04,
      costCurrency: "USD",
      confidence: "bounded",
    },
    fidelity: { level: "exact", losses: [] },
    deadlineMs: 5_000,
    ...overrides,
  };
}

function samplePointBatch(plan: WarehouseExecutionPlan, sequence = 0) {
  return createGeoArrowBatch({
    id: `${plan.sourceId}:batch-${sequence}`,
    sequence,
    rowOffset: sequence * 2,
    schemaId: "schema-v1",
    identity: {
      sourceId: plan.sourceId,
      sourceVersion: plan.sourceVersion,
      schemaVersion: "schema-v1",
      planId: plan.planId,
      authorizationScope: plan.policyScopeFingerprint,
      ordering: { stable: true, keys: [{ field: "id", direction: "ascending", nulls: "last" }] },
      freshness: { observedAt: "2026-11-21T12:00:00.000Z" },
    },
    geometry: {
      kind: "point",
      field: "geometry",
      coordinateLayout: "interleaved",
      crs: "OGC:CRS84",
      values: [
        [-156.49, 20.9],
        [-156.48, 20.91],
      ],
    },
    featureIds: { field: "id", values: [sequence * 2 + 1, sequence * 2 + 2] },
    dictionary: { field: "zone", values: ["R-1", "AG"] },
  }).batch;
}

function stubQueryTransport(): WarehouseSourceTransport {
  return {
    async query() {
      return {
        features: [{ attributes: { id: 1, zone: "R-1" }, geometry: { type: "Point", coordinates: [-156.49, 20.9] } }],
        exceededTransferLimit: false,
      };
    },
    async queryAggregate() {
      return {
        features: [],
        exceededTransferLimit: false,
        aggregateRows: [{ count: 4 }],
      };
    },
    async queryExtent() {
      return { extent: { xmin: -156.5, ymin: 20.89, xmax: -156.48, ymax: 20.92 }, count: 4 };
    },
  };
}

describe("governed warehouse source and capability contract", () => {
  it("supports Redshift, Snowflake, Databricks, and DuckDB while rejecting BigQuery and CARTO", () => {
    expect(GOVERNED_WAREHOUSE_PROVIDERS).toEqual(["redshift", "snowflake", "databricks", "duckdb"]);
    for (const provider of GOVERNED_WAREHOUSE_PROVIDERS) {
      const validated = validateWarehouseSourceCapabilities(sampleCapabilities(provider));
      expect(validated.provider).toBe(provider);
      expect(validated.formats).toEqual(["format.geoparquet", "format.geoarrow"]);
    }
    for (const excluded of ["bigquery", "carto"]) {
      expect(() =>
        validateWarehouseSourceCapabilities({
          ...sampleCapabilities("snowflake"),
          provider: excluded,
        }),
      ).toThrow(HonuaCapabilityNotSupportedError);
    }
  });

  it("rejects incompatible versions and malformed field and spatial declarations", () => {
    const valid = sampleCapabilities("snowflake");
    for (const invalid of [
      { schemaVersion: "honua.warehouse-source-capabilities.v2" },
      { fields: [{ name: "id", type: "integer" }] },
      { spatialPredicates: ["unknown"] },
    ]) {
      expect(() => validateWarehouseSourceCapabilities({ ...valid, ...invalid })).toThrow(HonuaWarehouseError);
    }
  });

  it("checks the geometry and relation against declared predicates before querying", async () => {
    const query = vi.fn(stubQueryTransport().query);
    const source = createGovernedWarehouseSource(
      sampleCapabilities("snowflake", { spatialPredicates: ["bbox-intersects"] }),
      { query },
      { now: FIXED_NOW },
    );

    await source.query({
      spatialFilter: { geometryType: "esriGeometryEnvelope", geometry: { xmin: 0, ymin: 0, xmax: 1, ymax: 1 } },
    });
    for (const spatialRel of [
      undefined,
      "esriSpatialRelWithin",
      "esriSpatialRelContains",
      "esriSpatialRelIndexIntersects",
    ]) {
      await expect(
        source.query({
          spatialFilter: {
            geometryType: "esriGeometryPolygon",
            geometry: {
              rings: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 0],
                ],
              ],
            },
            ...(spatialRel ? { spatialRel } : {}),
          },
        }),
      ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    }
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("never infers capabilities from provider name and fails closed with HonuaCapabilityNotSupportedError", async () => {
    const restricted = sampleCapabilities("snowflake", {
      formats: ["format.geoparquet"],
      capabilities: {
        query: true,
        queryAggregate: false,
        spatialAggregate: false,
        h3Aggregation: false,
        queryExtent: false,
        stream: false,
        temporalFilter: false,
        widgets: false,
      },
    });
    const source = createGovernedWarehouseSource(restricted, stubQueryTransport(), { now: FIXED_NOW });

    expect(source.supportsFormat("format.geoparquet")).toBe(true);
    expect(source.supportsFormat("format.geoarrow")).toBe(false);
    expect(() => source.assertFormat("format.geoarrow")).toThrow(HonuaCapabilityNotSupportedError);
    await expect(
      source.queryAggregate({ aggregation: { metrics: [{ fn: "count", field: "*", alias: "n" }] } }),
    ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(source.applyEdits({})).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
  });

  it("fails closed when capability evidence is expired or unavailable", async () => {
    const expiredSource = createGovernedWarehouseSource(sampleCapabilities("databricks"), stubQueryTransport(), {
      now: () => new Date("2026-11-21T15:00:00.000Z"),
    });
    await expect(expiredSource.query()).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);

    const unavailableSource = createGovernedWarehouseSource(
      sampleCapabilities("redshift", {
        availability: {
          status: "unavailable",
          reason: "warehouse cluster paused",
          observedAt: "2026-11-21T11:00:00.000Z",
          expiresAt: "2026-11-21T14:00:00.000Z",
        },
      }),
      stubQueryTransport(),
      { now: FIXED_NOW },
    );
    await expect(unavailableSource.query()).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
  });

  it("rejects credentials, signed URLs, connection strings, and raw vendor SQL", () => {
    const secretCases: Array<Record<string, unknown>> = [
      { ...sampleCapabilities("redshift"), password: "super-secret-password" },
      {
        ...sampleCapabilities("snowflake"),
        diagnostics: { auth: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123456" },
      },
      {
        ...sampleCapabilities("databricks"),
        diagnostics: { uri: "https://bucket.example/file?X-Amz-Signature=deadbeef" },
      },
      { ...sampleCapabilities("duckdb"), diagnostics: { dsn: "postgresql://admin:secret@db.internal:5432/gis" } },
      { ...sampleCapabilities("snowflake"), governedQueryId: "SELECT * FROM private.parcels" },
      { ...sampleCapabilities("databricks"), sql: "SELECT * FROM catalog.schema.parcels" },
    ];
    for (const payload of secretCases) {
      expect(() => validateWarehouseSourceCapabilities(payload)).toThrow(HonuaWarehouseError);
    }
  });

  it("isolates cache keys by policy scope and integrates into Dataset without provider-specific code", async () => {
    const alpha = validateWarehouseSourceCapabilities(sampleCapabilities("duckdb"));
    const beta = validateWarehouseSourceCapabilities(
      sampleCapabilities("duckdb", {
        policy: { ...alpha.policy, policyScopeFingerprint: "scope:tenant-beta:role-analyst" },
      }),
    );
    expect(buildWarehouseSourceCacheKey(alpha)).not.toBe(buildWarehouseSourceCacheKey(beta));

    const client = new HonuaClient({ baseUrl: "https://honua.example.test" });
    const redshiftSource = createGovernedWarehouseSource(sampleCapabilities("redshift"), stubQueryTransport(), {
      now: FIXED_NOW,
    });
    const databricksSource = createGovernedWarehouseSource(sampleCapabilities("databricks"), stubQueryTransport(), {
      now: FIXED_NOW,
    });
    const dataset = createDataset({
      id: "warehouse-ops",
      client,
      skipCompatibilityCheck: true,
      sources: [redshiftSource.descriptor, databricksSource.descriptor],
      resolveSource: (descriptor) =>
        descriptor.id === redshiftSource.descriptor.id ? redshiftSource : databricksSource,
    });

    for (const id of [redshiftSource.descriptor.id, databricksSource.descriptor.id]) {
      const result = await dataset.source(id)!.query();
      expect(result.features).toHaveLength(1);
    }
  });
});

describe("server-authored warehouse execution plan and explain guardrails", () => {
  const budgets: WarehousePlanBudgets = {
    maxScannedRows: 100_000,
    maxScannedBytes: 10 * 1024 * 1024,
    maxReturnedRows: 10_000,
    maxReturnedBytes: 8 * 1024 * 1024,
    maxTransferBytes: 8 * 1024 * 1024,
    maxEstimatedCost: 0.25,
    deadlineMs: 10_000,
    minFidelity: "exact",
    allowUnknownEstimates: false,
  };

  it("validates semantic intent explain requests and accepts within-budget server plans", () => {
    const caps = validateWarehouseSourceCapabilities(sampleCapabilities("databricks"));
    const intent: WarehouseSemanticIntent = {
      sourceId: caps.sourceId,
      governedQueryId: caps.governedQueryId,
      bbox: [-156.5, 20.89, -156.48, 20.92],
      h3: { resolution: 8 },
      preferredRepresentation: "geoarrow",
    };
    const request = buildWarehouseExplainRequest(caps, intent, budgets, { now: FIXED_NOW });
    expect(request.provider).toBe("databricks");
    const plan = validateWarehouseExecutionPlan(samplePlan("databricks"), caps);
    const accepted = acceptWarehouseExecutionPlan(plan, budgets);
    expect(accepted.bboxPushdown).toBe(true);
    expect(accepted.h3Pushdown).toBe(true);
  });

  it("refuses over-budget cost, unknown estimates, low fidelity, unredacted plans, and unbounded object materialization", () => {
    const caps = validateWarehouseSourceCapabilities(sampleCapabilities("snowflake"));

    expect(() =>
      validateWarehouseExecutionPlan({ ...samplePlan("snowflake"), parameterRedacted: false }, caps),
    ).toThrow(HonuaWarehouseError);

    const expensive = validateWarehouseExecutionPlan(
      samplePlan("snowflake", {
        estimates: { ...samplePlan("snowflake").estimates, estimatedCost: 4.5, scannedBytes: 500 * 1024 * 1024 },
      }),
      caps,
    );
    const expensiveDecision = evaluateWarehouseExecutionPlan(expensive, budgets);
    expect(expensiveDecision.accepted).toBe(false);
    expect(expensiveDecision.violations.map((v) => v.code)).toEqual(
      expect.arrayContaining(["cost-budget-exceeded", "scanned-bytes-exceeded"]),
    );
    expect(() => acceptWarehouseExecutionPlan(expensive, budgets)).toThrow(HonuaWarehouseError);

    const unknown = validateWarehouseExecutionPlan(
      samplePlan("snowflake", {
        estimates: { ...samplePlan("snowflake").estimates, estimatedCost: null, confidence: "unknown" },
      }),
      caps,
    );
    expect(evaluateWarehouseExecutionPlan(unknown, budgets).violations.map((v) => v.code)).toContain(
      "unknown-estimate-refused",
    );

    const lossy = validateWarehouseExecutionPlan(
      samplePlan("snowflake", {
        fidelity: { level: "lossy", losses: [{ code: "simplify", reason: "tolerance applied" }] },
      }),
      caps,
    );
    expect(evaluateWarehouseExecutionPlan(lossy, budgets).violations.map((v) => v.code)).toContain(
      "fidelity-below-minimum",
    );

    const unboundedObjects = validateWarehouseExecutionPlan(
      samplePlan("snowflake", {
        representation: "objects",
        outputFormat: "format.geojson",
        estimates: { ...samplePlan("snowflake").estimates, returnedRows: 25_000 },
      }),
      caps,
    );
    expect(
      evaluateWarehouseExecutionPlan(unboundedObjects, { maxObjectMaterializationRows: 1_000 }).violations.map(
        (v) => v.code,
      ),
    ).toContain("object-materialization-unbounded");
  });

  it("reconciles observed execution metrics against accepted plans", () => {
    const plan = acceptWarehouseExecutionPlan(validateWarehouseExecutionPlan(samplePlan("duckdb")), budgets);
    expect(
      reconcileWarehouseExecutionMetrics(plan, {
        scannedRows: 25_000,
        scannedBytes: 2 * 1024 * 1024,
        returnedRows: 4,
        returnedBytes: 4_096,
        transferBytes: 4_096,
        elapsedMs: 120,
        cost: 0.04,
      }).status,
    ).toBe("within-budget");

    expect(
      reconcileWarehouseExecutionMetrics(plan, {
        scannedRows: 75_000,
        returnedRows: 4,
        returnedBytes: 4_096,
        transferBytes: 4_096,
        elapsedMs: 120,
      }).status,
    ).toBe("divergent");

    expect(
      reconcileWarehouseExecutionMetrics(plan, {
        scannedRows: 250_000,
        returnedRows: 4,
        returnedBytes: 4_096,
        transferBytes: 4_096,
        elapsedMs: 120,
      }).status,
    ).toBe("budget-exceeded");
  });
});

describe("bounded Arrow/GeoArrow streaming and renderer handoff", () => {
  it("streams bounded batches, enforces budgets, handles AbortSignal, detects schema drift, and hands off to deck.gl/MapLibre", async () => {
    const plan = acceptWarehouseExecutionPlan(validateWarehouseExecutionPlan(samplePlan("redshift")), {
      maxReturnedRows: 10,
      maxTransferBytes: 64 * 1024,
      maxObjectMaterializationRows: 4,
    });

    const receipt = await collectWarehouseColumnarStream(plan, async function* () {
      yield { batch: samplePointBatch(plan, 0), transferBytes: 512 };
      yield { batch: samplePointBatch(plan, 1), transferBytes: 512 };
    });
    expect(receipt.totals).toMatchObject({ batches: 2, rows: 4, transferBytes: 1_024 });
    expect(receipt.reconciliation.status).toBe("within-budget");
    const batchBytes = receipt.batches[0]!.metrics.backingBytes;
    expect(receipt.reconciliation.observed.returnedBytes).toBe(2 * batchBytes);

    const twoBatches = async function* () {
      yield { batch: samplePointBatch(plan, 0), transferBytes: 512 };
      yield { batch: samplePointBatch(plan, 1), transferBytes: 512 };
    };
    await expect(
      collectWarehouseColumnarStream(plan, twoBatches, {
        budgets: { maxBackingBytes: batchBytes },
      }),
    ).rejects.toThrow("Collected backing bytes");
    const acceptedByteLimit = { ...plan, budgets: { ...plan.budgets, maxReturnedBytes: batchBytes } };
    await expect(collectWarehouseColumnarStream(acceptedByteLimit, twoBatches)).rejects.toThrow("Returned bytes");

    const deckGl = handoffWarehouseBatchToDeckGl(receipt.batches[0]!.batch, {
      layerId: "redshift-points",
      geometry: "point",
    });
    expect(deckGl.metrics.copiedBytes).toBe(0);
    expect(deckGl.metrics.geoJsonFeaturesMaterialized).toBe(0);

    const maplibre = handoffWarehouseBatchToMapLibre(receipt.batches[0]!.batch, plan);
    expect(maplibre.geojson.features).toHaveLength(2);
    expect(() => handoffWarehouseBatchToMapLibre(receipt.batches[0]!.batch, plan, { maxFeatures: 1 })).toThrow(
      HonuaWarehouseError,
    );

    // Mid-stream budget refusal
    await expect(
      collectWarehouseColumnarStream(
        plan,
        async function* () {
          yield { batch: samplePointBatch(plan, 0), transferBytes: 512 };
          yield { batch: samplePointBatch(plan, 1), transferBytes: 512 };
        },
        { budgets: { maxRows: 3 } },
      ),
    ).rejects.toMatchObject({ code: "budget-exceeded" });

    // Mid-stream AbortSignal cancellation
    const controller = new AbortController();
    let yielded = 0;
    const consume = async () => {
      for await (const _item of executeWarehouseColumnarStream(
        plan,
        async function* ({ signal }) {
          yield { batch: samplePointBatch(plan, 0), transferBytes: 512 };
          controller.abort();
          if (signal.aborted) return;
          yield { batch: samplePointBatch(plan, 1), transferBytes: 512 };
        },
        { signal: controller.signal },
      )) {
        yielded += 1;
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(HonuaAbortError);
    expect(yielded).toBe(1);

    // Mid-stream schema drift
    const baseDrifted = samplePointBatch(plan, 1);
    const drifted = {
      ...baseDrifted,
      schema: { ...baseDrifted.schema, id: "schema-v2" },
      identity: { ...baseDrifted.identity!, schemaVersion: "schema-v2" },
    };
    await expect(
      collectWarehouseColumnarStream(plan, async function* () {
        yield { batch: samplePointBatch(plan, 0), transferBytes: 512 };
        yield { batch: drifted, transferBytes: 512 };
      }),
    ).rejects.toMatchObject({ code: "schema-drift" });
  });
});

describe("cross-warehouse conformance across Redshift, Snowflake, Databricks, and DuckDB", () => {
  it.each(GOVERNED_WAREHOUSE_PROVIDERS)("passes the provider-neutral conformance suite on %s", async (provider) => {
    const capabilities = sampleCapabilities(provider);
    const plan = samplePlan(provider);
    const overBudgetPlan = samplePlan(provider, {
      estimates: { ...plan.estimates, estimatedCost: 99.99 },
    });
    const report = await runWarehouseProviderConformance({
      provider,
      capabilities,
      intent: {
        sourceId: capabilities.sourceId,
        governedQueryId: capabilities.governedQueryId,
        bbox: [-156.5, 20.89, -156.48, 20.92],
        h3: { resolution: 8 },
        preferredRepresentation: "geoarrow",
      },
      budgets: {
        maxScannedRows: 100_000,
        maxScannedBytes: 10 * 1024 * 1024,
        maxReturnedRows: 1_000,
        maxTransferBytes: 1024 * 1024,
        maxEstimatedCost: 0.5,
        deadlineMs: 10_000,
        minFidelity: "exact",
      },
      plan,
      overBudgetPlan,
      queryTransport: stubQueryTransport(),
      streamTransport: async function* ({ plan: activePlan }) {
        yield { batch: samplePointBatch(activePlan, 0), transferBytes: 512 };
      },
      deckGlGeometry: "point",
      now: FIXED_NOW,
    });

    expect(report.passed).toBe(true);
    expect(report.provider).toBe(provider);
    expect(report.supportedFormats).toEqual(["format.geoparquet", "format.geoarrow"]);
    expect(report.checks.every((check) => check.passed)).toBe(true);
  });
});
