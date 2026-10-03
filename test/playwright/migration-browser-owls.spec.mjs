/**
 * Browser page for the converted Owls of Bavaria map files
 * (loadMap.jsx, loadOwlFeatureLayer.jsx, filterOwlLayer.jsx).
 *
 * The codemod rewrites those modules and does not emit a legend or
 * registerHonuaWidgetKit. Legend stays headless. Basemap tiles are
 * fulfilled locally. Nothing in this spec contacts Esri or OpenStreetMap.
 * This is not the published-tarball receipt.
 */
import { crc32, deflateSync, inflateSync } from "node:zlib";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { buildGeometryPeerVendors, serveVendorRequest } from "./vendor-geometry-peers.mjs";

test.setTimeout(90_000);

const CENTER = [11.4, 49.0];
const MASK_GEOJSON = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "mask" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [10.0, 47.5],
            [10.3, 47.5],
            [10.3, 47.8],
            [10.0, 47.8],
            [10.0, 47.5],
          ],
        ],
      },
    },
  ],
});

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
  let orange = 0;
  let blue = 0;
  for (let index = 0; index < width * height; index += 1) {
    const pixel = index * channels;
    const r = rows[pixel];
    const g = rows[pixel + 1];
    const b = rows[pixel + 2];
    if (r > 180 && g > 70 && g < 180 && b < 90) orange += 1;
    else if (b > 80 && b > r + 30) blue += 1;
  }
  return { width, height, orange, blue };
}

function owlsSource() {
  return `
import {
  FeatureEffectCompat,
  FeatureFilterCompat,
  FeatureLayerCompat,
  GeoJSONLayerCompat,
  GraphicCompat,
  MapCompat,
  MapViewCompat,
} from "/esri-compat-entry.js";

const webmap = new MapCompat({ basemap: "dark-gray" });
const view = new MapViewCompat({
  container: "view",
  map: webmap,
  center: [${CENTER[0]}, ${CENTER[1]}],
  zoom: 7,
  constraints: {
    geometry: { type: "extent", xmin: 9.8, ymin: 47.1, xmax: 14.9, ymax: 51.6 },
    minZoom: 5,
  },
});
const background = new GeoJSONLayerCompat({
  url: "/fixtures/mask.geojson",
  renderer: {
    type: "simple",
    symbol: {
      type: "simple-fill",
      color: [240, 239, 237],
      outline: { color: "black", width: 0.2 },
    },
  },
  opacity: 0.5,
});
const owlFeatureLayer = new FeatureLayerCompat({
  source: {},
  renderer: {
    type: "simple",
    symbol: {
      type: "simple-marker",
      color: "#102A44",
      outline: { color: "#c38b1a", width: 3.5 },
    },
  },
  objectIdField: "ObjectId",
  fields: [
    { name: "ObjectId", type: "oid" },
    { name: "species_name", type: "string" },
  ],
});
webmap.add(background);
const observation = new GraphicCompat({
  attributes: { ObjectId: 1, species_name: "Eurasian Eagle-Owl" },
  geometry: { type: "point", longitude: ${CENTER[0]}, latitude: ${CENTER[1]} },
  symbol: {
    type: "simple-marker",
    color: [226, 119, 40],
    outline: { color: [255, 255, 255], width: 2 },
  },
});
owlFeatureLayer.source = [observation];
owlFeatureLayer.featureEffect = new FeatureEffectCompat({
  filter: new FeatureFilterCompat({ where: "ObjectId = 1" }),
  includedEffect: "bloom(0.9 0.6pt 0)",
  excludedEffect: "grayscale(100%) opacity(30%)",
});
webmap.layers.add(owlFeatureLayer);

view
  .when(() => {})
  .then(async () => {
    await background.load();
    const canvas = document.querySelector("#view canvas");
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
      window.__sampleError = "view reported ready while the container was blank";
    }
    window.__sample = { view, layer: owlFeatureLayer };
    window.__legend = "headless";
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
    <title>Owls converted map</title>
    <link rel="stylesheet" href="/maplibre/maplibre-gl.css" />
    <script type="importmap">${JSON.stringify({ imports: importMap })}</script>
    <style>
      html, body { margin: 0; background: #fff; }
      #view { position: relative; width: 800px; height: 600px; }
    </style>
  </head>
  <body>
    <div id="view"></div>
    <script type="module" src="/app/main.js"></script>
  </body>
</html>`;
}

function contentType(filePath) {
  const extension = path.extname(filePath);
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
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
    if (requestUrl.pathname === "/fixtures/mask.geojson") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(MASK_GEOJSON);
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

async function openOwls(page) {
  const mainSource = owlsSource();
  expect(mainSource).not.toContain("registerHonuaWidgetKit");
  const root = projectRoot();
  const vendorDir = fs.mkdtempSync(path.join(os.tmpdir(), "honua-owls-sample-"));
  const vendors = await buildGeometryPeerVendors(root, vendorDir);
  const server = await startServer(root, mainSource, vendors);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind the Owls sample server.");
  const origin = `http://127.0.0.1:${address.port}`;
  const blocked = [];
  const requests = [];
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("blob:") || url.startsWith("data:")) {
      await route.continue();
      return;
    }
    requests.push(url);
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
    return { server, vendorDir, requests };
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

test("converted Owls map paints a feature, hits it, zooms, and leaves the legend headless", async ({ page }) => {
  const sample = await openOwls(page);
  try {
    await expect
      .poll(() => sample.requests.some((url) => url.includes("World_Dark_Gray_Base")), { timeout: 15_000 })
      .toBe(true);

    const canvas = page.locator("#view canvas").first();
    await expect(canvas).toBeVisible();
    let stats = { width: 0, height: 0, orange: 0, blue: 0 };
    await expect
      .poll(
        async () => {
          stats = decodePng(await canvas.screenshot());
          return stats.orange > 8 && stats.blue > 50 ? 1 : 0;
        },
        {
          timeout: 15_000,
          intervals: [300, 600, 1000],
          message: () => `canvas ${stats.width}x${stats.height} orange=${stats.orange} blue=${stats.blue}`,
        },
      )
      .toBe(1);

    await expect(page.locator("honua-legend")).toHaveCount(0);
    expect(await page.evaluate(() => window.__legend)).toBe("headless");

    const hit = await page.evaluate(async () => {
      const view = window.__sample.view;
      const result = await view.hitTest({
        mapPoint: { longitude: 11.4, latitude: 49.0 },
      });
      return result.results[0]?.graphic?.attributes?.species_name ?? null;
    });
    expect(hit).toBe("Eurasian Eagle-Owl");

    const moved = await page.evaluate(() => {
      const view = window.__sample.view;
      const before = view.toScreen({ longitude: 11.6, latitude: 49.2 });
      const zoomBefore = view.zoom;
      view.zoom = zoomBefore + 1;
      const after = view.toScreen({ longitude: 11.6, latitude: 49.2 });
      const distance = (point) => Math.hypot(point.x - 400, point.y - 300);
      return { zoomBefore, zoomAfter: view.zoom, before: distance(before), after: distance(after) };
    });
    expect(moved.zoomAfter).toBe(moved.zoomBefore + 1);
    expect(moved.after).toBeGreaterThan(moved.before);
  } finally {
    await closeSample(sample);
  }
});
