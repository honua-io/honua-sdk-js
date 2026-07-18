// Generator for the reader-side server<->SDK GeoParquet interop conformance
// fixture (honua-io/honua-sdk-js#630, honua-io/honua-server#2845 / #2842).
//
// honua-server's `Honua.Hosting.Services.GeoParquetFeatureWriter` is the
// authoritative GeoParquet 1.1.0 writer (GeoServices `f=parquet`, OData
// `$format=parquet`). This script does NOT invoke that .NET writer (no
// honua-server checkout / runtime is available in this repo); instead it
// reproduces its documented, byte-level output contract directly:
//
//   - `version` "1.1.0", `primary_column` "geometry", `encoding` "WKB"
//     (GeoParquetFeatureWriter.GeoParquetVersion / GeometryEncoding).
//   - `geometry_types` reflects whether ANY feature in the result carries a Z
//     ordinate ("Point Z" when so, even if individual rows are still encoded
//     as 2D WKB) -- see `BuildGeometryArray`'s `anyHasZ` flag and
//     `BuildGeoParquetMetadata`'s `geometryTypesPart`. This fixture mixes 2D
//     and 3D rows for exactly that reason: to exercise the "XY/XYZ" half of
//     honua-sdk-js#630's acceptance criteria against a realistic, non-4326
//     partial-Z result set.
//   - `crs` PROJJSON for a non-4326 output SRID is spliced in verbatim from
//     the server's embedded `GeoParquetProjJsonCatalog` (pyproj/PROJ
//     generated, see `scripts/geoparquet/generate-projjson-catalog.py` in
//     honua-server). `./epsg-32604.projjson.json` here is a byte-for-byte
//     vendored copy of that catalog's "32604" entry (EPSG:32604, WGS 84 / UTM
//     zone 4N -- Oahu's UTM zone), used because `TryGetProjJson` returns the
//     stored JSON's `GetRawText()` verbatim (see
//     `epsg-32604.provenance.json`).
//   - `covering.bbox` maps the per-row 2D envelope onto a `bbox` STRUCT<xmin
//     DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE> column declared last in
//     the schema (`BuildGeoParquetMetadata` / `CreateBboxStructType`).
//
// Geometry coordinates are produced with DuckDB's `spatial` extension
// `ST_Transform` (PROJ-backed, always_xy = true), the same PROJ stack that
// generated the vendored EPSG:32604 catalog entry, so a reader consuming this
// fixture is round-tripping through the same authoritative CRS definition and
// projection math the server contract relies on -- not a hand-rolled
// approximation.
//
// Regenerate with: node test/fixtures/geoparquet/server-interop/generate.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createNodeDuckDbDriver } from "../../../helpers/geoparquet-node-driver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_SRID = "EPSG:32604";
const CRS_PROJJSON = fs.readFileSync(path.join(HERE, "epsg-32604.projjson.json"), "utf8").trim();

// (gersId, name, category, population, lon, lat, elevationMetres|null)
// Same 8 Oahu "places" as ../generate.mjs, plus real-ish elevations on two
// landmark rows so the fixture carries a genuine partial-Z result set.
const PLACES = [
  ["08f2a3c1d4e5f601", "Honolulu Hale", "civic", 0, -157.8583, 21.3069, null],
  ["08f2a3c1d4e5f602", "Diamond Head", "landmark", 0, -157.8055, 21.2619, 232.0],
  ["08f2a3c1d4e5f603", "Ala Moana Center", "retail", 0, -157.8434, 21.2911, null],
  ["08f2a3c1d4e5f604", "Waikiki Beach", "beach", 0, -157.8261, 21.2762, null],
  ["08f2a3c1d4e5f605", "Pearl Harbor", "historic", 0, -157.9494, 21.3649, null],
  ["08f2a3c1d4e5f606", "University of Hawaii", "education", 20000, -157.8163, 21.2969, null],
  ["08f2a3c1d4e5f607", "Kailua Beach Park", "beach", 0, -157.7394, 21.3925, null],
  ["08f2a3c1d4e5f608", "Dole Plantation", "attraction", 0, -158.0372, 21.5254, 169.0],
];

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function valuesSql() {
  return PLACES.map(
    ([id, name, cat, pop, lon, lat, elevation]) =>
      `(${sqlString(id)}, ${sqlString(name)}, ${sqlString(cat)}, ${pop}, ${lon}, ${lat}, ${
        elevation === null ? "NULL::DOUBLE" : elevation
      })`,
  ).join(",\n    ");
}

function geoMetadataJson(geometryTypes) {
  const typesJson = JSON.stringify(geometryTypes);
  // Mirrors honua-server's GeoParquetFeatureWriter.BuildGeoParquetMetadata
  // string template exactly (member order: encoding, geometry_types, crs,
  // covering; covering paths point at the `bbox` struct's fields).
  return (
    `{"version":"1.1.0","primary_column":"geometry","columns":{"geometry":{` +
    `"encoding":"WKB","geometry_types":${typesJson},"crs":${CRS_PROJJSON},` +
    `"covering":{"bbox":{"xmin":["bbox","xmin"],"ymin":["bbox","ymin"],"xmax":["bbox","xmax"],"ymax":["bbox","ymax"]}}}}}`
  );
}

async function main() {
  const d = await createNodeDuckDbDriver();

  await d.run(`
    CREATE TABLE places AS
    SELECT * FROM (VALUES
    ${valuesSql()}
    ) AS v(id, name, category, population, lon, lat, elevation);
  `);

  // Project into the output CRS with the real PROJ pipeline (always_xy so the
  // WKB carries (x, y) = (easting, northing), matching the GeoParquet spec's
  // fixed axis order regardless of the CRS's own authority-defined order).
  await d.run(`
    CREATE TABLE places_projected AS
    SELECT
      id, name, category, population,
      CASE WHEN elevation IS NOT NULL THEN
        ST_Transform(
          ST_GeomFromText('POINT Z (' || lon || ' ' || lat || ' ' || elevation || ')'),
          'EPSG:4326', '${OUTPUT_SRID}', true)
      ELSE
        ST_Transform(ST_Point(lon, lat), 'EPSG:4326', '${OUTPUT_SRID}', true)
      END AS geom
    FROM places;
  `);

  const anyHasZ = PLACES.some(([, , , , , , elevation]) => elevation !== null);
  const geometryTypes = anyHasZ ? ["Point Z"] : ["Point"];

  // WKB geometry + the GeoParquet 1.1 covering bbox column (2D envelope of
  // the projected geometry -- bbox never carries Z, matching
  // CreateBboxStructType's four DOUBLE fields server-side).
  await d.run(`
    CREATE TABLE places_geoparquet AS
    SELECT
      id, name, category, population,
      CAST(ST_AsWKB(geom) AS BLOB) AS geometry,
      {xmin: ST_X(geom), ymin: ST_Y(geom), xmax: ST_X(geom), ymax: ST_Y(geom)}
        ::STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE) AS bbox
    FROM places_projected;
  `);

  const geoJson = geoMetadataJson(geometryTypes);
  const outFile = path.join(HERE, "places-server-geoparquet.parquet").replace(/\\/g, "/");
  // Note: this build of duckdb-wasm's parquet writer does not honor a small
  // ROW_GROUP_SIZE for an 8-row table (it still emits a single row group), so
  // the fixture cannot demonstrate physical row-group skipping. The reader
  // test instead asserts the *predicate form* the SQL compiler chooses for a
  // spatialFilter against this covering-bbox column (the bbox-struct
  // comparison that DuckDB's parquet scan can satisfy from row-group /
  // Parquet statistics without decoding WKB geometry), which is the same
  // thing test/geoparquet-sql.test.ts labels "(row-group prune)" and is as
  // far as the browser driver's introspection goes (see docs/geoparquet.md).
  await d.run(`COPY places_geoparquet TO '${outFile}' (FORMAT parquet, KV_METADATA {geo: ${sqlString(geoJson)}});`);
  const bytes = fs.readFileSync(outFile);

  // Golden reference: independently captured GeoJSON-shaped expectations
  // (attributes + geometry in the file's native, projected coordinates) for
  // the fidelity assertions in test/geoparquet-server-interop.test.ts. Derived
  // from the SAME projected table (and therefore the same WKB bytes written
  // above), so this is a frozen expectation of "what a correct reader
  // decodes", not a second independent computation.
  const goldenRows = await d.query(`
    SELECT id, name, category, population, ST_AsGeoJSON(geom) AS geometry_json
    FROM places_projected
    ORDER BY id;
  `);
  const golden = {
    version: "1.1.0",
    primaryColumn: "geometry",
    encoding: "WKB",
    crs: "EPSG:32604",
    geometryTypes,
    bboxColumn: "bbox",
    features: goldenRows.map((row) => ({
      attributes: {
        id: row.id,
        name: row.name,
        category: row.category,
        population: Number(row.population),
      },
      geometry: JSON.parse(row.geometry_json),
    })),
  };
  fs.writeFileSync(path.join(HERE, "places-server-golden.json"), `${JSON.stringify(golden, null, 2)}\n`);

  await d.close();
  process.stdout.write(
    `Wrote places-server-geoparquet.parquet (${bytes.byteLength} B) and places-server-golden.json ` +
      `(${golden.features.length} features, geometry_types=${JSON.stringify(geometryTypes)})\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
