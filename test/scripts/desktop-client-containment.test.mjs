import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { inspectDesktopClientContainment } from "../../scripts/lib/desktop-client-containment.mjs";

const desktopProduct = ["ArcGIS", " Pro"].join("");
const hyphenatedProduct = ["ArcGIS", "-Pro"].join("");
const scriptingInterface = ["Arc", "Py"].join("");
const projectPath = ["test/fixtures/client.", "aprx"].join("");
const toolboxPath = ["test/fixtures/tool.", "atbx"].join("");

test("rejects references outside the nominative allowlist", () => {
  const result = inspectDesktopClientContainment([
    { path: "docs/compatibility.md", content: `Compatibility with ${desktopProduct}.` },
    { path: "docs/scripting.md", content: scriptingInterface },
    { path: "docs/hyphen.md", content: `${hyphenatedProduct} project` },
  ]);

  assert.deepEqual(result.unexpected, [
    { path: "docs/compatibility.md", line: 1 },
    { path: "docs/scripting.md", line: 1 },
    { path: "docs/hyphen.md", line: 1 },
  ]);
  assert.deepEqual(result.missing, []);
});

test("does not treat provider, property, or provenance as the desktop product", () => {
  const result = inspectDesktopClientContainment([
    { path: "bundle-budgets.json", content: "ArcGIS provider mapping" },
    { path: "test/feature-filter-compat.test.ts", content: "projects onto the ArcGIS property shape" },
    { path: "src/migration/oss-corpus.ts", content: "export interface OssArcGisProvenance {" },
    { path: "docs/hyphen-prefix.md", content: "ArcGIS-property and ArcGIS-provenance stay" },
  ]);

  assert.deepEqual(result.unexpected, []);
  assert.deepEqual(result.missing, []);
});

test("rejects desktop project and toolbox paths before binary content is skipped", () => {
  const result = inspectDesktopClientContainment([
    { path: projectPath, content: "PK\0binary" },
    { path: toolboxPath, content: "plain text toolbox artifact" },
  ]);

  assert.deepEqual(result.unexpected, [
    { path: projectPath, line: 1 },
    { path: toolboxPath, line: 1 },
  ]);
});

test("skips binary content when the tracked path is not a desktop artifact", () => {
  const result = inspectDesktopClientContainment([
    { path: "assets/photo.bin", content: `prefix\0${desktopProduct}` },
  ]);

  assert.deepEqual(result.unexpected, []);
});

test("reports a modified allowlisted line instead of allowing detail beside it", () => {
  const allowedLine = `Compatibility with ${desktopProduct}.`;
  const hash = createHash("sha256").update(allowedLine).digest("hex");
  const allowedLineHashes = new Map([["docs/compatibility.md", new Set([hash])]]);
  const result = inspectDesktopClientContainment(
    [{ path: "docs/compatibility.md", content: `${allowedLine} with added text` }],
    { allowedLineHashes },
  );

  assert.deepEqual(result.unexpected, [{ path: "docs/compatibility.md", line: 1 }]);
  assert.deepEqual(result.missing, [{ path: "docs/compatibility.md", hash }]);
});

test("accepts an unchanged allowlisted nominative line", () => {
  const allowedLine = `Compatibility with ${desktopProduct}.`;
  const hash = createHash("sha256").update(allowedLine).digest("hex");
  const allowedLineHashes = new Map([["docs/compatibility.md", new Set([hash])]]);
  const result = inspectDesktopClientContainment(
    [{ path: "docs/compatibility.md", content: allowedLine }],
    { allowedLineHashes },
  );

  assert.deepEqual(result.unexpected, []);
  assert.deepEqual(result.missing, []);
});
