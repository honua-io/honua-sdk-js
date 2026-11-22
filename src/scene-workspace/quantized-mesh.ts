/**
 * Quantized-Mesh 1.0 terrain client, `layer.json` manifest validator, binary
 * `.terrain` tile decoder/encoder/validator (including `octvertexnormals`),
 * and barycentric elevation sampler.
 *
 * Pure and DOM-free: complements Terrain-RGB (`src/core/terrain-elevation.ts`)
 * without importing CesiumJS statically. Supports both public terrain routes
 * and host-bound {@link SceneProtectedAssetSession} requests.
 *
 * @experimental Held back from the beta `@honua/app-platform/scene-workspace`
 *   tier while server quantized-mesh terrain qualification completes.
 * @module
 */

import type { SceneProtectedAssetSession } from "./scene-access-session.js";

/** Quantized-Mesh 1.0 extension identifiers. */
export const QUANTIZED_MESH_EXTENSION_OCT_VERTEX_NORMALS = 1;
export const QUANTIZED_MESH_EXTENSION_WATER_MASK = 2;
export const QUANTIZED_MESH_EXTENSION_METADATA = 4;

/** Maximum quantized coordinate value (15-bit unsigned range). */
export const QUANTIZED_MESH_MAX_COORD = 32_767;

const HEADER_BYTES = 88;
const INDEX_16_VERTEX_THRESHOLD = 65_536;
const NORMAL_UNIT_LENGTH_TOLERANCE = 0.05;
const ACCEPTED_TERRAIN_FORMAT = "quantized-mesh-1.0";

/** Typed error for quantized-mesh manifest, transport, or binary decode failures. */
export class HonuaQuantizedMeshError extends Error {
  public readonly code: "invalid-manifest" | "unsupported-format" | "tile-unavailable" | "invalid-tile" | "http-error";
  public readonly statusCode?: number;

  public constructor(
    code: HonuaQuantizedMeshError["code"],
    message: string,
    options: { readonly statusCode?: number; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HonuaQuantizedMeshError";
    this.code = code;
    this.statusCode = options.statusCode;
  }
}

/** One tile availability rectangle in `layer.json` (`available[z]`). */
export interface QuantizedMeshAvailabilityRect {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
}

/** Validated Quantized-Mesh 1.0 `layer.json` manifest. */
export interface QuantizedMeshLayerManifest {
  readonly tilejson: string;
  readonly format: "quantized-mesh-1.0";
  readonly version: string;
  readonly scheme: "tms" | "xyz";
  readonly projection: string;
  readonly tiles: readonly string[];
  readonly bounds: readonly [number, number, number, number];
  readonly minzoom: number;
  readonly maxzoom: number;
  readonly extensions: readonly string[];
  readonly attribution?: string;
  readonly available?: readonly (readonly QuantizedMeshAvailabilityRect[])[];
}

/** Decoded 88-byte Quantized-Mesh 1.0 binary header. */
export interface QuantizedMeshHeader {
  readonly centerX: number;
  readonly centerY: number;
  readonly centerZ: number;
  readonly minimumHeight: number;
  readonly maximumHeight: number;
  readonly boundingSphereCenterX: number;
  readonly boundingSphereCenterY: number;
  readonly boundingSphereCenterZ: number;
  readonly boundingSphereRadius: number;
  readonly horizonOcclusionPointX: number;
  readonly horizonOcclusionPointY: number;
  readonly horizonOcclusionPointZ: number;
}

/** Edge vertex index arrays used for skirt stitching across neighboring tiles. */
export interface QuantizedMeshEdgeIndices {
  readonly west: Uint16Array | Uint32Array;
  readonly south: Uint16Array | Uint32Array;
  readonly east: Uint16Array | Uint32Array;
  readonly north: Uint16Array | Uint32Array;
}

/** Fully decoded Quantized-Mesh 1.0 `.terrain` tile. */
export interface DecodedQuantizedMeshTile {
  readonly header: QuantizedMeshHeader;
  readonly vertexCount: number;
  readonly u: Uint16Array;
  readonly v: Uint16Array;
  readonly height: Uint16Array;
  readonly elevationsMeters: Float32Array;
  readonly triangleCount: number;
  readonly indices: Uint16Array | Uint32Array;
  readonly edgeIndices: QuantizedMeshEdgeIndices;
  /** Oct-decoded unit vertex normals (`[nx, ny, nz, ...]`, length `vertexCount * 3`) when extension 1 is present. */
  readonly vertexNormals?: Float32Array;
  readonly waterMask?: Uint8Array;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly extensionsPresent: readonly number[];
}

/** Result of {@link validateQuantizedMeshTile}. */
export interface QuantizedMeshValidationResult {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

/** Input for {@link encodeQuantizedMeshTile}. */
export interface QuantizedMeshEncodeInput {
  readonly header: QuantizedMeshHeader;
  readonly u: readonly number[];
  readonly v: readonly number[];
  readonly height: readonly number[];
  readonly indices: readonly number[];
  readonly edgeIndices?: {
    readonly west?: readonly number[];
    readonly south?: readonly number[];
    readonly east?: readonly number[];
    readonly north?: readonly number[];
  };
  /** Optional unit vertex normals (`[nx, ny, nz, ...]`, length `vertexCount * 3`) encoded as `octvertexnormals`. */
  readonly vertexNormals?: readonly number[];
  readonly waterMask?: Uint8Array;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Options for {@link createQuantizedMeshTerrainClient}. */
export interface QuantizedMeshTerrainClientOptions {
  /** Base terrain URL (e.g. `https://host/terrain/dem` or `.../layer.json`). */
  readonly url: string;
  /** Optional host-bound session for protected terrain routes. */
  readonly session?: SceneProtectedAssetSession;
  readonly fetchFn?: typeof fetch;
}

/** Tile coordinate request for {@link QuantizedMeshTerrainClient.getTile}. */
export interface QuantizedMeshTileCoord {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly requestVertexNormals?: boolean;
}

/** Client for Quantized-Mesh 1.0 terrain endpoints (`layer.json` + `.terrain`). */
export interface QuantizedMeshTerrainClient {
  readonly baseUrl: string;
  readonly layerJsonUrl: string;
  getLayerManifest(signal?: AbortSignal): Promise<QuantizedMeshLayerManifest>;
  getTile(coord: QuantizedMeshTileCoord, signal?: AbortSignal): Promise<DecodedQuantizedMeshTile>;
}

/** Parse and strictly validate a Quantized-Mesh 1.0 `layer.json` document. Pure. */
export function parseQuantizedMeshLayerJson(raw: unknown): QuantizedMeshLayerManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HonuaQuantizedMeshError("invalid-manifest", "Quantized-mesh layer.json must be a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  const format = typeof record.format === "string" ? record.format.trim() : "";
  if (format !== ACCEPTED_TERRAIN_FORMAT) {
    throw new HonuaQuantizedMeshError(
      "unsupported-format",
      `Unsupported terrain manifest format "${format || "(missing)"}"; expected "${ACCEPTED_TERRAIN_FORMAT}".`,
    );
  }
  const tiles = Array.isArray(record.tiles)
    ? record.tiles.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
  if (tiles.length === 0 || !tiles[0]!.includes("{z}") || !tiles[0]!.includes("{x}") || !tiles[0]!.includes("{y}")) {
    throw new HonuaQuantizedMeshError(
      "invalid-manifest",
      "layer.json must declare at least one tile URL template containing {z}, {x}, and {y}.",
    );
  }
  const bounds = parseBounds(record.bounds);
  const minzoom = typeof record.minzoom === "number" && Number.isInteger(record.minzoom) ? record.minzoom : 0;
  const maxzoom = typeof record.maxzoom === "number" && Number.isInteger(record.maxzoom) ? record.maxzoom : minzoom;
  if (minzoom < 0 || maxzoom < minzoom) {
    throw new HonuaQuantizedMeshError("invalid-manifest", `Invalid zoom range [${minzoom}, ${maxzoom}].`);
  }
  const scheme = record.scheme === "xyz" ? "xyz" : "tms";
  const extensions = Array.isArray(record.extensions)
    ? record.extensions.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
  const available = parseAvailability(record.available);
  return {
    tilejson: typeof record.tilejson === "string" ? record.tilejson : "2.1.0",
    format: ACCEPTED_TERRAIN_FORMAT,
    version: typeof record.version === "string" && record.version.trim() !== "" ? record.version.trim() : "1.0.0",
    scheme,
    projection: typeof record.projection === "string" ? record.projection : "EPSG:4326",
    tiles,
    bounds,
    minzoom,
    maxzoom,
    extensions,
    ...(typeof record.attribution === "string" ? { attribution: record.attribution } : {}),
    ...(available ? { available } : {}),
  };
}

/** Check whether a tile coordinate falls within the manifest zoom range and `available` rectangles. */
export function isQuantizedMeshTileAvailable(
  manifest: QuantizedMeshLayerManifest,
  coord: { readonly z: number; readonly x: number; readonly y: number },
): boolean {
  if (!Number.isInteger(coord.z) || !Number.isInteger(coord.x) || !Number.isInteger(coord.y)) return false;
  if (coord.z < manifest.minzoom || coord.z > manifest.maxzoom || coord.x < 0 || coord.y < 0) return false;
  if (!manifest.available) return true;
  const levelRects = manifest.available[coord.z];
  if (!levelRects || levelRects.length === 0) return false;
  return levelRects.some(
    (rect) => coord.x >= rect.startX && coord.x <= rect.endX && coord.y >= rect.startY && coord.y <= rect.endY,
  );
}

/** Resolve a `.terrain` tile URL from `layer.json` template + base URL. */
export function resolveQuantizedMeshTileUrl(
  manifest: QuantizedMeshLayerManifest,
  baseUrl: string,
  coord: { readonly z: number; readonly x: number; readonly y: number },
): string {
  const template = manifest.tiles[0]!;
  const substituted = template
    .replaceAll("{z}", String(coord.z))
    .replaceAll("{x}", String(coord.x))
    .replaceAll("{y}", String(coord.y))
    .replaceAll("{version}", encodeURIComponent(manifest.version));
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(substituted, normalizedBase).toString();
}

/** Decode a binary Quantized-Mesh 1.0 `.terrain` payload into typed arrays + extensions. Pure. */
export function decodeQuantizedMeshTile(input: ArrayBuffer | Uint8Array): DecodedQuantizedMeshTile {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < HEADER_BYTES + 4) {
    throw new HonuaQuantizedMeshError("invalid-tile", "Quantized-mesh tile is truncated before vertex header.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readHeader(view);
  let offset = HEADER_BYTES;

  const vertexCount = view.getUint32(offset, true);
  offset += 4;
  const vertexBytesNeeded = vertexCount * 6;
  if (offset + vertexBytesNeeded > bytes.byteLength) {
    throw new HonuaQuantizedMeshError("invalid-tile", "Quantized-mesh tile is truncated in vertex buffer.");
  }
  const u = decodeZigZagArray(view, offset, vertexCount);
  offset += vertexCount * 2;
  const v = decodeZigZagArray(view, offset, vertexCount);
  offset += vertexCount * 2;
  const height = decodeZigZagArray(view, offset, vertexCount);
  offset += vertexCount * 2;

  const elevationsMeters = dequantizeHeights(height, header.minimumHeight, header.maximumHeight);
  const use32BitIndices = vertexCount > INDEX_16_VERTEX_THRESHOLD;
  const indexBytes = use32BitIndices ? 4 : 2;
  offset = alignOffset(offset, indexBytes);

  if (offset + 4 > bytes.byteLength) {
    throw new HonuaQuantizedMeshError("invalid-tile", "Quantized-mesh tile is truncated before triangleCount.");
  }
  const triangleCount = view.getUint32(offset, true);
  offset += 4;
  const indexCount = triangleCount * 3;
  if (offset + indexCount * indexBytes > bytes.byteLength) {
    throw new HonuaQuantizedMeshError("invalid-tile", "Quantized-mesh tile is truncated in triangle index buffer.");
  }
  const indices = decodeHighWaterMarkIndices(view, offset, indexCount, use32BitIndices);
  offset += indexCount * indexBytes;

  const edgeRead = readAllEdgeIndices(view, offset, bytes.byteLength, use32BitIndices);
  offset = edgeRead.nextOffset;

  const extensions = decodeExtensions(bytes, view, offset, vertexCount);
  return {
    header,
    vertexCount,
    u,
    v,
    height,
    elevationsMeters,
    triangleCount,
    indices,
    edgeIndices: edgeRead.edges,
    ...(extensions.vertexNormals ? { vertexNormals: extensions.vertexNormals } : {}),
    ...(extensions.waterMask ? { waterMask: extensions.waterMask } : {}),
    ...(extensions.metadata ? { metadata: extensions.metadata } : {}),
    extensionsPresent: extensions.present,
  };
}

/** Validate geometric and binary invariants of a decoded quantized-mesh tile. Pure. */
export function validateQuantizedMeshTile(tile: DecodedQuantizedMeshTile): QuantizedMeshValidationResult {
  const issues: string[] = [];
  if (!Number.isFinite(tile.header.minimumHeight) || !Number.isFinite(tile.header.maximumHeight)) {
    issues.push("Header heights must be finite.");
  }
  if (tile.header.minimumHeight > tile.header.maximumHeight) {
    issues.push("Header minimumHeight exceeds maximumHeight.");
  }
  if (!Number.isFinite(tile.header.boundingSphereRadius) || tile.header.boundingSphereRadius < 0) {
    issues.push("Header boundingSphereRadius must be finite and non-negative.");
  }
  for (let i = 0; i < tile.vertexCount; i += 1) {
    if (
      tile.u[i]! > QUANTIZED_MESH_MAX_COORD ||
      tile.v[i]! > QUANTIZED_MESH_MAX_COORD ||
      tile.height[i]! > QUANTIZED_MESH_MAX_COORD
    ) {
      issues.push(`Vertex ${i} coordinate exceeds ${QUANTIZED_MESH_MAX_COORD}.`);
      break;
    }
  }
  for (let i = 0; i < tile.indices.length; i += 1) {
    if (tile.indices[i]! >= tile.vertexCount) {
      issues.push(`Triangle index ${i} (${tile.indices[i]}) is out of range for vertexCount ${tile.vertexCount}.`);
      break;
    }
  }
  const edgeLists = [tile.edgeIndices.west, tile.edgeIndices.south, tile.edgeIndices.east, tile.edgeIndices.north];
  for (const edge of edgeLists) {
    for (let i = 0; i < edge.length; i += 1) {
      if (edge[i]! >= tile.vertexCount) {
        issues.push(`Edge index ${edge[i]} is out of range for vertexCount ${tile.vertexCount}.`);
        break;
      }
    }
  }
  if (tile.vertexNormals) {
    if (tile.vertexNormals.length !== tile.vertexCount * 3) {
      issues.push("vertexNormals length does not match vertexCount * 3.");
    } else {
      for (let i = 0; i < tile.vertexCount; i += 1) {
        const nx = tile.vertexNormals[i * 3]!;
        const ny = tile.vertexNormals[i * 3 + 1]!;
        const nz = tile.vertexNormals[i * 3 + 2]!;
        const len = Math.hypot(nx, ny, nz);
        if (!Number.isFinite(len) || Math.abs(len - 1) > NORMAL_UNIT_LENGTH_TOLERANCE) {
          issues.push(`Vertex normal ${i} is not unit length (${len}).`);
          break;
        }
      }
    }
  }
  return { valid: issues.length === 0, issues };
}

/**
 * Sample elevation (metres) at normalized tile coordinates `(uNorm, vNorm) ∈ [0, 1]²`
 * using barycentric interpolation across the decoded triangles. Pure.
 */
export function sampleQuantizedMeshElevation(
  tile: DecodedQuantizedMeshTile,
  uNorm: number,
  vNorm: number,
): number | undefined {
  if (!Number.isFinite(uNorm) || !Number.isFinite(vNorm) || uNorm < 0 || uNorm > 1 || vNorm < 0 || vNorm > 1) {
    return undefined;
  }
  const targetU = uNorm * QUANTIZED_MESH_MAX_COORD;
  const targetV = vNorm * QUANTIZED_MESH_MAX_COORD;
  const eps = 1e-6;

  for (let t = 0; t < tile.triangleCount; t += 1) {
    const i0 = tile.indices[t * 3]!;
    const i1 = tile.indices[t * 3 + 1]!;
    const i2 = tile.indices[t * 3 + 2]!;
    const x0 = tile.u[i0]!;
    const y0 = tile.v[i0]!;
    const x1 = tile.u[i1]!;
    const y1 = tile.v[i1]!;
    const x2 = tile.u[i2]!;
    const y2 = tile.v[i2]!;
    const denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(denom) < eps) continue;
    const w0 = ((y1 - y2) * (targetU - x2) + (x2 - x1) * (targetV - y2)) / denom;
    const w1 = ((y2 - y0) * (targetU - x2) + (x0 - x2) * (targetV - y2)) / denom;
    const w2 = 1 - w0 - w1;
    if (w0 >= -eps && w1 >= -eps && w2 >= -eps) {
      return w0 * tile.elevationsMeters[i0]! + w1 * tile.elevationsMeters[i1]! + w2 * tile.elevationsMeters[i2]!;
    }
  }
  return undefined;
}

/** Encode a Quantized-Mesh 1.0 binary `.terrain` payload (with optional extensions). Pure. */
export function encodeQuantizedMeshTile(input: QuantizedMeshEncodeInput): Uint8Array {
  const vertexCount = input.u.length;
  if (input.v.length !== vertexCount || input.height.length !== vertexCount) {
    throw new HonuaQuantizedMeshError("invalid-tile", "u, v, and height arrays must have equal length.");
  }
  if (input.indices.length % 3 !== 0) {
    throw new HonuaQuantizedMeshError("invalid-tile", "indices length must be a multiple of 3.");
  }
  const use32Bit = vertexCount > INDEX_16_VERTEX_THRESHOLD;
  const indexBytes = use32Bit ? 4 : 2;
  const triangleCount = input.indices.length / 3;
  const west = input.edgeIndices?.west ?? [];
  const south = input.edgeIndices?.south ?? [];
  const east = input.edgeIndices?.east ?? [];
  const north = input.edgeIndices?.north ?? [];

  const extBlocks = buildExtensionBlocks(input, vertexCount);
  const vertexSectionEnd = HEADER_BYTES + 4 + vertexCount * 6;
  const alignedIndexStart = alignOffset(vertexSectionEnd, indexBytes);
  const edgeBytes = 16 + (west.length + south.length + east.length + north.length) * indexBytes;
  const extBytes = extBlocks.reduce((sum, block) => sum + 5 + block.payload.byteLength, 0);
  const totalBytes = alignedIndexStart + 4 + input.indices.length * indexBytes + edgeBytes + extBytes;

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  writeHeader(view, input.header);

  let offset = HEADER_BYTES;
  view.setUint32(offset, vertexCount, true);
  offset += 4;
  offset = writeZigZagArray(view, offset, input.u);
  offset = writeZigZagArray(view, offset, input.v);
  offset = writeZigZagArray(view, offset, input.height);

  offset = alignedIndexStart;
  view.setUint32(offset, triangleCount, true);
  offset += 4;
  offset = writeHighWaterMarkIndices(view, offset, input.indices, use32Bit);

  for (const edge of [west, south, east, north]) {
    view.setUint32(offset, edge.length, true);
    offset += 4;
    for (const idx of edge) {
      if (use32Bit) view.setUint32(offset, idx, true);
      else view.setUint16(offset, idx, true);
      offset += indexBytes;
    }
  }

  for (const block of extBlocks) {
    view.setUint8(offset, block.id);
    view.setUint32(offset + 1, block.payload.byteLength, true);
    out.set(block.payload, offset + 5);
    offset += 5 + block.payload.byteLength;
  }

  return out;
}

/** Create a client for reading `layer.json` and binary `.terrain` tiles from a Honua terrain endpoint. */
export function createQuantizedMeshTerrainClient(
  options: QuantizedMeshTerrainClientOptions,
): QuantizedMeshTerrainClient {
  const normalized = normalizeTerrainBaseUrls(options.url);
  const fetchFn = options.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  let cachedManifest: QuantizedMeshLayerManifest | undefined;

  const fetchUrl = (url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> => {
    if (options.session) {
      return options.session.fetchAsset({ url, method: "GET", headers, signal });
    }
    return fetchFn(url, { method: "GET", headers, signal });
  };

  const client: QuantizedMeshTerrainClient = {
    baseUrl: normalized.baseUrl,
    layerJsonUrl: normalized.layerJsonUrl,
    async getLayerManifest(signal?: AbortSignal): Promise<QuantizedMeshLayerManifest> {
      if (cachedManifest) return cachedManifest;
      const response = await fetchUrl(normalized.layerJsonUrl, { Accept: "application/json" }, signal);
      if (!response.ok) {
        throw new HonuaQuantizedMeshError("http-error", `layer.json request failed with HTTP ${response.status}.`, {
          statusCode: response.status,
        });
      }
      const manifest = parseQuantizedMeshLayerJson(await response.json());
      cachedManifest = manifest;
      return manifest;
    },
    async getTile(coord: QuantizedMeshTileCoord, signal?: AbortSignal): Promise<DecodedQuantizedMeshTile> {
      const manifest = await client.getLayerManifest(signal);
      if (!isQuantizedMeshTileAvailable(manifest, coord)) {
        throw new HonuaQuantizedMeshError(
          "tile-unavailable",
          `Terrain tile ${coord.z}/${coord.x}/${coord.y} is outside layer.json availability.`,
        );
      }
      const tileUrl = resolveQuantizedMeshTileUrl(manifest, normalized.baseUrl, coord);
      const accept = coord.requestVertexNormals
        ? "application/vnd.quantized-mesh;extensions=octvertexnormals,application/octet-stream;q=0.9"
        : "application/vnd.quantized-mesh,application/octet-stream;q=0.9";
      const response = await fetchUrl(tileUrl, { Accept: accept }, signal);
      if (!response.ok) {
        throw new HonuaQuantizedMeshError("http-error", `Terrain tile request failed with HTTP ${response.status}.`, {
          statusCode: response.status,
        });
      }
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (contentType.startsWith("image/")) {
        throw new HonuaQuantizedMeshError(
          "unsupported-format",
          `Expected quantized-mesh binary tile but received raster content-type "${contentType}".`,
        );
      }
      const decoded = decodeQuantizedMeshTile(await response.arrayBuffer());
      const validation = validateQuantizedMeshTile(decoded);
      if (!validation.valid) {
        throw new HonuaQuantizedMeshError("invalid-tile", `Invalid quantized-mesh tile: ${validation.issues[0]}`);
      }
      return decoded;
    },
  };

  return client;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeTerrainBaseUrls(rawUrl: string): { readonly baseUrl: string; readonly layerJsonUrl: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new HonuaQuantizedMeshError("invalid-manifest", "Terrain base URL must be non-empty.");
  }
  if (/\/tile\.json(\?.*)?$/i.test(trimmed)) {
    throw new HonuaQuantizedMeshError(
      "unsupported-format",
      "Terrain-RGB tile.json endpoints are not quantized-mesh sources; use Terrain-RGB decoding instead.",
    );
  }
  if (/\/layer\.json$/i.test(trimmed)) {
    return { baseUrl: trimmed.slice(0, -"/layer.json".length), layerJsonUrl: trimmed };
  }
  const baseUrl = trimmed.replace(/\/+$/, "");
  return { baseUrl, layerJsonUrl: `${baseUrl}/layer.json` };
}

function parseBounds(value: unknown): readonly [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    return [-180, -90, 180, 90];
  }
  const [west, south, east, north] = value as [number, number, number, number];
  if (west >= east || south >= north) {
    throw new HonuaQuantizedMeshError(
      "invalid-manifest",
      "layer.json bounds must satisfy west < east and south < north.",
    );
  }
  return [west, south, east, north];
}

function parseAvailability(value: unknown): readonly (readonly QuantizedMeshAvailabilityRect[])[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((level) => {
    if (!Array.isArray(level)) return [];
    return level
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .map((rect) => ({
        startX: Number(rect.startX),
        startY: Number(rect.startY),
        endX: Number(rect.endX),
        endY: Number(rect.endY),
      }))
      .filter((r) => [r.startX, r.startY, r.endX, r.endY].every((n) => Number.isInteger(n) && n >= 0));
  });
}

function readHeader(view: DataView): QuantizedMeshHeader {
  return {
    centerX: view.getFloat64(0, true),
    centerY: view.getFloat64(8, true),
    centerZ: view.getFloat64(16, true),
    minimumHeight: view.getFloat32(24, true),
    maximumHeight: view.getFloat32(28, true),
    boundingSphereCenterX: view.getFloat64(32, true),
    boundingSphereCenterY: view.getFloat64(40, true),
    boundingSphereCenterZ: view.getFloat64(48, true),
    boundingSphereRadius: view.getFloat64(56, true),
    horizonOcclusionPointX: view.getFloat64(64, true),
    horizonOcclusionPointY: view.getFloat64(72, true),
    horizonOcclusionPointZ: view.getFloat64(80, true),
  };
}

function writeHeader(view: DataView, header: QuantizedMeshHeader): void {
  view.setFloat64(0, header.centerX, true);
  view.setFloat64(8, header.centerY, true);
  view.setFloat64(16, header.centerZ, true);
  view.setFloat32(24, header.minimumHeight, true);
  view.setFloat32(28, header.maximumHeight, true);
  view.setFloat64(32, header.boundingSphereCenterX, true);
  view.setFloat64(40, header.boundingSphereCenterY, true);
  view.setFloat64(48, header.boundingSphereCenterZ, true);
  view.setFloat64(56, header.boundingSphereRadius, true);
  view.setFloat64(64, header.horizonOcclusionPointX, true);
  view.setFloat64(72, header.horizonOcclusionPointY, true);
  view.setFloat64(80, header.horizonOcclusionPointZ, true);
}

function decodeZigZagArray(view: DataView, offset: number, count: number): Uint16Array {
  const out = new Uint16Array(count);
  let acc = 0;
  for (let i = 0; i < count; i += 1) {
    const raw = view.getUint16(offset + i * 2, true);
    const delta = (raw >> 1) ^ -(raw & 1);
    acc += delta;
    out[i] = acc;
  }
  return out;
}

function writeZigZagArray(view: DataView, offset: number, values: readonly number[]): number {
  let prev = 0;
  for (let i = 0; i < values.length; i += 1) {
    const current = values[i]!;
    const delta = current - prev;
    prev = current;
    const encoded = (delta << 1) ^ (delta >> 31);
    view.setUint16(offset + i * 2, encoded & 0xffff, true);
  }
  return offset + values.length * 2;
}

function dequantizeHeights(height: Uint16Array, minHeight: number, maxHeight: number): Float32Array {
  const out = new Float32Array(height.length);
  const span = maxHeight - minHeight;
  for (let i = 0; i < height.length; i += 1) {
    out[i] = minHeight + (height[i]! / QUANTIZED_MESH_MAX_COORD) * span;
  }
  return out;
}

function alignOffset(offset: number, alignment: number): number {
  const remainder = offset % alignment;
  return remainder === 0 ? offset : offset + (alignment - remainder);
}

function decodeHighWaterMarkIndices(
  view: DataView,
  offset: number,
  count: number,
  use32Bit: boolean,
): Uint16Array | Uint32Array {
  const out = use32Bit ? new Uint32Array(count) : new Uint16Array(count);
  const step = use32Bit ? 4 : 2;
  let highest = 0;
  for (let i = 0; i < count; i += 1) {
    const code = use32Bit ? view.getUint32(offset + i * step, true) : view.getUint16(offset + i * step, true);
    out[i] = highest - code;
    if (code === 0) highest += 1;
  }
  return out;
}

function writeHighWaterMarkIndices(
  view: DataView,
  offset: number,
  indices: readonly number[],
  use32Bit: boolean,
): number {
  const step = use32Bit ? 4 : 2;
  let highest = 0;
  for (let i = 0; i < indices.length; i += 1) {
    const idx = indices[i]!;
    const code = highest - idx;
    if (use32Bit) view.setUint32(offset + i * step, code, true);
    else view.setUint16(offset + i * step, code, true);
    if (code === 0) highest += 1;
  }
  return offset + indices.length * step;
}

function readAllEdgeIndices(
  view: DataView,
  startOffset: number,
  byteLength: number,
  use32Bit: boolean,
): { readonly edges: QuantizedMeshEdgeIndices; readonly nextOffset: number } {
  const step = use32Bit ? 4 : 2;
  let offset = startOffset;
  const readOne = (): Uint16Array | Uint32Array => {
    if (offset + 4 > byteLength) {
      throw new HonuaQuantizedMeshError("invalid-tile", "Quantized-mesh tile is truncated in edge indices.");
    }
    const count = view.getUint32(offset, true);
    offset += 4;
    if (offset + count * step > byteLength) {
      throw new HonuaQuantizedMeshError("invalid-tile", "Quantized-mesh tile edge index array exceeds tile bounds.");
    }
    const arr = use32Bit ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i += 1) {
      arr[i] = use32Bit ? view.getUint32(offset + i * step, true) : view.getUint16(offset + i * step, true);
    }
    offset += count * step;
    return arr;
  };
  return {
    edges: { west: readOne(), south: readOne(), east: readOne(), north: readOne() },
    nextOffset: offset,
  };
}

function decodeExtensions(
  bytes: Uint8Array,
  view: DataView,
  startOffset: number,
  vertexCount: number,
): {
  readonly vertexNormals?: Float32Array;
  readonly waterMask?: Uint8Array;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly present: readonly number[];
} {
  let offset = startOffset;
  const present: number[] = [];
  let vertexNormals: Float32Array | undefined;
  let waterMask: Uint8Array | undefined;
  let metadata: Readonly<Record<string, unknown>> | undefined;

  while (offset + 5 <= bytes.byteLength) {
    const extId = view.getUint8(offset);
    const extLength = view.getUint32(offset + 1, true);
    offset += 5;
    if (offset + extLength > bytes.byteLength) {
      throw new HonuaQuantizedMeshError("invalid-tile", `Extension ${extId} payload exceeds tile bounds.`);
    }
    present.push(extId);
    const payload = bytes.subarray(offset, offset + extLength);
    if (extId === QUANTIZED_MESH_EXTENSION_OCT_VERTEX_NORMALS) {
      vertexNormals = decodeOctVertexNormals(payload, vertexCount);
    } else if (extId === QUANTIZED_MESH_EXTENSION_WATER_MASK) {
      waterMask = new Uint8Array(payload);
    } else if (extId === QUANTIZED_MESH_EXTENSION_METADATA && extLength >= 4) {
      const jsonLength = view.getUint32(offset, true);
      const text = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 4 + jsonLength));
      metadata = JSON.parse(text) as Record<string, unknown>;
    }
    offset += extLength;
  }
  return { vertexNormals, waterMask, metadata, present };
}

function decodeOctVertexNormals(payload: Uint8Array, vertexCount: number): Float32Array {
  if (payload.byteLength < vertexCount * 2) {
    throw new HonuaQuantizedMeshError(
      "invalid-tile",
      "octvertexnormals extension length is smaller than vertexCount * 2.",
    );
  }
  const normals = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i += 1) {
    const x = (payload[i * 2]! / 255) * 2 - 1;
    const y = (payload[i * 2 + 1]! / 255) * 2 - 1;
    const z = 1 - Math.abs(x) - Math.abs(y);
    let nx = x;
    let ny = y;
    if (z < 0) {
      nx = (1 - Math.abs(y)) * (x >= 0 ? 1 : -1);
      ny = (1 - Math.abs(x)) * (y >= 0 ? 1 : -1);
    }
    const len = Math.hypot(nx, ny, z) || 1;
    normals[i * 3] = nx / len;
    normals[i * 3 + 1] = ny / len;
    normals[i * 3 + 2] = z / len;
  }
  return normals;
}

function encodeOctVertexNormals(normals: readonly number[], vertexCount: number): Uint8Array {
  if (normals.length !== vertexCount * 3) {
    throw new HonuaQuantizedMeshError("invalid-tile", "vertexNormals length must equal vertexCount * 3.");
  }
  const out = new Uint8Array(vertexCount * 2);
  for (let i = 0; i < vertexCount; i += 1) {
    let nx = normals[i * 3]!;
    let ny = normals[i * 3 + 1]!;
    let nz = normals[i * 3 + 2]!;
    const sum = Math.abs(nx) + Math.abs(ny) + Math.abs(nz) || 1;
    nx /= sum;
    ny /= sum;
    nz /= sum;
    let ox = nx;
    let oy = ny;
    if (nz < 0) {
      ox = (1 - Math.abs(ny)) * (nx >= 0 ? 1 : -1);
      oy = (1 - Math.abs(nx)) * (ny >= 0 ? 1 : -1);
    }
    out[i * 2] = Math.round(Math.min(1, Math.max(-1, ox)) * 127.5 + 127.5);
    out[i * 2 + 1] = Math.round(Math.min(1, Math.max(-1, oy)) * 127.5 + 127.5);
  }
  return out;
}

function buildExtensionBlocks(
  input: QuantizedMeshEncodeInput,
  vertexCount: number,
): Array<{ readonly id: number; readonly payload: Uint8Array }> {
  const blocks: Array<{ readonly id: number; readonly payload: Uint8Array }> = [];
  if (input.vertexNormals) {
    blocks.push({
      id: QUANTIZED_MESH_EXTENSION_OCT_VERTEX_NORMALS,
      payload: encodeOctVertexNormals(input.vertexNormals, vertexCount),
    });
  }
  if (input.waterMask) {
    blocks.push({ id: QUANTIZED_MESH_EXTENSION_WATER_MASK, payload: input.waterMask });
  }
  if (input.metadata) {
    const encoded = new TextEncoder().encode(JSON.stringify(input.metadata));
    const payload = new Uint8Array(4 + encoded.byteLength);
    new DataView(payload.buffer).setUint32(0, encoded.byteLength, true);
    payload.set(encoded, 4);
    blocks.push({ id: QUANTIZED_MESH_EXTENSION_METADATA, payload });
  }
  return blocks;
}
