import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const distRoot = path.resolve(exampleRoot, "dist");
const fixtureRoot = path.resolve(exampleRoot, "fixtures");
const packageFixturePath = path.join(fixtureRoot, "map-package.json");
const featureFixturePath = path.join(fixtureRoot, "features.json");

const TILE_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".pbf": "application/x-protobuf",
  ".png": "image/png",
};

function buildDemoIfNeeded() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "demo:runtime-parity:build", "--silent"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) throw new Error("Failed to build the runtime parity showcase.");
}

function serveFile(res, filePath) {
  res.writeHead(200, {
    "content-type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(fs.readFileSync(filePath));
}

function serveJsonFixture(res, filePath, headers = {}) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(fs.readFileSync(filePath));
}

export async function startRuntimeParityShowcaseFixtureServer({ build = true } = {}) {
  if (build) buildDemoIfNeeded();

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (requestUrl.pathname === "/api/v1/map-packages/runtime-parity-showcase") {
      const etag = '"runtime-parity-showcase-v1"';
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, {
          etag,
          "last-modified": "Fri, 01 May 2026 12:00:00 GMT",
          "cache-control": "no-store",
        });
        res.end();
        return;
      }
      serveJsonFixture(res, packageFixturePath, {
        etag,
        "last-modified": "Fri, 01 May 2026 12:00:00 GMT",
      });
      return;
    }

    if (requestUrl.pathname === "/__runtime-parity-showcase__/features.json") {
      serveJsonFixture(res, featureFixturePath, {
        etag: '"runtime-parity-features-v1"',
        "last-modified": "Fri, 01 May 2026 12:00:00 GMT",
      });
      return;
    }

    if (requestUrl.pathname.startsWith("/__runtime-parity-showcase__/tiles/")) {
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store",
      });
      res.end(TILE_BYTES);
      return;
    }

    if (requestUrl.pathname.startsWith("/__runtime-parity-showcase__/vector-tiles/")) {
      res.writeHead(204, {
        "content-type": "application/x-protobuf",
        "cache-control": "no-store",
      });
      res.end();
      return;
    }

    const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    const staticPath = path.join(distRoot, requestedPath);

    if (staticPath.startsWith(distRoot) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      serveFile(res, staticPath);
      return;
    }

    const indexPath = path.join(distRoot, "index.html");
    if (!path.extname(requestUrl.pathname) && fs.existsSync(indexPath)) {
      serveFile(res, indexPath);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind runtime parity showcase fixture server.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startRuntimeParityShowcaseFixtureServer();
  process.stdout.write(`runtimeParityShowcaseUrl=${server.url}\n`);
}
