#!/usr/bin/env node

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import proj4 from "proj4";

import { canonicalJson } from "../samples/scenarios/determinism.mjs";
import { fixtureLicenseRecord } from "../samples/scenarios/fixture-license-registry.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIOME_ENTRY = path.join(REPOSITORY_ROOT, "node_modules/@biomejs/biome/bin/biome");
const OUTPUT_ROOT = path.join(REPOSITORY_ROOT, "samples/fixtures/first-map/v2");
const V1_ROOT = path.join(REPOSITORY_ROOT, "samples/fixtures/first-map/v1");
const SOURCE_URL = "https://www2.census.gov/geo/tiger/TIGER2025/TRACT/tl_2025_15_tract.zip";
const SOURCE_SHA256 = "92b736e066555d55afa795f9dd5944edccd26a97fa70bd1066bf09c7661c5900";
const SOURCE_BYTES = 1_772_413;
const TERMS_URL =
  "https://www2.census.gov/geo/pdfs/maps-data/data/tiger/tgrshp2025/TGRSHP2025_TechDoc_Ch1.pdf";
const TERMS_SHA256 = "ce40bee768cdb00f9dadc154ca0b1dc6ca91180c1b9362e5d2b70cbea2d75003";
const TERMS_BYTES = 150_512;
const COLLECTION_ID = "maui-census-tracts-2025";
const PRECISION = 7;

proj4.defs("EPSG:4269", "+proj=longlat +datum=NAD83 +no_defs +type=crs");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function jsonBytes(value, name) {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  try {
    return Buffer.from(
      execFileSync(process.execPath, [BIOME_ENTRY, "format", "--stdin-file-path", `samples/fixtures/first-map/v2/${name}`], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        input: source,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  } catch (cause) {
    throw new Error("First Map v2 refresh requires the repository-pinned Biome formatter from npm ci.", { cause });
  }
}

async function fetchPinned(url, expectedBytes, expectedSha256) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Pinned source fetch failed with HTTP ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== expectedBytes || sha256(bytes) !== expectedSha256) {
    throw new Error(`Pinned source digest or byte length changed: ${url}`);
  }
  return bytes;
}

function unzip(bytes) {
  const minimumEocd = 22;
  let eocd = -1;
  for (let offset = bytes.length - minimumEocd; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("Pinned TIGER archive has no ZIP end-of-central-directory record.");
  const entryCount = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Pinned TIGER ZIP central directory is invalid.");
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP local header is invalid: ${name}`);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(start, start + compressedSize);
    const expanded = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : undefined;
    if (!expanded || expanded.byteLength !== uncompressedSize) {
      throw new Error(`ZIP entry compression or size is unsupported: ${name}`);
    }
    entries.set(name.toLowerCase(), expanded);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function archiveEntry(entries, suffix) {
  const matches = [...entries.entries()].filter(([name]) => name.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`Pinned TIGER archive must contain exactly one ${suffix} entry.`);
  return matches[0][1];
}

function parseDbf(bytes) {
  const recordCount = bytes.readUInt32LE(4);
  const headerLength = bytes.readUInt16LE(8);
  const recordLength = bytes.readUInt16LE(10);
  const fields = [];
  for (let offset = 32; offset < headerLength - 1; offset += 32) {
    if (bytes[offset] === 0x0d) break;
    const name = bytes.subarray(offset, offset + 11).toString("ascii").replace(/\0.*$/, "").trim();
    fields.push({ name, type: String.fromCharCode(bytes[offset + 11]), length: bytes[offset + 16] });
  }
  const records = [];
  for (let index = 0; index < recordCount; index += 1) {
    const start = headerLength + index * recordLength;
    if (bytes[start] === 0x2a) {
      records.push(null);
      continue;
    }
    const record = {};
    let cursor = start + 1;
    for (const field of fields) {
      const raw = bytes.subarray(cursor, cursor + field.length).toString("latin1").trim();
      record[field.name] = field.type === "N" || field.type === "F" ? Number(raw) : raw;
      cursor += field.length;
    }
    records.push(record);
  }
  return records;
}

function parseShapefile(bytes) {
  if (bytes.readInt32BE(0) !== 9994 || bytes.readInt32LE(28) !== 1000 || bytes.readInt32LE(32) !== 5) {
    throw new Error("Pinned TIGER Shapefile header is not a version 1000 Polygon file.");
  }
  const records = [];
  for (let offset = 100; offset < bytes.length; ) {
    const contentBytes = bytes.readInt32BE(offset + 4) * 2;
    const start = offset + 8;
    const shapeType = bytes.readInt32LE(start);
    if (shapeType === 0) records.push(null);
    else if (shapeType === 5) {
      const partCount = bytes.readInt32LE(start + 36);
      const pointCount = bytes.readInt32LE(start + 40);
      const partStarts = Array.from({ length: partCount }, (_, index) => bytes.readInt32LE(start + 44 + index * 4));
      const pointStart = start + 44 + partCount * 4;
      const points = Array.from({ length: pointCount }, (_, index) => [
        bytes.readDoubleLE(pointStart + index * 16),
        bytes.readDoubleLE(pointStart + index * 16 + 8),
      ]);
      records.push(partStarts.map((partStart, index) => points.slice(partStart, partStarts[index + 1] ?? pointCount)));
    } else throw new Error(`Pinned TIGER Shapefile contains unsupported shape type ${shapeType}.`);
    offset = start + contentBytes;
  }
  return records;
}

function roundCoordinate(value) {
  const rounded = Number(value.toFixed(PRECISION));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function signedArea(ring) {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return area / 2;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const [xi, yi] = ring[current];
    const [xj, yj] = ring[previous];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function canonicalRing(input, counterclockwise) {
  const points = input.map(([x, y]) => proj4("EPSG:4269", "EPSG:4326", [x, y]).map(roundCoordinate));
  while (points.length > 1 && points.at(-1)[0] === points.at(-2)[0] && points.at(-1)[1] === points.at(-2)[1]) {
    points.pop();
  }
  if (points[0][0] !== points.at(-1)[0] || points[0][1] !== points.at(-1)[1]) points.push([...points[0]]);
  let open = points.slice(0, -1);
  if (open.length < 3 || signedArea([...open, open[0]]) === 0) throw new Error("TIGER polygon contains a degenerate ring.");
  if ((signedArea([...open, open[0]]) > 0) !== counterclockwise) open = [...open].reverse();
  let best;
  let bestKey;
  for (let index = 0; index < open.length; index += 1) {
    const candidate = [...open.slice(index), ...open.slice(0, index)];
    const key = canonicalJson(candidate);
    if (bestKey === undefined || key < bestKey) {
      best = candidate;
      bestKey = key;
    }
  }
  return [...best, [...best[0]]];
}

export function canonicalizeTigerPolygon(rings) {
  const normalized = rings.map((ring) => {
    const closed = ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring : [...ring, ring[0]];
    return { ring: closed, area: Math.abs(signedArea(closed)), parent: -1, depth: undefined };
  });
  for (let child = 0; child < normalized.length; child += 1) {
    for (let candidate = 0; candidate < normalized.length; candidate += 1) {
      if (child === candidate || normalized[candidate].area <= normalized[child].area) continue;
      if (!pointInRing(normalized[child].ring[0], normalized[candidate].ring)) continue;
      if (normalized[child].parent < 0 || normalized[candidate].area < normalized[normalized[child].parent].area) {
        normalized[child].parent = candidate;
      }
    }
  }
  function depth(index) {
    if (normalized[index].depth !== undefined) return normalized[index].depth;
    normalized[index].depth = normalized[index].parent < 0 ? 0 : depth(normalized[index].parent) + 1;
    return normalized[index].depth;
  }
  const polygons = [];
  for (let index = 0; index < normalized.length; index += 1) {
    if (depth(index) % 2 !== 0) continue;
    const holes = normalized
      .map((entry, child) => ({ entry, child }))
      .filter(({ entry, child }) => entry.parent === index && depth(child) === depth(index) + 1)
      .map(({ entry }) => canonicalRing(entry.ring, false))
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    polygons.push([canonicalRing(normalized[index].ring, true), ...holes]);
  }
  return polygons.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function extentFromFeatures(features) {
  const extent = [Infinity, Infinity, -Infinity, -Infinity];
  function visit(value) {
    if (typeof value[0] === "number") {
      extent[0] = Math.min(extent[0], value[0]);
      extent[1] = Math.min(extent[1], value[1]);
      extent[2] = Math.max(extent[2], value[0]);
      extent[3] = Math.max(extent[3], value[1]);
      return;
    }
    value.forEach(visit);
  }
  features.forEach((feature) => visit(feature.geometry.coordinates));
  return extent;
}

function replaceStrings(value, replacements) {
  if (typeof value === "string") {
    return replacements.reduce((current, [before, after]) => current.replaceAll(before, after), value);
  }
  if (Array.isArray(value)) return value.map((entry) => replaceStrings(entry, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceStrings(entry, replacements)]));
  }
  return value;
}

function metadataProvenance(provenance) {
  return {
    sourceUrl: provenance.sourceUrl,
    sourceSha256: provenance.sourceSha256,
    retrievedAt: provenance.retrievedAt,
    selection: provenance.selection,
  };
}

async function buildFiles() {
  const [archive] = await Promise.all([
    fetchPinned(SOURCE_URL, SOURCE_BYTES, SOURCE_SHA256),
    fetchPinned(TERMS_URL, TERMS_BYTES, TERMS_SHA256),
  ]);
  const entries = unzip(archive);
  const projection = archiveEntry(entries, ".prj").toString("ascii");
  if (!projection.includes("North_American_1983")) throw new Error("Pinned TIGER source CRS is not NAD83.");
  const records = parseDbf(archiveEntry(entries, ".dbf"));
  const shapes = parseShapefile(archiveEntry(entries, ".shp"));
  if (records.length !== shapes.length) throw new Error("Pinned TIGER DBF and Shapefile record counts differ.");
  const selected = records
    .map((record, index) => ({ record, rings: shapes[index] }))
    .filter(({ record }) => record?.COUNTYFP === "009")
    .sort((left, right) => left.record.GEOID.localeCompare(right.record.GEOID));
  if (selected.length !== 48 || new Set(selected.map(({ record }) => record.GEOID)).size !== 48) {
    throw new Error("Pinned TIGER selection must contain exactly 48 unique Maui County GEOIDs.");
  }

  const ogcFeatures = selected.map(({ record, rings }, index) => {
    if (!rings) throw new Error(`Selected TIGER tract ${record.GEOID} has no polygon geometry.`);
    const properties = {
      OBJECTID: index + 1,
      GEOID: record.GEOID,
      NAME: record.NAME,
      NAMELSAD: record.NAMELSAD,
      ALAND: record.ALAND,
      AWATER: record.AWATER,
    };
    if (!Number.isSafeInteger(properties.ALAND) || !Number.isSafeInteger(properties.AWATER)) {
      throw new Error(`Selected TIGER tract ${record.GEOID} has unsafe area attributes.`);
    }
    return {
      type: "Feature",
      id: index + 1,
      properties,
      geometry: { type: "MultiPolygon", coordinates: canonicalizeTigerPolygon(rings) },
    };
  });
  const extent = extentFromFeatures(ogcFeatures);
  const fields = [
    { name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID" },
    { name: "GEOID", type: "esriFieldTypeString", alias: "Census tract GEOID", length: 11 },
    { name: "NAME", type: "esriFieldTypeString", alias: "Census tract name", length: 7 },
    { name: "NAMELSAD", type: "esriFieldTypeString", alias: "Legal/statistical area description", length: 100 },
    { name: "ALAND", type: "esriFieldTypeDouble", alias: "Land area (square meters)" },
    { name: "AWATER", type: "esriFieldTypeDouble", alias: "Water area (square meters)" },
  ];
  const license = fixtureLicenseRecord("LicenseRef-US-Government-Work");
  const provenance = {
    sourceUrl: SOURCE_URL,
    sourceSha256: SOURCE_SHA256,
    sourceBytes: SOURCE_BYTES,
    retrievedAt: "2026-08-08T00:00:00.000Z",
    sourceVintage: "2025-01-01",
    selection: { field: "COUNTYFP", equals: "009", sort: "GEOID" },
    transformation: {
      id: "honua-tiger-shapefile-v1",
      sourceCrs: "EPSG:4269",
      targetCrs: "EPSG:4326",
      coordinatePrecision: PRECISION,
      geometryNormalization:
        "Retain every source ring without simplification; transform NAD83 to WGS84 with proj4; round to 7 decimals; group rings by containment; enforce RFC 7946 orientation; rotate and sort rings and polygons canonically.",
      attributeSelection: ["GEOID", "NAME", "NAMELSAD", "ALAND", "AWATER"],
      objectIdAssignment: "1-based index after ascending GEOID sort",
    },
    toolchain: {
      node: "20.19.0 (.nvmrc)",
      projection: "proj4@2.20.9 (package-lock.json)",
      archive: "node:zlib inflateRawSync",
      parser: "scripts/refresh-first-map-tiger-v2.mjs",
    },
    refreshCommand: "npm run samples:fixtures:first-map-v2:write",
  };
  const projectedProvenance = metadataProvenance(provenance);
  const features = {
    objectIdFieldName: "OBJECTID",
    geometryType: "esriGeometryPolygon",
    spatialReference: { wkid: 4326 },
    fields,
    features: ogcFeatures.map((feature) => ({
      attributes: feature.properties,
      geometry: { rings: feature.geometry.coordinates.flat().map((ring) => [...ring].reverse()) },
    })),
  };
  const layer = {
    currentVersion: 11.3,
    id: 0,
    name: "Maui County 2025 Census tracts",
    type: "Feature Layer",
    description: "Forty-eight Maui County census tracts from the pinned 2025 TIGER/Line source artifact.",
    copyrightText: license.citation,
    license,
    provenance: projectedProvenance,
    geometryType: "esriGeometryPolygon",
    objectIdField: "OBJECTID",
    maxRecordCount: 1000,
    advancedQueryCapabilities: {
      supportsPagination: true,
      supportsReturningQueryExtent: false,
      supportsStatistics: false,
    },
    extent: {
      xmin: extent[0],
      ymin: extent[1],
      xmax: extent[2],
      ymax: extent[3],
      spatialReference: { wkid: 4326 },
    },
    fields,
    capabilities: "Query",
  };
  const licenseLink = { href: license.termsUrl, rel: "license", type: "application/pdf", title: "Source terms" };
  const landing = {
    title: layer.name,
    description: "Governed deterministic First Map fixture projected through OGC API Features.",
    attribution: license.citation,
    license,
    provenance: projectedProvenance,
    links: [
      { href: "/ogc/features", rel: "self", type: "application/json", title: "This landing page" },
      {
        href: "/ogc/features/conformance",
        rel: "conformance",
        type: "application/json",
        title: "Conformance classes",
      },
      { href: "/ogc/features/collections", rel: "data", type: "application/json", title: "Feature collections" },
      {
        href: "/ogc/features/api",
        rel: "service-desc",
        type: "application/vnd.oai.openapi+json;version=3.0",
        title: "Bounded OpenAPI definition",
      },
      licenseLink,
    ],
  };
  const collection = {
    id: COLLECTION_ID,
    title: layer.name,
    description: layer.description,
    itemType: "feature",
    extent: {
      spatial: { bbox: [extent], crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" },
    },
    crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
    attribution: license.citation,
    license,
    provenance: projectedProvenance,
    links: [
      { href: "/ogc/features", rel: "root", type: "application/json", title: "Feature service landing page" },
      {
        href: `/ogc/features/collections/${COLLECTION_ID}`,
        rel: "self",
        type: "application/json",
        title: "This collection",
      },
      {
        href: `/ogc/features/collections/${COLLECTION_ID}/items`,
        rel: "items",
        type: "application/geo+json",
        title: "Collection items",
      },
      licenseLink,
    ],
  };
  const items = {
    type: "FeatureCollection",
    timeStamp: provenance.retrievedAt,
    numberMatched: 48,
    numberReturned: 48,
    attribution: license.citation,
    license,
    provenance: projectedProvenance,
    features: ogcFeatures,
    links: [
      {
        href: `/ogc/features/collections/${COLLECTION_ID}/items`,
        rel: "self",
        type: "application/geo+json",
        title: "Collection items",
      },
      {
        href: `/ogc/features/collections/${COLLECTION_ID}`,
        rel: "collection",
        type: "application/json",
        title: "Collection metadata",
      },
      licenseLink,
    ],
  };
  const readV1 = (name) => JSON.parse(fs.readFileSync(path.join(V1_ROOT, name), "utf8"));
  const api = replaceStrings(readV1("ogc-api-definition.json"), [
    ["operations-areas", COLLECTION_ID],
    ["Honua First Map fixture OGC API Features", "Maui County 2025 Census tracts OGC API Features"],
    ["1.0.0", "2.0.0"],
    ["deterministic OGC API Features projection", "governed TIGER/Line OGC API Features projection"],
  ]);
  const data = {
    "capabilities.json": readV1("capabilities.json"),
    "features.json": features,
    "layer.json": layer,
    "ogc-api-definition.json": api,
    "ogc-collection.json": collection,
    "ogc-conformance.json": readV1("ogc-conformance.json"),
    "ogc-items.json": items,
    "ogc-landing.json": landing,
  };
  const fileBytes = Object.fromEntries(Object.entries(data).map(([name, value]) => [name, jsonBytes(value, name)]));
  const manifest = {
    fixturePackVersion: "honua.fixture-pack/v2",
    identity: {
      id: "first-map",
      version: "2.0.0",
      revision: "v2",
      title: "Governed Maui County 2025 TIGER/Line census tracts",
    },
    schema: {
      protocols: ["honua-capabilities-v1", "esri-geoservices-feature-server", "ogc-api-features-1.0"],
      geometryType: "MultiPolygon",
      authorityCrs: "EPSG:4326",
      coordinateEncoding: { format: "Esri JSON", axes: ["x-longitude", "y-latitude"], order: "xy" },
      projections: [
        {
          protocol: "esri-geoservices-feature-server",
          crs: "EPSG:4326",
          coordinateEncoding: { format: "Esri JSON", axes: ["x-longitude", "y-latitude"], order: "xy" },
        },
        {
          protocol: "ogc-api-features-1.0",
          crs: "OGC:CRS84",
          coordinateEncoding: { format: "GeoJSON", axes: ["longitude", "latitude"], order: "xy" },
        },
      ],
      extent,
      featureCount: 48,
      selectedRecordId: 1,
      files: {
        capabilities: "capabilities.json",
        layer: "layer.json",
        features: "features.json",
        ogcLanding: "ogc-landing.json",
        ogcApiDefinition: "ogc-api-definition.json",
        ogcConformance: "ogc-conformance.json",
        ogcCollection: "ogc-collection.json",
        ogcItems: "ogc-items.json",
      },
    },
    provenance,
    license,
    freshness: { policy: "immutable", asOf: "2025-01-01T00:00:00.000Z", refreshAfterDays: null },
    integrity: {
      algorithm: "sha256",
      canonicalization:
        "canonicalDatasetSha256 hashes recursively key-sorted JSON over the ordered GeoJSON features. File hashes cover exact UTF-8 JSON bytes. Metadata hashes exclude the recursive integrity object.",
      canonicalDatasetSha256: sha256(canonicalJson({ type: "FeatureCollection", features: ogcFeatures })),
      metadataFingerprint: "",
      metadataComponents: { license: "", provenance: "" },
      files: Object.fromEntries(Object.entries(fileBytes).map(([name, bytes]) => [name, sha256(bytes)])),
    },
  };
  const { integrity: _integrity, ...semantics } = manifest;
  manifest.integrity.metadataFingerprint = sha256(canonicalJson(semantics));
  manifest.integrity.metadataComponents.license = sha256(canonicalJson(manifest.license));
  manifest.integrity.metadataComponents.provenance = sha256(canonicalJson(manifest.provenance));
  fileBytes["manifest.json"] = jsonBytes(manifest, "manifest.json");
  return fileBytes;
}

function apply(files, write) {
  if (write) fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const actualNames = fs.existsSync(OUTPUT_ROOT)
    ? fs.readdirSync(OUTPUT_ROOT, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort()
    : [];
  const expectedNames = Object.keys(files).sort();
  const drift = [];
  for (const name of expectedNames) {
    const destination = path.join(OUTPUT_ROOT, name);
    const current = fs.existsSync(destination) ? fs.readFileSync(destination) : undefined;
    if (!current?.equals(files[name])) drift.push(name);
    if (write && !current?.equals(files[name])) fs.writeFileSync(destination, files[name]);
  }
  const unexpected = actualNames.filter((name) => !expectedNames.includes(name));
  if (unexpected.length > 0) throw new Error(`First Map v2 contains unexpected files: ${unexpected.join(", ")}`);
  if (!write && drift.length > 0) throw new Error(`First Map v2 generated bytes drifted: ${drift.join(", ")}`);
  return drift;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.some((argument) => argument !== "--write") ||
    arguments_.filter((argument) => argument === "--write").length > 1
  ) {
    throw new Error("Usage: refresh-first-map-tiger-v2.mjs [--write]");
  }
  const write = arguments_.includes("--write");
  const files = await buildFiles();
  const drift = apply(files, write);
  process.stdout.write(
    `${JSON.stringify({ fixture: "first-map@v2", mode: write ? "write" : "check", changed: drift, sourceSha256: SOURCE_SHA256 }, null, 2)}\n`,
  );
}
