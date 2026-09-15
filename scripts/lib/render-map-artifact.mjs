// Renders a MapLibre style in headless Chromium and returns the canvas as PNG
// bytes, for receipt pixel assertions on a portable map artifact.
//
// The browser automation module and the MapLibre distribution are injected so
// the caller decides which bytes render: the lifecycle receipt passes the
// copies installed in its isolated registry consumer, never the repository's
// own. MapLibre 6 ships ES modules that import their shared chunk and worker
// relative to themselves, so the distribution is served from a loopback HTTP
// server for the life of one render.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";

const TYPES = { ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };

async function serveDistribution(distDir) {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://loopback").pathname;
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><html><body style="margin:0;background:#ffffff"><div id="map"></div></body></html>');
      return;
    }
    const file = normalize(join(distDir, path));
    if (!file.startsWith(normalize(distDir))) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/**
 * @param {object} options
 * @param {{ chromium: { launch: Function } }} options.playwright
 * @param {string} options.maplibreDistDir  the installed maplibre-gl/dist directory
 * @param {object} options.style            MapLibre style document
 * @param {[number, number]} options.center
 * @param {number} options.zoom
 * @param {number} [options.size=512]
 * @returns {Promise<{ png: Buffer, renderer: string, maplibreVersion: string }>}
 */
export async function renderMapStyle({ playwright, maplibreDistDir, style, center, zoom, size = 512 }) {
  const { server, origin } = await serveDistribution(maplibreDistDir);
  const browser = await playwright.chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/`);
    const result = await page.evaluate(async ({ origin, style, center, zoom, size }) => {
      const maplibregl = await import(`${origin}/maplibre-gl.mjs`);
      const api = maplibregl.default ?? maplibregl;
      const container = document.getElementById("map");
      container.style.width = `${size}px`;
      container.style.height = `${size}px`;
      const map = new api.Map({
        container, style, center, zoom, interactive: false, attributionControl: false,
        fadeDuration: 0, canvasContextAttributes: { preserveDrawingBuffer: true },
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("MapLibre did not reach idle within 30 s")), 30_000);
        map.once("error", (event) => { clearTimeout(timer); reject(new Error(event.error?.message ?? "MapLibre error")); });
        map.once("idle", () => { clearTimeout(timer); resolve(); });
      });
      const gl = map.getCanvas().getContext("webgl2") ?? map.getCanvas().getContext("webgl");
      return {
        dataUrl: map.getCanvas().toDataURL("image/png"),
        renderer: gl ? String(gl.getParameter(gl.VERSION)) : "unknown",
        version: api.getVersion?.() ?? "unknown",
      };
    }, { origin, style, center, zoom, size });
    if (errors.length > 0) throw new Error(`page errors while rendering: ${errors.join("; ")}`);
    return {
      png: Buffer.from(result.dataUrl.replace(/^data:image\/png;base64,/, ""), "base64"),
      renderer: `Chromium ${browser.version()} ${result.renderer}`,
      maplibreVersion: result.version,
    };
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
