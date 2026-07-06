// Deterministic fixture server for the standalone quickstart.
//
// It rebuilds the demo with the FeatureServer URL pointed at a same-origin
// relative path, then serves the recorded GeoServices JSON from
// `test/fixtures/standalone-quickstart-demo/` for the metadata + query paths and
// an inline offline basemap. CI (and the Playwright smoke) therefore never touch
// the public endpoints — `refresh-fixtures.mjs` is the only thing that does.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const fixtureRoot = path.resolve(projectRoot, "test", "fixtures", "standalone-quickstart-demo");
const distRoot = path.resolve(exampleRoot, "dist");

const FIXTURE_SERVICE_ID = "census-apportionment";
const FIXTURE_LAYER_ID = "0";
const BASEMAP_PATH = "/__standalone__/basemap-style.json";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const FIXTURE_BUILD_ENV = {
  VITE_STANDALONE_FEATURE_LAYER_URL: `/rest/services/${FIXTURE_SERVICE_ID}/FeatureServer/${FIXTURE_LAYER_ID}`,
  VITE_STANDALONE_WHERE: "1=1",
  VITE_STANDALONE_MAX_PAGES: "4",
  VITE_STANDALONE_BASEMAP_STYLE: BASEMAP_PATH,
};

function readFixture(name) {
  return fs.readFileSync(path.join(fixtureRoot, name), "utf8");
}

function buildDemoIfNeeded() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "demo:standalone:build", "--silent"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: { ...process.env, ...FIXTURE_BUILD_ENV },
  });
  if (result.status !== 0) {
    throw new Error("Failed to build the standalone quickstart before starting the fixture server.");
  }
}

function createBasemapStyle() {
  return JSON.stringify({
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#0b1120" } }],
  });
}

function serveBuffer(res, buffer, filePath) {
  res.writeHead(200, {
    "content-type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(buffer);
}

function serveText(res, value, contentType) {
  res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  res.end(value);
}

function resolveStaticPath(pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const absolutePath = path.join(distRoot, requestedPath);
  return absolutePath.startsWith(distRoot) ? absolutePath : undefined;
}

export async function startStandaloneFixtureServer({ build = true } = {}) {
  if (build) {
    buildDemoIfNeeded();
  }

  const layerMetadata = readFixture("geoservices-layer-metadata.json");
  const queryFeatures = readFixture("geoservices-query.json");
  const basemapStyle = createBasemapStyle();
  const layerPath = `/rest/services/${FIXTURE_SERVICE_ID}/FeatureServer/${FIXTURE_LAYER_ID}`;
  const queryPath = `${layerPath}/query`;

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const { pathname } = requestUrl;

    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (pathname === BASEMAP_PATH) {
      serveText(res, basemapStyle, "application/json; charset=utf-8");
      return;
    }
    if (pathname === queryPath) {
      serveText(res, queryFeatures, "application/json; charset=utf-8");
      return;
    }
    if (pathname === layerPath) {
      serveText(res, layerMetadata, "application/json; charset=utf-8");
      return;
    }

    const staticPath = resolveStaticPath(pathname);
    if (staticPath && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      serveBuffer(res, fs.readFileSync(staticPath), staticPath);
      return;
    }

    const indexPath = path.join(distRoot, "index.html");
    if (pathname === "/" || !path.extname(pathname)) {
      serveBuffer(res, fs.readFileSync(indexPath), indexPath);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind the standalone quickstart fixture server.");
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url, close } = await startStandaloneFixtureServer();
  process.stdout.write(`standaloneMockUrl=${url}\n`);

  const shutdown = async () => {
    await close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
