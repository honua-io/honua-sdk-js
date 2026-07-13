import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPage,
  measureMapLibre,
  parseBundleSizes,
  parseMatrixProtocolColumns,
} from "../../scripts/generate-comparison-page.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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

test("measureMapLibre reports the pinned version with KiB measurements", () => {
  const measured = measureMapLibre(ROOT);
  assert.match(measured.version, /^\d+\.\d+\.\d+/);
  assert.match(measured.min, /^[\d.]+ KiB$/);
  assert.match(measured.gzip, /^[\d.]+ KiB$/);
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
});
