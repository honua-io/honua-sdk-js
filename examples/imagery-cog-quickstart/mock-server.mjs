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
  ".png": "image/png",
};

const TILE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mO8ePHifwYGBgYmBiQAAAcYApK+mIzmAAAAAElFTkSuQmCC",
  "base64",
);

const WMS_CAPABILITIES = `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns:xlink="http://www.w3.org/1999/xlink">
  <Service>
    <Title>Oahu Honua Imagery WMS</Title>
    <Abstract>Fixture-safe WMS surface for the Honua imagery and COG quickstart.</Abstract>
  </Service>
  <Capability>
    <Request>
      <GetMap><Format>image/png</Format></GetMap>
      <GetLegendGraphic><Format>image/png</Format></GetLegendGraphic>
    </Request>
    <Layer queryable="0">
      <Name>natural_color</Name>
      <Title>Oahu Natural Color</Title>
      <CRS>EPSG:3857</CRS>
      <CRS>EPSG:4326</CRS>
      <BoundingBox CRS="EPSG:4326" minx="-158.22" miny="21.21" maxx="-157.66" maxy="21.64"/>
      <Style>
        <Name>default</Name>
        <Title>Default natural color</Title>
      </Style>
    </Layer>
  </Capability>
</WMS_Capabilities>`;

function buildDemoIfNeeded() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "demo:imagery-cog:build", "--silent"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: createFixtureBuildEnvironment(),
  });
  if (result.status !== 0) throw new Error("Failed to build the Imagery and COG Quickstart sample.");
}

function serveFile(res, filePath) {
  res.writeHead(200, {
    "content-type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(fs.readFileSync(filePath));
}

function serveJson(res, body) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function servePng(res) {
  res.writeHead(200, {
    "content-type": "image/png",
    "cache-control": "no-store",
  });
  res.end(TILE_PNG);
}

function maybeServeHonuaFixture(requestUrl, res) {
  if (requestUrl.pathname === "/rest/services/OahuImagery/MapServer/WMS") {
    const request = (requestUrl.searchParams.get("REQUEST") ?? "GetCapabilities").toLowerCase();
    if (request === "getcapabilities") {
      res.writeHead(200, {
        "content-type": "text/xml; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(WMS_CAPABILITIES);
      return true;
    }
    servePng(res);
    return true;
  }

  if (requestUrl.pathname === "/rest/services/OahuCog/ImageServer") {
    serveJson(res, {
      serviceDescription: "Oahu Sentinel-2 COG ImageServer",
      layers: [{ id: 0, name: "oahu_sentinel2_cog" }],
      spatialReference: { wkid: 4326 },
      fullExtent: { xmin: -158.22, ymin: 21.21, xmax: -157.66, ymax: 21.64, spatialReference: { wkid: 4326 } },
      cache: {
        scope: "metadata",
        status: "hit",
        ageMs: 25_000,
        ttlMs: 600_000,
        keyFingerprint: "fixture-oahu-cog",
      },
    });
    return true;
  }

  if (requestUrl.pathname === "/rest/services/OahuCog/ImageServer/legend") {
    serveJson(res, {
      layers: [
        {
          layerId: 0,
          layerName: "oahu_sentinel2_cog",
          legend: [{ label: "Sentinel-2 visual", imageData: TILE_PNG.toString("base64"), contentType: "image/png" }],
        },
      ],
    });
    return true;
  }

  if (requestUrl.pathname === "/rest/services/OahuCog/ImageServer/exportImage") {
    serveJson(res, {
      href: "/fixtures/imagery/export/oahu-cog-preview.png",
      width: 512,
      height: 512,
      extent: { xmin: -158.22, ymin: 21.21, xmax: -157.66, ymax: 21.64, spatialReference: { wkid: 4326 } },
      scale: 144_000,
    });
    return true;
  }

  if (/^\/rest\/services\/OahuCog\/ImageServer\/tile\/\d+\/\d+\/\d+$/.test(requestUrl.pathname)) {
    servePng(res);
    return true;
  }

  if (requestUrl.pathname.startsWith("/fixtures/imagery/")) {
    servePng(res);
    return true;
  }

  return false;
}

export async function startImageryCogFixtureServer({ build = true } = {}) {
  if (build) buildDemoIfNeeded();

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (maybeServeHonuaFixture(requestUrl, res)) {
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
  if (!address || typeof address === "string") throw new Error("Failed to bind Imagery COG fixture server.");
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
  const server = await startImageryCogFixtureServer();
  process.stdout.write(`imageryCogUrl=${server.url}\n`);
}
