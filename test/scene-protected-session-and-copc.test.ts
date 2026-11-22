import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HonuaSceneAccessSessionError,
  SceneView,
  buildSceneCopcUrl,
  createCopcRangeClient,
  createProtectedSceneAssetSession,
  normalizeScene,
  normalizeSceneResolution,
  parseCopcInfoVlr,
  parseLas14Header,
} from "../src/scene-workspace/index.js";

function buildSyntheticCopcPayload(): Uint8Array {
  const headerSize = 375;
  const vlrHeaderSize = 54;
  const copcInfoSize = 160;
  const totalBytes = headerSize + vlrHeaderSize + copcInfoSize + 1024;
  const buf = new Uint8Array(totalBytes);
  const view = new DataView(buf.buffer);

  // LASF signature
  buf[0] = 0x4c; // L
  buf[1] = 0x41; // A
  buf[2] = 0x53; // S
  buf[3] = 0x46; // F
  view.setUint8(24, 1); // versionMajor
  view.setUint8(25, 4); // versionMinor
  view.setUint16(94, headerSize, true);
  view.setUint32(96, headerSize + vlrHeaderSize + copcInfoSize, true);
  view.setUint32(100, 1, true); // vlrCount
  view.setUint8(104, 0x80 | 6); // LAZ compressed, PDRF 6
  view.setUint16(105, 30, true);
  view.setUint32(107, 0, true);
  view.setUint32(247, 125_000, true); // extended point count low
  view.setUint32(251, 0, true); // extended point count high

  // Scale & offset
  view.setFloat64(131, 0.01, true);
  view.setFloat64(139, 0.01, true);
  view.setFloat64(147, 0.01, true);
  view.setFloat64(155, -122.0, true);
  view.setFloat64(163, 37.0, true);
  view.setFloat64(171, 0.0, true);
  // Max X, Min X, Max Y, Min Y, Max Z, Min Z
  view.setFloat64(179, -122.38, true);
  view.setFloat64(187, -122.42, true);
  view.setFloat64(195, 37.81, true);
  view.setFloat64(203, 37.76, true);
  view.setFloat64(211, 240.5, true);
  view.setFloat64(219, 12.25, true);

  // VLR header at offset 375: userId = "copc", recordId = 1, length = 160
  const userId = "copc";
  for (let i = 0; i < userId.length; i += 1) {
    buf[headerSize + 2 + i] = userId.charCodeAt(i);
  }
  view.setUint16(headerSize + 18, 1, true);
  view.setUint16(headerSize + 20, copcInfoSize, true);

  const payload = headerSize + vlrHeaderSize;
  view.setFloat64(payload, -122.4, true);
  view.setFloat64(payload + 8, 37.785, true);
  view.setFloat64(payload + 16, 126.375, true);
  view.setFloat64(payload + 24, 512.0, true);
  view.setFloat64(payload + 32, 0.25, true);
  view.setUint32(payload + 40, headerSize + vlrHeaderSize + copcInfoSize, true);
  view.setUint32(payload + 44, 0, true);
  view.setUint32(payload + 48, 256, true);
  view.setUint32(payload + 52, 0, true);
  view.setFloat64(payload + 56, 100.0, true);
  view.setFloat64(payload + 64, 500.0, true);

  return buf;
}

describe("protected scene asset session, separation of serving format vs content kind, and COPC range access", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    while (closers.length > 0) {
      await closers.pop()?.();
    }
  });

  async function startSceneServer(options: { readonly allowRedirects?: boolean; readonly baseTime?: number } = {}) {
    const copcBytes = buildSyntheticCopcPayload();
    let tokenSeq = 0;
    let activeToken = "";
    let envelopeRequests = 0;
    const seenHeaders: Array<Record<string, string | string[] | undefined>> = [];

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      seenHeaders.push(req.headers);

      if (req.method === "POST" && url.pathname === "/scenes/protected-city/access-envelope") {
        envelopeRequests += 1;
        tokenSeq += 1;
        activeToken = `secret-scene-token-${tokenSeq}`;
        const base = options.baseTime ?? Date.UTC(2026, 10, 21, 0, 0, 0);
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(
          JSON.stringify({
            sceneId: "protected-city",
            token: activeToken,
            expiresAt: new Date(base + 300_000 * tokenSeq).toISOString(),
            refreshAfter: new Date(base + 180_000 * tokenSeq).toISOString(),
            contractVersion: "2026-08-v1",
            allowedMethods: ["GET", "HEAD"],
            transports: [{ kind: "header", name: "X-Honua-Token", valueTemplate: "{token}", preferred: true }],
            assetScopes: [
              {
                scheme: "http",
                host: "127.0.0.1",
                port: (server.address() as AddressInfo).port,
                pathPrefix: "/scenes/protected-city/",
              },
            ],
          }),
        );
        return;
      }

      if (url.pathname === "/api/scenes/protected-city/resolve") {
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            sceneId: "protected-city",
            tilesetUrl: `${origin}/scenes/protected-city/tileset.json`,
            copcUrl: `${origin}/scenes/protected-city/copc`,
            servingFormat: "3d-tiles",
            contentKind: "buildings",
            capabilities: ["3d-tiles", "copc"],
            auth: { requiresAuthentication: true, scheme: "scene-access-envelope" },
            accessAffordance: {
              method: "POST",
              path: "/scenes/protected-city/access-envelope",
              origin,
              pathPrefix: "/scenes/protected-city/",
              transport: "header",
              headerName: "X-Honua-Token",
              allowRedirects: options.allowRedirects === true,
            },
            endpoints: [
              {
                name: "tileset",
                url: `${origin}/scenes/protected-city/tileset.json`,
                servingFormat: "3d-tiles",
                contentKind: "buildings",
              },
              {
                name: "copc",
                url: `${origin}/scenes/protected-city/copc`,
                servingFormat: "copc",
                contentKind: "point-cloud",
                rangeSupported: true,
              },
            ],
          }),
        );
        return;
      }

      if (url.pathname === "/scenes/protected-city/redirect-other") {
        const token = req.headers["x-honua-token"];
        if (token !== activeToken) {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(302, { location: "https://attacker.example/leak" });
        res.end();
        return;
      }

      if (url.pathname === "/scenes/protected-city/redirect-same") {
        const token = req.headers["x-honua-token"];
        if (token !== activeToken) {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(302, { location: "/scenes/protected-city/tileset.json" });
        res.end();
        return;
      }

      if (url.pathname === "/scenes/protected-city/forbidden") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }

      if (url.pathname === "/scenes/protected-city/texture.png") {
        if (req.headers["x-honua-token"] !== activeToken) {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "image/png" });
        res.end(
          Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l2sAAAAASUVORK5CYII=",
            "base64",
          ),
        );
        return;
      }

      if (url.pathname === "/scenes/protected-city/tileset.json") {
        const token = req.headers["x-honua-token"];
        if (token !== activeToken) {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ asset: { version: "1.1" }, root: { content: { uri: "tiles/0.glb" } } }));
        return;
      }

      if (url.pathname === "/scenes/protected-city/copc") {
        const token = req.headers["x-honua-token"];
        if (token !== activeToken) {
          res.writeHead(401);
          res.end();
          return;
        }
        if (req.method === "HEAD") {
          res.writeHead(200, {
            "content-length": String(copcBytes.byteLength),
            "accept-ranges": "bytes",
            etag: '"copc-v1"',
          });
          res.end();
          return;
        }
        const rangeHeader = req.headers.range;
        if (typeof rangeHeader === "string" && rangeHeader.startsWith("bytes=")) {
          const [startStr, endStr] = rangeHeader.slice("bytes=".length).split("-");
          const start = Number.parseInt(startStr ?? "0", 10);
          const end = Math.min(
            copcBytes.byteLength - 1,
            Number.parseInt(endStr ?? String(copcBytes.byteLength - 1), 10),
          );
          const slice = copcBytes.subarray(start, end + 1);
          res.writeHead(206, {
            "content-type": "application/octet-stream",
            "content-length": String(slice.byteLength),
            "content-range": `bytes ${start}-${end}/${copcBytes.byteLength}`,
            etag: '"copc-v1"',
          });
          res.end(slice);
          return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(copcBytes);
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
    return {
      origin,
      getEnvelopeRequests: () => envelopeRequests,
      rotateServerToken: () => {
        activeToken = "rotated-on-server";
      },
      seenHeaders,
    };
  }

  it("authenticates the root and cloned descendants through the real Cesium resource", async () => {
    const srv = await startSceneServer();
    // Cesium checks XHR blob capability during module initialization. Node
    // supplies fetch/Blob but no XHR or bitmap decoding.
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        responseType = "";
        open() {}
      },
    );
    const cesium = await import("cesium");
    vi.unstubAllGlobals();
    const bitmap = { width: 1, height: 1 };
    const imageResource = cesium.Resource as typeof cesium.Resource & {
      supportsImageBitmapOptions(): Promise<boolean>;
      createImageBitmapFromBlob(blob: Blob, options: ImageBitmapOptions): Promise<ImageBitmap>;
    };
    vi.spyOn(imageResource, "supportsImageBitmapOptions").mockResolvedValue(true);
    const decode = vi.spyOn(imageResource, "createImageBitmapFromBlob").mockResolvedValue(bitmap as ImageBitmap);
    const { loadWithSceneResource } = await import("../src/scene-workspace/scene-cesium-resource.js");
    const session = createProtectedSceneAssetSession({
      sceneId: "protected-city",
      affordance: {
        method: "POST",
        path: "/scenes/protected-city/access-envelope",
        origin: srv.origin,
        pathPrefix: "/scenes/protected-city/",
        transport: "header",
      },
      execute: <T>(method: string, path: string) =>
        fetch(`${srv.origin}${path}`, { method }).then((response) => response.json() as Promise<T>),
      now: () => Date.UTC(2026, 10, 21, 0, 0, 10),
    });
    await loadWithSceneResource(
      cesium as unknown as Parameters<typeof loadWithSceneResource>[0],
      { url: `${srv.origin}/scenes/protected-city/tileset.json`, access: { session } },
      async (root) => {
        expect(root).toBeInstanceOf(cesium.Resource);
        const resource = root as unknown as InstanceType<typeof cesium.Resource>;
        await expect(resource.fetchJson()).resolves.toMatchObject({ asset: { version: expect.any(String) } });
        const descendant = resource.clone().getDerivedResource({ url: "copc" });
        descendant.headers.Range = "bytes=0-15";
        expect(descendant.url).toBe(`${srv.origin}/scenes/protected-city/copc`);
        expect(descendant.headers).toEqual({ Range: "bytes=0-15" });
        await expect(descendant.fetchArrayBuffer()).resolves.toHaveProperty("byteLength", 16);
        const texture = resource.getDerivedResource({ url: "texture.png" });
        await expect(texture.fetchImage({ preferImageBitmap: true })).resolves.toBe(bitmap);
        expect(decode).toHaveBeenCalledWith(expect.objectContaining({ type: "image/png" }), expect.any(Object));
        const outside = resource.getDerivedResource({ url: "../../outside.json" });
        await expect(outside.fetchJson()).rejects.toMatchObject({ code: "scope-violation" });
        await expect(outside.fetchImage({ preferImageBitmap: true })).rejects.toMatchObject({
          code: "scope-violation",
        });
      },
    );
    expect(srv.seenHeaders.filter((headers) => headers["x-honua-token"])).toHaveLength(3);
  });

  it("allows acquisition to retry after a synchronous executor failure", async () => {
    const srv = await startSceneServer();
    let attempts = 0;
    const session = createProtectedSceneAssetSession({
      sceneId: "protected-city",
      affordance: {
        method: "POST",
        path: "/scenes/protected-city/access-envelope",
        origin: srv.origin,
        pathPrefix: "/scenes/protected-city/",
        transport: "header",
      },
      execute: <T = unknown>(method: string, path: string): Promise<T> => {
        attempts += 1;
        if (attempts === 1) throw new Error("executor temporarily unavailable");
        return fetch(`${srv.origin}${path}`, { method }).then((response) => response.json() as Promise<T>);
      },
      now: () => Date.UTC(2026, 10, 21, 0, 0, 10),
    });

    await expect(session.ensureAccess()).rejects.toBeInstanceOf(HonuaSceneAccessSessionError);
    await expect(session.ensureAccess()).resolves.toMatchObject({ status: "active", generation: 1 });
    expect(attempts).toBe(2);
  });

  it("intersects advertised path and method restrictions with the caller scope", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null));
    let expiresAt = "2026-08-22T00:15:00+00:00";
    let refreshAfter = "2026-08-22T00:07:30+00:00";
    const session = createProtectedSceneAssetSession({
      sceneId: "protected-campus",
      affordance: {
        method: "POST",
        path: "/scenes/protected-campus/access-envelope",
        origin: "https://maps.example.test",
        pathPrefix: "/scenes/protected-campus/",
      },
      execute: async <T>() =>
        ({
          sceneId: "protected-campus",
          token: "opaque-token",
          expiresAt,
          refreshAfter,
          allowedMethods: ["HEAD", "POST"],
          contractVersion: "2026-08-v1",
          transports: [
            { kind: "query", name: "token", valueTemplate: "{token}", preferred: false },
            { kind: "header", name: "X-Honua-Token", valueTemplate: "{token}", preferred: true },
          ],
          assetScopes: [
            { scheme: "https", host: "maps.example.test", port: 443, pathPrefix: "/scenes/protected-campus/tiles/" },
            { scheme: "https", host: "other.example.test", port: 443, pathPrefix: "/" },
          ],
        }) as T,
      fetchFn,
      now: () => Date.parse("2026-08-22T00:00:00Z"),
    });
    expiresAt = "2026-08-21T23:59:59Z";
    await expect(session.ensureAccess()).rejects.toMatchObject({ code: "refresh-failed" });
    expiresAt = "2026-08-22T00:15:00Z";
    refreshAfter = expiresAt;
    await expect(session.ensureAccess()).rejects.toMatchObject({ code: "refresh-failed" });
    refreshAfter = "2026-08-22T00:07:30Z";
    expect(await session.ensureAccess()).toMatchObject({
      allowedMethods: ["HEAD"],
      transport: "header",
      pathPrefix: "/scenes/protected-campus/tiles/",
    });
    const url = "https://maps.example.test/scenes/protected-campus/tiles/0.glb";
    await expect(session.fetchAsset({ url })).rejects.toBeInstanceOf(HonuaSceneAccessSessionError);
    await expect(
      session.fetchAsset({
        method: "HEAD",
        url: "https://maps.example.test/scenes/protected-campus/tileset.json",
      }),
    ).rejects.toBeInstanceOf(HonuaSceneAccessSessionError);
    for (const ambiguous of ["%2f..%2f", "%5c%2e%2e%5c", "%252f%252e%252e%252f"]) {
      await expect(
        session.fetchAsset({
          method: "HEAD",
          url: `https://maps.example.test/scenes/protected-campus/tiles/${ambiguous}private.glb`,
        }),
      ).rejects.toMatchObject({ code: "scope-violation" });
    }
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(session.fetchAsset({ url, method: "HEAD" })).resolves.toMatchObject({ status: 200 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("X-Honua-Token")).toBe("opaque-token");
  });

  it("acquires single-flight POST envelopes, refreshes proactively, rotates on 401, fails closed on 403, and never leaks tokens", async () => {
    const srv = await startSceneServer();
    let clockMs = Date.UTC(2026, 10, 21, 0, 0, 10);

    const execute = async <T = unknown>(
      ...[method, path, , signal]: [
        string,
        string,
        { readonly body?: unknown; readonly headers?: Record<string, string> }?,
        AbortSignal?,
      ]
    ): Promise<T> => {
      const response = await fetch(`${srv.origin}${path}`, { method, signal });
      return (await response.json()) as T;
    };

    const session = createProtectedSceneAssetSession({
      sceneId: "protected-city",
      affordance: {
        method: "POST",
        path: "/scenes/protected-city/access-envelope",
        origin: srv.origin,
        pathPrefix: "/scenes/protected-city/",
        transport: "header",
        headerName: "X-Honua-Token",
      },
      execute,
      now: () => clockMs,
    });

    // Concurrent calls share a single POST acquisition.
    const [r1, r2] = await Promise.all([
      session.fetchAsset({ url: `${srv.origin}/scenes/protected-city/tileset.json` }),
      session.fetchAsset({ url: `${srv.origin}/scenes/protected-city/tileset.json` }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(srv.getEnvelopeRequests()).toBe(1);

    // Zero token material in snapshots, JSON serialization, or toString().
    const serialized = JSON.stringify(session);
    expect(serialized).not.toContain("secret-scene-token");
    expect(session.toString()).not.toContain("secret-scene-token");
    expect(session.snapshot().status).toBe("active");
    expect(session.snapshot().generation).toBe(1);

    // Advance past refreshAfter -> automatic refresh before expiry.
    clockMs = Date.UTC(2026, 10, 21, 0, 3, 1);
    const r3 = await session.fetchAsset({ url: `${srv.origin}/scenes/protected-city/tileset.json` });
    expect(r3.status).toBe(200);
    expect(srv.getEnvelopeRequests()).toBe(2);
    expect(session.snapshot().generation).toBe(2);

    // Server rotates token -> 401 triggers single refresh + retry.
    srv.rotateServerToken();
    const r4 = await session.fetchAsset({ url: `${srv.origin}/scenes/protected-city/tileset.json` });
    expect(r4.status).toBe(200);
    expect(srv.getEnvelopeRequests()).toBe(3);

    // 403 fails closed immediately without retry loop.
    await expect(session.fetchAsset({ url: `${srv.origin}/scenes/protected-city/forbidden` })).rejects.toMatchObject({
      code: "forbidden",
      statusCode: 403,
    });
    expect(srv.getEnvelopeRequests()).toBe(3);

    // Cross-origin, prefix widening, traversal, and redirects are denied.
    await expect(
      session.authorizeRequest({ url: "https://other-host.example/scenes/protected-city/tileset.json" }),
    ).rejects.toMatchObject({ code: "cross-origin-denied" });
    await expect(
      session.authorizeRequest({ url: `${srv.origin}/scenes/other-scene/tileset.json` }),
    ).rejects.toMatchObject({ code: "scope-violation" });
    await expect(
      session.authorizeRequest({ url: `${srv.origin}/scenes/protected-city/../other-scene/tileset.json` }),
    ).rejects.toMatchObject({ code: "scope-violation" });
    await expect(
      session.fetchAsset({ url: `${srv.origin}/scenes/protected-city/redirect-same` }),
    ).rejects.toMatchObject({ code: "redirect-denied" });

    // Cesium resource factory resolves relative tile URIs inside scope.
    const resourceFactory = session.createCesiumResourceFactory();
    const desc = await resourceFactory("tiles/0.glb");
    expect(desc.url).toBe(`${srv.origin}/scenes/protected-city/tiles/0.glb`);
    expect(desc.headers?.["X-Honua-Token"]).toBe("secret-scene-token-3");

    // Disposal clears memory and blocks subsequent requests.
    session.dispose();
    expect(session.snapshot().status).toBe("disposed");
    expect(session.isUrlInScope(`${srv.origin}/scenes/protected-city/tileset.json`)).toBe(false);
    await expect(session.ensureAccess()).rejects.toBeInstanceOf(HonuaSceneAccessSessionError);
  });

  it("allows same-scope redirects only when explicitly permitted and still blocks cross-origin redirect hops", async () => {
    const srv = await startSceneServer({ allowRedirects: true });
    const session = createProtectedSceneAssetSession({
      sceneId: "protected-city",
      affordance: {
        method: "POST",
        path: "/scenes/protected-city/access-envelope",
        origin: srv.origin,
        pathPrefix: "/scenes/protected-city/",
        allowRedirects: true,
      },
      execute: async <T = unknown>(method: string, path: string): Promise<T> => {
        const res = await fetch(`${srv.origin}${path}`, { method });
        return (await res.json()) as T;
      },
      now: () => Date.UTC(2026, 10, 21, 0, 0, 5),
    });

    const sameScope = await session.fetchAsset({ url: `${srv.origin}/scenes/protected-city/redirect-same` });
    expect(sameScope.status).toBe(200);

    await expect(
      session.fetchAsset({ url: `${srv.origin}/scenes/protected-city/redirect-other` }),
    ).rejects.toMatchObject({ code: "cross-origin-denied" });
  });

  it("separates servingFormat from semantic contentKind and wires protected SceneView sessions + COPC range access", async () => {
    const srv = await startSceneServer({ baseTime: Date.now() });
    const execute = async <T = unknown>(
      ...[method, path, , signal]: [
        string,
        string,
        { readonly body?: unknown; readonly headers?: Record<string, string> }?,
        AbortSignal?,
      ]
    ): Promise<T> => {
      const response = await fetch(`${srv.origin}${path}`, { method, signal });
      return (await response.json()) as T;
    };

    const resolved = normalizeSceneResolution(await execute("GET", "/api/scenes/protected-city/resolve"));
    expect(resolved.servingFormat).toBe("3d-tiles");
    expect(resolved.contentKind).toBe("buildings");
    expect(resolved.copcUrl).toBe(`${srv.origin}/scenes/protected-city/copc`);
    expect(resolved.accessAffordance?.method).toBe("POST");

    const normalized = normalizeScene({
      sceneId: "lidar-scan",
      servingFormat: "3d-tiles",
      contentKind: "point-cloud",
      endpoints: [
        {
          name: "tileset",
          url: `${srv.origin}/scenes/lidar-scan/tileset.json`,
          servingFormat: "3d-tiles",
          contentKind: "point-cloud",
        },
        {
          name: "copc",
          url: `${srv.origin}/scenes/lidar-scan/copc`,
          servingFormat: "copc",
          contentKind: "point-cloud",
          rangeSupported: true,
        },
      ],
    });
    expect(normalized.servingFormat).toBe("3d-tiles");
    expect(normalized.contentKind).toBe("point-cloud");
    expect(normalized.copcUrl).toBe(`${srv.origin}/scenes/lidar-scan/copc`);

    // SceneView attaches a protected-scene asset session from the resolve affordance.
    const view = new SceneView({
      execute: async <T = unknown>(method: string, path: string): Promise<T> => {
        if (path === "/api/scenes/protected-city") {
          return {
            sceneId: "protected-city",
            title: "Protected City",
            servingFormat: "3d-tiles",
            contentKind: "buildings",
            auth: { requiresAuthentication: true },
          } as T;
        }
        return execute<T>(method, path);
      },
    });
    await view.loadScene("protected-city");
    expect(view.accessSession).toBeDefined();
    expect(view.accessSession?.snapshot().sceneId).toBe("protected-city");

    // Protected COPC range reads reuse the exact same session.
    const copc = createCopcRangeClient({
      copcUrl: buildSceneCopcUrl(srv.origin, "protected-city"),
      session: view.accessSession,
    });
    const head = await copc.head();
    expect(head.acceptRanges).toBe(true);
    expect(head.contentLength).toBeGreaterThan(589);
    expect(head.etag).toBe('"copc-v1"');

    const { lasHeader, copcInfo } = await copc.readHeader();
    expect(lasHeader.signature).toBe("LASF");
    expect(lasHeader.versionMajor).toBe(1);
    expect(lasHeader.versionMinor).toBe(4);
    expect(lasHeader.isCompressedLaz).toBe(true);
    expect(lasHeader.pointDataRecordFormat).toBe(6);
    expect(lasHeader.pointCount).toBe(125_000);
    expect(copcInfo?.halfSize).toBe(512);
    expect(copcInfo?.spacing).toBe(0.25);
    expect(copcInfo?.rootHierarchySize).toBe(256);

    view.dispose();
    expect(view.accessSession).toBeUndefined();
  });

  it("enforces bounded range limits and rejects servers that ignore Range with an unbounded 200 payload", async () => {
    const raw = buildSyntheticCopcPayload();
    const header = parseLas14Header(raw);
    const vlr = parseCopcInfoVlr(raw, header.headerSize);
    expect(header.pointCount).toBe(125_000);
    expect(vlr?.spacing).toBe(0.25);

    const client = createCopcRangeClient({
      baseUrl: "https://copc.example",
      sceneId: "dem-lidar",
      maxRangeBytes: 256,
      fetchFn: (async () =>
        new Response(Buffer.from(raw), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        })) as unknown as typeof fetch,
    });

    await expect(client.readRange({ start: 0, end: 511 })).rejects.toThrow(/exceeds maxRangeBytes/);
    await expect(client.readRange({ start: 10, end: 200 })).rejects.toThrow(/exceeded maxRangeBytes|unbounded/);
  });

  it("validates partial response offsets and sizes before returning COPC bytes", async () => {
    const request = { start: 10, end: 13 };
    const clientFor = (response: Response) =>
      createCopcRangeClient({
        baseUrl: "https://copc.example",
        sceneId: "dem-lidar",
        fetchFn: async () => response,
      });
    const partial = (length: number, contentRange: string) =>
      new Response(new Uint8Array(length), { status: 206, headers: { "Content-Range": contentRange } });
    await expect(clientFor(new Response(new Uint8Array(4))).readRange(request)).rejects.toThrow(/ignored HTTP Range/);
    await expect(clientFor(partial(4, "bytes 11-14/100")).readRange(request)).rejects.toThrow(/requested range/);
    await expect(clientFor(partial(3, "bytes 10-13/100")).readRange(request)).rejects.toThrow(/response size/);
    await expect(clientFor(partial(2, "bytes 10-11/12")).readRange(request)).resolves.toMatchObject({
      bytes: new Uint8Array(2),
    });
  });

  it("cancels a COPC response when streaming exceeds its byte budget", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.enqueue(new Uint8Array(2));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = createCopcRangeClient({
      baseUrl: "https://copc.example",
      sceneId: "dem-lidar",
      fetchFn: async () => new Response(body, { status: 206, headers: { "Content-Range": "bytes 10-13/100" } }),
    });
    await expect(client.readRange({ start: 10, end: 13 })).rejects.toThrow(/byte budget/);
    expect(cancelled).toBe(true);
  });

  it("rejects hierarchy offsets outside JavaScript's safe integer range", () => {
    const bytes = buildSyntheticCopcPayload();
    new DataView(bytes.buffer).setBigUint64(375 + 54 + 40, 2n ** 53n + 1n, true);
    expect(() => parseCopcInfoVlr(bytes, 375)).toThrow(/safe integer range/);
  });
});
