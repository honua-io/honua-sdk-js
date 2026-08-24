import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
  buildPage,
  measureMapLibre,
  parseBundleSizes,
  parseMatrixProtocolColumns,
} from "../../scripts/generate-comparison-page.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function createMapLibreFixture(version, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "honua-maplibre-measurement-"));
  const packageRoot = path.join(root, "node_modules", "maplibre-gl");
  fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version }));
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(packageRoot, file), content);
  }
  return root;
}

function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

test("parseBundleSizes extracts the generated stamp and measurement rows", () => {
  const markdown = [
    "<!-- GENERATED FILE — do not edit by hand. -->",
    "",
    "# Bundle sizes",
    "",
    "_Generated 2026-07-13 at commit `abc1234`._",
    "",
    "| Entrypoint | Min | Min budget | Gzip | Gzip budget |",
    "| --- | ---: | ---: | ---: | ---: |",
    "| `.` (root) | 369.4 KiB | 382.0 KiB | 97.1 KiB | 101.2 KiB |",
    "| `/geocoding` | 12.5 KiB | 13.7 KiB | 3.9 KiB | 4.3 KiB |",
    "",
  ].join("\n");
  const bundle = parseBundleSizes(markdown);
  assert.equal(bundle.date, "2026-07-13");
  assert.equal(bundle.commit, "abc1234");
  assert.deepEqual(bundle.rows.get("`.` (root)"), { min: "369.4 KiB", gzip: "97.1 KiB" });
  assert.deepEqual(bundle.rows.get("`/geocoding`"), { min: "12.5 KiB", gzip: "3.9 KiB" });
});

test("parseBundleSizes rejects a document without the generated stamp", () => {
  assert.throws(() => parseBundleSizes("# Bundle sizes\n"), /generated date\/commit/);
});

test("parseMatrixProtocolColumns returns the protocol column headers", () => {
  const markdown = [
    "# Protocol × Capability Matrix",
    "",
    "| Capability | gRPC | GS Feature | WFS | OData |",
    "| --- | :-: | :-: | :-: | :-: |",
    "| `query` | ✓ | ✓ | ✓ | ✓ |",
  ].join("\n");
  assert.deepEqual(parseMatrixProtocolColumns(markdown), ["gRPC", "GS Feature", "WFS", "OData"]);
});

test("the generated protocol matrix exposes the canonical GeoParquet header", () => {
  const matrix = fs.readFileSync(path.join(ROOT, "docs", "protocol-capability-matrix.md"), "utf8");
  const columns = parseMatrixProtocolColumns(matrix);
  assert.ok(columns.includes("GeoParquet"));
  assert.equal(columns.includes("GeoParq"), false);
});

test("measureMapLibre reports the pinned version with KiB measurements", () => {
  const measured = measureMapLibre(ROOT);
  assert.match(measured.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(measured.files, [
    "dist/maplibre-gl.mjs",
    "dist/maplibre-gl-shared.mjs",
    "dist/maplibre-gl-worker.mjs",
  ]);
  assert.match(measured.min, /^[\d.]+ KiB$/);
  assert.match(measured.gzip, /^[\d.]+ KiB$/);
});

test("measureMapLibre selects the self-contained v5 distribution deterministically", (t) => {
  const umd = Buffer.alloc(2_048, 1);
  const root = createMapLibreFixture("5.24.0", {
    "dist/maplibre-gl.js": umd,
    "dist/maplibre-gl.mjs": Buffer.alloc(8_192, 2),
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const measured = measureMapLibre(root);
  assert.deepEqual(measured.files, ["dist/maplibre-gl.js"]);
  assert.equal(measured.min, kib(umd.byteLength));
  assert.equal(measured.gzip, kib(gzipSync(umd, { level: 9 }).byteLength));
});

test("measureMapLibre selects and sums the complete v6 ESM graph deterministically", (t) => {
  const main = Buffer.alloc(1_024, 1);
  const shared = Buffer.alloc(2_048, 2);
  const worker = Buffer.alloc(3_072, 3);
  const root = createMapLibreFixture("6.0.0", {
    "dist/maplibre-gl.js": Buffer.alloc(8_192, 4),
    "dist/maplibre-gl.mjs": main,
    "dist/maplibre-gl-shared.mjs": shared,
    "dist/maplibre-gl-worker.mjs": worker,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const measured = measureMapLibre(root);
  assert.deepEqual(measured.files, [
    "dist/maplibre-gl.mjs",
    "dist/maplibre-gl-shared.mjs",
    "dist/maplibre-gl-worker.mjs",
  ]);
  assert.equal(measured.min, kib(main.byteLength + shared.byteLength + worker.byteLength));
  assert.equal(
    measured.gzip,
    kib(
      gzipSync(main, { level: 9 }).byteLength +
        gzipSync(shared, { level: 9 }).byteLength +
        gzipSync(worker, { level: 9 }).byteLength,
    ),
  );
});

test("buildPage is deterministic and carries the freshness contract", () => {
  const first = buildPage(ROOT);
  const second = buildPage(ROOT);
  assert.equal(first, second, "two builds from the same inputs must be byte-identical");
  assert.match(first, /GENERATED FILE — do not edit by hand/);
  assert.match(first, /npm run docs:comparison/);
  // Every external figure needs a pinned source URL and the Honua bundle
  // figures must come from the generated bundle-sizes doc, not hand-writing.
  assert.match(first, /github\.com\/Esri\/jsapi-resources\/blob\/9fe7d8cc7/);
  assert.match(first, /retrieved 2026-07-13/);
  const committedBundleDoc = fs.readFileSync(path.join(ROOT, "docs", "bundle-sizes.md"), "utf8");
  const rootGzip = /\| `\.` \(root\) \| [\d.]+ KiB \| [\d.]+ KiB \| ([\d.]+ KiB) \|/.exec(committedBundleDoc);
  assert.ok(rootGzip, "committed bundle-sizes.md must measure the root entrypoint");
  assert.ok(first.includes(rootGzip[1]), "comparison page must carry the generated root gzip figure");
  assert.match(first, /`mapbox-gl`/);
  assert.match(first, /`@carto\/api-client`/);
  assert.match(first, /`@feltmaps\/js-sdk`/);
});
