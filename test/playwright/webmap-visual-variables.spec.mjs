import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("WebMap point, line and outline scale ramps render at multiple zooms and latitudes", async ({ page }) => {
  test.setTimeout(120_000);
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<html><head><style>body{margin:0}#map{width:256px;height:256px}</style></head><body><div id="map"></div></body></html>');
      return;
    }
    const filename = path.resolve(root, `.${pathname}`);
    if (!filename.startsWith(`${root}${path.sep}`) || !fs.existsSync(filename)) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", filename.endsWith(".json") ? "application/json" : "text/javascript");
    response.end(fs.readFileSync(filename));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const evidence = await page.evaluate(async () => {
      const maplibregl = await import("/node_modules/maplibre-gl/dist/maplibre-gl.mjs");
      const { convertRenderer, createWarningCollector } = await import("/dist/src/webmap/index.js");
      const scale0 = 2 * Math.PI * 6378137 * 96 / (512 * 0.0254);
      const measurements = [];
      const map = new maplibregl.Map({ container: "map", style: { version: 8, sources: {}, layers: [] },
        center: [0, 0], zoom: 10, attributionControl: false, canvasContextAttributes: { preserveDrawingBuffer: true } });
      const mapErrors = [];
      map.on("error", (event) => mapErrors.push(event.error.message));
      await new Promise((resolve) => map.once("load", resolve));
      const white = [255, 255, 255, 255];
      for (const latitude of [0, 60]) {
        for (const zoom of [10, 12]) {
          for (const geometry of ["point", "line", "outline"]) {
            map.jumpTo({ center: [0, latitude], zoom });
            const variable = { type: "sizeInfo", valueExpression: "$view.scale", stops: [
              { value: scale0 / 2 ** 12, size: 18 }, { value: scale0 / 2 ** 10, size: 6 },
            ], ...(geometry === "outline" ? { target: "outline" } : {}) };
            const symbol = geometry === "point" ? { type: "esriSMS", size: 6, color: white }
              : geometry === "line" ? { type: "esriSLS", width: 1, color: white }
                : { type: "esriSFS", color: [0, 0, 0, 0], outline: { type: "esriSLS", width: 1, color: white } };
            const warn = createWarningCollector();
            const converted = convertRenderer({ type: "simple", symbol, visualVariables: [variable] }, warn);
            if (warn.warnings.length) throw new Error(JSON.stringify(warn.warnings));
            const coordinate = (x, y) => map.unproject([x, y]).toArray();
            const shape = geometry === "point" ? { type: "Point", coordinates: coordinate(128, 128) }
              : geometry === "line" ? { type: "LineString", coordinates: [coordinate(32, 128), coordinate(224, 128)] }
                : { type: "Polygon", coordinates: [[coordinate(32, 128), coordinate(224, 128), coordinate(224, 224), coordinate(32, 224), coordinate(32, 128)]] };
            map.setStyle({ version: 8, sources: { features: { type: "geojson", data: { type: "Feature", properties: {}, geometry: shape } } },
              layers: [converted, ...(converted.additionalLayers ?? [])].map((fragment, index) => ({
                id: `geometry-${index}`, source: "features", type: fragment.layerType, paint: fragment.paint, layout: fragment.layout,
              })) }, { diff: false });
            await new Promise((resolve) => map.once("idle", resolve));
            const canvas = document.createElement("canvas");
            canvas.width = map.getCanvas().width;
            canvas.height = map.getCanvas().height;
            const context = canvas.getContext("2d");
            context.drawImage(map.getCanvas(), 0, 0);
            const pixels = context.getImageData(128, 0, 1, 256).data;
            const lit = [];
            for (let y = 96; y < 160; y++) if (pixels[y * 4 + 3] > 128) lit.push(y);
            const width = lit.length ? Math.max(...lit) - Math.min(...lit) + 1 : 0;
            measurements.push({ latitude, zoom, geometry, width, expected: zoom === 10 ? 8 : 24 });
          }
        }
      }
      const fixture = await (await fetch("/test/fixtures/webmap-helicopter-renderer.json")).json();
      const warn = createWarningCollector();
      const helicopter = convertRenderer(fixture.renderer, warn, { fieldMap: { Speed: "speed" } });
      if (warn.warnings.length) throw new Error(JSON.stringify(warn.warnings));
      map.jumpTo({ center: [0, 40.7], zoom: 21 });
      const stops = fixture.renderer.visualVariables[0].stops;
      const features = stops.map((stop, index) => ({ type: "Feature", properties: { speed: stop.value }, geometry: {
        type: "LineString", coordinates: [map.unproject([32, 32 + index * 40]).toArray(), map.unproject([224, 32 + index * 40]).toArray()],
      } }));
      map.setStyle({ version: 8, sources: { flights: { type: "geojson", data: { type: "FeatureCollection", features } } },
        layers: [{ id: "flights", source: "flights", type: helicopter.layerType, paint: helicopter.paint }] }, { diff: false });
      await new Promise((resolve) => map.once("idle", resolve));
      const image = document.createElement("canvas");
      image.width = 256; image.height = 256;
      const context = image.getContext("2d");
      context.drawImage(map.getCanvas(), 0, 0);
      const colorSamples = stops.map((stop, index) => ({ speed: stop.value, expected: stop.color,
        actual: [...context.getImageData(128, 32 + index * 40, 1, 1).data] }));
      map.remove();
      return { measurements, colorSamples, mapErrors };
    });
    await test.info().attach("scale-rendering-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
    expect(evidence.mapErrors).toEqual([]);
    expect(errors).toEqual([]);
    expect(evidence.measurements).toHaveLength(12);
    for (const result of evidence.measurements) {
      expect(Math.abs(result.width - result.expected), JSON.stringify(result)).toBeLessThanOrEqual(2);
    }
    for (const sample of evidence.colorSamples) {
      for (let component = 0; component < 4; component++) {
        expect(Math.abs(sample.actual[component] - sample.expected[component]), JSON.stringify(sample)).toBeLessThanOrEqual(3);
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
