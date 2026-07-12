#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";

const index = JSON.parse(await readFile("samples/flagship-evidence.v1.json", "utf8"));
const catalog = JSON.parse(await readFile("samples/catalog.v1.json", "utf8"));
const budgets = JSON.parse(await readFile("bundle-budgets.json", "utf8")).entrypoints;
const expected = new Set([
  "maplibre-quickstart",
  "realtime-incident-dashboard",
  "spatial-analytics-workbench",
  "overture-geoparquet",
  "ai-spatial-app-builder",
]);

if (index.format !== "honua.sdk.flagship-evidence-index.v1" || index.schemaVersion !== 1) {
  throw new Error("Flagship evidence index format/version is invalid");
}
if (index.samples.length !== expected.size) throw new Error("Flagship evidence index must contain exactly five samples");

for (const sample of index.samples) {
  if (!expected.delete(sample.sampleId)) throw new Error(`Unexpected or duplicate flagship sample: ${sample.sampleId}`);
  const catalogSample = catalog.samples.find((candidate) => candidate.id === sample.sampleId);
  if (!catalogSample || catalogSample.tier !== "flagship") {
    throw new Error(`${sample.sampleId} is not a flagship catalog sample`);
  }
  await access(sample.performance.definition);
  for (const entrypoint of sample.bundle.entrypoints) {
    if (!budgets[entrypoint]) throw new Error(`${sample.sampleId} references missing bundle budget ${entrypoint}`);
  }
}
if (expected.size > 0) throw new Error(`Missing flagship samples: ${[...expected].join(", ")}`);

process.stdout.write("Flagship performance and bundle evidence index verified for 5 samples.\n");
