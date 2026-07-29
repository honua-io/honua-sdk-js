import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFixtureBuildEnvironment } from "../../scripts/lib/fixture-build-environment.mjs";
import { runNpmScriptSync } from "../../scripts/lib/npm-cli.mjs";

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
  VITE_HONUA_REACT_BASE_URL: "",
  VITE_HONUA_REACT_SERVICE_ID: "natural-earth",
  VITE_HONUA_REACT_LAYER_ID: "0",
  VITE_HONUA_REACT_WHERE: "1=1",
};

function readFixture(name) {
  return fs.readFileSync(path.join(fixtureRoot, name), "utf8");
}

function buildDemoIfNeeded() {
  const result = runNpmScriptSync("demo:react-quickstart:build", {
    cwd: projectRoot,
    stdio: "inherit",
    env: createFixtureBuildEnvironment(FIXTURE_BUILD_ENV),
  });

  if (result.status !== 0) {
    throw new Error("Failed to build the react-quickstart demo before starting the mock server.");
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

export async function startReactQuickstartFixtureServer({ build = true } = {}) {
  if (build) {
    buildDemoIfNeeded();
  }

  const capabilities = readFixture("capabilities.json");
  const queryFeatures = readFixture("query-features.json");
  const queryPath = `/rest/services/${FIXTURE_BUILD_ENV.VITE_HONUA_REACT_SERVICE_ID}/FeatureServer/${FIXTURE_BUILD_ENV.VITE_HONUA_REACT_LAYER_ID}/query`;

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

    if (requestUrl.pathname === queryPath) {
      serveText(res, queryFeatures, "application/json; charset=utf-8");
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
    throw new Error("Failed to bind the react-quickstart fixture server.");
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
  const { url, close } = await startReactQuickstartFixtureServer();
  process.stdout.write(`reactQuickstartMockUrl=${url}\n`);

  const shutdown = async () => {
    await close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
