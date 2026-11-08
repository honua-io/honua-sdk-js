import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { measureBundle } from "../../scripts/report-bundle-sizes.mjs";

test("the bundle guard rejects retained external renderers and RPC peers", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "honua-catalog-bundle-"));
  try {
    const entry = path.join(directory, "entry.mjs");
    for (const specifier of ["maplibre-gl", "@bufbuild/protobuf", "@connectrpc/connect"]) {
      fs.writeFileSync(entry, `import * as dependency from '${specifier}'; console.log(dependency);`);
      await assert.rejects(measureBundle(entry, [], [specifier]), /unexpectedly retained/);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("the bundle guard also rejects retained bundled modules", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "honua-catalog-input-"));
  try {
    const entry = path.join(directory, "entry.mjs");
    fs.writeFileSync(entry, "import { marker } from './heavy.mjs'; console.log(marker());");
    fs.writeFileSync(path.join(directory, "heavy.mjs"), "export function marker() { return globalThis.fixtureValue; }");
    await assert.rejects(measureBundle(entry, [], ["heavy.mjs"]), /unexpectedly retained/);
    const measurement = await measureBundle(entry);
    assert.ok(measurement.min > 0 && measurement.gzip > 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
