import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { connect } from "../src/connect.js";
import type { SourceDescriptor } from "../src/contract/types.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../src/contract/types.js";
import type { DuckDbDriver, DuckRow } from "../src/geoparquet/driver.js";
import { createBrowserDuckDbDriver } from "../src/geoparquet/driver.js";
import { GeoparquetRuntime, geoparquetSource } from "../src/geoparquet/index.js";
import { buildSourceProfile } from "../src/geoparquet/metadata.js";

const URL = "encoding-truth.parquet";

function geometryMetadata(
  version: string,
  encoding: string,
  geometryTypes: readonly string[],
): Record<string, unknown> {
  return {
    version,
    primary_column: "geometry",
    columns: { geometry: { encoding, geometry_types: geometryTypes } },
  };
}

function descriptor(): SourceDescriptor {
  return {
    id: "encoding-truth",
    protocol: "geoparquet",
    locator: { url: URL },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
  };
}

function fakeDriver(options: {
  readonly describe: readonly DuckRow[];
  readonly geo: Record<string, unknown>;
  readonly spatialExtension?: boolean;
}): { readonly driver: DuckDbDriver; readonly scans: string[] } {
  const scans: string[] = [];
  const driver: DuckDbDriver = {
    geometryCapabilities: { spatialExtension: options.spatialExtension !== false },
    async run() {},
    async query(sql) {
      if (sql.startsWith("DESCRIBE")) return [...options.describe];
      if (sql.includes("parquet_kv_metadata")) {
        return [{ file_name: URL, value: JSON.stringify(options.geo) }];
      }
      if (sql.includes("parquet_file_metadata")) return [{ row_estimate: 1 }];
      scans.push(sql);
      return [];
    },
    async registerFileBuffer() {},
    async close() {},
  };
  return { driver, scans };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    return error;
  }
}

describe("GeoParquet descriptive and executable geometry truth", () => {
  it("keeps versioned WKB identity separate from the representation DuckDB delivered", () => {
    const v10Blob = buildSourceProfile({
      describe: [{ column_name: "geometry", column_type: "BLOB" }],
      geoJson: JSON.stringify(geometryMetadata("1.0.0", "WKB", ["Point"])),
      geometryRuntime: { spatialExtension: true },
    });
    const v11Rehydrated = buildSourceProfile({
      describe: [{ column_name: "geometry", column_type: "GEOMETRY" }],
      geoJson: JSON.stringify(geometryMetadata("1.1.0", "WKB", ["Point"])),
      geometryRuntime: { spatialExtension: true },
    });

    expect(v10Blob.geometry).toMatchObject({
      encoding: "geoparquet-1.0-wkb",
      execution: "wkb",
      specVersion: "1.0.0",
      coordinateOrder: "xy",
    });
    expect(v11Rehydrated.geometry).toMatchObject({
      encoding: "geoparquet-1.1-wkb",
      execution: "duckdb-native",
      specVersion: "1.1.0",
      coordinateOrder: "xy",
    });
  });

  it("preserves physical geometry-column order, deterministic primary selection, CRS, epoch, order, and covering", () => {
    const bboxType = "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)";
    const profile = buildSourceProfile({
      describe: [
        { column_name: "secondary", column_type: "BLOB", null: "YES" },
        { column_name: "secondary_bbox", column_type: bboxType, null: "YES" },
        { column_name: "primary", column_type: "GEOMETRY", null: "YES" },
        { column_name: "primary_bbox", column_type: bboxType, null: "YES" },
        { column_name: "name", column_type: "VARCHAR", null: "NO" },
      ],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "primary",
        columns: {
          primary: {
            encoding: "WKB",
            geometry_types: ["Point Z"],
            crs: { id: { authority: "EPSG", code: 4979 } },
            epoch: 2024.25,
            covering: {
              bbox: {
                xmin: ["primary_bbox", "xmin"],
                ymin: ["primary_bbox", "ymin"],
                xmax: ["primary_bbox", "xmax"],
                ymax: ["primary_bbox", "ymax"],
              },
            },
          },
          secondary: {
            encoding: "WKB",
            geometry_types: ["Polygon"],
            crs: null,
            epoch: 2019.5,
            covering: {
              bbox: {
                xmin: ["secondary_bbox", "xmin"],
                ymin: ["secondary_bbox", "ymin"],
                xmax: ["secondary_bbox", "xmax"],
                ymax: ["secondary_bbox", "ymax"],
              },
            },
          },
        },
      }),
      geometryRuntime: { spatialExtension: true },
    });

    expect(profile.geometries?.map((geometry) => geometry.column)).toEqual(["secondary", "primary"]);
    expect(profile.geometry?.column).toBe("primary");
    expect(profile.geometries).toEqual([
      expect.objectContaining({
        column: "secondary",
        primary: false,
        encoding: "geoparquet-1.1-wkb",
        execution: "wkb",
        bboxColumn: "secondary_bbox",
        crsState: "null",
        coordinateEpoch: 2019.5,
        coordinateOrder: "xy",
      }),
      expect.objectContaining({
        column: "primary",
        primary: true,
        encoding: "geoparquet-1.1-wkb",
        execution: "duckdb-native",
        bboxColumn: "primary_bbox",
        crsState: "value",
        coordinateEpoch: 2024.25,
        coordinateOrder: "xy",
      }),
    ]);
  });

  it.each([
    ["version-unsupported", geometryMetadata("9.9.9-hostile", "WKB", ["Point"]), "BLOB"],
    ["encoding-unsupported", geometryMetadata("1.1.0", "future-secret-encoding", ["Point"]), "BLOB"],
    ["dimensions-unsupported", geometryMetadata("1.1.0", "WKB", ["Point ZM"]), "BLOB"],
  ] as const)("classifies hostile metadata as %s without making it executable", (reason, metadata, columnType) => {
    const profile = buildSourceProfile({
      describe: [{ column_name: "geometry", column_type: columnType }],
      geoJson: JSON.stringify(metadata),
      geometryRuntime: { spatialExtension: true },
    });
    expect(profile.geometry).toMatchObject({ metadataState: "invalid", unsupportedReason: reason });
    expect(profile.geometry?.execution).toBeUndefined();
  });

  it("keeps GeoParquet 1.1 native geometry descriptive-only until the dedicated decoder exists", () => {
    const profile = buildSourceProfile({
      describe: [{ column_name: "geometry", column_type: "STRUCT(x DOUBLE, y DOUBLE)" }],
      geoJson: JSON.stringify(geometryMetadata("1.1.0", "point", ["Point"])),
      geometryRuntime: { spatialExtension: true },
    });
    expect(profile.geometry).toMatchObject({
      encoding: "geoparquet-1.1-native-point",
      unsupportedReason: "native-decoder-unavailable",
    });
    expect(profile.geometry?.execution).toBeUndefined();
  });

  it("derives executable truth from the effective installed spatial runtime", () => {
    const unavailable = buildSourceProfile({
      describe: [{ column_name: "geometry", column_type: "BLOB" }],
      geoJson: JSON.stringify(geometryMetadata("1.1.0", "WKB", ["Point"])),
      geometryRuntime: { spatialExtension: false },
    });
    expect(unavailable.geometry).toMatchObject({
      encoding: "geoparquet-1.1-wkb",
      execution: "wkb",
      spatialRuntimeAvailable: false,
    });
    expect(unavailable.geometry?.unsupportedReason).toBeUndefined();
  });
});

describe("GeoParquet fail-closed execution boundaries", () => {
  it("retains every geometry column on a discovered locator in physical order", async () => {
    const profile = buildSourceProfile({
      describe: [
        { column_name: "secondary", column_type: "BLOB" },
        { column_name: "primary", column_type: "GEOMETRY" },
      ],
      geoJson: JSON.stringify({
        version: "1.1.0",
        primary_column: "primary",
        columns: {
          primary: { encoding: "WKB", geometry_types: ["Point"], epoch: 2023.5 },
          secondary: { encoding: "WKB", geometry_types: ["Polygon"], crs: null },
        },
      }),
      geometryRuntime: { spatialExtension: true },
    });
    const connection = await connect({
      endpoint: "https://fixtures.test/multiple.parquet",
      protocol: "geoparquet",
      authorizationScopeFingerprint: "anonymous",
      geoparquet: {
        profiler: {
          async profile() {
            return profile;
          },
        },
      },
    });

    const locator = connection.inspection.sources[0]?.descriptor.locator.geoparquet;
    expect(locator).toMatchObject({
      geometryColumn: "primary",
      geometryEncoding: "geoparquet-1.1-wkb",
      geometryExecution: "duckdb-native",
    });
    expect(locator?.geometries).toEqual([
      expect.objectContaining({
        column: "secondary",
        primary: false,
        execution: "wkb",
        crsState: "null",
        coordinateOrder: "xy",
      }),
      expect.objectContaining({
        column: "primary",
        primary: true,
        execution: "duckdb-native",
        coordinateEpoch: 2023.5,
        coordinateOrder: "xy",
      }),
    ]);
  });

  it("rejects unsupported metadata during discovery before advertising query capabilities", async () => {
    const profile = buildSourceProfile({
      describe: [{ column_name: "geometry", column_type: "BLOB" }],
      geoJson: JSON.stringify(geometryMetadata("44.0-hostile", "WKB", ["Point"])),
      geometryRuntime: { spatialExtension: true },
    });
    const error = await rejectionOf(
      connect({
        endpoint: "https://fixtures.test/future.parquet",
        protocol: "geoparquet",
        authorizationScopeFingerprint: "anonymous",
        geoparquet: {
          profiler: {
            async profile() {
              return profile;
            },
          },
        },
      }),
    );
    expect(error).toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-endpoint",
      context: { reason: "version-unsupported" },
    });
  });

  it("exposes native metadata through describe but rejects query before any data scan", async () => {
    const harness = fakeDriver({
      describe: [{ column_name: "geometry", column_type: "STRUCT(x DOUBLE, y DOUBLE)" }],
      geo: geometryMetadata("1.1.0", "point", ["Point"]),
    });
    const runtime = new GeoparquetRuntime({ driverFactory: async () => harness.driver });
    const source = geoparquetSource(descriptor(), { runtime });

    const description = await source.protocol("geoparquet")!.describe();
    expect(description).toMatchObject({
      geometryColumns: ["geometry"],
      geometryEncoding: "geoparquet-1.1-native-point",
      geometryUnsupportedReason: "native-decoder-unavailable",
    });
    const error = await rejectionOf(source.query());
    expect(error).toMatchObject({
      name: "HonuaCapabilityNotSupportedError",
      context: { reason: "native-decoder-unavailable" },
    });
    expect(harness.scans).toEqual([]);
    await runtime.dispose();
  });

  it("rejects unsupported versions before request construction and redacts hostile metadata", async () => {
    const secret = "future-version-secret-token";
    const harness = fakeDriver({
      describe: [{ column_name: "geometry", column_type: "GEOMETRY" }],
      geo: geometryMetadata(`9.9.9-${secret}`, "WKB", ["Point"]),
    });
    const runtime = new GeoparquetRuntime({ driverFactory: async () => harness.driver });
    const source = geoparquetSource(descriptor(), { runtime });

    const error = await rejectionOf(source.query({ returnGeometry: false }));
    expect(error).toMatchObject({
      name: "HonuaCapabilityNotSupportedError",
      context: { reason: "version-unsupported" },
    });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(harness.scans).toEqual([]);
    await runtime.dispose();
  });

  it("allows bbox-only attribute queries without spatial functions but blocks geometry projection", async () => {
    const harness = fakeDriver({
      describe: [
        { column_name: "geometry", column_type: "BLOB", null: "YES" },
        {
          column_name: "bbox",
          column_type: "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)",
          null: "YES",
        },
      ],
      geo: {
        version: "1.1.0",
        primary_column: "geometry",
        columns: {
          geometry: {
            encoding: "WKB",
            geometry_types: ["Point"],
            covering: {
              bbox: {
                xmin: ["bbox", "xmin"],
                ymin: ["bbox", "ymin"],
                xmax: ["bbox", "xmax"],
                ymax: ["bbox", "ymax"],
              },
            },
          },
        },
      },
      spatialExtension: false,
    });
    const runtime = new GeoparquetRuntime({ driverFactory: async () => harness.driver });
    const source = geoparquetSource(descriptor(), { runtime });
    const spatialFilter = {
      geometry: { xmin: -158, ymin: 20, xmax: -157, ymax: 21 },
      geometryType: "esriGeometryEnvelope" as const,
    };

    await source.query({ spatialFilter, returnGeometry: false });
    expect(harness.scans).toHaveLength(1);
    expect(harness.scans[0]).toContain('"bbox".xmin <= -157');
    expect(harness.scans[0]).not.toContain("ST_");

    const error = await rejectionOf(source.query({ spatialFilter }));
    expect(error).toMatchObject({
      name: "HonuaCapabilityNotSupportedError",
      context: { reason: "spatial-runtime-unavailable" },
    });
    expect(harness.scans).toHaveLength(1);
    await runtime.dispose();
  });

  it("tags and redacts an unavailable optional peer before worker or runtime creation", async () => {
    const secret = "optional-peer-loader-secret";
    const error = await rejectionOf(
      createBrowserDuckDbDriver({
        moduleLoader: async () => {
          throw new Error(secret);
        },
      }),
    );
    expect(error).toMatchObject({
      name: "HonuaCapabilityNotSupportedError",
      context: { reason: "runtime-peer-unavailable" },
    });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("maps optional-peer failure to stable discovery truth", async () => {
    const secret = "discovery-peer-secret";
    const error = await rejectionOf(
      connect({
        endpoint: "https://fixtures.test/peer-missing.parquet",
        protocol: "geoparquet",
        authorizationScopeFingerprint: "anonymous",
        geoparquet: {
          profiler: {
            async profile() {
              await createBrowserDuckDbDriver({
                moduleLoader: async () => {
                  throw new Error(secret);
                },
              });
              throw new Error("unreachable");
            },
          },
        },
      }),
    );
    expect(error).toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-endpoint",
      context: { reason: "runtime-peer-unavailable" },
    });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});

describe("GeoParquet optional-peer graph boundary", () => {
  it("keeps duckdb-wasm out of root, contract, and discovery static imports", () => {
    const root = process.cwd();
    const files = [
      path.join(root, "src", "index.ts"),
      path.join(root, "src", "honua.ts"),
      path.join(root, "src", "connect.ts"),
      path.join(root, "src", "connect-geoparquet.ts"),
      ...typescriptFiles(path.join(root, "src", "contract")),
    ];
    const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    expect(source).not.toMatch(/(?:\bfrom\s*|\bimport\s*)["']@duckdb\/duckdb-wasm/);

    const driver = fs.readFileSync(path.join(root, "src", "geoparquet", "driver.ts"), "utf8");
    expect(driver).toContain('import("@duckdb/duckdb-wasm")');
    expect(driver).not.toMatch(/\bfrom\s*["']@duckdb\/duckdb-wasm/);
  });
});

function typescriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...typescriptFiles(candidate));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(candidate);
  }
  return files;
}
