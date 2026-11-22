import { describe, expect, it } from "vitest";

import type { Query, Result, Source } from "../src/contract/types.js";
import { HonuaAbortError } from "../src/core/errors.js";
import { publicFieldGuard } from "../src/export/guard.js";
import {
  type BboxParquetMetadata,
  HonuaPublicationError,
  PUBLICATION_LOOKUP_BUDGET,
  assertValidBbox,
  bboxOverlaps,
  pruneRowGroupsByBbox,
  rowMatchesBbox,
} from "../src/export/index.js";
import { type LookupContext, planBboxLookup, queryBboxWithinBudget } from "../src/export/lookup.js";
import type { Publication } from "../src/export/open.js";
import type { PublicationParquet } from "../src/export/parquet.js";

function encodeFloat64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return bytes;
}

function encodeFloat32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  return bytes;
}

function makeRowGroup(
  numRows: number,
  bbox: readonly [number, number, number, number] | undefined,
  options: { readonly compressedBytes?: number; readonly binaryStats?: "f32" | "f64" } = {},
) {
  const compressed = options.compressedBytes ?? 16_384;
  const encode = (value: number) =>
    options.binaryStats === "f64" ? encodeFloat64(value) : options.binaryStats === "f32" ? encodeFloat32(value) : value;

  const columns: Array<{
    readonly meta_data: {
      readonly path_in_schema: readonly string[];
      readonly total_compressed_size: number;
      readonly statistics?: { readonly min_value?: unknown; readonly max_value?: unknown };
    };
  }> = [
    { meta_data: { path_in_schema: ["tmk_txt"], total_compressed_size: compressed } },
    { meta_data: { path_in_schema: ["plat"], total_compressed_size: Math.floor(compressed / 2) } },
    { meta_data: { path_in_schema: ["geometry"], total_compressed_size: compressed * 2 } },
  ];

  if (bbox) {
    columns.push(
      {
        meta_data: {
          path_in_schema: ["bbox", "xmin"],
          total_compressed_size: 256,
          statistics: { min_value: encode(bbox[0]) },
        },
      },
      {
        meta_data: {
          path_in_schema: ["bbox", "ymin"],
          total_compressed_size: 256,
          statistics: { min_value: encode(bbox[1]) },
        },
      },
      {
        meta_data: {
          path_in_schema: ["bbox", "xmax"],
          total_compressed_size: 256,
          statistics: { max_value: encode(bbox[2]) },
        },
      },
      {
        meta_data: {
          path_in_schema: ["bbox", "ymax"],
          total_compressed_size: 256,
          statistics: { max_value: encode(bbox[3]) },
        },
      },
    );
  }
  return { num_rows: BigInt(numRows), columns };
}

function samplePublication(): Publication {
  return {
    url: "https://data.honua.example/exports/maui-parcels/v1/collection.json",
    id: "maui-parcels",
    geometry: { column: "geometry", encoding: "wkb", bboxColumn: "bbox" },
    queryArtifact: {
      url: "https://data.honua.example/exports/maui-parcels/v1/parcels.parquet",
      bytes: 8_000_000,
      fields: ["tmk_txt", "plat"],
    },
    stamp: { publicationId: "maui-parcels", version: "v1", captureId: "cap-1" },
    publicFields: [
      { name: "tmk_txt", type: "string" },
      { name: "plat", type: "string" },
    ],
    identity: { field: "tmk_txt", pmtilesProperty: "tmk_txt", geoparquetColumn: "tmk_txt" },
    freshness: {
      version: "v1",
      captureId: "cap-1",
      capturedAt: "2026-11-21T00:00:00Z",
      publishedAt: "2026-11-21T00:05:00Z",
      sourceRevision: "rev-1",
    },
    display: {
      pmtilesUrl: "https://data.honua.example/exports/maui-parcels/v1/parcels.pmtiles",
      sourceLayer: "parcels",
      promoteId: "tmk_txt",
      bounds: [-156.51, 20.89, -156.48, 20.92],
    },
    geoparquetUrl: "https://data.honua.example/exports/maui-parcels/v1/parcels.parquet",
  } as unknown as Publication;
}

describe("spatially-ordered GeoParquet bbox row-group pruning", () => {
  it("prunes non-overlapping row groups using GeoParquet 1.1 bbox min/max statistics", () => {
    const metadata: BboxParquetMetadata = {
      row_groups: [
        makeRowGroup(500, [-156.51, 20.89, -156.5, 20.9]),
        makeRowGroup(500, [-156.5, 20.9, -156.49, 20.91], { binaryStats: "f64" }),
        makeRowGroup(500, [-156.49, 20.91, -156.48, 20.92], { binaryStats: "f32" }),
      ],
    };

    const tight = pruneRowGroupsByBbox(
      metadata,
      "bbox",
      [-156.498, 20.902, -156.492, 20.908],
      ["tmk_txt", "plat", "geometry", "bbox"],
    );
    expect(tight.usedBboxStats).toBe(true);
    expect(tight.totalRowGroups).toBe(3);
    expect(tight.rowGroups).toEqual([1]);
    expect(tight.prunedRowGroups).toBe(2);
    expect(tight.ranges).toEqual([
      { index: 1, rowStart: 500, rowEnd: 1000, compressedBytes: 16_384 + 8_192 + 32_768 + 1_024 },
    ]);

    const disjoint = pruneRowGroupsByBbox(metadata, "bbox", [10, 10, 11, 11], ["tmk_txt", "geometry", "bbox"]);
    expect(disjoint.rowGroups).toEqual([]);
    expect(disjoint.prunedRowGroups).toBe(3);
    expect(disjoint.estimatedBytes).toBe(0);
  });

  it("retains groups and rows with nonfinite or inverted bbox bounds", () => {
    const query = [0, 0, 1, 1] as const;
    const result = pruneRowGroupsByBbox(
      {
        row_groups: [
          makeRowGroup(1, [Number.NaN, 0, 1, 1], { binaryStats: "f64" }),
          makeRowGroup(1, [0, Number.POSITIVE_INFINITY, 1, 1], { binaryStats: "f32" }),
          makeRowGroup(1, [5, 0, 4, 1]),
          makeRowGroup(1, [0, 5, 1, 4]),
        ],
      },
      "bbox",
      query,
      ["bbox"],
    );
    expect(result.rowGroups).toEqual([0, 1, 2, 3]);
    expect(result.usedBboxStats).toBe(false);
    expect(
      rowMatchesBbox({ bbox: { xmin: encodeFloat64(Number.NaN), ymin: 0, xmax: 1, ymax: 1 } }, "bbox", query),
    ).toBe(true);
    expect(rowMatchesBbox({ bbox: { xmin: 5, ymin: 0, xmax: 4, ymax: 1 } }, "bbox", query)).toBe(true);
  });

  it("conservatively retains row groups lacking bbox statistics and validates bbox geometry", () => {
    const metadata: BboxParquetMetadata = {
      row_groups: [makeRowGroup(100, [-156.51, 20.89, -156.5, 20.9]), makeRowGroup(100, undefined)],
    };
    const result = pruneRowGroupsByBbox(metadata, "bbox", [10, 10, 11, 11], ["tmk_txt"]);
    expect(result.usedBboxStats).toBe(true);
    expect(result.rowGroups).toEqual([1]);
    expect(result.prunedRowGroups).toBe(1);

    expect(bboxOverlaps([0, 0, 10, 10], [10, 10, 20, 20])).toBe(true);
    expect(bboxOverlaps([0, 0, 10, 10], [11, 11, 20, 20])).toBe(false);
    expect(() => assertValidBbox([10, 0, 5, 10])).toThrow(TypeError);
    expect(() => assertValidBbox([0, Number.NaN, 1, 1])).toThrow(TypeError);

    expect(
      rowMatchesBbox(
        { bbox: { xmin: -156.495, ymin: 20.903, xmax: -156.494, ymax: 20.904 } },
        "bbox",
        [-156.498, 20.902, -156.492, 20.908],
      ),
    ).toBe(true);
    expect(
      rowMatchesBbox(
        { bbox: { xmin: -156.51, ymin: 20.89, xmax: -156.505, ymax: 20.895 } },
        "bbox",
        [-156.498, 20.902, -156.492, 20.908],
      ),
    ).toBe(false);
  });
});

describe("browser GeoParquet bbox budget enforcement, field guard, and live server fallback", () => {
  it("answers within-budget bbox queries in the browser, strips non-public fields, and handles empty disjoint plans", async () => {
    const publication = samplePublication();
    let reads = 0;
    const parquet: PublicationParquet = {
      async verify() {},
      async prepareLookup() {
        throw new Error("not used");
      },
      async prepareBboxQuery<T>(bbox: readonly [number, number, number, number]) {
        const isDisjoint = bbox[0] > 0;
        const plan = Object.freeze({
          rowGroups: isDisjoint ? Object.freeze([]) : Object.freeze([1]),
          totalRowGroups: 4,
          prunedRowGroups: isDisjoint ? 4 : 3,
          footerBytes: 65_536,
          plannedBytes: isDisjoint ? 65_536 : 128_000,
          usedBboxStats: true,
        });
        return {
          plan,
          async read(): Promise<Result<T>> {
            if (plan.rowGroups.length === 0) return { features: [], exceededTransferLimit: false };
            reads += 1;
            return {
              features: [
                {
                  attributes: {
                    tmk_txt: "2-3-7-001",
                    plat: "030",
                    owner_ssn: "secret-should-be-stripped",
                  } as unknown as T,
                  geometry: { type: "Point", coordinates: [-156.495, 20.904] },
                },
              ],
              exceededTransferLimit: false,
            };
          },
        };
      },
    };

    const context: LookupContext = {
      publication,
      sourceId: "maui-parcels",
      parquet,
      guard: publicFieldGuard(publication, "maui-parcels"),
      budget: PUBLICATION_LOOKUP_BUDGET,
      serverSource: undefined,
    };

    const tightBbox = [-156.498, 20.902, -156.492, 20.908] as const;
    const plan = await planBboxLookup(context, tightBbox);
    expect(plan.usedBboxStats).toBe(true);
    expect(plan.prunedRowGroups).toBe(3);

    const answered = await queryBboxWithinBudget(context, tightBbox);
    expect(answered.answeredBy).toBe("geoparquet");
    expect(answered.result.features).toHaveLength(1);
    expect(answered.result.features[0]?.attributes).toEqual({ tmk_txt: "2-3-7-001", plat: "030" });
    expect(reads).toBe(1);

    const disjoint = await queryBboxWithinBudget(context, [10, 10, 11, 11]);
    expect(disjoint.plan.rowGroups).toEqual([]);
    expect(disjoint.result.features).toEqual([]);
    expect(reads).toBe(1);
  });

  it("refuses over-budget bbox queries without a server, falls back with DegradedReason when configured, and honors AbortSignal", async () => {
    const publication = samplePublication();
    const expensiveParquet: PublicationParquet = {
      async verify() {},
      async prepareLookup() {
        throw new Error("not used");
      },
      async prepareBboxQuery<T>() {
        return {
          plan: Object.freeze({
            rowGroups: Object.freeze([0, 1, 2, 3]),
            totalRowGroups: 4,
            prunedRowGroups: 0,
            footerBytes: 65_536,
            plannedBytes: 5_000_000,
            usedBboxStats: true,
          }),
          async read(): Promise<Result<T>> {
            throw new Error("read must not be invoked when plan exceeds byte budget");
          },
        };
      },
    };

    const baseContext: LookupContext = {
      publication,
      sourceId: "maui-parcels",
      parquet: expensiveParquet,
      guard: publicFieldGuard(publication, "maui-parcels"),
      budget: PUBLICATION_LOOKUP_BUDGET,
      serverSource: undefined,
    };

    const fullBbox = [-156.51, 20.89, -156.48, 20.92] as const;
    await expect(queryBboxWithinBudget(baseContext, fullBbox)).rejects.toBeInstanceOf(HonuaPublicationError);
    await expect(queryBboxWithinBudget(baseContext, fullBbox)).rejects.toMatchObject({
      code: "query-budget-exceeded",
    });

    const seenQueries: Query[] = [];
    const liveServer = {
      async query(query: Query): Promise<Result> {
        seenQueries.push(query);
        return {
          features: [
            {
              attributes: { tmk_txt: "2-3-7-001", plat: "030", landvalue: 999_999 },
              geometry: { type: "MultiPolygon", coordinates: [] },
            },
          ],
          exceededTransferLimit: false,
        };
      },
    } as unknown as Source;

    const withServer: LookupContext = { ...baseContext, serverSource: liveServer };
    const fallback = await queryBboxWithinBudget(withServer, fullBbox);
    expect(fallback.answeredBy).toBe("server");
    expect(fallback.limit?.kind).toBe("bytes");
    expect(fallback.result.degraded?.[0]?.reason).toContain("so the live service answered instead.");
    expect(fallback.result.features[0]?.attributes).toEqual({ tmk_txt: "2-3-7-001", plat: "030" });
    expect(seenQueries).toHaveLength(1);
    expect(seenQueries[0]?.spatialFilter).toBeDefined();

    // Cancelled bbox query fails immediately with HonuaAbortError
    await expect(queryBboxWithinBudget(withServer, fullBbox, { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
      HonuaAbortError,
    );
    expect(seenQueries).toHaveLength(1);
  });
});
