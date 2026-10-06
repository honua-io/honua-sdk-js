import assert from "node:assert/strict";
import test from "node:test";

import { inspectDesktopClientContainment } from "../../scripts/lib/desktop-client-containment.mjs";

const desktopProduct = ["ArcGIS", " Pro"].join("");
const scriptingInterface = ["Arc", "Py"].join("");

test("rejects references outside the nominative allowlist", () => {
  const result = inspectDesktopClientContainment([
    { path: "docs/compatibility.md", content: `Compatibility with ${desktopProduct}.` },
    { path: "docs/scripting.md", content: scriptingInterface },
  ]);

  assert.deepEqual(result.unexpected, [
    { path: "docs/compatibility.md", line: 1 },
    { path: "docs/scripting.md", line: 1 },
  ]);
});

test("reports a modified allowlisted line instead of allowing detail beside it", () => {
  const result = inspectDesktopClientContainment([
    {
      path: "test/feature-filter-compat.test.ts",
      content: `projects onto the ${desktopProduct} property shape with added text`,
    },
  ]);

  assert.deepEqual(result.unexpected, [{ path: "test/feature-filter-compat.test.ts", line: 1 }]);
  assert.ok(result.missing.some(({ path }) => path === "test/feature-filter-compat.test.ts"));
});
