import { spawnSync } from "node:child_process";
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
  ".pmtiles": "application/octet-stream",
  ".png": "image/png",
};

function buildDemoIfNeeded() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "demo:pmtiles-static:build", "--silent"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: createFixtureBuildEnvironment(),
  });
  if (result.status !== 0) throw new Error("Failed to build the PMTiles Static Quickstart sample.");
}

/**
 * Serve a static file with HTTP Range support. PMTiles reads archives through
 * byte-range requests, so a static host MUST honour the `Range` header — this
 * mirrors what real object storage (S3 / R2 / GCS) provides.
 */
function serveFile(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const contentType = MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream";
  const range = req.headers.range;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] === "" ? 0 : Number.parseInt(match[1], 10);
      const end = match[2] === "" ? stat.size - 1 : Number.parseInt(match[2], 10);
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && end < stat.size) {
        res.writeHead(206, {
          "content-type": contentType,
          "content-range": `bytes ${start}-${end}/${stat.size}`,
          "accept-ranges": "bytes",
          "content-length": end - start + 1,
          "cache-control": "no-store",
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
  }

  res.writeHead(200, {
    "content-type": contentType,
    "accept-ranges": "bytes",
    "content-length": stat.size,
    "cache-control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

export async function startPmtilesStaticFixtureServer({ build = true } = {}) {
  if (build) buildDemoIfNeeded();

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    const staticPath = path.join(distRoot, requestedPath);

    if (staticPath.startsWith(distRoot) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      serveFile(req, res, staticPath);
      return;
    }

    const indexPath = path.join(distRoot, "index.html");
    if (!path.extname(requestUrl.pathname) && fs.existsSync(indexPath)) {
      serveFile(req, res, indexPath);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind PMTiles static fixture server.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve(undefined)));
        server.closeAllConnections?.();
      });
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startPmtilesStaticFixtureServer();
  process.stdout.write(`pmtilesStaticUrl=${server.url}\n`);
}
