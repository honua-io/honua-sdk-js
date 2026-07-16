// Deterministic generator for the tiny GeoParquet test fixtures.
//
// Produces three byte-identical-across-runs parquet files under this directory:
//   1. places-geoparquet.parquet — GeoParquet 1.1 style: a GEOMETRY column
//      that DuckDB writes with a `geo` key-value metadata block. Detection
//      goes through the GeoParquet JSON.
//   2. places-wkb-nometa.parquet — a raw WKB BLOB geometry column with NO
//      GeoParquet metadata. Detection falls back to the Parquet column type +
//      conventional-name heuristic, and geometry is decoded with
//      ST_GeomFromWKB.
//   3. lossless-values.parquet — exact wide integer, decimal, temporal,
//      binary, list, and struct values used by the opt-in JSON result tests.
//
// Both carry the same 8 Oahu "places" with stable GERS-style ids so the
// example and tests can assert on them. Regenerate with:
//   node test/fixtures/geoparquet/generate.mjs
//
// The .parquet files are committed; this script only needs to run when the
// fixture schema changes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createNodeDuckDbDriver } from "../../helpers/geoparquet-node-driver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// DuckDB's Node runtime writes `COPY … TO 'name'` to the real filesystem, so
// stage intermediates in a temp dir and clean them up.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "honua-geoparquet-"));
const tmp = (name) => path.join(TMP, name).replace(/\\/g, "/");

// (gersId, name, category, population, lon, lat)
const PLACES = [
  ["08f2a3c1d4e5f601", "Honolulu Hale", "civic", 0, -157.8583, 21.3069],
  ["08f2a3c1d4e5f602", "Diamond Head", "landmark", 0, -157.8055, 21.2619],
  ["08f2a3c1d4e5f603", "Ala Moana Center", "retail", 0, -157.8434, 21.2911],
  ["08f2a3c1d4e5f604", "Waikiki Beach", "beach", 0, -157.8261, 21.2762],
  ["08f2a3c1d4e5f605", "Pearl Harbor", "historic", 0, -157.9494, 21.3649],
  ["08f2a3c1d4e5f606", "University of Hawaii", "education", 20000, -157.8163, 21.2969],
  ["08f2a3c1d4e5f607", "Kailua Beach Park", "beach", 0, -157.7394, 21.3925],
  ["08f2a3c1d4e5f608", "Dole Plantation", "attraction", 0, -158.0372, 21.5254],
];

function valuesSql() {
  return PLACES.map(
    ([id, name, cat, pop, lon, lat]) =>
      `('${id}', '${name.replace(/'/g, "''")}', '${cat}', ${pop}, ST_Point(${lon}, ${lat}))`,
  ).join(",\n    ");
}

async function main() {
  const d = await createNodeDuckDbDriver();
  await d.run(`
    CREATE TABLE places AS
    SELECT * FROM (VALUES
    ${valuesSql()}
    ) AS v(id, name, category, population, geometry);
  `);

  // 1. GeoParquet 1.1 (GEOMETRY column ⇒ DuckDB writes `geo` metadata).
  const geoTmp = tmp("geoparquet.parquet");
  await d.run(`COPY places TO '${geoTmp}' (FORMAT parquet);`);
  const geoparquetBytes = fs.readFileSync(geoTmp);
  fs.writeFileSync(path.join(HERE, "places-geoparquet.parquet"), geoparquetBytes);

  // 2. Raw WKB BLOB, no GeoParquet metadata.
  await d.run(`
    CREATE TABLE places_wkb AS
    SELECT id, name, category, population, CAST(ST_AsWKB(geometry) AS BLOB) AS geometry
    FROM places;
  `);
  const wkbTmp = tmp("wkb.parquet");
  await d.run(`COPY places_wkb TO '${wkbTmp}' (FORMAT parquet);`);
  const wkbBytes = fs.readFileSync(wkbTmp);
  fs.writeFileSync(path.join(HERE, "places-wkb-nometa.parquet"), wkbBytes);

  // 3. Exact values whose JavaScript representation must not depend on
  // Arrow's default number/wrapper conversions.
  await d.run(`
    CREATE TABLE lossless_values (
      group_key BIGINT,
      int_value INTEGER,
      big_value BIGINT,
      unsigned_value UBIGINT,
      amount DECIMAL(20,5),
      event_date DATE,
      event_time TIME,
      event_ts TIMESTAMP_NS,
      event_tz TIMESTAMPTZ,
      payload BLOB,
      nested STRUCT(ids BIGINT[], amount DECIMAL(20,5)),
      fixed_ids BIGINT[2],
      measures MAP(BIGINT, DECIMAL(10,2))
    );
    INSERT INTO lossless_values VALUES
      (
        9007199254740993,
        2147483647,
        9223372036854775807,
        18446744073709551615,
        123456789012345.67890,
        DATE '2026-07-15',
        TIME '12:34:56.123456',
        CAST('2026-07-15 12:34:56.123456789' AS TIMESTAMP_NS),
        CAST('2026-07-15 12:34:56.123456+05:30' AS TIMESTAMPTZ),
        from_hex('00ff80'),
        {'ids': [9007199254740993, 9223372036854775807], 'amount': 0.00001},
        CAST([9007199254740993, 9223372036854775807] AS BIGINT[2]),
        MAP([CAST(9007199254740993 AS BIGINT)], [CAST(1.23 AS DECIMAL(10,2))])
      ),
      (
        9007199254740993,
        2147483647,
        9223372036854775807,
        18446744073709551615,
        123456789012345.67890,
        DATE '2026-07-16',
        TIME '23:59:59.999999',
        CAST('2026-07-16 23:59:59.999999999' AS TIMESTAMP_NS),
        CAST('2026-07-16 23:59:59.999999-10:00' AS TIMESTAMPTZ),
        from_hex('0102'),
        {'ids': [-9007199254740993], 'amount': -0.00001},
        CAST([-9007199254740993, -9223372036854775807] AS BIGINT[2]),
        MAP([CAST(-9007199254740993 AS BIGINT)], [CAST(-4.50 AS DECIMAL(10,2))])
      );
  `);
  const losslessTmp = tmp("lossless.parquet");
  await d.run(`COPY lossless_values TO '${losslessTmp}' (FORMAT parquet);`);
  const losslessBytes = fs.readFileSync(losslessTmp);
  fs.writeFileSync(path.join(HERE, "lossless-values.parquet"), losslessBytes);

  await d.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.stdout.write(
    `Wrote places-geoparquet.parquet (${geoparquetBytes.byteLength} B), ` +
      `places-wkb-nometa.parquet (${wkbBytes.byteLength} B), and ` +
      `lossless-values.parquet (${losslessBytes.byteLength} B)\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
