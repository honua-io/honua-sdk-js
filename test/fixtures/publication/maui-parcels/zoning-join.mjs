// Joins each parcel to the County of Maui zoning district that covers the
// largest share of it, from a separate capture of the county zoning layer
// (capture-layer.mjs). The parcel layer itself carries only the tax map key
// zone digit, which is not land-use zoning.

import fs from "node:fs";
import path from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";

import { sha256 } from "./capture-layer.mjs";

export const ZONING_FIELD_NAMES = ["zone_code", "zone_dist"];
// Below this share the overlap is treated as a digitising sliver along a
// district boundary, and the parcel is reported as having no zoning.
export const MINIMUM_ZONING_SHARE = 0.1;
// A capture of the wrong layer, or in the wrong CRS, leaves most parcels
// without zoning; the build refuses it instead of publishing nulls.
const MINIMUM_ZONED_PARCELS = 0.95;

export function zoningFields(record) {
  const source = `${record.layerName}, captured ${record.capturedAt} (${record.captureId})`;
  const rule = `district covering the largest share of the parcel, at least ${MINIMUM_ZONING_SHARE * 100}%; null otherwise`;
  return [
    { name: "zoning_code", type: "string", title: "Zoning code", description: `County zoning code: ${rule}. Source: ${source}` },
    { name: "zoning_district", type: "string", title: "Zoning district", description: `County zoning district name: ${rule}. Source: ${source}` },
  ];
}

export function readZoningCapture(directory) {
  const record = JSON.parse(fs.readFileSync(path.join(directory, "capture.json"), "utf8"));
  const featuresPath = path.join(directory, "capture.ndjson");
  if (`sha256:${sha256(fs.readFileSync(featuresPath))}` !== record.captureId) {
    throw new Error("zoning capture.ndjson does not match capture.json");
  }
  return { record, featuresPath };
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function parcelGeometry(parcel) {
  return parcel.polygons.length === 1
    ? { type: "Polygon", coordinates: parcel.polygons[0] }
    : { type: "MultiPolygon", coordinates: parcel.polygons };
}

// Areas are compared within one parcel only, so planar degrees are enough.
// The layer spells some codes two ways ("M-1 Light Industrial" and "M1 Light
// Industrial"), so overlap is summed per code and each code takes its most
// common name.
const LARGEST_SHARE_SQL = `
  WITH district_name AS (
    SELECT zone_code, mode(zone_dist ORDER BY zone_dist) AS zone_dist FROM zoning GROUP BY zone_code
  ), district_overlap AS (
    SELECT p.id, z.zone_code, sum(ST_Area(ST_Intersection(p.geom, z.geom))) AS covered, any_value(p.area) AS area
    FROM parcels p JOIN zoning z ON ST_Intersects(p.geom, z.geom)
    GROUP BY p.id, z.zone_code
  )
  SELECT o.id, o.zone_code, n.zone_dist, o.covered / nullif(o.area, 0) AS share
  FROM district_overlap o JOIN district_name n USING (zone_code)
  QUALIFY row_number() OVER (PARTITION BY o.id ORDER BY o.covered DESC, o.zone_code) = 1`;

async function largestShares(parcelsPath, zoningPath) {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run("INSTALL spatial; LOAD spatial;");
    await connection.run(
      `CREATE TABLE parcels AS SELECT id, geom, ST_Area(geom) AS area
       FROM (SELECT id, ST_MakeValid(ST_GeomFromGeoJSON(geometry)) AS geom
             FROM read_json(${sqlString(parcelsPath)}, format = 'newline_delimited', columns = {id: 'BIGINT', geometry: 'VARCHAR'}))`,
    );
    await connection.run(
      `CREATE TABLE zoning AS SELECT properties->>'zone_code' AS zone_code, properties->>'zone_dist' AS zone_dist,
         ST_MakeValid(ST_GeomFromGeoJSON(geometry::VARCHAR)) AS geom
       FROM read_json(${sqlString(zoningPath)}, format = 'newline_delimited', columns = {properties: 'JSON', geometry: 'JSON'})
       WHERE geometry IS NOT NULL`,
    );
    const reader = await connection.runAndReadAll(LARGEST_SHARE_SQL);
    return reader.getRowObjects();
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function assignDistricts(parcels, rows) {
  for (const parcel of parcels) Object.assign(parcel.attributes, { zoning_code: null, zoning_district: null });
  const kept = rows.filter((row) => row.share !== null && row.share >= MINIMUM_ZONING_SHARE);
  for (const row of kept) {
    Object.assign(parcels[Number(row.id)].attributes, { zoning_code: row.zone_code, zoning_district: row.zone_dist });
  }
  const counts = { zoned: kept.length, unzoned: parcels.length - kept.length, slivers: rows.length - kept.length };
  if (counts.zoned < parcels.length * MINIMUM_ZONED_PARCELS) {
    throw new Error(`Only ${counts.zoned} of ${parcels.length} parcels fall in a zoning district; check the zoning capture`);
  }
  return counts;
}

// Sets zoning_code and zoning_district on every parcel and returns counts.
export async function joinZoning(parcels, zoningCapture, workDirectory) {
  const parcelsPath = path.join(workDirectory, "zoning-join.parcels.ndjson");
  fs.writeFileSync(
    parcelsPath,
    `${parcels.map((parcel, id) => JSON.stringify({ id, geometry: JSON.stringify(parcelGeometry(parcel)) })).join("\n")}\n`,
  );
  try {
    return assignDistricts(parcels, await largestShares(parcelsPath, zoningCapture.featuresPath));
  } finally {
    fs.rmSync(parcelsPath, { force: true });
  }
}
