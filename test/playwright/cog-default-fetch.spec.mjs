import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "test/fixtures/cog/scenarios.json"), "utf8"));

test("COG default native browser fetch inspects and reads ranges without an injected fetch", async ({ page }) => {
  const ranges = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>COG native fetch</title>");
    } else if (pathname === "/asset.tif") {
      const range = request.headers.range;
      ranges.push(range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
      if (!match) return response.writeHead(400).end();
      const bytes = Buffer.from(fixture.assetText);
      const [start, end] = match.slice(1).map(Number);
      response.writeHead(206, {
        "content-range": `bytes ${start}-${end}/${bytes.length}`,
        "content-type": "image/tiff",
      }).end(bytes.subarray(start, end + 1));
    } else if (pathname.startsWith("/dist/src/")) {
      const file = path.resolve(root, `.${pathname}`);
      if (!file.startsWith(`${root}/dist/src/`) || !fs.existsSync(file)) return response.writeHead(404).end();
      response.writeHead(200, { "content-type": "text/javascript" }).end(fs.readFileSync(file));
    } else response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async ({ metadata }) => {
      const { openStacCogAsset } = await import("/dist/src/cog/index.js");
      const session = openStacCogAsset({
        id: "item:visual", state: "classified", kind: "cog", confidence: "high",
        documentUrl: `${location.origin}/item.json`, objectType: "item", objectId: "item", assetKey: "visual",
        href: `${location.origin}/asset.tif`, mediaType: "image/tiff; application=geotiff; profile=cloud-optimized",
        roles: ["data"], metadata: {},
        evidence: [{ kind: "media-type", value: "image/tiff; application=geotiff; profile=cloud-optimized", supports: ["cog"] }],
        provenance: [{ source: `${location.origin}/item.json`, retrievedAt: "2026-11-12T00:00:00.000Z" }],
      }, {
        decoderFactory: async () => ({
          async inspect({ readRange }) { await readRange({ offset: 0, length: 8 }); return metadata; },
          async readWindow(_request, { readRange }) {
            const values = await readRange({ offset: 64, length: 4 });
            return { width: 2, height: 2, bands: [{ band: 1, values }] };
          },
        }),
      });
      try {
        await session.inspect();
        const window = await session.readWindow({ x: 0, y: 0, width: 2, height: 2, bands: [1] });
        return { width: window.width, height: window.height };
      } finally { await session.dispose(); }
    }, fixture);
    expect(result).toEqual({ width: 2, height: 2 });
    expect(ranges).toEqual(["bytes=0-7", "bytes=64-67"]);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
