#!/usr/bin/env node
/**
 * Deterministically generate the small committed PMTiles fixtures used by the
 * PMTiles unit tests and the `examples/pmtiles-static` Playwright smoke.
 *
 * PMTiles has no JS writer, so this emits valid PMTiles v3 archives by hand
 * (spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md):
 * a 127-byte header, a gzip-compressed root directory + JSON metadata, and a
 * tile-data section. Each archive holds a single tile at z0/0/0 — enough for
 * `describe()` (header + metadata) and for MapLibre to render one tile.
 *
 * Two archives are produced:
 *   - `sample-raster.pmtiles` — one PNG tile; rendered by the example.
 *   - `sample-vector.pmtiles`  — MVT tile-type with `vector_layers` metadata so
 *     `describe()` returns vector layer names.
 *
 * Regenerate with: `node test/fixtures/pmtiles/generate.mjs`, then read the
 * archives back with the real `pmtiles` reader to confirm validity.
 */

import { gzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// A minimal 1x1 opaque PNG (deep teal) — a valid raster tile payload.
const PNG_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// An empty (layer-less) Mapbox Vector Tile is a zero-length protobuf; wrap it in
// gzip to match the archive's declared tile compression.
const MVT_TILE = gzipSync(Buffer.alloc(0));

function writeVarint(value) {
  const bytes = [];
  let v = value;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

/**
 * Serialize a PMTiles v3 directory. `entries` are `{ tileId, offset, length,
 * runLength }` in ascending tileId order. Columns are written in the spec order
 * (tileId deltas, runLengths, lengths, offsets), then gzip-compressed.
 */
function serializeDirectory(entries) {
  const parts = [writeVarint(entries.length)];
  let lastId = 0;
  for (const entry of entries) {
    parts.push(writeVarint(entry.tileId - lastId));
    lastId = entry.tileId;
  }
  for (const entry of entries) parts.push(writeVarint(entry.runLength));
  for (const entry of entries) parts.push(writeVarint(entry.length));
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const prev = entries[i - 1];
    if (i > 0 && prev && entry.offset === prev.offset + prev.length) {
      parts.push(writeVarint(0));
    } else {
      parts.push(writeVarint(entry.offset + 1));
    }
  }
  return gzipSync(Buffer.concat(parts));
}

function e7(value) {
  return Math.round(value * 1e7);
}

/**
 * Assemble a full PMTiles v3 archive buffer.
 */
function buildArchive({ tileType, tileCompression, tileBytes, metadata, bounds, center, minZoom, maxZoom }) {
  const HEADER_LEN = 127;
  const entries = [{ tileId: 0, offset: 0, length: tileBytes.length, runLength: 1 }];
  const rootDir = serializeDirectory(entries);
  const metadataBuf = gzipSync(Buffer.from(JSON.stringify(metadata), "utf8"));

  const rootDirOffset = HEADER_LEN;
  const metadataOffset = rootDirOffset + rootDir.length;
  const leafDirOffset = metadataOffset + metadataBuf.length;
  const leafDirLength = 0;
  const tileDataOffset = leafDirOffset + leafDirLength;
  const tileDataLength = tileBytes.length;

  const header = Buffer.alloc(HEADER_LEN);
  header.write("PMTiles", 0, "ascii");
  header.writeUInt8(3, 7); // spec version
  writeUint64(header, 8, rootDirOffset);
  writeUint64(header, 16, rootDir.length);
  writeUint64(header, 24, metadataOffset);
  writeUint64(header, 32, metadataBuf.length);
  writeUint64(header, 40, leafDirOffset);
  writeUint64(header, 48, leafDirLength);
  writeUint64(header, 56, tileDataOffset);
  writeUint64(header, 64, tileDataLength);
  writeUint64(header, 72, 1); // numAddressedTiles
  writeUint64(header, 80, 1); // numTileEntries
  writeUint64(header, 88, 1); // numTileContents
  header.writeUInt8(1, 96); // clustered
  header.writeUInt8(2, 97); // internal compression = gzip
  header.writeUInt8(tileCompression, 98);
  header.writeUInt8(tileType, 99);
  header.writeUInt8(minZoom, 100);
  header.writeUInt8(maxZoom, 101);
  header.writeInt32LE(e7(bounds[0]), 102); // min lon
  header.writeInt32LE(e7(bounds[1]), 106); // min lat
  header.writeInt32LE(e7(bounds[2]), 110); // max lon
  header.writeInt32LE(e7(bounds[3]), 114); // max lat
  header.writeUInt8(center[2], 118); // center zoom
  header.writeInt32LE(e7(center[0]), 119); // center lon
  header.writeInt32LE(e7(center[1]), 123); // center lat

  return Buffer.concat([header, rootDir, metadataBuf, tileBytes]);
}

function writeUint64(buffer, offset, value) {
  buffer.writeBigUInt64LE(BigInt(value), offset);
}

const BOUNDS = [-123.2, 37.0, -121.5, 38.2];
const CENTER = [-122.35, 37.6, 3];

const rasterArchive = buildArchive({
  tileType: 2, // PNG
  tileCompression: 1, // none
  tileBytes: PNG_TILE,
  bounds: BOUNDS,
  center: CENTER,
  minZoom: 0,
  maxZoom: 5,
  metadata: {
    name: "Honua PMTiles sample (raster)",
    type: "overlay",
    attribution: "Honua PMTiles sample",
  },
});

const vectorArchive = buildArchive({
  tileType: 1, // MVT
  tileCompression: 2, // gzip
  tileBytes: MVT_TILE,
  bounds: BOUNDS,
  center: CENTER,
  minZoom: 0,
  maxZoom: 5,
  metadata: {
    name: "Honua PMTiles sample (vector)",
    type: "overlay",
    attribution: "Honua PMTiles sample",
    vector_layers: [
      { id: "landuse", description: "Land use polygons", minzoom: 0, maxzoom: 5, fields: { class: "String" } },
      { id: "roads", description: "Road centerlines", minzoom: 0, maxzoom: 5, fields: { type: "String" } },
    ],
  },
});

fs.writeFileSync(path.join(HERE, "sample-raster.pmtiles"), rasterArchive);
fs.writeFileSync(path.join(HERE, "sample-vector.pmtiles"), vectorArchive);
process.stdout.write(
  `wrote sample-raster.pmtiles (${rasterArchive.length} bytes) and sample-vector.pmtiles (${vectorArchive.length} bytes)\n`,
);
