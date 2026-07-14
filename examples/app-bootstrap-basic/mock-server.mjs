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
};

function buildDemoIfNeeded() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "demo:app-bootstrap:build", "--silent"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: createFixtureBuildEnvironment(),
  });
  if (result.status !== 0) throw new Error("Failed to build the app bootstrap sample.");
}

function serve(res, filePath) {
  res.writeHead(200, {
    "content-type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(fs.readFileSync(filePath));
}

function packageBody() {
  return {
    mapPackage: {
      mapPackageId: "app-bootstrap-demo",
      format: "honua_map_package.v1",
      status: "Ready",
      sourceBindings: [],
      initialView: { center: [-157.86, 21.3], zoom: 11 },
      legend: [{ label: "High priority", color: "#dc2626" }],
      mapSpec: {
        version: 8,
        sources: {
          incidents: {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: [
                {
                  type: "Feature",
                  id: 1,
                  properties: { name: "Harbor response district", priority: "High" },
                  geometry: { type: "Point", coordinates: [-157.87, 21.31] },
                },
              ],
            },
          },
        },
        layers: [
          { id: "basemap-background", type: "background", paint: { "background-color": "#e8eef7" } },
          {
            id: "incident-points",
            source: "incidents",
            type: "circle",
            metadata: { title: "Incident points" },
            paint: { "circle-radius": 7, "circle-color": "#dc2626" },
          },
        ],
      },
    },
  };
}

export async function startAppBootstrapFixtureServer({ build = true } = {}) {
  if (build) buildDemoIfNeeded();

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/api/v1/map-packages/app-bootstrap-demo") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        etag: "\"app-bootstrap-demo\"",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(packageBody()));
      return;
    }
    if (requestUrl.pathname === "/api/v1/map-packages/secure-map") {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("Unauthorized");
      return;
    }

    const requestedPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    const staticPath = path.join(distRoot, requestedPath);
    if (staticPath.startsWith(distRoot) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      serve(res, staticPath);
      return;
    }

    const indexPath = path.join(distRoot, "index.html");
    if (!path.extname(requestUrl.pathname) && fs.existsSync(indexPath)) {
      serve(res, indexPath);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind app bootstrap fixture server.");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startAppBootstrapFixtureServer();
  process.stdout.write(`appBootstrapUrl=${server.url}\n`);
}
