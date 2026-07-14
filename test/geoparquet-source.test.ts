import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDataset } from "../src/contract/source.js";
import { PROTOCOL_DEFAULT_CAPABILITIES, type Query, type SourceDescriptor } from "../src/contract/types.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import { envelope } from "../src/core/spatial-filter.js";
import { GeoparquetRuntime, geoparquetResolver, geoparquetSource } from "../src/geoparquet/index.js";
// @ts-expect-error — .mjs test helper (no type declarations, excluded from tsc)
import { createNodeDuckDbDriver } from "./helpers/geoparquet-node-driver.mjs";

const GEOPARQUET_URL = "places-geoparquet.parquet";
const WKB_URL = "places-wkb-nometa.parquet";

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/geoparquet/${name}`, import.meta.url))));
}

async function makeRuntime(): Promise<GeoparquetRuntime> {
  const runtime = new GeoparquetRuntime({ driverFactory: createNodeDuckDbDriver });
  await runtime.registerFileBuffer(GEOPARQUET_URL, fixtureBytes("places-geoparquet.parquet"));
  await runtime.registerFileBuffer(WKB_URL, fixtureBytes("places-wkb-nometa.parquet"));
  return runtime;
}

function descriptor(id: string, url: string): SourceDescriptor {
  return {
    id,
    protocol: "geoparquet",
    locator: { url },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
  };
}

describe("geoparquet Source — real DuckDB-WASM against fixtures", () => {
  let runtime: GeoparquetRuntime;

  beforeAll(async () => {
    runtime = await makeRuntime();
  }, 60_000);

  afterAll(async () => {
    await runtime.dispose();
  });

  for (const [label, url] of [
    ["GeoParquet 1.1 metadata", GEOPARQUET_URL],
    ["Parquet-native WKB (no metadata)", WKB_URL],
  ] as const) {
    describe(label, () => {
      it("returns all 8 places with GeoJSON geometry and preserved GERS ids", async () => {
        const source = geoparquetSource(descriptor(`s-${url}`, url), { runtime });
        const result = await source.query({});
        expect(result.features).toHaveLength(8);
        const first = result.features.find((f) => (f.attributes as { name: string }).name === "Honolulu Hale");
        expect(first).toBeDefined();
        expect((first?.attributes as { id: string }).id).toBe("08f2a3c1d4e5f601");
        expect(first?.geometry).toMatchObject({ type: "Point" });
        // GERS ids preserved for every row.
        const ids = result.features.map((f) => (f.attributes as { id: string }).id);
        expect(ids.every((v) => /^08f2a3c1d4e5f60[1-8]$/.test(v))).toBe(true);
      });

      it("pushes a bbox spatial filter down (fewer rows, exact envelope)", async () => {
        const source = geoparquetSource(descriptor(`sf-${url}`, url), { runtime });
        // A tight envelope around Waikiki / Diamond Head / UH / Ala Moana.
        const result = await source.query({ spatialFilter: envelope(-157.86, 21.25, -157.8, 21.3) });
        expect(result.features.length).toBeGreaterThan(0);
        expect(result.features.length).toBeLessThan(8);
        expect(result.degraded).toBeUndefined();
        for (const f of result.features) {
          const [lon, lat] = (f.geometry as { coordinates: [number, number] }).coordinates;
          expect(lon).toBeGreaterThanOrEqual(-157.86);
          expect(lon).toBeLessThanOrEqual(-157.8);
          expect(lat).toBeGreaterThanOrEqual(21.25);
          expect(lat).toBeLessThanOrEqual(21.3);
        }
      });

      it("describe() surfaces schema and geometry and only defaults CRS from GeoParquet metadata", async () => {
        const source = geoparquetSource(descriptor(`d-${url}`, url), { runtime });
        const handle = source.protocol("geoparquet");
        expect(handle).toBeDefined();
        const description = await handle!.describe();
        expect(description.geometryColumns).toEqual(["geometry"]);
        expect(description.rowEstimate).toBe(8);
        expect(description.crs).toBe(url === GEOPARQUET_URL ? "OGC:CRS84" : undefined);
        expect(description.schema.map((f) => f.name)).toEqual(
          expect.arrayContaining(["id", "name", "category", "population"]),
        );
      });

      it("maps queryAggregate to GROUP BY", async () => {
        const source = geoparquetSource(descriptor(`a-${url}`, url), { runtime });
        const result = await source.queryAggregate({
          aggregation: {
            groupBy: ["category"],
            metrics: [{ fn: "count", field: "*", alias: "n" }],
          },
        });
        expect(result.features).toHaveLength(0);
        expect(result.aggregateRows).toBeDefined();
        const beach = result.aggregateRows?.find((r) => r.category === "beach");
        expect(beach?.n).toBe(2);
      });

      it("omits geometry when returnGeometry is false", async () => {
        const source = geoparquetSource(descriptor(`ng-${url}`, url), { runtime });
        const result = await source.query({ returnGeometry: false, pagination: { limit: 3 } });
        expect(result.features).toHaveLength(3);
        expect(result.features[0]?.geometry).toBeUndefined();
        expect(result.exceededTransferLimit).toBe(true);
      });
    });
  }

  it("produces an identical Result shape across both fixture styles", async () => {
    const geoparquet = geoparquetSource(descriptor("shape-geo", GEOPARQUET_URL), { runtime });
    const wkb = geoparquetSource(descriptor("shape-wkb", WKB_URL), { runtime });
    const a = await geoparquet.query({ outFields: ["id", "name"], orderBy: [{ field: "id" }] });
    const b = await wkb.query({ outFields: ["id", "name"], orderBy: [{ field: "id" }] });
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a.features.map((f) => f.attributes)).toEqual(b.features.map((f) => f.attributes));
    expect((a.features[0]?.geometry as { type?: string })?.type).toBe(
      (b.features[0]?.geometry as { type?: string })?.type,
    );
  });

  it("honestly refuses capabilities it does not support", async () => {
    const source = geoparquetSource(descriptor("miss", GEOPARQUET_URL), { runtime });
    await expect(source.queryExtent({})).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(source.queryObjectIds({})).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(source.applyEdits({ adds: [] })).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    await expect(source.queryRelated({ relationshipId: 0, sourceIds: [] })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
    await expect(source.attachments.list(1)).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
  });

  it("streams the relation as a single page", async () => {
    const source = geoparquetSource(descriptor("stream", GEOPARQUET_URL), { runtime });
    const pages: number[] = [];
    for await (const page of source.stream({})) pages.push(page.features.length);
    expect(pages).toEqual([8]);
  });
});

describe("geoparquet profile safety", () => {
  it("merges compatible per-file geometry types and bboxes across a partitioned relation", async () => {
    const runtime = new GeoparquetRuntime({
      driverFactory: async () => ({
        async run() {},
        async query(sql: string) {
          if (sql.startsWith("DESCRIBE")) {
            return [{ column_name: "geometry", column_type: "GEOMETRY", null: "YES" }];
          }
          if (sql.includes("parquet_kv_metadata")) {
            return [
              {
                file_name: "a.parquet",
                value: JSON.stringify({
                  version: "1.1.0",
                  primary_column: "geometry",
                  columns: { geometry: { encoding: "WKB", geometry_types: ["Point"], bbox: [0, 0, 1, 1] } },
                }),
              },
              {
                file_name: "b.parquet",
                value: JSON.stringify({
                  version: "1.1.0",
                  primary_column: "geometry",
                  columns: { geometry: { encoding: "WKB", geometry_types: ["Polygon"], bbox: [2, -1, 4, 3] } },
                }),
              },
            ];
          }
          return [{ row_estimate: 2 }];
        },
        async registerFileBuffer() {},
        async close() {},
      }),
    });

    const profile = await runtime.profile(["a.parquet", "b.parquet"]);
    expect(profile.geometry).toMatchObject({
      metadataState: "valid",
      geometryTypes: ["Point", "Polygon"],
    });
    await runtime.dispose();
  });

  it("rejects a malformed bbox even when another file omits bbox metadata", async () => {
    const runtime = new GeoparquetRuntime({
      driverFactory: async () => ({
        async run() {},
        async query(sql: string) {
          if (sql.startsWith("DESCRIBE")) {
            return [{ column_name: "geometry", column_type: "GEOMETRY", null: "YES" }];
          }
          if (sql.includes("parquet_kv_metadata")) {
            return [
              {
                file_name: "a.parquet",
                value: JSON.stringify({
                  version: "1.1.0",
                  primary_column: "geometry",
                  columns: { geometry: { encoding: "WKB", geometry_types: ["Point"], bbox: [0, 0, 1] } },
                }),
              },
              {
                file_name: "b.parquet",
                value: JSON.stringify({
                  version: "1.1.0",
                  primary_column: "geometry",
                  columns: { geometry: { encoding: "WKB", geometry_types: ["Point"] } },
                }),
              },
            ];
          }
          return [{ row_estimate: 2 }];
        },
        async registerFileBuffer() {},
        async close() {},
      }),
    });

    await expect(runtime.profile(["a.parquet", "b.parquet"])).rejects.toThrow(/invalid bbox/);
    await runtime.dispose();
  });

  it("rejects incompatible CRS metadata across a multi-file relation", async () => {
    const runtime = new GeoparquetRuntime({
      driverFactory: async () => ({
        async run() {},
        async query(sql: string) {
          if (sql.startsWith("DESCRIBE")) {
            return [{ column_name: "geometry", column_type: "GEOMETRY", null: "YES" }];
          }
          if (sql.includes("parquet_kv_metadata")) {
            return [
              {
                file_name: "a.parquet",
                value: JSON.stringify({
                  version: "1.1.0",
                  primary_column: "geometry",
                  columns: {
                    geometry: {
                      encoding: "WKB",
                      geometry_types: ["Point"],
                      crs: { id: { authority: "EPSG", code: 4326 } },
                    },
                  },
                }),
              },
              {
                file_name: "b.parquet",
                value: JSON.stringify({
                  version: "1.1.0",
                  primary_column: "geometry",
                  columns: {
                    geometry: {
                      encoding: "WKB",
                      geometry_types: ["Point"],
                      crs: { id: { authority: "EPSG", code: 3857 } },
                    },
                  },
                }),
              },
            ];
          }
          return [{ row_estimate: 2 }];
        },
        async registerFileBuffer() {},
        async close() {},
      }),
    });

    await expect(runtime.profile(["a.parquet", "b.parquet"])).rejects.toThrow(/incompatible metadata/);
    await runtime.dispose();
  });
});

describe("geoparquet via createDataset + geoparquetResolver", () => {
  it("resolves a geoparquet descriptor and shares one runtime", async () => {
    const runtime = new GeoparquetRuntime({ driverFactory: createNodeDuckDbDriver });
    await runtime.registerFileBuffer(GEOPARQUET_URL, fixtureBytes("places-geoparquet.parquet"));
    const resolver = geoparquetResolver({ runtime });
    const client = new HonuaClient({ baseUrl: "https://example.invalid" });
    const dataset = createDataset({
      id: "overture",
      client,
      capabilityPolicy: "degraded",
      skipCompatibilityCheck: true,
      resolveSource: resolver,
      sources: [descriptor("places", GEOPARQUET_URL)],
    });
    const places = dataset.source("places");
    expect(places).toBeDefined();

    // The SAME Query object shape used against a FeatureServer works here.
    const query: Query = {
      where: "category = 'beach'",
      outFields: ["id", "name", "category"],
      spatialFilter: envelope(-158.5, 21, -157.5, 21.7),
      returnGeometry: true,
    };
    const result = await places!.query(query);
    expect(result.features.length).toBeGreaterThan(0);
    for (const f of result.features) {
      expect((f.attributes as { category: string }).category).toBe("beach");
    }
    expect(resolver.runtime).toBe(runtime);
    await resolver.dispose();
  });
});
