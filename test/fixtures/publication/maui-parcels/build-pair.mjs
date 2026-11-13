#!/usr/bin/env node
// Builds a paired PMTiles + GeoParquet publication of the County of Maui parcel
// layer from one capture, plus its publication descriptor v1 and the STAC item the
// descriptor links.
//
//   node build-pair.mjs capture --source <parcel layer URL> --out <capture dir>
//   node build-pair.mjs build --capture <capture dir> --out <output dir> [--subset fixture]
//
// `capture` reads the layer once (ids first, then pages of features in
// WGS 84) and refuses to finish if the layer's id set or metadata changed while
// it read. `build` is offline and derives both artifacts from that capture
// only, so both carry the same capture id. `--subset fixture` publishes the
// small committed fixture (a bounding box of the same capture). The descriptor
// links the live Honua layer that serves the same parcels for server queries.
// Large outputs
// belong under the ignored `.artifacts/` directory. Requires Docker (tippecanoe
// image built from the tagged source, see pmtiles-archive.mjs) and Node 22.

import fs from "node:fs";
import path from "node:path";

import { DuckDBInstance } from "@duckdb/node-api";

import { captureLayer, sha256 } from "./capture-layer.mjs";
import { runTippecanoe, withPublicationMetadata } from "./pmtiles-archive.mjs";

const ROW_GROUP_ROWS = 2048;
const PUBLICATION_ID = "maui-county-parcels";
const IDENTITY_FIELD = "tmk_txt";
const PMTILES_LAYER = "parcels";
const PMTILES_MIN_ZOOM = 10;
const PMTILES_MAX_ZOOM = 15;
const ADDITIVE_FIELDS = new Set(["gisacres", "taxacres"]);
const BLANK_MEANS_ABSENT = new Set(["nhoodcode"]);
const LIVE_LAYER = "https://demo.honua.io/rest/services/maui-parcels/FeatureServer/1";
const FIXTURE_BOUNDS = [-156.494, 20.902, -156.484, 20.911];
const SOURCE_LICENSE_URL = "https://planning.hawaii.gov/gis/download-gis-data-expanded/";

const PUBLIC_FIELDS = [
  { name: "tmk_txt", type: "string", title: "Tax map key", description: "Nine-digit parcel number" },
  { name: "zone", type: "string", title: "Zone" },
  { name: "section", type: "string", title: "Section" },
  { name: "plat", type: "string", title: "Plat", description: "Three digits, leading zeros kept" },
  { name: "parcel", type: "string", title: "Parcel", description: "Three digits, leading zeros kept" },
  {
    name: "nhoodcode",
    type: "string",
    title: "Assessment neighborhood",
    description: "Null where the county records no neighborhood code",
  },
  { name: "pittcode", type: "integer", title: "Property class code" },
  { name: "taxacres", type: "number", title: "Tax acres" },
  { name: "gisacres", type: "number", title: "GIS acres" },
];
const PRIVATE_FIELDS = [
  { name: "tmk", type: "integer", title: "Tax map key as a number" },
  { name: "landvalue", type: "integer", title: "Land value" },
  { name: "bldgvalue", type: "integer", title: "Building value" },
  { name: "homeowner", type: "string", title: "Homeowner exemption" },
];
const PMTILES_FIELDS = [IDENTITY_FIELD];

const DUCKDB_COLUMN_TYPES = {
  tmk_txt: "VARCHAR",
  zone: "VARCHAR",
  section: "VARCHAR",
  plat: "VARCHAR",
  parcel: "VARCHAR",
  nhoodcode: "VARCHAR",
  pittcode: "INTEGER",
  taxacres: "DOUBLE",
  gisacres: "DOUBLE",
  geometry: "STRUCT(x DOUBLE, y DOUBLE)[][][]",
  bbox: "STRUCT(xmin DOUBLE, ymin DOUBLE, xmax DOUBLE, ymax DOUBLE)",
};

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!key?.startsWith("--") || rest[index + 1] === undefined) throw new Error(`Bad argument near ${key}`);
    options[key.slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function polygonsOf(geometry) {
  if (geometry?.type === "Polygon") return [geometry.coordinates];
  if (geometry?.type === "MultiPolygon") return geometry.coordinates;
  throw new Error(`Unsupported parcel geometry ${geometry?.type}`);
}

function publicAttributes(properties) {
  const attributes = {};
  for (const { name } of PUBLIC_FIELDS) {
    const value = properties[name];
    attributes[name] = BLANK_MEANS_ABSENT.has(name) && typeof value === "string" && value.trim() === "" ? null : value;
  }
  return attributes;
}

function mergeRecordsSharingIdentity(features) {
  const parcels = new Map();
  for (const feature of features) {
    const attributes = publicAttributes(feature.properties);
    const key = attributes[IDENTITY_FIELD];
    if (typeof key !== "string" || key.length === 0) throw new Error(`Feature without ${IDENTITY_FIELD}`);
    const existing = parcels.get(key);
    if (!existing) {
      parcels.set(key, { attributes, polygons: [...polygonsOf(feature.geometry)] });
      continue;
    }
    for (const { name } of PUBLIC_FIELDS) {
      if (ADDITIVE_FIELDS.has(name)) existing.attributes[name] += attributes[name];
      else if (existing.attributes[name] !== attributes[name]) {
        throw new Error(`${key} appears twice with different ${name}; refusing to merge`);
      }
    }
    existing.polygons.push(...polygonsOf(feature.geometry));
  }
  return [...parcels.values()].sort((left, right) =>
    left.attributes[IDENTITY_FIELD] < right.attributes[IDENTITY_FIELD] ? -1 : 1,
  );
}

function boundsOf(polygons) {
  const bounds = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [x, y] of ring) {
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x);
        bounds[3] = Math.max(bounds[3], y);
      }
    }
  }
  return bounds;
}

function intersects(bounds, window) {
  return bounds[0] <= window[2] && bounds[2] >= window[0] && bounds[1] <= window[3] && bounds[3] >= window[1];
}

function unionBounds(parcels) {
  const all = parcels.map((parcel) => parcel.bounds);
  return [
    Math.min(...all.map((bounds) => bounds[0])),
    Math.min(...all.map((bounds) => bounds[1])),
    Math.max(...all.map((bounds) => bounds[2])),
    Math.max(...all.map((bounds) => bounds[3])),
  ];
}

function parquetRow(parcel) {
  const [xmin, ymin, xmax, ymax] = parcel.bounds;
  return {
    ...parcel.attributes,
    geometry: parcel.polygons.map((polygon) => polygon.map((ring) => ring.map(([x, y]) => ({ x, y })))),
    bbox: { xmin, ymin, xmax, ymax },
  };
}

function geoMetadata(bounds) {
  return {
    version: "1.1.0",
    primary_column: "geometry",
    columns: {
      geometry: {
        encoding: "multipolygon",
        geometry_types: ["MultiPolygon"],
        bbox: bounds,
        covering: { bbox: { xmin: ["bbox", "xmin"], ymin: ["bbox", "ymin"], xmax: ["bbox", "xmax"], ymax: ["bbox", "ymax"] } },
      },
    },
  };
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function writeGeoParquet(parcels, publicationStamp, directory) {
  const rowsPath = path.join(directory, "parcels.rows.ndjson");
  fs.writeFileSync(rowsPath, `${parcels.map((parcel) => JSON.stringify(parquetRow(parcel))).join("\n")}\n`);
  const target = path.join(directory, "parcels.parquet");
  const columns = Object.entries(DUCKDB_COLUMN_TYPES)
    .map(([name, type]) => `${sqlString(name)}: ${sqlString(type)}`)
    .join(", ");
  const kv = {
    geo: JSON.stringify(geoMetadata(unionBounds(parcels))),
    "honua:publication": JSON.stringify(publicationStamp),
  };
  const kvSql = Object.entries(kv)
    .map(([key, value]) => `${sqlString(key)}: ${sqlString(value)}`)
    .join(", ");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run(
      `COPY (SELECT * FROM read_json(${sqlString(rowsPath)}, format = 'newline_delimited', columns = {${columns}}) ORDER BY ${IDENTITY_FIELD})
       TO ${sqlString(target)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE ${ROW_GROUP_ROWS}, KV_METADATA {${kvSql}})`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  fs.rmSync(rowsPath);
  return target;
}

function tileFeature(parcel) {
  return {
    type: "Feature",
    properties: Object.fromEntries(PMTILES_FIELDS.map((name) => [name, parcel.attributes[name]])),
    geometry:
      parcel.polygons.length === 1
        ? { type: "Polygon", coordinates: parcel.polygons[0] }
        : { type: "MultiPolygon", coordinates: parcel.polygons },
  };
}

async function rowGroupCount(file) {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(`SELECT num_row_groups FROM parquet_file_metadata(${sqlString(file)})`);
    return Number(reader.getRowObjects()[0].num_row_groups);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function artifactRecord(file, mediaType, fields, captureId) {
  const bytes = fs.readFileSync(file);
  return { href: path.basename(file), mediaType, bytes: bytes.length, sha256: sha256(bytes), captureId, fields };
}

async function descriptorFor({ record, parcels, version, subset, pmtilesPath, parquetPath, bounds }) {
  const captureId = record.captureId;
  return {
    $schema: "https://honua.io/schemas/publication-descriptor.v1.schema.json",
    descriptorVersion: "1.0",
    publicationId: subset ? `${PUBLICATION_ID}-fixture` : PUBLICATION_ID,
    version,
    title: subset ? "Maui County parcels (test fixture subset)" : "Maui County parcels",
    publishedAt: new Date().toISOString(),
    sourceLayer: { service: "maui-parcels", layer: "parcels", title: record.layerName, href: LIVE_LAYER },
    capture: {
      captureId,
      capturedAt: record.capturedAt,
      sourceRevision: record.sourceRevision,
      featureCount: parcels.length,
      ...(subset ? { filter: { bbox: FIXTURE_BOUNDS } } : {}),
    },
    bounds: bounds.map((value) => Number(value.toFixed(7))),
    crs: { source: record.sourceCrs, geoparquet: "OGC:CRS84", pmtiles: "EPSG:3857" },
    fields: [...PUBLIC_FIELDS.map((field) => ({ ...field, public: true })), ...PRIVATE_FIELDS.map((field) => ({ ...field, public: false }))],
    identity: { field: IDENTITY_FIELD, type: "string", pmtilesProperty: IDENTITY_FIELD, geoparquetColumn: IDENTITY_FIELD },
    geometry: { column: "geometry", encoding: "geoarrow-multipolygon", types: ["MultiPolygon"], bboxColumn: "bbox" },
    artifacts: {
      pmtiles: {
        ...artifactRecord(pmtilesPath, "application/vnd.pmtiles", PMTILES_FIELDS, captureId),
        vectorLayer: PMTILES_LAYER,
        minzoom: PMTILES_MIN_ZOOM,
        maxzoom: PMTILES_MAX_ZOOM,
      },
      geoparquet: {
        ...artifactRecord(parquetPath, "application/vnd.apache.parquet", PUBLIC_FIELDS.map((field) => field.name), captureId),
        rowGroups: await rowGroupCount(parquetPath),
        sortedBy: IDENTITY_FIELD,
      },
    },
    validation: {
      status: "passed",
      validatedAt: new Date().toISOString(),
      checks: [
        { name: "capture-consistency", status: "passed" },
        { name: "public-fields-only", status: "passed" },
        { name: "identity-unique", status: "passed" },
      ],
    },
    links: { stac: stacItemPath(subset), source: LIVE_LAYER },
    provenance: {
      publisher: "County of Maui",
      license: "public-domain",
      attribution: record.attribution,
    },
  };
}

function stacItemPath(subset) {
  return `stac/${subset ? `${PUBLICATION_ID}-fixture` : PUBLICATION_ID}.json`;
}

function stacAsset(artifact, title) {
  return { href: `../${artifact.href}`, type: artifact.mediaType, title, "file:size": artifact.bytes, "file:checksum": `1220${artifact.sha256}` };
}

function stacItemFor(descriptor, record) {
  const [west, south, east, north] = descriptor.bounds;
  return {
    type: "Feature",
    stac_version: "1.1.0",
    stac_extensions: ["https://stac-extensions.github.io/file/v2.1.0/schema.json"],
    id: `${descriptor.publicationId}-${descriptor.version}`,
    bbox: descriptor.bounds,
    geometry: {
      type: "Polygon",
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    },
    properties: {
      title: descriptor.title,
      datetime: record.capturedAt,
      created: descriptor.publishedAt,
      license: "other",
      providers: [{ name: descriptor.provenance.publisher, roles: ["producer", "licensor"], url: record.sourceUrl }],
      "honua:captureId": record.captureId,
      "honua:featureCount": descriptor.capture.featureCount,
    },
    links: [
      { rel: "describedby", href: "../descriptor.json", type: "application/json", title: "Publication descriptor v1" },
      { rel: "via", href: record.sourceUrl, title: record.layerName },
      { rel: "license", href: SOURCE_LICENSE_URL, title: descriptor.provenance.license },
    ],
    assets: {
      pmtiles: stacAsset(descriptor.artifacts.pmtiles, "Display tiles"),
      geoparquet: stacAsset(descriptor.artifacts.geoparquet, "Feature records"),
    },
  };
}

async function build({ capture: captureDir, out, subset, version }) {
  if (!captureDir || !out) throw new Error("build needs --capture and --out");
  if (subset !== undefined && subset !== "fixture") throw new Error("--subset accepts only 'fixture'");
  fs.mkdirSync(out, { recursive: true });
  const record = JSON.parse(fs.readFileSync(path.join(captureDir, "capture.json"), "utf8"));
  const captured = fs.readFileSync(path.join(captureDir, "capture.ndjson"), "utf8");
  if (`sha256:${sha256(captured)}` !== record.captureId) throw new Error("capture.ndjson does not match capture.json");
  const all = mergeRecordsSharingIdentity(captured.trimEnd().split("\n").map((line) => JSON.parse(line)));
  for (const parcel of all) parcel.bounds = boundsOf(parcel.polygons);
  const parcels = subset ? all.filter((parcel) => intersects(parcel.bounds, FIXTURE_BOUNDS)) : all;
  const publicationVersion = version ?? record.capturedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const publicationStamp = {
    publicationId: subset ? `${PUBLICATION_ID}-fixture` : PUBLICATION_ID,
    version: publicationVersion,
    captureId: record.captureId,
  };
  const parquetPath = await writeGeoParquet(parcels, publicationStamp, out);
  const rawPmtiles = runTippecanoe({
    features: parcels.map(tileFeature),
    directory: out,
    layer: PMTILES_LAYER,
    minZoom: PMTILES_MIN_ZOOM,
    maxZoom: PMTILES_MAX_ZOOM,
  });
  const pmtilesPath = withPublicationMetadata(rawPmtiles, publicationStamp, path.join(out, "parcels.pmtiles"));
  const descriptor = await descriptorFor({
    record,
    parcels,
    version: publicationVersion,
    subset,
    pmtilesPath,
    parquetPath,
    bounds: unionBounds(parcels),
  });
  fs.writeFileSync(path.join(out, "descriptor.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
  const stacItemFile = path.join(out, stacItemPath(subset));
  fs.mkdirSync(path.dirname(stacItemFile), { recursive: true });
  fs.writeFileSync(stacItemFile, `${JSON.stringify(stacItemFor(descriptor, record), null, 2)}\n`);
  const multipart = parcels.filter((parcel) => parcel.polygons.length > 1).length;
  const nullNeighborhood = parcels.filter((parcel) => parcel.attributes.nhoodcode === null).length;
  process.stdout.write(
    `parcels=${parcels.length} multipart=${multipart} nullNhoodcode=${nullNeighborhood} ` +
      `geoparquet=${descriptor.artifacts.geoparquet.bytes}B pmtiles=${descriptor.artifacts.pmtiles.bytes}B\n`,
  );
}

const { command, options } = parseArguments(process.argv.slice(2));
if (command === "capture") await captureLayer({ ...options, fieldNames: PUBLIC_FIELDS.map((field) => field.name) });
else if (command === "build") await build(options);
else throw new Error("usage: build-pair.mjs capture|build [options]");
