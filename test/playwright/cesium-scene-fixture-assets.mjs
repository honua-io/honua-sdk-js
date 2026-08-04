/**
 * Deterministic 3D fixture assets for the real-Cesium scene-adapter browser lane.
 *
 * Every asset the fixture serves — the glTF/GLB model, the 3D-Tiles tileset and
 * its tile content, the quantized-mesh terrain layer descriptor and its terrain
 * tiles, and the imagery tile — is generated here in-process with nothing but
 * the Node standard library. Two properties fall out of that and both are
 * load-bearing for honua-sdk-js#928:
 *
 *  1. The repository carries no binary blobs for this lane, so the fixture is
 *     reviewable as source and cannot drift from what the spec asserts.
 *  2. The fixture server can answer every request the real CesiumJS runtime
 *     makes without a single byte of network egress (REQ-001 / AC-5).
 *
 * The geometry is deliberately minimal (a single triangle, a two-triangle
 * terrain tile). The point of this lane is that the adapter's *bindings* reach
 * real Cesium loaders, GPU resources, and workers — not that the fixture is a
 * pretty scene.
 *
 * @module
 */

import zlib from "node:zlib";

/** Fixture anchor: offshore of Honolulu, matching the rest of the repo's demo data. */
export const FIXTURE_ORIGIN = Object.freeze({ longitude: -157.858, latitude: 21.307, height: 400 });

const GLTF_MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK_TYPE = 0x4e4f534a; // "JSON"
const BIN_CHUNK_TYPE = 0x004e4942; // "BIN\0"
const ARRAY_BUFFER_TARGET = 34962;
const ELEMENT_ARRAY_BUFFER_TARGET = 34963;
const COMPONENT_TYPE_FLOAT = 5126;
const COMPONENT_TYPE_UNSIGNED_SHORT = 5123;

/**
 * Build a valid, self-contained glTF 2.0 binary (`.glb`) holding one shaded
 * triangle in a local east-north-up frame.
 *
 * Used twice: directly as the `model-layer` (`glb`) primitive's asset, and as
 * the 3D-Tiles root tile's content — Cesium routes a tile whose payload starts
 * with the `glTF` magic through its glTF tile loader, so one generator covers
 * both model formats the adapter materializes.
 */
export function buildTriangleGlb() {
  const positions = new Float32Array([0, 0, 0, 40, 0, 0, 0, 40, 30]);
  const indices = new Uint16Array([0, 1, 2]);
  const positionBytes = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength);
  const indexBytes = Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength);
  const binary = padTo4(Buffer.concat([positionBytes, indexBytes]), 0x00);

  const gltf = {
    asset: { version: "2.0", generator: "honua-sdk-js scene fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "honua-fixture-triangle" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [
      {
        name: "honua-fixture-material",
        doubleSided: true,
        pbrMetallicRoughness: {
          baseColorFactor: [0.16, 0.63, 0.94, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
    buffers: [{ byteLength: binary.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.byteLength, target: ARRAY_BUFFER_TARGET },
      {
        buffer: 0,
        byteOffset: positionBytes.byteLength,
        byteLength: indexBytes.byteLength,
        target: ELEMENT_ARRAY_BUFFER_TARGET,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: COMPONENT_TYPE_FLOAT,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [40, 40, 30],
      },
      { bufferView: 1, componentType: COMPONENT_TYPE_UNSIGNED_SHORT, count: 3, type: "SCALAR" },
    ],
  };

  const jsonChunk = padTo4(Buffer.from(JSON.stringify(gltf), "utf8"), 0x20);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLTF_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.byteLength + 8 + binary.byteLength, 8);
  return Buffer.concat([header, chunk(jsonChunk, JSON_CHUNK_TYPE), chunk(binary, BIN_CHUNK_TYPE)]);
}

/**
 * A single-tile 3D-Tiles 1.1 tileset whose root content is {@link buildTriangleGlb}.
 *
 * The bounding volume is an axis-aligned box around the tile-local origin, not a
 * geographic region: the adapter places the tileset itself by assigning
 * `tileset.modelMatrix` from the primitive's `position`, so keeping the tileset's
 * own coordinates local is what makes that placement path observable.
 */
export function buildTilesetJson() {
  return {
    asset: { version: "1.1", tilesetVersion: "honua-fixture-1" },
    geometricError: 64,
    root: {
      boundingVolume: { box: [0, 0, 0, 60, 0, 0, 0, 60, 0, 0, 0, 60] },
      geometricError: 0,
      refine: "ADD",
      content: { uri: "content.glb" },
    },
  };
}

/**
 * A quantized-mesh `layer.json` describing a two-level terrain pyramid that the
 * fixture server backs with {@link buildQuantizedMeshTile}.
 *
 * `available` is declared explicitly so Cesium requests exactly the tiles the
 * fixture can serve; nothing 404s, so the terrain path produces no console
 * noise for NFR-002 to trip over.
 */
export function buildTerrainLayerJson() {
  return {
    tilejson: "2.1.0",
    name: "honua-scene-fixture-terrain",
    description: "Deterministic offline quantized-mesh terrain for the Cesium scene-adapter fixture.",
    version: "1.0.0",
    format: "quantized-mesh-1.0",
    attribution: "Honua SDK fixture",
    schema: "tms",
    tiles: ["{z}/{x}/{y}.terrain"],
    projection: "EPSG:4326",
    bounds: [-180, -90, 180, 90],
    maxzoom: 0,
    minzoom: 0,
    extensions: [],
    available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]],
  };
}

/**
 * Encode a minimal but structurally valid quantized-mesh 1.0 terrain tile: four
 * corner vertices at a constant height, two triangles, and the four edge-index
 * lists Cesium needs to stitch the tile to its neighbours.
 *
 * Vertex positions are derived by Cesium from the tiling scheme's rectangle plus
 * the quantized u/v/height grid and the min/max height, so the header's centre,
 * bounding sphere, and horizon-occlusion point are culling metadata only. They
 * are left zeroed with a whole-earth bounding radius: the lane asserts that the
 * adapter binds and tears down a real `CesiumTerrainProvider` whose tiles decode
 * without error, not that this particular flat tile survives culling.
 */
export function buildQuantizedMeshTile() {
  const header = Buffer.alloc(88);
  let offset = 0;
  for (const value of [0, 0, 0]) {
    header.writeDoubleLE(value, offset); // tile centre (ECEF), culling metadata
    offset += 8;
  }
  header.writeFloatLE(0, offset); // minimum height
  offset += 4;
  header.writeFloatLE(0, offset); // maximum height
  offset += 4;
  for (const value of [0, 0, 0]) {
    header.writeDoubleLE(value, offset); // bounding sphere center
    offset += 8;
  }
  header.writeDoubleLE(7_000_000, offset); // bounding sphere radius (whole-earth safe)
  offset += 8;
  for (const value of [0, 0, 0]) {
    header.writeDoubleLE(value, offset); // horizon occlusion point
    offset += 8;
  }

  // Four corners of the tile in the 0..32767 quantized u/v/height grid.
  const u = [0, 32767, 0, 32767];
  const v = [0, 0, 32767, 32767];
  const height = [0, 0, 0, 0];
  const vertexData = Buffer.alloc(4 + 3 * 2 * u.length);
  vertexData.writeUInt32LE(u.length, 0);
  writeZigZagDeltas(vertexData, 4, u);
  writeZigZagDeltas(vertexData, 4 + 2 * u.length, v);
  writeZigZagDeltas(vertexData, 4 + 4 * u.length, height);

  const triangles = [
    [0, 1, 2],
    [1, 3, 2],
  ];
  const indexData = Buffer.alloc(4 + 2 * 3 * triangles.length);
  indexData.writeUInt32LE(triangles.length, 0);
  writeHighWaterMarkIndices(indexData, 4, triangles.flat());

  const edges = [
    [0, 2], // west
    [0, 1], // south
    [1, 3], // east
    [2, 3], // north
  ];
  const edgeChunks = edges.map((indices) => {
    const buffer = Buffer.alloc(4 + 2 * indices.length);
    buffer.writeUInt32LE(indices.length, 0);
    indices.forEach((index, position) => buffer.writeUInt16LE(index, 4 + 2 * position));
    return buffer;
  });

  return Buffer.concat([header, vertexData, indexData, ...edgeChunks]);
}

/**
 * Encode a solid-colour 8-bit RGB PNG of the given size with `node:zlib`.
 *
 * Cesium's `UrlTemplateImageryProvider` uploads whatever the tile URL returns to
 * a texture; a real decodable PNG is what makes that a real GPU upload rather
 * than a decode error the spec would then have to tolerate.
 */
export function buildSolidPng(size = 256, rgb = [10, 58, 92]) {
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let row = 0; row < size; row += 1) {
    const rowStart = row * stride;
    raw[rowStart] = 0; // filter type: none
    for (let column = 0; column < size; column += 1) {
      const pixel = rowStart + 1 + column * 3;
      raw[pixel] = rgb[0];
      raw[pixel + 1] = rgb[1];
      raw[pixel + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(payload, type) {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(payload.byteLength, 0);
  head.writeUInt32LE(type, 4);
  return Buffer.concat([head, payload]);
}

function padTo4(buffer, fill) {
  const remainder = buffer.byteLength % 4;
  if (remainder === 0) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(4 - remainder, fill)]);
}

function writeZigZagDeltas(buffer, byteOffset, values) {
  let previous = 0;
  values.forEach((value, index) => {
    const delta = value - previous;
    previous = value;
    buffer.writeUInt16LE(((delta << 1) ^ (delta >> 31)) & 0xffff, byteOffset + index * 2);
  });
}

function writeHighWaterMarkIndices(buffer, byteOffset, indices) {
  let highest = 0;
  indices.forEach((index, position) => {
    buffer.writeUInt16LE(highest - index, byteOffset + position * 2);
    if (index === highest) highest += 1;
  });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.byteLength, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 0);
  return Buffer.concat([length, typeBytes, payload, crc]);
}
