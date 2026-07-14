#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";

const index = JSON.parse(await readFile("samples/flagship-evidence.v1.json", "utf8"));
const catalog = JSON.parse(await readFile("samples/catalog.v2.json", "utf8"));
const budgets = JSON.parse(await readFile("bundle-budgets.json", "utf8")).entrypoints;
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const ci = await readFile(".github/workflows/ci.yml", "utf8");
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
  if (!catalogSample || catalogSample.track === "fixture") {
    throw new Error(`${sample.sampleId} is not a public catalog sample`);
  }
  await access(sample.performance.definition);
  const definition = await readFile(sample.performance.definition, "utf8");
  if (sample.performance.definition.endsWith("budgets.json")) {
    const declared = JSON.parse(definition).scenarios;
    if (!declared?.[sample.performance.scenario]) {
      throw new Error(`${sample.sampleId} references missing performance scenario ${sample.performance.scenario}`);
    }
  } else if (!definition.includes("toBeLessThan")) {
    throw new Error(`${sample.sampleId} performance definition does not enforce a numeric ceiling`);
  }
  if (sample.performance.artifact) {
    const packageScripts = JSON.stringify(packageJson.scripts);
    if (!packageScripts.includes(sample.performance.artifact)) {
      throw new Error(`${sample.sampleId} artifact is not produced by a package script`);
    }
  }
  for (const entrypoint of sample.bundle.entrypoints) {
    if (!budgets[entrypoint]) throw new Error(`${sample.sampleId} references missing bundle budget ${entrypoint}`);
  }
}
if (expected.size > 0) throw new Error(`Missing flagship samples: ${[...expected].join(", ")}`);
if (!ci.includes("npm run bench:browser") || !ci.includes("npm run test:coverage") || !ci.includes("verify:bundle-budgets")) {
  throw new Error("Flagship performance and bundle gates are not all wired into CI");
}

process.stdout.write("Historical performance and bundle evidence index verified for 5 samples.\n");
