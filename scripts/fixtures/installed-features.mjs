// Copied into the isolated npm consumer before execution. No repository imports.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { HonuaClient } from "@honua/sdk-js";

const baseUrl = process.env.HONUA_INSTALLED_FIXTURE_URL;
assert.ok(baseUrl, "exact candidate fixture URL is required");
const requests = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  assert.equal(url.origin, new URL(baseUrl).origin, "request escaped the candidate fixture");
  const response = await nativeFetch(input, { ...init, signal: AbortSignal.timeout(30_000) });
  const bytes = (await response.clone().arrayBuffer()).byteLength;
  assert.ok(bytes <= 128_000, "bounded response byte budget exceeded");
  // Query values, headers, credentials and response bodies are never diagnostics.
  requests.push({ path: url.pathname, status: response.status, bytes });
  return response;
};
const client = new HonuaClient({ baseUrl });
const layer = client.featureLayer("test_service", 0);
const observations = [];
async function prove(operation, facets, assertions, action) {
  const start = requests.length;
  try {
    const values = await action();
    observations.push({ id: `protocol-certification:featureserver:${operation}`, verdict: "pass",
      execution: { mode: "installed-package", facets, assertions, values, requests: requests.slice(start) } });
  } catch (error) {
    observations.push({ id: `protocol-certification:featureserver:${operation}`, verdict: "fail",
      diagnostic: error instanceof assert.AssertionError ? `fixture assertion failed: ${error.message.slice(0, 500)}` : "candidate request failed; inspect bounded request statuses",
      execution: { mode: "installed-package", facets, assertions: 0, requests: requests.slice(start) } });
  }
}

await prove("metadata", ["positive", "metadata", "media-schema"], 5, async () => {
  const metadata = await layer.metadata();
  assert.equal(metadata.id, 0);
  assert.equal(metadata.name, "Test Layer");
  assert.equal(metadata.geometryType, "esriGeometryPoint");
  assert.equal(metadata.extent.spatialReference.wkid, 4326);
  assert.ok(metadata.fields.some((field) => field.name === "name" && field.type === "esriFieldTypeString"));
  return { id: metadata.id, name: metadata.name, geometryType: metadata.geometryType, srid: 4326 };
});
await prove("count", ["positive", "media-schema"], 2, async () => {
  // SQL fixture has ten rows, alternating active/inactive: exactly five active.
  const active = await layer.queryFeatureCount({ where: "status = 'active'" });
  const absent = await layer.queryFeatureCount({ where: "name = 'not-in-fixture'" });
  assert.equal(active, 5);
  assert.equal(absent, 0);
  return { active, absent };
});
await prove("query", ["positive", "pagination", "media-schema"], 6, async () => {
  const features = [];
  for (const offset of [0, 2, 4]) {
    const page = await layer.queryFeatures({ where: "status = 'active'", outFields: ["name", "count", "ratio"],
      returnGeometry: true, outSr: 4326, orderByFields: ["count ASC"], resultOffset: offset, resultRecordCount: 2 });
    assert.equal(page.features.length, offset === 4 ? 1 : 2);
    features.push(...page.features);
  }
  // Independently transcribed from the SQL input VALUES, not captured SDK output.
  // The count/ratio relation is n and 1.25*n; lon/lat order is deliberately asymmetric.
  const expected = [
    ["alpha", 1, 1.25, -122.49, 37.71], ["gamma", 3, 3.75, -122.46, 37.73],
    ["epsilon", 5, 6.25, -122.43, 37.75], ["eta", 7, 8.75, -122.4194, 37.7749],
    ["iota", 9, 11.25, -122.37, 37.79],
  ];
  const values = features.map(({ attributes: a, geometry: g }) => [a.name, a.count, a.ratio, g.x, g.y]);
  assert.deepEqual(values, expected);
  const missing = await layer.queryFeatures({ where: "name = 'lambda'", outFields: ["name", "description"],
    returnGeometry: true, outSr: 4326, resultRecordCount: 1 });
  assert.equal(missing.features.length, 1);
  assert.equal(missing.features[0].geometry ?? null, null);
  assert.equal(missing.features[0].attributes.description, null);
  return { features: values, nullGeometry: true, nullDescription: true, rasterNodata: "not-applicable" };
});
await writeFile(process.argv[2], `${JSON.stringify(observations, null, 2)}\n`);
