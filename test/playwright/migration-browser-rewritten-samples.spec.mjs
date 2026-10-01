/**
 * Fixture-backed browser gate for the rewritten 2D ArcGIS samples
 * (intro-featurelayer, featurelayer-query, popup-actions).
 *
 * The page is the compat shape those rewrites emit: an in-memory
 * FeatureLayerCompat, MapViewCompat, and registerHonuaWidgetKit before any
 * hosted widget. Basemap tiles are fulfilled locally. Nothing in this spec
 * contacts Esri or OpenStreetMap.
 */
import { crc32, deflateSync, inflateSync } from "node:zlib";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { buildGeometryPeerVendors, serveVendorRequest } from "./vendor-geometry-peers.mjs";

const OAK = {
  attributes: { OBJECTID: 1, name: "Oak" },
  geometry: { type: "point", longitude: -82.44, latitude: 35.61 },
};
const PINE = {
  attributes: { OBJECTID: 2, name: "Pine" },
  geometry: { type: "point", longitude: -82.2, latitude: 35.61 },
};

test.setTimeout(90_000);

function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, checksum]);
}

/** Solid RGB PNG. MapLibre stretches it to the raster tile size. */
function solidPng(width, height, red, green, blue) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const index = row + 1 + x * 3;
      raw[index] = red;
      raw[index + 1] = green;
      raw[index + 2] = blue;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const TILE_PNG = solidPng(16, 16, 26, 58, 140);

function decodePng(bytes) {
  const png = Buffer.from(bytes);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels || width === 0 || height === 0) {
    throw new Error(`Unsupported screenshot PNG (color type ${colorType}, ${width}x${height})`);
  }
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (stride + 1)];
    const from = y * (stride + 1) + 1;
    const to = y * stride;
    const above = (y - 1) * stride;
    for (let index = 0; index < stride; index += 1) {
      const raw = inflated[from + index];
      const left = index >= channels ? rows[to + index - channels] : 0;
      const up = y > 0 ? rows[above + index] : 0;
      const upLeft = y > 0 && index >= channels ? rows[above + index - channels] : 0;
      let value = raw;
      if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + ((left + up) >> 1);
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const dLeft = Math.abs(estimate - left);
        const dUp = Math.abs(estimate - up);
        const dUpLeft = Math.abs(estimate - upLeft);
        value = raw + (dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft);
      } else if (filter !== 0) {
        throw new Error(`Unknown PNG filter ${filter}`);
      }
      rows[to + index] = value & 0xff;
    }
  }
  let red = 0;
  let blue = 0;
  for (let index = 0; index < width * height; index += 1) {
    const pixel = index * channels;
    const r = rows[pixel];
    const g = rows[pixel + 1];
    const b = rows[pixel + 2];
    if (r > 140 && r > g + 40 && r > b + 40) red += 1;
    else if (b > 80 && b > r + 30) blue += 1;
  }
  return { width, height, red, blue };
}

function sampleSource(features, withPopup) {
  return `
import {
  FeatureLayerCompat,
  LegendCompat,
  MapCompat,
  MapViewCompat,
  PopupCompat,
  ZoomCompat,
  registerHonuaWidgetKit,
} from "/esri-compat-entry.js";

registerHonuaWidgetKit(() => import("@honua/sdk-js/web-components"));

const layer = new FeatureLayerCompat({
  title: "Trees",
  objectIdField: "OBJECTID",
  geometryType: "point",
  source: ${JSON.stringify(features)},
  renderer: { type: "simple", symbol: { type: "simple-marker", color: "#c62828", size: 12 } },
});
const map = new MapCompat({ basemap: "hybrid", layers: [layer] });
const view = new MapViewCompat({
  container: "view",
  map,
  center: [-82.44, 35.61],
  zoom: 11,
});

view.when()
  .then(async () => {
    const legend = new LegendCompat({ view, container: "legend" });
    new ZoomCompat({ view, container: "zoom" });
    ${withPopup ? 'new PopupCompat({ view, container: "popup" });' : ""}
    await legend.when();
    window.__sample = { view, layer };
    window.__sampleReady = true;
  })
  .catch((error) => {
    window.__sampleError = String(error && error.stack ? error.stack : error);
    window.__sampleReady = true;
  });
`;
}

function indexHtml(importMap) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Rewritten sample</title>
    <link rel="stylesheet" href="/maplibre/maplibre-gl.css" />
    <script type="importmap">${JSON.stringify({ imports: importMap })}</script>
    <style>
      html, body { margin: 0; background: #fff; }
      #view { position: relative; width: 800px; height: 600px; }
      #legend, #zoom, #popup { position: absolute; z-index: 2; background: #fff; }
      #legend { top: 12px; left: 820px; width: 180px; }
      #zoom { top: 12px; left: 12px; }
      #popup { top: 220px; left: 820px; width: 280px; }
    </style>
  </head>
  <body>
    <div id="view"></div>
    <div id="legend"></div>
    <div id="zoom"></div>
    <div id="popup"></div>
    <script type="module" src="/app/main.js"></script>
  </body>
</html>`;
}

function contentType(filePath) {
  const extension = path.extname(filePath);
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".png") return "image/png";
  return "text/javascript; charset=utf-8";
}

function startServer(root, mainSource, vendors) {
  const distSourceRoot = path.join(root, "dist", "src");
  const maplibreRoot = path.join(root, "node_modules", "maplibre-gl", "dist");
  const html = indexHtml({
    ...vendors.imports,
    "maplibre-gl": "/maplibre/maplibre-gl.mjs",
    "@honua/sdk-js/web-components": "/_deprecated/web-components.js",
  });

  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (serveVendorRequest(requestUrl, response, vendors.outDir)) return;
    if (requestUrl.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (requestUrl.pathname === "/app/main.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(mainSource);
      return;
    }

    const maplibrePath = path.resolve(maplibreRoot, requestUrl.pathname.slice("/maplibre/".length));
    if (
      requestUrl.pathname.startsWith("/maplibre/") &&
      maplibrePath.startsWith(`${maplibreRoot}${path.sep}`) &&
      fs.existsSync(maplibrePath) &&
      fs.statSync(maplibrePath).isFile()
    ) {
      response.writeHead(200, { "content-type": contentType(maplibrePath) });
      response.end(fs.readFileSync(maplibrePath));
      return;
    }

    const distPath = path.resolve(distSourceRoot, requestUrl.pathname.slice(1));
    if (distPath.startsWith(`${distSourceRoot}${path.sep}`) && fs.existsSync(distPath) && fs.statSync(distPath).isFile()) {
      response.writeHead(200, { "content-type": contentType(distPath) });
      response.end(fs.readFileSync(distPath));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function openSample(page, features, withPopup) {
  const root = projectRoot();
  const vendorDir = fs.mkdtempSync(path.join(os.tmpdir(), "honua-rewritten-sample-"));
  const vendors = await buildGeometryPeerVendors(root, vendorDir);
  const server = await startServer(root, sampleSource(features, withPopup), vendors);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind the rewritten-sample server.");
  const origin = `http://127.0.0.1:${address.port}`;
  const blocked = [];
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("blob:") || url.startsWith("data:")) {
      await route.continue();
      return;
    }
    if (/arcgisonline\.com|openstreetmap\.org/i.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        headers: { "access-control-allow-origin": "*" },
        body: TILE_PNG,
      });
      return;
    }
    blocked.push(url);
    await route.abort();
  });
  try {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.goto(origin);
    await expect.poll(() => page.evaluate(() => window.__sampleReady === true), { timeout: 30_000 }).toBe(true);
    const sampleError = await page.evaluate(() => window.__sampleError ?? null);
    expect(sampleError, sampleError ?? "").toBeNull();
    expect(pageErrors).toEqual([]);
    expect(blocked).toEqual([]);
    return { server, vendorDir };
  } catch (error) {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    fs.rmSync(vendorDir, { recursive: true, force: true });
    throw error;
  }
}

async function closeSample(sample) {
  await new Promise((resolve) => sample.server.close(() => resolve(undefined)));
  fs.rmSync(sample.vendorDir, { recursive: true, force: true });
}

async function paintedCanvas(page) {
  const canvas = page.locator("#view canvas").first();
  await expect(canvas).toBeVisible();
  let stats = { width: 0, height: 0, red: 0, blue: 0 };
  await expect
    .poll(
      async () => {
        stats = decodePng(await canvas.screenshot());
        return stats.red > 8 && stats.blue > 50 ? 1 : 0;
      },
      {
        timeout: 15_000,
        intervals: [300, 600, 1000],
        message: () => `canvas ${stats.width}x${stats.height} red=${stats.red} blue=${stats.blue}`,
      },
    )
    .toBe(1);
}

test("intro-featurelayer paints a feature, hits it, zooms, and mounts the legend", async ({ page }) => {
  const sample = await openSample(page, [OAK], false);
  try {
    await paintedCanvas(page);
    const legend = page.locator("#legend honua-legend");
    await expect(legend).toBeVisible();
    await expect(legend.getByRole("heading", { name: "Legend" })).toBeVisible();
    await expect(legend.getByRole("listitem").filter({ hasText: "Trees" })).toBeVisible();
    await expect(legend.locator(".swatch").first()).toBeVisible();
    await expect(legend.getByText("No legend")).toHaveCount(0);

    const hit = await page.evaluate(async () => {
      const view = window.__sample.view;
      const result = await view.hitTest({
        mapPoint: { longitude: -82.44, latitude: 35.61 },
      });
      return result.results[0]?.graphic?.attributes?.name ?? null;
    });
    expect(hit).toBe("Oak");

    const zoomBefore = await page.evaluate(() => window.__sample.view.zoom);
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(() => page.evaluate(() => window.__sample.view.zoom)).toBe(zoomBefore + 1);
  } finally {
    await closeSample(sample);
  }
});

test("featurelayer-query definitionExpression changes the feature count", async ({ page }) => {
  const sample = await openSample(page, [OAK, PINE], false);
  try {
    await paintedCanvas(page);
    const counts = await page.evaluate(async () => {
      const layer = window.__sample.layer;
      const all = await layer.queryFeatures();
      layer.setDefinitionExpression("name = 'Oak'");
      const oaks = await layer.queryFeatures();
      layer.setDefinitionExpression("name = 'Missing'");
      const none = await layer.queryFeatures();
      return {
        all: all.features.length,
        oaks: oaks.features.map((feature) => feature.attributes.name),
        none: none.features.length,
      };
    });
    expect(counts.all).toBe(2);
    expect(counts.oaks).toEqual(["Oak"]);
    expect(counts.none).toBe(0);
  } finally {
    await closeSample(sample);
  }
});

test("popup-actions opens the clicked feature and mounts the popup host", async ({ page }) => {
  const sample = await openSample(page, [OAK], true);
  try {
    await paintedCanvas(page);
    await expect(page.locator("#popup honua-feature-inspection")).toBeVisible();
    await expect(page.locator("#popup honua-feature-inspection").getByRole("search")).toBeVisible();

    await page.locator("#view canvas").click();
    await expect(page.locator("#view .honua-popup")).toContainText("Oak");

    const popup = await page.evaluate(() => ({
      visible: window.__sample.view.popup.visible,
      title: window.__sample.view.popup.title,
    }));
    expect(popup.visible).toBe(true);
    expect(popup.title).toBe("Oak");
  } finally {
    await closeSample(sample);
  }
});
