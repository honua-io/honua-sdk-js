#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createNodeDuckDbDriver } from "../../test/helpers/geoparquet-node-driver.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "honua-overture-fixture-"));
const output = path.join(HERE, "public", "overture-places.parquet");
const staged = path.join(TMP, "overture-places.parquet").replaceAll("\\", "/");

const places = [
  ["08f2a3c1d4e5f601", "Honolulu Hale", "civic", 0.99, -157.8583, 21.3069],
  ["08f2a3c1d4e5f602", "Diamond Head", "landmark", 0.98, -157.8055, 21.2619],
  ["08f2a3c1d4e5f603", "Ala Moana Center", "retail", 0.97, -157.8434, 21.2911],
  ["08f2a3c1d4e5f604", "Waikiki Beach", "beach", 0.96, -157.8261, 21.2762],
  ["08f2a3c1d4e5f605", "Pearl Harbor", "historic", 0.95, -157.9494, 21.3649],
  ["08f2a3c1d4e5f606", "University of Hawaii", "education", 0.94, -157.8163, 21.2969],
  ["08f2a3c1d4e5f607", "Kailua Beach Park", "beach", 0.93, -157.7394, 21.3925],
  ["08f2a3c1d4e5f608", "Dole Plantation", "attraction", 0.92, -158.0372, 21.5254],
];

function escapeSql(value) {
  return value.replaceAll("'", "''");
}

async function main() {
  const driver = await createNodeDuckDbDriver();
  try {
    const values = places
      .map(
        ([id, name, category, confidence, longitude, latitude]) =>
          `('${id}', '${escapeSql(name)}', '${category}', ${confidence}, ${longitude}, ${latitude})`,
      )
      .join(",\n");
    await driver.run(`
      CREATE TABLE places AS
      SELECT
        id,
        name,
        category,
        confidence,
        ST_Point(longitude, latitude) AS geometry,
        struct_pack(xmin := longitude, ymin := latitude, xmax := longitude, ymax := latitude) AS bbox
      FROM (VALUES ${values}) AS input(id, name, category, confidence, longitude, latitude);
      COPY places TO '${staged}' (FORMAT parquet, COMPRESSION zstd);
    `);
    fs.copyFileSync(staged, output);
    process.stdout.write(`Wrote ${path.relative(process.cwd(), output)} (${fs.statSync(output).size} bytes)\n`);
  } finally {
    await driver.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
