import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFixtureBuildEnvironment } from "../../scripts/lib/fixture-build-environment.mjs";
import { runNpmScriptSync } from "../../scripts/lib/npm-cli.mjs";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const distRoot = path.resolve(exampleRoot, "dist");
const geocodeRoute = "/rest/services/World/GeocodeServer/findAddressCandidates";
const geocodeFixturePath = path.join(exampleRoot, "public", geocodeRoute);
const geocodeFixture = JSON.parse(fs.readFileSync(geocodeFixturePath, "utf8"));

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function buildDemoIfNeeded() {
  const result = runNpmScriptSync("demo:geocoding:build", {
    cwd: projectRoot,
    stdio: "inherit",
    env: createFixtureBuildEnvironment({}),
  });

  if (result.status !== 0) {
    throw new Error("Failed to build the geocoding quickstart before starting the fixture server.");
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

function serveJson(res, body) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function resolveStaticPath(pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const absolutePath = path.join(distRoot, requestedPath);
  if (!absolutePath.startsWith(distRoot)) return undefined;
  return absolutePath;
}

export async function startGeocodingFixtureServer({ build = true } = {}) {
  if (build) buildDemoIfNeeded();

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (requestUrl.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (requestUrl.pathname === geocodeRoute) {
      serveJson(res, geocodeFixture);
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
    throw new Error("Failed to bind the geocoding fixture server.");
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
  const { url, close } = await startGeocodingFixtureServer();
  process.stdout.write(`geocodingMockUrl=${url}\n`);

  const shutdown = async () => {
    await close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
