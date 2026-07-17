import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFixtureBuildEnvironment } from "../../scripts/lib/fixture-build-environment.mjs";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const distRoot = path.resolve(exampleRoot, "dist");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const OGC_FEATURES = Object.freeze([
  Object.freeze({
    type: "Feature",
    id: "place-1",
    geometry: Object.freeze({ type: "Point", coordinates: Object.freeze([-157.8583, 21.3069]) }),
    properties: Object.freeze({ name: "Honolulu", category: "civic", population: 350964 }),
  }),
  Object.freeze({
    type: "Feature",
    id: "place-2",
    geometry: Object.freeze({ type: "Point", coordinates: Object.freeze([-157.8036, 21.2945]) }),
    properties: Object.freeze({ name: "Diamond Head", category: "landmark", population: null }),
  }),
  Object.freeze({
    type: "Feature",
    id: "place-3",
    geometry: Object.freeze({ type: "Point", coordinates: Object.freeze([-157.7394, 21.2832]) }),
    properties: Object.freeze({ name: "Hanauma Bay", category: "reserve", population: null }),
  }),
]);

function buildDemoIfNeeded() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "demo:service-explorer:build", "--silent"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: createFixtureBuildEnvironment({ VITE_HONUA_SERVICE_EXPLORER_MODE: "fixture" }),
  });

  if (result.status !== 0) {
    throw new Error("Failed to build the service explorer before starting the fixture server.");
  }
}

function serveBuffer(res, buffer, filePath) {
  const extension = path.extname(filePath);
  res.writeHead(200, {
    "content-type": MIME_TYPES[extension] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(buffer);
}

function serveJson(res, body, status = 200) {
  const buffer = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buffer.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(buffer);
}

function serveOgcFixture(requestUrl, res) {
  if (requestUrl.pathname === "/fixtures/ogc") {
    serveJson(res, {
      title: "Honua Service Explorer fixture",
      description: "A bounded OGC API Features service used by the maintained sample gate.",
      links: [
        { rel: "self", type: "application/json", href: "." },
        { rel: "data", type: "application/json", href: "./collections" },
        { rel: "conformance", type: "application/json", href: "./conformance" },
      ],
    });
    return true;
  }
  if (requestUrl.pathname === "/fixtures/ogc/conformance") {
    serveJson(res, {
      conformsTo: [
        "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
        "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson",
      ],
    });
    return true;
  }
  if (requestUrl.pathname === "/fixtures/ogc/collections") {
    serveJson(res, {
      collections: [
        {
          id: "places",
          title: "Oʻahu places",
          description: "Small, deterministic point fixture.",
          crs: ["http://www.opengis.net/def/crs/OGC/1.3/CRS84"],
          extent: { spatial: { bbox: [[-157.9, 21.25, -157.7, 21.35]] } },
          links: [{ rel: "items", type: "application/geo+json", href: "./collections/places/items" }],
        },
      ],
    });
    return true;
  }
  if (requestUrl.pathname === "/fixtures/ogc/collections/places/items") {
    const requestedLimit = Number(requestUrl.searchParams.get("limit") ?? OGC_FEATURES.length);
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 0), 100)
      : OGC_FEATURES.length;
    const features = OGC_FEATURES.slice(0, limit);
    serveJson(res, {
      type: "FeatureCollection",
      numberMatched: OGC_FEATURES.length,
      numberReturned: features.length,
      features,
      links: [{ rel: "self", type: "application/geo+json", href: "./items" }],
    });
    return true;
  }
  return false;
}

async function boundedJsonProbe(origin, requestPath, maxBytes = 64 * 1024) {
  const response = await fetch(`${origin}${requestPath}`, { signal: AbortSignal.timeout(2_000) });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) throw new Error(`${requestPath} returned HTTP ${response.status}`);
  if (body.byteLength === 0 || body.byteLength > maxBytes) {
    throw new Error(`${requestPath} exceeded its bounded fixture response budget`);
  }
  const contentType = response.headers.get("content-type");
  if (!contentType?.startsWith("application/json")) {
    throw new Error(`${requestPath} did not return JSON`);
  }
  return {
    path: requestPath,
    status: response.status,
    bodyBytes: body.byteLength,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    contentType,
    json: JSON.parse(body.toString("utf8")),
  };
}

async function probeProtocolAndHostileFixtures(origin) {
  const landing = await boundedJsonProbe(origin, "/fixtures/ogc");
  const conformance = await boundedJsonProbe(origin, "/fixtures/ogc/conformance");
  const collections = await boundedJsonProbe(origin, "/fixtures/ogc/collections");
  const items = await boundedJsonProbe(origin, "/fixtures/ogc/collections/places/items?limit=2");
  if (!landing.json.links?.some((link) => link.rel === "data")) {
    throw new Error("OGC landing evidence does not advertise a data link");
  }
  if (!conformance.json.conformsTo?.some((value) => value.includes("ogcapi-features-1/1.0/conf/core"))) {
    throw new Error("OGC conformance evidence does not advertise the core class");
  }
  if (collections.json.collections?.[0]?.id !== "places") {
    throw new Error("OGC collection evidence did not retain the expected source identity");
  }
  if (items.json.numberReturned !== 2 || items.json.features?.length !== 2) {
    throw new Error("OGC item evidence did not honor the bounded query limit");
  }

  const deadlineMs = 50;
  const startedAt = performance.now();
  let errorName;
  try {
    await fetch(`${origin}/fixtures/slow-ogc`, { signal: AbortSignal.timeout(deadlineMs) });
    throw new Error("Hostile slow fixture unexpectedly completed before its deadline");
  } catch (error) {
    errorName = error instanceof Error ? error.name : "unknown";
    if (errorName !== "AbortError" && errorName !== "TimeoutError") throw error;
  }
  const elapsedMs = Math.max(0, performance.now() - startedAt);
  if (elapsedMs > 1_000) throw new Error("Hostile slow fixture did not cancel within its bounded grace period");

  return {
    protocol: {
      landing: withoutJson(landing),
      conformance: withoutJson(conformance),
      collections: withoutJson(collections),
      items: withoutJson(items),
      sourceId: "places",
      returnedFeatures: items.json.numberReturned,
    },
    hostile: {
      path: "/fixtures/slow-ogc",
      deadlineMs,
      cancelled: true,
      errorName,
      elapsedMs,
    },
  };
}

function withoutJson(probe) {
  const { json: _json, ...evidence } = probe;
  return evidence;
}

function resolveStaticPath(pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const absolutePath = path.join(distRoot, requestedPath);
  if (!absolutePath.startsWith(distRoot)) return undefined;
  return absolutePath;
}

export async function startServiceExplorerFixtureServer({ build = true } = {}) {
  if (build) buildDemoIfNeeded();

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
      res.end("Method not allowed");
      return;
    }

    if (serveOgcFixture(requestUrl, res)) return;

    if (requestUrl.pathname === "/fixtures/slow-ogc") {
      const timer = setTimeout(() => {
        if (!res.destroyed) serveJson(res, { title: "Delayed fixture", links: [] });
      }, 30_000);
      res.once("close", () => clearTimeout(timer));
      return;
    }

    if (requestUrl.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    const staticPath = resolveStaticPath(requestUrl.pathname);
    if (staticPath && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      serveBuffer(res, fs.readFileSync(staticPath), staticPath);
      return;
    }

    const indexPath = path.join(distRoot, "index.html");
    if (requestUrl.pathname === "/" || !path.extname(requestUrl.pathname)) {
      serveBuffer(res, fs.readFileSync(indexPath), indexPath);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind the service explorer fixture server.");
  }

  let closePromise;
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      closePromise ??= new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await closePromise;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arguments_ = process.argv.slice(2);
  const evidenceOnce = arguments_.length === 1 && arguments_[0] === "--evidence-once";
  if (arguments_.length > 0 && !evidenceOnce) {
    throw new Error("Unknown service explorer fixture server argument");
  }

  const { server, url, close } = await startServiceExplorerFixtureServer();
  process.stdout.write(`serviceExplorerMockUrl=${url}\n`);

  if (evidenceOnce) {
    let probe;
    let fixtureMatrix;
    try {
      const response = await fetch(url);
      const body = Buffer.from(await response.arrayBuffer());
      probe = {
        method: "GET",
        path: "/",
        status: response.status,
        bodyBytes: body.byteLength,
        bodySha256: createHash("sha256").update(body).digest("hex"),
        contentType: response.headers.get("content-type"),
      };
      if (!response.ok) throw new Error(`Fixture evidence probe failed with HTTP ${response.status}`);
      fixtureMatrix = await probeProtocolAndHostileFixtures(url);
    } finally {
      await close();
    }
    const activeConnectionsAfterClose = await new Promise((resolve, reject) => {
      server.getConnections((error, count) => (error ? reject(error) : resolve(count)));
    });
    const endpoint = new URL(url);
    process.stdout.write(
      `fixtureEvidence=${JSON.stringify({
        transport: "loopback-http",
        networkScope: "loopback-only",
        host: endpoint.hostname,
        port: Number(endpoint.port),
        ready: true,
        started: true,
        probe,
        fixtureMatrix,
        closed: true,
        listeningAfterClose: server.listening,
        activeConnectionsAfterClose,
      })}\n`,
    );
    process.exit(0);
  }

  const shutdown = async () => {
    await close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
