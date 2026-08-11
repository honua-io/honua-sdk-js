import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync, deflateSync } from "node:zlib";

const WIDTH = 256;
const HEIGHT = 192;
const TILE_SIZE = 64;
const HEADER_BYTES = 4096;
const CHUNK_BYTES = 64 * 1024;
const MAP_TILE_SIZE = 256;
const BBOX = Object.freeze([-158.22, 21.21, -157.66, 21.64]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clamp = (value) => Math.max(1, Math.min(255, Math.round(value)));

function pixel(sourceX, sourceY) {
  const nx = (sourceX / WIDTH - 0.5) * 2;
  const ny = (sourceY / HEIGHT - 0.5) * 2;
  const rotation = -0.3;
  const along = Math.cos(rotation) * nx - Math.sin(rotation) * ny;
  const across = Math.sin(rotation) * nx + Math.cos(rotation) * ny;
  const coast = (along / 0.86) ** 2 + (across / 0.34) ** 2;
  const east = ((along - 0.66) / 0.28) ** 2 + ((across + 0.02) / 0.18) ** 2;
  const west = ((along + 0.69) / 0.24) ** 2 + ((across - 0.03) / 0.2) ** 2;
  const shore = Math.min(coast, east, west);
  const texture = Math.sin(sourceX * 0.73 + sourceY * 0.41) * 7 + Math.cos(sourceY * 0.91) * 5;
  if (shore >= 1) {
    const shelf = Math.max(0, 1.25 - shore);
    return [clamp(22 + shelf * 28), clamp(91 + shelf * 65), clamp(164 + shelf * 45)];
  }
  if (shore > 0.83) return [clamp(210 + texture), clamp(196 + texture), clamp(132 + texture / 2)];
  const ridge = Math.exp(-(((across - (0.06 * Math.sin(along * 7) - 0.03)) / 0.12) ** 2));
  if (along > 0.16 && along < 0.55 && across > 0.04 && across < 0.24) {
    const grid = (Math.floor(sourceX) + Math.floor(sourceY)) % 4 === 0 ? 24 : 0;
    return [146 + grid, 144 + grid, 134 + grid];
  }
  return [clamp(54 + ridge * 22), clamp(144 - ridge * 28 + texture * 0.7), clamp(67 + ridge * 18)];
}

function level(width, height, decimation, dataOffset) {
  const tileColumns = Math.ceil(width / TILE_SIZE);
  const tileRows = Math.ceil(height / TILE_SIZE);
  const tileBytes = TILE_SIZE * TILE_SIZE * 3;
  return {
    width,
    height,
    decimation,
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    tileColumns,
    tileRows,
    tileBytes,
    dataOffset,
    bytes: tileColumns * tileRows * tileBytes,
  };
}

function writeIfd(buffer, ifdOffset, nextIfdOffset, image, reduced) {
  const entries = [];
  let extraOffset = ifdOffset + 2 + (reduced ? 17 : 16) * 12 + 4;
  const reserve = (bytes, alignment = 2) => {
    extraOffset = Math.ceil(extraOffset / alignment) * alignment;
    const offset = extraOffset;
    extraOffset += bytes;
    return offset;
  };
  const bits = reserve(6);
  const sampleFormat = reserve(6);
  const scale = reserve(24, 8);
  const tiepoint = reserve(48, 8);
  const geokeys = reserve(40);
  const nodata = reserve(2);
  const tileCount = image.tileColumns * image.tileRows;
  const offsets = reserve(tileCount * 4, 4);
  const counts = reserve(tileCount * 4, 4);
  const add = (tag, type, count, value) => entries.push({ tag, type, count, value });
  if (reduced) add(254, 4, 1, 1);
  add(256, 4, 1, image.width);
  add(257, 4, 1, image.height);
  add(258, 3, 3, bits);
  add(259, 3, 1, 1);
  add(262, 3, 1, 2);
  add(277, 3, 1, 3);
  add(284, 3, 1, 1);
  add(322, 4, 1, image.tileWidth);
  add(323, 4, 1, image.tileHeight);
  add(324, 4, tileCount, offsets);
  add(325, 4, tileCount, counts);
  add(339, 3, 3, sampleFormat);
  add(33550, 12, 3, scale);
  add(33922, 12, 6, tiepoint);
  add(34735, 3, 20, geokeys);
  add(42113, 2, 2, nodata);
  entries.sort((a, b) => a.tag - b.tag);
  buffer.writeUInt16LE(entries.length, ifdOffset);
  entries.forEach((entry, index) => {
    const offset = ifdOffset + 2 + index * 12;
    buffer.writeUInt16LE(entry.tag, offset);
    buffer.writeUInt16LE(entry.type, offset + 2);
    buffer.writeUInt32LE(entry.count, offset + 4);
    if (entry.type === 3 && entry.count === 1) buffer.writeUInt16LE(entry.value, offset + 8);
    else buffer.writeUInt32LE(entry.value, offset + 8);
  });
  buffer.writeUInt32LE(nextIfdOffset, ifdOffset + 2 + entries.length * 12);
  for (let index = 0; index < 3; index += 1) {
    buffer.writeUInt16LE(8, bits + index * 2);
    buffer.writeUInt16LE(1, sampleFormat + index * 2);
  }
  [(BBOX[2] - BBOX[0]) / image.width, (BBOX[3] - BBOX[1]) / image.height, 0].forEach((value, index) =>
    buffer.writeDoubleLE(value, scale + index * 8),
  );
  [0, 0, 0, BBOX[0], BBOX[3], 0].forEach((value, index) => buffer.writeDoubleLE(value, tiepoint + index * 8));
  [1, 1, 0, 4, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326, 2054, 0, 1, 9102].forEach((value, index) =>
    buffer.writeUInt16LE(value, geokeys + index * 2),
  );
  buffer.write("0\0", nodata, "ascii");
  for (let index = 0; index < tileCount; index += 1) {
    buffer.writeUInt32LE(image.dataOffset + index * image.tileBytes, offsets + index * 4);
    buffer.writeUInt32LE(image.tileBytes, counts + index * 4);
  }
}

function writePixels(buffer, image) {
  for (let tileY = 0; tileY < image.tileRows; tileY += 1) {
    for (let tileX = 0; tileX < image.tileColumns; tileX += 1) {
      const tileOffset = image.dataOffset + (tileY * image.tileColumns + tileX) * image.tileBytes;
      for (let y = 0; y < TILE_SIZE; y += 1) {
        for (let x = 0; x < TILE_SIZE; x += 1) {
          const imageX = tileX * TILE_SIZE + x;
          const imageY = tileY * TILE_SIZE + y;
          if (imageX >= image.width || imageY >= image.height) continue;
          const offset = tileOffset + (y * TILE_SIZE + x) * 3;
          const rgb = pixel(imageX * image.decimation, imageY * image.decimation);
          buffer[offset] = rgb[0];
          buffer[offset + 1] = rgb[1];
          buffer[offset + 2] = rgb[2];
        }
      }
    }
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return output;
}

function encodeRgbPng(renderPixel) {
  const rows = Buffer.alloc((MAP_TILE_SIZE * 3 + 1) * MAP_TILE_SIZE);
  for (let y = 0; y < MAP_TILE_SIZE; y += 1) {
    const rowOffset = y * (MAP_TILE_SIZE * 3 + 1);
    for (let x = 0; x < MAP_TILE_SIZE; x += 1) {
      const [red, green, blue] = renderPixel(x, y);
      const offset = rowOffset + 1 + x * 3;
      rows[offset] = red;
      rows[offset + 1] = green;
      rows[offset + 2] = blue;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(MAP_TILE_SIZE, 0);
  ihdr.writeUInt32BE(MAP_TILE_SIZE, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function mapFixture(id, path, purpose, renderPixel) {
  const bytes = encodeRgbPng(renderPixel);
  return {
    bytes,
    metadata: {
      id,
      path,
      mediaType: "image/png",
      bytes: bytes.length,
      sha256: sha256(bytes),
      license: "CC0-1.0",
      width: MAP_TILE_SIZE,
      height: MAP_TILE_SIZE,
      purpose,
    },
  };
}

function imageryPixel(x, y, variant) {
  const fixtureX = Math.floor(x / 8) * 8;
  const fixtureY = Math.floor(y / 8) * 8;
  const [red, green, blue] = pixel((fixtureX / MAP_TILE_SIZE) * WIDTH, (fixtureY / MAP_TILE_SIZE) * HEIGHT);
  if (variant === "wms") return [red, green, blue];
  return [clamp(red * 0.88 + 18), clamp(green * 1.04), clamp(blue * 0.94 + 9)];
}

function terrainPixel(x, y) {
  const fixtureX = Math.floor(x / 16) * 16;
  const fixtureY = Math.floor(y / 16) * 16;
  const elevation = Math.round(420 + 360 * Math.sin(fixtureX / 38) + 180 * Math.cos(fixtureY / 27));
  const encoded = Math.max(0, Math.min(16_777_215, Math.round((elevation + 10_000) * 10)));
  return [(encoded >> 16) & 255, (encoded >> 8) & 255, encoded & 255];
}

export function buildFixtureCogAssets() {
  const base = level(WIDTH, HEIGHT, 1, HEADER_BYTES);
  const overview = level(WIDTH / 4, HEIGHT / 4, 4, HEADER_BYTES + base.bytes);
  const assetBytes = Buffer.alloc(HEADER_BYTES + base.bytes + overview.bytes);
  assetBytes.write("II", 0, "ascii");
  assetBytes.writeUInt16LE(42, 2);
  assetBytes.writeUInt32LE(8, 4);
  writeIfd(assetBytes, 8, 1024, base, false);
  writeIfd(assetBytes, 1024, 0, overview, true);
  writePixels(assetBytes, base);
  writePixels(assetBytes, overview);
  const chunks = [];
  for (let offset = 0, index = 0; offset < assetBytes.length; offset += CHUNK_BYTES, index += 1) {
    const bytes = assetBytes.subarray(offset, Math.min(offset + CHUNK_BYTES, assetBytes.length));
    const storedBytes = deflateRawSync(bytes, { level: 9 });
    chunks.push({
      path: `chunks/${String(index).padStart(4, "0")}.bin`,
      offset,
      bytes,
      sha256: sha256(bytes),
      storedBytes,
      storedSha256: sha256(storedBytes),
    });
  }
  const renderFixtures = [
    mapFixture("wms-natural-color", "tiles/wms-natural-color.png", "WMS natural-color MapLibre tile", (x, y) =>
      imageryPixel(x, y, "wms"),
    ),
    mapFixture(
      "image-server-natural-color",
      "tiles/image-server-natural-color.png",
      "ImageServer natural-color MapLibre tile and export preview",
      (x, y) => imageryPixel(x, y, "image-server"),
    ),
    mapFixture("terrain-rgb", "tiles/terrain-rgb.png", "Mapbox Terrain-RGB elevation tile", terrainPixel),
  ];
  const digest = sha256(assetBytes);
  const manifest = {
    schemaVersion: 1,
    format: "honua.sdk.fixture-cog.v1",
    asset: {
      path: "assets/oahu-natural-color-v1.tif",
      mediaType: "image/tiff; application=geotiff; profile=cloud-optimized",
      bytes: assetBytes.length,
      sha256: digest,
      etag: `\"sha256-${digest}\"`,
      license: "CC0-1.0",
      width: WIDTH,
      height: HEIGHT,
      crs: "EPSG:4326",
      bbox: [...BBOX],
      chunkBytes: CHUNK_BYTES,
      levels: [base, overview],
    },
    chunks: chunks.map((chunk) => ({
      path: chunk.path,
      offset: chunk.offset,
      bytes: chunk.bytes.length,
      sha256: chunk.sha256,
      storage: {
        encoding: "deflate-raw",
        bytes: chunk.storedBytes.length,
        sha256: chunk.storedSha256,
      },
    })),
    renderFixtures: renderFixtures.map((fixture) => fixture.metadata),
  };
  const assets = {
    cog: {
      href: `./${manifest.asset.path}`,
      type: manifest.asset.mediaType,
      roles: ["data"],
      title: "Deterministic Oahu natural-color COG fixture",
      "file:size": manifest.asset.bytes,
      "checksum:multihash": `sha256:${digest}`,
    },
  };
  for (const key of ["cog-alt", "slow-cog", "no-range-cog", "cors-cog", "unsupported-crs", "unsupported-format"])
    assets[key] = { href: `./assets/${key}`, type: manifest.asset.mediaType, roles: ["data"] };
  const item = {
    type: "Feature",
    stac_version: "1.0.0",
    id: "oahu-natural-color-fixture-v1",
    bbox: [...BBOX],
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [BBOX[0], BBOX[1]],
          [BBOX[2], BBOX[1]],
          [BBOX[2], BBOX[3]],
          [BBOX[0], BBOX[3]],
          [BBOX[0], BBOX[1]],
        ],
      ],
    },
    properties: {
      datetime: "2024-01-01T00:00:00Z",
      license: "CC0-1.0",
      "proj:epsg": 4326,
      "proj:shape": [HEIGHT, WIDTH],
      "proj:bbox": [...BBOX],
    },
    links: [],
    assets,
  };
  return {
    assetBytes,
    chunks,
    renderFixtures,
    manifest,
    item,
    search: { type: "FeatureCollection", features: [item], links: [] },
  };
}

export async function writeFixtureCogAssets(rootDirectory = dirname(fileURLToPath(import.meta.url))) {
  const generated = buildFixtureCogAssets();
  const fixtureDirectory = resolve(rootDirectory, "public", "fixtures", "cog");
  await rm(fixtureDirectory, { recursive: true, force: true });
  await mkdir(resolve(fixtureDirectory, "chunks"), { recursive: true });
  await mkdir(resolve(fixtureDirectory, "tiles"), { recursive: true });
  await Promise.all([
    ...generated.chunks.map((chunk) => writeFile(resolve(fixtureDirectory, chunk.path), chunk.storedBytes)),
    ...generated.renderFixtures.map((fixture) =>
      writeFile(resolve(fixtureDirectory, fixture.metadata.path), fixture.bytes),
    ),
  ]);
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  await Promise.all([
    writeFile(resolve(rootDirectory, "fixture-cog-manifest.v1.json"), json(generated.manifest)),
    writeFile(resolve(fixtureDirectory, "manifest.json"), json(generated.manifest)),
    writeFile(resolve(fixtureDirectory, "item.json"), json(generated.item)),
    writeFile(resolve(fixtureDirectory, "search.json"), json(generated.search)),
    writeFile(
      resolve(fixtureDirectory, "LICENSE.txt"),
      "SPDX-License-Identifier: CC0-1.0\nDeterministic synthetic fixture; no source imagery was copied.\n",
    ),
  ]);
  return generated;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await writeFixtureCogAssets();
