import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { decodeTerrainRgbElevation, decodeTerrariumElevation } from "../src/core/terrain-elevation.js";
import {
  HonuaQuantizedMeshError,
  QUANTIZED_MESH_EXTENSION_METADATA,
  QUANTIZED_MESH_EXTENSION_OCT_VERTEX_NORMALS,
  QUANTIZED_MESH_EXTENSION_WATER_MASK,
  QUANTIZED_MESH_MAX_COORD,
  applyCesiumScenePrimitives,
  createProtectedSceneAssetSession,
  createQuantizedMeshTerrainClient,
  decodeQuantizedMeshTile,
  encodeQuantizedMeshTile,
  isQuantizedMeshTileAvailable,
  parseQuantizedMeshLayerJson,
  resolveQuantizedMeshTileUrl,
  sampleQuantizedMeshElevation,
  validateQuantizedMeshTile,
} from "../src/scene-workspace/index.js";

function buildSlopedTileBinary(
  options: { readonly includeNormals?: boolean; readonly indices?: readonly number[] } = {},
): Uint8Array {
  // 2x2 unit tile covering [0, 32767]^2 with linear slope z(u, v) = 100 + 200*u + 100*v (range 100..400m)
  // Corners: (0,0)=100m, (1,0)=300m, (0,1)=200m, (1,1)=400m
  const max = QUANTIZED_MESH_MAX_COORD;
  const h = (meters: number) => Math.round(((meters - 100) / 300) * max);
  const normals = options.includeNormals ? [0, 0, 1, 0.1, 0.2, 0.974679, -0.2, 0.1, 0.974679, 0, 0, 1] : undefined;

  return encodeQuantizedMeshTile({
    header: {
      centerX: 1_000_000,
      centerY: -4_500_000,
      centerZ: 3_800_000,
      minimumHeight: 100,
      maximumHeight: 400,
      boundingSphereCenterX: 1_000_000,
      boundingSphereCenterY: -4_500_000,
      boundingSphereCenterZ: 3_800_000,
      boundingSphereRadius: 25_000,
      horizonOcclusionPointX: 0.15,
      horizonOcclusionPointY: -0.7,
      horizonOcclusionPointZ: 0.6,
    },
    u: [0, max, 0, max],
    v: [0, 0, max, max],
    height: [h(100), h(300), h(200), h(400)],
    indices: options.indices ?? [0, 1, 2, 1, 3, 2],
    edgeIndices: {
      west: [0, 2],
      south: [0, 1],
      east: [1, 3],
      north: [2, 3],
    },
    ...(normals ? { vertexNormals: normals } : {}),
    waterMask: new Uint8Array([0]),
    metadata: { source: "honua-dem-fixture" },
  });
}

describe("quantized-mesh 1.0 terrain client, decoder, validator, and Terrain-RGB coexistence", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      await closers.pop()?.();
    }
  });

  it("parses and validates layer.json manifests while rejecting Terrain-RGB tile.json payloads", () => {
    const manifest = parseQuantizedMeshLayerJson({
      tilejson: "2.1.0",
      format: "quantized-mesh-1.0",
      version: "1.1.0",
      scheme: "tms",
      projection: "EPSG:4326",
      tiles: ["{z}/{x}/{y}.terrain?v={version}"],
      bounds: [-123.0, 37.0, -121.5, 38.5],
      minzoom: 0,
      maxzoom: 12,
      extensions: ["octvertexnormals"],
      available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]],
    });

    expect(manifest.format).toBe("quantized-mesh-1.0");
    expect(manifest.extensions).toEqual(["octvertexnormals"]);
    expect(isQuantizedMeshTileAvailable(manifest, { z: 0, x: 1, y: 0 })).toBe(true);
    expect(isQuantizedMeshTileAvailable(manifest, { z: 0, x: 2, y: 0 })).toBe(false);
    expect(resolveQuantizedMeshTileUrl(manifest, "https://terrain.example/terrain/dem", { z: 0, x: 1, y: 0 })).toBe(
      "https://terrain.example/terrain/dem/0/1/0.terrain?v=1.1.0",
    );

    expect(() =>
      parseQuantizedMeshLayerJson({
        tilejson: "3.0.0",
        format: "png",
        tiles: ["{z}/{x}/{y}.png"],
      }),
    ).toThrow(HonuaQuantizedMeshError);

    expect(() => createQuantizedMeshTerrainClient({ url: "https://terrain.example/terrain/dem/tile.json" })).toThrow(
      /Terrain-RGB/,
    );
  });

  it("rejects triangle ordering that cannot be represented without reindexing vertices", () => {
    expect(() => buildSlopedTileBinary({ indices: [0, 2, 1] })).toThrow(/high-water-mark order/);
  });

  it("rejects metadata JSON lengths larger than the extension payload", () => {
    const bytes = buildSlopedTileBinary();
    const jsonLength = new TextEncoder().encode(JSON.stringify({ source: "honua-dem-fixture" })).length;
    const offset = bytes.byteLength - jsonLength - 4;
    new DataView(bytes.buffer).setUint32(offset, jsonLength + 1, true);
    expect(() => decodeQuantizedMeshTile(bytes)).toThrow(/extension bounds/);
  });

  it("round-trips binary .terrain tiles with zig-zag vertices, high-water-mark indices, edge skirts, octvertexnormals, watermask, and metadata", () => {
    const bytes = buildSlopedTileBinary({ includeNormals: true });
    const decoded = decodeQuantizedMeshTile(bytes);

    expect(decoded.vertexCount).toBe(4);
    expect(decoded.triangleCount).toBe(2);
    expect(Array.from(decoded.indices)).toEqual([0, 1, 2, 1, 3, 2]);
    expect(Array.from(decoded.edgeIndices.west)).toEqual([0, 2]);
    expect(Array.from(decoded.edgeIndices.east)).toEqual([1, 3]);
    expect(decoded.extensionsPresent).toEqual([
      QUANTIZED_MESH_EXTENSION_OCT_VERTEX_NORMALS,
      QUANTIZED_MESH_EXTENSION_WATER_MASK,
      QUANTIZED_MESH_EXTENSION_METADATA,
    ]);
    expect(decoded.waterMask).toEqual(new Uint8Array([0]));
    expect(decoded.metadata).toEqual({ source: "honua-dem-fixture" });
    expect(decoded.vertexNormals?.length).toBe(12);

    const validation = validateQuantizedMeshTile(decoded);
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);

    // Known-answer elevation sampling on the sloped plane z(u, v) = 100 + 200u + 100v
    expect(sampleQuantizedMeshElevation(decoded, 0, 0)).toBeCloseTo(100, 1);
    expect(sampleQuantizedMeshElevation(decoded, 1, 1)).toBeCloseTo(400, 1);
    expect(sampleQuantizedMeshElevation(decoded, 0.5, 0.5)).toBeCloseTo(250, 1);
    expect(sampleQuantizedMeshElevation(decoded, 0.25, 0.75)).toBeCloseTo(225, 1);
    expect(sampleQuantizedMeshElevation(decoded, -0.1, 0.5)).toBeUndefined();
  });

  it("fetches public and protected quantized-mesh terrain endpoints and rejects raster Terrain-RGB responses", async () => {
    const validTile = buildSlopedTileBinary({ includeNormals: true });
    const receivedAcceptHeaders: string[] = [];

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/terrain/protected/access-envelope") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            sceneId: "protected-dem",
            token: "qm-secret-token",
            expiresAt: "2099-01-01T00:10:00Z",
            refreshAfter: "2099-01-01T00:08:00Z",
            contractVersion: "2026-08-v1",
            allowedMethods: ["GET", "HEAD"],
            transports: [{ kind: "header", name: "X-Honua-Token", valueTemplate: "{token}", preferred: true }],
            assetScopes: [
              {
                scheme: "http",
                host: "127.0.0.1",
                port: (server.address() as AddressInfo).port,
                pathPrefix: "/terrain/protected/",
              },
            ],
          }),
        );
        return;
      }

      if (url.pathname.startsWith("/terrain/protected/")) {
        if (req.headers["x-honua-token"] !== "qm-secret-token") {
          res.writeHead(401);
          res.end();
          return;
        }
      }

      if (url.pathname.endsWith("/layer.json")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            tilejson: "2.1.0",
            format: "quantized-mesh-1.0",
            version: "1.0.0",
            scheme: "tms",
            projection: "EPSG:4326",
            tiles: ["{z}/{x}/{y}.terrain"],
            bounds: [-180, -90, 180, 90],
            minzoom: 0,
            maxzoom: 2,
            extensions: ["octvertexnormals"],
            available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]],
          }),
        );
        return;
      }

      if (url.pathname.endsWith("/0/0/0.terrain")) {
        receivedAcceptHeaders.push(String(req.headers.accept ?? ""));
        res.writeHead(200, { "content-type": "application/vnd.quantized-mesh;extensions=octvertexnormals" });
        res.end(validTile);
        return;
      }

      if (url.pathname.endsWith("/0/1/0.terrain")) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    closers.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    );

    // Public quantized-mesh client
    const publicClient = createQuantizedMeshTerrainClient({ url: `${origin}/terrain/public` });
    const tile = await publicClient.getTile({ z: 0, x: 0, y: 0, requestVertexNormals: true });
    expect(tile.vertexNormals).toBeDefined();
    expect(receivedAcceptHeaders[0]).toContain("octvertexnormals");
    await expect(publicClient.getTile({ z: 0, x: 1, y: 0 })).rejects.toMatchObject({ code: "unsupported-format" });
    await expect(publicClient.getTile({ z: 1, x: 0, y: 0 })).rejects.toMatchObject({ code: "tile-unavailable" });

    // Protected quantized-mesh client via host-bound session
    const session = createProtectedSceneAssetSession({
      sceneId: "protected-dem",
      affordance: {
        method: "POST",
        path: "/terrain/protected/access-envelope",
        origin,
        pathPrefix: "/terrain/protected/",
      },
      execute: async <T = unknown>(method: string, path: string): Promise<T> => {
        const res = await fetch(`${origin}${path}`, { method });
        return (await res.json()) as T;
      },
    });
    const protectedClient = createQuantizedMeshTerrainClient({
      url: `${origin}/terrain/protected/layer.json`,
      session,
    });
    const protectedTile = await protectedClient.getTile({ z: 0, x: 0, y: 0, requestVertexNormals: true });
    expect(sampleQuantizedMeshElevation(protectedTile, 0.5, 0.5)).toBeCloseTo(250, 1);
    session.dispose();
  });

  it("keeps Terrain-RGB/Terrarium decoding intact alongside quantized-mesh while Cesium fails closed on terrain-rgb", async () => {
    expect(decodeTerrainRgbElevation(1, 134, 160)).toBeCloseTo(0, 2);
    expect(decodeTerrariumElevation(128, 0, 0)).toBeCloseTo(0, 2);

    const outcome = await applyCesiumScenePrimitives(
      {
        camera: {
          positionCartographic: { longitude: 0, latitude: 0, height: 1000 },
          heading: 0,
          pitch: -1.5,
          roll: 0,
          setView: () => undefined,
        },
        scene: {
          primitives: {
            add: (p: unknown) => p,
            remove: () => true,
            contains: () => false,
          },
        },
      },
      [
        {
          kind: "elevation-source",
          id: "rgb-dem",
          sourceId: "rgb-dem",
          protocol: "terrain-rgb",
          url: "https://terrain.example/dem/{z}/{x}/{y}.png",
        },
      ],
    );
    expect(outcome.status).toBe("unsupported");
  });
});
