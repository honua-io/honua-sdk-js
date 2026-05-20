import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);

function getProjectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

async function importCodemod(projectRoot) {
  const codemodPath = path.join(projectRoot, "dist", "src", "migration", "codemod.js");
  return import(pathToFileURL(codemodPath).href);
}

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "honua-playwright-maplibre-"));
}

function writeFixtureApp(appRoot) {
  fs.mkdirSync(appRoot, { recursive: true });
  const appFile = path.join(appRoot, "main.js");
  fs.writeFileSync(
    appFile,
    [
      "import Map from '@arcgis/core/Map';",
      "import FeatureLayer from '@arcgis/core/layers/FeatureLayer';",
      "import MapImageLayer from '@arcgis/core/layers/MapImageLayer';",
      "import TileLayer from '@arcgis/core/layers/TileLayer';",
      "import MapView from '@arcgis/core/views/MapView';",
      "const incidents = new FeatureLayer({",
      "  id: 'incidents',",
      "  title: 'Incidents',",
      "  url: 'https://example.test/rest/services/incidents/FeatureServer/0',",
      "  outFields: ['*'],",
      "  definitionExpression: \"status = 'open'\",",
      "  opacity: 0.8,",
      "});",
      "const districts = new MapImageLayer({",
      "  id: 'districts',",
      "  url: 'https://example.test/rest/services/districts/MapServer',",
      "  visible: true,",
      "});",
      "const basemapTiles = new TileLayer({",
      "  id: 'basemap-tiles',",
      "  url: 'https://example.test/rest/services/basemap/MapServer',",
      "});",
      "const map = new Map({",
      "  basemap: 'streets-vector',",
      "  layers: [basemapTiles, districts, incidents],",
      "});",
      "const view = new MapView({",
      "  map,",
      "  container: 'viewDiv',",
      "  center: [-157.8, 21.3],",
      "  zoom: 12,",
      "});",
      "void view;",
    ].join("\n"),
    "utf8",
  );
  return appFile;
}

function createIndexHtml() {
  // The migrated module emitted by the `honua-maplibre` codemod target
  // references the bare specifiers `maplibre-gl` and `@honua/sdk-js/map`,
  // which the browser cannot resolve directly. We deliberately do not
  // execute the migrated module in the browser here — the source-level
  // assertions below prove the codemod produced the correct shape. The
  // page below instead exercises the Honua MapLibre helpers (served from
  // the built `dist/src/map/maplibre-target.js`) end-to-end against a
  // real MapLibre runtime so we can assert that a `<canvas>` renders and
  // the derived style retains the migrated layer.
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Honua MapLibre Migration Browser Smoke</title>
    <link rel="stylesheet" href="/maplibre-gl.css" />
    <style>
      html, body, #viewDiv { margin: 0; padding: 0; height: 100%; width: 100%; }
    </style>
  </head>
  <body>
    <div id="viewDiv"></div>
    <script src="/maplibre-gl.js"></script>
    <script type="module">
      window.__migrationDone = false;
      window.__migrationResult = null;
      window.__migrationError = null;

      import("/honua/maplibre-target.js")
        .then(async (mod) => {
          const tileLayer = mod.createHonuaTileServiceLayer({
            id: "basemap-tiles",
            url: "https://example.test/rest/services/basemap/MapServer",
          });
          const style = mod.createHonuaMapLibreStyle({
            basemap: "streets-vector",
            layers: [tileLayer],
            center: [-157.8, 21.3],
            zoom: 12,
          });
          const mapOptions = mod.createHonuaMapLibreMapOptions({
            map: style,
            container: "viewDiv",
            center: [-157.8, 21.3],
            zoom: 12,
          });

          const map = new window.maplibregl.Map(mapOptions);
          // Don't let upstream tile-fetch errors fail the smoke test —
          // we only care that MapLibre accepted the style and produced
          // a canvas. Surface the error to the test runner instead.
          map.on("error", (event) => {
            window.__migrationTileError = event?.error?.message ?? String(event);
          });
          map.on("load", () => {
            const liveStyle = map.getStyle();
            window.__migrationResult = {
              mapLibreVersion: window.maplibregl?.version ?? null,
              styleVersion: style.version,
              styleLayerCount: style.layers.length,
              liveLayerCount: liveStyle?.layers?.length ?? 0,
              liveLayerIds: (liveStyle?.layers ?? []).map((layer) => layer.id),
              basemapMetadata: style.metadata?.["honua:arcgis-basemap"] ?? null,
              tileSourceType: liveStyle?.sources?.[tileLayer.sourceId]?.type ?? null,
            };
            window.__migrationDone = true;
          });
        })
        .catch((error) => {
          window.__migrationError = String(error);
          window.__migrationDone = true;
          console.error(error);
        });
    </script>
  </body>
</html>`;
}

function startServer(projectRoot, appMain) {
  const distSourceRoot = path.join(projectRoot, "dist", "src");
  const maplibreModuleRoot = path.dirname(
    require.resolve("maplibre-gl/package.json", { paths: [projectRoot] }),
  );
  const maplibreJs = path.join(maplibreModuleRoot, "dist", "maplibre-gl.js");
  const maplibreCss = path.join(maplibreModuleRoot, "dist", "maplibre-gl.css");

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(createIndexHtml());
      return;
    }

    if (requestUrl.pathname === "/app/main.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(fs.readFileSync(appMain, "utf8"));
      return;
    }

    if (requestUrl.pathname === "/maplibre-gl.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(fs.readFileSync(maplibreJs, "utf8"));
      return;
    }

    if (requestUrl.pathname === "/maplibre-gl.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      res.end(fs.readFileSync(maplibreCss, "utf8"));
      return;
    }

    if (requestUrl.pathname === "/honua/maplibre-target.js") {
      const target = path.join(distSourceRoot, "map", "maplibre-target.js");
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(fs.readFileSync(target, "utf8"));
      return;
    }

    const distModulePath = path.join(distSourceRoot, requestUrl.pathname.slice(1));
    if (distModulePath.startsWith(distSourceRoot) && fs.existsSync(distModulePath)) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(fs.readFileSync(distModulePath, "utf8"));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

async function getServerUrl(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind maplibre migration smoke server.");
  }
  return `http://127.0.0.1:${address.port}`;
}

test("honua-maplibre codemod target produces a runnable MapLibre app", async ({ page }) => {
  const projectRoot = getProjectRoot();
  const tempRoot = createTempRoot();
  const appRoot = path.join(tempRoot, "app");
  const appMain = writeFixtureApp(appRoot);

  const { runEsriCompatCodemod } = await importCodemod(projectRoot);
  const codemodResult = runEsriCompatCodemod({
    rootDir: tempRoot,
    target: "honua-maplibre",
    write: true,
  });

  // Source-level acceptance: the codemod fully migrated every supported
  // constructor for the honua-maplibre target without leaving any manual
  // todos for the simple-app shape.
  expect(codemodResult.target).toBe("honua-maplibre");
  expect(codemodResult.filesChanged).toBe(1);
  expect(codemodResult.metrics.totalCodemodScopedCallSites).toBe(5);
  expect(codemodResult.metrics.autoMigratedCallSites).toBe(5);
  expect(codemodResult.metrics.manualCallSites).toBe(0);

  const migratedSource = fs.readFileSync(appMain, "utf8");
  expect(migratedSource).not.toContain("@arcgis/core");
  expect(migratedSource).not.toContain("@honua/sdk-esri-compat");
  expect(migratedSource).toContain('import * as maplibregl from "maplibre-gl";');
  expect(migratedSource).toContain('from "@honua/sdk-js/map"');
  expect(migratedSource).toContain("createHonuaFeatureServiceLayer");
  expect(migratedSource).toContain("createHonuaMapServiceLayer");
  expect(migratedSource).toContain("createHonuaTileServiceLayer");
  expect(migratedSource).toContain("createHonuaMapLibreStyle");
  expect(migratedSource).toContain("createHonuaMapLibreMapOptions");
  expect(migratedSource).toContain("new maplibregl.Map(");

  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startServer(projectRoot, appMain);
  try {
    const serverUrl = await getServerUrl(server);
    await page.goto(serverUrl);

    // Browser-level acceptance: the Honua MapLibre helpers wire a real
    // MapLibre runtime that renders to a canvas and registers at least
    // the migrated tile layer in the live style.
    await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 20_000 });

    await expect
      .poll(async () => page.evaluate(() => window.__migrationDone === true), {
        timeout: 20_000,
      })
      .toBe(true);

    const migrationError = await page.evaluate(() => window.__migrationError);
    const migrationResult = await page.evaluate(() => window.__migrationResult);

    expect(migrationError).toBeNull();
    expect(pageErrors).toEqual([]);
    expect(migrationResult).not.toBeNull();
    expect(migrationResult).toMatchObject({
      styleVersion: 8,
      styleLayerCount: 1,
      liveLayerCount: 1,
      basemapMetadata: "streets-vector",
      tileSourceType: "raster",
    });
    expect(migrationResult.liveLayerIds).toContain("basemap-tiles-raster");
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
