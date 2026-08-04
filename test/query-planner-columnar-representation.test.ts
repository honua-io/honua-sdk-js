import { describe, expect, it } from "vitest";

import type { SourceDescriptor } from "../src/contract/types.js";
import { capabilities } from "../src/contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import type { DuckDbDriver, DuckRow } from "../src/geoparquet/driver.js";
import {
  GeoParquetNativeGeometryError,
  GeoparquetRuntime,
  createGeoParquetNativeGeometryBatch,
  geoparquetSource,
} from "../src/geoparquet/index.js";
import {
  COLUMNAR_REPRESENTATION_MIN_BYTES,
  COLUMNAR_REPRESENTATION_MIN_ROWS,
  columnarBatchCacheKey,
  columnarBatchIdentityFromPlan,
  createColumnarBatchCache,
  createMemoryColumnarBatchCacheStorage,
  decodeGeoArrowBatch,
  executeQueryPlan,
  explainQuery,
  inspectGeoArrowBatch,
  parseQueryPlan,
  serializeQueryPlan,
} from "../src/query-planner/index.js";
import type { QueryExecutionPlanV1 } from "../src/query-planner/index.js";

const OBSERVED_AT = "2026-08-04T00:00:00.000Z";
const PLAN_CONTEXT = {
  authorizationScope: ["data:read"],
  schemaVersion: "parcels-schema-3",
  sourceVersion: "parcels-source-9",
} as const;

const LARGE = { rows: COLUMNAR_REPRESENTATION_MIN_ROWS } as const;

function expectGeoParquetCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GeoParquetNativeGeometryError);
    expect((error as GeoParquetNativeGeometryError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} to be thrown`);
}

function descriptor(
  encoding: "geoarrow-point" | "geoarrow-multipolygon" | "wkb" = "geoarrow-point",
  url = "points.parquet",
): SourceDescriptor {
  return {
    id: "parcels",
    protocol: "geoparquet",
    locator: {
      url,
      geoparquet: { geometryColumn: "geometry", geometryEncoding: encoding, nativeDimensions: "xy" },
    },
    capabilities: capabilities(["query", "queryAggregate"]),
  };
}

function plan(
  options: Partial<Parameters<typeof explainQuery<Record<string, unknown>>>[0]> = {},
): QueryExecutionPlanV1 {
  return explainQuery({ descriptor: descriptor(), ...PLAN_CONTEXT, ...options });
}

describe("planner result-representation selection", () => {
  it("selects columnar for a columnar-capable source with a large estimate, and names the decision inputs", () => {
    const selected = plan({ estimates: LARGE });
    expect(selected.representation).toEqual({
      version: "1.0",
      requested: "auto",
      selected: "columnar",
      available: ["object", "columnar"],
      reason: "workload-above-threshold",
      inputs: {
        geometryEncoding: "geoarrow-point",
        rowThreshold: COLUMNAR_REPRESENTATION_MIN_ROWS,
        byteThreshold: COLUMNAR_REPRESENTATION_MIN_BYTES,
        estimatedRows: COLUMNAR_REPRESENTATION_MIN_ROWS,
      },
    });
    expect(selected.validity.representation).toBe("columnar");
    // The columnar selection is not a warning: it is what the caller asked for.
    expect(selected.warnings).toEqual([]);
  });

  it("selects columnar on a byte estimate alone", () => {
    const selected = plan({ estimates: { bytes: COLUMNAR_REPRESENTATION_MIN_BYTES } });
    expect(selected.representation.selected).toBe("columnar");
    expect(selected.representation.inputs.estimatedBytes).toBe(COLUMNAR_REPRESENTATION_MIN_BYTES);
    expect(selected.representation.inputs.estimatedRows).toBeUndefined();
  });

  it("plans object execution for a small estimate and says why", () => {
    const small = plan({ estimates: { rows: COLUMNAR_REPRESENTATION_MIN_ROWS - 1 } });
    expect(small.representation).toMatchObject({
      selected: "object",
      available: ["object", "columnar"],
      reason: "workload-below-threshold",
    });
    expect(small.validity.representation).toBe("object");
    expect(small.warnings).toEqual([
      {
        code: "columnar-representation-declined",
        severity: "warning",
        path: "$.representation",
        message: "This source can serve columnar execution; object execution was selected (workload-below-threshold).",
        remediation:
          'Supply estimates that reach the plan\'s columnar thresholds, or pin representation: "columnar" to require it.',
      },
    ]);
  });

  it("plans object execution with no estimate rather than guessing", () => {
    expect(plan().representation).toMatchObject({ selected: "object", reason: "estimate-unavailable" });
  });

  it("plans object execution for a source without a columnar producer, and offers no columnar option", () => {
    const wkb = explainQuery({ descriptor: descriptor("wkb"), estimates: LARGE, ...PLAN_CONTEXT });
    expect(wkb.representation).toMatchObject({
      selected: "object",
      available: ["object"],
      reason: "encoding-not-columnar",
      inputs: { geometryEncoding: "wkb" },
    });
    // Nothing was declined, so nothing is warned about.
    expect(wkb.warnings).toEqual([]);
  });

  it("refuses multi-part geoarrow encodings rather than re-labelling their parts", () => {
    const multi = explainQuery({ descriptor: descriptor("geoarrow-multipolygon"), estimates: LARGE, ...PLAN_CONTEXT });
    expect(multi.representation).toMatchObject({ selected: "object", reason: "encoding-not-columnar" });
  });

  it("plans object execution for a non-geoparquet protocol", () => {
    const ogc = explainQuery({
      descriptor: {
        id: "collection",
        protocol: "ogc-features",
        locator: { url: "https://example.test/ogc", collectionId: "parcels" },
        capabilities: capabilities(["query"]),
      },
      estimates: LARGE,
      ...PLAN_CONTEXT,
    });
    expect(ogc.representation).toMatchObject({
      selected: "object",
      available: ["object"],
      reason: "protocol-not-columnar",
    });
    expect(ogc.representation.inputs.geometryEncoding).toBeUndefined();
  });

  it("plans object execution for an aggregate and for a geometry-free query", () => {
    const aggregate = plan({
      estimates: LARGE,
      query: { aggregation: { metrics: [{ fn: "count", field: "*" }] } },
    });
    expect(aggregate.representation).toMatchObject({ selected: "object", reason: "aggregation-not-columnar" });
    const noGeometry = plan({ estimates: LARGE, query: { returnGeometry: false } });
    expect(noGeometry.representation).toMatchObject({ selected: "object", reason: "geometry-not-requested" });
  });
});

describe("explicit representation pins", () => {
  it("honours an object pin over a qualifying workload", () => {
    const pinned = plan({ estimates: LARGE, representation: "object" });
    expect(pinned.representation).toMatchObject({ requested: "object", selected: "object", reason: "explicit-pin" });
    expect(pinned.validity.representation).toBe("object");
  });

  it("honours a columnar pin below the workload threshold", () => {
    const pinned = plan({ representation: "columnar" });
    expect(pinned.representation).toMatchObject({
      requested: "columnar",
      selected: "columnar",
      reason: "explicit-pin",
    });
  });

  it("fails closed on an unsatisfiable columnar pin instead of degrading to object results", () => {
    for (const unsatisfiable of [
      () => explainQuery({ descriptor: descriptor("wkb"), representation: "columnar", ...PLAN_CONTEXT }),
      () => plan({ representation: "columnar", query: { returnGeometry: false } }),
      () => plan({ representation: "columnar", query: { aggregation: { metrics: [{ fn: "count", field: "*" }] } } }),
    ]) {
      expect(unsatisfiable).toThrow(HonuaCapabilityNotSupportedError);
      expect(unsatisfiable).toThrow(/columnar-execution/);
    }
  });

  it("rejects an unknown representation request", () => {
    expect(() => plan({ representation: "tile" as never })).toThrow(/representation is invalid/);
  });
});

describe("representation participates in plan identity", () => {
  it("is deterministic and only moves the fingerprint when the strategy moves", () => {
    const first = plan({ estimates: LARGE });
    const second = plan({ estimates: LARGE });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.validity.fingerprint).toBe(second.validity.fingerprint);

    const pinnedSame = plan({ estimates: LARGE, representation: "columnar" });
    // Same selected strategy, different recorded request: the validity binding
    // covers the strategy, not the caller's phrasing of it.
    expect(pinnedSame.validity.fingerprint).toBe(first.validity.fingerprint);

    const objectPlan = plan({ estimates: LARGE, representation: "object" });
    expect(objectPlan.validity.fingerprint).not.toBe(first.validity.fingerprint);
    expect(objectPlan.fingerprint).not.toBe(first.fingerprint);
  });

  it("round-trips through persistence and rejects a tampered decision", () => {
    const columnar = plan({ estimates: LARGE });
    const serialized = serializeQueryPlan(columnar);
    expect(parseQueryPlan(serialized)).toEqual(columnar);

    for (const tamper of [
      (value: Record<string, unknown>) => {
        value.selected = "object";
      },
      (value: Record<string, unknown>) => {
        value.reason = "explicit-pin";
      },
      (value: Record<string, unknown>) => {
        value.available = ["object"];
      },
      (value: Record<string, unknown>) => {
        value.requested = "object";
      },
    ]) {
      const hostile = JSON.parse(serialized) as { representation: Record<string, unknown> };
      tamper(hostile.representation);
      expect(() => parseQueryPlan(JSON.stringify(hostile))).toThrow(/invalid or unsafe to persist/);
    }
  });

  it("refuses to run a columnar plan through the object executor", async () => {
    const columnar = plan({ estimates: LARGE });
    const source = {
      descriptor: descriptor(),
      capabilities: capabilities(["query", "queryAggregate"]),
      async query() {
        throw new Error("the object executor must never reach the source for a columnar plan");
      },
    };
    await expect(executeQueryPlan(columnar, source as never, PLAN_CONTEXT)).rejects.toThrow(
      /selected "columnar" execution/,
    );
  });
});

describe("plan-derived columnar batch identity", () => {
  it("derives every identity field from the plan", () => {
    const columnar = plan({ estimates: LARGE, query: { orderBy: [{ field: "id", direction: "desc" }] } });
    const identity = columnarBatchIdentityFromPlan(columnar, { observedAt: OBSERVED_AT, validator: 'W/"7"' });
    expect(identity).toEqual({
      sourceId: "parcels",
      sourceVersion: "parcels-source-9",
      schemaVersion: "parcels-schema-3",
      planId: columnar.validity.fingerprint,
      authorizationScope: columnar.provenance.authorizationScope.fingerprint,
      ordering: { stable: true, keys: [{ field: "id", direction: "descending", nulls: "last" }] },
      freshness: { observedAt: OBSERVED_AT, validator: 'W/"7"' },
    });
    // Never the raw scope, and never an invented plan identifier.
    expect(identity.authorizationScope).not.toContain("data:read");
    expect(identity.planId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("falls back to plan fingerprints when the source declares no versions", () => {
    const columnar = explainQuery({
      descriptor: descriptor(),
      estimates: LARGE,
      authorizationScope: ["data:read"],
    });
    const identity = columnarBatchIdentityFromPlan(columnar, { observedAt: OBSERVED_AT });
    expect(identity.sourceVersion).toBe(columnar.provenance.source.descriptorFingerprint);
    expect(identity.schemaVersion).toBe(columnar.validity.schemaFingerprint);
    expect(identity.ordering).toEqual({ stable: false, keys: [] });
  });

  it("refuses to mint a columnar identity from an object plan", () => {
    expect(() =>
      columnarBatchIdentityFromPlan(plan({ estimates: LARGE, representation: "object" }), {
        observedAt: OBSERVED_AT,
      }),
    ).toThrow(HonuaCapabilityNotSupportedError);
  });

  it("requires an execution-time observation instant", () => {
    expect(() => columnarBatchIdentityFromPlan(plan({ estimates: LARGE }), { observedAt: "" })).toThrow(
      /observedAt must be a non-empty string/,
    );
  });
});

describe("GeoParquet columnar batch production", () => {
  const POINTS = [{ x: 1, y: 2 }, null, { x: 3, y: 4 }] as const;

  it("hands back a batch instead of rows, carrying the plan's identity", () => {
    const columnar = plan({ estimates: LARGE });
    const identity = columnarBatchIdentityFromPlan(columnar, { observedAt: OBSERVED_AT });
    const created = createGeoParquetNativeGeometryBatch({
      kind: "point",
      dimensions: "xy",
      values: [...POINTS],
      identity,
      batchId: "parcels-0",
      sequence: 1,
    });
    expect(created.batch.kind).toBe("honua.columnar-batch");
    expect(created.batch.rowCount).toBe(3);
    expect(created.batch.identity).toEqual(identity);
    expect(created.batch.schema.id).toBe(identity.schemaVersion);
    // The buffers are the answer; no row object was produced to build them.
    expect(inspectGeoArrowBatch(created.batch).geometry.coordinates.x?.length).toBe(3);
    expect(decodeGeoArrowBatch(created.batch).rows.map((row) => row.geometry)).toEqual([[1, 2], null, [3, 4]]);
  });

  it("refuses a multi-part encoding rather than misreporting the geometry type", () => {
    const identity = columnarBatchIdentityFromPlan(plan({ estimates: LARGE }), { observedAt: OBSERVED_AT });
    expectGeoParquetCode(
      () =>
        createGeoParquetNativeGeometryBatch({
          kind: "multipolygon",
          dimensions: "xy",
          values: [],
          identity,
          batchId: "parcels-0",
          sequence: 1,
        }),
      "GEOPARQUET_COLUMNAR_UNSUPPORTED_ENCODING",
    );
  });

  it("refuses an ordering key the batch does not carry", () => {
    const ordered = plan({ estimates: LARGE, query: { orderBy: [{ field: "name", direction: "asc" }] } });
    const identity = columnarBatchIdentityFromPlan(ordered, { observedAt: OBSERVED_AT });
    expectGeoParquetCode(
      () =>
        createGeoParquetNativeGeometryBatch({
          kind: "point",
          dimensions: "xy",
          values: [...POINTS],
          identity,
          batchId: "parcels-0",
          sequence: 1,
        }),
      "GEOPARQUET_COLUMNAR_ORDERING_FIELD_UNAVAILABLE",
    );
  });

  it("is admissible to the persistent batch cache with no hand-written identity", async () => {
    const columnar = plan({ estimates: LARGE });
    const identity = columnarBatchIdentityFromPlan(columnar, { observedAt: OBSERVED_AT });
    const created = createGeoParquetNativeGeometryBatch({
      kind: "point",
      dimensions: "xy",
      values: [...POINTS],
      identity,
      batchId: "parcels-0",
      sequence: 1,
    });
    const storage = createMemoryColumnarBatchCacheStorage();
    const cache = createColumnarBatchCache(storage, { now: () => Date.parse(OBSERVED_AT) + 1_000 });
    const write = await cache.write(created.batch);
    expect(write.outcome).toBe("stored");
    expect(write.outcome === "stored" && write.record.planId).toBe(columnar.validity.fingerprint);
    expect((await cache.read(identity)).outcome).toBe("hit");

    // A different plan is a different entry, by construction.
    const other = plan({ estimates: LARGE, query: { pagination: { limit: 10 } } });
    expect(other.validity.fingerprint).not.toBe(columnar.validity.fingerprint);
    const otherIdentity = columnarBatchIdentityFromPlan(other, { observedAt: OBSERVED_AT });
    expect(await columnarBatchCacheKey(otherIdentity)).not.toBe(await columnarBatchCacheKey(identity));
    expect((await cache.read(otherIdentity)).outcome).toBe("miss");
  });
});

describe("GeoParquet source columnar execution", () => {
  const GEO_METADATA = JSON.stringify({
    version: "1.1.0",
    primary_column: "geometry",
    columns: { geometry: { encoding: "point", geometry_types: ["Point"] } },
  });

  function runtimeFor(rows: readonly DuckRow[], scans: string[] = []): GeoparquetRuntime {
    const driver: DuckDbDriver = {
      async run() {},
      async query(sql: string) {
        if (sql.startsWith("DESCRIBE")) {
          return [
            { column_name: "id", column_type: "BIGINT", null: "NO" },
            { column_name: "geometry", column_type: "STRUCT(x DOUBLE, y DOUBLE)", null: "YES" },
          ];
        }
        if (sql.includes("parquet_kv_metadata")) return [{ file_name: "points.parquet", value: GEO_METADATA }];
        if (sql.includes("parquet_file_metadata")) return [{ row_estimate: 3n }];
        scans.push(sql);
        return [...rows];
      },
      async registerFileBuffer() {},
      async close() {},
    };
    return new GeoparquetRuntime({ driverFactory: async () => driver });
  }

  const ROWS: readonly DuckRow[] = [
    { id: 1n, __geometry_geojson: { x: 1, y: 2 } },
    { id: 2n, __geometry_geojson: { x: 3, y: 4 } },
  ];

  it("returns a plan-identified batch and scans only the columns the batch carries", async () => {
    const scans: string[] = [];
    const runtime = runtimeFor(ROWS, scans);
    const source = geoparquetSource(descriptor(), { runtime });
    const columnar = plan({ estimates: LARGE });
    const identity = columnarBatchIdentityFromPlan(columnar, { observedAt: OBSERVED_AT });

    const produced = await source.protocol("geoparquet")!.queryColumnar({
      identity,
      batchId: "parcels-0",
      sequence: 1,
      featureIdColumn: "id",
    });

    expect(produced.rowCount).toBe(2);
    expect(produced.batch.identity?.planId).toBe(columnar.validity.fingerprint);
    expect(produced.metrics.rows).toBe(2);
    const inspected = inspectGeoArrowBatch(produced.batch);
    expect([...(inspected.geometry.coordinates.x ?? [])]).toEqual([1, 3]);
    expect([...(inspected.featureIds?.values ?? [])]).toEqual([1, 2]);
    expect(scans).toHaveLength(1);
    expect(scans[0]).toContain('"id"');
    expect(scans[0]).not.toContain("ST_AsGeoJSON");
    await runtime.dispose();
  });

  it("refuses instead of quietly returning objects when the encoding has no columnar producer", async () => {
    const runtime = new GeoparquetRuntime({
      driverFactory: async () => ({
        async run() {},
        async query(sql: string) {
          if (sql.startsWith("DESCRIBE")) return [{ column_name: "geometry", column_type: "BLOB", null: "YES" }];
          if (sql.includes("parquet_kv_metadata")) return [];
          if (sql.includes("parquet_file_metadata")) return [{ row_estimate: 1n }];
          return [];
        },
        async registerFileBuffer() {},
        async close() {},
      }),
    });
    const source = geoparquetSource(descriptor("wkb"), { runtime });
    const identity = columnarBatchIdentityFromPlan(plan({ estimates: LARGE }), { observedAt: OBSERVED_AT });
    await expect(
      source.protocol("geoparquet")!.queryColumnar({ identity, batchId: "parcels-0", sequence: 1 }),
    ).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await runtime.dispose();
  });

  it("refuses an aggregate or geometry-free columnar request", async () => {
    const runtime = runtimeFor(ROWS);
    const source = geoparquetSource(descriptor(), { runtime });
    const identity = columnarBatchIdentityFromPlan(plan({ estimates: LARGE }), { observedAt: OBSERVED_AT });
    const handle = source.protocol("geoparquet")!;
    await expect(
      handle.queryColumnar({
        identity,
        batchId: "parcels-0",
        sequence: 1,
        query: { aggregation: { metrics: [{ fn: "count", field: "*" }] } },
      }),
    ).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await expect(
      handle.queryColumnar({ identity, batchId: "parcels-0", sequence: 1, query: { returnGeometry: false } }),
    ).rejects.toThrow(HonuaCapabilityNotSupportedError);
    await runtime.dispose();
  });
});
