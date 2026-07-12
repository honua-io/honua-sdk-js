import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const fixtureRoot = path.resolve(projectRoot, "test", "fixtures", "honua-quickstart-demo");
const distRoot = path.resolve(exampleRoot, "dist");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const FIXTURE_BUILD_ENV = {
  VITE_HONUA_QUICKSTART_BASE_URL: "",
  VITE_HONUA_QUICKSTART_SERVICE_ID: "natural-earth",
  VITE_HONUA_QUICKSTART_LAYER_ID: "0",
  VITE_HONUA_QUICKSTART_WHERE: "1=1",
  VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT: "25",
  VITE_HONUA_QUICKSTART_BASEMAP_STYLE: "/__honua-quickstart__/basemap-style.json",
};

function readFixture(name) {
  return fs.readFileSync(path.join(fixtureRoot, name), "utf8");
}

function buildDemoIfNeeded(timeoutMs) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "demo:quickstart:build", "--silent"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ...FIXTURE_BUILD_ENV,
    },
    timeout: timeoutMs,
  });

  if (result.status !== 0) {
    if (result.error?.code === "ETIMEDOUT") {
      throw new Error(`Quickstart fixture build exceeded its ${timeoutMs}ms budget.`);
    }
    throw new Error("Failed to build the quickstart demo before starting the mock server.");
  }
}

function createBasemapStyle() {
  return JSON.stringify({
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: {
          "background-color": "#efe6d1",
        },
      },
    ],
  });
}

function serveBuffer(res, buffer, filePath) {
  const extension = path.extname(filePath);
  res.writeHead(200, {
    "content-type": MIME_TYPES[extension] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(buffer);
}

function serveText(res, value, contentType) {
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(value);
}

function resolveStaticPath(pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const absolutePath = path.join(distRoot, requestedPath);
  if (!absolutePath.startsWith(distRoot)) {
    return undefined;
  }
  return absolutePath;
}

export async function startQuickstartFixtureServer({ build = true, buildTimeoutMs } = {}) {
  if (build) {
    buildDemoIfNeeded(buildTimeoutMs);
  }

  const capabilities = readFixture("capabilities.json");
  const queryFeatures = readFixture("query-features.json");
  const layerMetadata = readFixture("layer-metadata.json");
  const basemapStyle = createBasemapStyle();
  const queryPath = `/rest/services/${FIXTURE_BUILD_ENV.VITE_HONUA_QUICKSTART_SERVICE_ID}/FeatureServer/${FIXTURE_BUILD_ENV.VITE_HONUA_QUICKSTART_LAYER_ID}/query`;
  const layerPath = `/rest/services/${FIXTURE_BUILD_ENV.VITE_HONUA_QUICKSTART_SERVICE_ID}/FeatureServer/${FIXTURE_BUILD_ENV.VITE_HONUA_QUICKSTART_LAYER_ID}`;

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (requestUrl.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (requestUrl.pathname === "/api/v1/admin/capabilities") {
      serveText(res, capabilities, "application/json; charset=utf-8");
      return;
    }

    if (requestUrl.pathname === "/__honua-quickstart__/basemap-style.json") {
      serveText(res, basemapStyle, "application/json; charset=utf-8");
      return;
    }

    if (requestUrl.pathname === queryPath) {
      serveText(res, queryFeatures, "application/json; charset=utf-8");
      return;
    }

    if (requestUrl.pathname === layerPath) {
      serveText(res, layerMetadata, "application/json; charset=utf-8");
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

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind the quickstart fixture server.");
  }

  const url = `http://127.0.0.1:${address.port}`;
  return {
    server,
    url,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url, close } = await startQuickstartFixtureServer();
  process.stdout.write(`quickstartMockUrl=${url}\n`);

  const shutdown = async () => {
    await close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
