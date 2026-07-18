// Reader-side server<->SDK GeoParquet interop conformance (honua-io/honua-sdk-js#630).
//
// honua-server's GeoParquetFeatureWriter (Honua.Hosting.Services) is the
// authoritative GeoParquet 1.1.0 writer shared by every protocol adapter that
// exports cloud-native Parquet (GeoServices `f=parquet`, OData
// `$format=parquet`); its server-side conformance lane proves that output
// validates against the GeoParquet 1.1.0 / PROJJSON v0.7 JSON Schemas and
// round-trips through geopandas/pyarrow/pyproj (honua-io/honua-server#2845,
// part of #2842). This suite locks the other half of that contract: that the
// SDK's `@honua/sdk-js/geoparquet` reader consumes exactly what that writer
// emits.
//
// The fixture (`test/fixtures/geoparquet/server-interop/`) is not produced by
// invoking the .NET writer directly (no honua-server checkout/runtime is
// available here); it is built to reproduce that writer's documented,
// byte-level `geo` metadata contract exactly -- including a `crs` PROJJSON
// value vendored verbatim from the server's own embedded
// `GeoParquetProjJsonCatalog` -- so this suite is exercising the real reader
// path (`GeoparquetRuntime.profile` -> `buildSourceProfile` ->
// `compileQuery`/`compileAggregate`) against a faithful reproduction of the
// server's on-the-wire shape. See `generate.mjs` in that directory for the
// exact provenance of every metadata field.
//
// Hermetic: fixtures are committed, no live server or network is used.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SourceDescriptor } from "../src/contract/types.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../src/contract/types.js";
import { geoMetadataSql } from "../src/core/geoparquet-sql.js";
import { envelope } from "../src/core/spatial-filter.js";
import { GeoparquetRuntime, compileQuery, geoparquetSource } from "../src/geoparquet/index.js";
// @ts-expect-error — .mjs test helper (no type declarations, excluded from tsc)
import { createNodeDuckDbDriver } from "./helpers/geoparquet-node-driver.mjs";

const SERVER_URL = "places-server-geoparquet.parquet";

interface GoldenFeature {
  readonly attributes: {
    readonly id: string;
    readonly name: string;
    readonly category: string;
    readonly population: number;
  };
  readonly geometry: { readonly type: string; readonly coordinates: readonly number[] };
}

interface Golden {
  readonly version: string;
  readonly primaryColumn: string;
  readonly encoding: string;
  readonly crs: string;
  readonly geometryTypes: readonly string[];
  readonly bboxColumn: string;
  readonly features: readonly GoldenFeature[];
}

function fixturePath(name: string): URL {
  return new URL(`./fixtures/geoparquet/server-interop/${name}`, import.meta.url);
}

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(fixturePath(name))));
}

const golden: Golden = JSON.parse(readFileSync(fileURLToPath(fixturePath("places-server-golden.json")), "utf8"));
const goldenById = new Map(golden.features.map((f) => [f.attributes.id, f]));

function descriptor(id: string): SourceDescriptor {
  return {
    id,
    protocol: "geoparquet",
    locator: { url: SERVER_URL },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
  };
}

describe("GeoParquet reader-side server<->SDK interop conformance", () => {
  let runtime: GeoparquetRuntime;

  beforeAll(async () => {
    runtime = new GeoparquetRuntime({ driverFactory: createNodeDuckDbDriver });
    await runtime.registerFileBuffer(SERVER_URL, fixtureBytes("places-server-geoparquet.parquet"));
  }, 60_000);

  afterAll(async () => {
    await runtime.dispose();
  });

  describe("raw `geo` key-value metadata (independent of the SDK parser)", () => {
    it("declares version 1.1.0, primary_column geometry, and WKB encoding — the server's writer contract", async () => {
      const rows = await runtime.query(geoMetadataSql([SERVER_URL]));
      const rawValue = rows[0]?.value;
      const geoText = typeof rawValue === "string" ? rawValue : new TextDecoder().decode(rawValue as Uint8Array);
      const geo = JSON.parse(geoText);
      expect(geo.version).toBe("1.1.0");
      expect(geo.primary_column).toBe("geometry");
      expect(geo.columns.geometry.encoding).toBe("WKB");
      expect(geo.columns.geometry.geometry_types).toEqual(golden.geometryTypes);
      // The non-4326 CRS is carried as PROJJSON with an authoritative EPSG id,
      // not a bare string — this is what the SDK's crs resolver must parse.
      expect(geo.columns.geometry.crs.id).toEqual({ authority: "EPSG", code: 32604 });
      // GeoParquet 1.1 covering: bbox struct column mapped for row-group pruning.
      expect(geo.columns.geometry.covering.bbox).toEqual({
        xmin: ["bbox", "xmin"],
        ymin: ["bbox", "ymin"],
        xmax: ["bbox", "xmax"],
        ymax: ["bbox", "ymax"],
      });
    });
  });

  describe("SDK metadata reader (GeoparquetRuntime.profile -> buildSourceProfile)", () => {
    it("resolves the geometry plan, CRS EPSG code, and bbox covering column from the server's geo metadata", async () => {
      const profile = await runtime.profile([SERVER_URL]);
      expect(profile.geometry).toBeDefined();
      expect(profile.geometry?.column).toBe("geometry");
      // GeoParquet metadata parsed and validated against the bounded 1.0/1.1
      // projection this normalizer accepts (see src/geoparquet/metadata.ts).
      expect(profile.geometry?.metadataState).toBe("valid");
      expect(profile.geometry?.geometryTypesState).toBe("valid");
      expect(profile.geometry?.geometryTypes).toEqual(golden.geometryTypes);
      // CRS PROJJSON resolves to the expected EPSG code (not left as an opaque blob).
      expect(profile.geometry?.crsState).toBe("value");
      expect(profile.crs).toBe(golden.crs);
      // The declared covering maps onto the physical `bbox` struct column, so
      // spatial predicates can be pushed onto it instead of decoding geometry.
      expect(profile.geometry?.bboxColumn).toBe(golden.bboxColumn);
      expect(profile.rowEstimate).toBe(golden.features.length);
    });

    it("describe() surfaces the same CRS and geometry column through the public escape hatch", async () => {
      const source = geoparquetSource(descriptor("describe"), { runtime });
      const handle = source.protocol("geoparquet");
      const description = await handle!.describe();
      expect(description.geometryColumns).toEqual(["geometry"]);
      expect(description.crs).toBe(golden.crs);
      expect(description.rowEstimate).toBe(golden.features.length);
      expect(description.schema.map((f) => f.name)).toEqual(
        expect.arrayContaining(["id", "name", "category", "population"]),
      );
    });
  });

  describe("fidelity: decoded features match the golden GeoJSON reference view", () => {
    it("decodes all features with attributes and geometry matching the golden reference, coordinates in (x, y[, z]) order", async () => {
      const source = geoparquetSource(descriptor("fidelity"), { runtime });
      const result = await source.query({});
      expect(result.features).toHaveLength(golden.features.length);

      for (const feature of result.features) {
        const id = (feature.attributes as { id: string }).id;
        const expected = goldenById.get(id);
        expect(expected, `unexpected feature id ${id}`).toBeDefined();
        expect(feature.attributes).toEqual(expected?.attributes);

        const geometry = feature.geometry as { type: string; coordinates: readonly number[] };
        expect(geometry.type).toBe(expected?.geometry.type);
        // Coordinate order is (x, y[, z]) — the GeoParquet/WKB axis order,
        // which the reader preserves verbatim rather than reprojecting or
        // reordering for the CRS's own authority-defined (lat, lon) axes.
        expect(geometry.coordinates).toEqual(expected?.geometry.coordinates);
      }
    });

    it("preserves XYZ for rows with an elevation and plain XY for the rest (geometry_types: Point / Point Z)", async () => {
      const source = geoparquetSource(descriptor("xyz"), { runtime });
      const result = await source.query({});
      const withZ = golden.features.filter((f) => f.geometry.coordinates.length === 3).map((f) => f.attributes.id);
      const withoutZ = golden.features.filter((f) => f.geometry.coordinates.length === 2).map((f) => f.attributes.id);
      expect(withZ.length).toBeGreaterThan(0);
      expect(withoutZ.length).toBeGreaterThan(0);

      for (const feature of result.features) {
        const id = (feature.attributes as { id: string }).id;
        const coords = (feature.geometry as { coordinates: readonly number[] }).coordinates;
        if (withZ.includes(id)) expect(coords).toHaveLength(3);
        else if (withoutZ.includes(id)) expect(coords).toHaveLength(2);
      }
    });
  });

  describe("covering.bbox spatial pruning", () => {
    // A tight envelope, in the file's native projected (EPSG:32604) coordinate
    // space, that covers exactly "Ala Moana Center" and "Waikiki Beach" and
    // excludes the other 6 places (verified against the golden coordinates).
    const TIGHT_ENVELOPE = envelope(619_000, 2_352_500, 622_500, 2_355_500);

    it("compiles the spatial predicate against the covering bbox column, not decoded geometry (row-group-prunable)", async () => {
      const profile = await runtime.profile([SERVER_URL]);
      const compiled = compileQuery(
        { spatialFilter: TIGHT_ENVELOPE },
        {
          sources: [SERVER_URL],
          geometryAlias: "__geometry_geojson",
          geometry: profile.geometry,
          columns: profile.columns,
        },
      );
      // Matches the form asserted in test/geoparquet-sql.test.ts as
      // "(row-group prune)": a comparison against the bbox struct's own
      // fields, which DuckDB's Parquet scan can satisfy from column
      // statistics without decoding any WKB geometry.
      expect(compiled.sql).toContain('"bbox".xmin');
      expect(compiled.sql).toContain('"bbox".xmax');
      expect(compiled.sql).toContain('"bbox".ymin');
      expect(compiled.sql).toContain('"bbox".ymax');
      expect(compiled.sql).not.toContain("ST_Intersects");
      expect(compiled.sql).not.toContain("ST_GeomFromWKB");
      // An exact envelope filter is never approximated.
      expect(compiled.bboxApproximated).toBe(false);
    });

    it("returns exactly the intersecting features with no degradation", async () => {
      const source = geoparquetSource(descriptor("pruned"), { runtime });
      const result = await source.query({ spatialFilter: TIGHT_ENVELOPE });
      expect(result.degraded).toBeUndefined();
      const ids = result.features.map((f) => (f.attributes as { id: string }).id).sort();
      expect(ids).toEqual(["08f2a3c1d4e5f603", "08f2a3c1d4e5f604"]); // Ala Moana Center, Waikiki Beach
      expect(result.features.length).toBeLessThan(golden.features.length);
    });
  });
});
